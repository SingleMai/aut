import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Classifier } from "@aut/classifier/interface";
import {
  ClassifierError,
  type Classifier as ClassifierShape,
  DecisionOutput,
  DecisionRequest,
  DecisionResponse,
  type JsonValue,
  type DecisionLog as LogRecord,
  NonNegativeInteger,
  type QuestionBinding,
  TreeConfig,
  type TreeNode,
} from "@aut/protocol";
import { Cause, Clock, Context, Effect, Exit, Layer, Schema } from "effect";
import { DecisionLog } from "../decision-log.js";
import type { CoreError } from "../errors.js";
import { TreeError } from "./errors.js";
import { type EvaluationContext, evaluate, testPredicate } from "./expression.js";

export interface TreeInput {
  readonly id?: string;
  readonly eventRef: string;
  readonly state: JsonValue;
  /** In-memory execution port, used only by explicit rewrite nodes and never serialized. */
  readonly rewrite?: RewritePort;
}
export interface TreeResult {
  readonly decisionLogId: string;
  readonly output: DecisionOutput;
}
export interface RewritePort {
  readonly rewrite: (input: {
    readonly state: JsonValue;
    readonly instructions: string;
    readonly attempt: number;
  }) => Effect.Effect<JsonValue, TreeError>;
}
export interface TreeOptions {
  readonly fallback?: ClassifierShape;
  readonly classifyTimeoutMs?: number;
  readonly maxSteps?: number;
  readonly rewrite?: RewritePort;
}
export const TreeBudgets = Schema.Struct({
  classifyTimeoutMs: NonNegativeInteger.pipe(Schema.greaterThan(0)),
  maxSteps: NonNegativeInteger.pipe(Schema.greaterThan(0)),
});
export class DecisionTree extends Context.Tag("aut/DecisionTree")<
  DecisionTree,
  {
    readonly run: (
      tree: TreeConfig,
      input: TreeInput,
    ) => Effect.Effect<TreeResult, TreeError | CoreError>;
  }
>() {}

const checked = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(
      () =>
        new TreeError({
          code: "Validation",
          message: "Decision-tree data failed schema validation.",
        }),
    ),
  );
// The daemon reuses its data-only tree definitions across messages, even when its classifier changes.
// Keep a detached snapshot so in-place edits still undergo the complete schema and edge checks.
const validatedTrees = new WeakMap<TreeConfig, TreeConfig>();
const validateTree = (tree: TreeConfig) => {
  const previous = validatedTrees.get(tree);
  if (previous && isDeepStrictEqual(tree, previous)) return Effect.succeed(previous);
  return checked(TreeConfig, tree).pipe(
    Effect.map((decoded) => {
      const snapshot = structuredClone(decoded);
      validatedTrees.set(tree, snapshot);
      return snapshot;
    }),
  );
};
const sameKeys = (left: object, right: object) => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key))
  );
};

const validateResponse = (request: DecisionRequest, response: DecisionResponse) =>
  Schema.decodeUnknown(DecisionResponse)(response).pipe(
    Effect.filterOrFail(
      (value) =>
        sameKeys(value.answers, request.questions) &&
        Object.entries(request.questions).every(([id, question]) => {
          const answer = value.answers[id];
          if (!answer || answer.type !== question.type) return false;
          if (question.type === "choice" && answer.type === "choice")
            return (
              Object.hasOwn(question.criteria, answer.choice) &&
              sameKeys(question.criteria, answer.probabilities) &&
              Math.abs(answer.confidence - (answer.probabilities[answer.choice] ?? -1)) < 1e-9
            );
          return true;
        }),
      () =>
        new ClassifierError({
          code: "InvalidResponse",
          message: "Classifier response does not match its questions.",
        }),
    ),
    Effect.mapError(
      () =>
        new ClassifierError({
          code: "InvalidResponse",
          message: "Classifier response does not match its questions.",
        }),
    ),
  );

const expandQuestions = (bindings: readonly QuestionBinding[], context: EvaluationContext) =>
  Effect.gen(function* () {
    const questions: Record<string, unknown> = {};
    for (const binding of bindings) {
      let scopes: EvaluationContext[] = [context];
      if (binding.repeat) {
        const values = yield* evaluate(binding.repeat.from, context);
        if (!Array.isArray(values))
          return yield* Effect.fail(
            new TreeError({ code: "Expression", message: "Repeated questions require an array." }),
          );
        scopes = values.map((value) => ({
          ...context,
          vars: { ...context.vars, [binding.repeat?.as ?? "item"]: value },
        }));
      }
      for (const scope of scopes) {
        if (binding.when && !(yield* testPredicate(binding.when, scope))) continue;
        const id = yield* evaluate(binding.id, scope);
        if (
          typeof id !== "string" ||
          !id.length ||
          Object.hasOwn(questions, id) ||
          ["__proto__", "prototype", "constructor"].includes(id)
        )
          return yield* Effect.fail(
            new TreeError({
              code: "Expression",
              message: "Expanded question IDs must be unique safe strings.",
            }),
          );
        questions[id] = {
          type: binding.question.type,
          instructions: binding.question.instructions,
          ...(binding.question.type === "noul"
            ? {}
            : { criteria: yield* evaluate(binding.question.criteria, scope) }),
        };
      }
    }
    return questions;
  });

export const DecisionTreeLive = (options: TreeOptions = {}) =>
  Layer.effect(
    DecisionTree,
    Effect.gen(function* () {
      const classifier = yield* Classifier;
      const logs = yield* DecisionLog;
      const { classifyTimeoutMs: timeoutMs, maxSteps } = yield* checked(TreeBudgets, {
        classifyTimeoutMs: options.classifyTimeoutMs ?? 1_500,
        maxSteps: options.maxSteps ?? 1_000,
      });
      return {
        run: (tree: TreeConfig, input: TreeInput) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const id = input.id ?? randomUUID();
              const at = yield* Clock.currentTimeMillis;
              const calls: LogRecord["classifierCalls"][number][] = [];
              const dynamicOptions: Record<string, Record<string, string>> = {};
              const path: string[] = [];
              let context: EvaluationContext = {
                state: input.state,
                answers: {},
                vars: { decisionLogId: id },
                thresholds: tree.thresholds,
              };
              let rewrites = 0;
              const classify = (node: Extract<TreeNode, { type: "classify" }>, nodeId: string) =>
                Effect.gen(function* () {
                  const request = yield* checked(DecisionRequest, {
                    state: yield* evaluate(node.state, context),
                    questions: yield* expandQuestions(node.questions, context),
                  });
                  for (const [questionId, question] of Object.entries(request.questions))
                    if (question.type === "choice")
                      dynamicOptions[`${nodeId}.${questionId}`] = { ...question.criteria };
                  const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
                  for (const backend of [
                    classifier,
                    ...(options.fallback ? [options.fallback] : []),
                  ]) {
                    const started = yield* Clock.currentTimeMillis;
                    if (started >= deadline) return false;
                    const response = yield* Effect.uninterruptibleMask((restoreCall) =>
                      Effect.gen(function* () {
                        const exit = yield* Effect.exit(
                          restoreCall(
                            Effect.suspend(() => backend.decide(request)).pipe(
                              Effect.flatMap((value) => validateResponse(request, value)),
                              Effect.timeoutFail({
                                duration: deadline - started,
                                onTimeout: () =>
                                  new ClassifierError({
                                    code: "Timeout",
                                    message: "Classify node exceeded its total budget.",
                                  }),
                              }),
                            ),
                          ),
                        );
                        const latencyMs = (yield* Clock.currentTimeMillis) - started;
                        const error = Exit.isFailure(exit)
                          ? Cause.isInterrupted(exit.cause)
                            ? "Interrupted: Classification was cancelled."
                            : Cause.failureOption(exit.cause).pipe((value) =>
                                value._tag === "Some"
                                  ? `${value.value.code}: ${value.value.message}`
                                  : "InvalidResponse: Classifier failed unexpectedly.",
                              )
                          : undefined;
                        calls.push({
                          backend: backend.backend,
                          model: backend.model,
                          request,
                          latencyMs,
                          ...(Exit.isSuccess(exit)
                            ? { response: exit.value }
                            : { error: error ?? "Classifier failed." }),
                        });
                        if (Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)) {
                          // Preserve cancellation exactly; it is not a typed classifier failure or a fallback instruction.
                          return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
                        }
                        return exit;
                      }),
                    );
                    if (Exit.isSuccess(response)) {
                      context = {
                        ...context,
                        answers: {
                          ...(context.answers as Record<string, JsonValue>),
                          ...response.value.answers,
                        },
                      };
                      return true;
                    }
                  }
                  return false;
                });
              const interpret = Effect.gen(function* () {
                const config = yield* validateTree(tree);
                let next = config.entry;
                for (let step = 0; step < maxSteps; step++) {
                  const node = config.nodes[next];
                  if (!node)
                    return yield* Effect.fail(
                      new TreeError({
                        code: "Validation",
                        message: "Tree edge has no destination.",
                      }),
                    );
                  path.push(next);
                  switch (node.type) {
                    case "rule":
                      next = (yield* testPredicate(node.when, context)) ? node.then : node.else;
                      break;
                    case "branch": {
                      next = node.otherwise;
                      for (const branch of node.cases)
                        if (yield* testPredicate(branch.when, context)) {
                          next = branch.next;
                          break;
                        }
                      break;
                    }
                    case "classify":
                      next = (yield* classify(node, next)) ? node.next : node.onError;
                      break;
                    case "action": {
                      const output = yield* checked(
                        DecisionOutput,
                        yield* evaluate(node.output, context),
                      );
                      const valid =
                        config.name === "inbound"
                          ? "op" in output && output.op !== "escalate"
                          : config.name === "reply-gate"
                            ? "gate" in output
                            : config.name === "request"
                              ? "request" in output
                              : "excerpts" in output;
                      if (!valid)
                        return yield* Effect.fail(
                          new TreeError({
                            code: "Validation",
                            message: "Action output does not belong to this tree.",
                          }),
                        );
                      return output;
                    }
                    case "slow":
                      return yield* checked(DecisionOutput, {
                        op: "escalate",
                        reason: yield* evaluate(node.reason, context),
                        messageIds: yield* evaluate(node.messageIds, context),
                        decisionLogId: id,
                      });
                    case "rewrite": {
                      if (rewrites >= 2)
                        return yield* Effect.fail(
                          new TreeError({
                            code: "StepBudget",
                            message: "Tree exceeded the two-rewrite limit.",
                          }),
                        );
                      rewrites += 1;
                      const rewrite = input.rewrite ?? options.rewrite;
                      const rewritten = yield* (
                        rewrite
                          ? rewrite.rewrite({
                              state: context.state,
                              instructions: node.instructions,
                              attempt: rewrites,
                            })
                          : Effect.fail(
                              new TreeError({
                                code: "Rewrite",
                                message: "No rewrite port is configured.",
                              }),
                            )
                      ).pipe(Effect.either);
                      if (rewritten._tag === "Right")
                        context = { ...context, state: rewritten.right };
                      next = rewritten._tag === "Right" ? node.next : node.onError;
                      break;
                    }
                  }
                }
                return yield* Effect.fail(
                  new TreeError({
                    code: "StepBudget",
                    message: "Tree exceeded its node-step budget.",
                  }),
                );
              });
              const result = yield* Effect.exit(restore(interpret));
              const error = Exit.isSuccess(result)
                ? "Execution pending"
                : Cause.isInterrupted(result.cause)
                  ? "Interrupted: Decision was cancelled."
                  : Cause.failureOption(result.cause).pipe((value) =>
                      value._tag === "Some"
                        ? `${value.value.code}: ${value.value.message}`
                        : "Decision execution failed unexpectedly.",
                    );
              const persisted = yield* Effect.exit(
                logs.write({
                  id,
                  at,
                  tree: tree.name,
                  treeVersion: tree.version,
                  input: { eventRef: input.eventRef, state: input.state, dynamicOptions },
                  classifierCalls: calls,
                  path,
                  ...(Exit.isSuccess(result) ? { output: result.value } : {}),
                  execution: {
                    ok: false,
                    error,
                  },
                }),
              );
              if (Exit.isFailure(persisted))
                return yield* Effect.failCause(
                  Exit.isFailure(result)
                    ? Cause.sequential(result.cause, persisted.cause)
                    : persisted.cause,
                );
              if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
              return { decisionLogId: id, output: result.value };
            }),
          ),
      };
    }),
  );

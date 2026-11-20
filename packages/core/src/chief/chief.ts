import { randomUUID } from "node:crypto";
import {
  AutEvent,
  BotId,
  type DecisionLog as LogRecord,
  MessageId,
  NonEmptyString,
  Op,
  ProposableOp,
  TaskId,
  Timestamp,
} from "@aut/protocol";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { DecisionTree } from "../decision-tree/engine.js";
import { inboundV1 } from "../decision-tree/inbound.js";
import { CoreError, validate } from "../errors.js";
import { isCoordinationTask } from "../primary-assistant.js";
import { questionCardState, requireCardMessage } from "../request-cards.js";
import { Store } from "../store.js";
import { type ExecutionResult, InboundState, OpExecutor, StateSource } from "./ports.js";

export interface ChiefResult {
  readonly decisionLogId: string;
  readonly op?: Op;
  readonly execution: ExecutionResult;
}
export interface ChiefReceipt {
  readonly decisionLogId: string;
  readonly awaitResult: Effect.Effect<ChiefResult>;
}
export const ChiefProposal = Schema.Struct({
  originTaskId: TaskId,
  originBotId: BotId,
  op: ProposableOp,
  rationale: NonEmptyString,
  eventRef: NonEmptyString,
});
export type ChiefProposal = typeof ChiefProposal.Type;
export class Chief extends Context.Tag("aut/Chief")<
  Chief,
  {
    readonly submit: (event: AutEvent, eventRef?: string) => Effect.Effect<ChiefReceipt, CoreError>;
    readonly propose: (proposal: ChiefProposal) => Effect.Effect<ChiefReceipt, CoreError>;
    readonly results: Stream.Stream<ChiefResult>;
  }
>() {}

interface Pending {
  readonly event: AutEvent;
  readonly eventRef: string;
  readonly decisionLogId: string;
  readonly completed: Deferred.Deferred<ChiefResult>;
}
interface PendingProposal {
  readonly proposal: ChiefProposal;
  readonly decisionLogId: string;
  readonly completed: Deferred.Deferred<ChiefResult>;
}

const acknowledgement = (op: Op, state: Pick<InboundState, "bots">): string => {
  switch (op.op) {
    case "new":
      return `已交给『${state.bots.find((bot) => bot.id === op.botId)?.name ?? op.botId}』`;
    case "send":
      return "已提交到任务";
    case "ask":
      return "正在查看任务";
    case "control":
      return "已提交任务操作";
    case "answer":
      return "已提交回答";
    case "clarify":
      return op.card.prompt;
    case "escalate":
      return "我想想";
  }
};

export const ChiefLive = Layer.scoped(
  Chief,
  Effect.gen(function* () {
    const source = yield* StateSource;
    const executor = yield* OpExecutor;
    const tree = yield* DecisionTree;
    const logs = yield* DecisionLog;
    const store = yield* Store;
    const config = yield* ConfigStore;
    const queue = yield* Queue.unbounded<Pending | PendingProposal>();
    const results = yield* PubSub.unbounded<ChiefResult>();
    yield* Effect.addFinalizer(() =>
      Queue.shutdown(queue).pipe(Effect.zipRight(PubSub.shutdown(results))),
    );

    const handle = (pending: Pending) =>
      Effect.gen(function* () {
        let state: InboundState | undefined;
        let op: Op | undefined;
        let logged = false;
        const run = Effect.gen(function* () {
          state = yield* source
            .prepare(pending)
            .pipe(Effect.flatMap((value) => validate(InboundState, value)));
          const decision = yield* tree.run(inboundV1, {
            id: pending.decisionLogId,
            eventRef: pending.eventRef,
            state,
          });
          logged = true;
          op = yield* validate(Op, decision.output);
          const action =
            pending.event.source === "user" && pending.event.kind === "ui-action"
              ? pending.event.action
              : undefined;
          const registered =
            action?.type === "correct-dispatch"
              ? yield* executor.execute(op, pending.decisionLogId, action.decisionLogId)
              : yield* executor.execute(op, pending.decisionLogId);
          const execution = registered.execution;
          yield* logs.complete(pending.decisionLogId, execution);
          if (execution.ok) {
            const acknowledgementMessage = {
              id: MessageId.make(`chief:${pending.decisionLogId}`),
              at: Timestamp.make(yield* Clock.currentTimeMillis),
              author: "chief",
              kind:
                op.op === "clarify"
                  ? op.card.requestId
                    ? "question-card"
                    : "clarify-card"
                  : "ack",
              text: acknowledgement(op, state),
              decisionLogId: pending.decisionLogId,
              ...(op.op === "clarify" ? { card: op.card } : {}),
            } as const;
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                if (action?.type === "card-choice" || action?.type === "question-answer") {
                  const original = yield* requireCardMessage(tx, action.cardId);
                  if (!(op?.op === "answer" && original.card.requestId))
                    yield* tx.set("main_thread_messages", {
                      ...original,
                      card: { ...original.card, state: "answered" },
                    });
                }
                const card = acknowledgementMessage.card;
                if (card?.requestId) {
                  const request = yield* tx.get("session_requests", card.requestId);
                  if (request._tag === "None")
                    return yield* Effect.fail(
                      new CoreError({
                        code: "NotFound",
                        message: "The question request no longer exists.",
                      }),
                    );
                  yield* tx.insert("main_thread_messages", {
                    ...acknowledgementMessage,
                    taskId: request.value.taskId,
                    card: { ...card, state: questionCardState(request.value) },
                  });
                } else yield* tx.insert("main_thread_messages", acknowledgementMessage);
              }),
            );
            if (registered.activate) yield* registered.activate;
          }
          return { decisionLogId: pending.decisionLogId, op, execution } satisfies ChiefResult;
        });
        const outcome = yield* run.pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const failure = Cause.failureOption(cause);
              const error =
                failure._tag === "Some"
                  ? `${failure.value._tag}: ${failure.value.message}`
                  : "Chief execution failed unexpectedly.";
              const execution: ExecutionResult = { ok: false, error };
              // A tree failure may already have written its diagnostic log before returning the error.
              const existing = yield* logs.get(pending.decisionLogId);
              if (logged || existing._tag === "Some")
                yield* logs.complete(pending.decisionLogId, execution);
              else {
                const log: LogRecord = {
                  id: pending.decisionLogId,
                  at: Timestamp.make(yield* Clock.currentTimeMillis),
                  tree: "inbound",
                  treeVersion: inboundV1.version,
                  input: {
                    eventRef: pending.eventRef,
                    state: state ?? { event: pending.event },
                    dynamicOptions: {},
                  },
                  classifierCalls: [],
                  path: [],
                  execution,
                  ...(op ? { output: op } : {}),
                };
                yield* logs.write(log);
              }
              return {
                decisionLogId: pending.decisionLogId,
                ...(op ? { op } : {}),
                execution,
              } satisfies ChiefResult;
            }),
          ),
        );
        yield* Deferred.succeed(pending.completed, outcome);
        yield* PubSub.publish(results, outcome);
      });
    const handleProposal = (pending: PendingProposal) =>
      Effect.gen(function* () {
        const proposal = pending.proposal;
        yield* logs.write({
          id: pending.decisionLogId,
          at: Timestamp.make(yield* Clock.currentTimeMillis),
          tree: "inbound",
          treeVersion: "slow-brain-v1",
          input: { eventRef: proposal.eventRef, state: proposal, dynamicOptions: {} },
          classifierCalls: [],
          path: ["slow-brain", "propose_route"],
          output: proposal.op,
          execution: { ok: false, error: "Execution pending" },
        });
        const attempted = yield* Effect.gen(function* () {
          const bots = yield* config.readBots;
          const bot = bots.find((value) => value.id === proposal.originBotId);
          const task = yield* store.transaction((tx) => tx.get("tasks", proposal.originTaskId));
          if (
            !bot ||
            task._tag !== "Some" ||
            !isCoordinationTask(task.value, bot) ||
            ["cancelled", "archived"].includes(task.value.status)
          )
            return yield* Effect.fail(
              new CoreError({
                code: "InvalidRequest",
                message: "Only a primary assistant coordination task may propose routes.",
              }),
            );
          const registered = yield* executor.execute(proposal.op, pending.decisionLogId);
          yield* logs.complete(pending.decisionLogId, registered.execution);
          if (registered.execution.ok) {
            const at = Timestamp.make(yield* Clock.currentTimeMillis);
            yield* store.transaction((tx) =>
              tx.insert("main_thread_messages", {
                id: MessageId.make(`chief:${pending.decisionLogId}`),
                at,
                author: "chief",
                kind: "ack",
                text: acknowledgement(proposal.op, { bots }),
                decisionLogId: pending.decisionLogId,
              }),
            );
            if (registered.activate) yield* registered.activate;
          }
          return registered.execution;
        }).pipe(Effect.either);
        const execution: ExecutionResult =
          attempted._tag === "Right"
            ? attempted.right
            : { ok: false, error: `${attempted.left._tag}: ${attempted.left.message}` };
        if (attempted._tag === "Left") yield* logs.complete(pending.decisionLogId, execution);
        const result: ChiefResult = {
          decisionLogId: pending.decisionLogId,
          op: proposal.op,
          execution,
        };
        yield* Deferred.succeed(pending.completed, result);
        yield* PubSub.publish(results, result);
      });
    yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((pending) =>
          ("proposal" in pending ? handleProposal(pending) : handle(pending)).pipe(
            // Storage failure cannot disappear or kill the queue consumer; publish a failed receipt.
            Effect.catchAllCause(() => {
              const outcome: ChiefResult = {
                decisionLogId: pending.decisionLogId,
                execution: { ok: false, error: "Failed to persist the decision result." },
              };
              return Deferred.succeed(pending.completed, outcome).pipe(
                Effect.zipRight(PubSub.publish(results, outcome)),
              );
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
    return {
      submit: (event: AutEvent, eventRef?: string) =>
        Effect.gen(function* () {
          const checked = yield* validate(AutEvent, event);
          if (checked.source !== "user")
            return yield* Effect.fail(
              new CoreError({
                code: "InvalidRequest",
                message: "The inbound Chief accepts user events only.",
              }),
            );
          const decisionLogId = randomUUID();
          const completed = yield* Deferred.make<ChiefResult>();
          yield* Queue.offer(queue, {
            event: checked,
            eventRef: eventRef ?? decisionLogId,
            decisionLogId,
            completed,
          });
          return { decisionLogId, awaitResult: Deferred.await(completed) };
        }),
      propose: (proposal: ChiefProposal) =>
        Effect.gen(function* () {
          const checked = yield* validate(ChiefProposal, proposal);
          const decisionLogId = randomUUID();
          const completed = yield* Deferred.make<ChiefResult>();
          yield* Queue.offer(queue, { proposal: checked, decisionLogId, completed });
          return { decisionLogId, awaitResult: Deferred.await(completed) };
        }),
      results: Stream.fromPubSub(results),
    };
  }),
);

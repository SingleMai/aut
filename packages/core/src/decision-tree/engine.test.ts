import { Classifier } from "@aut/classifier/interface";
import {
  ClassifierError,
  type Classifier as ClassifierShape,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionLog as LogRecord,
  type TreeConfig,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, TestClock } from "effect";
import { expect } from "vitest";
import { DecisionLog } from "../decision-log.js";
import { DecisionTree, DecisionTreeLive, type TreeOptions } from "./engine.js";

const sample: TreeConfig = {
  name: "request",
  version: "test",
  entry: "c",
  thresholds: {},
  nodes: {
    c: {
      type: "classify",
      state: { kind: "ref", path: ["state"] },
      questions: [
        {
          id: { kind: "literal", value: "q" },
          question: { type: "noul", instructions: "Check the request." },
        },
      ],
      next: "yes",
      onError: "no",
    },
    yes: { type: "action", output: { kind: "literal", value: { request: "allow" } } },
    no: { type: "action", output: { kind: "literal", value: { request: "relay" } } },
  },
};
const response: DecisionResponse = { answers: { q: { type: "noul", noul: 0.9 } }, latencyMs: 1 };
const backend = (decide: ClassifierShape["decide"], name = "primary"): ClassifierShape => ({
  backend: name,
  model: "fixed-1",
  decide,
});
const setup = (primary: ClassifierShape, options: TreeOptions = {}) => {
  const records: LogRecord[] = [];
  const logLayer = Layer.succeed(DecisionLog, {
    write: (log) =>
      Effect.sync(() => {
        records.push(log);
        return log;
      }),
    get: (id) => Effect.succeed(Option.fromNullable(records.find((log) => log.id === id))),
    correct: () => Effect.die("Not used"),
    complete: () => Effect.die("Not used"),
  });
  return {
    records,
    layer: DecisionTreeLive(options).pipe(
      Layer.provide(Layer.merge(logLayer, Layer.succeed(Classifier, primary))),
    ),
  };
};

it.effect("persists cancelled classifier calls and decisions without invoking fallback", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let fallbackCalls = 0;
    const test = setup(
      backend(() =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ),
      ),
      {
        fallback: backend(
          () =>
            Effect.sync(() => {
              fallbackCalls += 1;
              return response;
            }),
          "fallback",
        ),
      },
    );
    const fiber = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(sample, { eventRef: "cancelled", state: {} });
    }).pipe(Effect.provide(test.layer), Effect.fork);
    yield* Deferred.await(entered);
    const exit = yield* Fiber.interrupt(fiber);
    yield* Deferred.await(released);
    expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
    expect(fallbackCalls).toBe(0);
    expect(test.records).toHaveLength(1);
    expect(test.records[0]?.classifierCalls).toHaveLength(1);
    expect(test.records[0]?.classifierCalls[0]?.error).toContain("Interrupted");
    expect(test.records[0]?.execution).toEqual({
      ok: false,
      error: "Interrupted: Decision was cancelled.",
    });
    expect(test.records[0]?.output).toBeUndefined();
  }),
);

it.effect(
  "releases an in-flight classify Scope and writes its audit when the parent Scope closes",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let live = 0;
      const test = setup(
        backend(() =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              live += 1;
            }),
            () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
            () =>
              Effect.sync(() => {
                live -= 1;
              }),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            return yield* (yield* DecisionTree).run(sample, { eventRef: "scope-close", state: {} });
          }).pipe(Effect.provide(test.layer), Effect.forkScoped);
          yield* Deferred.await(entered);
          expect(live).toBe(1);
        }),
      );
      expect(live).toBe(0);
      expect(test.records).toHaveLength(1);
      expect(test.records[0]?.classifierCalls[0]?.error).toContain("Interrupted");
      expect(test.records[0]?.execution.ok).toBe(false);
    }),
);

it.effect("honors a configured node budget longer than the default", () =>
  Effect.gen(function* () {
    const test = setup(
      backend(() => Effect.sleep("2 seconds").pipe(Effect.as(response))),
      { classifyTimeoutMs: 3_000 },
    );
    const fiber = yield* Effect.fork(
      Effect.gen(function* () {
        return yield* (yield* DecisionTree).run(sample, { eventRef: "event", state: {} });
      }).pipe(Effect.provide(test.layer)),
    );
    yield* TestClock.adjust("2 seconds");
    expect((yield* Fiber.join(fiber)).output).toEqual({ request: "allow" });
    expect(test.records[0]?.classifierCalls[0]?.latencyMs).toBe(2_000);
  }),
);

it.effect("rejects direct action escalation and records the invalid output failure", () =>
  Effect.gen(function* () {
    const test = setup(backend(() => Effect.die("Must not classify")));
    const tree: TreeConfig = {
      name: "inbound",
      version: "invalid-action",
      entry: "action",
      thresholds: {},
      nodes: {
        action: {
          type: "action",
          output: {
            kind: "literal",
            value: { op: "escalate", reason: "Bypass", decisionLogId: "forged", messageIds: [] },
          },
        },
      },
    };
    const result = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(tree, { eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer), Effect.either);
    expect(result._tag).toBe("Left");
    expect(test.records[0]?.output).toBeUndefined();
    expect(test.records[0]?.execution.error).toContain("does not belong");
  }),
);

it.effect(
  "batches repeated questions and records the exact request, probabilities and node path",
  () =>
    Effect.gen(function* () {
      let captured: DecisionRequest | undefined;
      const test = setup(
        backend((request) => {
          captured = request;
          return Effect.succeed({
            answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.1 } },
            latencyMs: 2,
          });
        }),
      );
      const tree: TreeConfig = {
        ...sample,
        nodes: {
          ...sample.nodes,
          c: {
            type: "classify",
            state: { kind: "ref", path: ["state"] },
            questions: [
              {
                repeat: { from: { kind: "literal", value: ["a", "b"] }, as: "id" },
                id: { kind: "ref", path: ["vars", "id"] },
                question: { type: "noul", instructions: "Check one candidate." },
              },
            ],
            next: "yes",
            onError: "no",
          },
        },
      };
      const result = yield* Effect.gen(function* () {
        return yield* (yield* DecisionTree).run(tree, {
          eventRef: "event",
          state: { text: "test" },
        });
      }).pipe(Effect.provide(test.layer));
      expect(result.output).toEqual({ request: "allow" });
      expect(Object.keys(captured?.questions ?? {})).toEqual(["a", "b"]);
      expect(test.records[0]?.path).toEqual(["c", "yes"]);
      expect(test.records[0]?.classifierCalls[0]?.response?.answers.b).toEqual({
        type: "noul",
        noul: 0.1,
      });
    }),
);

it.effect("uses one fallback after a primary failure and records both attempts", () =>
  Effect.gen(function* () {
    const test = setup(
      backend(() => Effect.fail(new ClassifierError({ code: "RateLimited", message: "Limited" }))),
      { fallback: backend(() => Effect.succeed(response), "fallback") },
    );
    yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(sample, { eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer));
    expect(test.records[0]?.classifierCalls.map((call) => call.backend)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(test.records[0]?.path).toEqual(["c", "yes"]);
  }),
);

it.effect("shares the total timeout across primary and fallback and keeps their errors", () =>
  Effect.gen(function* () {
    const test = setup(
      backend(() =>
        Effect.sleep("1 second").pipe(
          Effect.zipRight(
            Effect.fail(new ClassifierError({ code: "TransportError", message: "Unavailable" })),
          ),
        ),
      ),
      { fallback: backend(() => Effect.never, "fallback") },
    );
    const fiber = yield* Effect.fork(
      Effect.gen(function* () {
        return yield* (yield* DecisionTree).run(sample, { eventRef: "event", state: {} });
      }).pipe(Effect.provide(test.layer)),
    );
    yield* TestClock.adjust("1500 millis");
    expect((yield* Fiber.join(fiber)).output).toEqual({ request: "relay" });
    expect(test.records[0]?.classifierCalls.map((call) => call.latencyMs)).toEqual([1_000, 500]);
    expect(test.records[0]?.classifierCalls[1]?.error).toContain("Timeout");
  }),
);

it.effect("logs malformed classifier output and follows the explicit failure edge", () =>
  Effect.gen(function* () {
    const test = setup(backend(() => Effect.succeed({ answers: {}, latencyMs: 0 })));
    const result = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(sample, { eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer));
    expect(result.output).toEqual({ request: "relay" });
    expect(test.records[0]?.classifierCalls[0]?.error).toContain("InvalidResponse");
  }),
);

it.effect("records budget exhaustion without inventing an output", () =>
  Effect.gen(function* () {
    const test = setup(
      backend(() => Effect.succeed(response)),
      { maxSteps: 3 },
    );
    const loop: TreeConfig = {
      name: "request",
      version: "loop",
      entry: "loop",
      thresholds: {},
      nodes: { loop: { type: "branch", cases: [], otherwise: "loop" } },
    };
    const result = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(loop, { eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer), Effect.either);
    expect(result._tag === "Left" && result.left._tag === "TreeError" && result.left.code).toBe(
      "StepBudget",
    );
    expect(test.records[0]?.output).toBeUndefined();
    expect(test.records[0]?.path).toHaveLength(3);
    expect(test.records[0]?.execution.ok).toBe(false);
  }),
);

it.effect("permits slow only through its explicit node and binds the current log ID", () =>
  Effect.gen(function* () {
    const test = setup(backend(() => Effect.die("Must not classify")));
    const tree: TreeConfig = {
      name: "inbound",
      version: "slow",
      entry: "slow",
      thresholds: {},
      nodes: {
        slow: {
          type: "slow",
          reason: { kind: "literal", value: "Complex request" },
          messageIds: { kind: "literal", value: ["m"] },
        },
      },
    };
    const result = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(tree, { id: "log", eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer));
    expect(result.output).toEqual({
      op: "escalate",
      reason: "Complex request",
      messageIds: ["m"],
      decisionLogId: "log",
    });
    expect(test.records[0]?.classifierCalls).toEqual([]);
  }),
);

it.effect("calls rewrite only at rewrite nodes and refuses more than two attempts", () =>
  Effect.gen(function* () {
    const attempts: number[] = [];
    const test = setup(
      backend(() => Effect.die("Must not classify")),
      {
        rewrite: {
          rewrite: ({ attempt }) =>
            Effect.sync(() => {
              attempts.push(attempt);
              return { report: "Rewritten" };
            }),
        },
      },
    );
    const tree: TreeConfig = {
      name: "reply-gate",
      version: "rewrite",
      entry: "rewrite",
      thresholds: {},
      nodes: {
        rewrite: {
          type: "rewrite",
          instructions: "Rewrite concisely.",
          next: "rewrite",
          onError: "done",
        },
        done: { type: "action", output: { kind: "literal", value: { gate: "truncate" } } },
      },
    };
    const result = yield* Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(tree, { eventRef: "event", state: {} });
    }).pipe(Effect.provide(test.layer), Effect.either);
    expect(result._tag).toBe("Left");
    expect(attempts).toEqual([1, 2]);
    expect(test.records[0]?.execution.error).toContain("two-rewrite");
  }),
);

it.effect("revalidates nested changes to a previously executed tree and still logs each run", () =>
  Effect.gen(function* () {
    const fixture = setup(backend(() => Effect.succeed(response)));
    const original = {
      ...sample,
      nodes: {
        ...sample.nodes,
        yes: {
          type: "action" as const,
          output: { kind: "literal" as const, value: { request: "allow" } },
        },
      },
    };
    yield* Effect.gen(function* () {
      const service = yield* DecisionTree;
      const run = (ref: string) => service.run(original, { eventRef: ref, state: {} });
      expect((yield* run("first")).output).toEqual({ request: "allow" });
      expect((yield* run("same definition")).output).toEqual({ request: "allow" });
      // Deliberately mutate a nested literal and then an edge on the very same object.
      original.nodes.yes.output.value.request = "relay";
      expect((yield* run("changed output")).output).toEqual({ request: "relay" });
      original.entry = "missing";
      expect((yield* Effect.flip(run("broken edge"))).code).toBe("Validation");
      expect(fixture.records).toHaveLength(4);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

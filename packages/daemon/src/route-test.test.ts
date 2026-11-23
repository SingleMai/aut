import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "@aut/classifier/interface";
import { ConfigStore, CoreLive, DecisionTreeLive, Store } from "@aut/core";
import { BotConfig, BotId, ClassifierError, type DecisionRequest } from "@aut/protocol";
import { Effect, Either, Layer, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { RouteTest, RouteTestLive } from "./route-test.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "aut",
  name: "aut",
  description: "General work",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
  system: "primary",
});
const run = <A, E>(
  body: Effect.Effect<A, E, RouteTest | ConfigStore | Store>,
  fail = false,
  calls: DecisionRequest[] = [],
) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-route-test-"));
  directories.push(dataDirectory);
  const core = CoreLive({ dataDirectory });
  const classifier = Layer.succeed(Classifier, {
    backend: "mock",
    model: "mock-1",
    decide: (request) =>
      Effect.suspend(() => {
        calls.push(request);
        return fail
          ? Effect.fail(new ClassifierError({ code: "Timeout", message: "Expected test timeout" }))
          : Effect.succeed({
              answers: {
                bot: {
                  type: "choice" as const,
                  choice: "code",
                  confidence: 0.8,
                  probabilities: { aut: 0.2, code: 0.8 },
                },
              },
              latencyMs: 1,
            });
      }),
  });
  const tree = DecisionTreeLive().pipe(Layer.provideMerge(Layer.merge(core, classifier)));
  return Effect.runPromise(
    Effect.scoped(body.pipe(Effect.provide(RouteTestLive.pipe(Layer.provideMerge(tree))))),
  );
};
const seed = Effect.gen(function* () {
  const regular = { ...bot };
  delete regular.system;
  yield* (yield* ConfigStore).writeBots([
    bot,
    {
      ...regular,
      id: BotId.make("code"),
      name: "开发助手",
      description: "编写代码并审查软件工程变更",
    },
  ]);
});

it("returns real choice probabilities through a logged tree without executing the diagnostic Op", async () => {
  const calls: DecisionRequest[] = [];
  const result = await run(
    Effect.gen(function* () {
      yield* seed;
      const response = yield* (yield* RouteTest).run({ text: "帮我写代码" });
      const store = yield* Store;
      const saved = yield* store.transaction((tx) =>
        Effect.gen(function* () {
          return {
            logs: yield* tx.list("decision_logs"),
            tasks: yield* tx.list("tasks"),
            messages: yield* tx.list("main_thread_messages"),
          };
        }),
      );
      return { response, ...saved };
    }),
    false,
    calls,
  );
  expect(result.response.selectedBotId).toBe("code");
  expect(result.response.probabilities).toEqual([
    { botId: "aut", name: "aut", probability: 0.2 },
    { botId: "code", name: "开发助手", probability: 0.8 },
  ]);
  expect(result.tasks).toEqual([]);
  expect(result.messages).toEqual([]);
  expect(result.logs).toHaveLength(1);
  expect(result.logs[0]?.path).toEqual(["classify", "selected"]);
  expect(result.logs[0]?.execution.ok).toBe(true);
  expect(result.logs[0]?.input.eventRef).toMatch(/^route-test:/);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.state).toMatchObject({
    bots: [{ id: "aut" }, { id: "code", description: "编写代码并审查软件工程变更" }],
  });
  const question = calls[0]?.questions.bot;
  expect(question?.type === "choice" && question.criteria.code).toContain("index 1");
  expect(JSON.stringify(question)).not.toMatch(/\p{Script=Han}/u);
  expect(Object.keys(calls[0]?.questions ?? {})).toEqual(["bot"]);
});

it("logs classifier failure and reports unavailability without invented probabilities", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* seed;
      const failed = yield* Effect.either((yield* RouteTest).run({ text: "请求" }));
      return { failed, logs: yield* (yield* Store).transaction((tx) => tx.list("decision_logs")) };
    }),
    true,
  );
  expect(Either.isLeft(result.failed) && result.failed.left.code).toBe("Unavailable");
  expect(result.logs[0]?.path).toEqual(["classify", "unavailable"]);
  expect(result.logs[0]?.execution.ok).toBe(false);
  expect(result.logs[0]?.classifierCalls[0]?.error).toContain("Timeout");
});

it("records configuration failures before classification and rejects empty request text", async () => {
  const result = await run(
    Effect.gen(function* () {
      const service = yield* RouteTest;
      const missing = yield* Effect.either(service.run({ text: "Request" }));
      const empty = yield* Effect.either(service.run({ text: "" }));
      return {
        missing,
        empty,
        logs: yield* (yield* Store).transaction((tx) => tx.list("decision_logs")),
      };
    }),
  );
  expect(Either.isLeft(result.missing) && result.missing.left.code).toBe("Unavailable");
  expect(Either.isLeft(result.empty) && result.empty.left.code).toBe("Validation");
  expect(result.logs).toHaveLength(1);
  expect(result.logs[0]?.output).toBeUndefined();
  expect(result.logs[0]?.execution.ok).toBe(false);
});

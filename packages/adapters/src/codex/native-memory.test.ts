import { readFileSync } from "node:fs";
import { AdapterError, BotId, JsonValue, type StartSessionInput, TaskId } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Queue, Schema } from "effect";
import { expect } from "vitest";
import { makeCodexAdapter } from "./session.js";
import type { ProcessOptions, TransportFactory, TransportNotice } from "./transport.js";

const fixture = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      version: Schema.Literal("codex-cli 0.171.0"),
      passed: Schema.Literal(true),
      evidence: Schema.Array(
        Schema.Struct({
          check: Schema.String,
          feature: Schema.optional(Schema.Boolean),
          useMemories: Schema.optional(Schema.Boolean),
          generateMemories: Schema.optional(Schema.Boolean),
          mode: Schema.optional(Schema.String),
          response: Schema.optional(JsonValue),
        }),
      ),
    }),
  ),
)(
  readFileSync(
    new URL("../../../../spikes/codex/fixtures/native-memory-0.171.0.json", import.meta.url),
    "utf8",
  ),
);
const recorded = (check: string) => {
  const value = fixture.evidence.find((entry) => entry.check === check);
  if (!value) throw new Error(`Missing recorded memory check: ${check}`);
  return value;
};
const disabled = recorded("strict_config_and_effective_values");
const nativeConfig: JsonValue = {
  config: {
    features: { memories: disabled.feature ?? null },
    memories: {
      use_memories: disabled.useMemories ?? null,
      generate_memories: disabled.generateMemories ?? null,
    },
  },
};
const input: StartSessionInput = {
  taskId: TaskId.make("memory-policy"),
  model: "unchanged-model",
  cwd: "/tmp",
  instructions: "Synthetic test",
  mcpServers: [],
  bot: {
    id: BotId.make("memory-bot"),
    name: "Memory test",
    description: "Fixture",
    soul: "",
    cwd: "/tmp",
    modelSelection: { instanceId: "fixture", model: "unchanged-model" },
  },
};
const setup = (config: JsonValue = nativeConfig, refuseMode = false) =>
  Effect.gen(function* () {
    const calls: { method: string; params: JsonValue }[] = [];
    const opens: ProcessOptions[] = [];
    let released = 0;
    const factory: TransportFactory = {
      open: (options) =>
        Effect.gen(function* () {
          opens.push(options);
          const notices = yield* Queue.unbounded<TransportNotice>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released++;
            }),
          );
          return {
            notices,
            stop: Effect.void,
            send: () => Effect.void,
            request: (method, params) =>
              Effect.suspend(() => {
                calls.push({ method, params });
                if (method === "config/read") return Effect.succeed(config);
                if (method === "thread/memoryMode/set")
                  return refuseMode
                    ? Effect.fail(
                        new AdapterError({
                          code: "ProtocolError",
                          message: "Memory mode unavailable",
                        }),
                      )
                    : Effect.succeed(recorded("set_disabled_on_synthetic_thread").response ?? null);
                if (["thread/start", "thread/resume", "thread/fork"].includes(method))
                  return Effect.succeed({
                    thread: { id: method === "thread/fork" ? "fork-thread" : "aut-thread" },
                  });
                if (method === "turn/start") return Effect.succeed({ turn: { id: "turn" } });
                if (method === "thread/read")
                  return Effect.succeed({ thread: { id: "aut-thread", turns: [] } });
                return Effect.succeed({});
              }),
          };
        }),
    };
    const adapter = makeCodexAdapter(
      {
        args: [
          "--enable",
          "memories",
          "-c",
          "memories.use_memories=true",
          "-c",
          "memories.generate_memories=true",
        ],
        env: { AUT_FIXTURE_KEEP: "unchanged" },
      },
      factory,
    );
    return { adapter, calls, opens, released: () => released };
  });

it.scoped(
  "disables native memory for new, resumed and forked sessions despite instance enable flags",
  () =>
    Effect.gen(function* () {
      expect(recorded("new_thread").mode).toBe("disabled");
      expect(recorded("fork").mode).toBe("disabled");
      expect(recorded("resume_existing_thread").mode).toBe("enabled");
      const test = yield* setup();
      const created = yield* test.adapter.startSession(input);
      yield* created.fork();
      const resumed = yield* test.adapter.resumeSession(created.cursor, input);
      yield* resumed.startTurn({ text: "Synthetic", messageIds: [] });
      expect(test.opens).toHaveLength(3);
      for (const options of test.opens) {
        expect(options.args.slice(-6)).toEqual([
          "--disable",
          "memories",
          "-c",
          "memories.use_memories=false",
          "-c",
          "memories.generate_memories=false",
        ]);
        expect(options.env).toEqual({ AUT_FIXTURE_KEEP: "unchanged" });
        expect(options.cwd).toBe(input.cwd);
      }
      const threadCalls = test.calls.filter((call) =>
        ["thread/start", "thread/resume", "thread/fork"].includes(call.method),
      );
      for (const call of threadCalls)
        expect(call.params).toMatchObject({
          model: input.model,
          config: {
            "features.memories": false,
            "memories.use_memories": false,
            "memories.generate_memories": false,
          },
        });
      expect(test.calls.filter((call) => call.method === "thread/memoryMode/set")).toEqual([
        { method: "thread/memoryMode/set", params: { threadId: "aut-thread", mode: "disabled" } },
      ]);
      const methods = test.calls.map((call) => call.method);
      expect(methods.indexOf("thread/memoryMode/set")).toBeGreaterThan(
        methods.indexOf("thread/resume"),
      );
      expect(methods.indexOf("thread/memoryMode/set")).toBeLessThan(methods.indexOf("turn/start"));
      expect(methods.filter((method) => method.startsWith("config/"))).toEqual([
        "config/read",
        "config/read",
        "config/read",
      ]);
    }),
);

for (const [name, config] of [
  [
    "forced feature",
    {
      config: {
        features: { memories: true },
        memories: { use_memories: false, generate_memories: false },
      },
    },
  ],
  [
    "memory reading",
    {
      config: {
        features: { memories: false },
        memories: { use_memories: true, generate_memories: false },
      },
    },
  ],
  [
    "future learning",
    {
      config: {
        features: { memories: false },
        memories: { use_memories: false, generate_memories: true },
      },
    },
  ],
  ["unsupported config", { config: { token: "SYNTHETIC_SECRET_DO_NOT_LOG" } }],
] as const)
  it.scoped(`refuses ${name} before creating a thread and releases the process`, () =>
    Effect.gen(function* () {
      const test = yield* setup(config);
      const error = yield* test.adapter.startSession(input).pipe(Effect.flip);
      expect(error.message).toBe("Codex native memory could not be disabled");
      expect(JSON.stringify(error)).not.toContain("SYNTHETIC_SECRET_DO_NOT_LOG");
      expect(test.calls.map((call) => call.method)).toEqual(["initialize", "config/read"]);
      expect(test.released()).toBe(1);
    }),
  );

it.scoped("does not expose a resumed handle if persisted learning cannot be disabled", () =>
  Effect.gen(function* () {
    const test = yield* setup(nativeConfig, true);
    const error = yield* test.adapter
      .resumeSession({ kind: "codex", data: { threadId: "aut-thread" } }, input)
      .pipe(Effect.flip);
    expect(error.message).toBe("Memory mode unavailable");
    expect(test.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(test.released()).toBe(1);
  }),
);

it.scoped("does not change learning eligibility for an unexpected resumed thread", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    const error = yield* test.adapter
      .resumeSession({ kind: "codex", data: { threadId: "expected-thread" } }, input)
      .pipe(Effect.flip);
    expect(error.message).toBe("Resumed session belongs to another thread");
    expect(test.calls.some((call) => call.method === "thread/memoryMode/set")).toBe(false);
    expect(test.released()).toBe(1);
  }),
);

it.scoped("keeps cold history reads read-only while disabling native memory on their process", () =>
  Effect.gen(function* () {
    const test = yield* setup();
    if (!test.adapter.readSession) return yield* Effect.die("Missing read capability");
    yield* test.adapter.readSession({ kind: "codex", data: { threadId: "aut-thread" } });
    expect(test.calls.map((call) => call.method)).toEqual(["initialize", "thread/read"]);
    expect(test.opens[0]?.args).toContain("memories.generate_memories=false");
    expect(test.released()).toBe(1);
  }),
);

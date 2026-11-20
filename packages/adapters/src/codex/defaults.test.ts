import { readFileSync } from "node:fs";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, TestClock } from "effect";
import { expect } from "vitest";
import { readCodexDefaults } from "./defaults.js";
import type { TransportFactory, TransportNotice } from "./transport.js";

const recording = JSON.parse(
  readFileSync(new URL("./fixtures/defaults-projection.json", import.meta.url), "utf8"),
) as { config: JsonValue; models: JsonValue; metadata: { source: string; cli: string } };
const fixture = (config: JsonValue, models: readonly JsonValue[] = []) => {
  const calls: { method: string; params: JsonValue }[] = [];
  let closed = 0;
  let page = 0;
  const factory: TransportFactory = {
    open: () =>
      Effect.gen(function* () {
        const notices = yield* Queue.unbounded<TransportNotice>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed += 1;
          }),
        );
        return {
          notices,
          request: (method, params) =>
            Effect.sync(() => {
              calls.push({ method, params });
              return method === "config/read"
                ? config
                : method === "model/list"
                  ? (models[page++] ?? { data: [] })
                  : {};
            }),
          send: () => Effect.void,
          stop: Effect.void,
        };
      }),
  };
  return { factory, calls, closed: () => closed };
};

it.effect("uses the recorded default-model projection and preserves explicit effort", () =>
  Effect.gen(function* () {
    const test = fixture(recording.config, [recording.models]);
    expect(yield* readCodexDefaults({ cwd: "/tmp" }, test.factory)).toEqual({
      model: "gpt-6.1-sol",
      effort: "xhigh",
      provider: null,
      source: "reported-default",
    });
    expect(recording.metadata).toMatchObject({
      source: "recorded_projection",
      cli: "codex-cli 0.167.0",
    });
    expect(test.calls.map((call) => call.method)).toEqual([
      "initialize",
      "config/read",
      "model/list",
    ]);
    expect(test.closed()).toBe(1);
  }),
);

it.effect(
  "retains a configured custom model/provider without listing models or exposing other settings",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        config: {
          model: "custom-model",
          model_provider: "existing-provider",
          model_reasoning_effort: "high",
          api_key: "synthetic-secret",
          mcp_servers: { private: { env: { TOKEN: "synthetic-secret" } } },
        },
      });
      const result = yield* readCodexDefaults(
        {
          cwd: "/tmp",
          args: ["--profile", "existing"],
          env: { EXISTING_PROVIDER_KEY: "synthetic-secret" },
        },
        test.factory,
      );
      expect(result).toEqual({
        model: "custom-model",
        effort: "high",
        provider: "existing-provider",
        source: "configured",
      });
      expect(test.calls.map((call) => call.method)).toEqual(["initialize", "config/read"]);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
      expect(test.closed()).toBe(1);
    }),
);

it.effect("finds a unique native default across pages without a hardcoded model", () =>
  Effect.gen(function* () {
    const test = fixture({ config: { model: null, model_provider: "custom" } }, [
      { data: [{ model: "other", isDefault: false }], nextCursor: "next" },
      {
        data: [
          { model: "reported-custom-default", isDefault: true, defaultReasoningEffort: "medium" },
        ],
        nextCursor: null,
      },
    ]);
    expect(yield* readCodexDefaults({ cwd: "/tmp" }, test.factory)).toEqual({
      model: "reported-custom-default",
      effort: "medium",
      provider: "custom",
      source: "reported-default",
    });
    expect(test.calls.at(-1)?.params).toEqual({ cursor: "next" });
  }),
);

it.effect("rejects missing or ambiguous defaults and redacts malformed configuration errors", () =>
  Effect.gen(function* () {
    for (const [config, models] of [
      [{ config: { model: null } }, [{ data: [] }]],
      [
        { config: { model: null } },
        [
          {
            data: [
              { model: "a", isDefault: true },
              { model: "b", isDefault: true },
            ],
          },
        ],
      ],
      [{ config: { model: { key: "synthetic-secret" } } }, []],
    ] as const) {
      const test = fixture(config, models);
      const error = yield* readCodexDefaults({ cwd: "/tmp" }, test.factory).pipe(Effect.flip);
      expect(error.code).toBe("InvalidResponse");
      expect(JSON.stringify(error)).not.toContain("synthetic-secret");
      expect(test.closed()).toBe(1);
    }
  }),
);

it.effect("bounds the entire probe and closes its Scope on timeout", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const factory: TransportFactory = {
      open: () =>
        Effect.gen(function* () {
          const notices = yield* Queue.unbounded<TransportNotice>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          return {
            notices,
            request: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
            send: () => Effect.void,
            stop: Effect.void,
          };
        }),
    };
    const fiber = yield* readCodexDefaults({ cwd: "/tmp", timeoutMs: 50 }, factory).pipe(
      Effect.flip,
      Effect.fork,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("50 millis");
    expect((yield* Fiber.join(fiber)).code).toBe("TransportError");
    expect(closed).toBe(true);
    const sensitive: TransportFactory = {
      open: () =>
        Effect.fail(new AdapterError({ code: "ProtocolError", message: "synthetic-secret" })),
    };
    expect(
      JSON.stringify(yield* readCodexDefaults({ cwd: "/tmp" }, sensitive).pipe(Effect.flip)),
    ).not.toContain("synthetic-secret");
  }),
);

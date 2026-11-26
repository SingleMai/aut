import { readFileSync } from "node:fs";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, TestClock } from "effect";
import { expect } from "vitest";
import { readCodexModels } from "./models.js";
import type { TransportFactory, TransportNotice } from "./transport.js";

const recording = JSON.parse(
  readFileSync(new URL("./fixtures/defaults-projection.json", import.meta.url), "utf8"),
) as { config: JsonValue; models: JsonValue };
const fixture = (config: JsonValue, models: readonly JsonValue[]) => {
  const calls: string[] = [];
  let closed = false;
  let page = 0;
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
          stop: Effect.void,
          send: () => Effect.void,
          request: (method) =>
            Effect.sync(() => {
              calls.push(method);
              return method === "config/read"
                ? config
                : method === "model/list"
                  ? (models[page++] ?? {})
                  : {};
            }),
        };
      }),
  };
  return { factory, calls, closed: () => closed };
};
it.effect("projects the recorded native model list and closes the read-only process", () =>
  Effect.gen(function* () {
    const test = fixture(recording.config, [recording.models]);
    expect(yield* readCodexModels({ cwd: "/tmp" }, test.factory)).toEqual({
      models: [{ model: "gpt-6.1-sol", effort: "xhigh" }],
      defaultModel: "gpt-6.1-sol",
      source: "catalog",
    });
    expect(test.calls).toEqual(["initialize", "config/read", "model/list"]);
    expect(test.closed()).toBe(true);
  }),
);
it.effect(
  "preserves custom provider models without querying a different provider catalog or exposing secrets",
  () =>
    Effect.gen(function* () {
      const test = fixture(
        {
          config: {
            model: "custom-model",
            model_provider: "existing-provider",
            model_reasoning_effort: "high",
            api_key: "synthetic-secret",
          },
        },
        [],
      );
      const result = yield* readCodexModels({ cwd: "/tmp" }, test.factory);
      expect(result).toEqual({
        models: [{ model: "custom-model", effort: "high" }],
        defaultModel: "custom-model",
        source: "configured",
      });
      expect(test.calls).toEqual(["initialize", "config/read"]);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    }),
);
it.effect("deduplicates pages, retains a configured model, and rejects cursor loops", () =>
  Effect.gen(function* () {
    const pages = [
      { data: [{ model: "a", isDefault: false }], nextCursor: "page2" },
      {
        data: [
          { model: "a", isDefault: false },
          { model: "b", isDefault: true },
        ],
        nextCursor: null,
      },
    ];
    const test = fixture(
      { config: { model: "configured", model_reasoning_effort: "high" } },
      pages,
    );
    const result = yield* readCodexModels({ cwd: "/tmp" }, test.factory);
    expect(result.models.map((entry) => entry.model)).toEqual(["configured", "a", "b"]);
    expect(result.defaultModel).toBe("configured");
    const first = pages[0];
    if (!first) throw new Error("Missing fixture page");
    const loop = fixture({ config: {} }, [first, first]);
    expect((yield* readCodexModels({ cwd: "/tmp" }, loop.factory).pipe(Effect.flip)).code).toBe(
      "InvalidResponse",
    );
    expect(loop.closed()).toBe(true);
  }),
);
it.effect("times out and releases its process without leaking transport errors", () =>
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
            stop: Effect.void,
            send: () => Effect.void,
            request: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
          };
        }),
    };
    const fiber = yield* readCodexModels({ cwd: "/tmp", timeoutMs: 50 }, factory).pipe(
      Effect.flip,
      Effect.fork,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("50 millis");
    yield* Fiber.join(fiber);
    expect(closed).toBe(true);
    const bad: TransportFactory = {
      open: () =>
        Effect.fail(new AdapterError({ code: "TransportError", message: "synthetic-secret" })),
    };
    expect(
      JSON.stringify(yield* readCodexModels({ cwd: "/tmp" }, bad).pipe(Effect.flip)),
    ).not.toContain("synthetic-secret");
  }),
);

it.effect(
  "projects recorded per-model efforts and speed tiers without losing capabilities on the configured default",
  () =>
    Effect.gen(function* () {
      const probe = JSON.parse(
        readFileSync(
          new URL("../../../../spikes/codex/fixtures/model-options-0.171.0.json", import.meta.url),
          "utf8",
        ),
      ) as { cases: { events: { method: string; result: JsonValue }[] }[] };
      const pages =
        probe.cases[0]?.events
          .filter((event) => event.method === "model/list")
          .map((event) => event.result) ?? [];
      const test = fixture(
        {
          config: {
            model: "gpt-6.2-sol",
            model_reasoning_effort: "high",
            service_tier: "priority",
          },
        },
        pages,
      );
      const result = yield* readCodexModels({ cwd: "/tmp" }, test.factory);
      expect(result.models.find((model) => model.model === "gpt-6.2-sol")).toMatchObject({
        effort: "high",
        speed: "priority",
        efforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
          { value: "max" },
          { value: "ultra" },
        ],
        speeds: [
          { value: "default", label: "Standard" },
          { value: "priority", label: "Fast" },
          { value: "ultrafast", label: "Ultrafast" },
        ],
      });
      expect(
        result.models.find((model) => model.model === "auto/claude-sonnet-5-5")?.speeds,
      ).toEqual([]);
    }),
);

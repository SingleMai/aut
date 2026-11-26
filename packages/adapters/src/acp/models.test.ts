import { readFileSync } from "node:fs";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, TestClock } from "effect";
import { expect } from "vitest";
import { readAcpModels } from "./models.js";
import type { AcpTransportFactory, AcpTransportNotice } from "./transport.js";

const recording = JSON.parse(
  readFileSync(
    new URL("../../../../spikes/acp/fixtures/models-opencode-1.19.5.json", import.meta.url),
    "utf8",
  ),
) as {
  events: { direction: string; method: string; result?: JsonValue }[];
  result: { models: { model: string; label?: string }[]; defaultModel: string; source: string };
};
const responses = Object.fromEntries(
  recording.events
    .filter((event) => event.direction === "receive")
    .map((event) => [event.method, event.result]),
);
const options = { command: "opencode", args: ["acp"], cwd: "/tmp" };
const fixture = (values: Record<string, JsonValue | undefined> = responses) => {
  const calls: { method: string; params: JsonValue }[] = [];
  let closed = false;
  const factory: AcpTransportFactory = {
    open: () =>
      Effect.gen(function* () {
        const notices = yield* Queue.unbounded<AcpTransportNotice>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        return {
          notices,
          stop: Effect.void,
          send: () => Effect.void,
          request: (method, params) =>
            Effect.sync(() => {
              calls.push({ method, params });
              return values[method] ?? {};
            }),
        };
      }),
  };
  return { factory, calls, closed: () => closed };
};

it.effect(
  "replays OpenCode model options and closes the empty session without prompts or config writes",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      expect(yield* readAcpModels(options, test.factory)).toEqual(recording.result);
      expect(test.calls.map((call) => call.method)).toEqual([
        "initialize",
        "session/new",
        "session/close",
      ]);
      expect(test.closed()).toBe(true);
    }),
);

it.effect(
  "uses only declared existing auth and handles grouped model options without inventing defaults",
  () =>
    Effect.gen(function* () {
      const test = fixture({
        initialize: { authMethods: [{ id: "existing-login" }] },
        "session/new": {
          sessionId: "synthetic",
          configOptions: [
            {
              id: "native-model",
              category: "model",
              type: "select",
              options: [
                { group: "Cloud", options: [{ value: "one", name: "One" }] },
                { value: "two", name: "Two" },
              ],
            },
          ],
        },
      });
      expect(
        yield* readAcpModels(
          { ...options, authMethodIds: ["other", "existing-login"] },
          test.factory,
        ),
      ).toEqual({
        models: [
          { model: "one", label: "One" },
          { model: "two", label: "Two" },
        ],
        source: "catalog",
      });
      expect(test.calls.map((call) => call.method)).toEqual([
        "initialize",
        "authenticate",
        "session/new",
      ]);
      expect(test.calls[1]?.params).toEqual({ methodId: "existing-login" });
      expect(test.closed()).toBe(true);
      const rejected = fixture({ initialize: { authMethods: [{ id: "another" }] } });
      yield* readAcpModels(
        { ...options, authMethodIds: ["existing-login"] },
        rejected.factory,
      ).pipe(Effect.flip);
      expect(rejected.calls.map((call) => call.method)).toEqual(["initialize"]);
    }),
);

it.effect(
  "retains a configured model and returns an empty catalog when models are not advertised",
  () =>
    Effect.gen(function* () {
      const configured = fixture({
        initialize: {},
        "session/new": {
          sessionId: "synthetic",
          configOptions: [{ id: "model", type: "select", currentValue: "custom", options: [] }],
        },
      });
      expect(yield* readAcpModels(options, configured.factory)).toEqual({
        models: [{ model: "custom" }],
        defaultModel: "custom",
        source: "catalog",
      });
      const empty = fixture({ initialize: {}, "session/new": { sessionId: "synthetic" } });
      expect((yield* readAcpModels(options, empty.factory)).models).toEqual([]);
    }),
);

it.effect("releases a stalled or failed ACP process and redacts native errors", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const factory: AcpTransportFactory = {
      open: () =>
        Effect.gen(function* () {
          const notices = yield* Queue.unbounded<AcpTransportNotice>();
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
    const fiber = yield* readAcpModels({ ...options, timeoutMs: 50 }, factory).pipe(
      Effect.flip,
      Effect.fork,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("50 millis");
    yield* Fiber.join(fiber);
    expect(closed).toBe(true);
    const error = yield* readAcpModels(options, {
      open: () =>
        Effect.fail(new AdapterError({ code: "TransportError", message: "synthetic-secret" })),
    }).pipe(Effect.flip);
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  }),
);

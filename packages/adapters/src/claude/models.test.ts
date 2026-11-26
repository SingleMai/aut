import { existsSync, readFileSync } from "node:fs";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, TestClock } from "effect";
import { expect } from "vitest";
import { readClaudeModels } from "./models.js";
import type { ClaudeTransportFactory, ClaudeTransportNotice } from "./transport.js";

const recording = JSON.parse(
  readFileSync(
    new URL("../../../../spikes/claude/fixtures/model-options-2.1.330.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    setting: string | boolean;
    events: {
      payload: {
        type: string;
        response?: {
          subtype: string;
          request_id: string;
          response: {
            fast_mode_state: string;
            models: {
              value: string;
              displayName: string;
              supportsEffort?: boolean;
              supportedEffortLevels?: string[];
              supportsFastMode?: boolean;
            }[];
          };
        };
      };
    }[];
  }[];
};
const frame = recording.cases[0]?.events.find((event) => event.payload)?.payload;

it.effect(
  "reads the recorded Claude catalog without user frames, preserving settings and cleaning temporary files",
  () =>
    Effect.gen(function* () {
      if (!frame?.response) throw new Error("Missing fixture");
      let closed = false;
      let settingsPath = "";
      const sent: JsonValue[] = [];
      const factory: ClaudeTransportFactory = {
        open: (options) =>
          Effect.gen(function* () {
            expect(options.args).toContain("--no-session-persistence");
            expect(options.args).toContain("--strict-mcp-config");
            settingsPath = options.args[options.args.indexOf("--settings") + 1] ?? "";
            const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
            expect(settings).toMatchObject({
              model: "my-model",
              env: { EXAMPLE: "preserved", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
              autoMemoryEnabled: false,
              disableAllHooks: true,
            });
            const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            );
            return {
              notices,
              stop: Effect.void,
              send: (message) =>
                Effect.gen(function* () {
                  sent.push(message);
                  const requestId = (message as { request_id: string }).request_id;
                  yield* Queue.offer(notices, {
                    kind: "line",
                    line: JSON.stringify({
                      ...frame,
                      response: { ...frame.response, request_id: requestId },
                    }),
                  });
                }),
            };
          }),
      };
      const result = yield* readClaudeModels(
        {
          cwd: "/tmp",
          args: [
            "--settings",
            JSON.stringify({
              model: "my-model",
              env: { EXAMPLE: "preserved", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" },
            }),
          ],
        },
        factory,
      );
      expect(result.models.map((model) => model.model)).toEqual(
        frame.response.response.models.map((model) => model.value),
      );
      expect(result.models[0]?.label).toBe(frame.response.response.models[0]?.displayName);
      for (const native of frame.response.response.models) {
        const model = result.models.find((entry) => entry.model === native.value);
        expect(model?.efforts).toEqual(
          native.supportsEffort && native.supportedEffortLevels
            ? native.supportedEffortLevels.map((value) => ({ value }))
            : undefined,
        );
        expect(model?.speeds).toEqual(
          native.supportsFastMode
            ? [
                { value: "default", label: "Standard" },
                { value: "fast", label: "Fast" },
              ]
            : undefined,
        );
      }
      for (const probe of recording.cases) {
        const state = probe.events.find((event) => event.payload)?.payload.response?.response
          .fast_mode_state;
        expect(state).toBe(probe.setting === true ? "on" : "off");
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "control_request",
        request: { subtype: "initialize" },
      });
      expect(result.defaultModel).toBe("default");
      expect(closed).toBe(true);
      expect(existsSync(settingsPath)).toBe(false);
    }),
);

it.effect("times out and releases the Claude process without exposing native errors", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let closed = false;
    const factory: ClaudeTransportFactory = {
      open: () =>
        Effect.gen(function* () {
          const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          );
          return {
            notices,
            stop: Effect.void,
            send: () => Deferred.succeed(entered, undefined).pipe(Effect.asVoid),
          };
        }),
    };
    const fiber = yield* readClaudeModels({ cwd: "/tmp", timeoutMs: 50 }, factory).pipe(
      Effect.flip,
      Effect.fork,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("50 millis");
    yield* Fiber.join(fiber);
    expect(closed).toBe(true);
    const error = yield* readClaudeModels(
      { cwd: "/tmp" },
      {
        open: () =>
          Effect.fail(new AdapterError({ code: "TransportError", message: "synthetic-secret" })),
      },
    ).pipe(Effect.flip);
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  }),
);

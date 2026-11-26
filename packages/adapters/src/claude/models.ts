import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError, type BotModelsResponse, NonEmptyString } from "@aut/protocol";
import { Effect, Queue, Schema } from "effect";
import { claudeMemorySettings } from "./settings.js";
import { type ClaudeTransportFactory, NodeClaudeTransport } from "./transport.js";

export interface ReadClaudeModelsOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const Envelope = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    subtype: Schema.Literal("success"),
    request_id: NonEmptyString,
    response: Schema.Struct({
      models: Schema.Array(
        Schema.Struct({
          value: NonEmptyString,
          displayName: Schema.optional(NonEmptyString),
          supportsEffort: Schema.optional(Schema.Boolean),
          supportedEffortLevels: Schema.optional(Schema.Array(NonEmptyString)),
          supportsFastMode: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  }),
});
const failure = () =>
  new AdapterError({ code: "InvalidResponse", message: "Claude model discovery failed." });

/** Initialize the native catalog without a prompt, tools, hooks or a persistent session. */
export const readClaudeModels = (
  options: ReadClaudeModelsOptions,
  factory: ClaudeTransportFactory = NodeClaudeTransport,
): Effect.Effect<BotModelsResponse, AdapterError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const native = yield* claudeMemorySettings(options.args ?? [], options.cwd);
      const directory = yield* Effect.acquireRelease(
        Effect.try({ try: () => mkdtempSync(join(tmpdir(), "aut-models-")), catch: failure }),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
      );
      const settingsPath = join(directory, "settings.json");
      yield* Effect.try({
        try: () =>
          writeFileSync(
            settingsPath,
            JSON.stringify({ ...native.settings, disableAllHooks: true }),
            { mode: 0o600 },
          ),
        catch: failure,
      });
      const transport = yield* factory.open({
        command: options.command ?? "claude",
        args: [
          ...native.args,
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--settings",
          settingsPath,
        ],
        cwd: options.cwd,
        env: { ...options.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      });
      const requestId = randomUUID();
      yield* transport.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      });
      for (;;) {
        const notice = yield* Queue.take(transport.notices);
        if (notice.kind !== "line") return yield* Effect.fail(failure());
        const frame = yield* Schema.decodeUnknown(Schema.parseJson())(notice.line).pipe(
          Effect.mapError(failure),
        );
        if (typeof frame !== "object" || frame === null || !("type" in frame)) continue;
        if (frame.type !== "control_response") continue;
        const decoded = yield* Schema.decodeUnknown(Envelope)(frame).pipe(Effect.mapError(failure));
        if (decoded.response.request_id !== requestId) continue;
        const models = [
          ...new Map(
            decoded.response.response.models.map((model) => [
              model.value,
              {
                model: model.value,
                ...(model.displayName ? { label: model.displayName } : {}),
                ...(model.supportsEffort && model.supportedEffortLevels
                  ? {
                      efforts: model.supportedEffortLevels.map((value) => ({ value })),
                    }
                  : {}),
                ...(model.supportsFastMode
                  ? {
                      speeds: [
                        { value: "default", label: "Standard" },
                        { value: "fast", label: "Fast" },
                      ],
                    }
                  : {}),
              },
            ]),
          ).values(),
        ];
        return {
          models,
          ...(models.some((model) => model.model === "default") ? { defaultModel: "default" } : {}),
          source: "catalog" as const,
        };
      }
    }).pipe(
      Effect.interruptible,
      Effect.timeoutFail({ duration: options.timeoutMs ?? 15_000, onTimeout: failure }),
    ),
  ).pipe(Effect.mapError(failure));

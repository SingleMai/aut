import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Queue } from "effect";
import { readCodexModels } from "../packages/adapters/dist/codex/models.js";
import { NodeTransport } from "../packages/adapters/dist/codex/transport.js";
import { readClaudeModels } from "../packages/adapters/dist/claude/models.js";
import { NodeClaudeTransport } from "../packages/adapters/dist/claude/transport.js";

const [cli, destination] = process.argv.slice(2);
if (!["codex", "claude"].includes(cli) || !destination)
  throw new Error("Usage: model-options-probe.mjs codex|claude output.json");
const output = resolve(destination);
if (existsSync(output)) throw new Error("Refusing to overwrite a fixture");
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "aut-model-options-"));
const cases = [];
const project = (object, keys) =>
  Object.fromEntries(
    keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]),
  );
try {
  if (cli === "codex") {
    const events = [];
    const result = await Effect.runPromise(
      readCodexModels(
        { cwd },
        {
          open: (options) =>
            NodeTransport.open(options).pipe(
              Effect.map((transport) => ({
                ...transport,
                request: (method, params) =>
                  transport.request(method, params).pipe(
                    Effect.tap((response) =>
                      Effect.sync(() => {
                        if (method === "config/read")
                          events.push({
                            method,
                            result: {
                              config: project(response.config, [
                                "model",
                                "model_provider",
                                "model_reasoning_effort",
                                "service_tier",
                              ]),
                            },
                          });
                        if (method === "model/list")
                          events.push({
                            method,
                            result: {
                              data: response.data.map((model) => ({
                                ...project(model, [
                                  "model",
                                  "displayName",
                                  "isDefault",
                                  "defaultReasoningEffort",
                                  "defaultServiceTier",
                                ]),
                                supportedReasoningEfforts: model.supportedReasoningEfforts?.map(
                                  (effort) => project(effort, ["reasoningEffort"]),
                                ),
                                serviceTiers: model.serviceTiers?.map((tier) =>
                                  project(tier, ["id", "name"]),
                                ),
                              })),
                              nextCursor: response.nextCursor,
                            },
                          });
                      }),
                    ),
                  ),
              })),
            ),
        },
      ),
    );
    cases.push({ events, result });
  } else {
    for (const fastMode of [undefined, false, true]) {
      const events = [];
      const result = await Effect.runPromise(
        readClaudeModels(
          { cwd, args: ["--settings", JSON.stringify(fastMode === undefined ? {} : { fastMode })] },
          {
            open: (options) =>
              Effect.gen(function* () {
                const settings = JSON.parse(
                  readFileSync(options.args[options.args.lastIndexOf("--settings") + 1], "utf8"),
                );
                events.push({
                  settings: project(settings, ["fastMode", "disableAllHooks", "autoMemoryEnabled"]),
                });
                const transport = yield* NodeClaudeTransport.open(options);
                const notices = yield* Queue.unbounded();
                yield* Effect.forever(
                  Effect.gen(function* () {
                    const notice = yield* Queue.take(transport.notices);
                    if (notice.kind === "line") {
                      const frame = JSON.parse(notice.line);
                      const body = frame.response?.response;
                      if (frame.type === "control_response" && body?.models)
                        events.push({
                          payload: {
                            type: frame.type,
                            response: {
                              subtype: frame.response.subtype,
                              request_id: frame.response.request_id,
                              response: {
                                ...project(body, ["fast_mode_state", "fast_mode_disabled_reason"]),
                                models: body.models.map((model) =>
                                  project(model, [
                                    "value",
                                    "displayName",
                                    "supportsEffort",
                                    "supportedEffortLevels",
                                    "supportsFastMode",
                                  ]),
                                ),
                              },
                            },
                          },
                        });
                    }
                    yield* Queue.offer(notices, notice);
                  }),
                ).pipe(Effect.forkScoped);
                return { ...transport, notices };
              }),
          },
        ),
      );
      cases.push({ setting: fastMode ?? "inherited", events, result });
    }
  }
  writeFileSync(
    output,
    `${JSON.stringify({ cli, version, recordedAt: new Date().toISOString(), projection: "Model and option metadata only. No prompts, account details, credentials or descriptions recorded.", cases }, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      cli,
      version,
      cases: cases.length,
      models: cases[0]?.result.models.length,
    }),
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

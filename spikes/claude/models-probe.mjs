import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Queue } from "effect";
import { readClaudeModels } from "../../packages/adapters/dist/claude/models.js";
import { NodeClaudeTransport } from "../../packages/adapters/dist/claude/transport.js";
import { readAcpModels } from "../../packages/adapters/dist/acp/models.js";
import { NodeAcpTransport } from "../../packages/adapters/dist/acp/transport.js";

const [kind, destination] = process.argv.slice(2);
if (!["claude", "acp"].includes(kind) || !destination)
  throw new Error("Usage: models-probe.mjs claude|acp output.json");
const output = resolve(destination);
if (existsSync(output)) throw new Error("Refusing to overwrite a fixture");
const command = kind === "claude" ? "claude" : "opencode";
const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "aut-model-catalog-"));
const events = [];
try {
  const result =
    kind === "claude"
      ? await Effect.runPromise(
          readClaudeModels(
            { cwd },
            {
              open: (options) =>
                Effect.gen(function* () {
                  const transport = yield* NodeClaudeTransport.open(options);
                  const notices = yield* Queue.unbounded();
                  yield* Effect.forever(
                    Effect.gen(function* () {
                      const notice = yield* Queue.take(transport.notices);
                      if (notice.kind === "line") {
                        const frame = JSON.parse(notice.line);
                        if (frame.type === "control_response" && frame.response?.response?.models) {
                          events.push({
                            direction: "receive",
                            payload: {
                              type: frame.type,
                              response: {
                                subtype: frame.response.subtype,
                                request_id: frame.response.request_id,
                                response: {
                                  models: frame.response.response.models.map((model) => ({
                                    value: model.value,
                                    displayName: model.displayName,
                                  })),
                                },
                              },
                            },
                          });
                        }
                      }
                      yield* Queue.offer(notices, notice);
                    }),
                  ).pipe(Effect.forkScoped);
                  return {
                    ...transport,
                    notices,
                    send: (message) => {
                      events.push({ direction: "send", payload: message });
                      return transport.send(message);
                    },
                  };
                }),
            },
          ),
        )
      : await Effect.runPromise(
          readAcpModels(
            { cwd, command, args: ["acp"], timeoutMs: 15_000 },
            {
              open: (options) =>
                NodeAcpTransport.open(options).pipe(
                  Effect.map((transport) => ({
                    ...transport,
                    request: (method, params) => {
                      events.push({ direction: "send", method, params });
                      return transport.request(method, params).pipe(
                        Effect.tap((response) =>
                          Effect.sync(() => {
                            if (method === "initialize")
                              events.push({
                                direction: "receive",
                                method,
                                result: {
                                  agentCapabilities: response.agentCapabilities,
                                  authMethods: response.authMethods?.map(({ id }) => ({ id })),
                                },
                              });
                            else if (method === "session/new")
                              events.push({
                                direction: "receive",
                                method,
                                result: {
                                  sessionId: response.sessionId,
                                  configOptions: response.configOptions
                                    ?.filter((option) => option.category === "model")
                                    .map((option) => ({
                                      id: option.id,
                                      category: option.category,
                                      type: option.type,
                                      currentValue: option.currentValue,
                                      options: option.options?.map(({ value, name }) => ({
                                        value,
                                        name,
                                      })),
                                    })),
                                },
                              });
                            else events.push({ direction: "receive", method, result: response });
                          }),
                        ),
                      );
                    },
                  })),
                ),
            },
          ),
        );
  writeFileSync(
    output,
    `${JSON.stringify({ cli: command, version, recordedAt: new Date().toISOString(), projection: "Model metadata only; no prompt, account details, credentials or descriptions recorded.", events, result }, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      cli: command,
      version,
      count: result.models.length,
      methods: events
        .filter((event) => event.direction === "send")
        .map((event) => event.method ?? event.payload.type),
    }),
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

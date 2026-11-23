// Synthetic live gate verification. No user questions are answered by this probe.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { makeJevLayer } from "../../packages/classifier/dist/index.js";
import { CoreLive, DecisionTreeLive, SessionReplyGateLive, Store } from "../../packages/core/dist/index.js";
import { SessionReplyGate } from "../../packages/core/dist/session-manager/ports.js";
import { BotId, TaskId, type SessionEvent, type StartSessionInput, type Task } from "../../packages/protocol/dist/index.js";
import { Effect, Layer, Queue, Redacted, Stream, Take } from "effect";

const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY is required for the opt-in live gate probe");
const workdir = mkdtempSync(join(tmpdir(), "aut-gate-live-"));
const model = process.env.AUT_CODEX_MODEL ?? "gpt-6.1-sol";
const taskId = TaskId.make("gate-live-synthetic");
const botId = BotId.make("gate-live");
const input: StartSessionInput = {
  taskId, model, effort: "low", cwd: workdir, mcpServers: [],
  instructions: "This is a synthetic report test. Do not use tools or ask questions. Follow the current request and output only the requested report.",
  bot: { id: botId, name: "Gate fixture", description: "Synthetic report verification", soul: "", cwd: workdir, modelSelection: { instanceId: "codex", model } },
};
const at = Date.now();
const task: Task = { id: taskId, botId, title: "Synthetic gate verification", status: "reporting", createdAt: at, updatedAt: at, lastActivityAt: at, session: { instanceId: "codex" }, pendingRequestIds: [], queue: [], origin: { kind: "user" } };
const layer = SessionReplyGateLive().pipe(Layer.provideMerge(DecisionTreeLive().pipe(Layer.provideMerge(Layer.merge(
  CoreLive({ dataDirectory: workdir }), makeJevLayer({ apiKey: Redacted.make(key) }),
)))));
const adapter = makeCodexAdapter({ rpcTimeoutMs: 20_000 });
const assert = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message));
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const session = yield* adapter.startSession(input);
  const queue = yield* Stream.toQueue(session.events);
  yield* Effect.yieldNow();
  const longReport = "这是一份合成测试报告。三个测试都已通过，结果可以使用，没有发现阻塞问题。".repeat(12);
  yield* session.startTurn({ text: `Return exactly the following synthetic report, without changing or summarizing it:\n${longReport}`, messageIds: [] });
  let report: string | undefined;
  while (report === undefined) {
    const events = yield* Take.done(yield* Queue.take(queue));
    for (const event of events as Iterable<SessionEvent>) {
      if (event.kind === "request.opened" && event.request.kind === "question") return yield* Effect.fail(new Error("Unexpected question: this probe never answers questions"));
      if (event.kind === "turn.failed" || event.kind === "process.exited") return yield* Effect.fail(new Error("The synthetic worker failed"));
      if (event.kind === "turn.completed") {
        if (!event.ok) return yield* Effect.fail(new Error("The synthetic worker was interrupted"));
        report = event.finalReport;
      }
    }
  }
  yield* assert(Array.from(report).length > 200, "The source report must exercise the rewrite branch");
  const before = yield* session.transcript();
  const output = yield* (yield* SessionReplyGate).check({ task, report, reportEventId: "synthetic-report", session, adapter, sessionInput: input });
  const after = yield* session.transcript();
  yield* assert(JSON.stringify(before) === JSON.stringify(after), "The rewrite contaminated the original transcript");
  yield* assert(output.rewrites > 0 && output.rewrites <= 2, "The gate did not use its bounded rewrite path");
  yield* assert(Array.from(output.delivered).length <= 200, "The delivered Chinese reply exceeded the configured limit");
  const logs = yield* (yield* Store).transaction((tx) => tx.list("decision_logs"));
  yield* assert(logs.length === 1 && logs[0]?.execution.ok === true, "The gate decision was not persisted");
  return { sourceCharacters: Array.from(report).length, delivered: output.delivered, rewrites: output.rewrites, originalTranscriptUnchanged: true, path: logs[0]?.path, classifierCalls: logs[0]?.classifierCalls.map((call) => ({ backend: call.backend, model: call.model, response: call.response, error: call.error })) };
}).pipe(Effect.provide(layer), Effect.timeout("5 minutes"))));
let children: string[] = [];
try { children = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { /* No children is the expected result. */ }
if (children.length) throw new Error("The gate probe leaked child processes");
const output = process.env.AUT_GATE_RESULT ?? join(workdir, "reply-gate-result.json");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), model, ...result, childProcessesAfterScope: children }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, sourceCharacters: result.sourceCharacters, rewrites: result.rewrites, originalTranscriptUnchanged: result.originalTranscriptUnchanged, childProcessesAfterScope: children }));

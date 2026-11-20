// Explicit synthetic integration: real Codex, production handoff/tree/gate, deterministic classifier.
// Session setup is deliberately local to this probe; daemon wiring supplies the real aut MCP bridge.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { NodeTransport } from "../../packages/adapters/dist/codex/transport.js";
import { Classifier } from "../../packages/classifier/dist/interface.js";
import { CoreLive, ConfigStore, DecisionLog, DecisionTreeLive, HandoffBuilderLive, HarnessResolver, MainThread, SessionManager, SessionManagerLive, SessionReplyGateLive, SessionRequestRouterLive, SessionSetup, Store, TaskRegistry } from "../../packages/core/dist/index.js";
import { BotId, MessageId, TaskId, type BotConfig, type DecisionResponse, type Op } from "../../packages/protocol/dist/index.js";
import { Effect, Layer, Option } from "effect";

const directory = mkdtempSync(join(tmpdir(), "aut-manager-live-"));
const cwd = join(directory, "work");
mkdirSync(cwd);
const model = process.env.AUT_CODEX_MODEL ?? "gpt-6.1-sol";
const bot: BotConfig = { id: BotId.make("live-worker"), name: "Synthetic worker", description: "Synthetic manager integration", soul: "", modelSelection: { instanceId: "codex-live", model }, cwd, mcpServers: [] };
const childPids = new Set<number>();
const adapter = makeCodexAdapter({}, { open: (options) => NodeTransport.open(options).pipe(Effect.tap(() => Effect.sync(() => {
  for (const value of execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n")) if (value) childPids.add(Number(value));
}))) });
const core = CoreLive({ dataDirectory: join(directory, "data") });
const classifier = Layer.succeed(Classifier, {
  backend: "synthetic", model: "fixture-1",
  decide: (request) => Effect.sync((): DecisionResponse => ({
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: id.startsWith("candidate_") ? 0 : 1 }];
      if (question.type === "score") return [id, { type: "score", score: 0 }];
      const keys = Object.keys(question.criteria);
      return [id, { type: "choice", choice: keys[0] ?? "", confidence: 1, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])) }];
    })), latencyMs: 0,
  })),
});
const tree = DecisionTreeLive().pipe(Layer.provideMerge(classifier), Layer.provideMerge(core));
const ports = Layer.mergeAll(
  HandoffBuilderLive().pipe(Layer.provideMerge(tree)),
  SessionReplyGateLive().pipe(Layer.provideMerge(tree)),
  SessionRequestRouterLive.pipe(Layer.provideMerge(tree)),
  Layer.succeed(HarnessResolver, { resolve: () => Effect.succeed(adapter) }),
  Layer.succeed(SessionSetup, { prepare: (task, bot) => Effect.succeed({ taskId: task.id, bot, model: bot.modelSelection.model, cwd: bot.cwd, instructions: "This is an explicitly synthetic integration test. Follow the current request precisely.", mcpServers: [] }) }),
);
const layer = SessionManagerLive().pipe(Layer.provideMerge(ports), Layer.provideMerge(core));
const assert = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message));
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const config = yield* ConfigStore;
  const manager = yield* SessionManager;
  const tasks = yield* TaskRegistry;
  const logs = yield* DecisionLog;
  const main = yield* MainThread;
  const store = yield* Store;
  yield* config.writeBots([bot]);
  let serial = 0;
  const register = (op: Extract<Op, { op: "new" | "send" | "control" }>) => Effect.gen(function* () {
    const id = `live-route-${++serial}`;
    yield* logs.write({ id, at: Date.now(), tree: "inbound", treeVersion: "explicit-synthetic-route", input: { eventRef: id, state: {}, dynamicOptions: {} }, classifierCalls: [], path: ["synthetic-manual-route"], output: op, execution: { ok: false, error: "Awaiting registration" } });
    const receipt = yield* manager.register(op, id);
    yield* logs.complete(id, receipt.execution);
    if (receipt.activate) yield* receipt.activate;
    return op.op === "new" ? TaskId.make(`task:${id}`) : op.taskId;
  });
  const awaitIdle = (id: TaskId, expected?: string) => Effect.gen(function* () {
    while (true) {
      const found = yield* tasks.get(id);
      if (Option.isNone(found)) return yield* Effect.fail(new Error("Missing task"));
      const task = found.value;
      if (["failed", "interrupted", "waiting_user"].includes(task.status)) return yield* Effect.fail(new Error(`Unexpected task state: ${task.status}`));
      if (task.status === "idle" && (!expected || task.lastReport?.delivered.includes(expected))) return task;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("3 minutes"));
  const first = MessageId.make("live-request-1");
  yield* main.append({ id: first, at: Date.now(), author: "user", kind: "text", text: "Synthetic test: output the exact Chinese phrase 合成报告。 60 times consecutively. Do not summarize this request, call tools, or add headings. The repetition is intentionally longer than 200 Chinese characters for an integration test." });
  const id = yield* register({ op: "new", botId: bot.id, requestMessageIds: [first] });
  const initial = yield* awaitIdle(id);
  yield* assert((initial.lastReport?.full.length ?? 0) > 200, "Worker did not produce the intentionally long report");
  yield* assert((initial.lastReport?.rewrites ?? 0) >= 1 && (initial.lastReport?.rewrites ?? 3) <= 2, "Production reply gate did not use its isolated rewrite path");
  yield* assert((initial.lastReport?.delivered.length ?? 999) <= 200, "Gate output exceeds the character budget");
  const second = MessageId.make("live-request-2");
  yield* main.append({ id: second, at: Date.now(), author: "user", kind: "text", text: "Reply exactly SESSION_SEND_OK." });
  yield* register({ op: "send", taskId: id, delivery: "immediate", messageIds: [second] });
  const final = yield* awaitIdle(id, "SESSION_SEND_OK");
  const snapshot = yield* manager.snapshot(id);
  if (!snapshot.live) return yield* Effect.fail(new Error("Original session is unavailable"));
  const transcript = yield* snapshot.live.session.transcript();
  yield* assert(!transcript.some((entry) => entry.text.includes("<report>") || entry.text.includes("Return only the rewritten report")), "Rewrite instructions polluted the worker session");
  const replies = (yield* main.page()).filter((message) => message.kind === "reply");
  yield* assert(replies.length === 2 && new Set(replies.map((message) => message.fullReportRef)).size === 2, "Replies do not have immutable distinct report references");
  const events = yield* store.transaction((tx) => tx.list("events", { limit: Number.MAX_SAFE_INTEGER }));
  const decisions = yield* store.transaction((tx) => tx.list("decision_logs", { limit: Number.MAX_SAFE_INTEGER }));
  yield* assert(events.some((event) => event.id.startsWith("rewrite:")), "Missing persisted rewrite events");
  yield* assert(decisions.every((decision) => decision.execution.ok), "A routing/handoff/gate decision failed");
  return { taskId: id, initialReport: initial.lastReport, finalReport: final.lastReport, replies, transcript, eventCount: events.length, decisionCount: decisions.length, decisionTrees: decisions.map((decision) => decision.tree) };
})).pipe(Effect.provide(layer), Effect.timeout("8 minutes")));
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error(`Scoped processes remain alive: ${alive.join(",")}`);
const output = process.env.AUT_SESSION_MANAGER_RESULT ?? join(directory, "session-manager-result.json");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), model, classifier: "explicit deterministic fixture; all classifications still run through production decision trees", setup: "synthetic setup; daemon bridge wiring is a separate integration", checks: ["durable new", "production handoff", "native worker report", "production reply gate", "isolated native fork rewrite", "parent transcript isolation", "same-session send", "immutable report refs", "all decisions successful", "scope cleanup"], childPids: [...childPids], alive, ...result }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, childPids: [...childPids], alive }));

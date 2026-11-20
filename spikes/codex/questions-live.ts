// Explicit synthetic integration: real Codex, production handoff/tree/gate, deterministic classifier.
// Session setup is deliberately local to this probe; daemon wiring supplies the real aut MCP bridge.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { NodeTransport } from "../../packages/adapters/dist/codex/transport.js";
import { Classifier } from "../../packages/classifier/dist/interface.js";
import { CoreLive, ConfigStore, DecisionLog, QuestionsService, QuestionsServiceLive, DecisionTreeLive, HandoffBuilderLive, HarnessResolver, MainThread, SessionManager, SessionManagerLive, SessionReplyGateLive, SessionRequestRouterLive, SessionSetup, Store, TaskRegistry } from "../../packages/core/dist/index.js";
import { BotId, MessageId, TaskId, type BotConfig, type DecisionResponse, type Op, type SessionRequest } from "../../packages/protocol/dist/index.js";
import { Effect, Layer, Option } from "effect";

const directory = mkdtempSync(join(tmpdir(), "aut-questions-live-"));
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
const layer = QuestionsServiceLive.pipe(Layer.provideMerge(SessionManagerLive()), Layer.provideMerge(ports), Layer.provideMerge(core));
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
  const questions = yield* QuestionsService;
  const waitUntil = <A>(read: Effect.Effect<A, unknown>, check: (value: A) => boolean) => Effect.gen(function* () {
    while (true) {
      const value = yield* read;
      if (check(value)) return value;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.timeout("3 minutes"));
  const runs = [];
  for (const mode of ["sync", "async"] as const) {
    const messageId = MessageId.make(`question-${mode}`);
    const prompt = mode === "sync"
      ? "Explicit synthetic integration test: call request_user_input exactly once with TWO questions. First id probe_color, header Color, question Which fixture color?, options Blue / Red. Second id probe_shape, header Shape, question Which fixture shape?, options Circle / Square. Do not answer yourself. Wait for explicit user answers. After receiving Blue and Circle, output exactly QUESTIONS_SYNC_OK:Blue:Circle. If unavailable, output TOOL_UNAVAILABLE."
      : "Explicit synthetic integration test: call request_user_input_async to ask 'Which fixture color?' with options Blue and Red. Immediately run shell command sleep 20 so independent work continues. Do not answer yourself. Wait to receive the explicit user reply, then output exactly QUESTIONS_ASYNC_OK:Blue. If unavailable, output ASYNC_UNAVAILABLE.";
    yield* main.append({ id: messageId, at: Date.now(), author: "user", kind: "text", text: prompt });
    const taskId = yield* register({ op: "new", botId: bot.id, requestMessageIds: [messageId] });
    const requests = yield* waitUntil(store.transaction((tx) => tx.list("session_requests", { limit: 100 })),
      (items) => items.some((item) => item.taskId === taskId && item.request.kind === "question"));
    const record = requests.find((item) => item.taskId === taskId && item.request.kind === "question");
    if (!record) return yield* Effect.fail(new Error("Expected native request not found"));
    const request: SessionRequest = record.request;
    // These are explicit preset test answers, only for this exact synthetic question group.
    const expected = mode === "sync" ? ["Which fixture color?", "Which fixture shape?"] : ["Which fixture color?"];
    yield* assert(request.questions.length === expected.length && request.questions.every((question, index) => question.text === expected[index]
      && JSON.stringify(question.options?.map((option) => option.label)) === JSON.stringify(index === 0 ? ["Blue", "Red"] : ["Circle", "Square"])), "Unexpected question: no synthetic answer was sent");
    if (mode === "sync") yield* assert(request.questions[0]?.id === "probe_color" && request.questions[1]?.id === "probe_shape", "Unexpected native question IDs");
    const cards = yield* waitUntil(main.page({ limit: 100 }), (items) => items.some((item) => item.card?.requestId === request.id));
    yield* assert(cards.filter((item) => item.card?.requestId === request.id).length === 1, "Native request does not have exactly one card");
    yield* assert(Option.getOrThrow(yield* tasks.get(taskId)).status === "waiting_user", "Unanswered request is not reflected in task state");
    const claimId = `synthetic-answer-${mode}`;
    const answer = { perQuestion: request.questions.map((question) => ({ questionId: question.id, optionIds: [question.options?.[0]?.id ?? "invalid"] })) };
    const op: Extract<Op, { op: "answer" }> = { op: "answer", requestId: request.id, answer };
    yield* logs.write({ id: claimId, at: Date.now(), tree: "inbound", treeVersion: "explicit-synthetic-answer", input: { eventRef: claimId, state: { ...answer }, dynamicOptions: {} }, classifierCalls: [], path: ["synthetic-user-answer"], output: op, execution: { ok: false, error: "Awaiting registration" } });
    const receipt = yield* questions.register(op, claimId);
    yield* logs.complete(claimId, receipt.execution);
    const registered = Option.getOrThrow(yield* store.transaction((tx) => tx.get("session_requests", request.id)));
    yield* assert(registered.answerClaim?.phase === "registered" && registered.state === "open", "Answer was sent before activation");
    if (receipt.activate) yield* receipt.activate;
    const final = yield* waitUntil(tasks.get(taskId), (value) => Option.isSome(value) && ["idle", "failed", "interrupted"].includes(value.value.status));
    const task = Option.getOrThrow(final);
    yield* assert(task.status === "idle" && Boolean(task.lastReport?.delivered.includes(mode === "sync" ? "QUESTIONS_SYNC_OK:Blue:Circle" : "QUESTIONS_ASYNC_OK:Blue")), "Native answer did not reach the worker");
    const closed = Option.getOrThrow(yield* store.transaction((tx) => tx.get("session_requests", request.id)));
    yield* assert(closed.state === "answered" && closed.answerClaim?.phase === "delivered", "Answer confirmation was not persisted");
    const duplicate = yield* Effect.either(questions.register(op, `${claimId}-duplicate`));
    yield* assert(duplicate._tag === "Left", "Duplicate answer was accepted");
    runs.push({ mode, taskId, request: { id: request.id, questions: request.questions }, claimPhase: closed.answerClaim?.phase, report: task.lastReport, duplicateRejected: true });
  }
  const events = yield* store.transaction((tx) => tx.list("events", { limit: Number.MAX_SAFE_INTEGER }));
  const decisions = yield* store.transaction((tx) => tx.list("decision_logs", { limit: Number.MAX_SAFE_INTEGER }));
  yield* assert(decisions.every((decision) => decision.execution.ok), "A native question routing decision failed");
  return { runs, eventCount: events.length, decisionCount: decisions.length, decisionTrees: decisions.map((decision) => decision.tree) };
})).pipe(Effect.provide(layer), Effect.timeout("8 minutes")));
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error(`Scoped processes remain alive: ${alive.join(",")}`);
const output = process.env.AUT_QUESTIONS_RESULT ?? join(directory, "questions-result.json");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), model, classifier: "explicit deterministic fixture; all classifications still run through production decision trees", setup: "synthetic setup; daemon bridge wiring is a separate integration", checks: ["native request_user_input full group", "native async question", "request data tree", "one full-group card", "waiting_user without forcing pause", "explicit preset synthetic answers only", "registration before activation", "native confirmation", "production reply gate", "duplicate prevention", "all decisions logged", "scope cleanup"], childPids: [...childPids], alive, ...result }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, childPids: [...childPids], alive }));

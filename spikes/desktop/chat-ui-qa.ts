// Isolated desktop fixture backed by the real API; no harness or model is started.
// Interaction cases reference OpenMausBot 738ec88472a3b888ff7b7793755d89da613ed301:
// src/components/{Composer.ime,QuestionCard.answer,ChatView.follow,ReplyQuote}.test.ts.
// This fixture is independently implemented; no upstream source is copied.
import { phases, questionCases, questionFixture, sampleAnswer } from "../../apps/desktop/src/preview/question-fixtures.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ConfigStore, insertTaskWithSession, Store } from "../../packages/core/dist/index.js";
import { reportSources } from "../../packages/core/dist/report-sources.js";
import { truncateReport } from "../../packages/core/dist/reply-gate.js";
import { Administration, DaemonApiLive, HttpServer } from "../../packages/daemon/dist/index.js";
import {
  BotId, MessageId, RequestId, SessionRequest, TaskId,
} from "../../packages/protocol/dist/index.js";
import { Data, Effect, Option, Queue, Schema } from "effect";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}
const directory = mkdtempSync(join(tmpdir(), "aut-chat-ui-qa-"));
const now = Date.now();
const botId = BotId.make("qa-research");
const taskId = TaskId.make("qa-review");
const fullReport = [
  "# 本地界面验收完整报告",
  "",
  "这是一份不可变历史原文，用于检查报告弹窗、长文本换行与任务来源。",
  "",
  ...Array.from({ length: 32 }, (_, index) => `## 第 ${index + 1} 项检查\n保留第 ${index + 1} 条完整结论：消息、引用、原生题组与任务状态通过 daemon API 读取。`),
  "",
  "END_OF_IMMUTABLE_REPORT",
].join("\n");
const Command = Schema.Union(
  Schema.Struct({ command: Schema.Literal("create-bot") }),
  Schema.Struct({ command: Schema.Literal("source-report") }),
  Schema.Struct({ command: Schema.Literal("audit") }),
  Schema.Struct({ command: Schema.Literal("append"), text: Schema.String }),
  Schema.Struct({ command: Schema.Literal("phase"), requestId: Schema.String, phase: Schema.Literal(...phases) }),
  Schema.Struct({ command: Schema.Literal("settle"), requestId: Schema.String }),
);

const freePort = Effect.async<number, FixtureError>((resume) => {
  const server = createServer();
  server.once("error", () => resume(Effect.fail(new FixtureError({ message: "Cannot allocate preview port" }))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    server.close(() => resume(port ? Effect.succeed(port) : Effect.fail(new FixtureError({ message: "Missing preview port" }))));
  });
  return Effect.sync(() => server.close());
});

const program = Effect.scoped(Effect.gen(function* () {
  const store = yield* Store;
  const config = yield* ConfigStore;
  const admin = yield* Administration;
  yield* config.writeConfig({ harnessInstances: [{ id: "qa-local", name: "本地测试实例", kind: "codex", command: "codex", args: [] }] });
  yield* config.writeBots([
    { id: botId, name: "研究助手", description: "Review synthetic UI fixtures.", soul: "Use only synthetic fixtures.", cwd: directory, modelSelection: { instanceId: "qa-local", model: "fixture-only" } },
    { id: BotId.make("qa-writer"), name: "写作助手", description: "Write synthetic QA summaries.", soul: "Use only synthetic fixtures.", cwd: directory, modelSelection: { instanceId: "qa-local", model: "fixture-only" } },
  ]);
  yield* store.transaction((tx) => Effect.gen(function* () {
    yield* insertTaskWithSession(tx, {
      id: taskId, botId, title: "核对新版对话交互", status: "waiting_user", createdAt: now - 120_000, updatedAt: now, lastActivityAt: now,
      session: { instanceId: "qa-local" }, pendingRequestIds: [RequestId.make("qa-single"), RequestId.make("qa-multi")],
      lastReport: { full: "A newer task report must not replace the older referenced report.", delivered: "最近任务摘要", rewrites: 0 },
      queue: [], origin: { kind: "user" },
    });
    for (const [suffix, status] of [["idle", "idle"], ["failed", "failed"], ["interrupted", "interrupted"], ["running", "running"]] as const) {
      yield* insertTaskWithSession(tx, {
        id: TaskId.make(`qa-${suffix}`), botId, title: `状态测试 · ${suffix}`, status, createdAt: now - 200_000, updatedAt: now - 10_000, lastActivityAt: now - 10_000,
        session: { instanceId: "qa-local" }, pendingRequestIds: [], queue: [], origin: { kind: "user" },
      });
    }
    for (let index = 1; index <= 65; index++) {
      yield* tx.insert("main_thread_messages", {
        id: MessageId.make(`qa-history-${String(index).padStart(2, "0")}`), at: now - (90 - index) * 60_000,
        author: index % 2 ? "user" : { botId, taskId }, kind: index % 2 ? "text" : "reply", taskId,
        text: index % 2 ? `历史消息 ${index}：请检查对话记录能否分页查看。` : `历史消息 ${index}：已记录，这条历史内容不应在查看最新消息时丢失。`,
      });
    }
    yield* tx.insert("events", { id: "qa-immutable-report", at: now - 50_000, event: { source: "session", kind: "turn.completed", taskId, event: { kind: "turn.completed", turnId: "qa-original-turn", ok: true, finalReport: fullReport } } });
    yield* tx.insert("main_thread_messages", { id: MessageId.make("qa-user-intent"), at: now - 40_000, author: "user", kind: "text", taskId, text: "先对齐成熟的对话交互，再做必要的调优。请保留原生提问、任务来源和完整报告。" });
    yield* tx.insert("main_thread_messages", { id: MessageId.make("qa-ack"), at: now - 39_000, author: "chief", kind: "ack", taskId, text: "已交给『研究助手』" });
    yield* tx.insert("main_thread_messages", { id: MessageId.make("qa-report"), at: now - 38_000, author: { botId, taskId }, kind: "reply", taskId, text: "已整理对话布局和输入框交互。下一步确认问题卡片：单题直接选择，多题完成后提交。", fullReportRef: "event:qa-immutable-report" });
    for (const [index, item] of questionCases.entries()) {
      const at = now - 20_000 + index;
      const { card, snapshot } = questionFixture(item, taskId, at);
      const request = yield* Schema.decodeUnknown(SessionRequest)(snapshot.request);
      yield* tx.insert("session_requests", {
        id: request.id, taskId, request, state: card.state,
        ...(item.phase ? { answerClaim: { claimId: `${item.id}-claim`, answer: sampleAnswer, decisionLogId: `${item.id}-log`, phase: item.phase, updatedAt: now } } : {}),
      });
      yield* tx.insert("main_thread_messages", {
        id: MessageId.make(`${item.id}-message`), at, author: { botId, taskId }, kind: "question-card", taskId, text: card.prompt, card,
      });
    }
  }));
  const audit = store.transaction((tx) => Effect.gen(function* () {
    const events = yield* tx.list("events", { limit: Number.MAX_SAFE_INTEGER });
    const messages = yield* tx.list("main_thread_messages", { limit: Number.MAX_SAFE_INTEGER });
    return { messageCount: messages.length, actions: events.flatMap((entry) => entry.event.source === "user" && entry.event.kind === "ui-action" ? [{ id: entry.id, action: entry.event.action }] : []), userMessages: messages.filter((entry) => entry.author === "user" && !entry.id.startsWith("qa-")) };
  }));
  const commands = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
  const reader = yield* Effect.acquireRelease(Effect.sync(() => createInterface({ input: process.stdin })), (reader) => Effect.sync(() => reader.close()));
  reader.on("line", (line) => Effect.runFork(Queue.offer(commands, line)));
  yield* Effect.forever(Queue.take(commands).pipe(Effect.flatMap((line) => Effect.gen(function* () {
    const command = yield* Schema.decodeUnknown(Schema.parseJson(Command))(line, { onExcessProperty: "error" });
    if (command.command === "create-bot") {
      const source = (yield* config.readBots).find((bot) => bot.id === botId);
      if (!source) return yield* Effect.fail(new FixtureError({ message: "Missing fixture bot" }));
      yield* admin.createBot({ ...source, id: BotId.make("qa-observations"), name: "观测助手" }, taskId);
    } else if (command.command === "source-report") {
      const report = `MCP 通过统一协议连接模型与外部工具。参考 [MCP 官方文档](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro)。\n\n[长地址复制测试](https://example.com/${"long-path/".repeat(40)}intro?q=one&lang=zh#section)\n\n${"这段合成报告用于验证最后截断时仍保留完整来源。".repeat(20)}`;
      const id = `qa-source-${crypto.randomUUID()}`;
      yield* store.transaction((tx) => Effect.gen(function* () {
        yield* tx.insert("events", { id, at: Date.now(), event: { source: "session", kind: "turn.completed", taskId, event: {kind: "turn.completed", turnId: id, ok: true, finalReport: report} } });
        yield* tx.insert("main_thread_messages", { id: MessageId.make(id), at: Date.now(), author: { botId, taskId }, kind: "reply", taskId, text: truncateReport(report), sources: reportSources(report), fullReportRef: `event:${id}` });
      }));
    } else if (command.command === "append") {
      yield* store.transaction((tx) => tx.insert("main_thread_messages", { id: MessageId.make(`qa-live-${crypto.randomUUID()}`), at: Date.now(), author: { botId, taskId }, kind: "reply", taskId, text: command.text }));
    } else if (command.command === "phase" || command.command === "settle") {
      yield* store.transaction((tx) => Effect.gen(function* () {
        const found = yield* tx.get("session_requests", command.requestId);
        if (Option.isNone(found)) return yield* Effect.fail(new FixtureError({ message: "Unknown fixture request" }));
        const events = yield* tx.list("events", { limit: Number.MAX_SAFE_INTEGER });
        const submitted = events.find((entry) => entry.event.source === "user" && entry.event.kind === "ui-action" && entry.event.action.type === "question-answer" && entry.event.action.requestId === command.requestId);
        const action = submitted?.event.source === "user" && submitted.event.kind === "ui-action" && submitted.event.action.type === "question-answer" ? submitted.event.action : undefined;
        const answer = action?.answer ?? found.value.answerClaim?.answer;
        if (!answer) return yield* Effect.fail(new FixtureError({ message: "Submit an explicit synthetic answer before changing its phase" }));
        yield* tx.set("session_requests", { ...found.value, state: command.command === "settle" ? "answered" : found.value.state, answerClaim: { claimId: `${command.requestId}-claim`, answer, decisionLogId: `${command.requestId}-log`, phase: command.command === "settle" ? "delivered" : command.phase, updatedAt: Date.now() } });
        if (command.command === "settle") {
          const message = yield* tx.get("main_thread_messages", `${command.requestId}-message`);
          if (Option.isSome(message) && message.value.card) yield* tx.set("main_thread_messages", { ...message.value, card: { ...message.value.card, state: "answered" } });
        }
      }));
    }
    const receipt = yield* audit;
    yield* Effect.sync(() => { writeFileSync(join(directory, "audit.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify({ command: command.command, ...receipt })); });
  }).pipe(Effect.catchAll(() => Effect.sync(() => console.log(JSON.stringify({ error: "Fixture command failed" })))))))).pipe(Effect.forkScoped);
  const server = yield* HttpServer;
  const previewPort = yield* freePort;
  const preview = yield* Effect.acquireRelease(Effect.sync(() => {
    const child = spawn(process.execPath, [resolve("apps/desktop/scripts/preview.mjs")], { env: { ...process.env, AUT_DATA_DIR: directory, AUT_PORT: String(server.port), AUT_PREVIEW_PORT: String(previewPort) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    return child;
  }), (child) => Effect.sync(() => { if (child.exitCode === null) child.kill("SIGTERM"); }));
  const receipt = { directory, apiPort: server.port, previewPort, url: `http://127.0.0.1:${previewPort}`, fixturePid: process.pid, previewPid: preview.pid, requests: ["qa-single", "qa-latch", "qa-multi", "qa-open", ...phases.map((phase) => `qa-${phase}`)], reportRef: "event:qa-immutable-report" };
  yield* Effect.sync(() => { writeFileSync(join(directory, "runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); console.log(JSON.stringify(receipt)); });
  yield* Effect.async<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    return Effect.sync(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); });
  });
}).pipe(Effect.provide(DaemonApiLive({ dataDirectory: directory, port: 0 }))));
await Effect.runPromise(program);

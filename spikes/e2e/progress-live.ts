// Opt-in synthetic acceptance: all mutations use the real daemon API; native thread/read is audit only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { NodeTransport } from "../../packages/adapters/dist/codex/transport.js";
import { ThreadTranscript } from "../../packages/adapters/dist/codex/wire.js";
import {
  AcceptedResponse,
  ConfigResponse,
  MessageResponse,
  ReportResponse,
  type HarnessInstanceConfig,
  type Task,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for this opt-in live acceptance probe");
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const cliVersionSlug = cliVersion.replace(/^codex-cli\s+/, "").replace(/[^A-Za-z0-9._-]/g, "_");
const dataDirectory = fixtureDirectory();
const expectedReport = "这是一份合成测试报告。三个测试都已通过，结果可以使用，没有发现阻塞问题。".repeat(12);
const progressQuestion = "这个回声测试得出了哪些具体结论？请依据已完成的报告解释实际结果和仍然未知的内容。这是内容提问，不是状态查询。";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const auditTranscript = (task: Task, instance: HarnessInstanceConfig) => Effect.scoped(Effect.gen(function* () {
  yield* assert(task.session.cursor?.kind === "codex", "The fixture task has no Codex cursor");
  const cursor = yield* Schema.decodeUnknown(Schema.Struct({ threadId: Schema.String }))(task.session.cursor!.data);
  const transport = yield* NodeTransport.open({
    command: instance.command,
    args: ["app-server", "--stdio", ...instance.args],
    cwd: dataDirectory,
    ...(instance.env ? { env: instance.env } : {}),
    rpcTimeoutMs: 20_000,
  });
  yield* transport.request("initialize", { clientInfo: { name: "aut-progress-readonly-audit", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  yield* transport.send({ method: "initialized", params: {} });
  return yield* transport.request("thread/read", { threadId: cursor.threadId, includeTurns: true }).pipe(Effect.flatMap(Schema.decodeUnknown(ThreadTranscript)));
}));

const result = await Effect.runPromise(withDaemon(dataDirectory, (api) => Effect.gen(function* () {
  const bot = yield* configure(api, dataDirectory);
  console.log(JSON.stringify({ stage: "configured", dataDirectory, cliVersion, model: bot.modelSelection.model }));
  const started = Date.now();
  yield* api.request("/v1/messages", MessageResponse, "POST", {
    id: "e2e-long-report",
    text: `请回声助手执行一次回声测试：最终回复必须原样输出以下报告（不要缩写或新增内容）：\n${expectedReport}`,
  });
  const completed = yield* api.wait(api.messages, (messages) => messages.some((message) => message.kind === "reply" && message.fullReportRef !== undefined), "180 seconds");
  const first = completed.find((message) => message.kind === "reply" && message.fullReportRef !== undefined)!;
  const task = (yield* api.tasks).find((value) => value.id === first.taskId);
  yield* assert(task?.botId === bot.id && task.status === "idle", "The synthetic worker did not complete as the configured fixture bot");
  yield* assert(task!.lastReport && task!.lastReport.rewrites > 0 && task!.lastReport.rewrites <= 2, "The long report did not use the bounded rewrite path");
  yield* assert(Array.from(first.text).length <= 200, "The delivered long-report summary exceeded 200 characters");
  const originalReport = yield* api.request(`/v1/reports/${encodeURIComponent(first.fullReportRef!)}`, ReportResponse);
  yield* assert(originalReport.text === task!.lastReport!.full && Array.from(originalReport.text).length > 200, "The full-report API did not preserve the original long worker report");
  const config = yield* api.request("/v1/config", ConfigResponse);
  const instance = config.harnessInstances.find((value) => value.id === task!.session.instanceId);
  yield* assert(instance, "The fixture harness configuration is missing");
  const before = yield* auditTranscript(task!, instance!);
  yield* assert(before.thread.turns.length === 1, "The original worker acquired extra turns while its report was rewritten");
  console.log(JSON.stringify({ stage: "long-report", sourceCharacters: Array.from(originalReport.text).length, deliveredCharacters: Array.from(first.text).length, rewrites: task!.lastReport!.rewrites }));
  const beforeTask = JSON.stringify(task);
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "quote-reply", quotedMessageId: first.id, text: progressQuestion });
  const progressed = yield* api.wait(api.messages, (messages) => messages.some((message) => message.id.startsWith("progress:")), "180 seconds");
  const deep = progressed.find((message) => message.id.startsWith("progress:"))!;
  yield* assert(deep.kind === "reply" && typeof deep.author === "object" && deep.author.botId === bot.id && deep.taskId === task!.id, "The content query did not produce a bot-authored deep answer");
  yield* assert(deep.fullReportRef && deep.fullReportRef !== first.fullReportRef, "Deep progress lacks an independent immutable full report");
  yield* assert(Array.from(deep.text).length <= 200, "The deep-query reply exceeded the gate length limit");
  const deepReport = yield* api.request(`/v1/reports/${encodeURIComponent(deep.fullReportRef!)}`, ReportResponse);
  const originalAgain = yield* api.request(`/v1/reports/${encodeURIComponent(first.fullReportRef!)}`, ReportResponse);
  yield* assert(originalAgain.text === originalReport.text, "The old full-report reference changed after a deep query");
  const afterTask = (yield* api.tasks).find((value) => value.id === task!.id);
  yield* assert(JSON.stringify(afterTask) === beforeTask, "Deep progress changed the original persisted task");
  const after = yield* auditTranscript(task!, instance!);
  yield* assert(JSON.stringify(before) === JSON.stringify(after), "Deep progress contaminated the original session transcript");
  const logs = yield* api.logs;
  const deepDecision = logs.find((log) => log.id === deep.decisionLogId);
  yield* assert(deepDecision?.output && "op" in deepDecision.output && deepDecision.output.op === "ask" && deepDecision.output.mode === "deep" && deepDecision.execution.ok, "The original classifier did not route and log ask(deep)");
  const gates = logs.filter((log) => log.tree === "reply-gate");
  yield* assert(gates.length === 2 && gates.every((log) => log.execution.ok && log.classifierCalls.length > 0), "Both user-facing reports must have successful real classifier gate logs");
  const events = yield* api.events;
  yield* assert(!events.some((event) => event.event.source === "session" && event.event.event.kind === "request.opened" && event.event.event.request.kind === "question"), "Unexpected native question; the probe never answers questions");
  return {
    at: new Date().toISOString(), model: bot.modelSelection.model, temporaryDataDirectory: true,
    elapsedMs: Date.now() - started,
    sourceReport: { characters: Array.from(originalReport.text).length, sha256: hash(originalReport.text), fullReportRef: first.fullReportRef, exactFixturePreserved: originalReport.text === expectedReport },
    delivered: { text: first.text, characters: Array.from(first.text).length, rewrites: task!.lastReport!.rewrites },
    deep: { text: deep.text, originalReport: deepReport.text, fullReportRef: deep.fullReportRef, decisionLogId: deep.decisionLogId, source: deep.author },
    isolation: { taskUnchanged: true, originalReportUnchanged: true, originalTranscriptUnchanged: true, originalTurnCount: before.thread.turns.length, beforeSha256: hash(before), afterSha256: hash(after), auditMethods: ["initialize", "initialized", "thread/read"] },
    decisionLogs: logs.map((log) => ({ id: log.id, tree: log.tree, path: log.path, output: log.output, execution: log.execution, classifierCalls: log.classifierCalls.map((call) => ({ backend: call.backend, model: call.model, latencyMs: call.latencyMs, response: call.response, error: call.error })) })),
    queryCompletedEvents: events.filter((event) => event.id.startsWith("progress:") && event.event.source === "session" && event.event.event.kind === "turn.completed").map((event) => event.id),
  };
})).pipe(Effect.timeout("8 minutes")));
let children: string[] = [];
try { children = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { /* No children is the expected result. */ }
if (children.length) throw new Error("The progress probe leaked child processes");
const output = process.env.AUT_E2E_RESULT ?? resolve(`spikes/e2e/results/progress-${cliVersionSlug}.json`);
await Effect.runPromise(writeEvidence(output, { cliVersion, ...result, childProcessesAfterScope: children }));
console.log(JSON.stringify({ stage: "complete", output, originalTranscriptUnchanged: result.isolation.originalTranscriptUnchanged, childProcessesAfterScope: children }));

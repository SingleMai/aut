// Opt-in main-thread queue/steer acceptance using a scoped synthetic native question.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse, BotResponse, BotsResponse, MessageResponse, ReportResponse, RequestResponse,
  type DecisionLog, type MainThreadMessage,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, type LiveClient, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for this opt-in probe");
const dataDirectory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", dataDirectory, cliVersion }));
const childPids = new Set<number>();
const observeChildren = () => Effect.sync(() => {
  let output = "";
  try { output = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }); } catch { return; }
  for (const value of output.trim().split("\n")) if (value) childPids.add(Number(value));
});
const sendLog = (logs: readonly DecisionLog[], taskId: string, text: string) => logs.find((log) =>
  log.tree === "inbound" && log.output && "op" in log.output && log.output.op === "send"
  && log.output.taskId === taskId && JSON.stringify(log.input.state).includes(text));
const originalReport = (api: LiveClient, message: MainThreadMessage) => message.fullReportRef
  ? api.request(`/v1/reports/${encodeURIComponent(message.fullReportRef)}`, ReportResponse)
  : Effect.fail(new Error("No immutable original report reference"));

const result = await Effect.runPromise(withDaemon(dataDirectory, (api) => Effect.gen(function* () {
  const bot = yield* configure(api, dataDirectory);
  for (const entry of (yield* api.request("/v1/bots", BotsResponse)).bots)
    yield* api.request(`/v1/bots/${encodeURIComponent(entry.id)}`, BotResponse, "PUT", {
      ...entry, modelSelection: { ...entry.modelSelection, effort: "low" },
    });
  yield* api.request(`/v1/bots/${encodeURIComponent(bot.id)}`, BotResponse, "PUT", {
    ...bot,
    soul: `${bot.soul}\nSynthetic delivery fixtures: when the user requests QUEUE_START, call the native request_user_input exactly once with id queue_color, header Color, question Which queue fixture color?, and two options labeled exactly Blue and Red. Never answer your own question. After the explicit user selects Blue, reply in Chinese exactly 第一轮测试已完成。 When the user requests STEER_START, first emit commentary containing STEER_READY, then execute the shell command sleep 30, then reply 原始结果。 The wait exists so a later user correction can reach the current native turn. Apply such corrections in that same turn. Do not ask any questions for STEER_START. For other messages follow the user's requested short echo text.`,
  });
  console.log(JSON.stringify({ stage: "configured", model: bot.modelSelection.model }));
  yield* api.request("/v1/messages", MessageResponse, "POST", {
    id: "e2e-delivery-new",
    text: "请回声助手执行新的独立排队测试 QUEUE_START。",
  });
  const questionMessages = yield* api.wait(api.messages, (messages) => messages.some((message) => message.kind === "question-card"), "180 seconds");
  const questionMessage = questionMessages.find((message) => message.kind === "question-card");
  if (!questionMessage?.taskId || !questionMessage.card?.requestId)
    return yield* Effect.fail(new Error("The queue fixture did not open a native question card"));
  const taskId = questionMessage.taskId;
  const card = questionMessage.card;
  const requestId = questionMessage.card.requestId;
  const questionTask = (yield* api.tasks).find((task) => task.id === taskId);
  yield* assert(questionTask?.botId === bot.id && questionTask.session.cursor, "The fixture did not reach the intended persistent worker session");
  const questionResponse = yield* api.request(`/v1/requests/${encodeURIComponent(requestId)}`, RequestResponse);
  const question = questionResponse.request.questions[0];
  yield* assert(questionResponse.request.kind === "question" && questionResponse.request.questions.length === 1
    && question?.id === "queue_color" && question.text === "Which queue fixture color?"
    && JSON.stringify(question.options?.map((option) => option.label)) === JSON.stringify(["Blue", "Red"]),
    "Unexpected native question; no fixture answer was sent");
  const queueText = "请在这个任务当前回合完成后，再追加回复：排队测试已完成。";
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "quote-reply", quotedMessageId: questionMessage.id, text: queueText });
  const queuedLogs = yield* api.wait(api.logs, (logs) => sendLog(logs, taskId, queueText) !== undefined, "90 seconds");
  const queueDecision = sendLog(queuedLogs, taskId, queueText)!;
  yield* assert(queueDecision.output && "op" in queueDecision.output && queueDecision.output.op === "send" && queueDecision.output.delivery === "queue", "The real classifier did not choose queue delivery");
  const queued = (yield* api.wait(api.tasks, (tasks) => tasks.find((task) => task.id === taskId)?.queue.length === 1)).find((task) => task.id === taskId);
  yield* assert(queued?.status === "waiting_user" && queued.pendingRequestIds.includes(requestId), "Queue delivery changed the active native question state");
  yield* assert((yield* api.request(`/v1/requests/${encodeURIComponent(requestId)}`, RequestResponse)).answerState === undefined, "The queued instruction was incorrectly sent as a question answer");
  yield* observeChildren();
  yield* api.request("/v1/actions", AcceptedResponse, "POST", {
    type: "question-answer", cardId: card.id, requestId,
    answer: { perQuestion: [{ questionId: question!.id, optionIds: [question!.options![0]!.id] }] },
  });
  const completed = yield* api.wait(api.messages, (messages) => messages.filter((message) => message.kind === "reply" && message.taskId === taskId).length >= 2, "240 seconds");
  const replies = completed.filter((message) => message.kind === "reply" && message.taskId === taskId);
  const firstReport = yield* originalReport(api, replies[0]!);
  const queuedReport = yield* originalReport(api, replies[1]!);
  yield* assert(firstReport.text.includes("第一轮测试已完成") && queuedReport.text.includes("排队测试已完成"), "Queued work did not drain after the original question turn");
  yield* assert((yield* api.tasks).find((task) => task.id === taskId)?.queue.length === 0, "The completed queue did not drain");
  console.log(JSON.stringify({ stage: "queue-complete", taskId, queueDelivery: "queue" }));

  const longText = "继续这个任务执行纠偏测试 STEER_START。";
  const beforeSteerEvents = yield* api.events;
  const eventIdsBefore = new Set(beforeSteerEvents.map((record) => record.id));
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "quote-reply", quotedMessageId: replies[1]!.id, text: longText });
  const currentText = (events: Effect.Effect.Success<typeof api.events>) => events.filter((record) =>
    !eventIdsBefore.has(record.id) && record.id.startsWith("session:") && record.event.source === "session"
    && record.event.taskId === taskId && record.event.event.kind === "message.delta")
    .map((record) => record.event.source === "session" && record.event.event.kind === "message.delta" ? record.event.event.text : "").join("");
  const runningEvents = yield* api.wait(api.events, (events) => currentText(events).includes("STEER_READY"), "180 seconds");
  const parentTurns = (events: Effect.Effect.Success<typeof api.events>) => events.filter((record) =>
    !eventIdsBefore.has(record.id) && record.id.startsWith("session:") && record.event.source === "session"
    && record.event.taskId === taskId && record.event.event.kind === "turn.started");
  yield* assert(parentTurns(runningEvents).length === 1, "The steering fixture did not start exactly one parent turn");
  yield* assert((yield* api.tasks).find((task) => task.id === taskId)?.status === "running", "The native turn ended before its correction could be submitted");
  const steerText = "立即把当前正在执行的任务结果改为：纠偏测试已完成。";
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "quote-reply", quotedMessageId: replies[1]!.id, text: steerText });
  const steeringLogs = yield* api.wait(api.logs, (logs) => sendLog(logs, taskId, steerText) !== undefined, "90 seconds");
  const steerDecision = sendLog(steeringLogs, taskId, steerText)!;
  yield* assert(steerDecision.output && "op" in steerDecision.output && steerDecision.output.op === "send" && steerDecision.output.delivery === "steer", "The real classifier did not choose steer delivery");
  const finalMessages = yield* api.wait(api.messages, (messages) => messages.filter((message) => message.kind === "reply" && message.taskId === taskId).length >= 3, "240 seconds");
  const steeredReply = finalMessages.filter((message) => message.kind === "reply" && message.taskId === taskId)[2]!;
  const steeredReport = yield* originalReport(api, steeredReply);
  yield* assert(steeredReport.text.includes("纠偏测试已完成"), "The current native turn did not incorporate the steering instruction");
  const finalEvents = yield* api.events;
  yield* assert(parentTurns(finalEvents).length === 1, "Steering unexpectedly restarted or queued a second parent turn");
  const logs = yield* api.logs;
  const finalSteerLog = sendLog(logs, taskId, steerText)!;
  yield* assert(finalSteerLog.execution.ok && !(finalSteerLog.execution.degraded?.length), "Steering was downgraded instead of reaching the active turn");
  const finalTask = (yield* api.tasks).find((task) => task.id === taskId);
  yield* assert(finalTask?.status === "idle" && finalTask.queue.length === 0, "The steered task did not settle idle with an empty queue");
  yield* assert(JSON.stringify(finalTask!.session) === JSON.stringify(questionTask!.session), "Delivery changed the worker session cursor");
  return { at: new Date().toISOString(), cliVersion, dataDirectory,
    model: bot.modelSelection.model, taskId, questionTask, taskWhileQueued: queued, firstReport, queuedReport, steeredReport,
    queueDecisionId: queueDecision.id, steerDecisionId: steerDecision.id, steerParentTurnCount: parentTurns(finalEvents).length,
    finalTask, decisionLogs: logs, events: finalEvents, messages: finalMessages };
})).pipe(Effect.timeout("15 minutes")));
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error("The delivery acceptance leaked a scoped child process");
const output = process.env.AUT_E2E_DELIVERY_RESULT ?? join(dataDirectory, "delivery-result.json");
await Effect.runPromise(writeEvidence(output, { ...result, childPids: [...childPids], alive }));
console.log(JSON.stringify({ stage: "complete", output, alive }));

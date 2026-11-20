// Opt-in full-daemon native question acceptance. Only exact synthetic fixtures receive test answers.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse,
  BotResponse,
  BotsResponse,
  MessageResponse,
  RequestResponse,
  ReportResponse,
  type MainThreadMessage,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for this opt-in live acceptance probe");
const dataDirectory = fixtureDirectory();
console.log(JSON.stringify({ stage: "starting", dataDirectory }));
const childPids = new Set<number>();
const observeChildren = () => Effect.sync(() => {
  let output = "";
  try { output = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }); }
  catch { return; }
  for (const value of output.trim().split("\n")) if (value) childPids.add(Number(value));
});
const result = await Effect.runPromise(withDaemon(dataDirectory, (api) => Effect.gen(function* () {
  const bot = yield* configure(api, dataDirectory);
  // This isolated fixture uses a low effort budget, without changing the CLI provider.
  for (const systemBot of (yield* api.request("/v1/bots", BotsResponse)).bots.filter((entry) => entry.system))
    yield* api.request(`/v1/bots/${encodeURIComponent(systemBot.id)}`, BotResponse, "PUT", {
      ...systemBot, modelSelection: { ...systemBot.modelSelection, effort: "low" },
    });
  console.log(JSON.stringify({ stage: "configured", model: bot.modelSelection.model }));
  const runs = [];
  const previousCards = new Set<string>();
  const previousReplies = new Set<string>();
  for (const mode of ["sync", "async"] as const) {
    const fixture = mode === "sync"
      ? "Explicit synthetic integration test: call request_user_input exactly once with TWO questions. First id probe_color, header Color, question Which fixture color?, options Blue / Red. Second id probe_shape, header Shape, question Which fixture shape?, options Circle / Square. Do not answer yourself. Wait for explicit user answers. After receiving Blue and Circle, output exactly QUESTIONS_SYNC_OK:Blue:Circle. If unavailable, output TOOL_UNAVAILABLE."
      : "Explicit synthetic integration test: call request_user_input_async to ask 'Which fixture color?' with options Blue and Red. Immediately send commentary saying ASYNC_WORK_CONTINUES, then run shell command sleep 20 so independent work continues. Do not answer yourself. Wait to receive the explicit user reply, then output exactly QUESTIONS_ASYNC_OK:Blue. If unavailable, output ASYNC_UNAVAILABLE.";
    const submitted = yield* api.request("/v1/messages", MessageResponse, "POST", {
      id: `e2e-question-${mode}`,
      text: `请回声助手执行以下新的独立原生提问集成测试。\n${fixture}`,
    });
    const messages = yield* api.wait(api.messages, (values) => values.some((message) =>
      message.kind === "question-card" && message.card && !previousCards.has(message.card.id)), "180 seconds");
    const cardMessage: MainThreadMessage | undefined = messages.find((message) =>
      message.kind === "question-card" && message.card && !previousCards.has(message.card.id));
    if (!cardMessage?.card?.requestId || !cardMessage.taskId)
      return yield* Effect.fail(new Error("Missing full-group native question card"));
    const card = cardMessage.card;
    previousCards.add(card.id);
    const requestId = cardMessage.card.requestId;
    const original = yield* api.request(`/v1/requests/${encodeURIComponent(requestId)}`, RequestResponse);
    const request = original.request;
    const nativeMethod = typeof request.raw === "object" && request.raw !== null && "method" in request.raw
      ? request.raw.method : undefined;
    yield* assert(nativeMethod === (mode === "sync" ? "item/tool/requestUserInput" : "item/completed"),
      "The fixture did not use the expected native question protocol");
    const expected = mode === "sync" ? ["Which fixture color?", "Which fixture shape?"] : ["Which fixture color?"];
    yield* assert(request.kind === "question" && request.taskId === cardMessage.taskId
      && request.questions.length === expected.length && request.questions.every((question, index) =>
        question.text === expected[index] && JSON.stringify(question.options?.map((option) => option.label))
          === JSON.stringify(index === 0 ? ["Blue", "Red"] : ["Circle", "Square"])),
    "Unexpected native question: no test answer was sent");
    if (mode === "sync") yield* assert(request.questions[0]?.id === "probe_color" && request.questions[1]?.id === "probe_shape",
      "Unexpected native synchronous question IDs: no answer was sent");
    const pendingTask = (yield* api.tasks).find((task) => task.id === request.taskId);
    yield* assert(pendingTask?.status === "waiting_user" && pendingTask.pendingRequestIds.includes(requestId),
      "Pending native question is missing from the task state");
    yield* assert(original.answerState === undefined && card.state === "open", "The native question was answered automatically");
    let independentWorkObserved = false;
    if (mode === "async") {
      const afterQuestionText = (events: Effect.Effect.Success<typeof api.events>) => events
        .filter((record) => record.at >= request.openedAt && record.event.source === "session"
          && record.event.taskId === request.taskId && record.event.event.kind === "message.delta")
        .map((record) => record.event.source === "session" && record.event.event.kind === "message.delta"
          ? record.event.event.text : "").join("");
      const events = yield* api.wait(api.events, (events) => afterQuestionText(events).includes("ASYNC_WORK_CONTINUES"), "90 seconds");
      independentWorkObserved = afterQuestionText(events).includes("ASYNC_WORK_CONTINUES");
      yield* assert((yield* api.request(`/v1/requests/${encodeURIComponent(requestId)}`, RequestResponse)).answerState === undefined,
        "The async fixture received an answer before its independent work was observed");
    }
    yield* observeChildren();
    console.log(JSON.stringify({ stage: "question-card", mode, questionCount: request.questions.length, taskStatus: pendingTask?.status }));
    const answer = { perQuestion: request.questions.map((question) => ({
      questionId: question.id, optionIds: [question.options?.[0]?.id ?? "invalid"],
    })) };
    const actionStarted = Date.now();
    yield* api.request("/v1/actions", AcceptedResponse, "POST", {
      type: "question-answer", cardId: card.id, requestId, answer,
    });
    const actionAcceptedMs = Date.now() - actionStarted;
    console.log(JSON.stringify({ stage: "answer-accepted", mode, actionAcceptedMs }));
    const confirmed = yield* api.wait(api.request(`/v1/requests/${encodeURIComponent(requestId)}`, RequestResponse),
      (value) => value.answerState === "delivered", "180 seconds");
    const completed = yield* api.wait(api.messages, (values) => values.some((message) =>
      message.kind === "reply" && message.taskId === request.taskId && !previousReplies.has(message.id)), "180 seconds");
    const reply = completed.find((message) => message.kind === "reply" && message.taskId === request.taskId && !previousReplies.has(message.id));
    const marker = mode === "sync" ? "QUESTIONS_SYNC_OK:Blue:Circle" : "QUESTIONS_ASYNC_OK:Blue";
    if (!reply?.fullReportRef) return yield* Effect.fail(new Error("The native reply has no immutable full report reference"));
    const fullReport = yield* api.request(`/v1/reports/${encodeURIComponent(reply.fullReportRef)}`, ReportResponse);
    yield* assert(fullReport.text.includes(marker), "Original native channel did not continue with the explicit test answer");
    if (reply) previousReplies.add(reply.id);
    const closedCard = completed.find((message) => message.card?.id === card.id)?.card;
    yield* assert(closedCard?.state === "answered", "Confirmed answer did not close the question card");
    const task = (yield* api.tasks).find((task) => task.id === request.taskId);
    yield* assert(task?.status === "idle" && task.pendingRequestIds.length === 0, "Completed question turn is not idle");
    runs.push({ mode, submittedMessageId: submitted.message.id, taskId: request.taskId,
      questions: request.questions, nativeMethod, independentWorkObserved, waitingStatus: pendingTask?.status, answerState: confirmed.answerState,
      cardState: closedCard?.state, actionAcceptedMs, reply, fullReport, finalStatus: task?.status });
    console.log(JSON.stringify({ stage: "answered", mode, report: reply?.text }));
  }
  const logs = yield* api.logs;
  const events = yield* api.events;
  yield* assert(logs.filter((log) => log.tree === "request").length === 2, "Missing request tree decisions");
  yield* assert(logs.filter((log) => log.output && "op" in log.output && log.output.op === "answer").length === 2,
    "Missing native answer inbound decisions");
  yield* assert(logs.every((log) => log.execution.ok), "One or more question chain decisions failed");
  return { at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
    dataDirectory, model: bot.modelSelection.model, classifier: "real Jev via configured daemon",
    runs, eventCount: events.length, decisionLogs: logs };
})).pipe(Effect.timeout("12 minutes")));
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error("Scoped daemon processes remain alive");
const output = process.env.AUT_E2E_QUESTIONS_RESULT ?? join(dataDirectory, "questions-main-thread-result.json");
await Effect.runPromise(writeEvidence(output, { ...result, childPids: [...childPids], alive }));
console.log(JSON.stringify({ stage: "complete", output, childPids: [...childPids], alive }));

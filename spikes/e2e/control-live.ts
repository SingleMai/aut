// Opt-in lifecycle acceptance. Only isolated fixture bot settings and main-thread API actions are changed.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse, BotResponse, BotsResponse, MessageResponse, ReportResponse,
  type MainThreadMessage, type Task,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, type LiveClient, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for this opt-in probe");
const dataDirectory = fixtureDirectory();
console.log(JSON.stringify({ stage: "starting", dataDirectory }));
const childPids = new Set<number>();
const readChildren = () => {
  let output = "";
  try { output = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }); }
  catch { return []; }
  return output.trim().split("\n").filter(Boolean).map(Number);
};
const observeChildren = () => Effect.sync(() => {
  for (const pid of readChildren()) childPids.add(pid);
});
const startTask = (api: LiveClient, id: string, text: string) => Effect.gen(function* () {
  const previous = new Set((yield* api.tasks).map((task) => task.id));
  yield* api.request("/v1/messages", MessageResponse, "POST", { id, text });
  const routed = yield* api.wait(api.messages, (messages) => messages.some((message) =>
    message.author === "chief" && message.decisionLogId !== undefined
      && messages.findIndex((entry) => entry.id === message.id) > messages.findIndex((entry) => entry.id === id)), "90 seconds");
  const afterUser = routed.slice(routed.findIndex((entry) => entry.id === id) + 1);
  const clarify = afterUser.find((message) => message.kind === "clarify-card" && message.card?.state === "open");
  if (clarify?.card) {
    const option = clarify.card.options.find((entry) => entry.op?.op === "new")
      ?? clarify.card.options.find((entry) => entry.op?.op === "escalate");
    yield* assert(option, "The classifier clarification did not offer a route for the fixture");
    yield* api.request("/v1/actions", AcceptedResponse, "POST", {
      type: "card-choice", cardId: clarify.card.id, optionId: option!.id,
    });
  }
  const tasks = yield* api.wait(api.tasks, (tasks) => tasks.some((task) => !previous.has(task.id)), "90 seconds");
  const task = tasks.find((task) => !previous.has(task.id));
  if (!task) return yield* Effect.fail(new Error("No task was created for the fixture"));
  return task;
});
const waitMarker = (api: LiveClient, task: Task, marker: string) => Effect.gen(function* () {
  const text = (events: Effect.Effect.Success<typeof api.events>) => events
    .filter((record) => record.event.source === "session" && record.event.taskId === task.id && record.event.event.kind === "message.delta")
    .map((record) => record.event.source === "session" && record.event.event.kind === "message.delta" ? record.event.event.text : "").join("");
  yield* api.wait(api.events, (events) => text(events).includes(marker), "180 seconds");
  const current = (yield* api.tasks).find((entry) => entry.id === task.id);
  yield* assert(current?.status === "running" && current.session.cursor, "The fixture was not running with a saved native cursor");
  yield* observeChildren();
  return current!;
});
const waitReport = (api: LiveClient, taskId: string, phrase: string) => Effect.gen(function* () {
  const messages = yield* api.wait(api.messages, (messages) => messages.some((message) => message.kind === "reply" && message.taskId === taskId), "180 seconds");
  const reply: MainThreadMessage | undefined = messages.find((message) => message.kind === "reply" && message.taskId === taskId);
  if (!reply?.fullReportRef) return yield* Effect.fail(new Error("The report has no immutable original reference"));
  const original = yield* api.request(`/v1/reports/${encodeURIComponent(reply.fullReportRef)}`, ReportResponse);
  yield* assert(original.text.includes(phrase), "The resumed or retried worker did not return the expected original report");
  yield* assert((yield* api.tasks).find((task) => task.id === taskId)?.status === "idle", "The completed worker did not become idle");
  return { reply, original };
});

const initial = await Effect.runPromise(withDaemon(dataDirectory, (api) => Effect.gen(function* () {
  const bot = yield* configure(api, dataDirectory);
  for (const entry of (yield* api.request("/v1/bots", BotsResponse)).bots)
    yield* api.request(`/v1/bots/${encodeURIComponent(entry.id)}`, BotResponse, "PUT", {
      ...entry, modelSelection: { ...entry.modelSelection, effort: "low" },
    });
  console.log(JSON.stringify({ stage: "configured", model: bot.modelSelection.model }));

  const cancelTask = yield* startTask(api, "e2e-cancel", "请回声助手执行一个新的独立取消测试：先用 commentary 输出 CONTROL_CANCEL_READY，然后执行 shell 命令 sleep 60；等待结束后回复：取消测试的等待已结束。不要提问。 ");
  yield* waitMarker(api, cancelTask, "CONTROL_CANCEL_READY");
  const cancelAt = Date.now();
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "task-control", taskId: cancelTask.id, action: "cancel" });
  const cancelled = (yield* api.wait(api.tasks, (tasks) => tasks.find((task) => task.id === cancelTask.id)?.status === "cancelled")).find((task) => task.id === cancelTask.id);
  const cancelAcceptedMs = Date.now() - cancelAt;
  yield* Effect.sleep("1 second");
  yield* assert(!(yield* api.messages).some((message) => message.kind === "reply" && message.taskId === cancelTask.id), "A cancelled task published a late successful reply");
  console.log(JSON.stringify({ stage: "cancelled", taskId: cancelTask.id, cancelAcceptedMs }));

  const childrenBeforeFailure = yield* Effect.sync(() => new Set(readChildren()));
  const retryTask = yield* startTask(api, "e2e-retry", "请回声助手执行新的独立故障重试测试：第一次执行先用 commentary 输出 CONTROL_RETRY_READY，再执行 shell 命令 sleep 60。若发生外部进程故障后收到重复任务，不要再次等待，直接回复：重试测试已完成。正常等待完也回复同一句。不要提问。");
  yield* waitMarker(api, retryTask, "CONTROL_RETRY_READY");
  const candidates = yield* Effect.sync(() => readChildren().filter((pid) => !childrenBeforeFailure.has(pid)));
  yield* assert(candidates.length === 1, "The fault injection could not uniquely identify its synthetic harness child");
  const crashedPid = candidates[0]!;
  // The sole new direct child must be this probe's app-server before any signal is sent.
  yield* Effect.try(() => {
    const parent = execFileSync("ps", ["-p", String(crashedPid), "-o", "ppid="], { encoding: "utf8" }).trim();
    const command = execFileSync("ps", ["-p", String(crashedPid), "-o", "args="], { encoding: "utf8" });
    if (parent !== String(process.pid) || !command.includes("codex") || !command.includes("app-server"))
      throw new Error("The fault injection target is not this probe's Codex app-server");
    process.kill(crashedPid, "SIGKILL");
  });
  const failed = (yield* api.wait(api.tasks, (tasks) => tasks.find((task) => task.id === retryTask.id)?.status === "failed", "120 seconds")).find((task) => task.id === retryTask.id);
  yield* assert(failed?.status === "failed", "A crashed harness did not produce a failed task");
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "task-control", taskId: retryTask.id, action: "retry" });
  const retried = yield* waitReport(api, retryTask.id, "重试测试已完成");
  console.log(JSON.stringify({ stage: "retried", taskId: retryTask.id, finalStatus: "idle" }));

  const restartTask = yield* startTask(api, "e2e-daemon-restart", "请回声助手执行新的独立恢复测试：先用 commentary 输出 CONTROL_RESTART_READY，然后执行 shell 命令 sleep 60。若这个回合被中断后恢复，禁止再次执行等待，直接回复：恢复测试已完成。正常等完也回复同一句。不要提问。");
  const beforeRestart = yield* waitMarker(api, restartTask, "CONTROL_RESTART_READY");
  const eventsBeforeRestart = yield* api.events;
  return { model: bot.modelSelection.model, cancelTask: cancelled, cancelAcceptedMs, failedTask: failed, crashedPid, retryTaskId: retryTask.id, retried, beforeRestart, eventsBeforeRestart: eventsBeforeRestart.length };
})).pipe(Effect.timeout("12 minutes")));

console.log(JSON.stringify({ stage: "daemon-closed", taskId: initial.beforeRestart.id }));
const recovered = await Effect.runPromise(withDaemon(dataDirectory, (api) => Effect.gen(function* () {
  const task = (yield* api.tasks).find((task) => task.id === initial.beforeRestart.id);
  yield* assert(task?.status === "interrupted", "Daemon restart did not mark the active task interrupted");
  const startedBefore = (yield* api.events).filter((record) => record.event.source === "session" && record.event.taskId === task!.id && record.event.kind === "turn.started").length;
  yield* Effect.sleep("500 millis");
  const startedAfter = (yield* api.events).filter((record) => record.event.source === "session" && record.event.taskId === task!.id && record.event.kind === "turn.started").length;
  yield* assert(startedBefore === startedAfter, "Daemon restart automatically replayed an interrupted turn");
  yield* api.request("/v1/actions", AcceptedResponse, "POST", { type: "task-control", taskId: task!.id, action: "resume" });
  const resumed = yield* waitReport(api, task!.id, "恢复测试已完成");
  yield* observeChildren();
  const logs = yield* api.logs;
  yield* assert(logs.filter((log) => log.output && "op" in log.output && log.output.op === "control").length === 3, "Control actions are missing decision logs");
  return { taskAtStartup: task, automaticReplayCount: startedAfter - startedBefore, resumed, decisionLogs: logs };
})).pipe(Effect.timeout("5 minutes")));
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error("The lifecycle acceptance leaked a scoped child process");
const output = process.env.AUT_E2E_CONTROL_RESULT ?? join(dataDirectory, "control-result.json");
await Effect.runPromise(writeEvidence(output, { at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), dataDirectory, ...initial, ...recovered, childPids: [...childPids], alive }));
console.log(JSON.stringify({ stage: "complete", output, alive }));

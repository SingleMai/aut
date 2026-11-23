// Opt-in live validation for the trigger scheduler using an isolated aut directory.
// The probe exercises the same local API used by the desktop client and never mutates
// the user's existing ~/.aut directory.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  BotsResponse,
  MessagePageResponse,
  ReportResponse,
  TaskListResponse,
  TriggerResponse,
  TriggerRunsResponse,
  TriggersResponse,
  type MainThreadMessage,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for this opt-in live acceptance probe");

const dataDirectory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", dataDirectory, cliVersion }));

const result = await Effect.runPromise(
  withDaemon(dataDirectory, (api) =>
    Effect.gen(function* () {
      const bot = yield* configure(api, dataDirectory);
      const botCheck = yield* api.request("/v1/bots", BotsResponse);
      yield* assert(botCheck.bots.some((entry) => entry.id === bot.id), "The trigger fixture Bot was not persisted");

      const marker = "TRIGGER_E2E_OK";
      const scheduledAt = Date.now() + 3_000;
      const created = yield* api.request("/v1/triggers", TriggerResponse, "POST", {
        id: "trigger-e2e",
        name: "触发器集成测试",
        botId: bot.id,
        prompt: `这是触发器集成测试。请只回复唯一标记 ${marker}。不要提问，不要执行外部操作。`,
        payload: { marker, source: "trigger-live" },
        schedule: { kind: "once", at: scheduledAt },
        enabled: true,
      });
      yield* assert(
        created.trigger.enabled &&
          created.trigger.id === "trigger-e2e" &&
          created.trigger.nextAt === scheduledAt,
        "The once trigger did not retain its schedule",
      );
      console.log(JSON.stringify({ stage: "created", triggerId: created.trigger.id, scheduledAt }));

      const runs = () =>
        api
          .request(`/v1/triggers/${encodeURIComponent(created.trigger.id)}/runs`, TriggerRunsResponse)
          .pipe(Effect.map((response) => response.runs));
      const started = yield* api.wait(
        runs(),
        (values) => values.some((run) => run.status === "running" || run.status === "ran"),
        "180 seconds",
      );
      const active = started.find((run) => run.status === "running" || run.status === "ran");
      yield* assert(active, "The scheduler did not create a running trigger ledger entry");
      console.log(JSON.stringify({ stage: "started", runId: active!.id, status: active!.status }));

      const taskId = active!.taskId ?? `trigger:${active!.id}`;
      const tasks = () =>
        api.request("/v1/tasks?limit=50", TaskListResponse).pipe(Effect.map((response) => response.tasks));
      const taskList = yield* api.wait(
        tasks(),
        (values) => values.some((entry) => entry.id === taskId),
        "180 seconds",
      );
      const triggerTask = taskList.find((entry) => entry.id === taskId);
      yield* assert(triggerTask?.origin.kind === "trigger", "The trigger did not create a trigger task");
      yield* assert(triggerTask?.botId === bot.id, "The trigger task used the wrong Bot");

      const messages = () =>
        api.request("/v1/messages?limit=50", MessagePageResponse).pipe(
          Effect.map((response) => response.messages),
        );
      const delivered = yield* api.wait(
        messages(),
        (values) => values.some((message) => message.kind === "reply" && message.taskId === taskId),
        "240 seconds",
      );
      const reply = delivered.find(
        (message): message is MainThreadMessage =>
          message.kind === "reply" && message.taskId === taskId,
      );
      yield* assert(reply?.fullReportRef, "The trigger reply has no immutable report reference");
      yield* assert(reply!.text.includes(marker), "The delivered trigger reply is missing the fixture marker");
      const report = yield* api.request(
        `/v1/reports/${encodeURIComponent(reply!.fullReportRef!)}`,
        ReportResponse,
      );
      yield* assert(report.text.includes(marker), "The original trigger report is missing the fixture marker");

      const completedRuns = yield* api.wait(
        runs(),
        (values) => values.some((run) => run.id === active!.id && run.status === "ran"),
        "180 seconds",
      );
      const completed = completedRuns.find((run) => run.id === active!.id);
      yield* assert(completed?.taskId === taskId, "The completed trigger run has no task reference");
      yield* assert(completed?.finishedAt !== undefined, "The completed trigger run has no finish timestamp");
      const finalTaskList = yield* api.wait(
        tasks(),
        (values) => values.some((entry) => entry.id === taskId && entry.status === "idle"),
        "180 seconds",
      );
      const finalTask = finalTaskList.find((entry) => entry.id === taskId);
      yield* assert(finalTask?.status === "idle", "The trigger task did not become idle after its reply");
      const finalTriggerState = yield* api.request("/v1/triggers", TriggersResponse);
      const finishedTrigger = finalTriggerState.triggers.find((entry) => entry.id === created.trigger.id);
      yield* assert(
        finishedTrigger?.enabled === false && finishedTrigger.nextAt === undefined,
        "The once trigger did not disable itself after its only occurrence",
      );
      console.log(JSON.stringify({ stage: "completed", runId: completed!.id, taskId, reply: reply!.text }));

      const control = yield* api.request("/v1/triggers", TriggerResponse, "POST", {
        id: "trigger-e2e-control",
        name: "触发器控制测试",
        botId: bot.id,
        prompt: "这个控制测试不会在探针内到期。",
        payload: { source: "trigger-live-control" },
        schedule: { kind: "interval", startAt: Date.now() + 600_000, everyMs: 3_600_000 },
        enabled: true,
      });
      const paused = yield* api.request(
        `/v1/triggers/${encodeURIComponent(control.trigger.id)}/pause`,
        TriggerResponse,
        "POST",
      );
      yield* assert(!paused.trigger.enabled, "Pausing a trigger did not disable it");
      const resumed = yield* api.request(
        `/v1/triggers/${encodeURIComponent(control.trigger.id)}/resume`,
        TriggerResponse,
        "POST",
      );
      yield* assert(resumed.trigger.enabled, "Resuming a trigger did not enable it");
      const updated = yield* api.request(
        `/v1/triggers/${encodeURIComponent(control.trigger.id)}`,
        TriggerResponse,
        "PUT",
        { name: "触发器控制测试（已更新）", prompt: "更新后的控制测试。" },
      );
      yield* assert(
        updated.trigger.name === "触发器控制测试（已更新）" &&
          updated.trigger.prompt === "更新后的控制测试。" &&
          updated.trigger.enabled,
        "Updating a trigger did not preserve the resumed state",
      );

      const logs = yield* api.logs;
      const triggerLog = logs.find(
        (log) => log.tree === "trigger" && log.output && "op" in log.output && log.output.op === "new-trigger",
      );
      yield* assert(triggerLog?.execution.ok, "The trigger decision log is missing a successful execution");
      const events = yield* api.events;
      const fired = events.find(
        (record) => record.event.source === "trigger" && record.event.runId === active!.id,
      );
      yield* assert(fired, "The trigger fired event was not persisted");

      return {
        at: new Date().toISOString(),
        cliVersion,
        dataDirectory,
        model: bot.modelSelection.model,
        trigger: created.trigger,
        run: completed,
        task: finalTask,
        finishedTrigger,
        reply,
        report,
        control: {
          trigger: control.trigger,
          paused: paused.trigger,
          resumed: resumed.trigger,
          updated: updated.trigger,
        },
        triggerDecisionLog: triggerLog,
        firedEvent: fired,
      };
    }),
  ).pipe(Effect.timeout("10 minutes")),
);

const output = process.env.AUT_E2E_RESULT ?? join("spikes/e2e/results", "trigger-0.169.0.json");
await Effect.runPromise(writeEvidence(output, result));
console.log(JSON.stringify({ stage: "complete", output, runId: result.run.id, taskId: result.run.taskId }));

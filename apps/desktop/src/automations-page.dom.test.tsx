// @vitest-environment happy-dom
import {
  type BotConfig,
  BotId,
  TaskId,
  type Trigger,
  TriggerId,
  type TriggerRun,
  TriggerRunId,
} from "@aut/protocol";
import { Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { AutomationsPage } from "./automations-page.js";
import { createDesktopData } from "./desktop-data.js";

const bot: BotConfig = {
  id: BotId.make("reporter"),
  name: "报告助手",
  description: "生成报告",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
};

const trigger: Trigger = {
  id: TriggerId.make("morning-report"),
  name: "晨间报告",
  enabled: true,
  botId: bot.id,
  prompt: "生成今天的报告",
  payload: {},
  schedule: { kind: "interval", startAt: 1_000, everyMs: 3_600_000 },
  overlap: "skip",
  createdAt: 1_000,
  updatedAt: 1_000,
  nextAt: 3_601_000,
};

const run: TriggerRun = {
  id: TriggerRunId.make("run:morning-report:1"),
  triggerId: trigger.id,
  occurrenceKey: "morning-report:1",
  scheduledAt: 3_601_000,
  status: "ran",
  taskId: TaskId.make("trigger:run:morning-report:1"),
  startedAt: 3_601_001,
  finishedAt: 3_601_002,
};

afterEach(() => vi.restoreAllMocks());

const setup = () => {
  const data = createDesktopData();
  vi.spyOn(data, "refresh").mockReturnValue(Effect.void);
  const toggle = vi
    .spyOn(data, "toggleTrigger")
    .mockReturnValue(Effect.succeed({ trigger: { ...trigger, enabled: false } }));
  const listRuns = vi.spyOn(data, "listTriggerRuns").mockReturnValue(Effect.succeed([run]));
  const view = renderView(
    <AutomationsPage triggers={[trigger]} bots={[bot]} data={data} flash={vi.fn()} />,
  );
  return { ...view, toggle, listRuns };
};

it("renders the OpenMausBot-style automation card with readable schedule text", () => {
  const view = setup();
  expect(view.element.querySelector(".detail-card")?.textContent).toContain("每 1 小时");
  expect(view.element.textContent).toContain("晨间报告");
  expect(view.element.textContent).toContain("报告助手");
  expect(view.element.textContent).toContain("生成今天的报告");
  expect(
    view.element.querySelector<HTMLButtonElement>('[aria-label="编辑 晨间报告"]'),
  ).toBeTruthy();
  expect(
    view.element.querySelector<HTMLButtonElement>('[aria-label="暂停 晨间报告"]'),
  ).toBeTruthy();
});

it("pauses an automation through the card action", async () => {
  const view = setup();
  const button = view.element.querySelector<HTMLButtonElement>('[aria-label="暂停 晨间报告"]');
  if (!button) throw new Error("Missing pause button");
  await act(async () => button.click());
  expect(view.toggle).toHaveBeenCalledExactlyOnceWith(trigger.id, false);
});

it("loads run history lazily and shows the task identifier", async () => {
  const view = setup();
  const summary = view.element.querySelector<HTMLElement>(".automation-runs summary");
  if (!summary) throw new Error("Missing runs summary");
  expect(view.listRuns).not.toHaveBeenCalled();
  await act(async () => {
    summary.click();
    await Promise.resolve();
  });
  expect(view.listRuns).toHaveBeenCalledExactlyOnceWith(trigger.id);
  expect(view.element.querySelector(".automation-run-list")?.textContent).toContain(run.taskId);
});

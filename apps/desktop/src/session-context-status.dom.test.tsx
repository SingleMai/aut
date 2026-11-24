// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { renderView } from "../test/render.js";
import { contextPreviewResponse, contextPreviewTask } from "./preview/context-preview.js";
import { TaskSessionView } from "./task-session-view.js";

let view: ReturnType<typeof renderView> | undefined;
afterEach(() => {
  view = undefined;
});
async function show(example: string) {
  await act(async () => {
    const content = (
      <TaskSessionView
        task={contextPreviewTask}
        response={contextPreviewResponse(example)}
        busy={false}
        error=""
        load={() => {}}
      />
    );
    if (view) view.update(content);
    else view = renderView(content);
  });
}
async function openDetails() {
  const trigger = document.querySelector<HTMLButtonElement>(".session-context-trigger");
  if (!trigger) throw new Error("Missing context trigger");
  await act(async () => trigger.click());
}

it("shows upstream-style native percentages and a read-only details meter", async () => {
  await show("measured");
  expect(document.querySelector(".session-context-trigger")?.textContent).toBe("上下文 52%");
  await openDetails();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("104k / 200k tokens");
  expect(dialog?.querySelector("meter")?.getAttribute("value")).toBe("52");
  expect(dialog?.querySelectorAll("button")).toHaveLength(0);
});

it("keeps an open panel current through compaction and waits for new native usage", async () => {
  await show("measured");
  await openDetails();
  await show("compacting");
  expect(document.querySelector(".session-context-trigger")?.textContent).toBe("正在整理上下文…");
  expect(document.querySelector("meter")).toBeNull();
  expect(document.querySelector(".task-session-running")?.textContent).toContain("正在整理上下文");
  expect(document.querySelector(".task-session-item-note")?.textContent).toContain(
    "正在整理上下文",
  );
  await show("compacted");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "等待整理后的新用量读数",
  );
  expect(document.querySelector("meter")).toBeNull();
  await show("renewed");
  expect(document.querySelector(".session-context-trigger")?.textContent).toBe("上下文 12%");
  expect(document.querySelector("meter")?.getAttribute("value")).toBe("12");
  expect(document.querySelector(".task-session-item-note")?.textContent).toContain("上下文已整理");
});

it("omits unsupported controls and never fabricates a percentage for missing or unavailable readings", async () => {
  await show("unsupported");
  expect(document.querySelector(".session-context")).toBeNull();
  await show("tokens");
  expect(document.querySelector(".session-context-trigger")?.textContent).toBe("上下文 24k tokens");
  await openDetails();
  expect(document.querySelector("meter")).toBeNull();
  await show("unavailable");
  expect(document.querySelector(".session-context-trigger")?.textContent).toBe("上下文");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("当前无法读取");
  expect(document.querySelector("meter")).toBeNull();
});

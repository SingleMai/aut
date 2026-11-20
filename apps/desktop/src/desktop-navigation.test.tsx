// @vitest-environment happy-dom
import { BotId, type Task, TaskId, type TaskSessionResponse } from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import type { DesktopNotice } from "./bridge.js";
import { DesktopApp } from "./desktop-app.js";
import { t } from "./i18n.js";

function task(id: string, activity: number): Task {
  return {
    id: TaskId.make(id),
    title: id,
    botId: BotId.make("worker"),
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: activity,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  };
}
function start() {
  const tasks = [task("first", 10), task("latest", 20)];
  const list = Effect.runSync(Deferred.make<{ tasks: readonly Task[] }>());
  const listeners = new Set<(notice: DesktopNotice) => void>();
  vi.stubGlobal("aut", {
    onNotice(listener: (notice: DesktopNotice) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  vi.spyOn(desktopApi, "listTasks").mockReturnValue(Deferred.await(list));
  vi.spyOn(desktopApi, "listMessages").mockReturnValue(Effect.succeed({ messages: [] }));
  vi.spyOn(desktopApi, "listBots").mockReturnValue(Effect.succeed({ bots: [] }));
  vi.spyOn(desktopApi, "getConfig").mockReturnValue(Effect.succeed({ harnessInstances: [] }));
  const byId = (id: string) => {
    const found = tasks.find((t) => t.id === id);
    if (!found) throw new Error(`Unknown task ${id}`);
    return found;
  };
  vi.spyOn(desktopApi, "getTask").mockImplementation((id) => Effect.succeed({ task: byId(id) }));
  const read = vi.spyOn(desktopApi, "getTaskSession").mockImplementation((id) =>
    Effect.succeed({
      task: byId(id),
      availability: "pending",
      history: { turns: [] },
      hasEarlier: false,
    }),
  );
  const { element } = renderView(<DesktopApp />);
  const click = (selector: string) =>
    act(async () => {
      const button = element.querySelector<HTMLButtonElement>(selector);
      if (!button) throw new Error(`Missing button ${selector}`);
      button.click();
    });
  const load = () =>
    act(async () => {
      await Effect.runPromise(Deferred.succeed(list, { tasks }));
    });
  const changed = (id: string) =>
    act(async () => {
      for (const listener of listeners)
        listener({
          type: "event",
          event: {
            source: "session",
            taskId: TaskId.make(id),
            kind: "session.changed",
            event: { kind: "session.changed", turnId: "turn" },
          },
        });
    });
  return { element, read, click, load, byId, changed };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows examples after an empty read and leaves edited drafts under the user's control", async () => {
  const send = vi.spyOn(desktopApi, "sendMessage");
  const { element, click, load } = start();
  expect(element.querySelector(".example-prompt")).toBeNull();
  await load();
  const field = element.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!field) throw new Error("Missing composer");
  await click(".example-prompt:first-child");
  expect(field.value).toBe(t.examplePlan.draft);
  expect(document.activeElement).toBe(field);
  await click(".example-prompt:last-child");
  expect(field.value).toBe(t.exampleBot.draft);
  field.value = "Before / after";
  field.setSelectionRange(7, 8);
  await click(".example-prompt:first-child");
  expect(field.value).toBe(`Before ${t.examplePlan.draft} after`);
  expect(send).not.toHaveBeenCalled();
});

it("opens the most recently active task after a delayed first list and remembers an explicit selection", async () => {
  const { element, read, click, load } = start();
  await click("[data-view=tasks].nav-item");
  expect(read).not.toHaveBeenCalled();
  await load();
  const current = () =>
    element.querySelector<HTMLElement>("[data-task-id][aria-current=page]")?.dataset.taskId;
  expect(current()).toBe("latest");
  expect(read).toHaveBeenCalledWith("latest", undefined);
  expect(desktopApi.getTask).not.toHaveBeenCalled();
  await click("[data-task-id=first]");
  await click("[data-view=conversation].nav-item");
  await click("[data-view=tasks].nav-item");
  expect(current()).toBe("first");
  expect(element.querySelector(".task-detail-view:not([hidden]) h2")?.textContent).toBe("first");
});

it("drops a hidden task's pending reads and accepts fresh metadata on the next visit", async () => {
  const { element, read, click, load, byId, changed } = start();
  await load();
  const gate = Effect.runSync(Deferred.make<TaskSessionResponse>());
  const interrupted = vi.fn();
  read.mockReturnValueOnce(
    Deferred.await(gate).pipe(Effect.onInterrupt(() => Effect.sync(interrupted))),
  );
  await click("[data-task-id=latest]");
  await changed("latest");
  await changed("latest");
  expect(read).toHaveBeenCalledTimes(1);
  await click("[data-task-id=first]");
  expect(interrupted).toHaveBeenCalledOnce();
  const page = (title: string): TaskSessionResponse => ({
    task: { ...byId("latest"), title, updatedAt: 2 },
    availability: "available",
    history: { turns: [] },
    hasEarlier: false,
  });
  read.mockReturnValueOnce(Effect.succeed(page("Fresh task")));
  await click("[data-task-id=latest]");
  await act(async () => {
    await Effect.runPromise(Deferred.succeed(gate, page("Old task")));
  });
  expect(element.querySelector(".task-detail-view:not([hidden]) h2")?.textContent).toBe(
    "Fresh task",
  );
  expect(read.mock.calls.map(([id]) => id)).toEqual(["latest", "first", "latest"]);
});

it.each(["transport", "unavailable"] as const)(
  "keeps a failed older page retryable through a live refresh (%s)",
  async (failure) => {
    const { element, read, click, load, byId, changed } = start();
    await load();
    const page = (id: string, hasEarlier: boolean): TaskSessionResponse => ({
      task: byId("latest"),
      availability: "available",
      hasEarlier,
      ...(hasEarlier && { nextBefore: id }),
      history: {
        turns: [
          {
            id,
            status: "completed",
            items: [{ id, kind: "assistant", status: "completed", text: id }],
          },
        ],
      },
    });
    read
      .mockReturnValueOnce(Effect.succeed(page("recent-turn", true)))
      .mockReturnValueOnce(
        failure === "transport"
          ? Effect.fail(new UiError({ message: "Read interrupted" }))
          : Effect.succeed({
              task: byId("latest"),
              availability: "unavailable",
              message: "Read interrupted",
              history: { turns: [] },
              hasEarlier: false,
            }),
      )
      .mockReturnValueOnce(Effect.succeed(page("recent-turn", true)))
      .mockReturnValueOnce(Effect.succeed(page("older-turn", false)));
    await click("[data-task-id=latest]");
    await click(".task-session-earlier");
    expect(element.querySelector('[data-item-id="recent-turn"]')).toBeTruthy();
    expect(element.querySelector(".task-session-retry")?.hasAttribute("hidden")).toBe(false);
    await changed("latest");
    expect(element.querySelector(".task-session-retry")?.hasAttribute("hidden")).toBe(false);
    await click(".task-session-retry");
    expect(read.mock.calls.map(([, before]) => before)).toEqual([
      undefined,
      "recent-turn",
      undefined,
      "recent-turn",
    ]);
    expect(
      Array.from(element.querySelectorAll("[data-item-id]"), (row) =>
        row.getAttribute("data-item-id"),
      ),
    ).toEqual(["older-turn", "recent-turn"]);
    expect(element.querySelector(".task-session-retry")?.hasAttribute("hidden")).toBe(true);
  },
);

it("honours navigation away from tasks before the first response arrives", async () => {
  const { element, read, click, load } = start();
  await click("[data-view=tasks].nav-item");
  await click("[data-view=conversation].nav-item");
  await load();
  expect(element.querySelector(".workspace")?.getAttribute("data-view")).toBe("conversation");
  expect(read).not.toHaveBeenCalled();
});

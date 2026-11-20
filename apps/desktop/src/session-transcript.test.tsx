// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import {
  BotId,
  SessionHistory,
  type SessionItem,
  type SessionTurn,
  TaskId,
  type TaskSessionResponse,
} from "@aut/protocol";
import { Schema } from "effect";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "./openmausbot/lib/i18n.js";
import { SessionTranscript } from "./session-transcript.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = Schema.decodeUnknownSync(
  Schema.parseJson(Schema.Struct({ history: SessionHistory })),
)(
  readFileSync(new NodeURL("./fixtures/session-view-0.169.0.json", import.meta.url), "utf8"),
).history;

function required<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value == null) throw new Error("Required fixture or rendered element is missing");
  return value;
}

const recorded = required(fixture.turns[0]);
const user = required(recorded.items.find((item) => item.kind === "user"));
const progress = required(recorded.items.find((item) => item.phase === "commentary"));
const edit = required(recorded.items.find((item) => item.tool?.name === "fileChange"));
const command = required(recorded.items.find((item) => item.tool?.name === "commandExecution"));
const final = required(recorded.items.find((item) => item.phase === "final"));
const failed: SessionItem = {
  ...command,
  id: "synthetic-failed-after-recorded-tools",
  status: "failed",
  tool: {
    name: "fixture.read_file",
    input: "{}",
    output: '{"error":{"message":"Fixture permission denied"}}',
  },
};
const unknown: SessionItem = {
  ...command,
  id: "synthetic-unconfirmed-after-recorded-tools",
  status: "unknown",
  tool: { name: "fixture.future_tool", input: "{}", output: "" },
};

const snapshot = (
  items: readonly SessionItem[],
  status: SessionTurn["status"] = "running",
): TaskSessionResponse => ({
  task: {
    id: TaskId.make("task"),
    botId: BotId.make("worker"),
    title: "Recorded tool conversation",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  },
  history: { turns: [{ ...recorded, status, items }] },
  availability: "available",
  hasEarlier: false,
});

let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];
const scroll = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  setLocale("en");
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const render = (
  response: TaskSessionResponse,
  options: { showToolCalls?: boolean; focusedItemId?: string } = {},
) =>
  act(() =>
    root.render(
      <SessionTranscript
        response={response}
        advanced={false}
        showToolCalls={options.showToolCalls ?? true}
        {...(options.focusedItemId ? { focusedItemId: options.focusedItemId } : {})}
      />,
    ),
  );
const groupButton = () => required(host.querySelector<HTMLButtonElement>("button[aria-expanded]"));
const toolRow = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
const detailsFor = (id: string) =>
  required(toolRow(id)?.querySelector<HTMLDetailsElement>("details"));
const flushFrames = () =>
  act(() => {
    while (frames.length) frames.shift()?.(performance.now());
  });

function NavigationHarness({
  response,
  onConsumed,
}: {
  response: TaskSessionResponse;
  onConsumed: (id: string) => void;
}) {
  const [focused, setFocused] = useState<string>();
  return (
    <>
      <button type="button" data-testid="locate" onClick={() => setFocused(command.id)}>
        Locate
      </button>
      <SessionTranscript
        response={response}
        advanced={false}
        showToolCalls
        {...(focused ? { focusedItemId: focused } : {})}
        onFocusConsumed={(id) => {
          onConsumed(id);
          setFocused(undefined);
        }}
      />
    </>
  );
}

describe("SessionTranscript mounted with the recorded protocol fixture", () => {
  it("joins visible bubbles across hidden tools but splits at a visible tool or after fifteen minutes", () => {
    const at = 1_000_000;
    const first = { ...progress, startedAt: at };
    const second = { ...first, id: "second", startedAt: at + 500 };
    const later = { ...first, id: "later", startedAt: second.startedAt + 900_000 };
    const response = snapshot([first, { ...edit, startedAt: at + 200 }, second, later]);
    render(response);
    expect(toolRow(second.id)?.hasAttribute("data-joined-above")).toBe(false);
    render(response, { showToolCalls: false });
    expect(toolRow(first.id)?.hasAttribute("data-joined-below")).toBe(true);
    expect(toolRow(second.id)?.hasAttribute("data-joined-above")).toBe(true);
    expect(toolRow(later.id)?.hasAttribute("data-joined-above")).toBe(false);
    expect(host.querySelectorAll(".task-session-stamp")).toHaveLength(2);
  });

  it("keeps live tool activity visible during an async question and retires it when the task stops", () => {
    const live = snapshot([{ ...command, status: "running" }]);
    render({ ...live, task: { ...live.task, status: "waiting_user" } });
    expect(host.querySelector(".task-session-running")?.textContent).toContain("Run a command");
    render({ ...live, task: { ...live.task, status: "cancelled" } });
    expect(host.querySelector(".task-session-running")).toBeNull();
  });

  it("groups consecutive completed tools before the answer without hiding the progress text", () => {
    render(snapshot([user, progress, edit, command]));
    expect(groupButton().textContent).toBe("2 steps · Edit a file, Run a command");
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(0);
    expect(host.textContent).toContain(progress.text);
    expect(host.textContent).not.toContain("Worked for");
    act(() => groupButton().click());
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(2);
    expect(toolRow(edit.id)).not.toBeNull();
    expect(toolRow(command.id)).not.toBeNull();
  });

  it("waits for final completion and then folds only successful tools", () => {
    const streamingFinal: SessionItem = { ...final, status: "running" };
    const items = [user, edit, progress, command, failed, unknown, streamingFinal];
    render(snapshot(items));
    expect(host.textContent).not.toContain("Worked for");
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(4);

    render(snapshot([...items.slice(0, -1), final], "completed"));
    expect(groupButton().textContent).toMatch(/^Worked for /);
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(toolRow(edit.id)).toBeNull();
    expect(toolRow(command.id)).toBeNull();
    expect(host.textContent).toContain(progress.text);
    expect(host.textContent).toContain(final.text);
    expect(detailsFor(failed.id).querySelector("summary")?.getAttribute("aria-label")).toContain(
      "Fixture permission denied · Failed",
    );
    expect(detailsFor(unknown.id).querySelector("summary")?.getAttribute("aria-label")).toContain(
      "No result",
    );
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(2);
  });

  it("hides tool rows and groups while retaining original text and the final result", () => {
    const response = snapshot([user, progress, edit, command, failed, unknown, final], "completed");
    render(response);
    const textBefore = [...host.querySelectorAll(".task-session-text")].map(
      (node) => node.textContent,
    );
    render(response, { showToolCalls: false });
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(0);
    expect(host.querySelector("button[aria-expanded]")).toBeNull();
    expect(
      [...host.querySelectorAll(".task-session-text")].map((node) => node.textContent),
    ).toEqual(textBefore);
    expect(host.textContent).toContain(final.text);
    render(response, { showToolCalls: true });
    expect(groupButton()).toBeDefined();
    expect(host.querySelectorAll('[data-testid="tool-activity"]')).toHaveLength(2);
  });

  it("opens the containing folded turn when navigating to a native item ID", () => {
    const response = snapshot(recorded.items, "completed");
    render(response);
    expect(toolRow(command.id)).toBeNull();
    render(response, { focusedItemId: command.id });
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    const summary = required(detailsFor(command.id).querySelector("summary"));
    flushFrames();
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(scroll.mock.contexts.at(-1)).toBe(summary);
    expect(document.activeElement).toBe(summary);
  });

  it("can reopen the same containing group after the previous navigation was consumed", () => {
    const response = snapshot(recorded.items, "completed");
    const consumed = vi.fn();
    act(() => root.render(<NavigationHarness response={response} onConsumed={consumed} />));
    const locate = required(host.querySelector<HTMLButtonElement>('[data-testid="locate"]'));
    act(() => locate.click());
    flushFrames();
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(consumed).toHaveBeenLastCalledWith(command.id);
    act(() => groupButton().click());
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    act(() => locate.click());
    flushFrames();
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(consumed).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts.at(-1)).toBe(detailsFor(command.id).querySelector("summary"));
  });

  it("keeps an old turn's failure beside that turn before a newer successful conversation", () => {
    const response = snapshot(recorded.items, "completed");
    const oldMessage: SessionItem = {
      id: "old-message",
      kind: "assistant",
      status: "completed",
      text: "Older attempt",
    };
    const oldTurn: SessionTurn = {
      id: "older-turn",
      status: "failed",
      error: "Older native failure",
      items: [oldMessage],
    };
    render(
      { ...response, history: { turns: [oldTurn, ...response.history.turns] } },
      { showToolCalls: false },
    );
    const error = required(host.querySelector(".task-session-turn-error"));
    expect(error.textContent).toBe("Older native failure");
    expect(
      required(toolRow(oldMessage.id)).compareDocumentPosition(error) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      error.compareDocumentPosition(required(toolRow(user.id))) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(host.textContent).toContain(final.text);
  });

  it("keeps an empty interrupted turn visible before the next turn", () => {
    const response = snapshot(recorded.items, "completed");
    const interrupted: SessionTurn = { id: "empty-interrupted", status: "interrupted", items: [] };
    render({ ...response, history: { turns: [interrupted, ...response.history.turns] } });
    const status = required(host.querySelector(".task-session-turn-error"));
    expect(status.textContent).toBe("此回合已中断。");
    expect(
      status.compareDocumentPosition(required(toolRow(user.id))) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("preserves an opened run and native details across a new snapshot with full replacement output", async () => {
    const initial = snapshot([user, progress, edit, command]);
    render(initial);
    act(() => groupButton().click());
    const details = detailsFor(command.id);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    const fullOutput = `${command.tool?.output ?? ""}${"complete output\n".repeat(600)}`;
    const completed: SessionItem = {
      ...command,
      tool: { ...required(command.tool), output: fullOutput },
    };
    render(snapshot([user, progress, edit, completed]));
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(detailsFor(command.id)).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.getAttribute("aria-expanded")).toBe("true");
    expect([...details.querySelectorAll("pre")].at(-1)?.textContent).toBe(fullOutput);
    expect(host.querySelectorAll(`[data-item-id="${command.id}"]`)).toHaveLength(1);
  });

  it("updates a live single tool to its native completion while keeping details open", async () => {
    const running: SessionItem = {
      ...command,
      status: "running",
      tool: { ...required(command.tool), output: "streaming output" },
    };
    render(snapshot([user, progress, running]));
    const details = detailsFor(command.id);
    expect(details.querySelector("summary")?.getAttribute("aria-label")).toContain("Running");
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    render(snapshot([user, progress, command]));
    expect(detailsFor(command.id)).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")?.getAttribute("aria-label")).toContain("Completed");
    expect([...details.querySelectorAll("pre")].at(-1)?.textContent).toBe(command.tool?.output);
    expect(host.querySelectorAll(`[data-item-id="${command.id}"]`)).toHaveLength(1);
  });
});

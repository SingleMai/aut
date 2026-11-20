import { BotId, TaskId, type TaskSessionResponse } from "@aut/protocol";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { UiError } from "./api.js";
import { applySessionRead, mergeSessionPage, sessionIdentity } from "./task-session-state.js";

const page = (
  ids: readonly string[],
  options: Partial<TaskSessionResponse> = {},
): TaskSessionResponse => ({
  task: {
    id: TaskId.make("task"),
    botId: BotId.make("bot"),
    title: "Work",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local", cursor: { kind: "native", data: { threadId: "thread" } } },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  },
  history: {
    turns: ids.map((id) => ({
      id,
      status: "completed",
      items: [{ id: `${id}-item`, kind: "assistant", status: "completed", text: id }],
    })),
  },
  availability: "available",
  hasEarlier: true,
  nextBefore: ids[0],
  ...options,
});

describe("session snapshot reconciliation", () => {
  it("keeps missing intermediate turns reachable after a long disconnected window", () => {
    const previous = page(["1", "2"], { hasEarlier: false, nextBefore: undefined });
    const next = page(["5", "6"]);
    expect(mergeSessionPage(previous, next, false)).toBe(next);
    expect(mergeSessionPage(previous, next, false).nextBefore).toBe("5");
  });
  it("retains loaded history and replaces live turns without duplicate items", () => {
    const previous = page(["1", "2", "3"], { hasEarlier: false, nextBefore: undefined });
    const next = page(["3", "4"]);
    const result = mergeSessionPage(previous, next, false);
    expect(result.history.turns.map((turn) => turn.id)).toEqual(["1", "2", "3", "4"]);
    expect(result.history.turns[2]).toBe(next.history.turns[0]);
    expect(result.hasEarlier).toBe(false);
    expect(result.nextBefore).toBeUndefined();
  });
  it("prepends older pages without replacing newer overlapping records", () => {
    const previous = page(["3", "4"]);
    const earlier = page(["1", "2", "3"], { hasEarlier: false, nextBefore: undefined });
    const result = mergeSessionPage(previous, earlier, true);
    expect(result.history.turns.map((turn) => turn.id)).toEqual(["1", "2", "3", "4"]);
    expect(result.history.turns[2]).toBe(previous.history.turns[0]);
    expect(result.hasEarlier).toBe(false);
  });
  it("preserves readable history after a temporary error", () => {
    const previous = page(["1", "2"]);
    const result = mergeSessionPage(
      previous,
      page([], { availability: "unavailable", message: "Retry" }),
      false,
    );
    expect(result.history).toBe(previous.history);
    expect(result.availability).toBe("unavailable");
    expect(result.nextBefore).toBe("1");
  });
  it("clears the old transcript when a task moves to another native session", () => {
    const previous = page(["old"]);
    const next = page(["new"], {
      task: { ...previous.task, session: { instanceId: "different" } },
    });
    expect(mergeSessionPage(previous, next, false)).toBe(next);
  });
  it("uses a complete latest snapshot even when the daemon now reports zero turns", () => {
    const previous = page(["first", "second"]);
    const empty = page([], { hasEarlier: false, nextBefore: undefined });
    expect(mergeSessionPage(previous, empty, false)).toBe(empty);
  });
  it("drops a pagination error and any queued result when a live refresh replaces its cursor", () => {
    const failed = applySessionRead(
      { response: page(["3", "4"]) },
      {
        before: "3",
        result: Either.left(new UiError({ message: "Page offline" })),
      },
    );
    expect(failed.earlierError?.before).toBe("3");
    const latest = page(["7", "8"]);
    const updated = applySessionRead(failed, { before: null, result: Either.right(latest) });
    expect(updated).toEqual({ response: latest });
    const late = applySessionRead(updated, { before: "3", result: Either.right(page(["1", "2"])) });
    expect(late).toBe(updated);
  });
  it("retains only the older prefix and clears a temporary error after a successful page retry", () => {
    const previous = page(["first", "second", "removed"]);
    const latest = mergeSessionPage(previous, page(["second", "third"]), false);
    expect(latest.history.turns.map((t) => t.id)).toEqual(["first", "second", "third"]);
    const failed = mergeSessionPage(
      latest,
      page([], { availability: "unavailable", message: "Retry" }),
      true,
    );
    const retried = mergeSessionPage(
      failed,
      page(["oldest"], { hasEarlier: false, nextBefore: undefined }),
      true,
    );
    expect(retried.availability).toBe("available");
    expect(retried.message).toBeUndefined();
    expect(retried.history.turns.map((t) => t.id)).toEqual(["oldest", "first", "second", "third"]);
  });
  it("compares JSON cursor data independently of object key order", () => {
    const base = page([]).task;
    const cursor = (data: { nested: { a: number; b: number } }) => ({
      ...base,
      session: { instanceId: "local", cursor: { kind: "native", data } },
    });
    expect(sessionIdentity(cursor({ nested: { a: 1, b: 2 } }))).toBe(
      sessionIdentity(cursor({ nested: { b: 2, a: 1 } })),
    );
    expect(sessionIdentity(cursor({ nested: { a: 1, b: 3 } }))).not.toBe(
      sessionIdentity(cursor({ nested: { a: 1, b: 2 } })),
    );
  });
});

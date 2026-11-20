import { Schema } from "effect";
import { expect, it } from "vitest";
import { AutEvent, SessionEvent } from "./domain.js";
import {
  SessionHistory,
  SessionItem,
  SessionItemStatus,
  SessionTool,
  SessionTurn,
} from "./session-history.js";

const item = {
  id: "item-1",
  kind: "assistant",
  status: "completed",
  text: "Result",
  phase: "final",
  startedAt: 1000,
  completedAt: 1200,
};
const turn = {
  id: "turn-1",
  status: "completed",
  startedAt: 900,
  completedAt: 1300,
  items: [item],
};

it.each(["running", "completed", "failed", "interrupted", "unknown"])(
  "preserves native-normalized %s statuses",
  (status) => {
    expect(Schema.decodeUnknownSync(SessionItemStatus)(status)).toBe(status);
    expect(Schema.decodeUnknownSync(SessionItem)({ ...item, status }).status).toBe(status);
    expect(Schema.decodeUnknownSync(SessionTurn)({ ...turn, status }).status).toBe(status);
  },
);

it.each(["user", "assistant", "tool", "note"])("round-trips session item kind %s", (kind) => {
  const value = { ...item, kind };
  const decoded = Schema.decodeUnknownSync(SessionItem)(value);
  expect(Schema.encodeSync(SessionItem)(decoded)).toEqual(value);
});

it("preserves tool invocation, full output and signed native exit codes", () => {
  const tool = {
    name: "commandExecution",
    input: "printf fixture",
    output: "fixture\n",
    exitCode: -1,
  };
  expect(Schema.decodeUnknownSync(SessionTool)(tool)).toEqual(tool);
  expect(Schema.decodeUnknownSync(SessionItem)({ ...item, kind: "tool", tool }).tool).toEqual(tool);
  for (const invalid of [
    { ...tool, name: "" },
    { ...tool, input: {} },
    { ...tool, output: null },
    { ...tool, exitCode: 0.5 },
  ])
    expect(Schema.decodeUnknownEither(SessionTool)(invalid)._tag).toBe("Left");
});

it("rejects duplicate item IDs within a turn and duplicate turn IDs across a history", () => {
  expect(Schema.decodeUnknownEither(SessionTurn)({ ...turn, items: [item, item] })._tag).toBe(
    "Left",
  );
  expect(Schema.decodeUnknownEither(SessionHistory)({ turns: [turn, turn] })._tag).toBe("Left");
  expect(
    Schema.decodeUnknownSync(SessionHistory)({ turns: [turn, { ...turn, id: "turn-2" }] }).turns,
  ).toHaveLength(2);
});

it.each([
  { ...item, id: "" },
  { ...item, status: "inProgress" },
  { ...item, kind: "reasoning" },
  { ...item, phase: "final_answer" },
  { ...item, startedAt: -1 },
  { ...item, completedAt: 1.5 },
])("rejects malformed session item boundary %#", (value) => {
  expect(Schema.decodeUnknownEither(SessionItem)(value)._tag).toBe("Left");
});

it("validates session invalidation IDs and their matching outer event kind", () => {
  for (const event of [
    { kind: "session.changed", turnId: "turn-1" },
    { kind: "session.changed", turnId: "turn-1", itemId: "item-1" },
  ]) {
    expect(Schema.decodeUnknownSync(SessionEvent)(event)).toEqual(event);
    const wrapped = { source: "session", taskId: "task-1", kind: event.kind, event };
    expect(Schema.decodeUnknownSync(AutEvent)(wrapped)).toEqual(wrapped);
  }
  for (const event of [
    { kind: "session.changed", turnId: "" },
    { kind: "session.changed", turnId: "turn-1", itemId: "" },
  ])
    expect(Schema.decodeUnknownEither(SessionEvent)(event)._tag).toBe("Left");
  expect(
    Schema.decodeUnknownEither(AutEvent)({
      source: "session",
      taskId: "task-1",
      kind: "turn.started",
      event: { kind: "session.changed", turnId: "turn-1" },
    })._tag,
  ).toBe("Left");
});

import { BotId, type MainThreadMessage, MessageId, TaskId } from "@aut/protocol";
import { describe, expect, it } from "vitest";
import {
  canScrollConversation,
  canScrollConversationUp,
  deriveMessageLayout,
  isAtConversationEnd,
} from "./chat-layout.js";
import {
  FOLLOWING,
  type TranscriptFollow,
  transitionTranscriptFollow,
  wantsJumpToLatest,
} from "./openmausbot/lib/transcript-follow.js";

const at = new Date(2026, 10, 16, 12).getTime();
const taskId = TaskId.make("task-one");
const author = { botId: BotId.make("research"), taskId };
let nextMessageId = 0;
const message = (overrides: Partial<MainThreadMessage> = {}): MainThreadMessage => ({
  id: MessageId.make(`message-${++nextMessageId}`),
  at,
  author,
  kind: "reply",
  text: "A short update.",
  ...overrides,
});

describe("conversation message grouping", () => {
  it("assigns an arriving full report to the visible speaker in its own group", () => {
    const report = message({ fullReportRef: "event:first" });
    const latest = message({ fullReportRef: "event:second" });
    const rows = deriveMessageLayout([message(), report, latest, message({ author: "user" })]);
    expect(rows.map((row) => row.reportId)).toEqual([latest.id, undefined, undefined, undefined]);
    expect(rows[2]?.joinedAbove).toBe(true);
  });
  it("keeps one author label for contiguous replies and separates the user's answer", () => {
    expect(
      deriveMessageLayout([
        message(),
        message({ at: at + 1000 }),
        message({ at: at + 2000, author: "user", kind: "text", taskId }),
      ]),
    ).toEqual([
      { showTime: true, joinedAbove: false, joinedBelow: true, showAuthor: true },
      { showTime: false, joinedAbove: true, joinedBelow: false, showAuthor: false },
      { showTime: false, joinedAbove: false, joinedBelow: false, showAuthor: false },
    ]);
  });

  it.each([
    {
      label: "a different bot in the same task",
      next: { author: { botId: BotId.make("writer"), taskId } },
    },
    {
      label: "the same bot in a different task",
      next: { author: { botId: author.botId, taskId: TaskId.make("task-two") } },
    },
    {
      label: "an explicit different message task",
      next: { taskId: TaskId.make("task-two") },
    },
  ])("does not visually merge $label", ({ next }) => {
    const rows = deriveMessageLayout([message(), message(next)]);
    expect(rows[0]?.joinedBelow).toBe(false);
    expect(rows[1]).toMatchObject({ joinedAbove: false, showAuthor: true });
  });

  it("groups task-bound user follow-ups only within the same task", () => {
    const rows = deriveMessageLayout([
      message({ author: "user", kind: "text", taskId }),
      message({ author: "user", kind: "text", taskId }),
      message({ author: "user", kind: "text", taskId: TaskId.make("task-two") }),
      message({ author: "user", kind: "text" }),
    ]);
    expect(rows.map((row) => row.joinedAbove)).toEqual([false, true, false, false]);
    expect(rows.every((row) => !row.showAuthor)).toBe(true);
  });

  it.each([
    { elapsed: 15 * 60_000 - 1, showTime: false, joinedAbove: true },
    { elapsed: 15 * 60_000, showTime: true, joinedAbove: false },
    { elapsed: 15 * 60_000 + 1, showTime: true, joinedAbove: false },
  ])("applies the timestamp boundary after $elapsed ms", ({ elapsed, ...expected }) => {
    const rows = deriveMessageLayout([message(), message({ at: at + elapsed })]);
    expect(rows[1]).toMatchObject(expected);
    expect(rows[0]?.joinedBelow).toBe(expected.joinedAbove);
  });

  it("breaks a group across local midnight even when only one minute passed", () => {
    const before = new Date(2026, 11, 31, 23, 59, 30).getTime();
    const after = new Date(2027, 0, 1, 0, 0, 30).getTime();
    const rows = deriveMessageLayout([message({ at: before }), message({ at: after })]);
    expect(rows[0]?.joinedBelow).toBe(false);
    expect(rows[1]).toEqual({
      showTime: true,
      joinedAbove: false,
      joinedBelow: false,
      showAuthor: true,
    });
  });

  it.each(["text", "question-card", "clarify-card"] as const)(
    "keeps a %s card separate from its adjacent replies",
    (kind) => {
      const rows = deriveMessageLayout([
        message(),
        message({
          kind,
          card: {
            id: "question-one",
            prompt: "Choose a color.",
            multiSelect: false,
            allowFreeText: true,
            options: [],
            state: "open",
          },
        }),
        message(),
      ]);
      expect(rows.every((row) => !row.joinedAbove && !row.joinedBelow)).toBe(true);
      expect(rows.map((row) => row.showAuthor)).toEqual([true, true, true]);
    },
  );

  it.each(["ack", "notice"] as const)(
    "keeps chief %s rows independent and suppresses their author label",
    (kind) => {
      const rows = deriveMessageLayout([
        message({ author: "chief", kind: "text" }),
        message({ author: "chief", kind }),
        message({ author: "chief", kind }),
        message({ author: "chief", kind: "text" }),
      ]);
      expect(rows.every((row) => !row.joinedAbove && !row.joinedBelow)).toBe(true);
      expect(rows.map((row) => row.showAuthor)).toEqual([true, false, false, true]);
    },
  );

  it("accepts an empty conversation", () => {
    expect(deriveMessageLayout([])).toEqual([]);
  });
});

describe("conversation scroll follow tolerance", () => {
  it.each([
    { scrollTop: 599, expected: true },
    { scrollTop: 596.1, expected: true },
    { scrollTop: 596, expected: false },
    { scrollTop: 595, expected: false },
    { scrollTop: 601, expected: true },
  ])("treats scrollTop $scrollTop as at-end=$expected", ({ scrollTop, expected }) => {
    expect(isAtConversationEnd({ scrollHeight: 1000, clientHeight: 400, scrollTop })).toBe(
      expected,
    );
  });

  it("follows a conversation shorter than the viewport", () => {
    expect(isAtConversationEnd({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });
});

describe("conversation follow navigation", () => {
  it.each([
    { scrollHeight: 200, expected: false },
    { scrollHeight: 400, expected: false },
    { scrollHeight: 400.9, expected: false },
    { scrollHeight: 401, expected: true },
    { scrollHeight: 1000, expected: true },
  ])("requires actual scroll extent at height $scrollHeight", ({ scrollHeight, expected }) => {
    const metrics = { scrollHeight, clientHeight: 400 };
    expect(canScrollConversation(metrics)).toBe(expected);
    expect(canScrollConversationUp(metrics, false)).toBe(expected);
  });

  it("permits upward history navigation when the loaded rows fit in the viewport", () => {
    const metrics = { scrollHeight: 200, clientHeight: 400 };
    expect(canScrollConversation(metrics)).toBe(false);
    expect(canScrollConversationUp(metrics, true)).toBe(true);
  });

  it("does not release a short complete conversation on an ineffective upward gesture", () => {
    const metrics = { scrollHeight: 200, clientHeight: 400 };
    let state = FOLLOWING;
    if (canScrollConversationUp(metrics, false))
      state = transitionTranscriptFollow(state, { type: "navigated" });
    state = transitionTranscriptFollow(state, { type: "leftEnd" });
    expect(state.mode).toBe("following");
    expect(wantsJumpToLatest(state)).toBe(false);
  });

  it("keeps following through temporary growth from an asynchronous card or streamed reply", () => {
    const grown = transitionTranscriptFollow(FOLLOWING, { type: "leftEnd" });
    expect(grown.mode).toBe("following");
    expect(wantsJumpToLatest(grown)).toBe(false);
    expect(transitionTranscriptFollow(grown, { type: "reachedEnd" }).mode).toBe("following");
  });

  it("preserves a tiny upward gesture until the reader leaves the end band and returns", () => {
    let state = transitionTranscriptFollow(FOLLOWING, { type: "navigated" });
    state = transitionTranscriptFollow(state, { type: "reachedEnd" });
    expect(state).toEqual({ mode: "released", atEnd: true });
    expect(wantsJumpToLatest(state)).toBe(false);
    state = transitionTranscriptFollow(state, { type: "leftEnd" });
    expect(wantsJumpToLatest(state)).toBe(true);
    state = transitionTranscriptFollow(state, { type: "reachedEnd" });
    expect(state.mode).toBe("following");
    expect(wantsJumpToLatest(state)).toBe(false);
  });

  it("does not lose the away-from-end state on repeated upward gestures", () => {
    let state = transitionTranscriptFollow(FOLLOWING, { type: "navigated" });
    state = transitionTranscriptFollow(state, { type: "leftEnd" });
    state = transitionTranscriptFollow(state, { type: "navigated" });
    expect(state).toEqual({ mode: "released", atEnd: false });
    expect(wantsJumpToLatest(state)).toBe(true);
    expect(transitionTranscriptFollow(state, { type: "reachedEnd" }).mode).toBe("following");
  });

  it.each<TranscriptFollow>([
    { mode: "following" },
    { mode: "released", atEnd: true },
    { mode: "released", atEnd: false },
  ])("resumes immediately for an explicit send or latest action from $mode", (state) => {
    const next = transitionTranscriptFollow(state, { type: "followEnd" });
    expect(next.mode).toBe("following");
    expect(wantsJumpToLatest(next)).toBe(false);
  });
});

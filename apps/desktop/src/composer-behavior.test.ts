import { describe, expect, it } from "vitest";
import { clearSubmittedDraft } from "./composer-input.js";
import { escapeCancelsReply, replySnippet } from "./openmausbot/lib/replies.js";
import { sendsMessage } from "./openmausbot/lib/send-key.js";

const key = (overrides: Partial<Parameters<typeof sendsMessage>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
  ...overrides,
});

describe("composer keyboard conventions", () => {
  it("consumes Escape only for an active quote outside composition", () => {
    const escapeKey = { key: "Escape", isComposing: false };
    expect(escapeCancelsReply(escapeKey, { replying: false, recording: false })).toBe(false);
    expect(escapeCancelsReply(escapeKey, { replying: true, recording: false })).toBe(true);
    expect(
      escapeCancelsReply({ ...escapeKey, isComposing: true }, { replying: true, recording: false }),
    ).toBe(false);
  });

  it("quotes the readable text of a Markdown reply on one line", () => {
    expect(replySnippet("# **Result**\n> Open [the report](https://example.org) with `aut`")).toBe(
      "Result Open the report with aut",
    );
    expect(replySnippet("x".repeat(161))).toBe(`${"x".repeat(159)}…`);
  });
  it("sends on Enter or a command chord and leaves Shift+Enter for a newline", () => {
    expect(sendsMessage(key(), "enter")).toBe(true);
    expect(sendsMessage(key({ shiftKey: true }), "enter")).toBe(false);
    expect(sendsMessage(key({ metaKey: true }), "enter")).toBe(true);
    expect(sendsMessage(key({ ctrlKey: true }), "enter")).toBe(true);
    expect(sendsMessage(key({ key: "Escape" }), "enter")).toBe(false);
  });

  it("does not send an IME confirmation even with a command chord", () => {
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(sendsMessage(key(composition), "enter")).toBe(false);
      expect(sendsMessage(key({ ...composition, metaKey: true }), "enter")).toBe(false);
    }
  });
});

describe("a send acknowledged while the person keeps typing", () => {
  it("preserves the newer draft", () => {
    const events: Event[] = [];
    const input = { value: "new draft", dispatchEvent: (event: Event) => !!events.push(event) };
    expect(clearSubmittedDraft(input, "sent draft")).toBe(false);
    expect(input.value).toBe("new draft");
    expect(events).toHaveLength(0);
  });

  it("clears the acknowledged snapshot and notifies input sizing", () => {
    const events: Event[] = [];
    const input = { value: "sent draft", dispatchEvent: (event: Event) => !!events.push(event) };
    expect(clearSubmittedDraft(input, "sent draft")).toBe(true);
    expect(input.value).toBe("");
    expect(events.map((event) => event.type)).toEqual(["input"]);
  });
});

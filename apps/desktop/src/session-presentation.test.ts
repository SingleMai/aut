import { readFileSync } from "node:fs";
import {
  BotId,
  SessionHistory,
  type SessionItem,
  type SessionTurn,
  TaskId,
  type TaskSessionResponse,
} from "@aut/protocol";
import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { groupTranscript } from "./openmausbot/lib/activity-runs.js";
import { setLocale } from "./openmausbot/lib/i18n.js";
import { toolStepLabel } from "./openmausbot/lib/tool-step-label.js";
import { projectSession } from "./session-presentation.js";

const response = (turns: readonly SessionTurn[]): TaskSessionResponse => ({
  task: {
    id: TaskId.make("task"),
    botId: BotId.make("worker"),
    title: "Work",
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  },
  history: { turns },
  availability: "available",
  hasEarlier: false,
});

const toolItem = (overrides: Partial<SessionItem> = {}): SessionItem => ({
  id: "call",
  kind: "tool",
  status: "completed",
  text: "printf fixture",
  startedAt: 1_000,
  completedAt: 2_000,
  tool: { name: "commandExecution", input: "printf fixture", output: "fixture\n", exitCode: 0 },
  ...overrides,
});

const fixture = (name: string) =>
  Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ history: SessionHistory })))(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ).history;

beforeEach(() => setLocale("en"));

describe("session UI projection", () => {
  it("feeds the real Codex 0.169.0 command/file/final transcript into upstream grouping", () => {
    const source = response(fixture("session-view-0.169.0").turns);
    const projected = projectSession(source);
    expect(projected.messages.map((message) => message.kind)).toEqual([
      "text",
      "text",
      "activity",
      "activity",
      "text",
    ]);
    const [user, commentary, edit, command, final] = projected.messages;
    expect(user).toMatchObject({ role: "user", text: source.history.turns[0]?.items[0]?.text });
    expect(commentary).toMatchObject({ role: "bot", from: { botId: "worker" } });
    expect(edit?.tool).toMatchObject({ name: "edit", ok: true });
    expect(command?.tool?.name).toBe(source.history.turns[0]?.items[3]?.tool?.input);
    expect(command?.tool?.output).toBe(source.history.turns[0]?.items[3]?.tool?.output);
    expect(command?.tool && toolStepLabel(command.tool)).toBe("Run a command");
    expect(final).toMatchObject({ text: "AUT_SESSION_UI_OK", turnTerminal: true });
    expect(final?.at).toBe(source.history.turns[0]?.items[4]?.completedAt);
    expect(projected.liveMessageIds.size).toBe(0);
    const grouped = groupTranscript(projected.messages);
    expect(grouped.map((item) => item.kind)).toEqual(["message", "message", "turn", "message"]);
    expect(grouped[2]).toMatchObject({ kind: "turn", messages: [edit, command] });
  });

  it("uses the actual tool name from the recorded local MCP call without changing its payload", () => {
    const snapshot = fixture("session-mcp-0.169.0");
    const original = snapshot.turns[0]?.items[0];
    const message = projectSession(response(snapshot.turns)).messages[0];
    expect(message?.tool).toMatchObject({
      name: "fixture_echo",
      ok: true,
      input: original?.tool?.input,
      output: original?.tool?.output,
    });
    expect(message?.tool?.output).toContain('"structuredContent"');
  });

  it.each([
    ["completed", true, false],
    ["failed", false, false],
    ["running", undefined, true],
    ["unknown", undefined, false],
    ["interrupted", undefined, false],
  ] as const)("keeps %s distinct from an inferred success", (status, ok, live) => {
    const projected = projectSession(
      response([{ id: "turn", status: "running", items: [toolItem({ status })] }]),
    );
    expect(projected.messages[0]?.tool?.ok).toBe(ok);
    expect(projected.liveMessageIds.has("turn:call")).toBe(live);
    if (ok === undefined) expect(projected.messages[0]?.tool).not.toHaveProperty("ok");
  });

  it("does not keep a stale running item live after its native turn has stopped", () => {
    const projected = projectSession(
      response([{ id: "turn", status: "interrupted", items: [toolItem({ status: "running" })] }]),
    );
    expect(projected.liveMessageIds.size).toBe(0);
    expect(projected.messages[0]?.tool).not.toHaveProperty("ok");
  });

  it("waits for the native final completion before folding tools and uses the native turn end", () => {
    const final: SessionItem = {
      id: "final",
      kind: "assistant",
      status: "running",
      phase: "final",
      text: "Streaming answer",
    };
    const running = projectSession(
      response([
        {
          id: "turn",
          status: "running",
          startedAt: 1_000,
          items: [toolItem(), final],
        },
      ]),
    );
    expect(running.messages.at(-1)).not.toHaveProperty("turnTerminal");
    expect(groupTranscript(running.messages).every((item) => item.kind !== "turn")).toBe(true);
    const finished = projectSession(
      response([
        {
          id: "turn",
          status: "completed",
          startedAt: 1_000,
          completedAt: 5_000,
          items: [toolItem(), { ...final, status: "completed" }],
        },
      ]),
    );
    expect(finished.messages.at(-1)).toMatchObject({ turnTerminal: true, at: 5_000 });
    expect(groupTranscript(finished.messages)[0]).toMatchObject({
      kind: "turn",
      label: "Worked for 4s",
    });
  });

  it("keeps IDs stable across refreshes and disambiguates reused item IDs in separate turns", () => {
    const initial = response([
      { id: "first", status: "completed", items: [toolItem()] },
      { id: "second", status: "running", items: [toolItem({ status: "running" })] },
    ]);
    const projected = projectSession(initial);
    const updated = projectSession(
      response([
        initial.history.turns[0] as SessionTurn,
        { id: "second", status: "completed", items: [toolItem()] },
      ]),
    );
    expect(projected.messages.map((message) => message.id)).toEqual(["first:call", "second:call"]);
    expect(updated.messages.map((message) => message.id)).toEqual(
      projected.messages.map((message) => message.id),
    );
    expect([...projected.itemIds]).toEqual([
      ["first:call", "call"],
      ["second:call", "call"],
    ]);
    expect(updated.liveMessageIds.size).toBe(0);
  });

  it("maps schema-derived web tools and preserves unknown tools and empty output", () => {
    const items = [
      toolItem({
        id: "web",
        tool: { name: "webSearch", input: '{"query":"fixture"}', output: "" },
      }),
      toolItem({ id: "unknown", tool: { name: "futureTool", input: "input", output: "" } }),
      toolItem({
        id: "dynamic",
        tool: { name: "namespace.browser_click", input: "{}", output: "" },
      }),
    ];
    const projected = projectSession(response([{ id: "turn", status: "completed", items }]));
    expect(projected.messages.map((message) => message.tool?.name)).toEqual([
      "web_search",
      "futureTool",
      "browser_click",
    ]);
    expect(projected.messages[0]?.tool && toolStepLabel(projected.messages[0].tool)).toBe(
      "Search the web",
    );
    expect(projected.messages.every((message) => message.tool?.output === "")).toBe(true);
    expect(projected.messages.every((message) => message.tool?.clipped === undefined)).toBe(true);
  });

  it("extracts only explicit structured failure reasons without guessing from ordinary output", () => {
    const outputs = [
      '{"error":{"message":"Permission denied"}}',
      '{"error":"Missing fixture"}',
      '{"code":-32603,"message":"Native failure"}',
      '{"message":"Ordinary result with no error provenance"}',
      "Error: arbitrary tool output",
      '{"error":',
      '{"error":"   "}',
    ];
    const items = outputs.map((output, index) =>
      toolItem({
        id: String(index),
        status: "failed",
        tool: { name: "fixture.tool", input: "{}", output },
      }),
    );
    items.push(
      toolItem({
        id: "success",
        tool: { name: "fixture.tool", input: "{}", output: outputs[0] ?? "" },
      }),
    );
    const projected = projectSession(response([{ id: "turn", status: "failed", items }]));
    expect(projected.messages.map((message) => message.tool?.problem)).toEqual([
      "Permission denied",
      "Missing fixture",
      "Native failure",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      projected.messages.slice(0, outputs.length).map((message) => message.tool?.output),
    ).toEqual(outputs);
  });

  it("preserves native order and text while keeping unknown timestamps deterministic", () => {
    const projected = projectSession(
      response([
        {
          id: "turn",
          status: "completed",
          startedAt: 9_000,
          items: [
            {
              id: "user",
              kind: "user",
              status: "completed",
              text: "  original\ninput  ",
              startedAt: 5_000,
            },
            { id: "note-empty", kind: "note", status: "completed", text: "" },
            { id: "note", kind: "note", status: "completed", text: "Public summary" },
            {
              id: "answer",
              kind: "assistant",
              status: "completed",
              text: "original answer",
              startedAt: 4_000,
              completedAt: 10_000,
              phase: "final",
            },
          ],
        },
      ]),
    );
    expect(projected.messages.map((message) => message.id)).toEqual([
      "turn:user",
      "turn:note",
      "turn:answer",
    ]);
    expect(projected.messages.map((message) => message.at)).toEqual([5_000, 9_000, 10_000]);
    expect(projected.messages[0]?.text).toBe("  original\ninput  ");
    expect(projected.messages[1]).toMatchObject({ role: "system", text: "Public summary" });
    const untimed = projectSession(
      response([
        {
          id: "untimed",
          status: "unknown",
          items: [{ id: "item", kind: "assistant", status: "unknown", text: "unchanged" }],
        },
      ]),
    );
    expect(untimed.messages[0]?.at).toBe(0);
    expect(untimed.messages[0]).not.toHaveProperty("turnTerminal");
  });
});

import { readFileSync } from "node:fs";
import {
  BotId,
  type JsonValue,
  type SessionEvent,
  SessionHistory,
  type StartSessionInput,
  TaskId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Queue, Schema, Stream, Take } from "effect";
import { expect, test } from "vitest";
import { normalizeItem, SessionHistoryCache } from "./history.js";
import { makeCodexAdapter } from "./session.js";
import type { TransportFactory, TransportNotice } from "./transport.js";
import { Item, ItemNotification, RpcMessage, ThreadTranscript } from "./wire.js";

const frames = (name: string) =>
  readFileSync(new URL(`../../../../spikes/codex/fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      Schema.decodeUnknownSync(
        Schema.parseJson(Schema.Struct({ direction: Schema.String, payload: Schema.Unknown })),
      )(line),
    );
const wire = (name: string) =>
  frames(name)
    .filter((frame) => ["send", "receive"].includes(frame.direction))
    .map((frame) => ({ ...frame, payload: Schema.decodeUnknownSync(RpcMessage)(frame.payload) }));
const fixture = wire("session-view-0.169.0");
const responses = fixture
  .filter((row) => row.direction === "send" && row.payload.method === "thread/read")
  .map(
    (call) =>
      fixture.find((row) => row.direction === "receive" && row.payload.id === call.payload.id)
        ?.payload.result,
  );
const historical = responses.map(
  (value) => Schema.decodeUnknownSync(ThreadTranscript)(value).thread,
);
const itemEvents = fixture
  .filter(
    (row) =>
      row.direction === "receive" &&
      ["item/started", "item/completed"].includes(row.payload.method ?? ""),
  )
  .map((row) => ({
    method: row.payload.method,
    params: Schema.decodeUnknownSync(ItemNotification)(row.payload.params),
  }));

test("normalizes real command, file, user and assistant snapshots with millisecond timestamps", () => {
  const cache = new SessionHistoryCache();
  for (const turn of historical[1]?.turns ?? []) cache.turn(turn);
  const snapshot = Schema.decodeUnknownSync(SessionHistory)(cache.snapshot());
  expect(snapshot.turns).toHaveLength(1);
  const turn = snapshot.turns[0];
  expect(turn?.status).toBe("completed");
  expect(turn?.items.map((item) => item.kind)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "assistant",
  ]);
  expect(turn?.items.at(-1)).toMatchObject({ text: "AUT_SESSION_UI_OK", phase: "final" });
  expect(turn?.items.find((item) => item.tool?.name === "commandExecution")).toMatchObject({
    status: "completed",
    tool: { exitCode: 0, output: expect.stringContaining("aut-session-ui-probe") },
  });
  expect(turn?.items.find((item) => item.tool?.name === "fileChange")?.tool?.output).toContain(
    "fixture file content",
  );
  expect(turn?.startedAt).toBe((historical[1]?.turns[0]?.startedAt ?? 0) * 1000);
  expect(turn?.items[0]?.startedAt).toBeGreaterThan(1e12);
});

test("stream tool survives incomplete snapshots and completion replaces rather than appends deltas", () => {
  const cache = new SessionHistoryCache();
  const started = itemEvents.find(
    (entry) => entry.method === "item/started" && entry.params.item.type === "commandExecution",
  );
  const completed = itemEvents.find(
    (entry) => entry.method === "item/completed" && entry.params.item.type === "commandExecution",
  );
  expect(started && completed).toBeTruthy();
  if (!started || !completed) return;
  cache.item(started.params.turnId, started.params.item, false);
  cache.delta(started.params.turnId, started.params.item.id, "partial streaming output", true);
  for (const turn of historical[0]?.turns ?? []) cache.turn(turn);
  expect(
    cache.snapshot().turns[0]?.items.find((item) => item.id === started.params.item.id)?.tool
      ?.output,
  ).toBe("partial streaming output");
  cache.item(completed.params.turnId, completed.params.item, true);
  cache.delta(completed.params.turnId, completed.params.item.id, "late duplicate delta", true);
  cache.item(started.params.turnId, started.params.item, false);
  for (const turn of historical[1]?.turns ?? []) cache.turn(turn);
  expect(
    cache.snapshot().turns[0]?.items.find((item) => item.id === started.params.item.id)?.tool
      ?.output,
  ).toBe(completed.params.item.aggregatedOutput);
  expect(
    cache.snapshot().turns[0]?.items.filter((item) => item.id === started.params.item.id),
  ).toHaveLength(1);
});

test("MCP arguments and results are projected from the real synthetic local tool fixture", () => {
  const native = wire("session-mcp-0.169.0").find(
    (row) =>
      row.direction === "receive" &&
      row.payload.method === "item/completed" &&
      JSON.stringify(row.payload.params).includes('"type":"mcpToolCall"'),
  );
  const item = Schema.decodeUnknownSync(ItemNotification)(native?.payload.params).item;
  expect(normalizeItem(item)).toMatchObject({
    id: item.id,
    kind: "tool",
    status: "completed",
    tool: {
      name: "aut_session_view.fixture_echo",
      input: expect.stringContaining("aut-session-ui-mcp-probe"),
      output: expect.stringContaining("MCP_FIXTURE:aut-session-ui-mcp-probe"),
    },
  });
  expect(normalizeItem(item).tool?.output).toContain('"structuredContent"');
  expect(normalizeItem(item).tool?.output).toContain('"echo": "aut-session-ui-mcp-probe"');
});

test("interrupted history retains native failed command details without a successful report", () => {
  const data = wire("resume-persisted");
  const call = data.find((row) => row.direction === "send" && row.payload.method === "thread/read");
  const raw = data.find((row) => row.direction === "receive" && row.payload.id === call?.payload.id)
    ?.payload.result;
  const history = Schema.decodeUnknownSync(ThreadTranscript)(raw);
  const cache = new SessionHistoryCache();
  for (const turn of history.thread.turns) cache.turn(turn);
  const interrupted = cache.snapshot().turns.find((turn) => turn.status === "interrupted");
  expect(interrupted?.items.find((item) => item.kind === "tool")).toMatchObject({
    status: "failed",
    tool: { exitCode: -1 },
  });
  expect(interrupted?.items.some((item) => item.phase === "final")).toBe(false);
});

test("terminal turn settles unfinished stream items and unknown types remain conservative notes", () => {
  const cache = new SessionHistoryCache();
  cache.item(
    "turn",
    { id: "tool", type: "commandExecution", status: "inProgress", command: "sleep 30" },
    false,
  );
  cache.turn({ id: "turn", status: "interrupted", items: [] });
  cache.turn({ id: "turn", status: "inProgress", items: [] });
  expect(cache.snapshot().turns[0]).toMatchObject({
    status: "interrupted",
    items: [{ status: "interrupted" }],
  });
  expect(normalizeItem({ id: "new", type: "futureItem" })).toMatchObject({
    kind: "note",
    status: "unknown",
    text: "futureItem",
  });
  expect(
    normalizeItem({
      id: "reasoning",
      type: "reasoning",
      summary: ["Public summary"],
      content: [{ type: "text", text: "Not a public summary" }],
    }).text,
  ).toBe("Public summary");
});

test("native order wins over partial or missing timestamps and live-only IDs append in stream order", () => {
  const cache = new SessionHistoryCache();
  cache.item(
    "current",
    { type: "commandExecution", id: "live-1", startedAtMs: 10, command: "first" },
    false,
  );
  cache.item(
    "current",
    { type: "commandExecution", id: "live-2", startedAtMs: 5, command: "second" },
    false,
  );
  cache.hydrate([
    {
      id: "earlier",
      status: "completed",
      items: [
        { id: "old-user", type: "userMessage", content: [{ type: "text", text: "Earlier" }] },
      ],
    },
    {
      id: "current",
      status: "inProgress",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Question" }] },
        { id: "assistant", type: "agentMessage", text: "Working", startedAtMs: 100 },
      ],
    },
  ]);
  expect(cache.snapshot().turns.map((turn) => turn.id)).toEqual(["earlier", "current"]);
  expect(cache.snapshot().turns[1]?.items.map((item) => item.id)).toEqual([
    "user",
    "assistant",
    "live-1",
    "live-2",
  ]);
  cache.turn({
    id: "current",
    status: "completed",
    items: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Done" }],
  });
  expect(cache.snapshot().turns[1]?.items.map((item) => item.id)).toEqual([
    "user",
    "assistant",
    "live-1",
    "live-2",
    "final",
  ]);
});

test("unknown native statuses never invent a completed item or erase known stream progress", () => {
  const cache = new SessionHistoryCache();
  cache.hydrate([
    {
      id: "unknown",
      status: "futureStatus",
      items: [{ id: "item", type: "webSearch", query: "fixture" }],
    },
  ]);
  expect(cache.snapshot().turns[0]).toMatchObject({
    status: "unknown",
    items: [{ status: "unknown" }],
  });
  cache.item("running", { id: "assistant", type: "agentMessage", text: "Streaming" }, false);
  cache.hydrate([
    {
      id: "running",
      status: "inProgress",
      items: [{ id: "assistant", type: "agentMessage", text: "" }],
    },
  ]);
  expect(cache.snapshot().turns[0]).toMatchObject({
    status: "running",
    items: [{ status: "running", text: "Streaming" }],
  });
});

test("generated 0.169.0 schema tool variants preserve their structured input and output", () => {
  // Deliberate schema-derived examples; no external search, dynamic tool or collaboration was invoked.
  const examples = [
    {
      type: "webSearch",
      id: "search",
      query: "synthetic query",
      action: { type: "search", queries: ["synthetic query"] },
      results: [{ title: "Fixture", url: "https://example.test" }],
    },
    {
      type: "dynamicToolCall",
      id: "dynamic",
      namespace: "fixture",
      tool: "echo",
      status: "completed",
      arguments: { text: "input" },
      contentItems: [{ type: "inputText", text: "result" }],
      success: true,
    },
    {
      type: "collabAgentToolCall",
      id: "collab",
      tool: "spawnAgent",
      status: "completed",
      prompt: "Synthetic delegation",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "completed" } },
    },
    { type: "imageView", id: "view", path: "/tmp/synthetic.png" },
    {
      type: "imageGeneration",
      id: "image",
      status: "completed",
      revisedPrompt: "Synthetic prompt",
      savedPath: "/tmp/generated.png",
      fileId: "fixture-file",
    },
  ];
  const normalized = examples.map((value) =>
    normalizeItem(Schema.decodeUnknownSync(Item)(value), "completed"),
  );
  expect(normalized.every((item) => item.kind === "tool")).toBe(true);
  expect(normalized[0]?.tool?.input).toContain("synthetic query");
  expect(normalized[0]?.tool?.output).toContain("https://example.test");
  expect(normalized[1]?.tool).toMatchObject({
    name: "fixture.echo",
    input: expect.stringContaining("input"),
    output: expect.stringContaining("result"),
  });
  expect(normalized[2]?.tool?.output).toContain("child");
  expect(normalized[3]?.tool?.input).toBe("/tmp/synthetic.png");
  expect(normalized[4]?.tool?.output).toBe("/tmp/generated.png");
  const reasoning = Schema.decodeUnknownSync(Item)({
    type: "reasoning",
    id: "reasoning",
    summary: ["Public summary"],
    content: ["Private reasoning field"],
  });
  expect(normalizeItem(reasoning).text).toBe("Public summary");
});

const fake = () =>
  Effect.gen(function* () {
    const notices = yield* Queue.unbounded<TransportNotice>();
    const calls: string[] = [];
    let opened = 0;
    let closed = 0;
    let readResponse: JsonValue = responses[0] ?? null;
    const factory: TransportFactory = {
      open: () =>
        Effect.gen(function* () {
          opened++;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed++;
            }),
          );
          return {
            notices,
            stop: Effect.void,
            send: (message) =>
              Effect.sync(() => {
                calls.push(message.method ?? "response");
              }),
            request: (method) =>
              Effect.sync(() => {
                calls.push(method);
                if (method === "thread/start")
                  return { thread: { id: historical[0]?.id ?? "missing" } };
                if (method === "turn/start")
                  return { turn: { id: historical[0]?.turns[0]?.id ?? "missing" } };
                if (method === "thread/read") return readResponse;
                return {};
              }),
          };
        }),
    };
    return {
      factory,
      calls,
      notices,
      setRead: (value: JsonValue) => {
        readResponse = value;
      },
      opened: () => opened,
      closed: () => closed,
    };
  });

it.scoped(
  "cold adapter read only initializes and reads, then closes its own scope immediately",
  () =>
    Effect.gen(function* () {
      const f = yield* fake();
      f.setRead(responses[1] ?? null);
      const adapter = makeCodexAdapter({}, f.factory);
      if (!adapter.readSession) return yield* Effect.die("Missing session history capability");
      expect(adapter.capabilities.sessionHistory).toBe(true);
      const result = yield* adapter.readSession({
        kind: "codex",
        data: { threadId: historical[0]?.id ?? "missing" },
      });
      expect(result.turns[0]?.items).toHaveLength(5);
      expect(f.calls).toEqual(["initialize", "initialized", "thread/read"]);
      expect(f.opened()).toBe(1);
      expect(f.closed()).toBe(1);
    }),
);

it.scoped("cold read rejects wrong cursor and wrong returned thread identity", () =>
  Effect.gen(function* () {
    const f = yield* fake();
    const adapter = makeCodexAdapter({}, f.factory);
    if (!adapter.readSession) return yield* Effect.die("Missing session history capability");
    expect((yield* Effect.either(adapter.readSession({ kind: "other", data: {} })))._tag).toBe(
      "Left",
    );
    expect(f.opened()).toBe(0);
    expect(
      (yield* Effect.either(
        adapter.readSession({ kind: "codex", data: { threadId: "different" } }),
      ))._tag,
    ).toBe("Left");
    expect(f.closed()).toBe(1);
  }),
);

it.scoped(
  "live adapter invalidates tool changes and merges streaming output with incomplete native read",
  () =>
    Effect.gen(function* () {
      const f = yield* fake();
      const input: StartSessionInput = {
        taskId: TaskId.make("history-test"),
        model: "fixture",
        cwd: "/tmp",
        instructions: "Fixture",
        mcpServers: [],
        bot: {
          id: BotId.make("fixture"),
          name: "Fixture",
          description: "Fixture",
          soul: "",
          modelSelection: { instanceId: "fixture", model: "fixture" },
          cwd: "/tmp",
        },
      };
      const session = yield* makeCodexAdapter({}, f.factory).startSession(input);
      if (!session.readSession) return yield* Effect.die("Missing live session history");
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Synthetic fixture", messageIds: [] });
      const started = fixture.find(
        (row) =>
          row.direction === "receive" &&
          row.payload.method === "item/started" &&
          JSON.stringify(row.payload.params).includes('"type":"commandExecution"'),
      )?.payload;
      if (!started) return yield* Effect.die("Missing fixture command");
      const item = Schema.decodeUnknownSync(ItemNotification)(started.params);
      const until = (matches: (event: SessionEvent) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const chunk = yield* Take.done(yield* Queue.take(events));
            if ([...chunk].some(matches)) return;
          }
        });
      yield* Queue.offer(f.notices, { kind: "message", message: started });
      yield* until((event) => event.kind === "session.changed" && event.itemId === item.item.id);
      const first = yield* session.readSession();
      expect(first.turns[0]?.items.find((value) => value.id === item.item.id)?.status).toBe(
        "running",
      );
      const delta = fixture.find(
        (row) => row.payload.method === "item/commandExecution/outputDelta",
      )?.payload;
      if (!delta) return yield* Effect.die("Missing output delta");
      yield* Queue.offer(f.notices, { kind: "message", message: delta });
      yield* until((event) => event.kind === "session.changed" && event.itemId === item.item.id);
      expect(
        (yield* session.readSession()).turns[0]?.items.find((value) => value.id === item.item.id)
          ?.tool?.output,
      ).toContain("aut-session-ui-done");
      const completed = fixture.find(
        (row) =>
          row.direction === "receive" &&
          row.payload.method === "item/completed" &&
          JSON.stringify(row.payload.params).includes('"type":"commandExecution"'),
      )?.payload;
      if (!completed) return yield* Effect.die("Missing completed command");
      yield* Queue.offer(f.notices, { kind: "message", message: completed });
      yield* until((event) => event.kind === "session.changed" && event.itemId === item.item.id);
      f.setRead(responses[1] ?? null);
      const final = yield* session.readSession();
      expect(
        final.turns[0]?.items.find((value) => value.id === item.item.id)?.tool?.output,
      ).toContain("aut-session-ui-probe");
      expect(final.turns[0]?.items).toHaveLength(5);
      expect(f.closed()).toBe(0);
    }),
);

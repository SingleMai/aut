import { readFileSync } from "node:fs";
import { BotId, type JsonValue, type SessionEvent, SessionHistory, TaskId } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Queue, Schema, Stream, Take } from "effect";
import { expect, test } from "vitest";
import { SessionHistoryCache } from "./history.js";
import { makeCodexAdapter } from "./session.js";
import type { TransportFactory, TransportNotice } from "./transport.js";
import { ItemNotification, RpcMessage, ThreadTranscript, TokenUsageNotification } from "./wire.js";

const rows = (file: string) =>
  readFileSync(new URL(`../../../../spikes/codex/fixtures/${file}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      Schema.decodeUnknownSync(
        Schema.parseJson(Schema.Struct({ direction: Schema.String, payload: Schema.Unknown })),
      )(line),
    );
const recorded = rows("session-context-0.171.0");
const frames = recorded
  .filter((row) => row.direction === "receive")
  .map((row) => Schema.decodeUnknownSync(RpcMessage)(row.payload));
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing recorded context fixture");
  return value;
};
const thread = required(
  frames
    .flatMap((frame) => {
      const result = Schema.decodeUnknownEither(ThreadTranscript)(frame.result);
      return result._tag === "Right" ? [result.right.thread] : [];
    })
    .at(-1),
);
const usage = frames
  .filter((frame) => frame.method === "thread/tokenUsage/updated")
  .map((frame) => Schema.decodeUnknownSync(TokenUsageNotification)(frame.params));
const compactionFrames = frames.filter((frame) => {
  if (!frame.method?.startsWith("item/")) return false;
  const decoded = Schema.decodeUnknownEither(ItemNotification)(frame.params);
  return decoded._tag === "Right" && decoded.right.item.type === "contextCompaction";
});
const started = Schema.decodeUnknownSync(ItemNotification)(compactionFrames[0]?.params);
const completed = Schema.decodeUnknownSync(ItemNotification)(compactionFrames[1]?.params);

test("0.171.0 fixture records automatic compaction, native usage and cold history without a compact request", () => {
  expect(recorded[0]?.payload).toMatchObject({
    version: "codex-cli 0.171.0",
    scenario: "session-context",
  });
  const sent = recorded
    .filter((row) => row.direction === "send")
    .map((row) => Schema.decodeUnknownSync(RpcMessage)(row.payload));
  expect(sent.some((frame) => frame.method?.includes("compact"))).toBe(false);
  expect(compactionFrames.map((frame) => frame.method)).toEqual(["item/started", "item/completed"]);
  expect(usage).toHaveLength(3);
  expect(usage[1]?.tokenUsage.last.inputTokens).toBe(0);
  const cold = rows("session-context-read-0.171.0");
  expect(
    cold
      .filter((row) => row.direction === "send")
      .map((row) => Schema.decodeUnknownSync(RpcMessage)(row.payload).method),
  ).toEqual(["initialize", "initialized", "thread/read"]);
  const cache = new SessionHistoryCache();
  cache.hydrate(thread.turns);
  const context = Schema.decodeUnknownSync(SessionHistory)(cache.snapshot()).context;
  expect(context?.compaction).toMatchObject({ itemId: completed.item.id, status: "completed" });
  expect(context?.usage).toBeUndefined();
});

test("compaction invalidates old readings until a fresh input count, and historical hydration cannot restore them", () => {
  const cache = new SessionHistoryCache();
  cache.recordUsage({ tokens: required(usage[0]).tokenUsage.last.inputTokens });
  expect(cache.snapshot().context?.usage?.tokens).toBe(18164);
  cache.item(started.turnId, started.item, false);
  expect(cache.snapshot().context).toMatchObject({ compaction: { status: "running" } });
  expect(cache.snapshot().context?.usage).toBeUndefined();
  cache.recordUsage({ tokens: 0 });
  cache.item(completed.turnId, completed.item, true);
  expect(cache.snapshot().context?.usage).toBeUndefined();
  cache.recordUsage({ tokens: required(usage.at(-1)).tokenUsage.last.inputTokens, window: 996147 });
  cache.hydrate(thread.turns);
  expect(cache.snapshot().context?.usage).toEqual({ tokens: 21464, window: 996147 });
  cache.item(started.turnId, started.item, false);
  expect(cache.snapshot().context?.compaction?.status).toBe("completed");
  // Item identity is scoped to its turn, even when native IDs are normally UUIDs.
  cache.item("another-turn", completed.item, true);
  expect(cache.snapshot().context?.usage).toBeUndefined();
});

test.each(["interrupted", "failed"])(
  "unfinished compaction settles as %s without a success reading",
  (status) => {
    const cache = new SessionHistoryCache();
    cache.recordUsage({ tokens: 1234 });
    cache.item(started.turnId, started.item, false);
    cache.turn({ id: started.turnId, status });
    expect(cache.snapshot().context?.compaction?.status).toBe(status);
    expect(cache.snapshot().context?.usage).toBeUndefined();
  },
);

it.scoped(
  "production adapter replays native compaction and usage through session.changed without altering turn results",
  () =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<TransportNotice>();
      let turnIndex = 0;
      const calls: string[] = [];
      const factory: TransportFactory = {
        open: () =>
          Effect.succeed({
            notices,
            stop: Effect.void,
            send: () => Effect.void,
            request: (method) =>
              Effect.sync((): JsonValue => {
                calls.push(method);
                if (method === "thread/start") return { thread: { id: thread.id } };
                if (method === "turn/start")
                  return { turn: { id: required(thread.turns[turnIndex++]).id } };
                if (method === "thread/read") return { thread: { id: thread.id, turns: [] } };
                return {};
              }),
          }),
      };
      const session = yield* makeCodexAdapter({}, factory).startSession({
        taskId: TaskId.make("context"),
        model: "fixture",
        cwd: "/tmp",
        instructions: "Fixture",
        mcpServers: [],
        bot: {
          id: BotId.make("fixture"),
          name: "Fixture",
          description: "Fixture",
          soul: "",
          cwd: "/tmp",
          modelSelection: { instanceId: "fixture", model: "fixture" },
        },
      });
      const stream = yield* Stream.toQueue(session.events);
      const readSession = required(session.readSession);
      yield* Effect.yieldNow();
      const until = (kind: SessionEvent["kind"]) =>
        Effect.gen(function* () {
          while (true) {
            const batch = yield* Take.done(yield* Queue.take(stream));
            const event = [...batch].find((event) => event.kind === kind);
            if (event) return event;
          }
        });
      let completedTurns = 0;
      for (const turn of thread.turns) {
        yield* session.startTurn({ text: "Replay synthetic context fixture", messageIds: [] });
        // A malformed optional observation must not fail the worker.
        yield* Queue.offer(notices, {
          kind: "message",
          message: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: thread.id,
              turnId: turn.id,
              tokenUsage: { last: { inputTokens: -1 } },
            },
          },
        });
        for (const frame of frames) {
          const params = frame.params as { turnId?: string; turn?: { id?: string } } | undefined;
          if ((params?.turnId ?? params?.turn?.id) !== turn.id) continue;
          const kind =
            frame.method === "turn/started"
              ? "turn.started"
              : frame.method === "turn/completed"
                ? "turn.completed"
                : ["item/started", "item/completed", "thread/tokenUsage/updated"].includes(
                      frame.method ?? "",
                    )
                  ? "session.changed"
                  : undefined;
          if (!kind) continue;
          yield* Queue.offer(notices, { kind: "message", message: frame });
          const event = yield* until(kind);
          if (event.kind === "turn.completed") {
            expect(event.ok).toBe(true);
            completedTurns++;
          }
          const snapshot = yield* readSession();
          if (frame === compactionFrames[0]) {
            expect(snapshot.context?.compaction?.status).toBe("running");
            expect(snapshot.context?.usage).toBeUndefined();
          }
          if (frame === compactionFrames[1]) {
            expect(snapshot.context?.compaction?.status).toBe("completed");
            expect(snapshot.context?.usage).toBeUndefined();
          }
        }
      }
      expect(completedTurns).toBe(2);
      expect((yield* readSession()).context?.usage).toEqual({
        tokens: 21464,
        window: 996147,
      });
      expect(calls.some((method) => method.includes("compact"))).toBe(false);
    }),
);

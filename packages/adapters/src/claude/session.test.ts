import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BotId, type StartSessionInput, TaskId } from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Queue, Stream, Take } from "effect";
import { describe, expect } from "vitest";
import { makeClaudeAdapter } from "./session.js";

const fakeCli = fileURLToPath(
  new URL("../../../../spikes/claude/fake-claude-cli.ts", import.meta.url),
);
const input: StartSessionInput = {
  taskId: TaskId.make("claude-adapter-test"),
  bot: {
    id: BotId.make("claude-test-bot"),
    name: "Claude test",
    description: "Protocol fixture",
    soul: "",
    modelSelection: { instanceId: "claude-fixture", model: "claude-test" },
    cwd: "/tmp",
    mcpServers: [],
  },
  model: "claude-test",
  cwd: "/tmp",
  instructions: "You are a test worker.",
  mcpServers: [],
};

const fixtureAdapter = (mode = "stream") =>
  makeClaudeAdapter({
    command: fakeCli,
    args: [],
    env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_REPLY_FILE: "/tmp/aut-claude-fixture-reply.txt" },
  });

describe("Claude adapter", () => {
  writeFileSync("/tmp/aut-claude-fixture-reply.txt", "fixture reply\n");

  it.scopedLive("maps stream-json turns to aut events and transcript entries", () =>
    Effect.gen(function* () {
      const session = yield* fixtureAdapter().startSession(input);
      const events = yield* Stream.toQueue(session.events);
      yield* Effect.yieldNow();
      yield* session.startTurn({ text: "Say hello", messageIds: [] });
      const received: string[] = [];
      let completed = false;
      while (!completed) {
        const chunk = yield* Take.done(yield* Queue.take(events));
        for (const event of chunk) {
          received.push(event.kind);
          completed = completed || event.kind === "turn.completed";
        }
      }
      expect(received).toContain("turn.started");
      expect(received).toContain("cursor.updated");
      expect(received).toContain("message.delta");
      expect(received).toContain("turn.completed");
      expect((yield* session.transcript()).some((entry) => entry.role === "user")).toBe(true);
      expect((yield* session.transcript()).some((entry) => entry.role === "assistant")).toBe(true);
    }),
  );

  it.scopedLive("keeps the cursor kind stable across a resume", () =>
    Effect.gen(function* () {
      const adapter = fixtureAdapter("happy");
      const first = yield* adapter.startSession(input);
      expect(first.cursor.kind).toBe("claude");
      const firstEvents = yield* Stream.toQueue(first.events);
      yield* Effect.yieldNow();
      yield* first.startTurn({ text: "first", messageIds: [] });
      while (
        ![...(yield* Take.done(yield* Queue.take(firstEvents)))].some(
          (event) => event.kind === "turn.completed",
        )
      ) {}
      const resumed = yield* adapter.resumeSession(first.cursor, input);
      expect(resumed.cursor.kind).toBe("claude");
      yield* resumed.interrupt();
    }),
  );
});

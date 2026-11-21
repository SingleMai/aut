/** Synthetic live verification for the production Claude adapter. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeAdapter } from "../../packages/adapters/dist/index.js";
import {
  BotId,
  TaskId,
  type SessionEvent,
  type SessionHandle,
  type StartSessionInput,
} from "../../packages/protocol/dist/index.js";
import { Effect, Queue, Stream, Take } from "effect";

const workdir = mkdtempSync(join(tmpdir(), "aut-claude-adapter-live-"));
const model = process.env.AUT_CLAUDE_MODEL ?? "claude-haiku-4-5";
const input: StartSessionInput = {
  taskId: TaskId.make("claude-adapter-live"),
  bot: {
    id: BotId.make("claude-adapter-live"),
    name: "Claude adapter probe",
    description: "Synthetic Claude adapter verification",
    soul: "",
    modelSelection: { instanceId: "claude-live", model },
    cwd: workdir,
    mcpServers: [],
  },
  model,
  cwd: workdir,
  instructions: "You are an explicitly synthetic adapter test. Follow exact token instructions.",
  mcpServers: [],
};

const observed: SessionEvent[] = [];
const until = (session: SessionHandle) =>
  Effect.gen(function* () {
    const queue = yield* Stream.toQueue(session.events);
    yield* Effect.yieldNow();
    return (kind: SessionEvent["kind"]) =>
      Effect.gen(function* () {
        while (true) {
          const chunk = yield* Take.done(yield* Queue.take(queue));
          observed.push(...[...chunk]);
          const event = [...chunk].find((entry) => entry.kind === kind);
          if (event) return event;
        }
      }).pipe(Effect.timeout("120 seconds"));
  });

const assert = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(message));

const adapter = makeClaudeAdapter();
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const cursor = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* adapter.startSession(input);
        const next = yield* until(session);
        yield* session.startTurn({
          text: "Reply exactly CLAUDE_ADAPTER_LIVE_OK.",
          messageIds: [],
        });
        const completed = yield* next("turn.completed");
        if (completed.kind !== "turn.completed" || !completed.ok)
          return yield* Effect.fail(new Error("Claude adapter did not complete the live turn"));
        yield* assert(completed.finalReport.includes("CLAUDE_ADAPTER_LIVE_OK"), "Unexpected live report");

        yield* session.startTurn({
          text: "Call the aut-questions ask_user tool with the question 'Return the probe answer'. Then reply exactly CLAUDE_ADAPTER_QUESTION_OK.",
          messageIds: [],
        });
        const opened = yield* next("request.opened");
        if (opened.kind !== "request.opened" || opened.request.kind !== "question")
          return yield* Effect.fail(new Error("Claude adapter did not expose the native question tool"));
        const question = opened.request.questions[0];
        if (!question) return yield* Effect.fail(new Error("Claude adapter returned an empty question group"));
        yield* session.respond(opened.request.id, {
          perQuestion: [{ questionId: question.id, text: "AUT_CLAUDE_ADAPTER_ANSWER" }],
        });
        const questionComplete = yield* next("turn.completed");
        yield* assert(
          questionComplete.kind === "turn.completed" && questionComplete.ok && questionComplete.finalReport.includes("CLAUDE_ADAPTER_QUESTION_OK"),
          "Claude adapter did not complete after the question answer",
        );

        yield* session.startTurn({ text: "Run `sleep 5`, then reply BEFORE_STEER.", messageIds: [] });
        yield* next("turn.started");
        const steer = yield* session.steer({ text: "Reply exactly CLAUDE_ADAPTER_STEER_OK.", messageIds: [] });
        yield* assert(steer === "steered", "Claude adapter refused an active steer");
        const steered = yield* next("turn.completed");
        yield* assert(
          steered.kind === "turn.completed" && steered.ok && steered.finalReport.includes("CLAUDE_ADAPTER_STEER_OK"),
          "Claude adapter did not deliver the steered report",
        );

        yield* session.startTurn({ text: "Run `sleep 30`, then reply SHOULD_NOT_COMPLETE.", messageIds: [] });
        yield* next("turn.started");
        yield* Effect.sleep("1 second");
        yield* session.interrupt();
        const interrupted = yield* next("turn.completed");
        yield* assert(
          interrupted.kind === "turn.completed" && !interrupted.ok && interrupted.stopReason === "interrupted",
          "Claude adapter treated interrupt as success",
        );
        return session.cursor;
      }),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const resumed = yield* adapter.resumeSession(cursor, input);
        const next = yield* until(resumed);
        yield* resumed.startTurn({ text: "Reply exactly CLAUDE_ADAPTER_RESUME_OK.", messageIds: [] });
        const complete = yield* next("turn.completed");
        yield* assert(
          complete.kind === "turn.completed" && complete.ok && complete.finalReport.includes("CLAUDE_ADAPTER_RESUME_OK"),
          "Claude adapter resume failed",
        );
      }),
    );
    return { cursor };
  }).pipe(Effect.timeout("10 minutes")),
);

const output = process.env.AUT_CLAUDE_ADAPTER_RESULT ?? join(workdir, "adapter-live-result.json");
writeFileSync(
  output,
  `${JSON.stringify({
    at: new Date().toISOString(),
    cliVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    model,
    checks: ["completed turn", "native MCP question", "active steer", "interrupt", "cross-process resume", "scope cleanup"],
    ...result,
    events: observed,
  }, null, 2)}\n`,
  { flag: "wx" },
);
console.log(JSON.stringify({ output, checks: 6 }));

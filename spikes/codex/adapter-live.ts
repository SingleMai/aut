// Synthetic integration probe. Only the exact question below receives a preset test answer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { BotId, TaskId, type SessionEvent, type SessionHandle, type StartSessionInput } from "../../packages/protocol/dist/index.js";
import { Effect, Queue, Stream, Take } from "effect";

const workdir = mkdtempSync(join(tmpdir(), "aut-adapter-live-"));
const model = process.env.AUT_CODEX_MODEL ?? "gpt-6.1-sol";
const input: StartSessionInput = {
  taskId: TaskId.make("adapter-live-synthetic"),
  bot: { id: BotId.make("adapter-live"), name: "Probe", description: "Synthetic adapter test", soul: "", modelSelection: { instanceId: "codex", model }, cwd: workdir, mcpServers: [] },
  model, cwd: workdir, instructions: "You are running an explicitly synthetic integration test. Follow exact output and tool instructions.", mcpServers: [],
};
const pids = new Set<number>();
const captureChildren = () => Effect.sync(() => {
  const output = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  for (const value of output.trim().split("\n")) if (value) pids.add(Number(value));
});
const observed: SessionEvent[] = [];
const subscribe = (session: SessionHandle) => Effect.gen(function* () {
  const queue = yield* Stream.toQueue(session.events);
  yield* Effect.yieldNow();
  return (kind: SessionEvent["kind"]) => Effect.gen(function* () {
    while (true) {
      const events = yield* Take.done(yield* Queue.take(queue));
      observed.push(...events);
      for (const event of events) if (event.kind === "turn.failed" || event.kind === "process.exited") return yield* Effect.fail(new Error(JSON.stringify(event)));
      const event = [...events].find((event) => event.kind === kind);
      if (event) return event;
    }
  }).pipe(Effect.timeout("120 seconds"));
});
const assert = (condition: boolean, message: string) => condition ? Effect.void : Effect.fail(new Error(message));
const adapter = makeCodexAdapter({ rpcTimeoutMs: 20_000 });
const result = await Effect.runPromise(Effect.gen(function* () {
  const cursor = yield* Effect.scoped(Effect.gen(function* () {
    const session = yield* adapter.startSession(input);
    yield* captureChildren();
    const until = yield* subscribe(session);
    yield* session.startTurn({ text: 'Call request_user_input now with one question: id="adapter_color", header="Fixture", question="Which adapter fixture color?", options Blue (description "Synthetic blue") and Green (description "Synthetic green"). This is a synthetic test; await the tool answer, then reply exactly ADAPTER_BLUE_OK if Blue. Do not ask in plain text and do not call the async question tool.', messageIds: [] });
    const opened = yield* until("request.opened");
    if (opened.kind !== "request.opened") return yield* Effect.fail(new Error("Expected a native question"));
    const question = opened.request.questions[0];
    yield* assert(opened.request.kind === "question" && opened.request.questions.length === 1 && question?.id === "adapter_color" && question.text === "Which adapter fixture color?" && question.options?.map((option) => option.label).join(",") === "Blue,Green", "Unexpected question: never auto-answer it");
    yield* session.respond(opened.request.id, { perQuestion: [{ questionId: "adapter_color", optionIds: [question?.options?.[0]?.id ?? ""] }] });
    const completed = yield* until("turn.completed");
    yield* assert(completed.kind === "turn.completed" && completed.ok && completed.finalReport.includes("ADAPTER_BLUE_OK"), "Synthetic answer was not completed");
    yield* Effect.scoped(Effect.gen(function* () {
      const fork = yield* session.fork();
      yield* captureChildren();
      const forkUntil = yield* subscribe(fork);
      yield* fork.startTurn({ text: "Reply exactly FORK_ONLY_SENTINEL_712.", messageIds: [] });
      const complete = yield* forkUntil("turn.completed");
      yield* assert(complete.kind === "turn.completed" && complete.ok && complete.finalReport.includes("FORK_ONLY_SENTINEL_712"), "Fork did not complete");
    }));
    yield* session.startTurn({ text: "Reply exactly PARENT_ALIVE_OK.", messageIds: [] });
    const next = yield* until("turn.completed");
    yield* assert(next.kind === "turn.completed" && next.ok && next.finalReport.includes("PARENT_ALIVE_OK"), "Parent did not survive fork Scope closure");
    yield* session.startTurn({ text: "Run a shell command sleep 5, then reply BEFORE_STEER.", messageIds: [] });
    yield* until("turn.started");
    yield* assert((yield* session.steer({ text: "Change the final reply to exactly LIVE_STEER_OK.", messageIds: [] })) === "steered", "Steer was not accepted");
    const steered = yield* until("turn.completed");
    yield* assert(steered.kind === "turn.completed" && steered.ok && steered.finalReport.includes("LIVE_STEER_OK"), "Steer did not affect the active turn");
    yield* session.startTurn({ text: "Run a shell command sleep 30, then reply SHOULD_NOT_COMPLETE.", messageIds: [] });
    yield* until("turn.started");
    yield* Effect.sleep("1 second");
    yield* session.interrupt();
    const stopped = yield* until("turn.completed");
    yield* assert(stopped.kind === "turn.completed" && !stopped.ok && stopped.stopReason === "interrupted", "Interrupted turn was treated as success");
    const transcript = yield* session.transcript();
    yield* assert(transcript.some((entry) => entry.text.includes("ADAPTER_BLUE_OK")) && !transcript.some((entry) => entry.text.includes("FORK_ONLY_SENTINEL_712")), "Fork polluted parent transcript");
    return session.cursor;
  }));
  yield* Effect.scoped(Effect.gen(function* () {
    const resumed = yield* adapter.resumeSession(cursor, input);
    yield* captureChildren();
    const until = yield* subscribe(resumed);
    yield* resumed.startTurn({ text: "Reply exactly RESUME_OK.", messageIds: [] });
    const complete = yield* until("turn.completed");
    yield* assert(complete.kind === "turn.completed" && complete.ok && complete.finalReport.includes("RESUME_OK"), "Resume failed");
  }));
  return { cursor };
}).pipe(Effect.timeout("10 minutes")));
const alive = [...pids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error(`Scope leaked processes: ${alive.join(",")}`);
const output = process.env.AUT_CODEX_ADAPTER_RESULT ?? join(workdir, "adapter-live-result.json");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), model, checks: ["native question", "explicit synthetic answer", "completed report", "fork independent scope", "parent survives fork closure", "fork transcript isolation", "active-turn steer", "native interrupt", "cross-process resume", "no child processes after scope"], childPids: [...pids], alive, ...result, events: observed }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, childPids: [...pids], alive }));

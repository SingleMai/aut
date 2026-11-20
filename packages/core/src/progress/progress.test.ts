import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterError,
  BotConfig,
  type HarnessAdapter,
  MessageId,
  RequestId,
  type SessionEvent,
  type SessionHandle,
  type StartSessionInput,
  Task,
  type TurnInput,
} from "@aut/protocol";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Changes } from "../changes.js";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { CoreError } from "../errors.js";
import { CoreLive } from "../index.js";
import { SessionManager } from "../session-manager/manager.js";
import {
  HarnessResolver,
  SessionReplyGate,
  type SessionReplyInput,
  SessionSetup,
} from "../session-manager/ports.js";
import { Store } from "../store.js";
import { insertTaskWithSession } from "../task-registry.js";
import { type AskOp, ProgressQuery, ProgressQueryLive } from "./progress.js";
import { fastProgressText } from "./template.js";

const closures: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closures.splice(0)) await close();
});
const task = Schema.decodeUnknownSync(Task)({
  id: "task",
  botId: "bot",
  title: "Original task",
  status: "running",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  session: { instanceId: "local", cursor: { kind: "mock", data: "parent" } },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
  lastReport: { full: "Previous full report", delivered: "Previous report", rewrites: 0 },
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "bot",
  name: "Research",
  description: "Research",
  soul: "Original soul",
  modelSelection: { instanceId: "local", model: "test" },
  cwd: "/tmp",
  mcpServers: [],
});
const capabilities = {
  resume: true,
  fork: true,
  steer: true,
  nativeFullAccess: true,
  questions: { native: true, multiQuestion: true, multiSelect: true, freeText: true },
  transcript: true,
};
const originalTranscript = [
  { role: "user" as const, text: "Original task" },
  { role: "assistant" as const, text: "Existing evidence" },
];
interface Options {
  readonly mode?: "fast" | "deep";
  readonly fork?: boolean;
  readonly live?: boolean;
  readonly status?: Task["status"];
  readonly behavior?: "report" | "question" | "permission" | "failure" | "interrupted" | "hang";
  readonly timeoutMs?: number;
  readonly unavailableContext?: boolean;
  readonly closeBeforeFork?: boolean;
  readonly gateFails?: boolean;
}
const fixture = async (options: Options = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "aut-progress-"));
  const scope = await Effect.runPromise(Scope.make());
  closures.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(directory, { recursive: true, force: true });
  });
  const inputs: TurnInput[] = [];
  const starts: StartSessionInput[] = [];
  const gates: SessionReplyInput[] = [];
  let forks = 0;
  let resumes = 0;
  let snapshots = 0;
  let originalMutations = 0;
  let questionAnswers = 0;
  let permissions = 0;
  let transcriptReads = 0;
  let childrenClosed = 0;
  const childClosed = Effect.runSync(Deferred.make<void>());
  const currentTask: Task = {
    ...task,
    status: options.status ?? task.status,
    pendingRequestIds: options.status === "waiting_user" ? [RequestId.make("pending")] : [],
    ...(options.unavailableContext ? { session: { instanceId: "local" } } : {}),
  };
  const input: StartSessionInput = {
    taskId: task.id,
    bot,
    model: "test",
    cwd: "/tmp",
    instructions: "Original task instructions",
    mcpServers: [],
  };
  const child = Effect.gen(function* () {
    const bus = yield* Effect.acquireRelease(PubSub.unbounded<SessionEvent>(), (events) =>
      PubSub.shutdown(events).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            childrenClosed++;
          }),
        ),
        Effect.zipRight(Deferred.succeed(childClosed, undefined)),
      ),
    );
    const handle: SessionHandle = {
      cursor: { kind: "mock", data: "child" },
      events: Stream.fromPubSub(bus),
      startTurn: (turn) =>
        Effect.gen(function* () {
          inputs.push(turn);
          yield* PubSub.publish(bus, { kind: "turn.started", turnId: "query-turn" });
          if (options.behavior === "hang") return;
          if (options.behavior === "question")
            yield* PubSub.publish(bus, {
              kind: "request.opened",
              request: {
                id: RequestId.make("query-request"),
                taskId: task.id,
                kind: "question",
                openedAt: 1,
                raw: null,
                questions: [
                  { id: "q", text: "Need more input?", multiSelect: false, allowFreeText: true },
                ],
              },
            });
          else if (options.behavior === "failure")
            yield* PubSub.publish(bus, {
              kind: "turn.failed",
              turnId: "query-turn",
              error: "Test failure",
            });
          else if (options.behavior === "interrupted")
            yield* PubSub.publish(bus, {
              kind: "turn.completed",
              turnId: "query-turn",
              ok: false,
              stopReason: "interrupted",
            });
          else {
            if (options.behavior === "permission") {
              const id = RequestId.make("permission");
              yield* PubSub.publish(bus, {
                kind: "request.opened",
                request: {
                  id,
                  taskId: task.id,
                  kind: "permission",
                  openedAt: 1,
                  raw: null,
                  questions: [],
                  permission: { tool: "read", summary: "Read evidence" },
                },
              });
              yield* PubSub.publish(bus, {
                kind: "request.closed",
                requestId: id,
                reason: "answered",
              });
            }
            yield* PubSub.publish(bus, {
              kind: "turn.completed",
              turnId: "query-turn",
              ok: true,
              finalReport: "The task has gathered evidence and is still working.",
            });
          }
        }),
      steer: () => Effect.succeed("refused"),
      interrupt: () => Effect.void,
      respond: (_id, answer) =>
        Effect.sync(() => {
          if ("allow" in answer) permissions++;
          else questionAnswers++;
        }),
      fork: () =>
        Effect.fail(new AdapterError({ code: "NotSupported", message: "Unused child fork" })),
      transcript: () => Effect.succeed([{ role: "assistant", text: "Child report" }]),
    };
    return handle;
  });
  const parent: SessionHandle = {
    cursor: { kind: "mock", data: "parent" },
    events: Stream.empty,
    startTurn: () =>
      Effect.sync(() => {
        originalMutations++;
      }),
    steer: () =>
      Effect.sync(() => {
        originalMutations++;
        return "refused" as const;
      }),
    interrupt: () =>
      Effect.sync(() => {
        originalMutations++;
      }),
    respond: () =>
      Effect.sync(() => {
        originalMutations++;
      }),
    fork: () =>
      Effect.suspend(() => {
        forks++;
        if (options.closeBeforeFork && forks === 1)
          return Effect.fail(new AdapterError({ code: "ProcessExited", message: "Parent closed" }));
        return child;
      }),
    transcript: () =>
      Effect.sync(() => {
        transcriptReads++;
        return originalTranscript;
      }),
  };
  const adapter: HarnessAdapter = {
    kind: "mock",
    capabilities: { ...capabilities, fork: options.fork ?? true },
    startSession: (value) =>
      Effect.suspend(() => {
        starts.push(value);
        return child;
      }),
    resumeSession: () =>
      Effect.sync(() => {
        resumes++;
        return parent;
      }),
  };
  const manager = Layer.succeed(SessionManager, {
    answer: () => Effect.die("Unused progress-query answer port"),
    register: () => Effect.succeed({ execution: { ok: true } }),
    snapshot: () =>
      Effect.sync(() => {
        snapshots++;
        return {
          task: currentTask,
          ...(options.live === false
            ? {}
            : {
                live: {
                  session: {
                    cursor: parent.cursor,
                    fork: parent.fork,
                    transcript: parent.transcript,
                  },
                  adapter,
                  input,
                },
              }),
        };
      }),
  });
  const services = Layer.mergeAll(
    CoreLive({ dataDirectory: directory }),
    manager,
    Layer.succeed(HarnessResolver, { resolve: () => Effect.succeed(adapter) }),
    Layer.succeed(SessionSetup, { prepare: () => Effect.succeed(input) }),
    Layer.succeed(SessionReplyGate, {
      check: (value) =>
        options.gateFails
          ? Effect.fail(new CoreError({ code: "InvalidRequest", message: "Gate unavailable" }))
          : Effect.sync(() => {
              gates.push(value);
              return { delivered: "已收集资料，任务仍在推进。", rewrites: 1 };
            }),
    }),
  );
  const layer = ProgressQueryLive({ queryTimeoutMs: options.timeoutMs ?? 1_000 }).pipe(
    Layer.provideMerge(services),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof layer>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(context)));
  const op: AskOp = {
    op: "ask",
    taskId: task.id,
    mode: options.mode ?? "deep",
    messageId: MessageId.make("question"),
  };
  await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots([bot]);
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          yield* insertTaskWithSession(tx, currentTask);
          yield* tx.insert("main_thread_messages", {
            id: op.messageId,
            at: 1,
            author: "user",
            kind: "text",
            text: "What has the task found so far?",
          });
          yield* tx.insert("decision_logs", {
            id: "decision",
            at: 1,
            tree: "inbound",
            treeVersion: "1",
            input: { eventRef: "question", state: {}, dynamicOptions: {} },
            classifierCalls: [],
            path: ["ask"],
            output: op,
            execution: { ok: false, error: "Execution pending" },
          });
        }),
      );
    }),
  );
  const queue = await run(Scope.extend(Context.get(context, Changes).subscribe, scope));
  const service = Context.get(context, ProgressQuery);
  const completed = Effect.gen(function* () {
    const store = yield* Store;
    while (true) {
      const found = yield* store.transaction((tx) =>
        tx.get("main_thread_messages", "progress:decision"),
      );
      if (Option.isSome(found)) return found.value;
      yield* Queue.take(queue);
    }
  }).pipe(Effect.timeout("2 seconds"));
  const perform = async () => {
    const registered = await run(service.register(op, "decision"));
    if (registered.activate) await run(registered.activate);
    return await run(completed);
  };
  const stored = () =>
    run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            return {
              task: yield* tx.get("tasks", task.id),
              log: yield* tx.get("decision_logs", "decision"),
              events: yield* tx.list("events"),
              messages: yield* tx.list("main_thread_messages"),
            };
          }),
        );
      }),
    );
  return {
    run,
    service,
    op,
    perform,
    stored,
    currentTask,
    inputs,
    starts,
    gates,
    childClosed,
    freshService: async () =>
      Context.get(await run(Layer.buildWithScope(ProgressQueryLive(), scope)), ProgressQuery),
    counters: () => ({
      forks,
      resumes,
      snapshots,
      originalMutations,
      questionAnswers,
      permissions,
      transcriptReads,
      childrenClosed,
    }),
  };
};

describe("read-only progress queries", () => {
  it.each([
    "created",
    "running",
    "waiting_user",
    "reporting",
    "idle",
    "failed",
    "interrupted",
    "cancelled",
    "archived",
  ] as const)(
    "renders bounded fast metadata for %s without model/session access",
    async (status) => {
      const test = await fixture({ mode: "fast", status });
      const result = await test.perform();
      expect(result.author).toBe("chief");
      expect(result.text).toContain("Research");
      expect(result.text).toContain("创建：");
      expect(result.text).toContain("最近活动：");
      expect(Array.from(result.text).length).toBeLessThanOrEqual(200);
      expect(test.counters()).toMatchObject({
        forks: 0,
        resumes: 0,
        snapshots: 0,
        originalMutations: 0,
      });
      expect(test.gates).toHaveLength(0);
      const saved = await test.stored();
      expect(Option.getOrThrow(saved.task)).toEqual(test.currentTask);
    },
  );
  it("bounds Unicode bot names even for the longest state template", () => {
    expect(
      Array.from(fastProgressText({ ...task, status: "waiting_user" }, "𠮷".repeat(300))).length,
    ).toBeLessThanOrEqual(200);
  });
  it("forks without changing parent state or transcript, gates its answer, and preserves immutable reports", async () => {
    const test = await fixture();
    const result = await test.perform();
    await Effect.runPromise(Deferred.await(test.childClosed));
    expect(result.author).toEqual({ botId: "bot", taskId: "task" });
    expect(result.text).toBe("已收集资料，任务仍在推进。");
    expect(result.fullReportRef).toMatch(/^event:progress:decision:/);
    expect(test.gates).toHaveLength(1);
    expect(test.gates[0]?.session.cursor.data).toBe("child");
    expect(test.inputs[0]?.text).toContain("What has the task found so far?");
    expect(test.counters()).toMatchObject({
      forks: 1,
      originalMutations: 0,
      childrenClosed: 1,
      transcriptReads: 0,
    });
    const saved = await test.stored();
    expect(Option.getOrThrow(saved.task)).toEqual(test.currentTask);
    expect(Option.getOrThrow(saved.log).execution.ok).toBe(true);
    expect(
      saved.events.some(
        (event) =>
          `event:${event.id}` === result.fullReportRef &&
          event.event.source === "session" &&
          event.event.event.kind === "turn.completed" &&
          event.event.event.ok,
      ),
    ).toBe(true);
  });
  it("uses transcript-only temporary context when native fork is unavailable", async () => {
    const test = await fixture({ fork: false });
    await test.perform();
    await Effect.runPromise(Deferred.await(test.childClosed));
    expect(test.counters()).toMatchObject({ forks: 0, transcriptReads: 1, originalMutations: 0 });
    expect(test.inputs[0]?.text).toContain(JSON.stringify(originalTranscript));
    expect(test.starts[0]?.bot.soul).toBe("");
    expect(test.starts[0]?.mcpServers).toEqual([]);
    expect(test.gates).toHaveLength(1);
  });
  it.each([false, true])(
    "resumes only a read-only source and never executes the archived parent (stale live=%s)",
    async (closeBeforeFork) => {
      const test = await fixture({ status: "archived", live: closeBeforeFork, closeBeforeFork });
      await test.perform();
      expect(test.counters().resumes).toBe(1);
      expect(test.counters().originalMutations).toBe(0);
      expect(Option.getOrThrow((await test.stored()).task).status).toBe("archived");
    },
  );
  it.each(["question", "failure", "interrupted", "hang"] as const)(
    "records %s as a failed isolated query and leaves the original task untouched",
    async (behavior) => {
      const test = await fixture({ behavior, timeoutMs: behavior === "hang" ? 20 : 1_000 });
      const result = await test.perform();
      await Effect.runPromise(Deferred.await(test.childClosed));
      expect(result.kind).toBe("notice");
      expect(result.author).toBe("chief");
      expect(result.text).toContain("原任务不受影响");
      expect(test.gates).toHaveLength(0);
      expect(test.counters()).toMatchObject({
        originalMutations: 0,
        questionAnswers: 0,
        childrenClosed: 1,
      });
      const saved = await test.stored();
      expect(Option.getOrThrow(saved.task)).toEqual(test.currentTask);
      expect(Option.getOrThrow(saved.log).execution.ok).toBe(false);
    },
  );
  it("audits the adapter's permission approval without responding on the query session", async () => {
    const test = await fixture({ behavior: "permission" });
    expect((await test.perform()).kind).toBe("reply");
    expect(test.counters()).toMatchObject({ permissions: 0, questionAnswers: 0 });
    expect((await test.stored()).events.map(({ event }) => event.kind)).toEqual([
      "turn.started",
      "request.opened",
      "request.closed",
      "turn.completed",
    ]);
  });
  it("fails clearly when no reliable session context exists", async () => {
    const test = await fixture({ live: false, unavailableContext: true });
    expect((await test.perform()).kind).toBe("notice");
    expect(test.counters()).toMatchObject({ resumes: 0, forks: 0, originalMutations: 0 });
  });
  it("never delivers a raw deep report when the reply gate fails", async () => {
    const test = await fixture({ gateFails: true });
    expect((await test.perform()).kind).toBe("notice");
    const saved = await test.stored();
    expect(Option.getOrThrow(saved.log).execution.ok).toBe(false);
    expect(saved.messages.some((message) => message.fullReportRef !== undefined)).toBe(false);
    expect(Option.getOrThrow(saved.task)).toEqual(test.currentTask);
  });
  it("uses durable results with a fresh service and preserves concurrent corrections", async () => {
    const test = await fixture();
    const registered = await test.run(test.service.register(test.op, "decision"));
    const correction = { at: 2, kind: "manual" as const, detail: "Preserve user feedback" };
    await test.run(Effect.flatMap(DecisionLog, (logs) => logs.correct("decision", correction)));
    if (registered.activate) await test.run(registered.activate);
    await test.perform();
    const restarted = await test.freshService();
    const duplicate = await test.run(restarted.register(test.op, "decision"));
    expect(duplicate.activate).toBeUndefined();
    expect(duplicate.execution.ok).toBe(true);
    expect(test.counters().forks).toBe(1);
    expect(Option.getOrThrow((await test.stored()).log).correction).toEqual(correction);
  });
  it("waits for activation, deduplicates it, and validates matching durable ask output", async () => {
    const test = await fixture();
    const registered = await test.run(test.service.register(test.op, "decision"));
    expect(test.inputs).toHaveLength(0);
    const mismatch = await test.run(
      Effect.either(test.service.register({ ...test.op, mode: "fast" }, "decision")),
    );
    expect(mismatch._tag).toBe("Left");
    if (registered.activate)
      await test.run(
        Effect.all([registered.activate, registered.activate], { concurrency: "unbounded" }),
      );
    await test.perform();
    expect(test.counters().forks).toBe(1);
    expect(
      (await test.stored()).messages.filter((message) => message.id === "progress:decision"),
    ).toHaveLength(1);
  });
});

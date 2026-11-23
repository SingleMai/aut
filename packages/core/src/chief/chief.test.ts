import { Classifier } from "@aut/classifier/interface";
import {
  BotId,
  type DecisionAnswer,
  type DecisionLog as LogRecord,
  type MainThreadMessage,
  MessageId,
  type Op,
  RequestId,
  type Task,
  TaskId,
  Timestamp,
  TriggerId,
  TriggerRunId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Scope } from "effect";
import { expect } from "vitest";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { DecisionTreeLive } from "../decision-tree/engine.js";
import { CoreError } from "../errors.js";
import type { StoreRecords, StoreTable } from "../storage-model.js";
import { Store, type StoreTransaction } from "../store.js";
import { Chief, ChiefLive } from "./chief.js";
import {
  type ChiefInput,
  type ExecutionResult,
  type InboundState,
  OpExecutor,
  StateSource,
} from "./ports.js";

const state = (input: ChiefInput, taskIds: readonly string[]): InboundState => ({
  message: "Create a task",
  messageId:
    input.event.source === "user" && input.event.kind === "message" ? input.event.messageId : null,
  messageIds:
    input.event.source === "user" && input.event.kind === "message" ? [input.event.messageId] : [],
  uiAction: null,
  selectedOp: null,
  fixedTargetId: null,
  primaryBotId: BotId.make("aut"),
  bots: [{ id: BotId.make("aut"), name: "aut", description: "General purpose work." }],
  taskCandidates: taskIds.map((id) => ({
    id: TaskId.make(id),
    title: id,
    status: "created",
    description: "Newly registered task.",
  })),
  olderTasks: [],
  pendingRequests: [],
  recentMessages: [],
});
const setup = (
  prepare: (input: ChiefInput) => Effect.Effect<InboundState, CoreError>,
  execute: (op: Op, id: string) => Effect.Effect<ExecutionResult, CoreError>,
  activate?: (id: string) => Effect.Effect<void, CoreError>,
) => {
  const records = new Map<string, LogRecord>();
  const messages: MainThreadMessage[] = [];
  const tasks: Task[] = [];
  const requests: StoreRecords["session_requests"][] = [];
  const unusedRead = () => Effect.die("Unexpected store query in Chief fixture");
  const transaction: StoreTransaction = {
    botHasTasks: unusedRead,
    forgetBotCreation: unusedRead,
    messagesByIds: unusedRead,
    messagesByCardId: (id) => Effect.succeed(messages.filter((message) => message.card?.id === id)),
    cardsForRequest: unusedRead,
    openTaskCards: unusedRead,
    openRequests: unusedRead,
    userEvents: unusedRead(),
    latestDecisionForEvent: unusedRead,
    get: <K extends StoreTable>(table: K, id: string) =>
      Effect.succeed(
        Option.fromNullable(
          table === "tasks"
            ? tasks.find((task) => task.id === id)
            : table === "session_requests"
              ? requests.find((request) => request.id === id)
              : undefined,
        ) as Option.Option<StoreRecords[K]>,
      ),
    insert: (_table, value) =>
      Effect.sync(() => {
        messages.push(value as MainThreadMessage);
      }),
    set: (_table, value) =>
      Effect.sync(() => {
        const index = messages.findIndex((message) => message.id === value.id);
        messages[index] = value as MainThreadMessage;
      }),
    list: <K extends StoreTable>(_table: K) =>
      Effect.succeed(messages as unknown as readonly StoreRecords[K][]),
  };
  const logLayer = Layer.succeed(DecisionLog, {
    write: (log) =>
      Effect.sync(() => {
        records.set(log.id, log);
        return log;
      }),
    get: (id) => Effect.succeed(Option.fromNullable(records.get(id))),
    correct: () => Effect.die("Unused"),
    complete: (id, execution) =>
      Effect.sync(() => {
        const log = records.get(id);
        if (!log) return undefined as never;
        const next = { ...log, execution };
        records.set(id, next);
        return next;
      }),
  });
  const classifier = Layer.succeed(Classifier, {
    backend: "mock",
    model: "fixture-1",
    decide: (request) => {
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === "noul") {
          answers[id] = { type: "noul", noul: 0 };
          continue;
        }
        if (question.type !== "choice") continue;
        const selected =
          id === "op"
            ? "new_work"
            : id === "target"
              ? "none"
              : (Object.keys(question.criteria)[0] ?? "");
        answers[id] = {
          type: "choice",
          choice: selected,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0]),
          ),
        };
      }
      return Effect.succeed({ answers, latencyMs: 0 });
    },
  });
  const layer = ChiefLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        DecisionTreeLive().pipe(Layer.provide(Layer.merge(classifier, logLayer))),
        logLayer,
        Layer.succeed(StateSource, { prepare }),
        Layer.succeed(OpExecutor, {
          execute: (op, id) =>
            execute(op, id).pipe(
              Effect.map((execution) => ({
                execution,
                ...(activate ? { activate: activate(id) } : {}),
              })),
            ),
        }),
        Layer.succeed(Store, { transaction: (body) => body(transaction) }),
        Layer.succeed(ConfigStore, {
          withMutation: (effect) => effect,
          readConfig: Effect.succeed({ harnessInstances: [] }),
          writeConfig: () => Effect.die("Unused"),
          updateConfig: () => Effect.die("Unused"),
          readBots: Effect.succeed([
            {
              id: BotId.make("research"),
              name: "Research",
              description: "Research tasks",
              soul: "",
              modelSelection: { instanceId: "test", model: "test" },
              cwd: "/tmp",
              mcpServers: [],
            },
            {
              id: BotId.make("aut"),
              name: "aut",
              description: "Primary assistant",
              soul: "",
              modelSelection: { instanceId: "test", model: "test" },
              cwd: "/tmp",
              mcpServers: [],
              system: "primary" as const,
            },
          ]),
          writeBots: () => Effect.die("Unused"),
          updateBots: () => Effect.die("Unused"),
        }),
      ),
    ),
  );
  return { records, messages, tasks, requests, layer };
};

it.scoped(
  "serializes authenticated slow-brain proposals with user work and logs every proposal",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const calls: Op[] = [];
      const test = setup(
        (input) => Effect.succeed(state(input, [])),
        (op) =>
          Effect.gen(function* () {
            calls.push(op);
            yield* Deferred.succeed(entered, undefined);
            if (calls.length === 1) yield* Deferred.await(gate);
            return { ok: true };
          }),
      );
      test.tasks.push({
        id: TaskId.make("slow-task"),
        botId: BotId.make("aut"),
        title: "Slow discussion",
        status: "running",
        createdAt: Timestamp.make(1),
        updatedAt: Timestamp.make(1),
        lastActivityAt: Timestamp.make(1),
        session: { instanceId: "test" },
        pendingRequestIds: [],
        queue: [],
        origin: { kind: "coordination", decisionLogId: "source-decision" },
      });
      yield* Effect.gen(function* () {
        const chief = yield* Chief;
        const first = yield* chief.submit({
          source: "user",
          kind: "message",
          messageId: MessageId.make("user"),
        });
        const proposal = yield* chief.propose({
          originTaskId: TaskId.make("slow-task"),
          originBotId: BotId.make("aut"),
          op: {
            op: "new",
            botId: BotId.make("research"),
            requestMessageIds: [MessageId.make("user")],
          },
          rationale: "The user asked for a separate research task.",
          eventRef: "proposal-1",
        });
        yield* Deferred.await(entered);
        expect(calls).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
        yield* first.awaitResult;
        expect((yield* proposal.awaitResult).execution.ok).toBe(true);
        expect(test.records.get(proposal.decisionLogId)?.path).toEqual([
          "slow-brain",
          "propose_route",
        ]);
        expect(test.records.get(proposal.decisionLogId)?.input.state).toMatchObject({
          originBotId: "aut",
          rationale: "The user asked for a separate research task.",
        });
        expect(test.records.get(proposal.decisionLogId)?.classifierCalls).toEqual([]);
        const rejected = yield* chief.propose({
          originTaskId: TaskId.make("slow-task"),
          originBotId: BotId.make("research"),
          op: { op: "control", taskId: TaskId.make("slow-task"), action: "cancel" },
          rationale: "Synthetic unauthorized request",
          eventRef: "proposal-2",
        });
        expect((yield* rejected.awaitResult).execution.ok).toBe(false);
        expect(test.records.get(rejected.decisionLogId)?.execution.error).toContain("coordination");
        const primary = test.tasks[0];
        if (!primary) return yield* Effect.die("Missing primary task");
        test.tasks.push({ ...primary, id: TaskId.make("direct"), origin: { kind: "user" } });
        const direct = yield* chief.propose({
          originTaskId: TaskId.make("direct"),
          originBotId: primary.botId,
          op: { op: "control", taskId: primary.id, action: "cancel" },
          rationale: "Direct work with the same primary identity",
          eventRef: "proposal-direct",
        });
        expect((yield* direct.awaitResult).execution.ok).toBe(false);
        expect(calls).toHaveLength(2);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.scoped(
  "activates background work after initial logging and preserves its later degradation",
  () =>
    Effect.gen(function* () {
      let activated = false;
      const test = setup(
        (input) => Effect.succeed(state(input, [])),
        () => Effect.succeed({ ok: true }),
        (id) =>
          Effect.sync(() => {
            const log = test.records.get(id);
            expect(log?.execution.ok).toBe(true);
            expect(test.messages).toHaveLength(1);
            if (log)
              test.records.set(id, {
                ...log,
                execution: { ok: true, degraded: ["steer-to-queue"] },
              });
            activated = true;
          }),
      );
      yield* Effect.gen(function* () {
        const receipt = yield* (yield* Chief).submit({
          source: "user",
          kind: "message",
          messageId: MessageId.make("activate"),
        });
        yield* receipt.awaitResult;
        expect(activated).toBe(true);
        expect(test.records.get(receipt.decisionLogId)?.execution.degraded).toEqual([
          "steer-to-queue",
        ]);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.scoped(
  "queues immediately, registers new tasks serially, and leaves slow session work concurrent",
  () =>
    Effect.gen(function* () {
      const tasks = yield* Ref.make<string[]>([]);
      const snapshots: readonly string[][] = [];
      const observed: string[][] = snapshots as string[][];
      const registration = yield* Deferred.make<void>();
      const work = yield* Deferred.make<void>();
      const workFinished = yield* Ref.make(0);
      const scope = yield* Scope.Scope;
      let executed = 0;
      const test = setup(
        (input) =>
          Ref.get(tasks).pipe(
            Effect.map((current) => {
              observed.push([...current]);
              return state(input, current);
            }),
          ),
        () =>
          Effect.gen(function* () {
            executed += 1;
            if (executed === 1) yield* Deferred.await(registration);
            yield* Ref.update(tasks, (current) => [...current, `task-${executed}`]);
            yield* Deferred.await(work).pipe(
              Effect.zipRight(Ref.update(workFinished, (value) => value + 1)),
              Effect.forkIn(scope),
            );
            return { ok: true };
          }),
      );
      yield* Effect.gen(function* () {
        const chief = yield* Chief;
        const first = yield* chief.submit({
          source: "user",
          kind: "message",
          messageId: MessageId.make("first"),
        });
        const second = yield* chief.submit({
          source: "user",
          kind: "message",
          messageId: MessageId.make("second"),
        });
        yield* Effect.yieldNow();
        expect(observed).toEqual([[]]);
        yield* Deferred.succeed(registration, undefined);
        expect((yield* first.awaitResult).execution.ok).toBe(true);
        expect((yield* second.awaitResult).execution.ok).toBe(true);
        expect(observed).toEqual([[], ["task-1"]]);
        expect(yield* Ref.get(tasks)).toEqual(["task-1", "task-2"]);
        expect(yield* Ref.get(workFinished)).toBe(0);
        expect(test.messages.map((message) => message.text)).toEqual([
          "已交给『aut』",
          "已交给『aut』",
        ]);
        expect([...test.records.values()].every((log) => log.execution.ok)).toBe(true);
        yield* Deferred.succeed(work, undefined);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.scoped("records execution failure and continues with the next event", () =>
  Effect.gen(function* () {
    let count = 0;
    const test = setup(
      (input) => Effect.succeed(state(input, [])),
      () =>
        ++count === 1
          ? Effect.fail(
              new CoreError({ code: "Conflict", message: "Synthetic registration conflict" }),
            )
          : Effect.succeed({ ok: true }),
    );
    yield* Effect.gen(function* () {
      const chief = yield* Chief;
      const first = yield* chief.submit({
        source: "user",
        kind: "message",
        messageId: MessageId.make("first"),
      });
      const second = yield* chief.submit({
        source: "user",
        kind: "message",
        messageId: MessageId.make("second"),
      });
      expect((yield* first.awaitResult).execution.ok).toBe(false);
      expect((yield* second.awaitResult).execution.ok).toBe(true);
      expect(test.records.get(first.decisionLogId)?.execution.error).toContain(
        "registration conflict",
      );
      expect(test.records.get(first.decisionLogId)?.output).toMatchObject({ op: "new" });
    }).pipe(Effect.provide(test.layer));
  }),
);

it.scoped("records state-source failure without inventing an Op for a trigger input", () =>
  Effect.gen(function* () {
    const test = setup(
      () => Effect.fail(new CoreError({ code: "NotFound", message: "Unknown input message" })),
      () => Effect.die("Must not execute"),
    );
    yield* Effect.gen(function* () {
      const chief = yield* Chief;
      const receipt = yield* chief.submit({
        source: "user",
        kind: "message",
        messageId: MessageId.make("missing"),
      });
      expect((yield* receipt.awaitResult).execution.ok).toBe(false);
      expect(test.records.get(receipt.decisionLogId)?.output).toBeUndefined();
      const trigger = yield* chief.submit({
        source: "trigger",
        kind: "fired",
        triggerId: TriggerId.make("future"),
        runId: TriggerRunId.make("run:future"),
        occurrenceKey: "future:1",
        scheduledAt: 1,
        botId: BotId.make("research"),
        prompt: "Run the scheduled check",
        payload: {},
      });
      const triggerResult = yield* trigger.awaitResult;
      expect(triggerResult.execution.ok).toBe(false);
      expect(test.records.get(trigger.decisionLogId)?.tree).toBe("trigger");
      expect(test.records.get(trigger.decisionLogId)?.output).toBeUndefined();
    }).pipe(Effect.provide(test.layer));
  }),
);

it.scoped("caller cancellation while waiting does not remove an already queued message", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let executed = 0;
    const test = setup(
      (input) => Effect.succeed(state(input, [])),
      () =>
        Deferred.await(gate).pipe(
          Effect.map(() => {
            executed += 1;
            return { ok: true };
          }),
        ),
    );
    yield* Effect.gen(function* () {
      const chief = yield* Chief;
      const receipt = yield* chief.submit({
        source: "user",
        kind: "message",
        messageId: MessageId.make("once"),
      });
      const waiting = yield* Effect.fork(receipt.awaitResult);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* receipt.awaitResult).execution.ok).toBe(true);
      expect(executed).toBe(1);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.scoped(
  "closes the source card only after successful execution and blocks a queued duplicate",
  () =>
    Effect.gen(function* () {
      let executions = 0;
      const selectedOp: Op = {
        op: "new",
        botId: BotId.make("research"),
        requestMessageIds: [MessageId.make("original")],
      };
      const test = setup(
        (input) =>
          Effect.suspend(() => {
            if (test.messages[0]?.card?.state !== "open")
              return Effect.fail(
                new CoreError({ code: "Conflict", message: "Card was already answered" }),
              );
            return Effect.succeed({
              ...state(input, []),
              selectedOp,
              uiAction:
                input.event.source === "user" && input.event.kind === "ui-action"
                  ? input.event.action
                  : null,
            });
          }),
        () =>
          Effect.sync(() => {
            executions += 1;
            return {
              ok: executions > 1,
              ...(executions === 1 ? { error: "Synthetic failure" } : {}),
            };
          }),
      );
      test.messages.push({
        id: MessageId.make("card-message"),
        at: Timestamp.make(1),
        author: "chief",
        kind: "clarify-card",
        text: "Choose",
        card: {
          id: "card",
          prompt: "Choose",
          options: [{ id: "new", label: "New", op: selectedOp }],
          state: "open",
          multiSelect: false,
          allowFreeText: false,
        },
      });
      yield* Effect.gen(function* () {
        const chief = yield* Chief;
        const event = {
          source: "user",
          kind: "ui-action",
          action: { type: "card-choice", cardId: "card", optionId: "new" },
        } as const;
        expect((yield* (yield* chief.submit(event)).awaitResult).execution.ok).toBe(false);
        expect(test.messages[0]?.card?.state).toBe("open");
        const success = yield* chief.submit(event);
        const duplicate = yield* chief.submit(event);
        expect((yield* success.awaitResult).execution.ok).toBe(true);
        expect((yield* duplicate.awaitResult).execution.ok).toBe(false);
        expect(test.messages[0]?.card?.state).toBe("answered");
        expect(executions).toBe(2);
        expect(test.messages).toHaveLength(2);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.scoped("keeps native question cards open until the answer service confirms delivery", () =>
  Effect.gen(function* () {
    const selectedOp: Op = {
      op: "answer",
      requestId: RequestId.make("request"),
      answer: { perQuestion: [{ questionId: "question", text: "Answer" }] },
    };
    const test = setup(
      (input) => Effect.succeed({ ...state(input, []), selectedOp }),
      () => Effect.succeed({ ok: true }),
    );
    test.messages.push({
      id: MessageId.make("question-message"),
      at: Timestamp.make(1),
      author: "chief",
      kind: "question-card",
      text: "Question",
      card: {
        id: "question-card",
        requestId: RequestId.make("request"),
        prompt: "Question",
        options: [],
        state: "open",
        multiSelect: false,
        allowFreeText: true,
      },
    });
    yield* Effect.gen(function* () {
      const receipt = yield* (yield* Chief).submit({
        source: "user",
        kind: "ui-action",
        action: {
          type: "question-answer",
          cardId: "question-card",
          requestId: RequestId.make("request"),
          answer: selectedOp.answer,
        },
      });
      expect((yield* receipt.awaitResult).execution.ok).toBe(true);
      expect(test.messages[0]?.card?.state).toBe("open");
      expect(test.messages[1]?.text).toBe("已提交回答");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.scoped(
  "uses the current request state when a question closes before the Chief publishes its card",
  () =>
    Effect.gen(function* () {
      const id = RequestId.make("request");
      const taskId = TaskId.make("worker");
      const selectedOp: Op = {
        op: "clarify",
        card: {
          id: "form",
          requestId: id,
          prompt: "Questions",
          options: [],
          state: "open",
          allowFreeText: true,
          multiSelect: false,
        },
      };
      const test = setup(
        (input) => Effect.succeed({ ...state(input, []), selectedOp }),
        () =>
          Effect.sync(() => {
            test.requests.push({
              id,
              taskId,
              state: "expired",
              closedAt: 2,
              request: {
                kind: "question",
                id,
                taskId,
                openedAt: 1,
                raw: null,
                questions: [
                  { id: "q", text: "Which one?", allowFreeText: true, multiSelect: false },
                ],
              },
            });
            return { ok: true };
          }),
      );
      yield* Effect.gen(function* () {
        const receipt = yield* (yield* Chief).submit({
          source: "user",
          kind: "message",
          messageId: MessageId.make("answer"),
        });
        expect((yield* receipt.awaitResult).execution.ok).toBe(true);
        expect(test.messages).toMatchObject([
          { taskId, kind: "question-card", card: { requestId: id, state: "expired" } },
        ]);
      }).pipe(Effect.provide(test.layer));
    }),
);

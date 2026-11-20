import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "@aut/classifier/interface";
import {
  AdapterError,
  type BotConfig,
  BotId,
  type HarnessAdapter,
  MessageId,
  type Op,
  type QuestionAnswer,
  RequestId,
  type SessionEvent,
  type SessionHandle,
  type StartSessionInput,
  TaskId,
  type TaskStatus,
  type TurnInput,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  type Scope,
  Stream,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { DecisionTreeLive } from "../decision-tree/engine.js";
import { CoreError } from "../errors.js";
import type { EventBus } from "../event-bus.js";
import { CoreLive } from "../index.js";
import { MainThread } from "../main-thread.js";
import { QuestionsService, QuestionsServiceLive, SessionRequestRouterLive } from "../questions.js";
import { Store } from "../store.js";
import { TaskRegistry } from "../task-registry.js";
import {
  SessionManager,
  SessionManagerLive,
  type SessionManagerOptions,
  type SessionOp,
} from "./manager.js";
import { coalesce, type Delivery } from "./model.js";
import {
  HandoffBuilder,
  type HandoffInput,
  HarnessResolver,
  SessionReplyGate,
  type SessionReplyInput,
  type SessionReplyResult,
  type SessionRequestRouter,
  SessionSetup,
} from "./ports.js";

const bot: BotConfig = {
  id: BotId.make("worker"),
  name: "Worker",
  description: "Synthetic test",
  soul: "",
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  cwd: "/tmp",
  mcpServers: [],
};
const until = (check: Effect.Effect<boolean, CoreError>) =>
  Effect.gen(function* () {
    for (let count = 0; count < 2_000; count++) {
      if (yield* check) return;
      yield* Effect.yieldNow();
    }
    return yield* Effect.die("Fixture condition did not become true");
  });
interface FakeSession {
  readonly taskId: TaskId;
  readonly handle: SessionHandle;
  readonly starts: TurnInput[];
  readonly steers: TurnInput[];
  readonly answers: { requestId: RequestId; answer: QuestionAnswer | { allow: true } }[];
  readonly emit: (event: SessionEvent) => Effect.Effect<void>;
  current: string | undefined;
  closed: boolean;
  interrupts: number;
  onInterrupt?: () => Effect.Effect<void, AdapterError>;
}
const fakeHarness = () => {
  const sessions: FakeSession[] = [];
  const state = {
    sessions,
    resumed: 0,
    setupOpened: 0,
    setupClosed: 0,
    handoffs: 0,
    steerResult: "steered" as "steered" | "refused" | "indeterminate",
    supportedSteer: true,
    startError: undefined as AdapterError | undefined,
    afterStart: undefined as (() => Effect.Effect<void, AdapterError>) | undefined,
    respond: undefined as (() => Effect.Effect<void, AdapterError>) | undefined,
    setupWait: undefined as Effect.Effect<void, CoreError> | undefined,
    handoff: undefined as
      | ((input: HandoffInput) => Effect.Effect<TurnInput, CoreError>)
      | undefined,
    gate: (input: SessionReplyInput): Effect.Effect<SessionReplyResult, CoreError, Scope.Scope> =>
      Effect.succeed({ delivered: `GATED:${input.report}`, rewrites: 0 }),
  };
  const open = (input: StartSessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<SessionEvent>();
      let turn = 0;
      const nativeSession = sessions.length + 1;
      const session: FakeSession = {
        taskId: input.taskId,
        starts: [],
        steers: [],
        answers: [],
        closed: false,
        current: undefined,
        interrupts: 0,
        emit: (event) =>
          Effect.suspend(() => {
            if (
              (event.kind === "turn.completed" || event.kind === "turn.failed") &&
              event.turnId === session.current
            )
              session.current = undefined;
            return PubSub.publish(events, event).pipe(Effect.asVoid);
          }),
        handle: {
          cursor: { kind: "fixture", data: { id: sessions.length } },
          events: Stream.fromPubSub(events),
          startTurn: (value) =>
            Effect.gen(function* () {
              session.starts.push(value);
              if (state.startError) return yield* Effect.fail(state.startError);
              session.current = `${input.taskId}:session:${nativeSession}:turn:${++turn}`;
              yield* session.emit({ kind: "turn.started", turnId: session.current });
              if (state.afterStart) yield* state.afterStart();
            }),
          steer: (value) =>
            Effect.sync(() => {
              session.steers.push(value);
              return state.steerResult;
            }),
          interrupt: () =>
            Effect.gen(function* () {
              session.interrupts++;
              if (session.onInterrupt) return yield* session.onInterrupt();
              if (session.current)
                yield* session.emit({
                  kind: "turn.completed",
                  turnId: session.current,
                  ok: false,
                  stopReason: "interrupted",
                });
            }),
          respond: (requestId, answer) =>
            Effect.gen(function* () {
              session.answers.push({ requestId, answer });
              if (state.respond) yield* state.respond();
            }),
          fork: () =>
            Effect.fail(new AdapterError({ code: "NotSupported", message: "Fixture fork" })),
          transcript: () => Effect.succeed([]),
          readSession: () => Effect.succeed({ turns: [] }),
        },
      };
      sessions.push(session);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          session.closed = true;
        }).pipe(Effect.zipRight(PubSub.shutdown(events))),
      );
      return session.handle;
    });
  const adapter: HarnessAdapter = {
    kind: "fixture",
    capabilities: {
      resume: true,
      fork: false,
      get steer() {
        return state.supportedSteer;
      },
      nativeFullAccess: true,
      questions: { native: true, multiQuestion: true, multiSelect: false, freeText: true },
      transcript: true,
      sessionHistory: true,
    },
    startSession: open,
    resumeSession: (_cursor, input) =>
      Effect.sync(() => {
        state.resumed++;
      }).pipe(Effect.zipRight(open(input))),
  };
  return { ...state, adapter, state };
};
type Fake = ReturnType<typeof fakeHarness>;
interface TestContext {
  readonly config: typeof ConfigStore.Service;
  readonly fake: Fake;
  readonly manager: typeof SessionManager.Service;
  readonly questions: typeof QuestionsService.Service;
  readonly freshManager: Effect.Effect<typeof SessionManager.Service, CoreError, Scope.Scope>;
  readonly store: typeof Store.Service;
  readonly tasks: typeof TaskRegistry.Service;
  readonly logs: typeof DecisionLog.Service;
  readonly main: typeof MainThread.Service;
  readonly message: (text: string) => Effect.Effect<MessageId, CoreError>;
  readonly register: (
    op: SessionOp,
    activate?: boolean,
  ) => Effect.Effect<
    { id: TaskId; operationId: string; activate: Effect.Effect<void, CoreError> },
    CoreError
  >;
  readonly start: (text?: string) => Effect.Effect<{ id: TaskId; session: FakeSession }, CoreError>;
  readonly status: (id: TaskId, status: TaskStatus) => Effect.Effect<void, CoreError>;
  readonly answer: (
    requestId: RequestId,
    answer: QuestionAnswer,
    activate?: boolean,
  ) => Effect.Effect<Effect.Effect<void, CoreError>, CoreError>;
}
const withHarness = <A>(
  body: (context: TestContext) => Effect.Effect<A, unknown, Scope.Scope>,
  options: SessionManagerOptions = {},
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.sync(() => mkdtempSync(join(tmpdir(), "aut-manager-test-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const fake = fakeHarness();
    const ports = Layer.mergeAll(
      Layer.succeed(HarnessResolver, { resolve: () => Effect.succeed(fake.adapter) }),
      Layer.succeed(SessionSetup, {
        prepare: (task, bot) =>
          Effect.gen(function* () {
            fake.state.setupOpened++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                fake.state.setupClosed++;
              }),
            );
            if (fake.state.setupWait) yield* fake.state.setupWait;
            return {
              taskId: task.id,
              bot,
              model: bot.modelSelection.model,
              cwd: bot.cwd,
              instructions: "Explicit synthetic setup",
              mcpServers: [],
            };
          }),
      }),
      Layer.succeed(HandoffBuilder, {
        build: (value) =>
          Effect.suspend(() => {
            fake.state.handoffs++;
            return fake.state.handoff
              ? fake.state.handoff(value)
              : Effect.succeed({
                  text: `TEST HEADER\n${value.messages.map((message) => message.text).join("\n\n")}`,
                  messageIds: value.messages.map((message) => message.id),
                });
          }),
      }),
      Layer.succeed(SessionReplyGate, { check: (value) => fake.state.gate(value) }),
    );
    const services = QuestionsServiceLive.pipe(
      Layer.provideMerge(SessionManagerLive(options)),
      Layer.provideMerge(ports),
      Layer.provideMerge(SessionRequestRouterLive),
      Layer.provideMerge(DecisionTreeLive()),
      Layer.provideMerge(
        Layer.succeed(Classifier, {
          backend: "fixture",
          model: "no-classifier",
          decide: () => Effect.die("The request tree must not call a classifier"),
        }),
      ),
      Layer.provideMerge(CoreLive({ dataDirectory: directory })),
    );
    return yield* Effect.gen(function* () {
      const manager = yield* SessionManager;
      const dependencies = yield* Effect.context<
        | Store
        | ConfigStore
        | DecisionLog
        | EventBus
        | HarnessResolver
        | SessionSetup
        | HandoffBuilder
        | SessionReplyGate
        | SessionRequestRouter
      >();
      const freshManager = Layer.build(SessionManagerLive()).pipe(
        Effect.map((context) => Context.get(context, SessionManager)),
        Effect.provide(dependencies),
      );
      const questions = yield* QuestionsService;
      const tasks = yield* TaskRegistry;
      const logs = yield* DecisionLog;
      const store = yield* Store;
      const main = yield* MainThread;
      const config = yield* ConfigStore;
      yield* config.writeBots([bot]);
      let serial = 0;
      const message = (text: string) =>
        Effect.gen(function* () {
          const id = MessageId.make(`message:${++serial}`);
          yield* main.append({
            id,
            at: yield* Clock.currentTimeMillis,
            author: "user",
            kind: "text",
            text,
          });
          return id;
        });
      const register = (op: SessionOp, activate = true) =>
        Effect.gen(function* () {
          const operationId = `operation:${++serial}`;
          yield* logs.write({
            id: operationId,
            at: yield* Clock.currentTimeMillis,
            tree: "inbound",
            treeVersion: "synthetic",
            input: { eventRef: operationId, state: {}, dynamicOptions: {} },
            classifierCalls: [],
            path: ["synthetic"],
            output: op as Op,
            execution: { ok: false, error: "Registration pending" },
          });
          const result = yield* manager.register(op, operationId);
          yield* logs.complete(operationId, result.execution);
          if (activate && result.activate) yield* result.activate;
          return {
            id: op.op === "new" ? TaskId.make(`task:${operationId}`) : op.taskId,
            operationId,
            activate: result.activate ?? Effect.void,
          };
        });
      const status = (id: TaskId, status: TaskStatus) =>
        until(
          tasks
            .get(id)
            .pipe(Effect.map((value) => Option.isSome(value) && value.value.status === status)),
        );
      const answer = (requestId: RequestId, answer: QuestionAnswer, activate = true) =>
        Effect.gen(function* () {
          const operationId = `answer-operation:${++serial}`;
          const op: Extract<Op, { op: "answer" }> = { op: "answer", requestId, answer };
          yield* logs.write({
            id: operationId,
            at: yield* Clock.currentTimeMillis,
            tree: "inbound",
            treeVersion: "synthetic",
            input: { eventRef: operationId, state: { ...answer }, dynamicOptions: {} },
            classifierCalls: [],
            path: ["synthetic"],
            output: op,
            execution: { ok: false, error: "Registration pending" },
          });
          const result = yield* questions.register(op, operationId);
          yield* logs.complete(operationId, result.execution);
          if (activate && result.activate) yield* result.activate;
          return result.activate ?? Effect.void;
        });
      const start = (text = "First request") =>
        Effect.gen(function* () {
          const id = yield* message(text);
          const registered = yield* register({ op: "new", botId: bot.id, requestMessageIds: [id] });
          yield* until(
            Effect.sync(() =>
              fake.state.sessions.some(
                (session) =>
                  session.taskId === registered.id &&
                  session.starts.length > 0 &&
                  session.current !== undefined,
              ),
            ),
          );
          yield* status(registered.id, "running");
          const session = fake.state.sessions.find((session) => session.taskId === registered.id);
          if (!session) return yield* Effect.die("Missing fixture session");
          return { id: registered.id, session };
        });
      return yield* body({
        config,
        fake,
        manager,
        questions,
        freshManager,
        store,
        tasks,
        logs,
        main,
        message,
        register,
        start,
        status,
        answer,
      });
    }).pipe(Effect.provide(services));
  });

const fixtureQuestions = [
  {
    id: "color",
    text: "Which color?",
    options: [
      { id: "blue", label: "Blue" },
      { id: "red", label: "Red" },
    ],
    multiSelect: false,
    allowFreeText: false,
  },
  { id: "note", text: "Which note?", multiSelect: false, allowFreeText: true },
] as const;
const fixtureAnswer = {
  perQuestion: [
    { questionId: "color", optionIds: ["blue"] },
    { questionId: "note", text: "Synthetic user answer" },
  ],
} as const satisfies QuestionAnswer;
const openQuestion = (h: TestContext, session: FakeSession, id = "question-one") =>
  Effect.gen(function* () {
    const requestId = RequestId.make(id);
    yield* session.emit({
      kind: "request.opened",
      request: {
        id: requestId,
        taskId: session.taskId,
        kind: "question",
        questions: fixtureQuestions,
        openedAt: yield* Clock.currentTimeMillis,
        raw: { fixture: true },
      },
    });
    yield* until(h.main.get(MessageId.make(`question:${id}`)).pipe(Effect.map(Option.isSome)));
    return requestId;
  });
const storedQuestion = (h: TestContext, requestId: RequestId) =>
  h.store.transaction((tx) =>
    tx.get("session_requests", requestId).pipe(Effect.map(Option.getOrThrow)),
  );
const answerPhase = (h: TestContext, requestId: RequestId, phase: string) =>
  until(
    storedQuestion(h, requestId).pipe(
      Effect.map((request) => request.answerClaim?.phase === phase),
    ),
  );

it.scoped("relays the complete native question group exactly once without automatic answers", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const requestId = yield* openQuestion(h, session);
      const stored = yield* storedQuestion(h, requestId);
      yield* session.emit({ kind: "request.opened", request: stored.request });
      yield* h.status(id, "waiting_user");
      expect(session.answers).toHaveLength(0);
      const cards = (yield* h.main.page({ limit: 100 })).filter(
        (value) => value.card?.requestId === requestId,
      );
      expect(cards).toHaveLength(1);
      expect(stored.request.questions).toEqual(fixtureQuestions);
      expect(cards[0]?.card).toMatchObject({ state: "open", options: [], requestId });
      const decision = Option.getOrThrow(yield* h.logs.get(`request:${requestId}`));
      expect(decision).toMatchObject({
        tree: "request",
        output: { request: "relay" },
        classifierCalls: [],
        execution: { ok: true },
      });
    }),
  ),
);

it.scoped("registers an answer before activation and closes only the last pending request", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const first = yield* openQuestion(h, session);
      const second = yield* openQuestion(h, session, "question-two");
      const activate = yield* h.answer(first, fixtureAnswer, false);
      expect(session.answers).toHaveLength(0);
      expect((yield* storedQuestion(h, first)).answerClaim?.phase).toBe("registered");
      yield* activate;
      yield* answerPhase(h, first, "delivered");
      expect(session.answers).toEqual([{ requestId: first, answer: fixtureAnswer }]);
      expect(Option.getOrThrow(yield* h.tasks.get(id))).toMatchObject({
        status: "waiting_user",
        pendingRequestIds: [second],
      });
      yield* h.answer(second, fixtureAnswer);
      yield* answerPhase(h, second, "delivered");
      yield* h.status(id, "running");
      expect(
        (yield* h.main.page({ limit: 100 }))
          .filter((message) => message.card)
          .every((message) => message.card?.state === "answered"),
      ).toBe(true);
      expect((yield* Effect.either(h.answer(first, fixtureAnswer)))._tag).toBe("Left");
      expect(session.answers).toHaveLength(2);
    }),
  ),
);

it.scoped(
  "validates complete groups, question IDs, option IDs, selection count, free text and duplicates before registration",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        const bad: readonly QuestionAnswer[] = [
          { perQuestion: [] },
          { perQuestion: [fixtureAnswer.perQuestion[0]] },
          {
            perQuestion: [{ questionId: "unknown", text: "value" }, fixtureAnswer.perQuestion[1]],
          },
          {
            perQuestion: [
              { questionId: "color", optionIds: ["unknown"] },
              fixtureAnswer.perQuestion[1],
            ],
          },
          {
            perQuestion: [
              { questionId: "color", optionIds: ["blue", "red"] },
              fixtureAnswer.perQuestion[1],
            ],
          },
          { perQuestion: [{ questionId: "color", text: "Blue" }, fixtureAnswer.perQuestion[1]] },
          {
            perQuestion: [
              { questionId: "color", optionIds: ["blue", "blue"] },
              fixtureAnswer.perQuestion[1],
            ],
          },
          { perQuestion: [fixtureAnswer.perQuestion[0], fixtureAnswer.perQuestion[0]] },
          { perQuestion: [fixtureAnswer.perQuestion[0], { questionId: "note", text: "" }] },
        ];
        for (const answer of bad)
          expect((yield* Effect.either(h.answer(requestId, answer)))._tag).toBe("Left");
        expect(session.answers).toHaveLength(0);
        expect((yield* storedQuestion(h, requestId)).answerClaim).toBeUndefined();
      }),
    ),
);

it.scoped(
  "a replaced registration invalidates the old activation and duplicate activations send once",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        const old = yield* h.answer(requestId, fixtureAnswer, false);
        const next = yield* h.answer(requestId, fixtureAnswer, false);
        yield* old;
        yield* Effect.yieldNow();
        expect(session.answers).toHaveLength(0);
        yield* next;
        yield* next;
        yield* answerPhase(h, requestId, "delivered");
        expect(session.answers).toHaveLength(1);
      }),
    ),
);

it.scoped("native permissions are audited as allow and never enter the question answer path", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const requestId = RequestId.make("permission");
      yield* session.emit({
        kind: "request.opened",
        request: {
          id: requestId,
          taskId: id,
          kind: "permission",
          openedAt: 1,
          questions: [],
          permission: { tool: "fixture", summary: "Synthetic approval" },
          raw: {},
        },
      });
      yield* until(
        h.logs
          .get(`request:${requestId}`)
          .pipe(Effect.map((value) => Option.isSome(value) && value.value.execution.ok)),
      );
      expect(Option.getOrThrow(yield* h.logs.get(`request:${requestId}`)).output).toEqual({
        request: "allow",
      });
      expect((yield* h.main.page({ limit: 100 })).some((message) => message.card)).toBe(false);
      expect((yield* Effect.either(h.answer(requestId, fixtureAnswer)))._tag).toBe("Left");
      expect(session.answers).toHaveLength(0);
      yield* h.status(id, "running");
    }),
  ),
);

it.scoped(
  "an async request may finish unanswered and its late answer starts one same-task turn",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { id, session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        const formId = MessageId.make("chief-question-group");
        const other = yield* h.start("Independent task");
        const otherId = yield* openQuestion(h, other.session, "other-question");
        yield* h.main.append({
          id: formId,
          taskId: id,
          at: 1,
          author: "chief",
          kind: "question-card",
          text: "Complete the original form",
          card: {
            id: "form",
            requestId,
            prompt: "Complete the original form",
            options: [],
            state: "open",
            multiSelect: false,
            allowFreeText: true,
          },
        });
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "missing",
          ok: true,
          finalReport: "Continued asynchronously",
        });
        yield* h.status(id, "idle");
        expect((yield* storedQuestion(h, requestId)).state).toBe("expired");
        expect(Option.getOrThrow(yield* h.main.get(formId)).card?.state).toBe("expired");
        expect(
          Option.getOrThrow(yield* h.main.get(MessageId.make(`question:${otherId}`))).card?.state,
        ).toBe("open");
        const activate = yield* h.answer(requestId, fixtureAnswer, false);
        yield* activate;
        yield* activate;
        yield* answerPhase(h, requestId, "queued");
        expect(Option.getOrThrow(yield* h.main.get(formId)).card?.state).toBe("answered");
        yield* until(Effect.sync(() => session.starts.length === 2));
        expect(session.answers).toHaveLength(0);
        expect(session.starts[1]?.messageIds).toEqual([`answer:${requestId}`]);
        expect(session.starts[1]?.text).toContain("Which color?\nBlue");
        expect((yield* Effect.either(h.answer(requestId, fixtureAnswer)))._tag).toBe("Left");
        expect(
          (yield* h.main.page({ limit: 100 })).filter(
            (message) => message.id === `answer:${requestId}`,
          ),
        ).toHaveLength(1);
      }),
    ),
);

it.scoped(
  "a definitive RequestExpired queues the answer, while delivery uncertainty never does",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { session } = yield* h.start();
        const expired = yield* openQuestion(h, session);
        h.fake.state.respond = () =>
          Effect.fail(new AdapterError({ code: "RequestExpired", message: "Known undelivered" }));
        yield* h.answer(expired, fixtureAnswer);
        yield* answerPhase(h, expired, "queued");
        expect(session.answers).toHaveLength(1);
        const unknown = yield* openQuestion(h, session, "unknown-answer");
        h.fake.state.respond = () =>
          Effect.fail(
            new AdapterError({ code: "DeliveryIndeterminate", message: "Confirmation lost" }),
          );
        yield* h.answer(unknown, fixtureAnswer);
        yield* answerPhase(h, unknown, "indeterminate");
        expect((yield* Effect.either(h.answer(unknown, fixtureAnswer)))._tag).toBe("Left");
        expect(Option.isNone(yield* h.main.get(MessageId.make(`answer:${unknown}`)))).toBe(true);
        expect(session.answers).toHaveLength(2);
      }),
    ),
);

it.scoped("native answered evidence wins over a later lost RPC confirmation", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const requestId = yield* openQuestion(h, session);
      h.fake.state.respond = () =>
        session.emit({ kind: "request.closed", requestId, reason: "answered" }).pipe(
          Effect.zipRight(
            Effect.fail(
              new AdapterError({
                code: "DeliveryIndeterminate",
                message: "Late lost confirmation",
              }),
            ),
          ),
        );
      yield* h.answer(requestId, fixtureAnswer);
      yield* answerPhase(h, requestId, "delivered");
      yield* h.status(id, "running");
      expect(Option.isNone(yield* h.main.get(MessageId.make(`answer:${requestId}`)))).toBe(true);
    }),
  ),
);

it.scoped("turn completion during answer RPC does not resend an indeterminate answer", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const requestId = yield* openQuestion(h, session);
      const release = yield* Deferred.make<void>();
      h.fake.state.respond = () =>
        Deferred.await(release).pipe(
          Effect.zipRight(
            Effect.fail(new AdapterError({ code: "DeliveryIndeterminate", message: "Timeout" })),
          ),
        );
      yield* h.answer(requestId, fixtureAnswer);
      yield* answerPhase(h, requestId, "submitting");
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "missing",
        ok: true,
        finalReport: "Finished during answer",
      });
      yield* h.status(id, "idle");
      yield* Deferred.succeed(release, undefined);
      yield* answerPhase(h, requestId, "indeterminate");
      expect(session.starts).toHaveLength(1);
      expect((yield* Effect.either(h.answer(requestId, fixtureAnswer)))._tag).toBe("Left");
    }),
  ),
);

it.scoped(
  "cancel persisted before answer activation prevents native delivery and does not consume the card",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { id, session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        const activate = yield* h.answer(requestId, fixtureAnswer, false);
        yield* h.register({ op: "control", taskId: id, action: "cancel" });
        yield* activate;
        yield* until(
          storedQuestion(h, requestId).pipe(
            Effect.map((request) => request.answerClaim === undefined),
          ),
        );
        expect(session.answers).toHaveLength(0);
        expect(
          Option.getOrThrow(yield* h.main.get(MessageId.make(`question:${requestId}`))).card?.state,
        ).toBe("expired");
        expect(Option.isNone(yield* h.main.get(MessageId.make(`answer:${requestId}`)))).toBe(true);
      }),
    ),
);

it.scoped(
  "daemon initialization quarantines submitting claims even after the task became idle",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { id, session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        yield* h.answer(requestId, fixtureAnswer, false);
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "missing",
          ok: true,
          finalReport: "Before crash",
        });
        yield* h.status(id, "idle");
        yield* h.store.transaction((tx) =>
          Effect.gen(function* () {
            const record = Option.getOrThrow(yield* tx.get("session_requests", requestId));
            if (!record.answerClaim) return yield* Effect.die("Missing claim");
            yield* tx.set("session_requests", {
              ...record,
              answerClaim: { ...record.answerClaim, phase: "submitting" },
            });
          }),
        );
        const recovered = yield* h.freshManager;
        expect((yield* storedQuestion(h, requestId)).answerClaim?.phase).toBe("indeterminate");
        expect(
          (yield* Effect.either(
            recovered.answer(
              { op: "answer", requestId, answer: fixtureAnswer },
              "explicit-after-crash",
            ),
          ))._tag,
        ).toBe("Left");
        expect(session.answers).toHaveLength(0);
        expect(session.starts).toHaveLength(1);
      }),
    ),
);

for (const terminal of ["failed", "interrupted", "cancelled", "archived"] as const)
  it.scoped(`late answers do not implicitly reopen ${terminal} tasks`, () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { id, session } = yield* h.start();
        const requestId = yield* openQuestion(h, session);
        if (terminal === "failed")
          yield* session.emit({
            kind: "turn.failed",
            turnId: session.current ?? "missing",
            error: "Fixture failed",
          });
        else if (terminal === "interrupted")
          yield* session.emit({
            kind: "turn.completed",
            turnId: session.current ?? "missing",
            ok: false,
            stopReason: "interrupted",
          });
        else {
          yield* h.register({ op: "control", taskId: id, action: "cancel" });
          if (terminal === "archived")
            yield* h.register({ op: "control", taskId: id, action: "archive" });
        }
        yield* h.status(id, terminal);
        const result = yield* Effect.either(h.answer(requestId, fixtureAnswer));
        expect(result._tag).toBe("Left");
        if (result._tag === "Left")
          expect(result.left.message).toContain(
            terminal === "failed"
              ? "重试"
              : terminal === "interrupted"
                ? "恢复"
                : terminal === "archived"
                  ? "归档"
                  : "取消",
          );
        expect((yield* storedQuestion(h, requestId)).answerClaim).toBeUndefined();
        expect(session.answers).toHaveLength(0);
        expect(
          Option.getOrThrow(yield* h.main.get(MessageId.make(`question:${requestId}`))).card?.state,
        ).toBe("expired");
      }),
    ),
  );

it.scoped(
  "uses request order for the task title and queues a repeated registration only once",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const earlier = yield* h.message("Earlier in the thread");
        const first = yield* h.message("First in the request");
        const requestMessageIds = [first, earlier, first];
        const op = { op: "new" as const, botId: bot.id, requestMessageIds };
        const registered = yield* h.register(op, false);
        yield* h.manager.register(op, registered.operationId);
        expect(Option.getOrThrow(yield* h.tasks.get(registered.id))).toMatchObject({
          title: "First in the request",
          queue: [{ messageIds: requestMessageIds }],
        });
        expect(h.fake.state.sessions).toHaveLength(0);
        yield* registered.activate;
        yield* until(Effect.sync(() => h.fake.state.sessions[0]?.starts.length === 1));
        expect(h.fake.state.sessions[0]?.starts[0]?.messageIds).toEqual(requestMessageIds);
      }),
    ),
);

it.scoped("rejects incomplete message references without committing a task or a delivery", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const source = yield* h.message("Original request");
      const missing = MessageId.make("missing");
      const incomplete = [source, missing, source];
      const newOp = { op: "new" as const, botId: bot.id, requestMessageIds: incomplete };
      for (const ids of [[], incomplete]) {
        const error = yield* h.manager
          .register({ ...newOp, requestMessageIds: ids }, "new")
          .pipe(Effect.flip);
        expect(error.code).toBe("NotFound");
      }
      expect(yield* h.tasks.list()).toHaveLength(0);
      const registered = yield* h.register({ ...newOp, requestMessageIds: [source] }, false);
      const send = {
        op: "send" as const,
        delivery: "queue" as const,
        taskId: registered.id,
        messageIds: incomplete,
      };
      expect(yield* h.manager.register(send, "send").pipe(Effect.flip)).toMatchObject({
        code: "NotFound",
        message: `Unknown message: ${missing}`,
      });
      expect(
        (yield* h.manager.register({ ...send, messageIds: [] }, "send").pipe(Effect.flip)).code,
      ).toBe("InvalidRequest");
      const retry = yield* h.message("Corrected references");
      yield* h.manager.register({ ...send, messageIds: [retry] }, "send");
      expect(
        Option.getOrThrow(yield* h.tasks.get(registered.id)).queue.map((item) => item.messageIds),
      ).toEqual([[source], [retry]]);
    }),
  ),
);

it.scoped(
  "durably registers before activation, then delivers only gated replies and reuses the session",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const messageId = yield* h.message("Initial");
        const registered = yield* h.register(
          { op: "new", botId: bot.id, requestMessageIds: [messageId] },
          false,
        );
        expect(h.fake.state.sessions).toHaveLength(0);
        expect(Option.getOrThrow(yield* h.tasks.get(registered.id))).toMatchObject({
          status: "created",
          queue: [{ messageIds: [messageId] }],
        });
        yield* registered.activate;
        yield* until(Effect.sync(() => h.fake.state.sessions[0]?.current !== undefined));
        const session = h.fake.state.sessions[0];
        if (!session?.current) return yield* Effect.die("Missing native turn");
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current,
          ok: true,
          finalReport: "First report",
        });
        yield* h.status(registered.id, "idle");
        const next = yield* h.message("Follow up");
        yield* h.register({
          op: "send",
          taskId: registered.id,
          delivery: "immediate",
          messageIds: [next],
        });
        yield* until(
          Effect.sync(() => session.starts.length === 2 && session.current !== undefined),
        );
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "",
          ok: true,
          finalReport: "Second report",
        });
        yield* h.status(registered.id, "idle");
        const replies = (yield* h.main.page()).filter((message) => message.kind === "reply");
        expect(replies.map((message) => message.text)).toEqual([
          "GATED:First report",
          "GATED:Second report",
        ]);
        expect(new Set(replies.map((message) => message.fullReportRef)).size).toBe(2);
        expect(h.fake.state.sessions).toHaveLength(1);
        for (const reply of replies)
          expect(
            Option.isSome(
              yield* h.store.transaction((tx) =>
                tx.get("events", reply.fullReportRef?.slice(6) ?? ""),
              ),
            ),
          ).toBe(true);
      }),
    ),
);

it.scoped("queues busy input and coalesces only while draining", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const two = yield* h.message("Two");
      const three = yield* h.message("Three");
      yield* h.register({ op: "send", taskId: id, delivery: "queue", messageIds: [two] });
      yield* h.register({ op: "send", taskId: id, delivery: "queue", messageIds: [three] });
      expect(session.starts).toHaveLength(1);
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: true,
        finalReport: "One",
      });
      yield* until(Effect.sync(() => session.starts.length === 2));
      expect(session.starts[1]).toEqual({
        text: "TEST HEADER\nTwo\n\nThree",
        messageIds: [two, three],
      });
      expect(Option.getOrThrow(yield* h.tasks.get(id)).queue).toHaveLength(0);
    }),
  ),
);

for (const result of ["steered", "refused", "indeterminate", "unsupported"] as const)
  it.scoped(`steer ${result} preserves delivery certainty`, () =>
    withHarness((h) =>
      Effect.gen(function* () {
        h.fake.state.supportedSteer = result !== "unsupported";
        if (result !== "unsupported") h.fake.state.steerResult = result;
        const { id, session } = yield* h.start();
        const messageId = yield* h.message("Change direction");
        const registered = yield* h.register({
          op: "send",
          taskId: id,
          delivery: "steer",
          messageIds: [messageId],
        });
        yield* until(
          h.store
            .transaction((tx) => tx.get("sessions", id))
            .pipe(
              Effect.map(
                (value) =>
                  Option.isSome(value) &&
                  (result === "unsupported"
                    ? value.value.execution.pending[0]?.directive === "queue"
                    : result === "indeterminate"
                      ? value.value.execution.uncertain.length === 1
                      : result === "refused"
                        ? value.value.execution.pending[0]?.directive === "queue"
                        : session.steers.length === 1 && !value.value.execution.steering),
              ),
            ),
        );
        expect(session.steers).toHaveLength(result === "unsupported" ? 0 : 1);
        const log = Option.getOrThrow(yield* h.logs.get(registered.operationId));
        if (result === "indeterminate") expect(log.execution.ok).toBe(false);
        if (result === "refused" || result === "unsupported")
          expect(log.execution.degraded?.[0]).toContain("steer->queue");
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "",
          ok: true,
          finalReport: "Done",
        });
        if (result === "refused" || result === "unsupported")
          yield* until(Effect.sync(() => session.starts.length === 2));
        else {
          yield* h.status(id, "idle");
          expect(session.starts).toHaveLength(1);
        }
      }),
    ),
  );

it.scoped("restart persists input before stop and suppresses a racing successful report", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const oldTurn = session.current ?? "";
      const messageId = yield* h.message("Replacement");
      const registered = yield* h.register(
        { op: "send", taskId: id, delivery: "restart", messageIds: [messageId] },
        false,
      );
      expect(Option.getOrThrow(yield* h.tasks.get(id)).queue[0]?.messageIds).toEqual([messageId]);
      yield* session.emit({
        kind: "turn.completed",
        turnId: oldTurn,
        ok: true,
        finalReport: "Superseded",
      });
      yield* h.status(id, "idle");
      expect((yield* h.main.page()).filter((message) => message.kind === "reply")).toHaveLength(0);
      expect(session.starts).toHaveLength(1);
      yield* registered.activate;
      yield* until(Effect.sync(() => session.starts.length === 2 && session.current !== undefined));
      yield* session.emit({
        kind: "turn.completed",
        turnId: oldTurn,
        ok: true,
        finalReport: "Late old report",
      });
      yield* Effect.yieldNow();
      expect(Option.getOrThrow(yield* h.tasks.get(id)).status).toBe("running");
    }),
  ),
);

it.scoped("cancel revokes ownership before interrupt; late success cannot publish", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const oldTurn = session.current ?? "";
      const cancel = yield* h.register({ op: "control", taskId: id, action: "cancel" }, false);
      expect(Option.getOrThrow(yield* h.tasks.get(id)).status).toBe("cancelled");
      yield* session.emit({
        kind: "turn.completed",
        turnId: oldTurn,
        ok: true,
        finalReport: "Late",
      });
      yield* cancel.activate;
      yield* until(Effect.sync(() => session.closed));
      expect((yield* h.main.page()).filter((message) => message.kind === "reply")).toHaveLength(0);
      expect(
        (yield* h.store.transaction((tx) => tx.list("events"))).some(
          (entry) => entry.event.kind === "turn.completed",
        ),
      ).toBe(true);
      yield* h.register({ op: "control", taskId: id, action: "archive" });
      yield* h.status(id, "archived");
    }),
  ),
);

it.scoped("explicit retry reuses the failed prepared input exactly once", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start("Original work");
      yield* session.emit({
        kind: "turn.failed",
        turnId: session.current ?? "",
        error: "Synthetic failure",
      });
      yield* h.status(id, "failed");
      yield* h.register({ op: "control", taskId: id, action: "retry" });
      yield* until(Effect.sync(() => session.starts.length === 2 && session.current !== undefined));
      expect(session.starts[1]).toEqual(session.starts[0]);
      expect(h.fake.state.handoffs).toBe(1);
      yield* h.status(id, "running");
    }),
  ),
);

it.scoped("an indeterminate start is recorded and cannot be silently retried", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      h.fake.state.startError = new AdapterError({
        code: "DeliveryIndeterminate",
        message: "Synthetic ambiguous acceptance",
      });
      const messageId = yield* h.message("Potential side effect");
      const registered = yield* h.register({
        op: "new",
        botId: bot.id,
        requestMessageIds: [messageId],
      });
      yield* h.status(registered.id, "failed");
      const retry = yield* h
        .register({ op: "control", taskId: registered.id, action: "retry" })
        .pipe(Effect.flip);
      expect(retry.code).toBe("Conflict");
      expect(h.fake.state.sessions[0]?.starts).toHaveLength(1);
    }),
  ),
);

it.scoped("unexpected interruption resumes with a continuation template, not the old request", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start("Irreversible old request");
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: false,
        stopReason: "interrupted",
      });
      yield* h.status(id, "interrupted");
      yield* h.register({ op: "control", taskId: id, action: "resume" });
      yield* until(Effect.sync(() => session.starts.length === 2));
      expect(session.starts[1]?.text).toContain("avoid repeating completed actions");
      expect(session.starts[1]?.text).not.toContain("Irreversible old request");
    }),
  ),
);

it.scoped("a missing gate preserves reporting and the full report without publishing", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      h.fake.state.gate = () =>
        Effect.fail(new CoreError({ code: "Configuration", message: "Gate unavailable" }));
      const { id, session } = yield* h.start();
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: true,
        finalReport: "Ungated raw report",
      });
      yield* h.status(id, "reporting");
      expect(Option.getOrThrow(yield* h.tasks.get(id)).lastReport).toEqual({
        full: "Ungated raw report",
        delivered: "",
        rewrites: 0,
      });
      expect((yield* h.main.page()).filter((message) => message.kind === "reply")).toHaveLength(0);
    }),
  ),
);

it.scoped("pending questions are counted atomically and permission events do not block", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      for (const name of ["q1", "q2"])
        yield* session.emit({
          kind: "request.opened",
          request: {
            id: RequestId.make(name),
            taskId: id,
            kind: "question",
            openedAt: 0,
            raw: {},
            questions: [{ id: name, text: "Fixture?", multiSelect: false, allowFreeText: true }],
          },
        });
      yield* until(
        h.tasks
          .get(id)
          .pipe(
            Effect.map(
              (value) => Option.isSome(value) && value.value.pendingRequestIds.length === 2,
            ),
          ),
      );
      yield* session.emit({
        kind: "request.closed",
        requestId: RequestId.make("q1"),
        reason: "answered",
      });
      yield* until(
        h.tasks
          .get(id)
          .pipe(
            Effect.map(
              (value) => Option.isSome(value) && value.value.pendingRequestIds.length === 1,
            ),
          ),
      );
      expect(Option.getOrThrow(yield* h.tasks.get(id)).status).toBe("waiting_user");
      yield* session.emit({
        kind: "request.closed",
        requestId: RequestId.make("q2"),
        reason: "answered",
      });
      yield* h.status(id, "running");
      yield* session.emit({
        kind: "request.opened",
        request: {
          id: RequestId.make("permission"),
          taskId: id,
          kind: "permission",
          openedAt: 0,
          raw: {},
          questions: [],
          permission: { tool: "fixture", summary: "Synthetic" },
        },
      });
      yield* Effect.yieldNow();
      expect(Option.getOrThrow(yield* h.tasks.get(id)).pendingRequestIds).toHaveLength(0);
    }),
  ),
);

it.effect("coalescing uses adjacent nonnegative gaps and a configurable item cap", () =>
  Effect.sync(() => {
    const entry = (at: number, id: string): Delivery => ({
      id,
      decisionLogId: id,
      messageIds: [MessageId.make(id)],
      queuedAt: at,
      ready: true,
      directive: "queue",
    });
    expect(
      coalesce([entry(0, "a"), entry(120_000, "b"), entry(240_000, "c")], 120_000, 30),
    ).toHaveLength(3);
    expect(coalesce([entry(0, "a"), entry(120_001, "b")], 120_000, 30)).toHaveLength(1);
    expect(coalesce([entry(20, "a"), entry(19, "b")], 120_000, 30)).toHaveLength(1);
    expect(coalesce([entry(0, "a"), entry(1, "b"), entry(2, "c")], 120_000, 2)).toHaveLength(2);
  }),
);

it.scoped("independent tasks execute concurrently without sharing queues", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const first = yield* h.start("Task A");
      const second = yield* h.start("Task B");
      expect(h.fake.state.sessions).toHaveLength(2);
      expect(first.session.current).toBeDefined();
      expect(second.session.current).toBeDefined();
      const messageId = yield* h.message("Only A");
      yield* h.register({
        op: "send",
        taskId: first.id,
        delivery: "queue",
        messageIds: [messageId],
      });
      yield* second.session.emit({
        kind: "turn.completed",
        turnId: second.session.current ?? "",
        ok: true,
        finalReport: "B finished",
      });
      yield* h.status(second.id, "idle");
      expect(first.session.starts).toHaveLength(1);
      expect(second.session.starts).toHaveLength(1);
      expect(Option.getOrThrow(yield* h.tasks.get(first.id)).queue).toHaveLength(1);
    }),
  ),
);

it.scoped("a drain respects the configured cap and leaves the rest for the next completion", () =>
  withHarness(
    (h) =>
      Effect.gen(function* () {
        const { id, session } = yield* h.start();
        for (const text of ["A", "B", "C"])
          yield* h.register({
            op: "send",
            taskId: id,
            delivery: "queue",
            messageIds: [yield* h.message(text)],
          });
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "",
          ok: true,
          finalReport: "First",
        });
        yield* until(
          Effect.sync(() => session.starts.length === 2 && session.current !== undefined),
        );
        expect(session.starts[1]?.text).toBe("TEST HEADER\nA\n\nB");
        expect(Option.getOrThrow(yield* h.tasks.get(id)).queue).toHaveLength(1);
        yield* session.emit({
          kind: "turn.completed",
          turnId: session.current ?? "",
          ok: true,
          finalReport: "Second",
        });
        yield* until(Effect.sync(() => session.starts.length === 3));
        expect(session.starts[2]?.text).toBe("TEST HEADER\nC");
      }),
    { maxBatchItems: 2 },
  ),
);

it.scoped("restart waits for confirmed stop cleanup before draining the replacement", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const stopped = yield* Deferred.make<void>();
      session.onInterrupt = () =>
        Effect.gen(function* () {
          expect(Option.getOrThrow(yield* h.tasks.get(id).pipe(Effect.orDie)).queue).toHaveLength(
            1,
          );
          yield* session.emit({
            kind: "turn.completed",
            turnId: session.current ?? "",
            ok: false,
            stopReason: "interrupted",
          });
          yield* Deferred.await(stopped);
        });
      yield* h.register({
        op: "send",
        taskId: id,
        delivery: "restart",
        messageIds: [yield* h.message("Replacement")],
      });
      yield* h.status(id, "idle");
      expect(session.starts).toHaveLength(1);
      yield* Deferred.succeed(stopped, undefined);
      yield* until(Effect.sync(() => session.starts.length === 2));
    }),
  ),
);

it.scoped("cancel while gating prevents the delayed reply from being published", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const held = yield* Deferred.make<SessionReplyResult>();
      h.fake.state.gate = () =>
        Deferred.succeed(ready, undefined).pipe(Effect.zipRight(Deferred.await(held)));
      const { id, session } = yield* h.start();
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: true,
        finalReport: "Held report",
      });
      yield* Deferred.await(ready);
      yield* h.register({ op: "control", taskId: id, action: "cancel" });
      yield* Deferred.succeed(held, { delivered: "Must not publish", rewrites: 0 });
      yield* until(Effect.sync(() => session.closed));
      expect((yield* h.main.page()).filter((message) => message.kind === "reply")).toHaveLength(0);
      expect(Option.getOrThrow(yield* h.tasks.get(id)).status).toBe("cancelled");
    }),
  ),
);

it.scoped("duplicate successful terminal events are all audited but gate runs once", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<SessionReplyResult>();
      let calls = 0;
      h.fake.state.gate = () =>
        Effect.sync(() => {
          calls++;
        }).pipe(Effect.zipRight(Deferred.await(held)));
      const { id, session } = yield* h.start();
      const turnId = session.current ?? "";
      yield* session.emit({ kind: "turn.completed", turnId, ok: true, finalReport: "Original" });
      yield* h.status(id, "reporting");
      yield* session.emit({ kind: "turn.completed", turnId, ok: true, finalReport: "Duplicate" });
      yield* session.emit({ kind: "turn.failed", turnId, error: "Late error" });
      yield* until(
        h.store
          .transaction((tx) => tx.list("events"))
          .pipe(Effect.map((events) => events.length >= 4)),
      );
      expect(calls).toBe(1);
      yield* Deferred.succeed(held, { delivered: "Checked original", rewrites: 0 });
      yield* h.status(id, "idle");
      expect(Option.getOrThrow(yield* h.tasks.get(id)).lastReport?.full).toBe("Original");
    }),
  ),
);

for (const ready of [false, true])
  it.scoped(
    `explicit resume replaces a stale ${ready ? "ready" : "unready"} registration without early replay`,
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { id, session } = yield* h.start();
          yield* h.register(
            {
              op: "send",
              taskId: id,
              delivery: "queue",
              messageIds: [yield* h.message("Queued before interruption")],
            },
            false,
          );
          yield* session.emit({
            kind: "turn.completed",
            turnId: session.current ?? "",
            ok: false,
            stopReason: "interrupted",
          });
          yield* h.status(id, "interrupted");
          const old = yield* h.register({ op: "control", taskId: id, action: "resume" }, false);
          if (ready)
            yield* h.store.transaction((tx) =>
              Effect.gen(function* () {
                const stored = Option.getOrThrow(yield* tx.get("sessions", id));
                if (!stored.execution.nextStart)
                  return yield* Effect.die("Missing recovery registration");
                yield* tx.set("sessions", {
                  ...stored,
                  execution: {
                    ...stored.execution,
                    nextStart: { ...stored.execution.nextStart, ready: true },
                  },
                });
              }),
            );
          const replacement = yield* h.register(
            { op: "control", taskId: id, action: "resume" },
            false,
          );
          yield* old.activate;
          yield* Effect.yieldNow();
          const stored = Option.getOrThrow(
            yield* h.store.transaction((tx) => tx.get("sessions", id)),
          );
          expect(stored.execution.pending[0]?.ready).toBe(false);
          expect(session.starts).toHaveLength(1);
          yield* replacement.activate;
          yield* until(Effect.sync(() => session.starts.length === 2));
          expect(session.starts[1]?.text).toContain("Queued before interruption");
        }),
      ),
  );

it.scoped("recovered in-flight steer becomes uncertain and cannot block explicit resume", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: false,
        stopReason: "interrupted",
      });
      yield* h.status(id, "interrupted");
      const messageId = yield* h.message("Potentially delivered before crash");
      yield* h.store.transaction((tx) =>
        Effect.gen(function* () {
          const stored = Option.getOrThrow(yield* tx.get("sessions", id));
          yield* tx.set("sessions", {
            ...stored,
            execution: {
              ...stored.execution,
              steering: {
                generation: 1,
                delivery: {
                  id: "old-steer",
                  decisionLogId: "steer-decision",
                  messageIds: [messageId],
                  queuedAt: 0,
                  directive: "steer",
                  ready: true,
                },
              },
            },
          });
        }),
      );
      yield* h.register({ op: "control", taskId: id, action: "resume" });
      yield* until(Effect.sync(() => session.starts.length === 2));
      const stored = Option.getOrThrow(yield* h.store.transaction((tx) => tx.get("sessions", id)));
      expect(stored.execution.uncertain.map((entry) => entry.id)).toContain("old-steer");
      expect(session.steers).toHaveLength(0);
      expect(session.starts[1]?.text).not.toContain("Potentially delivered before crash");
    }),
  ),
);

it.scoped("resume prioritizes queued work instead of replaying the interrupted input", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start("Old input");
      yield* h.register({
        op: "send",
        taskId: id,
        delivery: "queue",
        messageIds: [yield* h.message("Pending input")],
      });
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: false,
        stopReason: "interrupted",
      });
      yield* h.status(id, "interrupted");
      yield* h.register({ op: "control", taskId: id, action: "resume" });
      yield* until(Effect.sync(() => session.starts.length === 2));
      expect(session.starts[1]?.text).toBe("TEST HEADER\nPending input");
    }),
  ),
);

it.scoped("task updates preserve internal execution ownership", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id } = yield* h.start();
      const before = Option.getOrThrow(
        yield* h.store.transaction((tx) => tx.get("sessions", id)),
      ).execution;
      yield* h.tasks.update(id, (task) => ({ ...task, title: "Updated title" }));
      expect(
        Option.getOrThrow(yield* h.store.transaction((tx) => tx.get("sessions", id))).execution,
      ).toEqual(before);
    }),
  ),
);

it.scoped(
  "cold explicit resume uses the stored cursor and does not create a replacement session",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const id = TaskId.make("recovered-task");
        yield* h.tasks.create({
          id,
          botId: bot.id,
          title: "Recovered",
          status: "created",
          createdAt: 0,
          updatedAt: 0,
          lastActivityAt: 0,
          session: {
            instanceId: "fixture",
            cursor: { kind: "fixture", data: { nativeThread: "persisted" } },
          },
          pendingRequestIds: [],
          queue: [],
          origin: { kind: "user" },
        });
        yield* h.tasks.transition(id, { type: "daemon.restart" });
        yield* h.register({ op: "control", taskId: id, action: "resume" });
        yield* until(Effect.sync(() => h.fake.state.sessions[0]?.starts.length === 1));
        expect(h.fake.state.resumed).toBe(1);
        expect(h.fake.state.sessions[0]?.starts[0]?.text).toContain(
          "avoid repeating completed actions",
        );
      }),
    ),
);

it.scoped("snapshot exposes read/fork access without worker mutation methods", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id } = yield* h.start();
      const snapshot = yield* h.manager.snapshot(id);
      expect(snapshot.task.botId).toBe(bot.id);
      expect(Object.keys(snapshot.live?.session ?? {}).sort()).toEqual([
        "cursor",
        "fork",
        "readSession",
        "transcript",
      ]);
      expect(yield* snapshot.live?.session.readSession?.() ?? Effect.die("Missing reader")).toEqual(
        { turns: [] },
      );
      expect(h.fake.state.sessions[0]?.closed).toBe(false);
      expect((yield* h.manager.snapshot(TaskId.make("absent")).pipe(Effect.flip)).code).toBe(
        "NotFound",
      );
    }),
  ),
);

it.scoped("audits session changes but updates activity only for the current owned turn", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const before = Option.getOrThrow(yield* h.tasks.get(id));
      yield* TestClock.adjust("1 second");
      yield* session.emit({
        kind: "session.changed",
        turnId: session.current ?? "missing",
        itemId: "current-tool",
      });
      yield* until(
        h.tasks
          .get(id)
          .pipe(
            Effect.map(
              (value) => Option.isSome(value) && value.value.lastActivityAt > before.lastActivityAt,
            ),
          ),
      );
      const current = Option.getOrThrow(yield* h.tasks.get(id));
      expect(current.status).toBe(before.status);
      expect(current.session).toEqual(before.session);
      expect(current.queue).toEqual(before.queue);
      expect(current.pendingRequestIds).toEqual(before.pendingRequestIds);
      yield* TestClock.adjust("1 second");
      yield* session.emit({ kind: "session.changed", turnId: "retired-turn", itemId: "late-tool" });
      yield* until(
        h.store
          .transaction((tx) => tx.list("events"))
          .pipe(
            Effect.map((events) =>
              events.some(
                (entry) =>
                  entry.event.source === "session" &&
                  entry.event.event.kind === "session.changed" &&
                  entry.event.event.itemId === "late-tool",
              ),
            ),
          ),
      );
      expect(Option.getOrThrow(yield* h.tasks.get(id))).toEqual(current);
      const events = yield* h.store.transaction((tx) => tx.list("events"));
      expect(
        events.filter(
          (entry) => entry.event.source === "session" && entry.event.kind === "session.changed",
        ),
      ).toHaveLength(2);
    }),
  ),
);

it.scoped("busy immediate delivery and invalid control transitions are rejected", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      const messageId = yield* h.message("Too early");
      expect(
        (yield* h
          .register({ op: "send", taskId: id, delivery: "immediate", messageIds: [messageId] })
          .pipe(Effect.flip)).code,
      ).toBe("InvalidTransition");
      expect(
        (yield* h.register({ op: "control", taskId: id, action: "archive" }).pipe(Effect.flip))
          .code,
      ).toBe("InvalidTransition");
      expect(session.starts).toHaveLength(1);
    }),
  ),
);

it.scoped("manager Scope closes all owned sessions and setup registrations", () =>
  Effect.gen(function* () {
    const state = yield* withHarness((h) =>
      Effect.gen(function* () {
        yield* h.start("A");
        yield* h.start("B");
        return h.fake.state;
      }),
    );
    expect(state.sessions.every((session) => session.closed)).toBe(true);
    expect(state.setupClosed).toBe(2);
  }),
);

it.scoped("a stale start failure cannot close a newer generation's preparing Scope", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const oldResponse = yield* Deferred.make<void, AdapterError>();
      h.fake.state.afterStart = () => Deferred.await(oldResponse);
      const { id, session } = yield* h.start();
      yield* session.emit({ kind: "process.exited", code: 7 });
      yield* h.status(id, "failed");
      const newSetup = yield* Deferred.make<void>();
      h.fake.state.setupWait = Deferred.await(newSetup);
      h.fake.state.afterStart = undefined;
      yield* h.register({ op: "control", taskId: id, action: "retry" });
      yield* until(Effect.sync(() => h.fake.state.setupOpened === 2));
      yield* Deferred.fail(
        oldResponse,
        new AdapterError({ code: "ProtocolError", message: "Late old RPC failure" }),
      );
      for (let count = 0; count < 10; count++) yield* Effect.yieldNow();
      expect(h.fake.state.setupClosed).toBe(1);
      yield* Deferred.succeed(newSetup, undefined);
      yield* until(Effect.sync(() => h.fake.state.sessions[1]?.starts.length === 1));
      expect(h.fake.state.sessions[1]?.closed).toBe(false);
    }),
  ),
);

it.scoped(
  "restart during handoff preparation cleans the abandoned Scope before replacement work",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const blocked = yield* Deferred.make<TurnInput>();
        h.fake.state.handoff = (input) =>
          h.fake.state.handoffs === 1
            ? Deferred.await(blocked)
            : Effect.succeed({
                text: input.messages.map((message) => message.text).join("\n"),
                messageIds: input.messages.map((message) => message.id),
              });
        const first = yield* h.message("Original pre-start work");
        const created = yield* h.register({ op: "new", botId: bot.id, requestMessageIds: [first] });
        yield* until(Effect.sync(() => h.fake.state.handoffs === 1));
        yield* h.register({
          op: "send",
          taskId: created.id,
          delivery: "restart",
          messageIds: [yield* h.message("Replacement prepared work")],
        });
        yield* until(
          Effect.sync(() =>
            h.fake.state.sessions.some((session) =>
              session.starts.some((turn) => turn.text === "Replacement prepared work"),
            ),
          ),
        );
        expect(h.fake.state.setupClosed).toBeGreaterThanOrEqual(1);
        expect(
          h.fake.state.sessions
            .flatMap((session) => session.starts)
            .some((turn) => turn.text.includes("Original pre-start work")),
        ).toBe(false);
      }),
    ),
);

it.scoped("an idle process exit lazily resumes its cursor for the next send", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const { id, session } = yield* h.start();
      yield* session.emit({
        kind: "turn.completed",
        turnId: session.current ?? "",
        ok: true,
        finalReport: "First",
      });
      yield* h.status(id, "idle");
      yield* session.emit({ kind: "process.exited", code: 0 });
      yield* until(Effect.sync(() => session.closed));
      yield* h.register({
        op: "send",
        taskId: id,
        delivery: "immediate",
        messageIds: [yield* h.message("Next")],
      });
      yield* until(Effect.sync(() => h.fake.state.sessions[1]?.current !== undefined));
      expect(h.fake.state.resumed).toBe(1);
      const resumed = h.fake.state.sessions[1];
      if (!resumed?.current) return yield* Effect.die("Missing resumed turn");
      yield* resumed.emit({
        kind: "turn.completed",
        turnId: resumed.current,
        ok: true,
        finalReport: "Resumed",
      });
      yield* h.status(id, "idle");
      expect(Option.getOrThrow(yield* h.tasks.get(id)).lastReport?.delivered).toBe("GATED:Resumed");
    }),
  ),
);

it.scoped(
  "corrects an acknowledged dispatch exactly once in the same transaction as task registration",
  () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const alternate = BotId.make("alternate");
        yield* h.config.writeBots([bot, { ...bot, id: alternate, system: "primary" }]);
        const source = yield* h.message("Original multilingual request 原话");
        const initial = { op: "new" as const, botId: bot.id, requestMessageIds: [source] };
        const original = yield* h.register(initial, false);
        const ack = {
          id: MessageId.make(`chief:${original.operationId}`),
          at: 1,
          author: "chief" as const,
          kind: "ack" as const,
          text: "Dispatch accepted",
          decisionLogId: original.operationId,
        };
        yield* h.main.append(ack);
        // A later execution error must not remove the controls for an acknowledged dispatch.
        yield* h.logs.complete(original.operationId, {
          ok: false,
          error: "Fixture worker failure",
        });
        const readAck = () =>
          h.main.page().pipe(Effect.map((rows) => rows.find((row) => row.id === ack.id)));
        expect((yield* readAck())?.dispatch).toEqual({
          botId: bot.id,
          status: "open",
          canUndo: true,
        });
        const options = { corrects: original.operationId };
        for (const op of [
          initial,
          {
            ...initial,
            botId: alternate,
            requestMessageIds: [yield* h.message("Substituted text")],
          },
        ]) {
          expect((yield* h.manager.register(op, "rejected", options).pipe(Effect.flip)).code).toBe(
            "InvalidRequest",
          );
          expect((yield* h.tasks.get(TaskId.make("task:rejected")))._tag).toBe("None");
        }
        expect((yield* readAck())?.dispatch?.status).toBe("open");
        const results = yield* Effect.all(
          ["correction-a", "correction-b"].map((id) =>
            h.manager.register({ ...initial, botId: alternate }, id, options).pipe(Effect.either),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Right")).toHaveLength(1);
        const oldLog = Option.getOrThrow(yield* h.logs.get(original.operationId));
        expect(oldLog.correction?.kind).toBe("reroute");
        const newDecision = oldLog.correction?.decisionLogId;
        const rows = yield* h.tasks.list();
        expect(rows).toHaveLength(2);
        expect(rows.find((t) => t.id === original.id)?.botId).toBe(bot.id);
        expect(rows.find((t) => t.id !== original.id)).toMatchObject({
          botId: alternate,
          title: "Original multilingual request 原话",
          origin: { kind: "user", decisionLogId: newDecision },
          queue: [{ messageIds: [source] }],
        });
        expect((yield* readAck())?.dispatch?.status).toBe("reroute");
      }),
    ),
);

it.scoped("undo cancels the original task and a stale cancellation rolls its correction back", () =>
  withHarness((h) =>
    Effect.gen(function* () {
      const source = yield* h.message("Cancel this request");
      for (const alreadyCancelled of [true, false]) {
        const original = yield* h.register(
          { op: "new", botId: bot.id, requestMessageIds: [source] },
          false,
        );
        yield* h.main.append({
          id: MessageId.make(`chief:${original.operationId}`),
          at: 1,
          author: "chief",
          kind: "ack",
          text: "Accepted",
          decisionLogId: original.operationId,
        });
        const undo = { op: "control" as const, taskId: original.id, action: "cancel" as const };
        if (alreadyCancelled) yield* h.register(undo, false);
        const result = yield* h.manager
          .register(undo, `undo:${original.id}`, { corrects: original.operationId })
          .pipe(Effect.either);
        expect(result._tag).toBe(alreadyCancelled ? "Left" : "Right");
        expect(Option.getOrThrow(yield* h.tasks.get(original.id)).status).toBe("cancelled");
        const log = Option.getOrThrow(yield* h.logs.get(original.operationId));
        expect(log.correction?.kind).toBe(alreadyCancelled ? undefined : "undo");
      }
    }),
  ),
);

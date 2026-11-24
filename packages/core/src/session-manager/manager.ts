// Delivery ownership and stop/drain sequencing adapted from OpenMausBot (Apache-2.0),
// server/steer-queue.ts and runtime/runtime.ts@738ec88472a3b888ff7b7793755d89da613ed301.
import { randomUUID } from "node:crypto";
import {
  AdapterError,
  type HarnessAdapter,
  MessageId,
  type Op,
  QuestionAnswer,
  type RequestId,
  type SessionEvent,
  type SessionHandle,
  StartSessionInput,
  type Task,
  TaskId,
  TurnInput,
} from "@aut/protocol";
import {
  Cause,
  Clock,
  Context,
  Effect,
  ExecutionStrategy,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import type { ExecutionResult, RegisteredExecution } from "../chief/ports.js";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { dispatchTaskId } from "../dispatch-correction.js";
import { CoreError, validate } from "../errors.js";
import { EventBus } from "../event-bus.js";
import { messagesInOrder } from "../main-thread.js";
import { reportSources } from "../report-sources.js";
import { expireTaskRequests, markQuestionCards, validateQuestionAnswer } from "../request-cards.js";
import type { StoredRequest } from "../storage-model.js";
import { Store, type StoreTransaction } from "../store.js";
import { requireTask, saveTask, transitionTask } from "../task-registry.js";
import { executionFor, noActive, noNext, noSteering } from "./execution.js";
import { type Attempt, coalesce, type Delivery } from "./model.js";
import {
  HandoffBuilder,
  HarnessResolver,
  SessionReplyGate,
  type SessionReplyResult,
  SessionRequestRouter,
  SessionSetup,
  type SessionSnapshot,
} from "./ports.js";

import { registerOperation, type SessionOp } from "./registration.js";

export type { SessionOp } from "./registration.js";
export interface SessionManagerOptions {
  readonly coalesceWindowMs?: number;
  readonly maxBatchItems?: number;
}
export class SessionManager extends Context.Tag("aut/SessionManager")<
  SessionManager,
  {
    readonly register: (
      op: SessionOp,
      decisionLogId: string,
      options?: { readonly origin?: Task["origin"]; readonly corrects?: string },
    ) => Effect.Effect<RegisteredExecution, CoreError>;
    readonly snapshot: (taskId: TaskId) => Effect.Effect<SessionSnapshot, CoreError>;
    readonly answer: (
      op: Extract<Op, { op: "answer" }>,
      decisionLogId: string,
    ) => Effect.Effect<RegisteredExecution, CoreError>;
  }
>() {}

const fault = (code: CoreError["code"], message: string) => new CoreError({ code, message });
const continueInput: TurnInput = {
  text: "Continue the interrupted task from the current session state. Inspect the transcript and current state, and avoid repeating completed actions.",
  messageIds: [],
};

interface LiveSession {
  readonly handle: SessionHandle;
  readonly adapter: HarnessAdapter;
  readonly input: StartSessionInput;
  readonly scope: Scope.CloseableScope;
  readonly token: string;
}
type Mail =
  | { readonly kind: "wake" }
  | { readonly kind: "answer"; readonly requestId: RequestId; readonly claimId: string }
  | {
      readonly kind: "answered";
      readonly requestId: RequestId;
      readonly claimId: string;
      readonly result: "delivered" | "expired" | "indeterminate" | "invalid";
      readonly error?: string;
    }
  | { readonly kind: "event"; readonly token: string; readonly event: SessionEvent }
  | {
      readonly kind: "prepared";
      readonly generation: number;
      readonly live: LiveSession;
      readonly input: TurnInput;
    }
  | {
      readonly kind: "failure";
      readonly generation: number;
      readonly error: string;
      readonly indeterminate: boolean;
    }
  | {
      readonly kind: "steered";
      readonly generation: number;
      readonly delivery: Delivery;
      readonly result: "steered" | "refused" | "indeterminate";
      readonly error?: string;
    }
  | { readonly kind: "gated"; readonly generation: number; readonly result: SessionReplyResult }
  | { readonly kind: "gate-failed"; readonly generation: number; readonly error: string }
  | { readonly kind: "stopped"; readonly generation: number }
  | { readonly kind: "closed" };
interface Runtime {
  readonly id: TaskId;
  readonly scope: Scope.CloseableScope;
  readonly queue: Queue.Queue<Mail>;
  generation?: number;
  live?: LiveSession;
  openingScope?: Scope.CloseableScope;
  job?: Fiber.RuntimeFiber<void, never>;
  gateJob?: Fiber.RuntimeFiber<void, never>;
  closing: boolean;
  stopGeneration?: number;
  readonly retiredTurns: Set<string>;
}

export const SessionManagerLive = (options: SessionManagerOptions = {}) =>
  Layer.scoped(
    SessionManager,
    Effect.gen(function* () {
      const store = yield* Store;
      const config = yield* ConfigStore;
      const logs = yield* DecisionLog;
      const bus = yield* EventBus;
      const resolver = yield* HarnessResolver;
      const setup = yield* SessionSetup;
      const handoff = yield* HandoffBuilder;
      const gate = yield* SessionReplyGate;
      const requestRouter = yield* SessionRequestRouter;
      const managerScope = yield* Effect.scope;
      const mapLock = yield* Effect.makeSemaphore(1);
      const runtimes = new Map<TaskId, Runtime>();
      const windowMs = options.coalesceWindowMs ?? 120_000;
      const maxItems = options.maxBatchItems ?? 30;
      // A previous process may have sent the RPC before it lost the confirmation.
      yield* store.transaction((tx) =>
        Effect.gen(function* () {
          for (const request of yield* tx.list("session_requests", {
            limit: Number.MAX_SAFE_INTEGER,
          })) {
            if (request.answerClaim?.phase === "submitting") {
              const at = yield* Clock.currentTimeMillis;
              yield* tx.set("session_requests", {
                ...request,
                answerClaim: {
                  ...request.answerClaim,
                  phase: "indeterminate",
                  updatedAt: at,
                },
              });
              const log = yield* tx.get("decision_logs", request.answerClaim.decisionLogId);
              if (Option.isSome(log))
                yield* tx.set("decision_logs", {
                  ...log.value,
                  execution: {
                    ...log.value.execution,
                    ok: false,
                    error: "Answer delivery is indeterminate after daemon restart",
                  },
                });
              yield* answerNotice(
                tx,
                request,
                "答案投递结果未知，请检查任务状态，勿重复提交。",
                at,
              );
            }
          }
        }),
      );
      if (
        !Number.isSafeInteger(windowMs) ||
        windowMs < 0 ||
        !Number.isSafeInteger(maxItems) ||
        maxItems < 1
      )
        return yield* Effect.fail(fault("Configuration", "Invalid delivery coalescing limits"));

      const botFor = (task: Task) =>
        config.readBots.pipe(
          Effect.flatMap((bots) => {
            const bot = bots.find((entry) => entry.id === task.botId);
            return bot
              ? Effect.succeed(bot)
              : Effect.fail(fault("Configuration", `Task bot is unavailable: ${task.botId}`));
          }),
        );
      const updateLogs = (ids: readonly string[], result: ExecutionResult) =>
        Effect.forEach(
          [...new Set(ids)],
          (id) =>
            Effect.gen(function* () {
              const previous = yield* logs.get(id);
              if (Option.isNone(previous))
                return yield* Effect.fail(
                  fault("NotFound", `Missing delivery decision log: ${id}`),
                );
              const before = previous.value.execution;
              const degraded = [
                ...new Set([...(before.degraded ?? []), ...(result.degraded ?? [])]),
              ];
              yield* logs.complete(id, {
                ok: before.ok && result.ok,
                ...(before.error || result.error ? { error: result.error ?? before.error } : {}),
                ...(degraded.length ? { degraded } : {}),
              });
            }),
          { discard: true },
        );
      const deliveryLogs = (deliveries: readonly Delivery[]) =>
        deliveries.map((entry) => entry.decisionLogId);
      const offer = (runtime: Runtime, mail: Mail) =>
        Queue.offer(runtime.queue, mail).pipe(Effect.asVoid);
      const job = (
        runtime: Runtime,
        work: Effect.Effect<void, CoreError | AdapterError, Scope.Scope>,
        generation: number,
      ) =>
        work.pipe(
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.void
              : offer(runtime, {
                  kind: "failure",
                  generation,
                  error: Cause.pretty(cause),
                  indeterminate: Cause.failureOption(cause).pipe(
                    Option.match({
                      onNone: () => true,
                      onSome: (error) => "code" in error && error.code === "DeliveryIndeterminate",
                    }),
                  ),
                }),
          ),
          Effect.provideService(Scope.Scope, runtime.scope),
          Effect.forkIn(runtime.scope),
        );

      // Filled by the serial actor below; registration never performs external work.
      const handle = (runtime: Runtime, mail: Mail): Effect.Effect<void, CoreError> =>
        processMail(runtime, mail);
      const runtimeFor = (id: TaskId) =>
        mapLock.withPermits(1)(
          Effect.gen(function* () {
            const existing = runtimes.get(id);
            if (existing) return existing;
            const scope = yield* Scope.fork(managerScope, ExecutionStrategy.sequential);
            const queue = yield* Queue.unbounded<Mail>();
            const runtime: Runtime = { id, scope, queue, closing: false, retiredTurns: new Set() };
            runtimes.set(id, runtime);
            yield* Scope.addFinalizer(scope, Queue.shutdown(queue));
            yield* Effect.forever(
              Queue.take(queue).pipe(
                Effect.flatMap((mail) =>
                  handle(runtime, mail).pipe(
                    Effect.catchAllCause((cause) =>
                      Effect.logError("Session actor operation failed", Cause.pretty(cause)),
                    ),
                  ),
                ),
              ),
            ).pipe(Effect.forkIn(scope));
            return runtime;
          }),
        );
      const activate = (id: TaskId, operationId: string) =>
        Effect.gen(function* () {
          yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const task = yield* requireTask(tx, id);
              const execution = yield* executionFor(tx, task);
              const recovery =
                execution.nextStart?.decisionLogId === operationId
                  ? execution.nextStart
                  : undefined;
              yield* saveTask(tx, task, {
                ...execution,
                pending: execution.pending.map((entry) =>
                  entry.decisionLogId === operationId || recovery?.kind === "resume"
                    ? { ...entry, ready: true }
                    : entry,
                ),
                ...(recovery ? { nextStart: { ...recovery, ready: true } } : {}),
              });
            }),
          );
          yield* offer(yield* runtimeFor(id), { kind: "wake" });
        });

      const register: typeof SessionManager.Service.register = (op, decisionLogId, options) =>
        Effect.gen(function* () {
          const taskId =
            op.op === "new"
              ? dispatchTaskId(decisionLogId)
              : op.op === "new-trigger"
                ? TaskId.make(`trigger:${op.runId}`)
                : op.taskId;
          const at = yield* Clock.currentTimeMillis;
          const execution = yield* store.transaction((tx) =>
            registerOperation(tx, config, op, { taskId, decisionLogId, at, ...options }),
          );
          return { execution, activate: activate(taskId, decisionLogId) };
        });

      const answerTaskError = (task: Task) => {
        switch (task.status) {
          case "failed":
            return "任务已失败，请先重试，再提交答案。";
          case "interrupted":
            return "任务已中断，请先恢复，再提交答案。";
          case "cancelled":
            return "任务已取消，不能继续提交答案。";
          case "archived":
            return "任务已归档，不能继续提交答案。";
          default:
            return undefined;
        }
      };
      const requireRequest = (tx: StoreTransaction, id: RequestId) =>
        tx.get("session_requests", id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(fault("NotFound", `Unknown request: ${id}`)),
              onSome: Effect.succeed,
            }),
          ),
        );
      const answer = (
        op: Extract<Op, { op: "answer" }>,
        decisionLogId: string,
      ): Effect.Effect<RegisteredExecution, CoreError> =>
        Effect.gen(function* () {
          const checked = yield* validate(QuestionAnswer, op.answer);
          const claimId = randomUUID();
          const request = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const request = yield* requireRequest(tx, op.requestId);
              yield* validateQuestionAnswer(request.request, checked);
              const task = yield* requireTask(tx, request.taskId);
              const blocked = answerTaskError(task);
              if (blocked) return yield* Effect.fail(fault("InvalidTransition", blocked));
              if (
                request.state === "answered" ||
                (request.answerClaim && request.answerClaim.phase !== "registered")
              )
                return yield* Effect.fail(
                  fault(
                    "Conflict",
                    request.answerClaim?.phase === "indeterminate"
                      ? "答案投递结果未知，请检查任务状态，勿重复提交。"
                      : "该问题的答案已提交，请勿重复提交。",
                  ),
                );
              yield* tx.set("session_requests", {
                ...request,
                answerClaim: {
                  claimId,
                  answer: checked,
                  decisionLogId,
                  phase: "registered",
                  updatedAt: yield* Clock.currentTimeMillis,
                },
              });
              return request;
            }),
          );
          return {
            execution: { ok: true },
            activate: Effect.gen(function* () {
              const runtime = yield* runtimeFor(request.taskId);
              yield* offer(runtime, { kind: "answer", requestId: request.id, claimId });
            }),
          };
        });

      function answerNotice(
        tx: StoreTransaction,
        request: StoredRequest,
        text: string,
        at: number,
      ) {
        return tx.set("main_thread_messages", {
          id: MessageId.make(`answer-notice:${request.answerClaim?.claimId ?? request.id}`),
          at,
          author: "chief",
          kind: "notice",
          taskId: request.taskId,
          text,
        });
      }

      function finishAnswer(
        runtime: Runtime,
        mail: Extract<Mail, { kind: "answered" }>,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const result = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const request = yield* requireRequest(tx, mail.requestId);
              const claim = request.answerClaim;
              if (
                !claim ||
                claim.claimId !== mail.claimId ||
                ["queued", "indeterminate"].includes(claim.phase)
              )
                return undefined;
              let task = yield* requireTask(tx, request.taskId);
              const execution = yield* executionFor(tx, task);
              const at = yield* Clock.currentTimeMillis;
              if (
                request.state === "answered" ||
                claim.phase === "delivered" ||
                mail.result === "delivered"
              ) {
                yield* tx.set("session_requests", {
                  ...request,
                  state: "answered",
                  closedAt: at,
                  answerClaim: { ...claim, phase: "delivered", updatedAt: at },
                });
                yield* markQuestionCards(tx, request.id, "answered");
                if (task.pendingRequestIds.includes(request.id)) {
                  task = yield* transitionTask(
                    task,
                    { type: "request.answered", requestId: request.id },
                    at,
                  );
                  yield* saveTask(tx, task, execution);
                }
                return { id: claim.decisionLogId, ok: true };
              }
              if (mail.result === "indeterminate") {
                yield* tx.set("session_requests", {
                  ...request,
                  answerClaim: { ...claim, phase: "indeterminate", updatedAt: at },
                });
                yield* answerNotice(
                  tx,
                  request,
                  "答案投递结果未知，请检查任务状态，勿重复提交。",
                  at,
                );
                return {
                  id: claim.decisionLogId,
                  ok: false,
                  error: mail.error ?? "Answer delivery is indeterminate",
                };
              }
              const blocked = answerTaskError(task);
              if (mail.result === "invalid" || blocked) {
                const { answerClaim: _, ...unclaimed } = request;
                yield* tx.set("session_requests", unclaimed);
                yield* answerNotice(
                  tx,
                  request,
                  blocked ?? "答案不符合原问题要求，请检查后重新提交。",
                  at,
                );
                return {
                  id: claim.decisionLogId,
                  ok: false,
                  error: blocked ?? mail.error ?? "Invalid answer",
                };
              }
              // Definitively undelivered: message, queue and tombstone commit together.
              const messageId = MessageId.make(`answer:${request.id}`);
              const text = request.request.questions
                .map((question) => {
                  const value = claim.answer.perQuestion.find(
                    (entry) => entry.questionId === question.id,
                  );
                  const values =
                    value?.optionIds?.map(
                      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
                    ) ?? [];
                  return `${question.text}\n${[...values, ...(value?.text ? [value.text] : [])].join("\n")}`;
                })
                .join("\n\n");
              yield* tx.set("main_thread_messages", {
                id: messageId,
                at,
                author: "user",
                kind: "text",
                text,
                taskId: task.id,
              });
              const operationId = `late-answer:${request.id}`;
              if (!execution.seenOperations.includes(operationId))
                yield* saveTask(tx, task, {
                  ...execution,
                  seenOperations: [...execution.seenOperations, operationId],
                  pending: [
                    ...execution.pending,
                    {
                      id: operationId,
                      messageIds: [messageId],
                      queuedAt: at,
                      decisionLogId: claim.decisionLogId,
                      directive: "queue",
                      ready: true,
                    },
                  ],
                });
              yield* tx.set("session_requests", {
                ...request,
                state: request.state === "open" ? "expired" : request.state,
                closedAt: request.closedAt ?? at,
                answerClaim: { ...claim, phase: "queued", updatedAt: at },
              });
              if (task.pendingRequestIds.includes(request.id)) {
                const updated = yield* requireTask(tx, task.id);
                yield* saveTask(
                  tx,
                  yield* transitionTask(
                    updated,
                    { type: "request.answered", requestId: request.id },
                    at,
                  ),
                  yield* executionFor(tx, updated),
                );
              }
              yield* markQuestionCards(tx, request.id, "answered");
              return {
                id: claim.decisionLogId,
                ok: true,
                degraded: ["expired answer -> same-task send"],
              };
            }),
          );
          if (result)
            yield* updateLogs([result.id], {
              ok: result.ok,
              ...("error" in result && result.error ? { error: result.error } : {}),
              ...("degraded" in result && result.degraded ? { degraded: result.degraded } : {}),
            });
          yield* wake(runtime);
        });
      }

      function beginAnswer(
        runtime: Runtime,
        requestId: RequestId,
        claimId: string,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const live = runtime.live;
          const request = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const request = yield* requireRequest(tx, requestId);
              if (
                request.answerClaim?.claimId !== claimId ||
                request.answerClaim.phase !== "registered"
              )
                return undefined;
              const task = yield* requireTask(tx, request.taskId);
              const execution = yield* executionFor(tx, task);
              const callable =
                request.state === "open" &&
                live &&
                !runtime.closing &&
                !answerTaskError(task) &&
                task.pendingRequestIds.includes(requestId) &&
                execution.active?.generation === runtime.generation &&
                execution.active?.phase === "running" &&
                !execution.active.restart;
              if (callable)
                yield* tx.set("session_requests", {
                  ...request,
                  answerClaim: {
                    ...request.answerClaim,
                    phase: "submitting",
                    updatedAt: yield* Clock.currentTimeMillis,
                  },
                });
              return { request, callable };
            }),
          );
          if (!request?.request.answerClaim) return;
          if (!request.callable || !live)
            return yield* finishAnswer(runtime, {
              kind: "answered",
              requestId,
              claimId,
              result: "expired",
            });
          const suppliedAnswer = request.request.answerClaim.answer;
          yield* store
            .transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* requireRequest(tx, requestId);
                const task = yield* requireTask(tx, runtime.id);
                const execution = yield* executionFor(tx, task);
                return (
                  current.state === "open" &&
                  current.answerClaim?.claimId === claimId &&
                  current.answerClaim.phase === "submitting" &&
                  !answerTaskError(task) &&
                  task.pendingRequestIds.includes(requestId) &&
                  execution.active?.generation === runtime.generation &&
                  execution.active?.phase === "running" &&
                  !execution.active.restart &&
                  runtime.live?.token === live.token &&
                  !runtime.closing
                );
              }),
            )
            .pipe(
              Effect.flatMap((owned) =>
                owned
                  ? live.handle.respond(requestId, suppliedAnswer)
                  : Effect.fail(
                      new AdapterError({
                        code: "RequestExpired",
                        message: "Answer ownership expired before delivery",
                      }),
                    ),
              ),
              Effect.matchCauseEffect({
                onSuccess: () =>
                  offer(runtime, { kind: "answered", requestId, claimId, result: "delivered" }),
                onFailure: (cause) =>
                  offer(runtime, {
                    kind: "answered",
                    requestId,
                    claimId,
                    result: Option.match(Cause.failureOption(cause), {
                      onNone: () => "indeterminate" as const,
                      onSome: (error) =>
                        error.code === "RequestExpired"
                          ? ("expired" as const)
                          : error.code === "InvalidAnswer"
                            ? ("invalid" as const)
                            : ("indeterminate" as const),
                    }),
                    error: Cause.pretty(cause),
                  }),
              }),
              Effect.forkIn(runtime.scope),
            );
        });
      }

      function closeRuntime(runtime: Runtime): Effect.Effect<void> {
        return Effect.gen(function* () {
          if (runtime.closing) return;
          runtime.closing = true;
          const running = runtime.job;
          const gating = runtime.gateJob;
          const live = runtime.live;
          const opening = runtime.openingScope;
          yield* Effect.gen(function* () {
            if (running) yield* Fiber.interrupt(running);
            if (gating) yield* Fiber.interrupt(gating);
            if (live) {
              yield* live.handle.interrupt().pipe(Effect.catchAll(() => Effect.void));
              yield* Scope.close(live.scope, Exit.void);
            }
            if (opening && opening !== live?.scope) yield* Scope.close(opening, Exit.void);
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError("Failed to release session resources", Cause.pretty(cause)),
            ),
            Effect.ensuring(offer(runtime, { kind: "closed" })),
            Effect.forkIn(runtime.scope),
          );
        });
      }

      function prepare(runtime: Runtime, task: Task, attempt: Attempt): Effect.Effect<void> {
        return Effect.gen(function* () {
          runtime.generation = attempt.generation;
          const existing = runtime.live;
          const scope =
            existing?.scope ?? (yield* Scope.fork(runtime.scope, ExecutionStrategy.sequential));
          if (!existing) runtime.openingScope = scope;
          runtime.job = yield* job(
            runtime,
            Effect.gen(function* () {
              const bot = yield* botFor(task);
              let live = existing;
              if (!live) {
                const adapter = yield* resolver.resolve(task.session.instanceId);
                const input = yield* setup.prepare(task, bot).pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.flatMap((value) => validate(StartSessionInput, value)),
                );
                if (
                  input.taskId !== task.id ||
                  input.bot.id !== task.botId ||
                  input.bot.modelSelection.instanceId !== task.session.instanceId
                )
                  return yield* Effect.fail(
                    fault(
                      "ImmutableField",
                      "Session setup changed its task, bot or harness binding",
                    ),
                  );
                if (task.session.cursor && !adapter.capabilities.resume)
                  return yield* Effect.fail(
                    fault("Configuration", "The adapter cannot resume this task"),
                  );
                const handle = yield* (
                  task.session.cursor
                    ? adapter.resumeSession(task.session.cursor, input)
                    : adapter.startSession(input)
                ).pipe(Effect.provideService(Scope.Scope, scope));
                const token = randomUUID();
                live = { handle, adapter, input, scope, token };
                yield* Stream.runForEach(handle.events, (event) =>
                  offer(runtime, { kind: "event", token, event }),
                ).pipe(Effect.forkIn(scope));
                yield* Effect.yieldNow();
              }
              const ids = attempt.deliveries.flatMap((entry) => entry.messageIds);
              const messages = yield* store.transaction((tx) =>
                messagesInOrder(tx, ids).pipe(
                  Effect.filterOrFail(
                    (messages) => messages.length === ids.length,
                    () => fault("NotFound", "Queued request messages are missing"),
                  ),
                ),
              );
              const input =
                attempt.input ??
                (yield* handoff.build({
                  task,
                  bot,
                  messages,
                  mode: attempt.mode === "new" ? "new" : "send",
                }));
              yield* validate(TurnInput, input);
              yield* offer(runtime, {
                kind: "prepared",
                generation: attempt.generation,
                live,
                input,
              });
            }),
            attempt.generation,
          );
        });
      }

      function wake(runtime: Runtime): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          if (runtime.closing) return;
          const current = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const task = yield* requireTask(tx, runtime.id);
              return { task, execution: yield* executionFor(tx, task) };
            }),
          );
          const { task, execution } = current;
          if (task.status === "cancelled" || task.status === "archived")
            return yield* closeRuntime(runtime);
          if (execution.active) {
            const active = execution.active;
            // Persisted ownership left by another daemon is never an automatic replay instruction.
            if (runtime.generation !== active.generation) return;
            if (active.restart && runtime.stopGeneration !== active.generation) {
              runtime.stopGeneration = active.generation;
              const previousJob = runtime.job;
              runtime.job = yield* job(
                runtime,
                Effect.gen(function* () {
                  if (["preparing", "starting"].includes(active.phase) && previousJob)
                    yield* Fiber.interrupt(previousJob);
                  if (runtime.live) yield* runtime.live.handle.interrupt();
                  else {
                    if (previousJob) yield* Fiber.interrupt(previousJob);
                    if (runtime.openingScope) yield* Scope.close(runtime.openingScope, Exit.void);
                  }
                  yield* offer(runtime, { kind: "stopped", generation: active.generation });
                }),
                active.generation,
              );
              return;
            }
            if (
              active.phase === "running" &&
              !active.restart &&
              !execution.steering &&
              runtime.live
            ) {
              const delivery = execution.pending.find(
                (entry) => entry.ready && entry.directive === "steer",
              );
              if (delivery) yield* beginSteer(runtime, active, delivery);
            }
            return;
          }
          if (runtime.stopGeneration !== undefined) return;
          if (execution.steering) return;
          const claimed = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              let task = yield* requireTask(tx, runtime.id);
              let execution = yield* executionFor(tx, task);
              if (execution.active || execution.steering) return undefined;
              const control = execution.nextStart;
              if (control && !control.ready) return undefined;
              if (!control && !["created", "idle"].includes(task.status)) return undefined;
              const deliveries =
                control?.kind === "retry"
                  ? (execution.lastAttempt?.deliveries ?? [])
                  : coalesce(execution.pending, windowMs, maxItems);
              if (deliveries.length === 0 && control?.kind !== "resume") return undefined;
              const mode: Attempt["mode"] =
                control?.kind ?? (task.status === "created" ? "new" : "send");
              const input =
                mode === "retry"
                  ? execution.lastAttempt?.input
                  : mode === "resume" && deliveries.length === 0
                    ? continueInput
                    : undefined;
              const active: Attempt = {
                generation: execution.generation + 1,
                deliveries,
                mode,
                decisionLogIds: [
                  ...new Set([
                    ...deliveryLogs(deliveries),
                    ...(control ? [control.decisionLogId] : []),
                  ]),
                ],
                phase: "preparing",
                restart: false,
                ...(input ? { input } : {}),
              };
              task = yield* transitionTask(
                task,
                { type: control?.kind ?? "turn.started" },
                yield* Clock.currentTimeMillis,
              );
              const selected = new Set(deliveries.map((entry) => entry.id));
              execution = {
                ...noNext(execution),
                generation: active.generation,
                active,
                pending: execution.pending.filter((entry) => !selected.has(entry.id)),
              };
              task = yield* saveTask(tx, task, execution);
              return { task, active };
            }),
          );
          if (claimed) yield* prepare(runtime, claimed.task, claimed.active);
        });
      }

      function beginSteer(
        runtime: Runtime,
        active: Attempt,
        delivery: Delivery,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const live = runtime.live;
          if (!live) return;
          if (!live.adapter.capabilities.steer) {
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                const task = yield* requireTask(tx, runtime.id);
                const execution = yield* executionFor(tx, task);
                yield* saveTask(tx, task, {
                  ...execution,
                  pending: execution.pending.map((entry) =>
                    entry.id === delivery.id ? { ...entry, directive: "queue" } : entry,
                  ),
                });
              }),
            );
            yield* updateLogs(deliveryLogs([delivery]), {
              ok: true,
              degraded: ["steer->queue: unsupported"],
            });
            yield* offer(runtime, { kind: "wake" });
            return;
          }
          const claimed = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const task = yield* requireTask(tx, runtime.id);
              const execution = yield* executionFor(tx, task);
              if (
                !["running", "waiting_user"].includes(task.status) ||
                execution.active?.generation !== active.generation ||
                execution.active.phase !== "running" ||
                execution.active.restart ||
                execution.steering ||
                !execution.pending.some((entry) => entry.id === delivery.id && entry.ready)
              )
                return false;
              yield* saveTask(tx, task, {
                ...execution,
                pending: execution.pending.filter((entry) => entry.id !== delivery.id),
                steering: { generation: active.generation, delivery },
              });
              return true;
            }),
          );
          if (!claimed) return;
          yield* Effect.gen(function* () {
            const task = yield* store.transaction((tx) => requireTask(tx, runtime.id));
            const bot = yield* botFor(task);
            const messages = yield* store.transaction((tx) =>
              messagesInOrder(tx, delivery.messageIds),
            );
            const input = yield* handoff.build({ task, bot, messages, mode: "send" });
            const current = yield* store.transaction((tx) =>
              Effect.gen(function* () {
                const currentTask = yield* requireTask(tx, runtime.id);
                const execution = yield* executionFor(tx, currentTask);
                return (
                  ["running", "waiting_user"].includes(currentTask.status) &&
                  execution.active?.generation === active.generation &&
                  !execution.active.restart
                );
              }),
            );
            if (!current)
              return yield* offer(runtime, {
                kind: "steered",
                generation: active.generation,
                delivery,
                result: "refused",
              });
            const result = yield* live.handle.steer(input);
            yield* offer(runtime, {
              kind: "steered",
              generation: active.generation,
              delivery,
              result,
            });
          }).pipe(
            Effect.catchAllCause((cause) =>
              offer(runtime, {
                kind: "steered",
                generation: active.generation,
                delivery,
                result: "indeterminate",
                error: Cause.pretty(cause),
              }),
            ),
            Effect.forkIn(runtime.scope),
          );
        });
      }

      function failAttempt(
        runtime: Runtime,
        generation: number,
        error: string,
        indeterminate: boolean,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const matched = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              let task = yield* requireTask(tx, runtime.id);
              const execution = yield* executionFor(tx, task);
              const active = execution.active;
              if (
                !active ||
                active.generation !== generation ||
                !["preparing", "starting", "running"].includes(active.phase)
              )
                return undefined;
              if (active.restart && !indeterminate) {
                task = yield* transitionTask(
                  task,
                  { type: "turn.completed", ok: false, stopReason: "interrupted", restart: true },
                  yield* Clock.currentTimeMillis,
                );
              } else
                task = yield* transitionTask(
                  task,
                  { type: "turn.failed" },
                  yield* Clock.currentTimeMillis,
                );
              yield* expireTaskRequests(tx, task.id, yield* Clock.currentTimeMillis, "expired");
              yield* saveTask(tx, task, {
                ...noActive(execution),
                lastAttempt: {
                  ...active,
                  phase: indeterminate ? "indeterminate" : "failed",
                  error,
                },
              });
              return active.decisionLogIds;
            }),
          );
          if (!matched) return;
          if (runtime.generation === generation) delete runtime.generation;
          if (runtime.openingScope) {
            yield* Scope.close(runtime.openingScope, Exit.void);
            delete runtime.openingScope;
          }
          yield* updateLogs(matched, { ok: false, error });
          yield* wake(runtime);
        });
      }

      function processMail(runtime: Runtime, mail: Mail): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          switch (mail.kind) {
            case "answer":
              return yield* beginAnswer(runtime, mail.requestId, mail.claimId);
            case "answered":
              return yield* finishAnswer(runtime, mail);
            case "wake":
              return yield* wake(runtime);
            case "closed":
              delete runtime.live;
              delete runtime.openingScope;
              delete runtime.generation;
              delete runtime.job;
              delete runtime.gateJob;
              delete runtime.stopGeneration;
              runtime.closing = false;
              return;
            case "prepared": {
              const accepted = yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const task = yield* requireTask(tx, runtime.id);
                  const execution = yield* executionFor(tx, task);
                  if (execution.active?.generation !== mail.generation || execution.active.restart)
                    return false;
                  yield* saveTask(
                    tx,
                    { ...task, session: { ...task.session, cursor: mail.live.handle.cursor } },
                    {
                      ...execution,
                      active: { ...execution.active, phase: "starting", input: mail.input },
                    },
                  );
                  return true;
                }),
              );
              if (!accepted) {
                if (mail.live.scope !== runtime.live?.scope)
                  yield* Scope.close(mail.live.scope, Exit.void);
                return yield* wake(runtime);
              }
              runtime.live = mail.live;
              delete runtime.openingScope;
              runtime.job = yield* job(
                runtime,
                mail.live.handle.startTurn(mail.input),
                mail.generation,
              );
              return;
            }
            case "failure":
              return yield* failAttempt(runtime, mail.generation, mail.error, mail.indeterminate);
            case "stopped": {
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const task = yield* requireTask(tx, runtime.id);
                  const execution = yield* executionFor(tx, task);
                  const active = execution.active;
                  if (!active || active.generation !== mail.generation || !active.restart) return;
                  const next = yield* transitionTask(
                    task,
                    { type: "turn.completed", ok: false, stopReason: "interrupted", restart: true },
                    yield* Clock.currentTimeMillis,
                  );
                  yield* expireTaskRequests(tx, task.id, yield* Clock.currentTimeMillis, "expired");
                  yield* saveTask(tx, next, {
                    ...noActive(execution),
                    lastAttempt: { ...active, phase: "interrupted" },
                  });
                }),
              );
              if (runtime.generation === mail.generation) delete runtime.generation;
              if (runtime.stopGeneration === mail.generation) delete runtime.stopGeneration;
              return yield* wake(runtime);
            }
            case "steered": {
              const alive = yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const task = yield* requireTask(tx, runtime.id);
                  const execution = yield* executionFor(tx, task);
                  if (execution.steering?.delivery.id !== mail.delivery.id) return false;
                  let next = noSteering(execution);
                  const usable = !["cancelled", "archived"].includes(task.status);
                  if (mail.result === "refused" && usable)
                    next = {
                      ...next,
                      pending: [
                        ...next.pending,
                        { ...mail.delivery, directive: "queue" as const },
                      ].sort((a, b) => a.queuedAt - b.queuedAt),
                    };
                  if (mail.result === "indeterminate")
                    next = { ...next, uncertain: [...next.uncertain, mail.delivery] };
                  yield* saveTask(tx, task, next);
                  return usable;
                }),
              );
              yield* updateLogs(
                deliveryLogs([mail.delivery]),
                mail.result === "indeterminate"
                  ? {
                      ok: false,
                      error:
                        mail.error ?? "Steer delivery is indeterminate; it will not be resent.",
                    }
                  : {
                      ok: true,
                      ...(mail.result === "refused" && alive
                        ? { degraded: ["steer->queue: refused"] }
                        : {}),
                    },
              );
              return yield* wake(runtime);
            }
            case "gated":
              return yield* acceptGate(runtime, mail.generation, mail.result).pipe(
                Effect.catchAll((error) =>
                  offer(runtime, {
                    kind: "gate-failed",
                    generation: mail.generation,
                    error: error.message,
                  }),
                ),
              );
            case "gate-failed": {
              const ids = yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const task = yield* requireTask(tx, runtime.id);
                  const execution = yield* executionFor(tx, task);
                  if (
                    execution.active?.generation !== mail.generation ||
                    task.status !== "reporting"
                  )
                    return [];
                  yield* saveTask(tx, task, {
                    ...execution,
                    active: { ...execution.active, error: mail.error },
                  });
                  return execution.active.decisionLogIds;
                }),
              );
              yield* updateLogs(ids, { ok: false, error: mail.error });
              return;
            }
            case "event":
              return yield* receiveEvent(runtime, mail.token, mail.event);
          }
        });
      }

      function acceptGate(
        runtime: Runtime,
        generation: number,
        result: SessionReplyResult,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const accepted = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const task = yield* requireTask(tx, runtime.id);
              const execution = yield* executionFor(tx, task);
              const active = execution.active;
              if (
                !active ||
                active.generation !== generation ||
                active.phase !== "reporting" ||
                task.status !== "reporting"
              )
                return undefined;
              if (!active.reportEventId)
                return yield* Effect.fail(
                  fault("InvalidRequest", "Report ownership has no immutable event reference"),
                );
              const report = yield* tx.get("events", active.reportEventId);
              if (
                Option.isNone(report) ||
                report.value.event.source !== "session" ||
                report.value.event.event.kind !== "turn.completed" ||
                !report.value.event.event.ok
              )
                return yield* Effect.fail(
                  fault("NotFound", "The original report event is unavailable"),
                );
              const at = yield* Clock.currentTimeMillis;
              const next = yield* transitionTask(task, { type: "gate.done" }, at);
              yield* tx.insert("main_thread_messages", {
                id: MessageId.make(`reply:${task.id}:${generation}`),
                at,
                author: { botId: task.botId, taskId: task.id },
                kind: "reply",
                text: result.delivered,
                taskId: task.id,
                fullReportRef: `event:${active.reportEventId}`,
                sources: reportSources(report.value.event.event.finalReport),
                ...(result.files ? { files: result.files } : {}),
                ...(result.fileIssues ? { fileIssues: result.fileIssues } : {}),
              });
              yield* saveTask(
                tx,
                {
                  ...next,
                  lastReport: {
                    full: report.value.event.event.finalReport,
                    delivered: result.delivered,
                    rewrites: result.rewrites,
                  },
                },
                { ...noActive(execution), lastAttempt: { ...active, phase: "completed" } },
              );
              return { ids: active.decisionLogIds };
            }),
          );
          if (!accepted) return;
          if (runtime.generation === generation) delete runtime.generation;
          delete runtime.gateJob;
          yield* updateLogs(accepted.ids, { ok: true });
          yield* wake(runtime);
        });
      }

      function receiveEvent(
        runtime: Runtime,
        token: string,
        event: SessionEvent,
      ): Effect.Effect<void, CoreError> {
        return Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const eventId = `session:${runtime.id}:${randomUUID()}`;
          const outer = { source: "session" as const, taskId: runtime.id, kind: event.kind, event };
          const effect = yield* store.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert("events", { id: eventId, at, event: outer });
              let task = yield* requireTask(tx, runtime.id);
              let execution = yield* executionFor(tx, task);
              const active = execution.active;
              const live = runtime.live?.token === token;
              const owned =
                live &&
                active &&
                active.generation === runtime.generation &&
                !["cancelled", "archived"].includes(task.status);
              const sameTurn = owned && "turnId" in event && event.turnId === active.turnId;
              if (
                event.kind === "cursor.updated" &&
                live &&
                !["cancelled", "archived"].includes(task.status)
              ) {
                yield* saveTask(
                  tx,
                  { ...task, session: { ...task.session, cursor: event.cursor } },
                  execution,
                );
              }
              if (!owned || !active) return { kind: "none" as const };
              switch (event.kind) {
                case "turn.started": {
                  if (
                    runtime.retiredTurns.has(event.turnId) ||
                    (active.turnId && active.turnId !== event.turnId)
                  )
                    break;
                  execution = {
                    ...execution,
                    active: { ...active, turnId: event.turnId, phase: "running" },
                  };
                  yield* saveTask(tx, { ...task, lastActivityAt: at, updatedAt: at }, execution);
                  return { kind: "wake" as const };
                }
                case "message.delta":
                case "session.changed":
                  if (sameTurn)
                    yield* saveTask(tx, { ...task, lastActivityAt: at, updatedAt: at }, execution);
                  break;
                case "request.opened": {
                  if (
                    event.request.taskId !== task.id ||
                    !["starting", "running"].includes(active.phase)
                  )
                    break;
                  if (Option.isSome(yield* tx.get("session_requests", event.request.id))) break;
                  yield* tx.insert("session_requests", {
                    id: event.request.id,
                    taskId: task.id,
                    request: event.request,
                    state: "open",
                  });
                  if (event.request.kind === "question")
                    task = yield* transitionTask(
                      task,
                      { type: "request.opened", requestId: event.request.id },
                      at,
                    );
                  yield* saveTask(tx, task, execution);
                  return { kind: "request" as const, request: event.request };
                }
                case "request.closed": {
                  const previous = yield* tx.get("session_requests", event.requestId);
                  if (
                    Option.isNone(previous) ||
                    previous.value.taskId !== task.id ||
                    previous.value.state !== "open"
                  )
                    break;
                  yield* tx.set("session_requests", {
                    ...previous.value,
                    ...(event.reason === "answered" && previous.value.answerClaim
                      ? {
                          answerClaim: {
                            ...previous.value.answerClaim,
                            phase: "delivered" as const,
                            updatedAt: at,
                          },
                        }
                      : {}),
                    state:
                      event.reason === "answered"
                        ? "answered"
                        : event.reason === "cancelled"
                          ? "cancelled"
                          : "expired",
                    closedAt: at,
                  });
                  if (task.pendingRequestIds.includes(event.requestId))
                    task = yield* transitionTask(
                      task,
                      { type: "request.answered", requestId: event.requestId },
                      at,
                    );
                  yield* markQuestionCards(
                    tx,
                    event.requestId,
                    event.reason === "answered" ? "answered" : "expired",
                  );
                  yield* saveTask(tx, task, execution);
                  break;
                }
                case "turn.completed": {
                  if (!sameTurn || active.phase === "reporting") break;
                  yield* expireTaskRequests(tx, task.id, at, "expired");
                  if (active.restart || !event.ok) {
                    task = yield* transitionTask(
                      task,
                      {
                        type: "turn.completed",
                        ok: false,
                        stopReason: "interrupted",
                        restart: active.restart,
                      },
                      at,
                    );
                    yield* saveTask(tx, task, {
                      ...noActive(execution),
                      lastAttempt: { ...active, phase: "interrupted" },
                    });
                    return {
                      kind: "settled" as const,
                      turnId: event.turnId,
                      generation: active.generation,
                      logIds: active.decisionLogIds,
                      ...(active.restart ? {} : { error: "The turn was interrupted." }),
                    };
                  }
                  task = yield* transitionTask(task, { type: "turn.completed", ok: true }, at);
                  task = yield* saveTask(
                    tx,
                    {
                      ...task,
                      lastReport: { full: event.finalReport, delivered: "", rewrites: 0 },
                    },
                    {
                      ...execution,
                      active: { ...active, phase: "reporting", reportEventId: eventId },
                    },
                  );
                  return {
                    kind: "gate" as const,
                    task,
                    generation: active.generation,
                    report: event.finalReport,
                    reportEventId: eventId,
                  };
                }
                case "turn.failed": {
                  if (!sameTurn || active.phase === "reporting") break;
                  task = yield* transitionTask(
                    task,
                    active.restart
                      ? {
                          type: "turn.completed",
                          ok: false,
                          stopReason: "interrupted",
                          restart: true,
                        }
                      : { type: "turn.failed" },
                    at,
                  );
                  yield* expireTaskRequests(tx, task.id, at, "expired");
                  yield* saveTask(tx, task, {
                    ...noActive(execution),
                    lastAttempt: { ...active, phase: "failed", error: event.error },
                  });
                  return {
                    kind: "settled" as const,
                    turnId: event.turnId,
                    generation: active.generation,
                    logIds: active.decisionLogIds,
                    ...(active.restart ? {} : { error: event.error }),
                  };
                }
                case "process.exited": {
                  if (!["preparing", "starting", "running"].includes(active.phase)) break;
                  task = yield* transitionTask(
                    task,
                    active.restart
                      ? {
                          type: "turn.completed",
                          ok: false,
                          stopReason: "interrupted",
                          restart: true,
                        }
                      : { type: "turn.failed" },
                    at,
                  );
                  yield* expireTaskRequests(tx, task.id, at, "expired");
                  yield* saveTask(tx, task, {
                    ...noActive(execution),
                    lastAttempt: { ...active, phase: "failed", error: "Harness process exited" },
                  });
                  return {
                    kind: "settled" as const,
                    ...(active.turnId ? { turnId: active.turnId } : {}),
                    generation: active.generation,
                    logIds: active.decisionLogIds,
                    ...(active.restart ? {} : { error: "Harness process exited" }),
                  };
                }
                case "cursor.updated":
                  break;
              }
              return { kind: "none" as const };
            }),
          );
          yield* bus.publish(outer);
          if (event.kind === "process.exited" && runtime.live?.token === token) {
            const old = runtime.live;
            delete runtime.live;
            yield* Scope.close(old.scope, Exit.void);
          }
          if (effect.kind === "request") yield* requestRouter.opened(effect.request, eventId);
          else if (effect.kind === "wake") yield* wake(runtime);
          else if (effect.kind === "settled") {
            if (effect.turnId) runtime.retiredTurns.add(effect.turnId);
            if (runtime.generation === effect.generation) delete runtime.generation;
            if (effect.error) yield* updateLogs(effect.logIds, { ok: false, error: effect.error });
            yield* wake(runtime);
          } else if (effect.kind === "gate") {
            if (event.kind === "turn.completed") runtime.retiredTurns.add(event.turnId);
            const live = runtime.live;
            if (!live)
              return yield* offer(runtime, {
                kind: "gate-failed",
                generation: effect.generation,
                error: "The session is unavailable for reply checking",
              });
            runtime.gateJob = yield* Effect.scoped(
              gate.check({
                task: effect.task,
                report: effect.report,
                reportEventId: effect.reportEventId,
                session: live.handle,
                adapter: live.adapter,
                sessionInput: live.input,
              }),
            ).pipe(
              Effect.flatMap((result) =>
                offer(runtime, { kind: "gated", generation: effect.generation, result }),
              ),
              Effect.catchAllCause((cause) =>
                offer(runtime, {
                  kind: "gate-failed",
                  generation: effect.generation,
                  error: Cause.pretty(cause),
                }),
              ),
              Effect.forkIn(runtime.scope),
            );
          }
        });
      }

      const snapshot = (taskId: TaskId) =>
        Effect.gen(function* () {
          const task = yield* store.transaction((tx) => requireTask(tx, taskId));
          return yield* mapLock.withPermits(1)(
            Effect.sync((): SessionSnapshot => {
              const runtime = runtimes.get(taskId);
              const live =
                runtime?.closing || ["cancelled", "archived"].includes(task.status)
                  ? undefined
                  : runtime?.live;
              return {
                task,
                ...(live
                  ? {
                      live: {
                        adapter: live.adapter,
                        input: live.input,
                        session: {
                          cursor: live.handle.cursor,
                          fork: () => live.handle.fork(),
                          transcript: () => live.handle.transcript(),
                          ...(live.handle.readSession
                            ? { readSession: live.handle.readSession.bind(live.handle) }
                            : {}),
                        },
                      },
                    }
                  : {}),
              };
            }),
          );
        });
      return { register, snapshot, answer };
    }),
  );

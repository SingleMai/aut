import { isDeepStrictEqual } from "node:util";
import {
  type BotId,
  NonNegativeInteger,
  RequestId,
  Task,
  type TaskId,
  TaskStatus,
  Timestamp,
} from "@aut/protocol";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { saveCreationReceipt } from "./bot-creation.js";
import { CoreError, validate } from "./errors.js";
import { executionFor } from "./session-manager/execution.js";
import { emptyExecution, type SessionExecution } from "./session-manager/model.js";
import { Store, type StoreTransaction } from "./store.js";

export const TaskTransition = Schema.Union(
  Schema.Struct({
    type: Schema.Literal(
      "turn.started",
      "gate.done",
      "turn.failed",
      "daemon.restart",
      "cancel",
      "retry",
      "resume",
      "archive",
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("request.opened", "request.answered"),
    requestId: RequestId,
  }),
  Schema.Struct({ type: Schema.Literal("turn.completed"), ok: Schema.Literal(true) }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    ok: Schema.Literal(false),
    stopReason: Schema.Literal("interrupted"),
    restart: Schema.Boolean,
  }),
);
export type TaskTransition = typeof TaskTransition.Type;

type Signal =
  | Exclude<TaskTransition["type"], "turn.completed">
  | "turn.completed"
  | "turn.interrupted";
type Guard = "always" | "pending" | "clear" | "restart" | "unexpected";
export interface TransitionRule {
  readonly from: TaskStatus;
  readonly signal: Signal;
  readonly guard: Guard;
  readonly to: TaskStatus;
}

const table: Readonly<Partial<Record<TaskStatus, Readonly<Partial<Record<Signal, TaskStatus>>>>>> =
  {
    created: {
      "turn.started": "running",
      "turn.failed": "failed",
      "daemon.restart": "interrupted",
      cancel: "cancelled",
    },
    running: {
      "request.opened": "waiting_user",
      "turn.completed": "reporting",
      "turn.failed": "failed",
      "daemon.restart": "interrupted",
      cancel: "cancelled",
    },
    waiting_user: {
      "request.opened": "waiting_user",
      "turn.completed": "reporting",
      "turn.failed": "failed",
      "daemon.restart": "interrupted",
      cancel: "cancelled",
    },
    reporting: { "gate.done": "idle", "daemon.restart": "interrupted", cancel: "cancelled" },
    idle: { "turn.started": "running", cancel: "cancelled", archive: "archived" },
    failed: { retry: "running", cancel: "cancelled", archive: "archived" },
    interrupted: { resume: "running", cancel: "cancelled", archive: "archived" },
    cancelled: { archive: "archived" },
  };

export const taskTransitionRules: readonly TransitionRule[] = [
  ...Object.entries(table).flatMap(([from, row]) =>
    Object.entries(row).map(([signal, to]) => ({
      from: from as TaskStatus,
      signal: signal as Signal,
      guard: "always" as const,
      to,
    })),
  ),
  { from: "waiting_user", signal: "request.answered", guard: "pending", to: "waiting_user" },
  { from: "waiting_user", signal: "request.answered", guard: "clear", to: "running" },
  ...(["running", "waiting_user"] as const).flatMap((from): TransitionRule[] => [
    { from, signal: "turn.interrupted", guard: "restart", to: "idle" },
    { from, signal: "turn.interrupted", guard: "unexpected", to: "interrupted" },
  ]),
];

export const resolveTaskTransition = (
  status: TaskStatus,
  event: TaskTransition,
  pendingRemaining: number,
) =>
  Effect.gen(function* () {
    yield* validate(TaskStatus, status);
    yield* validate(TaskTransition, event);
    yield* validate(NonNegativeInteger, pendingRemaining);
    const signal: Signal =
      event.type === "turn.completed" && !event.ok ? "turn.interrupted" : event.type;
    const guards: Readonly<Record<Guard, boolean>> = {
      always: true,
      pending: pendingRemaining > 0,
      clear: pendingRemaining === 0,
      restart: event.type === "turn.completed" && !event.ok && event.restart,
      unexpected: event.type === "turn.completed" && !event.ok && !event.restart,
    };
    const selected = taskTransitionRules.find(
      (rule) => rule.from === status && rule.signal === signal && guards[rule.guard],
    );
    if (!selected)
      return yield* Effect.fail(
        new CoreError({
          code: "InvalidTransition",
          message: `Invalid task transition: ${status} -> ${signal}`,
        }),
      );
    return selected.to;
  });

/** Pure domain transition usable inside a larger Store transaction. */
export const transitionTask = (current: Task, input: TaskTransition, at: number) =>
  Effect.gen(function* () {
    const task = yield* validate(Task, current);
    const event = yield* validate(TaskTransition, input);
    yield* validate(Timestamp, at);
    let pending = [...task.pendingRequestIds];
    if (event.type === "request.opened") {
      if (pending.includes(event.requestId))
        return yield* Effect.fail(
          new CoreError({
            code: "InvalidRequest",
            message: `Request is already pending: ${event.requestId}`,
          }),
        );
      pending.push(event.requestId);
    } else if (event.type === "request.answered") {
      if (!pending.includes(event.requestId))
        return yield* Effect.fail(
          new CoreError({
            code: "InvalidRequest",
            message: `Request is not pending: ${event.requestId}`,
          }),
        );
      pending = pending.filter((id) => id !== event.requestId);
    }
    const status = yield* resolveTaskTransition(task.status, event, pending.length);
    if (["turn.completed", "turn.failed", "daemon.restart", "cancel"].includes(event.type))
      pending = [];
    return yield* validate(Task, {
      ...task,
      status,
      pendingRequestIds: pending,
      updatedAt: at,
      lastActivityAt: at,
    });
  });

export const requireTask = (tx: StoreTransaction, id: TaskId) =>
  tx.get("tasks", id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new CoreError({ code: "NotFound", message: `Unknown task: ${id}` })),
        onSome: Effect.succeed,
      }),
    ),
  );

/** A worker update also projects its pending deliveries into the public task queue. */
export const saveTask = (tx: StoreTransaction, task: Task, execution?: SessionExecution) =>
  Effect.gen(function* () {
    const next = execution
      ? yield* validate(Task, {
          ...task,
          queue: execution.pending.map(({ messageIds, queuedAt }) => ({ messageIds, queuedAt })),
        })
      : task;
    yield* tx.set("tasks", next);
    yield* tx.set("sessions", {
      id: task.id,
      ...next.session,
      execution: execution ?? (yield* executionFor(tx, task)),
    });
    return next;
  });

export interface TaskListOptions {
  readonly status?: readonly TaskStatus[];
  readonly botId?: BotId;
  readonly limit?: number;
}
export const insertTaskWithSession = (tx: StoreTransaction, task: Task) =>
  Effect.gen(function* () {
    yield* tx.insert("tasks", task);
    yield* tx.insert("sessions", { id: task.id, ...task.session, execution: emptyExecution() });
    const creation = yield* tx.get("bot_creations", task.botId);
    if (Option.isSome(creation)) yield* saveCreationReceipt(tx, creation.value, "used");
  });

export class TaskRegistry extends Context.Tag("aut/TaskRegistry")<
  TaskRegistry,
  {
    readonly create: (task: Task) => Effect.Effect<Task, CoreError>;
    readonly get: (id: TaskId) => Effect.Effect<Option.Option<Task>, CoreError>;
    readonly list: (options?: TaskListOptions) => Effect.Effect<readonly Task[], CoreError>;
    readonly transition: (id: TaskId, event: TaskTransition) => Effect.Effect<Task, CoreError>;
    readonly update: (id: TaskId, modify: (task: Task) => Task) => Effect.Effect<Task, CoreError>;
  }
>() {}

export const TaskRegistryLive = Layer.effect(
  TaskRegistry,
  Effect.gen(function* () {
    const store = yield* Store;
    return {
      create: (task) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const value = yield* validate(Task, task);
            if (
              value.status !== "created" ||
              value.pendingRequestIds.length > 0 ||
              value.queue.length > 0
            )
              return yield* Effect.fail(
                new CoreError({
                  code: "InvalidTransition",
                  message: "New tasks must start with empty request and delivery queues",
                }),
              );
            yield* insertTaskWithSession(tx, value);
            return value;
          }),
        ),
      get: (id) => store.transaction((tx) => tx.get("tasks", id)),
      list: (options = {}) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const limit = options.limit ?? 50;
            if (!Number.isSafeInteger(limit) || limit <= 0)
              return yield* Effect.fail(
                new CoreError({
                  code: "Validation",
                  message: "Task limit must be a positive safe integer",
                }),
              );
            const tasks = yield* tx.list("tasks", { limit: Number.MAX_SAFE_INTEGER });
            return tasks
              .filter(
                (task) =>
                  (!options.status || options.status.includes(task.status)) &&
                  (!options.botId || task.botId === options.botId),
              )
              .slice(-limit);
          }),
        ),
      transition: (id, event) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireTask(tx, id);
            const task = yield* transitionTask(current, event, yield* Clock.currentTimeMillis);
            return yield* saveTask(tx, task);
          }),
        ),
      update: (id, modify) =>
        store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* requireTask(tx, id);
            const { kind, decisionLogId } = current.origin;
            const next = yield* Effect.try({
              try: () => modify(current),
              catch: (cause) =>
                new CoreError({
                  code: "Validation",
                  message: "Task update failed",
                  detail: String(cause),
                }),
            });
            const task = yield* validate(Task, next);
            if (
              task.id !== current.id ||
              task.botId !== current.botId ||
              task.createdAt !== current.createdAt ||
              task.origin.kind !== kind ||
              task.origin.decisionLogId !== decisionLogId ||
              task.session.instanceId !== current.session.instanceId ||
              task.status !== current.status ||
              !isDeepStrictEqual(task.queue, current.queue) ||
              task.pendingRequestIds.length !== current.pendingRequestIds.length ||
              task.pendingRequestIds.some((id, index) => id !== current.pendingRequestIds[index])
            )
              return yield* Effect.fail(
                new CoreError({
                  code: "ImmutableField",
                  message:
                    "Task identity, origin, status, delivery queue and pending requests cannot be changed by update",
                }),
              );
            return yield* saveTask(tx, { ...task, updatedAt: yield* Clock.currentTimeMillis });
          }),
        ),
    };
  }),
);

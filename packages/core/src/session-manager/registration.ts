// Delivery registration adapted from OpenMausBot server/steer-queue.ts and runtime/runtime.ts
// at 738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0). See NOTICE.

import type { BotConfig, Op, Task, TaskId } from "@aut/protocol";
import { Effect, Option } from "effect";
import type { ExecutionResult } from "../chief/ports.js";
import type { ConfigStore } from "../config-store.js";
import { recordDispatchCorrection } from "../dispatch-correction.js";
import { CoreError } from "../errors.js";
import { messagesInOrder } from "../main-thread.js";
import { expireTaskRequests } from "../request-cards.js";
import type { StoreTransaction } from "../store.js";
import { insertTaskWithSession, requireTask, saveTask, transitionTask } from "../task-registry.js";
import { executionFor, noActive, noNext, noSteering } from "./execution.js";
import type { Delivery, SessionExecution } from "./model.js";

export type SessionOp = Extract<Op, { readonly op: "new" | "send" | "control" }>;
interface Registration {
  readonly taskId: TaskId;
  readonly decisionLogId: string;
  readonly at: number;
  readonly origin?: Task["origin"];
  readonly corrects?: string;
}
const fail = (code: CoreError["code"], message: string) =>
  Effect.fail(new CoreError({ code, message }));

const registrationTarget = (
  tx: StoreTransaction,
  config: typeof ConfigStore.Service,
  op: SessionOp,
  { taskId, at, decisionLogId, origin }: Registration,
): Effect.Effect<{ task: Task; bot?: BotConfig; created: boolean }, CoreError> =>
  Effect.gen(function* () {
    if (op.op !== "new") return { task: yield* requireTask(tx, taskId), created: false };
    // This read and the first task insert share the transaction that orders use against bot removal.
    const bot = (yield* config.readBots).find((entry) => entry.id === op.botId);
    if (!bot) return yield* fail("Configuration", `Unknown bot: ${op.botId}`);
    const existing = yield* tx.get("tasks", taskId);
    if (Option.isSome(existing)) return { task: existing.value, bot, created: false };
    const messages = yield* messagesInOrder(tx, op.requestMessageIds);
    const first = messages[0];
    if (!first || messages.length !== op.requestMessageIds.length)
      return yield* fail("NotFound", "Task request messages are missing");
    const task: Task = {
      id: taskId,
      botId: bot.id,
      title: first.text.slice(0, 120),
      status: "created",
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
      session: { instanceId: bot.modelSelection.instanceId },
      pendingRequestIds: [],
      queue: [],
      origin: origin ?? { kind: "user", decisionLogId },
    };
    yield* insertTaskWithSession(tx, task);
    return { task, bot, created: true };
  });

const registerControl = (
  tx: StoreTransaction,
  task: Task,
  execution: SessionExecution,
  action: Extract<SessionOp, { op: "control" }>["action"],
  { at, decisionLogId }: Registration,
) =>
  Effect.gen(function* () {
    if (action === "cancel" || action === "archive") {
      const next = yield* transitionTask(task, { type: action }, at);
      yield* expireTaskRequests(tx, task.id, at, "cancelled");
      return yield* saveTask(tx, next, {
        ...noNext(noActive(execution)),
        generation: execution.generation + 1,
        pending: [],
        ...(execution.active ? { lastAttempt: { ...execution.active, phase: "cancelled" } } : {}),
      });
    }
    if (
      (action === "retry" && task.status !== "failed") ||
      (action === "resume" && task.status !== "interrupted")
    )
      return yield* fail("InvalidTransition", `Cannot ${action} a ${task.status} task`);
    // An explicit control supersedes an unclaimed recovery, including one saved before a restart.
    const previous = execution.active ?? execution.lastAttempt;
    if (action === "retry" && previous?.phase !== "failed")
      return yield* fail("Conflict", "There is no definitively failed delivery to retry");
    return yield* saveTask(tx, task, {
      ...noSteering(noActive(execution)),
      uncertain: [
        ...execution.uncertain,
        ...(execution.steering ? [execution.steering.delivery] : []),
      ],
      ...(previous ? { lastAttempt: previous } : {}),
      nextStart: { kind: action, decisionLogId, ready: false },
    });
  });

export const registerOperation = (
  tx: StoreTransaction,
  config: typeof ConfigStore.Service,
  op: SessionOp,
  registration: Registration,
): Effect.Effect<ExecutionResult, CoreError> =>
  Effect.gen(function* () {
    const { task, bot, created } = yield* registrationTarget(tx, config, op, registration);
    const prior = yield* executionFor(tx, task);
    const { at, decisionLogId, corrects } = registration;
    if (prior.seenOperations.includes(decisionLogId)) return { ok: true };
    if (corrects) yield* recordDispatchCorrection(tx, corrects, op, bot, registration);
    const execution = { ...prior, seenOperations: [...prior.seenOperations, decisionLogId] };
    if (op.op === "control") {
      yield* registerControl(tx, task, execution, op.action, registration);
      return { ok: true };
    }

    const messageIds = op.op === "new" ? op.requestMessageIds : op.messageIds;
    if (!created) {
      if (!messageIds.length)
        return yield* fail("InvalidRequest", "A delivery requires message references");
      const messages = yield* messagesInOrder(tx, messageIds);
      const missing = messageIds.find((id, index) => id !== messages[index]?.id);
      if (missing) return yield* fail("NotFound", `Unknown message: ${missing}`);
    }
    if (
      op.op === "send" &&
      !["created", "running", "waiting_user", "reporting", "idle"].includes(task.status)
    )
      return yield* fail(
        "InvalidTransition",
        `Cannot send to ${task.status}; use its explicit control action`,
      );
    if (op.op === "send" && op.delivery === "immediate" && task.status !== "idle")
      return yield* fail("InvalidTransition", "Immediate delivery requires an idle task");
    const requested =
      op.op === "send" && (op.delivery === "steer" || op.delivery === "restart")
        ? op.delivery
        : "queue";
    const directive =
      task.status === "running" || task.status === "waiting_user" ? requested : "queue";
    const delivery: Delivery = {
      id: decisionLogId,
      messageIds,
      queuedAt: at,
      decisionLogId,
      directive,
      ready: false,
    };
    yield* saveTask(
      tx,
      { ...task, updatedAt: at },
      {
        ...execution,
        pending: [...execution.pending, delivery],
        ...(directive === "restart" && execution.active
          ? { active: { ...execution.active, restart: true } }
          : {}),
      },
    );
    return requested === directive
      ? { ok: true }
      : { ok: true, degraded: [`${requested}->queue: no active turn`] };
  });

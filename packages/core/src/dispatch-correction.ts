import {
  type BotConfig,
  type DispatchChange,
  type MainThreadMessage,
  type Op,
  type Task,
  TaskId,
  Timestamp,
} from "@aut/protocol";
import { Effect, Option } from "effect";
import { CoreError } from "./errors.js";
import type { StoreTransaction } from "./store.js";

export const dispatchTaskId = (id: string) => TaskId.make(`task:${id}`);
const invalid = (message: string) =>
  Effect.fail(new CoreError({ code: "InvalidRequest", message }));
const canUndo = (status: Task["status"]) => status !== "cancelled" && status !== "archived";
const dispatchFor = (tx: StoreTransaction, message: MainThreadMessage) =>
  Effect.gen(function* () {
    const id = message.decisionLogId;
    if (!id || message.kind !== "ack" || message.author !== "chief" || message.id !== `chief:${id}`)
      return;
    const task = Option.getOrUndefined(yield* tx.get("tasks", dispatchTaskId(id)));
    if (task?.origin.kind !== "user" || task.origin.decisionLogId !== id) return;
    const log = Option.getOrUndefined(yield* tx.get("decision_logs", id));
    const original = log?.output;
    // A worker failure may update execution.ok after Chief acknowledged a successful registration.
    if (
      log?.tree !== "inbound" ||
      !original ||
      !("op" in original) ||
      original.op !== "new" ||
      original.botId !== task.botId
    )
      return;
    return { log, original, task };
  });

const readDispatch = (tx: StoreTransaction, id: string) =>
  Effect.gen(function* () {
    const ack = Option.getOrUndefined(yield* tx.get("main_thread_messages", `chief:${id}`));
    const dispatch = ack && (yield* dispatchFor(tx, ack));
    if (!dispatch || dispatch.log.correction)
      return yield* invalid("The dispatch is unavailable or has already been corrected");
    return dispatch;
  });

export const resolveDispatchChange = (
  tx: StoreTransaction,
  id: string,
  change: DispatchChange,
  bots: readonly BotConfig[],
): Effect.Effect<Op, CoreError> =>
  Effect.gen(function* () {
    const { original, task } = yield* readDispatch(tx, id);
    if (change.kind === "undo") {
      if (!canUndo(task.status))
        return yield* invalid("The original task can no longer be cancelled");
      return { op: "control", taskId: task.id, action: "cancel" } as const;
    }
    if (change.botId === original.botId || !bots.some((bot) => bot.id === change.botId))
      return yield* invalid("Select a different routable bot");
    return { ...original, botId: change.botId };
  });

/** Recheck the original dispatch in the transaction that registers its replacement or cancellation. */
export const recordDispatchCorrection = (
  tx: StoreTransaction,
  id: string,
  op: Op,
  target: BotConfig | undefined,
  registration: { readonly decisionLogId: string; readonly at: number },
) =>
  Effect.gen(function* () {
    const { log, original, task } = yield* readDispatch(tx, id);
    const undo = op.op === "control" && op.action === "cancel" && op.taskId === task.id;
    const reroute =
      op.op === "new" &&
      target?.id === op.botId &&
      target.id !== original.botId &&
      op.requestMessageIds.length === original.requestMessageIds.length &&
      op.requestMessageIds.every(
        (messageId, index) => messageId === original.requestMessageIds[index],
      );
    if (!undo && !reroute) return yield* invalid("Invalid dispatch correction");
    yield* tx.set("decision_logs", {
      ...log,
      correction: {
        kind: undo ? "undo" : "reroute",
        at: Timestamp.make(registration.at),
        decisionLogId: registration.decisionLogId,
      },
    });
  });

// Compute current controls from the same task and decision used to validate a correction.
export const withDispatch = (
  tx: StoreTransaction,
  message: MainThreadMessage,
): Effect.Effect<MainThreadMessage, CoreError> =>
  Effect.gen(function* () {
    const dispatch = yield* dispatchFor(tx, message);
    if (!dispatch) return message;
    const corrected = dispatch.log.correction?.kind;
    return {
      ...message,
      dispatch: {
        botId: dispatch.task.botId,
        canUndo: canUndo(dispatch.task.status),
        status:
          corrected === "undo" || corrected === "reroute"
            ? corrected
            : corrected
              ? "corrected"
              : "open",
      },
    };
  });

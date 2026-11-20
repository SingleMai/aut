import { randomUUID } from "node:crypto";
import {
  botConfigDigest,
  ConfigStore,
  matchesCreatedBot,
  reconcileBotCreation,
  Store,
  type StoredBotCreation,
  type StoreTransaction,
  saveCreationReceipt,
} from "@aut/core";
import { type BotConfig, type BotId, MessageId, type TaskId } from "@aut/protocol";
import { Clock, Effect, Option } from "effect";
import { DaemonError } from "./errors.js";

const readReceipt = (tx: StoreTransaction, id: MessageId) =>
  Effect.gen(function* () {
    const row = Option.getOrUndefined(yield* tx.get("main_thread_messages", id));
    if (!row?.botCreation)
      return yield* Effect.fail(
        new DaemonError({ code: "NotFound", message: "Unknown bot creation receipt" }),
      );
    return { message: row, receipt: row.botCreation };
  });

export const makeBotCreationReceipts = Effect.gen(function* () {
  const store = yield* Store;
  const config = yield* ConfigStore;
  const reconcile = (tx: StoreTransaction, id: BotId, bot: BotConfig | undefined) =>
    Effect.gen(function* () {
      const record = yield* tx.get("bot_creations", id);
      if (Option.isSome(record)) yield* reconcileBotCreation(tx, record.value, bot);
    });

  yield* config.withMutation(
    store.transaction((tx) =>
      Effect.gen(function* () {
        const pending = yield* tx.list("bot_creations", { limit: Number.MAX_SAFE_INTEGER });
        if (!pending.length) return;
        const bots = new Map((yield* config.readBots).map((bot) => [bot.id, bot]));
        for (const record of pending) yield* reconcileBotCreation(tx, record, bots.get(record.id));
      }),
    ),
  );

  // Persist the intent before editing JSON so a restart can recognize an interrupted undo.
  const beginUndo = (tx: StoreTransaction, id: MessageId) =>
    Effect.gen(function* () {
      const { message, receipt } = yield* readReceipt(tx, id);
      if (receipt.status !== "available") return { message };
      const record = Option.getOrUndefined(yield* tx.get("bot_creations", receipt.botId));
      if (record?.messageId !== id) return { message };
      const bot = (yield* config.readBots).find((entry) => entry.id === record.id);
      const latest = yield* reconcileBotCreation(tx, record, bot);
      if (latest?.botCreation?.status !== "available") return { message: latest ?? message };
      const intent: StoredBotCreation = { ...record, phase: "undoing" };
      yield* tx.set("bot_creations", intent);
      return { intent };
    });

  const finishUndo = (tx: StoreTransaction, intent: StoredBotCreation) =>
    Effect.gen(function* () {
      const { message, receipt } = yield* readReceipt(tx, intent.messageId);
      if (receipt.status !== "available") return message;
      if (yield* tx.botHasTasks(intent.id)) return yield* saveCreationReceipt(tx, intent, "used");
      const bots = yield* config.updateBots((current) =>
        current.filter((bot) => !matchesCreatedBot(intent, bot)),
      );
      return yield* saveCreationReceipt(
        tx,
        intent,
        bots.some((bot) => bot.id === intent.id) ? "changed" : "undone",
      );
    });

  return {
    reconcile,
    prepare: (bot: BotConfig, taskId: TaskId) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("bot_creations", {
            id: bot.id,
            messageId: MessageId.make(randomUUID()),
            taskId,
            name: bot.name,
            at: yield* Clock.currentTimeMillis,
            configDigest: botConfigDigest(bot),
            phase: "creating",
          });
        }),
      ),
    undo: (id: MessageId) =>
      config.withMutation(
        Effect.gen(function* () {
          const pending = yield* store.transaction((tx) => beginUndo(tx, id));
          const result = pending.intent
            ? yield* store.transaction((tx) => finishUndo(tx, pending.intent))
            : pending.message;
          if (result.botCreation?.status !== "undone")
            return yield* Effect.fail(
              new DaemonError({
                code: "Conflict",
                message: "This bot creation can no longer be undone",
              }),
            );
          return result;
        }),
      ),
  };
});

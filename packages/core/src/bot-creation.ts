// Creation receipts follow OpenMausBot's team-setup-requests.ts at 738ec884 (Apache-2.0).
import { createHash } from "node:crypto";
import type { BotConfig, BotCreationReceipt, MainThreadMessage } from "@aut/protocol";
import { Effect } from "effect";
import type { StoredBotCreation } from "./storage-model.js";
import type { StoreTransaction } from "./store.js";

// Header and environment maps can round-trip with different key order.
export function botConfigDigest(bot: BotConfig): string {
  const json = JSON.stringify(bot, (_, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
  return createHash("sha256").update(json).digest("hex");
}

export const matchesCreatedBot = (creation: StoredBotCreation, bot: BotConfig) =>
  bot.id === creation.id &&
  bot.system === undefined &&
  botConfigDigest(bot) === creation.configDigest;

export const saveCreationReceipt = (
  tx: StoreTransaction,
  creation: StoredBotCreation,
  status: BotCreationReceipt["status"],
) =>
  Effect.gen(function* () {
    const message: MainThreadMessage = {
      id: creation.messageId,
      at: creation.at,
      taskId: creation.taskId,
      author: "chief",
      kind: "notice",
      text: `已创建 Bot「${creation.name}」。`,
      botCreation: { botId: creation.id, status },
    };
    yield* tx.set("main_thread_messages", message);
    if (status === "available") yield* tx.set("bot_creations", { ...creation, phase: "active" });
    else yield* tx.forgetBotCreation(creation.id);
    return message;
  });

/** Reconcile using the atomic JSON file, including a crash on either side of its rename. */
export const reconcileBotCreation = (
  tx: StoreTransaction,
  creation: StoredBotCreation,
  current: BotConfig | undefined,
) =>
  Effect.gen(function* () {
    if (!current) {
      if (creation.phase === "creating") return yield* tx.forgetBotCreation(creation.id);
      return yield* saveCreationReceipt(
        tx,
        creation,
        creation.phase === "undoing" ? "undone" : "removed",
      );
    }
    if (!matchesCreatedBot(creation, current))
      return yield* saveCreationReceipt(tx, creation, "changed");
    if (yield* tx.botHasTasks(creation.id)) return yield* saveCreationReceipt(tx, creation, "used");
    return yield* saveCreationReceipt(tx, creation, "available");
  });

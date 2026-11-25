import {
  ConfigStore,
  type CoreError,
  isMemoryDreamTrigger,
  memoryDreamTriggerId,
  TaskRegistry,
  TriggerRegistry,
} from "@aut/core";
import type { Trigger } from "@aut/protocol";
import { Context, Effect, Layer } from "effect";

export { isMemoryDreamTask, isMemoryDreamTrigger, memoryDreamTriggerId } from "@aut/core";

/** System plans use the existing trigger ledger and execution path. */
export class MemoryDreams extends Context.Tag("aut/MemoryDreams")<
  MemoryDreams,
  {
    readonly ensure: Effect.Effect<void, CoreError>;
    readonly ready: (trigger: Trigger) => Effect.Effect<boolean, CoreError>;
  }
>() {}

export const MemoryDreamsLive = Layer.effect(
  MemoryDreams,
  Effect.gen(function* () {
    const config = yield* ConfigStore;
    const triggers = yield* TriggerRegistry;
    const tasks = yield* TaskRegistry;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ensure = Effect.gen(function* () {
      const bots = yield* config.readBots;
      const botIds = new Set(bots.map((bot) => bot.id));
      const existing = yield* triggers.list();
      const ids = new Set(existing.map((trigger) => trigger.id));
      for (const trigger of existing)
        if (isMemoryDreamTrigger(trigger) && trigger.enabled && !botIds.has(trigger.botId))
          yield* triggers.update(trigger.id, { enabled: false });
      for (const bot of bots) {
        const id = memoryDreamTriggerId(bot.id);
        if (ids.has(id)) continue;
        yield* triggers
          .create({
            id,
            name: `记忆整理 · ${bot.name}`,
            botId: bot.id,
            enabled: true,
            schedule: { kind: "daily", at: "03:00", timeZone },
            prompt: `整理「${bot.name}」的长期记忆。`,
            payload: { kind: "memory-dream" },
          })
          .pipe(
            // Another configuration writer may have created the same stable plan meanwhile.
            Effect.catchAll((error) =>
              error.code === "Conflict" ? Effect.void : Effect.fail(error),
            ),
          );
      }
    });
    const ready = (trigger: Trigger) =>
      Effect.gen(function* () {
        if (!isMemoryDreamTrigger(trigger)) return true;
        if (!(yield* config.readBots).some((bot) => bot.id === trigger.botId)) return false;
        const active = yield* tasks.list({
          botId: trigger.botId,
          status: ["created", "running", "waiting_user", "reporting"],
          limit: 1,
        });
        if (active.length) return false;
        const waiting = yield* tasks.list({
          botId: trigger.botId,
          status: ["idle", "failed", "interrupted"],
          limit: Number.MAX_SAFE_INTEGER,
        });
        return !waiting.some((task) => task.queue.length > 0);
      });
    return { ensure, ready };
  }),
);

import type { BotConfig, BotId, Task } from "@aut/protocol";
import { Context, Effect, Layer } from "effect";
import { ConfigStore } from "./config-store.js";
import { CoreError } from "./errors.js";

export const primaryBotConfig = (
  id: BotId,
  seed: Pick<BotConfig, "modelSelection" | "cwd">,
): BotConfig => ({
  id,
  system: "primary",
  name: "aut",
  description:
    "General assistance for requests without a matching specialist. Complete the work or help the user clarify what to do next.",
  soul: "You are aut's primary assistant. Do the requested work yourself when you can. Use the supplied context and relevant evidence, ask the user through the native question tool when needed, and report the outcome in the user's language.",
  modelSelection: { ...seed.modelSelection },
  cwd: seed.cwd,
});

export const isCoordinationTask = (
  task: Task,
  bot: BotConfig,
): task is Task & { readonly origin: Extract<Task["origin"], { kind: "coordination" }> } =>
  bot.system === "primary" && task.botId === bot.id && task.origin.kind === "coordination";

export class PrimaryAssistant extends Context.Tag("aut/PrimaryAssistant")<
  PrimaryAssistant,
  { readonly get: Effect.Effect<BotConfig, CoreError> }
>() {}
export const PrimaryAssistantLive = Layer.effect(
  PrimaryAssistant,
  Effect.gen(function* () {
    const config = yield* ConfigStore;
    return {
      get: Effect.gen(function* () {
        const bot = (yield* config.readBots).find((entry) => entry.system === "primary");
        if (
          !bot ||
          !(yield* config.readConfig).harnessInstances.some(
            (instance) => instance.id === bot.modelSelection.instanceId,
          )
        )
          return yield* Effect.fail(
            new CoreError({
              code: "Configuration",
              message: "The primary assistant requires a configured harness instance.",
            }),
          );
        return bot;
      }),
    };
  }),
);

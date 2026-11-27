import { ConfigStore, type CoreError, Store } from "@aut/core";
import {
  AutConfig,
  BotConfig,
  type BotId,
  type BotsConfig,
  HarnessInstanceConfig,
  type MainThreadMessage,
  type MessageId,
  RoutingCandidateId,
  type TaskId,
} from "@aut/protocol";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { makeBotCreationReceipts } from "./bot-creation-receipts.js";
import { DaemonError, decode } from "./errors.js";
import { PrimaryAssistantBootstrap } from "./primary-assistant.js";

export class Administration extends Context.Tag("aut/DaemonAdministration")<
  Administration,
  {
    readonly bots: Effect.Effect<BotsConfig, CoreError>;
    readonly config: Effect.Effect<AutConfig, CoreError>;
    readonly ensureBotConnection: (
      instance: HarnessInstanceConfig,
    ) => Effect.Effect<HarnessInstanceConfig, CoreError | DaemonError>;
    readonly createBot: (
      bot: BotConfig,
      originTaskId?: TaskId,
    ) => Effect.Effect<BotConfig, CoreError | DaemonError>;
    readonly undoBotCreation: (
      messageId: MessageId,
    ) => Effect.Effect<MainThreadMessage, CoreError | DaemonError>;
    readonly updateBot: (
      id: BotId,
      bot: BotConfig,
    ) => Effect.Effect<BotConfig, CoreError | DaemonError>;
    readonly deleteBot: (id: BotId) => Effect.Effect<void, CoreError | DaemonError>;
    readonly setConfig: (config: AutConfig) => Effect.Effect<AutConfig, CoreError | DaemonError>;
  }
>() {}

export const AdministrationLive = Layer.scoped(
  Administration,
  Effect.gen(function* () {
    const config = yield* ConfigStore;
    const store = yield* Store;
    const receipts = yield* makeBotCreationReceipts;
    const scope = yield* Effect.scope;
    const bootstrap = yield* Effect.serviceOption(PrimaryAssistantBootstrap);
    const refresh = Option.isSome(bootstrap)
      ? bootstrap.value.ensure.pipe(
          Effect.tapError(() =>
            Effect.logWarning(
              "Primary assistant initialization could not complete after a configuration save.",
            ),
          ),
          Effect.ignore,
          Effect.interruptible,
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      : Effect.void;
    const mutate = <A, E>(write: Effect.Effect<A, E>) =>
      config.withMutation(write).pipe(Effect.tap(() => refresh));
    const findBot = (id: BotId) =>
      config.readBots.pipe(Effect.map((bots) => bots.find((bot) => bot.id === id)));
    const requireBot = (id: BotId) =>
      findBot(id).pipe(
        Effect.flatMap((bot) =>
          bot
            ? Effect.succeed(bot)
            : Effect.fail(new DaemonError({ code: "NotFound", message: "Unknown bot" })),
        ),
      );
    const checkInstance = (bot: BotConfig) =>
      Effect.gen(function* () {
        const settings = yield* config.readConfig;
        if (
          !settings.harnessInstances.some(
            (instance) => instance.id === bot.modelSelection.instanceId,
          )
        )
          return yield* Effect.fail(
            new DaemonError({
              code: "Conflict",
              message: "Bot refers to an unknown harness instance",
            }),
          );
      });
    return {
      bots: config.readBots,
      config: config.readConfig,
      ensureBotConnection: (input) =>
        config.withMutation(
          Effect.gen(function* () {
            const instance = yield* decode(HarnessInstanceConfig, input);
            const key = (value: HarnessInstanceConfig) =>
              JSON.stringify([
                value.name,
                value.kind,
                value.command,
                value.args,
                Object.entries(value.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
                value.authMethodIds ?? [],
              ]);
            const current = yield* config.readConfig;
            const matching = current.harnessInstances.find((entry) => key(entry) === key(instance));
            if (matching) return matching;
            if (current.harnessInstances.some((entry) => entry.id === instance.id))
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "The connection identifier is already in use.",
                }),
              );
            yield* config.updateConfig((value) => ({
              ...value,
              harnessInstances: [...value.harnessInstances, instance],
            }));
            return instance;
          }),
        ),
      undoBotCreation: receipts.undo,
      createBot: (input, originTaskId) =>
        mutate(
          Effect.gen(function* () {
            const bot = yield* decode(BotConfig, input);
            if (!Schema.is(RoutingCandidateId)(bot.id))
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "This Bot ID is reserved for routing",
                }),
              );
            if (bot.system !== undefined)
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "The primary assistant identity is reserved",
                }),
              );
            yield* checkInstance(bot);
            const existing = yield* findBot(bot.id);
            yield* store.transaction((tx) => receipts.reconcile(tx, bot.id, existing));
            if (existing)
              return yield* Effect.fail(
                new DaemonError({ code: "Conflict", message: "Bot ID already exists" }),
              );
            if (originTaskId) yield* receipts.prepare(bot, originTaskId);
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* config.updateBots((current) => [...current, bot]);
                yield* receipts.reconcile(tx, bot.id, bot);
              }),
            );
            return bot;
          }),
        ),
      updateBot: (id, input) =>
        mutate(
          Effect.gen(function* () {
            const bot = yield* decode(BotConfig, input);
            const previous = yield* requireBot(id);
            if (bot.id !== id || bot.system !== previous.system)
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "Bot ID and system identity cannot be changed",
                }),
              );
            yield* checkInstance(bot);
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* receipts.reconcile(tx, id, previous);
                yield* config.updateBots((current) =>
                  current.map((value) => (value.id === id ? bot : value)),
                );
                yield* receipts.reconcile(tx, id, bot);
              }),
            );
            return bot;
          }),
        ),
      deleteBot: (id) =>
        mutate(
          Effect.gen(function* () {
            const bot = yield* requireBot(id);
            if (bot.system !== undefined)
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "The primary assistant cannot be deleted",
                }),
              );
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                yield* receipts.reconcile(tx, id, bot);
                if (yield* tx.botHasTasks(id))
                  return yield* Effect.fail(
                    new DaemonError({
                      code: "Conflict",
                      message: "Bot is still referenced by a task",
                    }),
                  );
                yield* config.updateBots((current) => current.filter((value) => value.id !== id));
                yield* receipts.reconcile(tx, id, undefined);
              }),
            );
          }),
        ),
      setConfig: (input) =>
        mutate(
          Effect.gen(function* () {
            const next = yield* decode(AutConfig, input);
            const bots = yield* config.readBots;
            if (
              bots.some(
                (bot) =>
                  !next.harnessInstances.some(
                    (instance) => instance.id === bot.modelSelection.instanceId,
                  ),
              )
            )
              return yield* Effect.fail(
                new DaemonError({
                  code: "Conflict",
                  message: "Harness instance is still referenced by a bot",
                }),
              );
            return yield* config.updateConfig((current) =>
              current.classifier && !next.classifier
                ? { ...next, classifier: current.classifier }
                : next,
            );
          }),
        ),
    };
  }),
);

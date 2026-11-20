import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CodexDefaults, readCodexDefaults } from "@aut/adapters";
import {
  ConfigStore,
  CoreError,
  type CoreOptions,
  primaryBotConfig,
  resolveDataDirectory,
} from "@aut/core";
import { type BotConfig, BotId, type HarnessInstanceConfig, NonEmptyString } from "@aut/protocol";
import { Context, Effect, Layer, Ref, Schema } from "effect";

export const PrimaryAssistantSetup = Schema.Union(
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({
    status: Schema.Literal("needsConfiguration"),
    reason: NonEmptyString,
  }),
);
export type PrimaryAssistantSetup = typeof PrimaryAssistantSetup.Type;
export class PrimaryAssistantDefaultsProbe extends Context.Tag("aut/PrimaryAssistantDefaultsProbe")<
  PrimaryAssistantDefaultsProbe,
  {
    readonly supports: (instance: HarnessInstanceConfig) => boolean;
    readonly read: (input: {
      readonly instance: HarnessInstanceConfig;
      readonly cwd: string;
      readonly timeoutMs: number;
    }) => Effect.Effect<CodexDefaults, CoreError>;
  }
>() {}
export const PrimaryAssistantDefaultsProbeLive = Layer.succeed(PrimaryAssistantDefaultsProbe, {
  supports: (instance) => instance.kind === "codex",
  read: ({ instance, cwd, timeoutMs }) =>
    readCodexDefaults({
      command: instance.command,
      args: instance.args,
      ...(instance.env ? { env: instance.env } : {}),
      cwd,
      timeoutMs,
    }).pipe(
      Effect.mapError(
        () =>
          new CoreError({
            code: "Configuration",
            message:
              "A configured Codex model could not be discovered without changing its settings.",
          }),
      ),
    ),
});

export class PrimaryAssistantBootstrap extends Context.Tag("aut/PrimaryAssistantBootstrap")<
  PrimaryAssistantBootstrap,
  {
    readonly ensure: Effect.Effect<PrimaryAssistantSetup, CoreError>;
    readonly status: Effect.Effect<PrimaryAssistantSetup>;
  }
>() {}
export interface PrimaryAssistantBootstrapOptions extends CoreOptions {
  readonly workspaceDirectory?: string;
  readonly codexCommand?: string;
  readonly probeTimeoutMs?: number;
}
const needsConfiguration = (reason: string): PrimaryAssistantSetup => ({
  status: "needsConfiguration",
  reason,
});
const availableId = (bots: readonly BotConfig[]): BotId => {
  const occupied = new Set(bots.map((bot) => bot.id as string));
  if (!occupied.has("aut")) return BotId.make("aut");
  let suffix = 2;
  while (occupied.has(`aut-${suffix}`)) suffix++;
  return BotId.make(`aut-${suffix}`);
};

export const PrimaryAssistantBootstrapLive = (options: PrimaryAssistantBootstrapOptions = {}) =>
  Layer.effect(
    PrimaryAssistantBootstrap,
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const probe = yield* PrimaryAssistantDefaultsProbe;
      const timeoutMs = options.probeTimeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(
          new CoreError({
            code: "Configuration",
            message: "Primary assistant discovery needs a positive safe timeout.",
          }),
        );
      const status = yield* Ref.make<PrimaryAssistantSetup>(
        needsConfiguration("Primary assistant setup has not run."),
      );
      const ensure = config
        .withMutation(
          Effect.gen(function* () {
            const settings = yield* config.readConfig;
            const bots = yield* config.readBots;
            const supported = (bot: BotConfig) =>
              settings.harnessInstances.some(
                (instance) =>
                  instance.id === bot.modelSelection.instanceId && probe.supports(instance),
              );
            const primary = bots.find((bot) => bot.system === "primary");
            if (primary)
              return supported(primary)
                ? { status: "ready" as const }
                : needsConfiguration(
                    "The primary assistant refers to an unavailable harness instance.",
                  );
            const reusable = bots.find(supported);
            let seed: Pick<BotConfig, "modelSelection" | "cwd">;
            if (reusable) seed = { modelSelection: reusable.modelSelection, cwd: reusable.cwd };
            else {
              const empty = settings.harnessInstances.length === 0 && bots.length === 0;
              let instance = settings.harnessInstances.find(probe.supports);
              if (!instance && !empty)
                return needsConfiguration(
                  "Configure a supported harness and model; existing settings were preserved.",
                );
              const cwd =
                options.workspaceDirectory ??
                (empty ? join(resolveDataDirectory(options), "workspace") : process.cwd());
              if (empty)
                yield* Effect.try({
                  try: () => mkdirSync(cwd, { recursive: true, mode: 0o700 }),
                  catch: () =>
                    new CoreError({
                      code: "Configuration",
                      message: "The aut workspace could not be prepared.",
                    }),
                });
              instance ??= {
                id: "aut-codex",
                name: "Local Codex configuration",
                kind: "codex",
                command: options.codexCommand ?? "codex",
                args: [],
              };
              const discovered = yield* probe.read({ instance, cwd, timeoutMs }).pipe(
                Effect.interruptible,
                Effect.timeoutFail({
                  duration: timeoutMs,
                  onTimeout: () =>
                    new CoreError({
                      code: "Configuration",
                      message: "Read-only model discovery timed out.",
                    }),
                }),
                Effect.either,
              );
              if (discovered._tag === "Left")
                return needsConfiguration(
                  "Model discovery did not return an unambiguous configured model. Configure the harness/model in Settings and retry.",
                );
              if (empty) {
                const discoveredInstance = instance;
                const current = yield* config.updateConfig((value) =>
                  value.harnessInstances.length === 0
                    ? { ...value, harnessInstances: [discoveredInstance] }
                    : value,
                );
                if (!current.harnessInstances.some((value) => value.id === discoveredInstance.id))
                  return needsConfiguration(
                    "Harness settings changed during setup; retry without replacing them.",
                  );
              }
              seed = {
                modelSelection: {
                  instanceId: instance.id,
                  model: discovered.right.model,
                  ...(discovered.right.effort ? { effort: discovered.right.effort } : {}),
                },
                cwd,
              };
            }
            yield* config.updateBots((current) =>
              current.some((bot) => bot.system === "primary")
                ? current
                : [...current, primaryBotConfig(availableId(current), seed)],
            );
            return { status: "ready" as const };
          }),
        )
        .pipe(Effect.tap((result) => Ref.set(status, result)));
      yield* ensure;
      return { ensure, status: Ref.get(status) };
    }),
  );

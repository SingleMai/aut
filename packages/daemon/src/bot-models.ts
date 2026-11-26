import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type {
  AutConfig,
  BotModelDiscoveryInput,
  BotModelOptionsResponse,
  BotModelsResponse,
  HarnessInstanceConfig,
} from "@aut/protocol";
import { Context, Effect, Layer } from "effect";
import { DaemonError } from "./errors.js";
import { harnessRegistration, harnessRegistry } from "./harness-registry.js";

const presets = Object.values(harnessRegistry).flatMap((registration) => registration.presets);
const sameProgram = (a: HarnessInstanceConfig, b: HarnessInstanceConfig) =>
  a.kind === b.kind &&
  basename(a.command) === b.command &&
  JSON.stringify(a.args) === JSON.stringify(b.args);

/** Resolves the same inherited PATH as the adapter subprocess; it never runs the program. */
export const programInstalled = (instance: HarnessInstanceConfig): boolean | undefined => {
  if (!isAbsolute(instance.command) && instance.command.includes("/")) return undefined;
  const searchPath = (instance.env?.PATH ?? process.env.PATH ?? "").split(delimiter);
  const paths = isAbsolute(instance.command)
    ? [instance.command]
    : searchPath.filter((path) => isAbsolute(path)).map((path) => join(path, instance.command));
  const found = paths.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  return found
    ? true
    : !isAbsolute(instance.command) && searchPath.some((path) => !isAbsolute(path))
      ? undefined
      : false;
};

const availableId = (id: string, config: AutConfig): string => {
  let candidate = id;
  while (config.harnessInstances.some((instance) => instance.id === candidate))
    candidate += ":default";
  return candidate;
};

export const botModelOptions = (
  config: AutConfig,
  installed: (instance: HarnessInstanceConfig) => boolean | undefined = programInstalled,
): BotModelOptionsResponse => {
  const candidates = [
    ...config.harnessInstances.map((instance) => ({ instance, configured: true })),
    ...presets
      .filter(
        ({ instance }) =>
          !config.harnessInstances.some(
            (existing) =>
              sameProgram(existing, instance) &&
              Object.keys(existing.env ?? {}).length === 0 &&
              !existing.authMethodIds?.length,
          ),
      )
      .map(({ instance }) => ({
        // A user's stored identifier always wins, even if it resembles a built-in identifier.
        instance: { ...instance, id: availableId(instance.id, config) },
        configured: false,
      })),
  ];
  return {
    options: candidates.map(({ instance, configured }) => {
      const registration = harnessRegistration(instance.kind);
      const found = registration ? installed(instance) : undefined;
      return {
        instance,
        configured,
        availability: !registration
          ? "unsupported"
          : found === undefined
            ? "unknown"
            : found
              ? "installed"
              : "missing",
        discovery: !!registration?.models,
        verification:
          presets.find((preset) => sameProgram(instance, preset.instance))?.verification ??
          registration?.verification ??
          "preview",
      };
    }),
  };
};

export class BotModelDiscovery extends Context.Tag("aut/BotModelDiscovery")<
  BotModelDiscovery,
  {
    readonly read: (input: BotModelDiscoveryInput) => Effect.Effect<BotModelsResponse, DaemonError>;
  }
>() {}

export const BotModelDiscoveryLive = Layer.succeed(BotModelDiscovery, {
  read: (input) => {
    const reader = harnessRegistration(input.instance.kind)?.models;
    return reader
      ? reader(input).pipe(
          Effect.mapError(
            () =>
              new DaemonError({
                code: "Unavailable",
                message:
                  "Could not read models. Check the execution host's program, account and working directory.",
              }),
          ),
        )
      : Effect.fail(
          new DaemonError({
            code: "Unavailable",
            message: "This program does not support model discovery.",
          }),
        );
  },
});

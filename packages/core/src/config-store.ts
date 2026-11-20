import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AutConfig, BotsConfig } from "@aut/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { Changes } from "./changes.js";
import { type CoreOptions, resolveDataDirectory } from "./data-directory.js";
import { boundary, CoreError } from "./errors.js";

const writeAtomic = (directory: string, filename: string, contents: string) => {
  const path = join(directory, filename);
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let parent: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    parent = openSync(directory, "r");
    fsyncSync(parent);
    closeSync(parent);
    parent = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent !== undefined) closeSync(parent);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
};

export class ConfigStore extends Context.Tag("aut/ConfigStore")<
  ConfigStore,
  {
    readonly withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly readConfig: Effect.Effect<AutConfig, CoreError>;
    readonly writeConfig: (config: AutConfig) => Effect.Effect<void, CoreError>;
    readonly updateConfig: (
      modify: (config: AutConfig) => AutConfig,
    ) => Effect.Effect<AutConfig, CoreError>;
    readonly readBots: Effect.Effect<BotsConfig, CoreError>;
    readonly writeBots: (bots: BotsConfig) => Effect.Effect<void, CoreError>;
    readonly updateBots: (
      modify: (bots: BotsConfig) => BotsConfig,
    ) => Effect.Effect<BotsConfig, CoreError>;
  }
>() {}

export const ConfigStoreLive = (options: CoreOptions = {}) =>
  Layer.effect(
    ConfigStore,
    Effect.gen(function* () {
      const changes = yield* Changes;
      const directory = resolveDataDirectory(options);
      if (directory.length === 0)
        return yield* Effect.fail(
          new CoreError({ code: "Configuration", message: "Data directory must not be empty" }),
        );
      yield* boundary("Failed to create configuration directory", () =>
        mkdirSync(directory, { recursive: true, mode: 0o700 }),
      );
      const semaphore = yield* Effect.makeSemaphore(1);
      const mutations = yield* Effect.makeSemaphore(1);
      const read = <A, I>(filename: string, schema: Schema.Schema<A, I>, initial: A) =>
        Effect.gen(function* () {
          const contents = yield* boundary(`Failed to read ${filename}`, () => {
            const path = join(directory, filename);
            return existsSync(path) ? readFileSync(path, "utf8") : undefined;
          });
          if (contents === undefined) return initial;
          return yield* Schema.decodeUnknown(Schema.parseJson(schema))(contents, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CoreError({
                  code: "Configuration",
                  message: `Invalid ${filename}; existing settings were preserved`,
                  detail: String(cause),
                }),
            ),
          );
        });
      const write = <A, I>(filename: string, schema: Schema.Schema<A, I>, value: A) =>
        Effect.gen(function* () {
          const contents = yield* Schema.encode(Schema.parseJson(schema))(value, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CoreError({
                  code: "Configuration",
                  message: `Invalid ${filename}; existing settings were preserved`,
                  detail: String(cause),
                }),
            ),
          );
          yield* Effect.uninterruptible(
            boundary(`Failed to save ${filename}`, () =>
              writeAtomic(directory, filename, `${contents}\n`),
            ).pipe(
              Effect.zipRight(changes.publish([filename === "bots.json" ? "bots" : "config"])),
            ),
          );
        });
      const update = <A, I>(
        filename: string,
        schema: Schema.Schema<A, I>,
        initial: A,
        modify: (value: A) => A,
      ) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* read(filename, schema, initial);
            const next = yield* Effect.try({
              try: () => modify(previous),
              catch: (cause) =>
                new CoreError({
                  code: "Configuration",
                  message: "Configuration update failed",
                  detail: String(cause),
                }),
            });
            yield* write(filename, schema, next);
            return next;
          }),
        );
      const emptyConfig: AutConfig = { harnessInstances: [] };
      const emptyBots: BotsConfig = [];
      return {
        withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => mutations.withPermits(1)(effect),
        readConfig: semaphore.withPermits(1)(read("config.json", AutConfig, emptyConfig)),
        writeConfig: (config) => semaphore.withPermits(1)(write("config.json", AutConfig, config)),
        updateConfig: (modify) => update("config.json", AutConfig, emptyConfig, modify),
        readBots: semaphore.withPermits(1)(read("bots.json", BotsConfig, emptyBots)),
        writeBots: (bots) => semaphore.withPermits(1)(write("bots.json", BotsConfig, bots)),
        updateBots: (modify) => update("bots.json", BotsConfig, emptyBots, modify),
      };
    }),
  );

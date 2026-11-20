import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type CoreOptions, resolveDataDirectory } from "@aut/core";
import {
  SecretName,
  SecretSaveInput,
  type SecretSaveResponse,
  type SecretStatusResponse,
} from "@aut/protocol";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { DaemonError, decode, io } from "./errors.js";

const SecretFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({ name: SecretName, key: Schema.Redacted(SecretSaveInput.fields.key) }),
  ).pipe(
    Schema.filter((entries) => new Set(entries.map((entry) => entry.name)).size === entries.length),
  ),
});
type SecretFile = typeof SecretFile.Type;
const maximumFileBytes = 1024 * 1024;
const unavailable = () =>
  new DaemonError({ code: "Unavailable", message: "The local credential store is unavailable" });
const prepareDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid credential directory");
  chmodSync(directory, 0o700);
};
const readFile = (directory: string): string | undefined => {
  prepareDirectory(directory);
  let descriptor: number;
  try {
    descriptor = openSync(
      join(directory, "secrets.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumFileBytes) throw new Error("Invalid credential file");
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};
const writeFile = (directory: string, contents: string) => {
  const temporary = join(directory, `.secrets.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let parent: number | undefined;
  let created = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, join(directory, "secrets.json"));
    created = false;
    parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent !== undefined) closeSync(parent);
    if (created) unlinkSync(temporary);
  }
};
export class SecretStore extends Context.Tag("aut/SecretStore")<
  SecretStore,
  {
    readonly save: (
      name: string,
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<SecretSaveResponse, DaemonError>;
    readonly resolve: (reference: string) => Effect.Effect<Redacted.Redacted<string>, DaemonError>;
    readonly status: (reference: string) => Effect.Effect<SecretStatusResponse, DaemonError>;
  }
>() {}
export const SecretStoreLive = (options: CoreOptions = {}) =>
  Layer.effect(
    SecretStore,
    Effect.gen(function* () {
      const directory = resolveDataDirectory(options);
      if (!directory.length) return yield* Effect.fail(unavailable());
      const semaphore = yield* Effect.makeSemaphore(1);
      const read = io("The local credential store could not be read", () =>
        readFile(directory),
      ).pipe(
        Effect.flatMap((contents) =>
          contents === undefined
            ? Effect.succeed<SecretFile>({ schemaVersion: 1, entries: [] })
            : Schema.decodeUnknown(Schema.parseJson(SecretFile))(contents, {
                onExcessProperty: "error",
              }).pipe(Effect.mapError(unavailable)),
        ),
      );
      const nameFromReference = (reference: string) =>
        reference.startsWith("secret:")
          ? decode(SecretName, reference.slice(7))
          : Effect.fail(
              new DaemonError({
                code: "Validation",
                message: "Invalid local credential reference",
              }),
            );
      return {
        save: (name, key) =>
          semaphore.withPermits(1)(
            Effect.uninterruptible(
              Effect.gen(function* () {
                const checked = yield* decode(SecretSaveInput, { name, key: Redacted.value(key) });
                const previous = yield* read;
                const next: SecretFile = {
                  schemaVersion: 1,
                  entries: [
                    ...previous.entries.filter((entry) => entry.name !== checked.name),
                    { name: checked.name, key: Redacted.make(checked.key) },
                  ],
                };
                const encoded = yield* Schema.encode(Schema.parseJson(SecretFile))(next).pipe(
                  Effect.mapError(unavailable),
                );
                if (Buffer.byteLength(`${encoded}\n`, "utf8") > maximumFileBytes)
                  return yield* Effect.fail(unavailable());
                yield* io("The local credential could not be saved", () =>
                  writeFile(directory, `${encoded}\n`),
                );
                return { apiKeyRef: `secret:${checked.name}`, configured: true } as const;
              }),
            ),
          ),
        resolve: (reference) =>
          semaphore.withPermits(1)(
            Effect.gen(function* () {
              const name = yield* nameFromReference(reference);
              const entry = (yield* read).entries.find((item) => item.name === name);
              return entry
                ? entry.key
                : yield* Effect.fail(
                    new DaemonError({
                      code: "Unavailable",
                      message: "The classifier credential is not configured",
                    }),
                  );
            }),
          ),
        status: (reference) =>
          semaphore.withPermits(1)(
            Effect.gen(function* () {
              const name = yield* nameFromReference(reference);
              return {
                apiKeyRef: reference,
                configured: (yield* read).entries.some((entry) => entry.name === name),
              };
            }),
          ),
      };
    }),
  );

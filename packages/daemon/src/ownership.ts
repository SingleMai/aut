import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CoreOptions, resolveDataDirectory } from "@aut/core";
import { Context, Effect, Layer } from "effect";
import { DaemonError, io } from "./errors.js";

export class Ownership extends Context.Tag("aut/DaemonOwnership")<
  Ownership,
  { readonly directory: string; readonly nonce: string }
>() {}

export const OwnershipLive = (options: CoreOptions = {}) =>
  Layer.scoped(
    Ownership,
    Effect.gen(function* () {
      const directory = resolveDataDirectory(options);
      const path = join(directory, "daemon-lock.sqlite");
      yield* io("Failed to create daemon directory", () =>
        mkdirSync(directory, { recursive: true, mode: 0o700 }),
      );
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const connection = new DatabaseSync(path);
            try {
              chmodSync(path, 0o600);
              connection.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
              return connection;
            } catch (cause) {
              connection.close();
              throw cause;
            }
          },
          catch: () =>
            new DaemonError({
              code: "Lock",
              message: "Could not acquire exclusive daemon ownership",
            }),
        }),
        (connection) =>
          io("Failed to release daemon ownership", () => {
            try {
              connection.exec("ROLLBACK");
            } finally {
              connection.close();
            }
          }).pipe(Effect.orDie),
      );
      return { directory, nonce: randomUUID() };
    }),
  );

export class Authentication extends Context.Tag("aut/DaemonAuthentication")<
  Authentication,
  {
    readonly matches: (candidate: string | undefined) => boolean;
  }
>() {}

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const owner = yield* Ownership;
    const path = join(owner.directory, "daemon-token");
    const token = yield* io("Failed to load daemon authentication", () => {
      if (!existsSync(path))
        writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
      return readFileSync(path, "utf8").trim();
    });
    if (!/^[0-9a-f]{64}$/.test(token))
      return yield* Effect.fail(
        new DaemonError({
          code: "Validation",
          message: "Stored daemon authentication token is invalid",
        }),
      );
    return {
      matches: (candidate) =>
        candidate !== undefined &&
        /^[0-9a-f]{64}$/.test(candidate) &&
        timingSafeEqual(Buffer.from(candidate), Buffer.from(token)),
    };
  }),
);

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RemoteConnectionInfo } from "@aut/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { safeStorage } from "electron";
import { DesktopError } from "./desktop-error.js";

const StoredTarget = Schema.Union(
  Schema.Struct({ version: Schema.Literal(1), mode: Schema.Literal("local") }),
  Schema.Struct({
    version: Schema.Literal(1),
    mode: Schema.Literal("remote"),
    encrypted: Schema.String.pipe(Schema.maxLength(8192)),
  }),
);
const failure = () =>
  new DesktopError({
    code: "Configuration",
    message: "无法读取或保存执行位置，请检查本机钥匙串与应用配置目录。",
  });
export class ConnectionPreferences extends Context.Tag("aut/ConnectionPreferences")<
  ConnectionPreferences,
  {
    readonly remote: RemoteConnectionInfo | undefined;
    readonly save: (remote: RemoteConnectionInfo | undefined) => Effect.Effect<void, DesktopError>;
  }
>() {}
export const ConnectionPreferencesLive = (directory: string) =>
  Layer.effect(
    ConnectionPreferences,
    Effect.gen(function* () {
      const path = join(directory, "execution-target.json");
      const raw = yield* Effect.try({
        try: () =>
          !existsSync(path)
            ? undefined
            : statSync(path).size <= 16384
              ? readFileSync(path, "utf8")
              : "",
        catch: failure,
      });
      const saved =
        raw === undefined
          ? undefined
          : yield* Schema.decodeUnknown(Schema.parseJson(StoredTarget))(raw, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(failure));
      const remote =
        saved?.mode !== "remote"
          ? undefined
          : yield* Effect.gen(function* () {
              if (!safeStorage.isEncryptionAvailable()) return yield* Effect.fail(failure());
              const plaintext = yield* Effect.try({
                try: () => safeStorage.decryptString(Buffer.from(saved.encrypted, "base64")),
                catch: failure,
              });
              return yield* Schema.decodeUnknown(Schema.parseJson(RemoteConnectionInfo))(
                plaintext,
                { onExcessProperty: "error" },
              ).pipe(Effect.mapError(failure));
            });
      return {
        remote,
        save: (connection) =>
          Effect.gen(function* () {
            let stored: typeof StoredTarget.Type = { version: 1, mode: "local" };
            if (connection) {
              const text = yield* Schema.encode(Schema.parseJson(RemoteConnectionInfo))(
                connection,
              ).pipe(Effect.mapError(failure));
              if (!safeStorage.isEncryptionAvailable()) return yield* Effect.fail(failure());
              const encrypted = yield* Effect.try({
                try: () => safeStorage.encryptString(text).toString("base64"),
                catch: failure,
              });
              stored = { version: 1, mode: "remote", encrypted };
            }
            const json = yield* Schema.encode(Schema.parseJson(StoredTarget))(stored).pipe(
              Effect.mapError(failure),
            );
            yield* Effect.try({
              try: () => {
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                const temporary = `${path}.${randomUUID()}.tmp`;
                try {
                  writeFileSync(temporary, json, { flag: "wx", mode: 0o600 });
                  renameSync(temporary, path);
                } finally {
                  rmSync(temporary, { force: true });
                }
              },
              catch: failure,
            });
          }),
      };
    }),
  );

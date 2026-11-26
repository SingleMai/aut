import { randomUUID } from "node:crypto";
import { RemoteConnectionInfo } from "@aut/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import type { PairingPreview } from "./bridge.js";
import { DesktopError } from "./desktop-error.js";

const prefix = "aut-connect:";
const invalid = () =>
  new DesktopError({
    code: "Validation",
    message:
      "没有识别到连接码。请在另一台电脑的 aut 设置中开启「允许其他设备连接」，复制连接码后再粘贴。",
  });
export const encodeConnectionCode = (info: RemoteConnectionInfo) =>
  `${prefix}${Buffer.from(JSON.stringify(info), "utf8").toString("base64url")}`;
export const decodeConnectionCode = (text: string) =>
  Effect.gen(function* () {
    if (text.length > 4096) return yield* Effect.fail(invalid());
    const trimmed = text.trim();
    const encoded = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : undefined;
    if (encoded !== undefined && !/^[A-Za-z0-9_-]+$/.test(encoded))
      return yield* Effect.fail(invalid());
    const json =
      encoded === undefined ? trimmed : Buffer.from(encoded, "base64url").toString("utf8");
    return yield* Schema.decodeUnknown(Schema.parseJson(RemoteConnectionInfo))(json, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalid));
  });

export class ConnectionPairing extends Context.Tag("aut/ConnectionPairing")<
  ConnectionPairing,
  {
    readonly inspect: (
      owner: number,
      text: Effect.Effect<string, DesktopError>,
    ) => Effect.Effect<PairingPreview, DesktopError>;
    readonly read: (owner: number, id: string) => Effect.Effect<RemoteConnectionInfo, DesktopError>;
    readonly clear: (owner: number) => Effect.Effect<void>;
  }
>() {}

export const ConnectionPairingLive = Layer.effect(
  ConnectionPairing,
  Effect.sync(() => {
    const pending = new Map<number, { id: string; connection: RemoteConnectionInfo }>();
    const active = new Map<number, string>();
    return {
      inspect: (owner: number, text: Effect.Effect<string, DesktopError>) =>
        Effect.gen(function* () {
          pending.delete(owner);
          const id = randomUUID();
          active.set(owner, id);
          const connection = yield* text.pipe(Effect.flatMap(decodeConnectionCode));
          if (active.get(owner) !== id) return yield* Effect.fail(invalid());
          pending.set(owner, { id, connection });
          return { id, name: connection.name, hostId: connection.hostId };
        }),
      read: (owner: number, id: string) =>
        Effect.gen(function* () {
          const draft = pending.get(owner);
          if (!draft || draft.id !== id)
            return yield* Effect.fail(
              new DesktopError({
                code: "Validation",
                message: "待连接电脑已失效，请重新粘贴连接码。",
              }),
            );
          return draft.connection;
        }),
      clear: (owner: number) =>
        Effect.sync(() => {
          pending.delete(owner);
          active.delete(owner);
        }),
    };
  }),
);

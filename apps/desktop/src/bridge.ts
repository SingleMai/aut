import {
  ApiErrorResponse,
  DaemonEvent,
  DesktopConnectionStatus,
  FileId,
  JsonValue,
  NonEmptyString,
  RemoteConnectionInfo,
} from "@aut/protocol";
import { Schema } from "effect";

const routes = [
  ["GET", /^\/v1\/remote\/host$/],
  ["PUT", /^\/v1\/remote\/host$/],
  ["GET", /^\/v1\/bots\/[^/?#]+\/memory(?:\/(?:file|graph))?(?:\?[^#]+)?$/],
  ["PUT", /^\/v1\/bots\/[^/?#]+\/memory\/file$/],
  ["DELETE", /^\/v1\/bots\/[^/?#]+\/memory\/file\?[^#]+$/],
  ["POST", /^\/v1\/bots\/[^/?#]+\/memory\/clear$/],
  ["GET", /^\/v1\/files\/[a-f0-9]{64}$/],
  ["POST", /^\/v1\/files$/],
  ["POST", /^\/v1\/files\/keepalive$/],
  ["DELETE", /^\/v1\/files\/[a-f0-9]{64}$/],
  ["GET", /^\/v1\/(?:mcp\/servers|bots\/[^/?#]+\/mcp-grants|triggers(?:\/[^/?#]+\/runs)?)$/],
  [
    "POST",
    /^\/v1\/(?:mcp\/servers(?:\/[^/?#]+\/(?:test|enable|disable|auth\/(?:start|logout)))?|triggers(?:\/[^/?#]+\/(?:pause|resume))?)$/,
  ],
  ["PUT", /^\/v1\/(?:mcp\/servers\/[^/?#]+|bots\/[^/?#]+\/mcp-grants\/[^/?#]+|triggers\/[^/?#]+)$/],
  ["DELETE", /^\/v1\/mcp\/servers\/[^/?#]+$/],
  [
    "GET",
    /^\/v1\/(?:health|messages(?:\?[^#]*)?|tasks(?:\?[^#]*)?|tasks\/[^/?#]+(?:\/session(?:\?[^#]*)?)?|requests\/[^/?#]+|reports\/[^/?#]+|bots|config|secrets\/status\?[^#]+)$/,
  ],
  ["POST", /^\/v1\/(?:messages(?:\/[^/?#]+\/undo-bot-creation)?|actions|bots|route-test|secrets)$/],
  ["POST", /^\/v1\/bot-models\/(?:discover|connection)$/],
  ["GET", /^\/v1\/bot-models\/options$/],
  ["PUT", /^\/v1\/(?:config|bots\/[^/?#]+)$/],
  ["DELETE", /^\/v1\/bots\/[^/?#]+$/],
] as const;
export const ApiRequest = Schema.Struct({
  method: Schema.Literal("GET", "POST", "PUT", "DELETE"),
  path: NonEmptyString,
  body: Schema.optional(JsonValue),
}).pipe(
  Schema.filter((request) =>
    routes.some(([method, path]) => method === request.method && path.test(request.path)),
  ),
);
export type ApiRequest = typeof ApiRequest.Type;
export const ApiResult = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), data: JsonValue }),
  Schema.Struct({
    ok: Schema.Literal(false),
    ...ApiErrorResponse.fields,
  }),
);
export type ApiResult = typeof ApiResult.Type;
export const DesktopNotice = Schema.Union(
  DaemonEvent,
  Schema.Struct({ type: Schema.Literal("connection"), connected: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("target"), status: DesktopConnectionStatus }),
);
export type DesktopNotice = typeof DesktopNotice.Type;
export const FileAction = Schema.Struct({
  id: FileId,
  action: Schema.Literal("save", "reveal", "preview"),
});
export type FileAction = typeof FileAction.Type;
export type FileActionResult = {
  readonly ok: boolean;
  readonly cancelled?: boolean;
  readonly error?: string;
};
export const ConnectionAction = Schema.Union(
  Schema.Struct({ action: Schema.Literal("status", "login", "copy", "local", "clear-pairing") }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    text: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
  }),
  Schema.Struct({ action: Schema.Literal("pair"), id: Schema.UUID }),
  Schema.Struct({ action: Schema.Literal("remote"), connection: RemoteConnectionInfo }),
);
export type ConnectionAction = typeof ConnectionAction.Type;
export const PairingPreview = Schema.Struct({
  id: Schema.UUID,
  name: RemoteConnectionInfo.fields.name,
  hostId: RemoteConnectionInfo.fields.hostId,
});
export type PairingPreview = typeof PairingPreview.Type;
export type ConnectionActionResult =
  | {
      readonly ok: true;
      readonly status?: DesktopConnectionStatus;
      readonly preview?: PairingPreview;
      readonly cancelled?: boolean;
    }
  | { readonly ok: false; readonly error: string };
export interface DesktopBridge {
  readonly connection?: (input: ConnectionAction) => Promise<ConnectionActionResult>;
  readonly fileAction?: (input: FileAction) => Promise<FileActionResult>;
  readonly request: (request: ApiRequest) => Promise<ApiResult>;
  readonly onNotice: (listener: (notice: DesktopNotice) => void) => () => void;
}
declare global {
  interface Window {
    readonly aut: DesktopBridge;
  }
}

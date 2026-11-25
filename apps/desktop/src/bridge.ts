import { DaemonEvent, FileId, JsonValue, NonEmptyString } from "@aut/protocol";
import { Schema } from "effect";

const routes = [
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
    error: Schema.Struct({ code: NonEmptyString, message: Schema.String }),
  }),
);
export type ApiResult = typeof ApiResult.Type;
export const DesktopNotice = Schema.Union(
  DaemonEvent,
  Schema.Struct({ type: Schema.Literal("connection"), connected: Schema.Boolean }),
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
export interface DesktopBridge {
  readonly fileAction?: (input: FileAction) => Promise<FileActionResult>;
  readonly request: (request: ApiRequest) => Promise<ApiResult>;
  readonly onNotice: (listener: (notice: DesktopNotice) => void) => () => void;
}
declare global {
  interface Window {
    readonly aut: DesktopBridge;
  }
}

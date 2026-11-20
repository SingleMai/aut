import { DaemonEvent, JsonValue, NonEmptyString } from "@aut/protocol";
import { Schema } from "effect";

const routes = [
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
export interface DesktopBridge {
  readonly request: (request: ApiRequest) => Promise<ApiResult>;
  readonly onNotice: (listener: (notice: DesktopNotice) => void) => () => void;
}
declare global {
  interface Window {
    readonly aut: DesktopBridge;
  }
}

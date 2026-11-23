import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type CoreError, McpRegistry } from "@aut/core";
import type {
  McpAuthStartResponse,
  McpAuthStartResponse as McpAuthStartResponseType,
  McpServer,
  McpServerId,
} from "@aut/protocol";
import { Context, Data, Effect, Layer, Redacted, Runtime, Schema } from "effect";
import { DaemonError } from "./errors.js";
import { SecretReader } from "./secret-reader.js";
import { SecretStore } from "./secret-store.js";

const callbackPath = "/oauth/callback";
const pendingLifetimeMs = 10 * 60 * 1000;
const requestTimeoutMs = 10_000;

export class McpOAuthError extends Data.TaggedError("McpOAuthError")<{
  readonly code: "Discovery" | "Registration" | "Exchange" | "State";
  readonly message: string;
  readonly detail?: string;
}> {}

type OAuthMetadata = {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
};

type OAuthToken = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly expiresAt?: number;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpoint: string;
};

const StoredToken = Schema.Struct({
  accessToken: Schema.String.pipe(Schema.minLength(1)),
  refreshToken: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  tokenType: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  expiresAt: Schema.optional(Schema.Number.pipe(Schema.finite())),
  clientId: Schema.String.pipe(Schema.minLength(1)),
  clientSecret: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  tokenEndpoint: Schema.String.pipe(Schema.minLength(1)),
});

const oauthSecretName = (serverId: McpServerId) =>
  `mcp-oauth-${createHash("sha256").update(serverId).digest("hex").slice(0, 32)}`;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string) => {
  const result = asObject(value)?.[key];
  return typeof result === "string" && result.length > 0 ? result : undefined;
};

const stringListField = (value: unknown, key: string) => {
  const result = asObject(value)?.[key];
  return Array.isArray(result) && result.every((item) => typeof item === "string")
    ? result
    : undefined;
};

const fetchJson = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as unknown;
    },
    catch: (error) =>
      new McpOAuthError({
        code: "Discovery",
        message: "MCP OAuth metadata could not be read",
        detail: String(error),
      }),
  });

const endpoint = (base: string, path: string) => {
  const url = new URL(path, base);
  return url.toString();
};

const metadataFrom = (value: unknown): OAuthMetadata | undefined => {
  const authorizationEndpoint = stringField(value, "authorization_endpoint");
  const tokenEndpoint = stringField(value, "token_endpoint");
  const registrationEndpoint = stringField(value, "registration_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) return undefined;
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
  };
};

const discover = (server: McpServer) =>
  Effect.gen(function* () {
    if (server.transport === "stdio")
      return yield* Effect.fail(
        new McpOAuthError({
          code: "Discovery",
          message: "OAuth is available only for HTTP MCP servers",
        }),
      );
    const target = new URL(server.url);
    const resourceMetadataUrl = endpoint(target.origin, "/.well-known/oauth-protected-resource");
    const resourceMetadata = yield* fetchJson(resourceMetadataUrl).pipe(
      Effect.catchTag("McpOAuthError", () => Effect.succeed<unknown>(undefined)),
    );
    const authorizationServer =
      stringListField(resourceMetadata, "authorization_servers")?.[0] ?? target.origin;
    const candidates = [
      endpoint(authorizationServer, "/.well-known/oauth-authorization-server"),
      endpoint(authorizationServer, "/.well-known/openid-configuration"),
    ];
    let metadata: OAuthMetadata | undefined;
    for (const candidate of candidates) {
      const value = yield* fetchJson(candidate).pipe(
        Effect.catchTag("McpOAuthError", () => Effect.succeed<unknown>(undefined)),
      );
      metadata = metadataFrom(value);
      if (metadata) break;
    }
    if (!metadata)
      return yield* Effect.fail(
        new McpOAuthError({
          code: "Discovery",
          message: "The MCP server does not advertise OAuth endpoints",
        }),
      );
    return { metadata, authorizationServer };
  });

const formBody = (values: Record<string, string>) => new URLSearchParams(values).toString();
const oauthError = (code: McpOAuthError["code"], message: string, detail?: string) =>
  new McpOAuthError({ code, message, ...(detail === undefined ? {} : { detail }) });

const asToken = (
  value: unknown,
  clientId: string,
  tokenEndpoint: string,
  clientSecret?: string,
  previousRefreshToken?: string,
): OAuthToken => {
  const accessToken = stringField(value, "access_token");
  if (!accessToken) throw new Error("OAuth token response did not include an access token");
  const expiresIn = asObject(value)?.expires_in;
  return {
    accessToken,
    ...(stringField(value, "refresh_token")
      ? { refreshToken: stringField(value, "refresh_token") as string }
      : previousRefreshToken === undefined
        ? {}
        : { refreshToken: previousRefreshToken }),
    ...(stringField(value, "token_type")
      ? { tokenType: stringField(value, "token_type") as string }
      : {}),
    ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? { expiresAt: Date.now() + Math.max(0, expiresIn) * 1000 }
      : {}),
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    tokenEndpoint,
  };
};

type Pending = {
  readonly server: McpServer;
  readonly metadata: OAuthMetadata;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly createdAt: number;
};

const html = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${detail}</p>`;

const reply = (response: ServerResponse, status: number, content: string) => {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(content);
};

export class McpOAuth extends Context.Tag("aut/McpOAuth")<
  McpOAuth,
  {
    readonly start: (
      id: McpServerId,
    ) => Effect.Effect<McpAuthStartResponseType, McpOAuthError | DaemonError | CoreError>;
    readonly logout: (
      id: McpServerId,
    ) => Effect.Effect<McpServer, McpOAuthError | DaemonError | CoreError>;
    readonly accessToken: (
      id: McpServerId,
    ) => Effect.Effect<Redacted.Redacted<string>, DaemonError | CoreError>;
  }
>() {}

export const McpOAuthLive = Layer.scoped(
  McpOAuth,
  Effect.gen(function* () {
    const registry = yield* McpRegistry;
    const secrets = yield* SecretStore;
    const secretReader = yield* SecretReader;
    const runtime = yield* Effect.runtime<never>();
    const pending = new Map<string, Pending>();
    let callbackPort = 0;

    const find = (id: McpServerId) =>
      registry
        .get(id)
        .pipe(
          Effect.flatMap((value) =>
            value._tag === "Some"
              ? Effect.succeed(value.value)
              : Effect.fail(
                  new DaemonError({ code: "NotFound", message: "The MCP server was not found" }),
                ),
          ),
        );
    const finish = (state: string, code: string | undefined, error: string | undefined) =>
      Effect.gen(function* () {
        const request = pending.get(state);
        pending.delete(state);
        if (!request || Date.now() - request.createdAt > pendingLifetimeMs)
          return yield* Effect.fail(
            new McpOAuthError({ code: "State", message: "The OAuth login has expired" }),
          );
        if (error)
          return yield* Effect.fail(
            new McpOAuthError({
              code: "Exchange",
              message: "The OAuth provider denied login",
              detail: error,
            }),
          );
        if (!code)
          return yield* Effect.fail(
            new McpOAuthError({
              code: "Exchange",
              message: "The OAuth callback did not include a code",
            }),
          );
        const tokenResponse = yield* fetchJson(request.metadata.tokenEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: formBody({
            grant_type: "authorization_code",
            code,
            redirect_uri: request.redirectUri,
            client_id: request.clientId,
            code_verifier: request.verifier,
            ...(request.clientSecret === undefined ? {} : { client_secret: request.clientSecret }),
          }),
        }).pipe(
          Effect.mapError((cause) =>
            oauthError("Exchange", "The OAuth token exchange failed", cause.detail),
          ),
        );
        const token = yield* Effect.try({
          try: () =>
            asToken(
              tokenResponse,
              request.clientId,
              request.metadata.tokenEndpoint,
              request.clientSecret,
            ),
          catch: (cause) =>
            oauthError("Exchange", "The OAuth token response was invalid", String(cause)),
        });
        const encoded = JSON.stringify(token);
        yield* secrets.save(oauthSecretName(request.server.id), Redacted.make(encoded));
        yield* registry.updateAuth(request.server.id, {
          status: "authenticated",
          updatedAt: Date.now(),
        });
      });

    const callbackServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${callbackPort || 80}`);
      if (url.pathname !== callbackPath) {
        reply(response, 404, html("aut OAuth", "Unknown callback path."));
        return;
      }
      const state = url.searchParams.get("state") ?? "";
      Runtime.runPromise(runtime)(
        finish(
          state,
          url.searchParams.get("code") ?? undefined,
          url.searchParams.get("error") ?? undefined,
        ),
      )
        .then(() =>
          reply(response, 200, html("aut OAuth", "Login completed. You can close this window.")),
        )
        .catch((error) =>
          reply(
            response,
            400,
            html("aut OAuth", error instanceof Error ? error.message : "Login failed."),
          ),
        );
    });
    yield* Effect.acquireRelease(
      Effect.async<number, DaemonError>((resume) => {
        const onError = () =>
          resume(
            Effect.fail(
              new DaemonError({
                code: "Transport",
                message: "The OAuth callback server could not start",
              }),
            ),
          );
        callbackServer.once("error", onError);
        callbackServer.listen(0, "127.0.0.1", () => {
          callbackServer.off("error", onError);
          const address = callbackServer.address();
          if (!address || typeof address === "string") {
            resume(
              Effect.fail(
                new DaemonError({
                  code: "Transport",
                  message: "The OAuth callback server did not expose a port",
                }),
              ),
            );
            return;
          }
          callbackPort = address.port;
          resume(Effect.succeed(address.port));
        });
        return Effect.sync(() => callbackServer.off("error", onError));
      }),
      () =>
        Effect.async<void>((resume) => {
          callbackServer.close(() => resume(Effect.void));
        }),
    );

    const start = (id: McpServerId) =>
      Effect.gen(function* () {
        const server = yield* find(id);
        const discovery = yield* discover(server);
        const redirectUri = `http://127.0.0.1:${callbackPort}${callbackPath}`;
        let clientId = server.transport === "stdio" ? undefined : server.oauth?.clientId;
        let clientSecret: string | undefined;
        if (server.transport !== "stdio" && server.oauth?.clientSecretRef)
          clientSecret = Redacted.value(yield* secretReader.resolve(server.oauth.clientSecretRef));
        if (!clientId && discovery.metadata.registrationEndpoint) {
          const registration = yield* fetchJson(discovery.metadata.registrationEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              redirect_uris: [redirectUri],
              client_name: "aut",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none",
            }),
          }).pipe(
            Effect.mapError((cause) =>
              oauthError("Registration", "The OAuth client could not be registered", cause.detail),
            ),
          );
          clientId = stringField(registration, "client_id");
          if (!clientId)
            return yield* Effect.fail(
              new McpOAuthError({
                code: "Registration",
                message: "The OAuth registration response did not include a client ID",
              }),
            );
          const registeredSecret = stringField(registration, "client_secret");
          if (registeredSecret) clientSecret = registeredSecret;
        }
        if (!clientId)
          return yield* Effect.fail(
            new McpOAuthError({
              code: "Registration",
              message: "Configure an OAuth client ID or enable dynamic registration",
            }),
          );
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const state = randomUUID();
        const expiresAt = Date.now() + pendingLifetimeMs;
        pending.set(state, {
          server,
          metadata: discovery.metadata,
          redirectUri,
          verifier,
          clientId,
          ...(clientSecret === undefined ? {} : { clientSecret }),
          createdAt: Date.now(),
        });
        yield* registry.updateAuth(id, {
          status: "required",
          message: "等待 OAuth 登录",
          updatedAt: Date.now(),
        });
        const authorization = new URL(discovery.metadata.authorizationEndpoint);
        authorization.search = new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          scope: "mcp",
        }).toString();
        return {
          serverId: id,
          authorizationUrl: authorization.toString(),
          expiresAt,
        } satisfies McpAuthStartResponse;
      });

    const logout = (id: McpServerId) =>
      Effect.gen(function* () {
        yield* find(id);
        for (const [state, value] of pending) if (value.server.id === id) pending.delete(state);
        yield* secrets.remove(oauthSecretName(id));
        return yield* registry.updateAuth(id, { status: "none", updatedAt: Date.now() });
      });

    return {
      start,
      logout,
      accessToken: (id) =>
        secrets.resolve(`secret:${oauthSecretName(id)}`).pipe(
          Effect.flatMap((value) =>
            Effect.gen(function* () {
              const token = yield* Effect.try({
                try: () => Schema.decodeUnknownSync(StoredToken)(JSON.parse(Redacted.value(value))),
                catch: () =>
                  new DaemonError({
                    code: "Unavailable",
                    message: "The MCP OAuth token is invalid",
                  }),
              });
              if (token.expiresAt === undefined || token.expiresAt > Date.now() + 30_000)
                return Redacted.make(token.accessToken);
              if (token.refreshToken === undefined)
                return yield* Effect.fail(
                  new DaemonError({
                    code: "Unavailable",
                    message: "The MCP OAuth token has expired",
                  }),
                );
              const refreshed = yield* fetchJson(token.tokenEndpoint, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  accept: "application/json",
                },
                body: formBody({
                  grant_type: "refresh_token",
                  refresh_token: token.refreshToken,
                  client_id: token.clientId,
                  ...(token.clientSecret === undefined
                    ? {}
                    : { client_secret: token.clientSecret }),
                }),
              }).pipe(
                Effect.mapError(
                  () =>
                    new DaemonError({
                      code: "Unavailable",
                      message: "The MCP OAuth token refresh failed",
                    }),
                ),
              );
              const next = yield* Effect.try({
                try: () =>
                  asToken(
                    refreshed,
                    token.clientId,
                    token.tokenEndpoint,
                    token.clientSecret,
                    token.refreshToken,
                  ),
                catch: () =>
                  new DaemonError({
                    code: "Unavailable",
                    message: "The MCP OAuth refresh response was invalid",
                  }),
              });
              yield* secrets.save(oauthSecretName(id), Redacted.make(JSON.stringify(next)));
              yield* registry.updateAuth(id, { status: "authenticated", updatedAt: Date.now() });
              return Redacted.make(next.accessToken);
            }),
          ),
        ),
    } satisfies McpOAuth["Type"];
  }),
);

export { oauthSecretName };

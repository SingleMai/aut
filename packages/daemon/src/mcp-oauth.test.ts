import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, CoreLive, McpRegistry } from "@aut/core";
import { Effect, Either, Layer, Redacted } from "effect";
import { afterEach, expect, it } from "vitest";
import { McpOAuth, McpOAuthLive, oauthSecretName } from "./mcp-oauth.js";
import { SecretReaderLive } from "./secret-reader.js";
import { SecretStoreLive } from "./secret-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const readForm = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

it("runs PKCE loopback login, stores only a reference in MCP config, and logs out", async () => {
  let tokenRequest: URLSearchParams | undefined;
  const oauth = createServer(async (request, response) => {
    if (request.url === "/.well-known/oauth-protected-resource") {
      const address = oauth.address();
      if (!address || typeof address === "string") return json(response, 500, {});
      return json(response, 200, { authorization_servers: [`http://127.0.0.1:${address.port}`] });
    }
    if (request.url === "/.well-known/oauth-authorization-server") {
      const address = oauth.address();
      if (!address || typeof address === "string") return json(response, 500, {});
      return json(response, 200, {
        authorization_endpoint: `http://127.0.0.1:${address.port}/authorize`,
        token_endpoint: `http://127.0.0.1:${address.port}/token`,
      });
    }
    if (request.url === "/token") {
      tokenRequest = await readForm(request);
      return json(response, 200, {
        access_token: "oauth-access-fixture",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return json(response, 404, {});
  });
  await new Promise<void>((resolve) => oauth.listen(0, "127.0.0.1", resolve));
  const address = oauth.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture did not start");
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-oauth-"));
  directories.push(dataDirectory);
  const base = Layer.merge(
    CoreLive({ dataDirectory }),
    SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive({ dataDirectory }))),
  );
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* McpRegistry;
          const server = yield* registry.create({
            name: "OAuth fixture",
            transport: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
            oauth: { clientId: "fixture-client" },
          });
          const auth = yield* McpOAuth;
          const started = yield* auth.start(server.id);
          const authorization = new URL(started.authorizationUrl);
          const redirect = authorization.searchParams.get("redirect_uri");
          const state = authorization.searchParams.get("state");
          if (!redirect || !state)
            return yield* Effect.dieMessage("Missing OAuth callback parameters");
          const callback = yield* Effect.tryPromise(() =>
            fetch(`${redirect}?code=fixture-code&state=${encodeURIComponent(state)}`),
          );
          expect(callback.status).toBe(200);
          expect(tokenRequest?.get("code_verifier")).toBeTruthy();
          expect(tokenRequest?.get("client_id")).toBe("fixture-client");
          const authenticated = yield* registry.get(server.id);
          if (authenticated._tag === "None")
            return yield* Effect.dieMessage("Missing authenticated server");
          const token = yield* auth.accessToken(server.id);
          const config = yield* (yield* ConfigStore).readMcp;
          const stored = readFileSync(join(dataDirectory, "secrets.json"), "utf8");
          const loggedOut = yield* auth.logout(server.id);
          const unavailable = yield* Effect.either(auth.accessToken(server.id));
          return {
            authenticated: authenticated.value,
            token,
            config,
            stored,
            loggedOut,
            unavailable,
          };
        }).pipe(Effect.provide(McpOAuthLive.pipe(Layer.provideMerge(base)))),
      ),
    );
    expect(result.authenticated.auth.status).toBe("authenticated");
    expect(Redacted.value(result.token)).toBe("oauth-access-fixture");
    expect(result.config.servers[0]?.auth.status).toBe("authenticated");
    expect(result.stored).toContain("oauth-access-fixture");
    expect(result.stored).toContain(oauthSecretName(result.authenticated.id));
    expect(result.loggedOut.auth.status).toBe("none");
    expect(Either.isLeft(result.unavailable)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => oauth.close(() => resolve()));
  }
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, CoreLive, McpRegistry } from "@aut/core";
import { Effect, Either, Fiber, Layer, Redacted } from "effect";
import { afterEach, expect, it } from "vitest";
import { McpOAuth, McpOAuthLive, oauthSecretName } from "./mcp-oauth.js";
import { SecretReaderLive } from "./secret-reader.js";
import { SecretStore, SecretStoreLive } from "./secret-store.js";

const directories: string[] = [];
const latch = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it.each([
  ["exchange", "logout"],
  ["exchange", "update"],
  ["exchange", "remove"],
  ["exchange", "new-login"],
  ["refresh", "logout"],
  ["refresh", "update"],
  ["refresh", "remove"],
  ["refresh", "new-login"],
] as const)("does not restore credentials from a late %s after %s", async (phase, action) => {
  const requested = latch();
  const release = latch();
  const provider = createServer(async (request, response) => {
    const address = provider.address();
    if (!address || typeof address === "string") return json(response, 500, {});
    const origin = `http://127.0.0.1:${address.port}`;
    if (request.url === "/.well-known/oauth-protected-resource")
      return json(response, 200, { authorization_servers: [origin] });
    if (request.url === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
      });
    if (request.url === "/token") {
      const form = await readForm(request);
      if (phase === "exchange" || form.get("grant_type") === "refresh_token") {
        requested.resolve();
        await release.promise;
      }
      return json(response, 200, {
        access_token: "late-access-fixture",
        refresh_token: "refresh-fixture",
        expires_in: phase === "refresh" ? 0 : 3600,
      });
    }
    return json(response, 404, {});
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture did not start");
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-mcp-oauth-race-"));
  directories.push(dataDirectory);
  const base = Layer.merge(
    CoreLive({ dataDirectory }),
    SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive({ dataDirectory }))),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* McpRegistry;
          const secrets = yield* SecretStore;
          const auth = yield* McpOAuth;
          const input = {
            name: "race-fixture",
            transport: "http" as const,
            url: `http://127.0.0.1:${address.port}/mcp`,
            oauth: { clientId: "fixture" },
          };
          const server = yield* registry.create(input);
          const authorization = new URL((yield* auth.start(server.id)).authorizationUrl);
          const callback = Effect.tryPromise(() =>
            fetch(
              `${authorization.searchParams.get("redirect_uri")}?code=fixture&state=${authorization.searchParams.get("state")}`,
            ),
          );
          if (phase === "refresh") expect((yield* callback).status).toBe(200);
          const inFlight = yield* (
            phase === "exchange"
              ? callback.pipe(Effect.map((response) => response.status === 200))
              : auth.accessToken(server.id).pipe(Effect.either, Effect.map(Either.isRight))
          ).pipe(Effect.fork);
          yield* Effect.tryPromise(() => requested.promise);
          if (action === "logout") yield* auth.logout(server.id);
          if (action === "update") {
            yield* registry.update(server.id, { ...input, url: `${input.url}/changed` });
            yield* auth.logout(server.id);
          }
          if (action === "remove") {
            yield* auth.logout(server.id);
            yield* registry.remove(server.id);
          }
          if (action === "new-login") yield* auth.start(server.id);
          release.resolve();
          expect(yield* Fiber.join(inFlight)).toBe(false);
          const current = yield* registry.get(server.id);
          if (current._tag === "Some")
            expect(current.value.auth.status).toBe(action === "new-login" ? "required" : "none");
          if (action !== "new-login")
            expect(
              Either.isLeft(
                yield* Effect.either(secrets.resolve(`secret:${oauthSecretName(server.id)}`)),
              ),
            ).toBe(true);
        }).pipe(
          Effect.ensuring(Effect.sync(release.resolve)),
          Effect.provide(McpOAuthLive.pipe(Layer.provideMerge(base))),
          Effect.timeout("5 seconds"),
        ),
      ),
    );
  } finally {
    release.resolve();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
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

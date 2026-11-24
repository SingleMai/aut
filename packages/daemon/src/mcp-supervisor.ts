import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError, McpRegistry } from "@aut/core";
import type { ExternalMcpConnection } from "@aut/mcp-bridge";
import {
  connectExternalMcp,
  type ExternalMcpError,
  type McpProxyCredentials,
  mcpProxyServerConfig,
} from "@aut/mcp-bridge";
import {
  type BotId,
  JsonRecord,
  type McpServer,
  type McpServerConfig,
  McpServerId,
  type McpTool,
  NonEmptyString,
} from "@aut/protocol";
import { Context, Effect, Exit, Layer, Redacted, Runtime, Schedule, Schema, Scope } from "effect";
import type { DaemonError } from "./errors.js";
import { McpOAuth } from "./mcp-oauth.js";
import { SecretReader } from "./secret-reader.js";

const proxyBodyLimit = 1024 * 1024;
const ProxyCallInput = Schema.Struct({
  serverId: McpServerId,
  tool: NonEmptyString,
  arguments: JsonRecord,
});

type ProxyRegistration = {
  readonly taskId: string;
  readonly botId: BotId;
  readonly serverId: McpServerId;
  readonly allowedTools: ReadonlySet<string>;
};

type ManagedConnection = {
  readonly connection: ExternalMcpConnection;
  readonly scope: Scope.CloseableScope;
  readonly fingerprint: string;
  readonly serverId: McpServerId;
};

const coreError = (message: string, detail?: string) =>
  new CoreError({ code: "Configuration", message, ...(detail === undefined ? {} : { detail }) });

const externalError = (error: ExternalMcpError) => coreError(error.message, error.detail);

const resolveRecord = (reader: SecretReader["Type"], values?: Readonly<Record<string, string>>) =>
  Effect.all(
    Object.entries(values ?? {}).map(([key, value]) =>
      (value.startsWith("secret:") || value.startsWith("env:")
        ? reader.resolve(value).pipe(Effect.map(Redacted.value))
        : Effect.succeed(value)
      ).pipe(Effect.map((resolved) => [key, resolved] as const)),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

const runtimeConfig = (
  server: McpServer,
  reader: SecretReader["Type"],
  oauth: McpOAuth["Type"],
): Effect.Effect<McpServerConfig, DaemonError | CoreError> => {
  if (server.transport === "stdio")
    return resolveRecord(reader, server.env).pipe(
      Effect.map(
        (env) =>
          ({
            name: server.name,
            transport: "stdio" as const,
            command: server.command,
            args: [...server.args],
            ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
            ...(Object.keys(env).length === 0 ? {} : { env }),
          }) satisfies McpServerConfig,
      ),
    );
  return resolveRecord(reader, server.headers).pipe(
    Effect.flatMap((headers) =>
      server.auth.status === "authenticated"
        ? oauth.accessToken(server.id).pipe(
            Effect.map((token) => ({
              ...headers,
              authorization: `Bearer ${Redacted.value(token)}`,
            })),
          )
        : Effect.succeed(headers),
    ),
    Effect.map(
      (headers) =>
        ({
          name: server.name,
          transport: server.transport,
          url: server.url,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        }) satisfies McpServerConfig,
    ),
  );
};

const readBody = (request: IncomingMessage) =>
  Effect.async<string, CoreError>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: CoreError) => {
      cleanup();
      request.resume();
      resume(Effect.fail(error));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > proxyBodyLimit) {
        fail(coreError("The MCP proxy request is too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
    };
    const onError = () => fail(coreError("The MCP proxy request could not be read"));
    const onAborted = () => fail(coreError("The MCP proxy request was interrupted"));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    return Effect.sync(cleanup);
  });

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

export class McpSupervisor extends Context.Tag("aut/McpSupervisor")<
  McpSupervisor,
  {
    readonly list: Effect.Effect<ReadonlyArray<McpServer>, CoreError>;
    readonly create: McpRegistry["Type"]["create"];
    readonly update: McpRegistry["Type"]["update"];
    readonly remove: McpRegistry["Type"]["remove"];
    readonly setEnabled: McpRegistry["Type"]["setEnabled"];
    readonly listGrants: McpRegistry["Type"]["listGrants"];
    readonly setGrant: McpRegistry["Type"]["setGrant"];
    readonly authStart: McpOAuth["Type"]["start"];
    readonly authLogout: McpOAuth["Type"]["logout"];
    readonly restart: (id: McpServerId) => Effect.Effect<McpServer, CoreError>;
    readonly test: (id: McpServerId) => Effect.Effect<McpServer, CoreError>;
    readonly configsForBot: (
      taskId: string,
      botId: BotId,
    ) => Effect.Effect<ReadonlyArray<McpServerConfig>, CoreError, Scope.Scope>;
  }
>() {}

export const McpSupervisorLive = Layer.scoped(
  McpSupervisor,
  Effect.gen(function* () {
    const registry = yield* McpRegistry;
    const reader = yield* SecretReader;
    const oauth = yield* McpOAuth;
    const runtime = yield* Effect.runtime<never>();
    const lock = yield* Effect.makeSemaphore(1);
    const connections = new Map<string, ManagedConnection>();
    const failedUntil = new Map<string, number>();
    const registrations = new Map<string, ProxyRegistration>();
    const socketDirectory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "aut-mcp-supervisor-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const socketPath = join(socketDirectory, "proxy.sock");
    const handleProxy = (request: IncomingMessage, response: ServerResponse) =>
      Effect.gen(function* () {
        if (request.method !== "POST" || request.url !== "/call") {
          writeJson(response, 404, { error: "Unknown MCP proxy route" });
          return;
        }
        const token = request.headers.authorization?.startsWith("Bearer ")
          ? request.headers.authorization.slice(7)
          : undefined;
        const registration = token === undefined ? undefined : registrations.get(token);
        if (!registration) {
          writeJson(response, 401, { error: "MCP proxy authorization failed" });
          return;
        }
        const input = yield* Schema.decodeUnknown(Schema.parseJson(ProxyCallInput))(
          yield* readBody(request),
        ).pipe(Effect.mapError(() => coreError("The MCP proxy call is invalid")));
        if (
          input.serverId !== registration.serverId ||
          !registration.allowedTools.has(input.tool)
        ) {
          writeJson(response, 403, { error: "The MCP tool is not authorized" });
          return;
        }
        const result = yield* lock
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* findServer(registration.serverId);
              const grant = (yield* registry.listGrants(registration.botId)).find(
                (value) => value.serverId === current.id,
              );
              if (
                !current.enabled ||
                current.auth.status === "required" ||
                current.auth.status === "error" ||
                !grant?.enabled ||
                !grant.allowedTools.includes(input.tool) ||
                !current.tools.some((tool) => tool.name === input.tool)
              ) {
                return yield* Effect.fail(coreError("The MCP tool is no longer authorized"));
              }
              const active = yield* ensure(current, `${registration.botId}:${current.id}`);
              if (!active.tools.some((tool) => tool.name === input.tool))
                return yield* Effect.fail(coreError("The MCP tool is no longer available"));
              return active.connection;
            }),
          )
          .pipe(
            Effect.flatMap((connection) => connection.callTool(input.tool, input.arguments)),
            Effect.map((value) => ({ status: 200, value })),
            Effect.catchAll(() =>
              Effect.succeed({
                status: 200,
                value: {
                  content: [
                    {
                      type: "text",
                      text: "The MCP tool is unavailable. Check its connection and authorization.",
                    },
                  ],
                  isError: true,
                },
              }),
            ),
          );
        writeJson(response, result.status, result.value);
      }).pipe(
        Effect.catchAll((error) => {
          writeJson(response, 400, { error: error.message });
          return Effect.void;
        }),
      );
    const proxyServer = createServer((request, response) => {
      Runtime.runFork(runtime)(handleProxy(request, response));
    });
    yield* Effect.acquireRelease(
      Effect.async<void, CoreError>((resume) => {
        const onError = () =>
          resume(Effect.fail(coreError("The MCP proxy socket could not start")));
        proxyServer.once("error", onError);
        proxyServer.listen(socketPath, () => {
          proxyServer.off("error", onError);
          try {
            chmodSync(socketPath, 0o600);
            resume(Effect.void);
          } catch (error) {
            resume(
              Effect.fail(coreError("The MCP proxy socket could not be secured", String(error))),
            );
          }
        });
        return Effect.sync(() => proxyServer.off("error", onError));
      }),
      () =>
        Effect.async<void>((resume) => {
          proxyServer.close(() => resume(Effect.void));
          proxyServer.closeAllConnections();
        }),
    );

    const findServer = (id: McpServerId) =>
      registry
        .get(id)
        .pipe(
          Effect.flatMap((value) =>
            value._tag === "Some"
              ? Effect.succeed(value.value)
              : Effect.fail(coreError("The MCP server was not found")),
          ),
        );
    const closeConnection = (key: string) =>
      Effect.gen(function* () {
        const managed = connections.get(key);
        connections.delete(key);
        if (managed) yield* Scope.close(managed.scope, Exit.void);
      });
    const invalidate = (id: McpServerId) =>
      Effect.gen(function* () {
        for (const [key, value] of connections)
          if (value.serverId === id) yield* closeConnection(key);
        failedUntil.clear();
      });
    const ensure = (server: McpServer, key: string, force = false) =>
      Effect.gen(function* () {
        if (!force && (failedUntil.get(key) ?? 0) > Date.now())
          return yield* Effect.fail(
            coreError("The MCP server is waiting before reconnecting; test it to retry now"),
          );
        const config = yield* runtimeConfig(server, reader, oauth).pipe(
          Effect.mapError(() => coreError("The MCP server credentials could not be resolved")),
        );
        const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
        let managed = connections.get(key);
        if (managed && managed.fingerprint !== fingerprint) {
          yield* closeConnection(key);
          managed = undefined;
        }
        if (!managed) {
          const connect = Effect.gen(function* () {
            const scope = yield* Scope.make();
            const connection = yield* connectExternalMcp(config).pipe(
              Scope.extend(scope),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
              ),
              Effect.mapError(externalError),
            );
            return { connection, scope, fingerprint, serverId: server.id };
          });
          managed = yield* force
            ? connect
            : connect.pipe(
                Effect.retry(
                  Schedule.exponential("250 millis").pipe(Schedule.intersect(Schedule.recurs(1))),
                ),
              );
          connections.set(key, managed);
        }
        const tools = yield* managed.connection.listTools().pipe(Effect.mapError(externalError));
        yield* registry.updateTools(server.id, tools);
        const next = yield* registry.updateHealth(server.id, {
          status: "ready",
          checkedAt: Date.now(),
        });
        failedUntil.delete(key);
        return { server: next, connection: managed.connection, tools };
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            yield* closeConnection(key);
            failedUntil.set(key, Date.now() + 30_000);
            yield* registry
              .updateHealth(server.id, {
                status: "error",
                checkedAt: Date.now(),
                message: error.message,
              })
              .pipe(Effect.ignore);
          }),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...connections.keys()], closeConnection, { discard: true }),
    );
    const test = (id: McpServerId) =>
      lock.withPermits(1)(
        findServer(id).pipe(
          Effect.flatMap((server) =>
            ensure(server, `test:${id}`, true).pipe(Effect.map((value) => value.server)),
          ),
        ),
      );
    const logout = (id: McpServerId) =>
      Effect.gen(function* () {
        yield* invalidate(id);
        yield* registry.setEnabled(id, false);
        return yield* oauth
          .logout(id)
          .pipe(Effect.mapError(() => coreError("The MCP sign-in could not be cleared")));
      });
    const registerProxy = (
      taskId: string,
      botId: BotId,
      server: McpServer,
      tools: readonly McpTool[],
      allowedTools: readonly string[],
    ) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const token = randomBytes(32).toString("base64url");
          registrations.set(token, {
            taskId,
            botId,
            serverId: server.id,
            allowedTools: new Set(allowedTools),
          });
          return {
            socketPath,
            token: Redacted.make(token),
            serverId: server.id,
            serverName: server.name,
            tools: tools.filter((tool) => allowedTools.includes(tool.name)),
          } satisfies McpProxyCredentials;
        }),
        (credentials) =>
          Effect.sync(() => {
            for (const [token, value] of registrations)
              if (value.serverId === credentials.serverId && value.taskId === taskId)
                registrations.delete(token);
          }),
      );

    return {
      list: registry.list,
      create: registry.create,
      update: (id, input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const previous = yield* findServer(id);
            const changed =
              previous.transport !== input.transport ||
              (input.transport === "stdio"
                ? previous.transport !== "stdio" ||
                  previous.command !== input.command ||
                  JSON.stringify(previous.args) !== JSON.stringify(input.args) ||
                  previous.cwd !== input.cwd ||
                  JSON.stringify(previous.env ?? {}) !== JSON.stringify(input.env ?? {})
                : previous.transport === "stdio" ||
                  previous.url !== input.url ||
                  JSON.stringify(previous.headers ?? {}) !== JSON.stringify(input.headers ?? {}) ||
                  JSON.stringify(previous.oauth ?? {}) !== JSON.stringify(input.oauth ?? {}));
            const updated = yield* registry.update(id, input);
            if (changed) {
              yield* logout(id);
              return yield* findServer(id);
            }
            return updated;
          }),
        ),
      remove: (id) => lock.withPermits(1)(logout(id).pipe(Effect.zipRight(registry.remove(id)))),
      setEnabled: (id, enabled) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* findServer(id);
            if (
              enabled &&
              (current.health.status !== "ready" ||
                ["required", "error"].includes(current.auth.status))
            )
              return yield* Effect.fail(
                new CoreError({
                  code: "InvalidRequest",
                  message: "Test the MCP server and complete sign-in before enabling it",
                }),
              );
            const server = yield* registry.setEnabled(id, enabled);
            if (!enabled) yield* invalidate(id);
            return server;
          }),
        ),
      listGrants: registry.listGrants,
      setGrant: (botId, id, enabled, tools) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const grant = yield* registry.setGrant(botId, id, enabled, tools);
            if (!enabled) yield* closeConnection(`${botId}:${id}`);
            return grant;
          }),
        ),
      authStart: (id) => lock.withPermits(1)(invalidate(id).pipe(Effect.zipRight(oauth.start(id)))),
      authLogout: (id) => lock.withPermits(1)(logout(id)),
      restart: (id) =>
        lock
          .withPermits(1)(invalidate(id))
          .pipe(Effect.zipRight(test(id))),
      test,
      configsForBot: (taskId, botId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const grants = yield* registry.listGrants(botId);
            const configs: McpServerConfig[] = [];
            for (const grant of grants) {
              if (!grant.enabled || grant.allowedTools.length === 0) continue;
              const server = yield* findServer(grant.serverId);
              if (!server.enabled || ["required", "error"].includes(server.auth.status)) continue;
              const current = yield* ensure(server, `${botId}:${server.id}`).pipe(
                Effect.catchAll(() => Effect.succeed(undefined)),
              );
              if (!current) continue;
              const allowedTools = grant.allowedTools.filter((tool) =>
                current.tools.some((entry) => entry.name === tool),
              );
              if (allowedTools.length === 0) continue;
              const credentials = yield* registerProxy(
                taskId,
                botId,
                current.server,
                current.tools,
                allowedTools,
              );
              configs.push(mcpProxyServerConfig(credentials));
            }
            return configs;
          }),
        ),
    };
  }),
);

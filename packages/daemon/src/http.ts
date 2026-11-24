import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  Changes,
  EventBus,
  MainThread,
  MessageFiles,
  SessionReader,
  SessionRecords,
  TaskRegistry,
  TriggerRegistry,
} from "@aut/core";
import {
  AcceptedResponse,
  ApiErrorResponse,
  AutConfig,
  BotConfig,
  BotId,
  BotResponse,
  BotsResponse,
  ConfigResponse,
  CreateTriggerInput,
  DaemonEvent,
  DeletedResponse,
  FILE_BODY_LIMIT,
  FileContentResponse,
  FileId,
  FileLeaseInput,
  FileReleaseResponse,
  FileResponse,
  FileUploadInput,
  HealthResponse,
  ListTasksInput,
  McpAuthStartResponse,
  McpGrantInput,
  McpGrantResponse,
  McpGrantsResponse,
  McpServerId,
  McpServerInput,
  McpServerResponse,
  McpServersResponse,
  McpTestResponse,
  MessageId,
  MessagePageInput,
  MessagePageResponse,
  MessageResponse,
  ReportResponse,
  RequestId,
  RequestResponse,
  RouteTestInput,
  RouteTestResponse,
  SecretSaveInput,
  SecretSaveResponse,
  SecretStatusInput,
  SecretStatusResponse,
  SendMessageInput,
  TaskId,
  TaskListResponse,
  TaskResponse,
  TaskSessionInput,
  TaskSessionResponse,
  TriggerId,
  TriggerResponse,
  TriggerRunsResponse,
  TriggersResponse,
  UiAction,
  UpdateTriggerInput,
} from "@aut/protocol";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Runtime,
  Schema,
  Scope,
} from "effect";
import { WebSocket, WebSocketServer } from "ws";
import { Administration } from "./admin.js";
import { DaemonError, decode, io, publicError } from "./errors.js";
import { InboundGateway } from "./inbound.js";
import { McpSupervisor } from "./mcp-supervisor.js";
import { Authentication } from "./ownership.js";
import { Recovery } from "./recovery.js";
import { RouteTest } from "./route-test.js";
import { SecretReader } from "./secret-reader.js";
import { SecretStore } from "./secret-store.js";

const bodyLimit = 1024 * 1024;
const readBody = (request: IncomingMessage, limit = bodyLimit) =>
  Effect.async<string, DaemonError>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: DaemonError) => {
      cleanup();
      request.resume();
      resume(Effect.fail(error));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(
          new DaemonError({ code: "BodyTooLarge", message: `Request body exceeds ${limit} bytes` }),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
    };
    const onError = () =>
      fail(new DaemonError({ code: "Transport", message: "Request body could not be read" }));
    const onAborted = () =>
      fail(new DaemonError({ code: "Transport", message: "Request body was interrupted" }));
    if (Number(request.headers["content-length"]) > limit) {
      fail(
        new DaemonError({ code: "BodyTooLarge", message: `Request body exceeds ${limit} bytes` }),
      );
      return;
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    return Effect.sync(cleanup);
  });

const body = <A, I>(request: IncomingMessage, schema: Schema.Schema<A, I>) =>
  readBody(request).pipe(Effect.flatMap((contents) => decode(Schema.parseJson(schema), contents)));

const respond = <A, I>(
  response: ServerResponse,
  status: number,
  schema: Schema.Schema<A, I>,
  value: NoInfer<A>,
) =>
  Schema.encode(Schema.parseJson(schema))(value).pipe(
    Effect.flatMap((json) =>
      io("Failed to write HTTP response", () => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(json);
      }),
    ),
  );

const bearer = (request: IncomingMessage) =>
  request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice(7)
    : undefined;
const parseUrl = (request: IncomingMessage) =>
  Effect.try({
    try: () => new URL(request.url ?? "/", "http://127.0.0.1"),
    catch: () => new DaemonError({ code: "Validation", message: "Invalid request URL" }),
  });
const pathId = (value: string) =>
  Effect.try({
    try: () => decodeURIComponent(value),
    catch: () => new DaemonError({ code: "Validation", message: "Invalid path identifier" }),
  });

const shutdown = (server: Server, sockets: WebSocketServer) =>
  Effect.async<void>((resume) => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
    server.closeAllConnections();
  });

export class HttpServer extends Context.Tag("aut/HttpServer")<
  HttpServer,
  { readonly host: "127.0.0.1"; readonly port: number }
>() {}

export const HttpServerLive = (port = 4317) =>
  Layer.scoped(
    HttpServer,
    Effect.gen(function* () {
      yield* Recovery;
      const auth = yield* Authentication;
      const inbound = yield* InboundGateway;
      const admin = yield* Administration;
      const routeTest = yield* RouteTest;
      const secrets = yield* SecretStore;
      const secretReader = yield* SecretReader;
      const thread = yield* MainThread;
      const files = yield* MessageFiles;
      const tasks = yield* TaskRegistry;
      const triggers = yield* TriggerRegistry;
      const sessions = yield* SessionReader;
      const records = yield* SessionRecords;
      const mcp = yield* McpSupervisor;
      const bus = yield* EventBus;
      const changes = yield* Changes;
      const runtime = yield* Effect.runtime<never>();
      const scope = yield* Scope.Scope;

      const route = (request: IncomingMessage, response: ServerResponse) =>
        Effect.gen(function* () {
          if (!auth.matches(bearer(request)))
            return yield* Effect.fail(
              new DaemonError({
                code: "Unauthorized",
                message: "Local authentication is required",
              }),
            );
          const url = yield* parseUrl(request);
          const method = request.method ?? "GET";
          const path = url.pathname;
          const rawQuery: Record<string, unknown> = Object.fromEntries(url.searchParams);
          if (Object.keys(rawQuery).length !== Array.from(url.searchParams).length)
            return yield* Effect.fail(
              new DaemonError({
                code: "Validation",
                message: "Duplicate query parameters are not supported",
              }),
            );
          if (
            !(
              method === "GET" &&
              (path === "/v1/messages" ||
                path === "/v1/tasks" ||
                path === "/v1/secrets/status" ||
                /^\/v1\/tasks\/[^/]+\/session$/.test(path))
            )
          )
            yield* decode(Schema.Record({ key: Schema.String, value: Schema.Never }), rawQuery);
          if (method === "GET" && path === "/v1/health")
            return yield* respond(response, 200, HealthResponse, { status: "ok" });
          if (method === "POST" && path === "/v1/files") {
            const input = yield* readBody(request, FILE_BODY_LIMIT).pipe(
              Effect.flatMap((value) => decode(Schema.parseJson(FileUploadInput), value)),
            );
            return yield* respond(response, 201, FileResponse, {
              file: yield* files.upload(input),
            });
          }
          if (method === "POST" && path === "/v1/files/keepalive") {
            const input = yield* body(request, FileLeaseInput);
            yield* files.renew(input.ids);
            return yield* respond(response, 200, AcceptedResponse, { accepted: true });
          }
          const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
          if (method === "DELETE" && fileMatch?.[1]) {
            const id = yield* decode(FileId, yield* pathId(fileMatch[1]));
            return yield* respond(response, 200, FileReleaseResponse, {
              released: yield* files.discard(id),
            });
          }
          if (method === "GET" && fileMatch?.[1]) {
            const id = yield* decode(FileId, yield* pathId(fileMatch[1]));
            return yield* respond(response, 200, FileContentResponse, yield* files.read(id));
          }
          if (method === "POST" && path === "/v1/route-test")
            return yield* respond(
              response,
              200,
              RouteTestResponse,
              yield* routeTest.run(yield* body(request, RouteTestInput)),
            );
          if (method === "GET" && path === "/v1/messages") {
            const raw = { ...rawQuery };
            if (raw.limit !== undefined) raw.limit = Number(raw.limit);
            const query = yield* decode(MessagePageInput, raw);
            const messages = yield* thread.page({
              ...(query.before === undefined ? {} : { before: query.before }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            });
            return yield* respond(response, 200, MessagePageResponse, { messages });
          }
          if (method === "POST" && path === "/v1/messages") {
            const result = yield* inbound.message(yield* body(request, SendMessageInput));
            return yield* respond(response, result.created ? 201 : 200, MessageResponse, {
              message: result.message,
            });
          }
          const undoCreation = /^\/v1\/messages\/([^/]+)\/undo-bot-creation$/.exec(path);
          if (method === "POST" && undoCreation?.[1]) {
            const id = yield* decode(MessageId, yield* pathId(undoCreation[1]));
            return yield* respond(response, 200, MessageResponse, {
              message: yield* admin.undoBotCreation(id),
            });
          }
          if (method === "POST" && path === "/v1/actions") {
            yield* inbound.action(yield* body(request, UiAction));
            return yield* respond(response, 202, AcceptedResponse, { accepted: true });
          }
          if (method === "GET" && path === "/v1/triggers")
            return yield* respond(response, 200, TriggersResponse, {
              triggers: yield* triggers.list(),
            });
          if (method === "POST" && path === "/v1/triggers")
            return yield* respond(response, 201, TriggerResponse, {
              trigger: yield* triggers.create(yield* body(request, CreateTriggerInput)),
            });
          const triggerRunsMatch = /^\/v1\/triggers\/([^/]+)\/runs$/.exec(path);
          if (method === "GET" && triggerRunsMatch?.[1]) {
            const id = yield* decode(TriggerId, yield* pathId(triggerRunsMatch[1]));
            return yield* respond(response, 200, TriggerRunsResponse, {
              runs: yield* triggers.listRuns(id),
            });
          }
          const triggerLifecycle = /^\/v1\/triggers\/([^/]+)\/(pause|resume)$/.exec(path);
          if (method === "POST" && triggerLifecycle?.[1] && triggerLifecycle[2]) {
            const id = yield* decode(TriggerId, yield* pathId(triggerLifecycle[1]));
            return yield* respond(response, 200, TriggerResponse, {
              trigger: yield* triggers.update(id, { enabled: triggerLifecycle[2] === "resume" }),
            });
          }
          const triggerMatch = /^\/v1\/triggers\/([^/]+)$/.exec(path);
          if (method === "PUT" && triggerMatch?.[1]) {
            const id = yield* decode(TriggerId, yield* pathId(triggerMatch[1]));
            return yield* respond(response, 200, TriggerResponse, {
              trigger: yield* triggers.update(id, yield* body(request, UpdateTriggerInput)),
            });
          }
          if (method === "GET" && path === "/v1/tasks") {
            const raw = { ...rawQuery };
            if (raw.limit !== undefined) raw.limit = Number(raw.limit);
            if (typeof raw.status === "string") raw.status = raw.status.split(",");
            const query = yield* decode(ListTasksInput, raw);
            return yield* respond(response, 200, TaskListResponse, {
              tasks: yield* tasks.list(query),
            });
          }
          const sessionMatch = /^\/v1\/tasks\/([^/]+)\/session$/.exec(path);
          if (method === "GET" && sessionMatch?.[1]) {
            const id = yield* decode(TaskId, yield* pathId(sessionMatch[1]));
            const raw = { ...rawQuery };
            if (raw.limit !== undefined) raw.limit = Number(raw.limit);
            const query = yield* decode(TaskSessionInput, raw);
            return yield* respond(
              response,
              200,
              TaskSessionResponse,
              yield* sessions.read(id, query),
            );
          }
          const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(path);
          if (method === "GET" && taskMatch?.[1]) {
            const id = yield* decode(TaskId, yield* pathId(taskMatch[1]));
            const task = yield* tasks.get(id);
            if (Option.isNone(task))
              return yield* Effect.fail(
                new DaemonError({ code: "NotFound", message: "Unknown task" }),
              );
            return yield* respond(response, 200, TaskResponse, { task: task.value });
          }
          const requestMatch = /^\/v1\/requests\/([^/]+)$/.exec(path);
          if (method === "GET" && requestMatch?.[1]) {
            const id = yield* decode(RequestId, yield* pathId(requestMatch[1]));
            return yield* respond(response, 200, RequestResponse, yield* records.readRequest(id));
          }
          const reportMatch = /^\/v1\/reports\/([^/]+)$/.exec(path);
          if (method === "GET" && reportMatch?.[1]) {
            const ref = yield* pathId(reportMatch[1]);
            return yield* respond(response, 200, ReportResponse, yield* records.readReport(ref));
          }
          if (method === "GET" && path === "/v1/bots")
            return yield* respond(response, 200, BotsResponse, { bots: yield* admin.bots });
          if (method === "POST" && path === "/v1/bots")
            return yield* respond(response, 201, BotResponse, {
              bot: yield* admin.createBot(yield* body(request, BotConfig)),
            });
          const botMatch = /^\/v1\/bots\/([^/]+)$/.exec(path);
          if (botMatch?.[1] && (method === "PUT" || method === "DELETE")) {
            const id = yield* decode(BotId, yield* pathId(botMatch[1]));
            if (method === "PUT")
              return yield* respond(response, 200, BotResponse, {
                bot: yield* admin.updateBot(id, yield* body(request, BotConfig)),
              });
            yield* admin.deleteBot(id);
            return yield* respond(response, 200, DeletedResponse, { deleted: true });
          }
          if (method === "GET" && path === "/v1/mcp/servers")
            return yield* respond(response, 200, McpServersResponse, { servers: yield* mcp.list });
          if (method === "POST" && path === "/v1/mcp/servers")
            return yield* respond(response, 201, McpServerResponse, {
              server: yield* mcp.create(yield* body(request, McpServerInput)),
            });
          const mcpServerAction = /^\/v1\/mcp\/servers\/([^/]+)\/(test|enable|disable)$/.exec(path);
          if (mcpServerAction?.[1] && mcpServerAction[2]) {
            const id = yield* decode(McpServerId, yield* pathId(mcpServerAction[1]));
            if (method === "POST" && mcpServerAction[2] === "test")
              return yield* respond(response, 200, McpTestResponse, {
                server: yield* mcp.test(id),
              });
            if (method === "POST")
              return yield* respond(response, 200, McpServerResponse, {
                server: yield* mcp.setEnabled(id, mcpServerAction[2] === "enable"),
              });
          }
          const mcpAuthAction = /^\/v1\/mcp\/servers\/([^/]+)\/auth\/(start|logout)$/.exec(path);
          if (method === "POST" && mcpAuthAction?.[1] && mcpAuthAction[2]) {
            const id = yield* decode(McpServerId, yield* pathId(mcpAuthAction[1]));
            if (mcpAuthAction[2] === "start")
              return yield* respond(response, 200, McpAuthStartResponse, yield* mcp.authStart(id));
            return yield* respond(response, 200, McpServerResponse, {
              server: yield* mcp.authLogout(id),
            });
          }
          const mcpServerMatch = /^\/v1\/mcp\/servers\/([^/]+)$/.exec(path);
          if (mcpServerMatch?.[1] && (method === "PUT" || method === "DELETE")) {
            const id = yield* decode(McpServerId, yield* pathId(mcpServerMatch[1]));
            if (method === "PUT")
              return yield* respond(response, 200, McpServerResponse, {
                server: yield* mcp.update(id, yield* body(request, McpServerInput)),
              });
            yield* mcp.remove(id);
            return yield* respond(response, 200, DeletedResponse, { deleted: true });
          }
          const mcpGrantsMatch = /^\/v1\/bots\/([^/]+)\/mcp-grants(?:\/([^/]+))?$/.exec(path);
          if (mcpGrantsMatch?.[1]) {
            const botId = yield* decode(BotId, yield* pathId(mcpGrantsMatch[1]));
            if (method === "GET" && !mcpGrantsMatch[2])
              return yield* respond(response, 200, McpGrantsResponse, {
                grants: yield* mcp.listGrants(botId),
              });
            if (method === "PUT" && mcpGrantsMatch[2]) {
              const serverId = yield* decode(McpServerId, yield* pathId(mcpGrantsMatch[2]));
              const input = yield* body(request, McpGrantInput);
              return yield* respond(response, 200, McpGrantResponse, {
                grant: yield* mcp.setGrant(botId, serverId, input.enabled, input.allowedTools),
              });
            }
          }
          if (path === "/v1/secrets" && method === "POST") {
            const input = yield* body(request, SecretSaveInput);
            return yield* respond(
              response,
              200,
              SecretSaveResponse,
              yield* secrets.save(input.name, Redacted.make(input.key)),
            );
          }
          if (path === "/v1/secrets/status" && method === "GET") {
            const { ref } = yield* decode(SecretStatusInput, rawQuery);
            const status = ref.startsWith("secret:")
              ? yield* secrets.status(ref)
              : {
                  apiKeyRef: ref,
                  configured: yield* secretReader.resolve(ref).pipe(
                    Effect.as(true),
                    Effect.catchAll(() => Effect.succeed(false)),
                  ),
                };
            return yield* respond(response, 200, SecretStatusResponse, status);
          }
          if (path === "/v1/config" && method === "GET")
            return yield* respond(response, 200, ConfigResponse, yield* admin.config);
          if (path === "/v1/config" && method === "PUT")
            return yield* respond(
              response,
              200,
              ConfigResponse,
              yield* admin.setConfig(yield* body(request, AutConfig)),
            );
          return yield* Effect.fail(
            new DaemonError({ code: "NotFound", message: "Unknown API route" }),
          );
        });

      const handle = (request: IncomingMessage, response: ServerResponse) =>
        route(request, response).pipe(
          Effect.catchAllCause((cause) => {
            const error = publicError(Option.getOrUndefined(Cause.failureOption(cause)));
            return respond(response, error.status, ApiErrorResponse, { error: error.error }).pipe(
              Effect.catchAll(() => Effect.void),
            );
          }),
        );

      const websocketSession = (socket: WebSocket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* bus.subscribe;
            const changed = yield* changes.subscribe;
            const closed = Effect.async<void>((resume) => {
              if (
                socket.readyState === WebSocket.CLOSED ||
                socket.readyState === WebSocket.CLOSING
              ) {
                resume(Effect.void);
                return;
              }
              const done = () => resume(Effect.void);
              socket.once("close", done);
              socket.once("error", done);
              return Effect.sync(() => {
                socket.off("close", done);
                socket.off("error", done);
              });
            });
            const send = (frame: DaemonEvent) =>
              Effect.gen(function* () {
                const data = yield* Schema.encode(Schema.parseJson(DaemonEvent))(frame);
                yield* Effect.async<void, DaemonError>((resume) => {
                  if (socket.readyState !== WebSocket.OPEN) {
                    resume(
                      Effect.fail(
                        new DaemonError({ code: "Transport", message: "WebSocket is closed" }),
                      ),
                    );
                    return;
                  }
                  socket.send(data, (error) =>
                    resume(
                      error
                        ? Effect.fail(
                            new DaemonError({
                              code: "Transport",
                              message: "WebSocket send failed",
                            }),
                          )
                        : Effect.void,
                    ),
                  );
                });
              });
            const forward = Effect.all(
              [
                Effect.forever(
                  Queue.take(subscription).pipe(
                    Effect.flatMap((event) => send({ type: "event", event })),
                  ),
                ),
                Effect.forever(Queue.take(changed).pipe(Effect.flatMap(send))),
              ],
              { concurrency: "unbounded" },
            );
            yield* Effect.raceFirst(forward, closed);
          }),
        ).pipe(Effect.catchAll(() => Effect.void));

      const rejectUpgrade = (socket: Duplex, status: number) =>
        io("Failed to reject WebSocket upgrade", () =>
          socket.end(
            `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          ),
        );
      const server = createServer((request, response) => {
        Runtime.runFork(runtime)(Effect.forkIn(handle(request, response), scope));
      });
      const sockets = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has("aut") ? "aut" : false),
      });
      yield* Effect.addFinalizer(() => shutdown(server, sockets));
      server.on("upgrade", (request, socket, head) => {
        const upgrade = Effect.gen(function* () {
          const url = yield* parseUrl(request);
          const protocols =
            request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ??
            [];
          const tokenProtocol = protocols.find((value) => value.startsWith("aut-token."));
          if (url.pathname !== "/v1/events" || url.search !== "")
            return yield* rejectUpgrade(socket, 404);
          if (
            !auth.matches(bearer(request)) &&
            !auth.matches(tokenProtocol?.slice("aut-token.".length))
          )
            return yield* rejectUpgrade(socket, 401);
          yield* io("Failed to upgrade WebSocket", () =>
            sockets.handleUpgrade(request, socket, head, (client) => {
              Runtime.runFork(runtime)(Effect.forkIn(websocketSession(client), scope));
            }),
          );
        }).pipe(
          Effect.catchAll(() =>
            rejectUpgrade(socket, 400).pipe(Effect.catchAll(() => Effect.void)),
          ),
        );
        Runtime.runFork(runtime)(Effect.forkIn(upgrade, scope));
      });
      yield* Effect.async<void, DaemonError>((resume) => {
        const error = () =>
          resume(
            Effect.fail(
              new DaemonError({
                code: "Transport",
                message: "Could not listen on the local daemon port",
              }),
            ),
          );
        server.once("error", error);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", error);
          resume(Effect.void);
        });
        return Effect.sync(() => server.off("error", error));
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        return yield* Effect.fail(
          new DaemonError({ code: "Transport", message: "Local daemon address is unavailable" }),
        );
      return { host: "127.0.0.1" as const, port: address.port };
    }),
  );

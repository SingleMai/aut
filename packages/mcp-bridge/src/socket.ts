// Identity forwarding and uncertain-delivery policy follow OpenMausBot's
// server/harness-mcp-request.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Design reference only; implemented independently with Effect. See NOTICE.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import {
  CreateBotInput,
  CreateBotOutput,
  CreateTriggerInput,
  CreateTriggerOutput,
  GetTaskInput,
  GetTaskOutput,
  GetTriggerInput,
  GetTriggerOutput,
  JsonValue,
  ListTasksInput,
  ListTasksOutput,
  ListTriggerRunsInput,
  ListTriggerRunsOutput,
  ListTriggersInput,
  ListTriggersOutput,
  McpInfoInput,
  McpInfoOutput,
  McpServerToolInput,
  McpServerToolOutput,
  NonEmptyString,
  PositiveInteger,
  ProposeRouteInput,
  ProposeRouteOutput,
  ReadMainThreadInput,
  ReadMainThreadOutput,
  ReadTaskSessionInput,
  ReadTaskSessionOutput,
  UpdateTriggerOutput,
  UpdateTriggerToolInput,
} from "@aut/protocol";
import { Effect, Fiber, Redacted, Runtime, Schema, type Scope } from "effect";
import { BridgeBackend, BridgeError, SessionIdentity } from "./interface.js";

export const BRIDGE_MAX_INPUT_BYTES = 1_048_576;
export const BRIDGE_MAX_OUTPUT_BYTES = 16_777_216;
const ErrorCode = Schema.Literal(
  "Unauthorized",
  "Forbidden",
  "InvalidInput",
  "Conflict",
  "NotFound",
  "Unavailable",
  "Indeterminate",
);
const WireReply = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), value: JsonValue }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: ErrorCode, message: Schema.String }),
  }),
);
export const BridgeCall = Schema.Union(
  Schema.Struct({
    tool: Schema.Literal("read_task_session"),
    input: ReadTaskSessionInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("mcp_info"),
    input: McpInfoInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("mcp_server"),
    input: McpServerToolInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("create_bot"),
    input: CreateBotInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("create_trigger"),
    input: CreateTriggerInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("get_trigger"),
    input: GetTriggerInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("list_triggers"),
    input: ListTriggersInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("list_trigger_runs"),
    input: ListTriggerRunsInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("update_trigger"),
    input: UpdateTriggerToolInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("read_main_thread"),
    input: ReadMainThreadInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("list_tasks"),
    input: ListTasksInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("get_task"),
    input: GetTaskInput,
    requestId: NonEmptyString,
  }),
  Schema.Struct({
    tool: Schema.Literal("propose_route"),
    input: ProposeRouteInput,
    requestId: NonEmptyString,
  }),
);
export type BridgeCall = typeof BridgeCall.Type;
const checked = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new BridgeError({ code: "InvalidInput", message: "Bridge data failed schema validation." }),
    ),
  );
const unavailable = () =>
  new BridgeError({ code: "Unavailable", message: "The local MCP bridge is unavailable." });
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const validPath = (socketPath: string) =>
  checked(
    NonEmptyString.pipe(
      Schema.filter(
        (value) => value.startsWith("/") && !value.includes("\0") && Buffer.byteLength(value) < 104,
      ),
    ),
    socketPath,
  ).pipe(
    Effect.mapError(
      () =>
        new BridgeError({
          code: "InvalidInput",
          message: "The Unix socket path must be absolute and shorter than 104 bytes.",
        }),
    ),
  );

const readBody = (incoming: IncomingMessage, limit: number): Effect.Effect<unknown, BridgeError> =>
  Effect.async((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        incoming.off("data", onData);
        incoming.resume();
        resume(
          Effect.fail(
            new BridgeError({
              code: "InvalidInput",
              message: "Bridge message exceeded its byte limit.",
            }),
          ),
        );
      } else chunks.push(chunk);
    };
    const onEnd = () =>
      resume(
        Effect.try({
          try: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          catch: () =>
            new BridgeError({ code: "InvalidInput", message: "Bridge message is not valid JSON." }),
        }),
      );
    const onError = () => resume(Effect.fail(unavailable()));
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
    incoming.once("aborted", onError);
    return Effect.sync(() => {
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
      incoming.off("aborted", onError);
    });
  });

export interface BridgeCredentials {
  readonly socketPath: string;
  readonly token: Redacted.Redacted<string>;
}
export interface BridgeSocket {
  readonly socketPath: string;
  readonly register: (
    identity: SessionIdentity,
  ) => Effect.Effect<BridgeCredentials, BridgeError, Scope.Scope>;
  readonly revoke: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
}

export const makeBridgeSocket = (options: {
  readonly socketPath: string;
}): Effect.Effect<BridgeSocket, BridgeError, Scope.Scope | BridgeBackend> =>
  Effect.gen(function* () {
    const socketPath = yield* validPath(options.socketPath);
    const backend = yield* BridgeBackend;
    const runtime = yield* Effect.runtime<never>();
    const sessions = new Map<string, SessionIdentity>();
    const connections = new Set<Socket>();
    const fibers = new Set<Fiber.RuntimeFiber<void, never>>();
    const dispatch = (identity: SessionIdentity, call: BridgeCall) => {
      switch (call.tool) {
        case "read_task_session":
          return backend
            .readTaskSession(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(ReadTaskSessionOutput, output)));
        case "mcp_info":
          return backend
            .mcpInfo(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(McpInfoOutput, output)));
        case "mcp_server":
          return backend
            .mcpServer(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(McpServerToolOutput, output)));
        case "read_main_thread":
          return backend
            .readMainThread(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(ReadMainThreadOutput, output)));
        case "list_tasks":
          return backend
            .listTasks(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(ListTasksOutput, output)));
        case "create_bot":
          return backend
            .createBot(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(CreateBotOutput, output)));
        case "create_trigger":
          return backend
            .createTrigger(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(CreateTriggerOutput, output)));
        case "get_trigger":
          return backend
            .getTrigger(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(GetTriggerOutput, output)));
        case "list_triggers":
          return backend
            .listTriggers(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(ListTriggersOutput, output)));
        case "list_trigger_runs":
          return backend
            .listTriggerRuns(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(ListTriggerRunsOutput, output)));
        case "update_trigger":
          return backend
            .updateTrigger(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(UpdateTriggerOutput, output)));
        case "get_task":
          return backend
            .getTask(identity, call.input)
            .pipe(Effect.flatMap((output) => checked(GetTaskOutput, output)));
        case "propose_route":
          return identity.role !== "coordinator"
            ? Effect.fail(
                new BridgeError({
                  code: "Forbidden",
                  message: "Only a coordination session may propose routes.",
                }),
              )
            : backend
                .proposeRoute(identity, call.input, call.requestId)
                .pipe(Effect.flatMap((output) => checked(ProposeRouteOutput, output)));
      }
    };
    const server = createServer((request, response) => {
      const handle = Effect.gen(function* () {
        const authorization = request.headers.authorization;
        const token =
          typeof authorization === "string" && authorization.startsWith("Bearer ")
            ? authorization.slice(7)
            : "";
        const identity = token.length ? sessions.get(digest(token)) : undefined;
        if (!identity)
          return yield* Effect.fail(
            new BridgeError({
              code: "Unauthorized",
              message: "The session credential is invalid or expired.",
            }),
          );
        yield* backend.authorize(identity);
        if (request.method !== "POST")
          return yield* Effect.fail(
            new BridgeError({ code: "InvalidInput", message: "Only POST requests are supported." }),
          );
        const body = yield* readBody(request, BRIDGE_MAX_INPUT_BYTES);
        if (request.url === "/identity") {
          yield* checked(Schema.Record({ key: Schema.String, value: Schema.Never }), body);
          return identity;
        }
        if (request.url !== "/tool")
          return yield* Effect.fail(
            new BridgeError({ code: "NotFound", message: "Unknown bridge endpoint." }),
          );
        return yield* dispatch(identity, yield* checked(BridgeCall, body));
      }).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({
            ok: false as const,
            error: { code: error.code, message: error.message },
          }),
        }),
        Effect.flatMap((reply) =>
          Effect.sync(() => {
            let contents = JSON.stringify(reply);
            if (Buffer.byteLength(contents) > BRIDGE_MAX_OUTPUT_BYTES)
              contents = JSON.stringify({
                ok: false,
                error: { code: "Unavailable", message: "Bridge response exceeded its byte limit." },
              });
            response.writeHead(
              reply.ok
                ? 200
                : reply.error.code === "Unauthorized"
                  ? 401
                  : reply.error.code === "Forbidden"
                    ? 403
                    : reply.error.code === "Conflict"
                      ? 409
                      : 400,
              { "content-type": "application/json" },
            );
            response.end(contents);
          }),
        ),
        Effect.catchAllCause(() =>
          Effect.sync(() => {
            if (!response.destroyed) {
              response.writeHead(500);
              response.end(
                JSON.stringify({
                  ok: false,
                  error: { code: "Unavailable", message: "The bridge request failed." },
                }),
              );
            }
          }),
        ),
      );
      const fiber = Runtime.runFork(runtime)(handle.pipe(Effect.interruptible));
      fibers.add(fiber);
      fiber.addObserver(() => fibers.delete(fiber));
      response.once("close", () => {
        if (!response.writableEnded) Runtime.runFork(runtime)(Fiber.interrupt(fiber));
      });
    });
    server.on("connection", (socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    yield* Effect.acquireRelease(
      Effect.async<void, BridgeError>((resume) => {
        const onError = () =>
          resume(
            Effect.fail(
              new BridgeError({
                code: "Unavailable",
                message: "Cannot bind the MCP Unix socket; the path may already be in use.",
              }),
            ),
          );
        server.once("error", onError);
        server.listen(socketPath, () => {
          server.off("error", onError);
          resume(Effect.void);
        });
      }),
      () =>
        Effect.gen(function* () {
          sessions.clear();
          yield* Effect.forEach([...fibers], Fiber.interrupt, { concurrency: "unbounded" });
          for (const socket of connections) socket.destroy();
          yield* Effect.async<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }),
    );
    yield* Effect.tryPromise({ try: () => chmod(socketPath, 0o600), catch: unavailable });
    return {
      socketPath,
      register: (identity) =>
        Effect.gen(function* () {
          const value = yield* checked(SessionIdentity, identity);
          yield* backend.authorize(value);
          const token = Redacted.make(randomBytes(32).toString("base64url"));
          const key = digest(Redacted.value(token));
          yield* Effect.acquireRelease(
            Effect.sync(() => sessions.set(key, value)),
            () =>
              Effect.sync(() => {
                sessions.delete(key);
              }),
          );
          return { socketPath, token };
        }),
      revoke: (token) =>
        Effect.sync(() => {
          sessions.delete(digest(Redacted.value(token)));
        }),
    };
  });

export interface SocketBridgeClient {
  readonly identity: Effect.Effect<SessionIdentity, BridgeError>;
  readonly call: (
    tool: BridgeCall["tool"],
    input: unknown,
    requestId?: string,
  ) => Effect.Effect<JsonValue, BridgeError>;
}

export const makeSocketBridgeClient = (
  credentials: BridgeCredentials,
  timeoutMs = 10_000,
): Effect.Effect<SocketBridgeClient, BridgeError> =>
  Effect.gen(function* () {
    const socketPath = yield* validPath(credentials.socketPath);
    const timeout = yield* checked(PositiveInteger, timeoutMs);
    const send = (path: string, body: unknown) =>
      Effect.async<unknown, BridgeError>((resume) => {
        const outgoing = httpRequest(
          {
            socketPath,
            path,
            method: "POST",
            headers: {
              authorization: `Bearer ${Redacted.value(credentials.token)}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            const fiber = Effect.runFork(readBody(response, BRIDGE_MAX_OUTPUT_BYTES));
            fiber.addObserver((exit) => resume(exit));
            outgoing.once("close", () => {
              if (!response.complete) Effect.runFork(Fiber.interrupt(fiber));
            });
          },
        );
        outgoing.once("error", () =>
          resume(
            Effect.fail(
              new BridgeError({
                code: "Indeterminate",
                message:
                  "The local bridge connection ended without a confirmed result; do not retry actions automatically.",
              }),
            ),
          ),
        );
        outgoing.end(JSON.stringify(body));
        return Effect.sync(() => outgoing.destroy());
      }).pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new BridgeError({
              code: "Indeterminate",
              message: "The local bridge request timed out; its outcome is unknown.",
            }),
        }),
        Effect.flatMap((value) => checked(WireReply, value)),
        Effect.flatMap((reply) =>
          reply.ok ? Effect.succeed(reply.value) : Effect.fail(new BridgeError(reply.error)),
        ),
      );
    return {
      identity: send("/identity", {}).pipe(
        Effect.flatMap((value) => checked(SessionIdentity, value)),
      ),
      call: (tool, input, requestId = randomUUID()) =>
        checked(BridgeCall, { tool, input, requestId }).pipe(
          Effect.flatMap((call) => send("/tool", call)),
        ),
    };
  });

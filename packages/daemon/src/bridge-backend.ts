import {
  Chief,
  ConfigStore,
  type CoreError,
  isCoordinationTask,
  MainThread,
  TaskRegistry,
} from "@aut/core";
import { BridgeBackend, BridgeError, SessionIdentity } from "@aut/mcp-bridge";
import {
  CreateBotInput,
  CreateBotOutput,
  GetTaskInput,
  GetTaskOutput,
  ListTasksInput,
  ListTasksOutput,
  ProposeRouteInput,
  ProposeRouteOutput,
  ReadMainThreadInput,
  ReadMainThreadOutput,
} from "@aut/protocol";
import { Effect, Layer, Option, Schema } from "effect";

import { Administration } from "./admin.js";

const boundaryError = (error: CoreError) =>
  new BridgeError({
    code:
      error.code === "NotFound"
        ? "NotFound"
        : error.code === "Validation"
          ? "InvalidInput"
          : "Unavailable",
    message:
      error.code === "NotFound"
        ? "The requested record was not found"
        : "The local operation could not be completed",
  });
const checked = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new BridgeError({ code: "InvalidInput", message: "The tool input or output is invalid" }),
    ),
  );

/** Supplies persistence and the serial Chief to the transport-only MCP package. */
export const BridgeBackendLive = Layer.effect(
  BridgeBackend,
  Effect.gen(function* () {
    const admin = yield* Administration;
    const config = yield* ConfigStore;
    const tasks = yield* TaskRegistry;
    const messages = yield* MainThread;
    const chief = yield* Chief;
    const authorize = (input: SessionIdentity) =>
      Effect.gen(function* () {
        const identity = yield* checked(SessionIdentity, input);
        const task = yield* tasks.get(identity.taskId).pipe(Effect.mapError(boundaryError));
        const bots = yield* config.readBots.pipe(Effect.mapError(boundaryError));
        const bot = bots.find((entry) => entry.id === identity.botId);
        if (
          Option.isNone(task) ||
          !bot ||
          task.value.botId !== identity.botId ||
          ["cancelled", "archived"].includes(task.value.status) ||
          (isCoordinationTask(task.value, bot) ? "coordinator" : "worker") !== identity.role
        )
          return yield* Effect.fail(
            new BridgeError({
              code: "Forbidden",
              message: "The session identity is no longer authorized",
            }),
          );
        return bot;
      });
    return {
      authorize: (identity) => authorize(identity).pipe(Effect.asVoid),
      readMainThread: (identity, input) =>
        Effect.gen(function* () {
          const args = yield* checked(ReadMainThreadInput, input);
          yield* authorize(identity);
          const rows = yield* (
            args.ids
              ? messages.getByIds(args.ids)
              : messages.page({
                  ...(args.before === undefined ? {} : { before: args.before }),
                  limit: args.limit ?? 50,
                })
          ).pipe(Effect.mapError(boundaryError));
          return yield* checked(
            ReadMainThreadOutput,
            rows.map(({ id, at, author, text, taskId }) => ({
              id,
              at,
              author,
              text,
              ...(taskId === undefined ? {} : { taskId }),
            })),
          );
        }),
      listTasks: (identity, input) =>
        Effect.gen(function* () {
          const args = yield* checked(ListTasksInput, input);
          yield* authorize(identity);
          const rows = yield* tasks.list(args).pipe(Effect.mapError(boundaryError));
          return yield* checked(
            ListTasksOutput,
            rows.map(
              ({
                id,
                botId,
                title,
                status,
                createdAt,
                updatedAt,
                lastActivityAt,
                pendingRequestIds,
              }) => ({
                id,
                botId,
                title,
                status,
                createdAt,
                updatedAt,
                lastActivityAt,
                pendingRequestIds,
              }),
            ),
          );
        }),
      getTask: (identity, input) =>
        Effect.gen(function* () {
          const args = yield* checked(GetTaskInput, input);
          yield* authorize(identity);
          const task = yield* tasks.get(args.taskId).pipe(Effect.mapError(boundaryError));
          if (Option.isNone(task))
            return yield* Effect.fail(
              new BridgeError({ code: "NotFound", message: "The requested task was not found" }),
            );
          return yield* checked(GetTaskOutput, task.value);
        }),
      createBot: (identity, input) =>
        Effect.gen(function* () {
          const args = yield* checked(CreateBotInput, input);
          const parent = yield* authorize(identity);
          const bot = yield* admin
            .createBot(
              {
                ...args,
                modelSelection: args.modelSelection ?? parent.modelSelection,
                cwd: args.cwd ?? parent.cwd,
                mcpServers: args.mcpServers ?? [],
              },
              identity.taskId,
            )
            .pipe(
              Effect.mapError((e) =>
                e._tag === "DaemonError"
                  ? new BridgeError({ code: "InvalidInput", message: e.message })
                  : boundaryError(e),
              ),
            );
          return yield* checked(CreateBotOutput, { id: bot.id, name: bot.name });
        }),
      proposeRoute: (identity, input, requestId) =>
        Effect.gen(function* () {
          const args = yield* checked(ProposeRouteInput, input);
          yield* authorize(identity);
          if (identity.role !== "coordinator")
            return yield* Effect.fail(
              new BridgeError({
                code: "Forbidden",
                message: "Route proposals require a primary assistant coordination task",
              }),
            );
          const receipt = yield* chief
            .propose({
              originTaskId: identity.taskId,
              originBotId: identity.botId,
              op: args.op,
              rationale: args.rationale,
              eventRef: `mcp:${requestId}`,
            })
            .pipe(Effect.mapError(boundaryError));
          const result = yield* receipt.awaitResult;
          return yield* checked(
            ProposeRouteOutput,
            result.execution.ok
              ? { accepted: true, result: result.decisionLogId }
              : {
                  accepted: false,
                  rejectReason:
                    result.execution.error ?? "The proposed operation could not be registered",
                },
          );
        }),
    };
  }),
);

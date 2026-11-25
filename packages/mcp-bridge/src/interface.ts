import {
  BotId,
  type CreateBotInput,
  type CreateBotOutput,
  type CreateTriggerInput,
  type CreateTriggerOutput,
  type GetTaskInput,
  type GetTaskOutput,
  type GetTriggerInput,
  type GetTriggerOutput,
  type ListTasksInput,
  type ListTasksOutput,
  type ListTriggerRunsInput,
  type ListTriggerRunsOutput,
  type ListTriggersInput,
  type ListTriggersOutput,
  type McpInfoInput,
  type McpInfoOutput,
  type McpServerToolInput,
  type McpServerToolOutput,
  type ProposeRouteInput,
  type ProposeRouteOutput,
  type ReadMainThreadInput,
  type ReadMainThreadOutput,
  type ReadTaskSessionInput,
  type ReadTaskSessionOutput,
  TaskId,
  type UpdateTriggerOutput,
  type UpdateTriggerToolInput,
} from "@aut/protocol";
import { Context, Data, type Effect, Schema } from "effect";

export const SessionIdentity = Schema.Struct({
  botId: BotId,
  taskId: TaskId,
  role: Schema.Literal("worker", "coordinator"),
});
export type SessionIdentity = typeof SessionIdentity.Type;

export class BridgeError extends Data.TaggedError("BridgeError")<{
  readonly code:
    | "Unauthorized"
    | "Forbidden"
    | "InvalidInput"
    | "Conflict"
    | "NotFound"
    | "Unavailable"
    | "Indeterminate";
  readonly message: string;
}> {}

export class BridgeBackend extends Context.Tag("aut/McpBridge/Backend")<
  BridgeBackend,
  {
    readonly mcpInfo: (
      identity: SessionIdentity,
      input: McpInfoInput,
    ) => Effect.Effect<McpInfoOutput, BridgeError>;
    readonly mcpServer: (
      identity: SessionIdentity,
      input: McpServerToolInput,
    ) => Effect.Effect<McpServerToolOutput, BridgeError>;
    readonly authorize: (identity: SessionIdentity) => Effect.Effect<void, BridgeError>;
    readonly readMainThread: (
      identity: SessionIdentity,
      input: ReadMainThreadInput,
    ) => Effect.Effect<ReadMainThreadOutput, BridgeError>;
    readonly listTasks: (
      identity: SessionIdentity,
      input: ListTasksInput,
    ) => Effect.Effect<ListTasksOutput, BridgeError>;
    readonly getTask: (
      identity: SessionIdentity,
      input: GetTaskInput,
    ) => Effect.Effect<GetTaskOutput, BridgeError>;
    readonly readTaskSession: (
      identity: SessionIdentity,
      input: ReadTaskSessionInput,
    ) => Effect.Effect<ReadTaskSessionOutput, BridgeError>;
    readonly createBot: (
      identity: SessionIdentity,
      input: CreateBotInput,
    ) => Effect.Effect<CreateBotOutput, BridgeError>;
    readonly createTrigger: (
      identity: SessionIdentity,
      input: CreateTriggerInput,
    ) => Effect.Effect<CreateTriggerOutput, BridgeError>;
    readonly getTrigger: (
      identity: SessionIdentity,
      input: GetTriggerInput,
    ) => Effect.Effect<GetTriggerOutput, BridgeError>;
    readonly listTriggers: (
      identity: SessionIdentity,
      input: ListTriggersInput,
    ) => Effect.Effect<ListTriggersOutput, BridgeError>;
    readonly listTriggerRuns: (
      identity: SessionIdentity,
      input: ListTriggerRunsInput,
    ) => Effect.Effect<ListTriggerRunsOutput, BridgeError>;
    readonly updateTrigger: (
      identity: SessionIdentity,
      input: UpdateTriggerToolInput,
    ) => Effect.Effect<UpdateTriggerOutput, BridgeError>;
    readonly proposeRoute: (
      identity: SessionIdentity,
      input: ProposeRouteInput,
      requestId: string,
    ) => Effect.Effect<ProposeRouteOutput, BridgeError>;
  }
>() {}

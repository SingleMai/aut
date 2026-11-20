import {
  BotId,
  type CreateBotInput,
  type CreateBotOutput,
  type GetTaskInput,
  type GetTaskOutput,
  type ListTasksInput,
  type ListTasksOutput,
  type ProposeRouteInput,
  type ProposeRouteOutput,
  type ReadMainThreadInput,
  type ReadMainThreadOutput,
  TaskId,
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
    | "NotFound"
    | "Unavailable"
    | "Indeterminate";
  readonly message: string;
}> {}

export class BridgeBackend extends Context.Tag("aut/McpBridge/Backend")<
  BridgeBackend,
  {
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
    readonly createBot: (
      identity: SessionIdentity,
      input: CreateBotInput,
    ) => Effect.Effect<CreateBotOutput, BridgeError>;
    readonly proposeRoute: (
      identity: SessionIdentity,
      input: ProposeRouteInput,
      requestId: string,
    ) => Effect.Effect<ProposeRouteOutput, BridgeError>;
  }
>() {}

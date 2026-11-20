import {
  AutEvent,
  BotId,
  type JsonValue,
  MessageId,
  Op,
  SessionRequest,
  TaskId,
  TaskStatus,
  UiAction,
} from "@aut/protocol";
import { Context, type Effect, Schema } from "effect";
import type { CoreError } from "../errors.js";

export const TaskCandidate = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  status: TaskStatus,
  description: Schema.String,
});
export type TaskCandidate = typeof TaskCandidate.Type;
export const InboundState = Schema.Struct({
  message: Schema.String,
  messageId: Schema.NullOr(MessageId),
  messageIds: Schema.Array(MessageId),
  uiAction: Schema.NullOr(UiAction),
  selectedOp: Schema.NullOr(Op),
  fixedTargetId: Schema.NullOr(TaskId),
  primaryBotId: BotId,
  bots: Schema.Array(Schema.Struct({ id: BotId, name: Schema.String, description: Schema.String })),
  taskCandidates: Schema.Array(TaskCandidate),
  olderTasks: Schema.Array(TaskCandidate),
  pendingRequests: Schema.Array(SessionRequest),
  recentMessages: Schema.Array(
    Schema.Struct({ id: MessageId, text: Schema.String, taskId: Schema.NullOr(TaskId) }),
  ),
});
export type InboundState = typeof InboundState.Type;

export const ChiefInput = Schema.Struct({
  event: AutEvent,
  eventRef: Schema.String,
  decisionLogId: Schema.String,
});
export type ChiefInput = typeof ChiefInput.Type;
export type StateSourceInput = ChiefInput;

export class StateSource extends Context.Tag("aut/Chief/StateSource")<
  StateSource,
  {
    readonly prepare: (input: ChiefInput) => Effect.Effect<InboundState, CoreError>;
  }
>() {}

export interface ExecutionResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly degraded?: readonly string[];
}

export interface RegisteredExecution {
  readonly execution: ExecutionResult;
  /** Starts already registered background work after the initial decision result is saved. */
  readonly activate?: Effect.Effect<void, CoreError>;
}

export class OpExecutor extends Context.Tag("aut/Chief/OpExecutor")<
  OpExecutor,
  {
    /** Return after durable registration/enqueueing. Session work runs outside the Chief fiber. */
    readonly execute: (
      op: Op,
      decisionLogId: string,
      corrects?: string,
    ) => Effect.Effect<RegisteredExecution, CoreError>;
  }
>() {}

export const jsonState = (state: InboundState): JsonValue => state;

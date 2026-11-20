import { Schema } from "effect";
import {
  BotId,
  MessageId,
  NonEmptyString,
  optional,
  PositiveInteger,
  RequestId,
  TaskId,
  Timestamp,
  uniqueBy,
} from "./common.js";
import { BotConfig, McpServerConfig, ModelSelection } from "./config.js";
import { MessageAuthor, ProposableOp, Questions, Task, TaskStatus } from "./domain.js";

export const MainThreadExcerpt = Schema.Struct({
  id: MessageId,
  at: Timestamp,
  author: MessageAuthor,
  text: Schema.String,
  taskId: optional(TaskId),
});
export type MainThreadExcerpt = typeof MainThreadExcerpt.Type;
export const TaskSummary = Schema.Struct({
  id: TaskId,
  botId: BotId,
  title: Schema.String,
  status: TaskStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  pendingRequestIds: Schema.Array(RequestId),
});
export type TaskSummary = typeof TaskSummary.Type;
export const ReadMainThreadInput = Schema.Struct({
  ids: optional(
    Schema.Array(MessageId).pipe(
      Schema.minItems(1),
      Schema.maxItems(50),
      Schema.filter((ids) => uniqueBy(ids, (id) => id)),
    ),
  ),
  before: optional(MessageId),
  limit: optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(50))),
}).pipe(
  Schema.filter(
    (input) => input.ids === undefined || (input.before === undefined && input.limit === undefined),
  ),
);
export type ReadMainThreadInput = typeof ReadMainThreadInput.Type;
export const ReadMainThreadOutput = Schema.Array(MainThreadExcerpt).pipe(Schema.maxItems(50));
export type ReadMainThreadOutput = typeof ReadMainThreadOutput.Type;
export const ListTasksInput = Schema.Struct({
  status: optional(Schema.Array(TaskStatus)),
  botId: optional(BotId),
  limit: optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(50))),
});
export type ListTasksInput = typeof ListTasksInput.Type;
export const ListTasksOutput = Schema.Array(TaskSummary).pipe(Schema.maxItems(50));
export type ListTasksOutput = typeof ListTasksOutput.Type;
export const GetTaskInput = Schema.Struct({ taskId: TaskId });
export type GetTaskInput = typeof GetTaskInput.Type;
export const GetTaskOutput = Task;
export type GetTaskOutput = typeof GetTaskOutput.Type;
export const CreateBotInput = Schema.Struct({
  ...BotConfig.pick("id", "name", "description", "soul", "characterId").fields,
  modelSelection: optional(ModelSelection),
  cwd: optional(NonEmptyString),
  mcpServers: optional(Schema.Array(McpServerConfig)),
});
export type CreateBotInput = typeof CreateBotInput.Type;
export const CreateBotOutput = BotConfig.pick("id", "name");
export type CreateBotOutput = typeof CreateBotOutput.Type;
export const ProposeRouteInput = Schema.Struct({ op: ProposableOp, rationale: NonEmptyString });
export type ProposeRouteInput = typeof ProposeRouteInput.Type;
export const ProposeRouteOutput = Schema.Struct({
  accepted: Schema.Boolean,
  result: optional(Schema.String),
  rejectReason: optional(Schema.String),
});
export type ProposeRouteOutput = typeof ProposeRouteOutput.Type;
export const AskUserInput = Schema.Struct({ questions: Questions });
export type AskUserInput = typeof AskUserInput.Type;
export const AskUserOutput = Schema.String;
export type AskUserOutput = typeof AskUserOutput.Type;

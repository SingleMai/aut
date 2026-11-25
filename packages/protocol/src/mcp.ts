import { Schema } from "effect";
import {
  UpdateTriggerInput as ApiUpdateTriggerInput,
  TaskSessionInput,
  TaskSessionResponse,
} from "./api.js";
import {
  BotId,
  McpServerId,
  MessageId,
  NonEmptyString,
  optional,
  PositiveInteger,
  RequestId,
  TaskId,
  Timestamp,
  TriggerId,
  uniqueBy,
} from "./common.js";
import {
  BotConfig,
  McpAuthStatus,
  McpGrant,
  McpHealthStatus,
  McpServerInput,
  McpTool,
  ModelSelection,
} from "./config.js";
import {
  MessageAuthor,
  ProposableOp,
  Questions,
  ReportSources,
  Task,
  TaskStatus,
  Trigger,
  TriggerRun,
} from "./domain.js";
import { MessageFileList } from "./files.js";

export const MainThreadExcerpt = Schema.Struct({
  id: MessageId,
  at: Timestamp,
  author: MessageAuthor,
  text: Schema.String,
  taskId: optional(TaskId),
  sources: optional(ReportSources),
  files: optional(MessageFileList),
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
export const ReadTaskSessionInput = Schema.Struct({ taskId: TaskId, ...TaskSessionInput.fields });
export type ReadTaskSessionInput = typeof ReadTaskSessionInput.Type;
export const ReadTaskSessionOutput = TaskSessionResponse;
export type ReadTaskSessionOutput = typeof ReadTaskSessionOutput.Type;
export const CreateBotInput = Schema.Struct({
  ...BotConfig.pick("id", "name", "description", "soul", "characterId").fields,
  modelSelection: optional(ModelSelection),
  cwd: optional(NonEmptyString),
});
export type CreateBotInput = typeof CreateBotInput.Type;
export const CreateBotOutput = BotConfig.pick("id", "name");
export type CreateBotOutput = typeof CreateBotOutput.Type;
export const CreateTriggerOutput = Trigger;
export type CreateTriggerOutput = typeof CreateTriggerOutput.Type;
export const GetTriggerInput = Schema.Struct({ triggerId: TriggerId });
export type GetTriggerInput = typeof GetTriggerInput.Type;
export const GetTriggerOutput = Trigger;
export type GetTriggerOutput = typeof GetTriggerOutput.Type;
export const ListTriggersInput = Schema.Struct({
  botId: optional(BotId),
  enabled: optional(Schema.Boolean),
  limit: optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(50))),
});
export type ListTriggersInput = typeof ListTriggersInput.Type;
export const ListTriggersOutput = Schema.Array(Trigger).pipe(Schema.maxItems(50));
export type ListTriggersOutput = typeof ListTriggersOutput.Type;
export const ListTriggerRunsInput = Schema.Struct({
  triggerId: TriggerId,
  limit: optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(50))),
});
export type ListTriggerRunsInput = typeof ListTriggerRunsInput.Type;
export const ListTriggerRunsOutput = Schema.Array(TriggerRun).pipe(Schema.maxItems(50));
export type ListTriggerRunsOutput = typeof ListTriggerRunsOutput.Type;
export const UpdateTriggerToolInput = Schema.Struct({
  triggerId: TriggerId,
  update: ApiUpdateTriggerInput,
});
export type UpdateTriggerToolInput = typeof UpdateTriggerToolInput.Type;
export const UpdateTriggerOutput = Trigger;
export type UpdateTriggerOutput = typeof UpdateTriggerOutput.Type;
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

export const McpServerSummary = Schema.Struct({
  id: McpServerId,
  name: NonEmptyString,
  transport: Schema.Literal("stdio", "http", "sse"),
  enabled: Schema.Boolean,
  health: McpHealthStatus,
  auth: McpAuthStatus,
  tools: Schema.Array(McpTool),
});
export type McpServerSummary = typeof McpServerSummary.Type;
export const McpInfoInput = Schema.Struct({ serverId: optional(McpServerId) });
export type McpInfoInput = typeof McpInfoInput.Type;
export const McpInfoOutput = Schema.Struct({
  servers: Schema.Array(McpServerSummary),
  grants: Schema.Array(McpGrant),
  bots: Schema.Array(BotConfig.pick("id", "name")),
});
export type McpInfoOutput = typeof McpInfoOutput.Type;
const McpManagementAction = Schema.Literal(
  "create",
  "update",
  "test",
  "enable",
  "disable",
  "restart",
  "remove",
  "grant",
);
export const McpServerToolInput = Schema.Struct({
  action: McpManagementAction,
  serverId: optional(McpServerId),
  config: optional(McpServerInput),
  botId: optional(BotId),
  enabled: optional(Schema.Boolean),
  allowedTools: optional(Schema.Array(NonEmptyString)),
}).pipe(
  Schema.filter((input) => {
    if (input.action === "create" && input.serverId !== undefined) return false;
    if (input.action !== "create" && input.serverId === undefined) return false;
    if (["create", "update"].includes(input.action))
      return (
        input.config !== undefined &&
        input.botId === undefined &&
        input.enabled === undefined &&
        input.allowedTools === undefined
      );
    if (input.action === "grant")
      return (
        input.botId !== undefined &&
        input.enabled !== undefined &&
        input.allowedTools !== undefined &&
        input.config === undefined
      );
    return (
      input.config === undefined &&
      input.botId === undefined &&
      input.enabled === undefined &&
      input.allowedTools === undefined
    );
  }),
);
export type McpServerToolInput = typeof McpServerToolInput.Type;
export const McpServerToolOutput = Schema.Struct({
  serverId: McpServerId,
  action: McpManagementAction,
});
export type McpServerToolOutput = typeof McpServerToolOutput.Type;

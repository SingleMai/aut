import { Schema } from "effect";
import {
  BotId,
  HttpUrl,
  JsonValue,
  McpServerId,
  MessageId,
  NonEmptyString,
  PositiveInteger,
  Probability,
  Timestamp,
  TriggerId,
} from "./common.js";
import { AutConfig, BotConfig, BotsConfig, McpGrant, McpServer, McpServerInput } from "./config.js";
import {
  AutEvent,
  MainThreadMessage,
  QuestionAnswer,
  SessionRequest,
  Task,
  Trigger,
  TriggerRun,
  TriggerSchedule,
} from "./domain.js";
import { SessionHistory } from "./session-history.js";

export const SendMessageInput = Schema.Struct({
  text: NonEmptyString,
  id: Schema.optional(MessageId),
});
export type SendMessageInput = typeof SendMessageInput.Type;
export const MessagePageInput = Schema.Struct({
  before: Schema.optional(MessageId),
  limit: Schema.optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(50))),
});
export type MessagePageInput = typeof MessagePageInput.Type;
export const MessagePageResponse = Schema.Struct({ messages: Schema.Array(MainThreadMessage) });
export const MessageResponse = Schema.Struct({ message: MainThreadMessage });
export const TaskListResponse = Schema.Struct({ tasks: Schema.Array(Task) });
export const TaskResponse = Schema.Struct({ task: Task });
export const TaskSessionInput = Schema.Struct({
  before: Schema.optional(NonEmptyString),
  limit: Schema.optional(PositiveInteger.pipe(Schema.lessThanOrEqualTo(20))),
});
export type TaskSessionInput = typeof TaskSessionInput.Type;
export const TaskSessionResponse = Schema.Struct({
  task: Task,
  history: SessionHistory,
  availability: Schema.Literal("available", "pending", "unsupported", "unavailable"),
  message: Schema.optional(Schema.String),
  hasEarlier: Schema.Boolean,
  nextBefore: Schema.optional(NonEmptyString),
});
export type TaskSessionResponse = typeof TaskSessionResponse.Type;
export const RequestResponse = Schema.Struct({
  request: SessionRequest,
  answerState: Schema.optional(
    Schema.Literal("registered", "submitting", "delivered", "indeterminate", "queued"),
  ),
  deliveredAnswer: Schema.optional(QuestionAnswer),
}).pipe(
  Schema.filter(
    (value) =>
      value.deliveredAnswer === undefined ||
      (value.request.kind === "question" && value.answerState === "delivered"),
  ),
);
export const ReportResponse = Schema.Struct({ ref: NonEmptyString, text: Schema.String });
export const RouteTestInput = Schema.Struct({ text: NonEmptyString });
export type RouteTestInput = typeof RouteTestInput.Type;
export const RouteTestResponse = Schema.Struct({
  decisionLogId: NonEmptyString,
  selectedBotId: BotId,
  probabilities: Schema.Array(
    Schema.Struct({ botId: BotId, name: NonEmptyString, probability: Probability }),
  ).pipe(
    Schema.minItems(1),
    Schema.filter(
      (entries) => new Set(entries.map((entry) => entry.botId)).size === entries.length,
    ),
  ),
  backend: NonEmptyString,
  model: NonEmptyString,
});
export type RouteTestResponse = typeof RouteTestResponse.Type;
export const BotsResponse = Schema.Struct({ bots: BotsConfig });
export const BotResponse = Schema.Struct({ bot: BotConfig });
export const ConfigResponse = AutConfig;
export const McpServersResponse = Schema.Struct({ servers: Schema.Array(McpServer) });
export const McpServerResponse = Schema.Struct({ server: McpServer });
export const McpServerInputResponse = McpServerInput;
export const McpGrantInput = Schema.Struct({
  enabled: Schema.Boolean,
  allowedTools: Schema.Array(NonEmptyString),
});
export type McpGrantInput = typeof McpGrantInput.Type;
export const McpGrantsResponse = Schema.Struct({ grants: Schema.Array(McpGrant) });
export const McpGrantResponse = Schema.Struct({ grant: McpGrant });
export const McpTestResponse = Schema.Struct({ server: McpServer });
export const McpServerIdResponse = Schema.Struct({ serverId: McpServerId });
export const McpAuthStartResponse = Schema.Struct({
  serverId: McpServerId,
  authorizationUrl: HttpUrl,
  expiresAt: Timestamp,
});
export type McpAuthStartResponse = typeof McpAuthStartResponse.Type;
export const HealthResponse = Schema.Struct({ status: Schema.Literal("ok") });
export const AcceptedResponse = Schema.Struct({ accepted: Schema.Literal(true) });
export const DeletedResponse = Schema.Struct({ deleted: Schema.Literal(true) });
export const CreateTriggerInput = Schema.Struct({
  id: Schema.optional(TriggerId),
  name: NonEmptyString,
  botId: BotId,
  prompt: NonEmptyString,
  payload: Schema.optionalWith(JsonValue, { default: () => ({}) }),
  schedule: TriggerSchedule,
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
export type CreateTriggerInput = typeof CreateTriggerInput.Type;
export const UpdateTriggerInput = Schema.Struct({
  name: Schema.optional(NonEmptyString),
  botId: Schema.optional(BotId),
  prompt: Schema.optional(NonEmptyString),
  payload: Schema.optional(JsonValue),
  schedule: Schema.optional(TriggerSchedule),
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdateTriggerInput = typeof UpdateTriggerInput.Type;
export const TriggerResponse = Schema.Struct({ trigger: Trigger });
export const TriggersResponse = Schema.Struct({ triggers: Schema.Array(Trigger) });
export const TriggerRunsResponse = Schema.Struct({ runs: Schema.Array(TriggerRun) });
export const ApiErrorResponse = Schema.Struct({
  error: Schema.Struct({ code: NonEmptyString, message: Schema.String }),
});

export const DaemonResource = Schema.Literal(
  "messages",
  "tasks",
  "requests",
  "bots",
  "config",
  "mcp",
  "triggers",
);
export type DaemonResource = typeof DaemonResource.Type;
export const ResourcesChanged = Schema.Struct({
  type: Schema.Literal("changed"),
  resources: Schema.Array(DaemonResource).pipe(
    Schema.minItems(1),
    Schema.filter((values) => new Set(values).size === values.length),
  ),
});
export type ResourcesChanged = typeof ResourcesChanged.Type;
export const DaemonEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("event"), event: AutEvent }),
  ResourcesChanged,
);
export type DaemonEvent = typeof DaemonEvent.Type;

// Local credential APIs return references and status only.
export const SecretName = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/));
export const SecretReference = Schema.String.pipe(
  Schema.pattern(/^(?:secret:[A-Za-z0-9][A-Za-z0-9_-]{0,63}|(?:env:)?[A-Z_][A-Z0-9_]*)$/),
);
export const SecretSaveInput = Schema.Struct({
  name: SecretName,
  key: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(16384),
    Schema.filter((value) => value.trim().length > 0),
  ),
});
export type SecretSaveInput = typeof SecretSaveInput.Type;
export const SecretSaveResponse = Schema.Struct({
  apiKeyRef: SecretReference,
  configured: Schema.Literal(true),
});
export type SecretSaveResponse = typeof SecretSaveResponse.Type;
export const SecretStatusInput = Schema.Struct({ ref: SecretReference });
export const SecretStatusResponse = Schema.Struct({
  apiKeyRef: SecretReference,
  configured: Schema.Boolean,
});
export type SecretStatusResponse = typeof SecretStatusResponse.Type;

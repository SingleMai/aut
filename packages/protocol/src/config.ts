import { Schema } from "effect";
import {
  BotId,
  HttpUrl,
  JsonRecord,
  JsonValue,
  McpServerId,
  NonEmptyString,
  optional,
  StringRecord,
  Timestamp,
  uniqueBy,
} from "./common.js";

export const McpServerConfig = Schema.Union(
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("stdio"),
    command: NonEmptyString,
    args: Schema.Array(Schema.String),
    cwd: optional(NonEmptyString),
    env: optional(StringRecord),
  }),
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("http", "sse"),
    url: HttpUrl,
    headers: optional(StringRecord),
  }),
);
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpTool = Schema.Struct({
  name: NonEmptyString,
  title: optional(Schema.String),
  description: optional(Schema.String),
  inputSchema: optional(JsonValue),
  outputSchema: optional(JsonRecord),
  annotations: optional(JsonRecord),
});
export type McpTool = typeof McpTool.Type;

export const McpAuthStatus = Schema.Struct({
  status: Schema.Literal("none", "required", "authenticated", "error"),
  message: optional(Schema.String),
  updatedAt: optional(Timestamp),
});
export type McpAuthStatus = typeof McpAuthStatus.Type;

export const McpHealthStatus = Schema.Struct({
  status: Schema.Literal("unknown", "ready", "error"),
  message: optional(Schema.String),
  checkedAt: optional(Timestamp),
});
export type McpHealthStatus = typeof McpHealthStatus.Type;

const McpSecretReference = Schema.String.pipe(
  Schema.pattern(/^(?:secret:[A-Za-z0-9][A-Za-z0-9_-]{0,63}|(?:env:)?[A-Z_][A-Z0-9_]*)$/),
);
export const McpOAuthClient = Schema.Struct({
  clientId: optional(NonEmptyString),
  clientSecretRef: optional(McpSecretReference),
});
export type McpOAuthClient = typeof McpOAuthClient.Type;

const mcpServerStateFields = {
  id: McpServerId,
  name: NonEmptyString,
  enabled: Schema.Boolean,
  auth: McpAuthStatus,
  oauth: optional(McpOAuthClient),
  health: McpHealthStatus,
  tools: Schema.Array(McpTool).pipe(Schema.filter((tools) => uniqueBy(tools, (tool) => tool.name))),
};

export const McpServer = Schema.Union(
  Schema.Struct({
    ...mcpServerStateFields,
    transport: Schema.Literal("stdio"),
    command: NonEmptyString,
    args: Schema.Array(Schema.String),
    cwd: optional(NonEmptyString),
    env: optional(StringRecord),
  }),
  Schema.Struct({
    ...mcpServerStateFields,
    transport: Schema.Literal("http", "sse"),
    url: HttpUrl,
    headers: optional(StringRecord),
    oauth: optional(McpOAuthClient),
  }),
);
export type McpServer = typeof McpServer.Type;

export const McpServerInput = Schema.Union(
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("stdio"),
    command: NonEmptyString,
    args: Schema.Array(Schema.String),
    cwd: optional(NonEmptyString),
    env: optional(StringRecord),
  }),
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("http", "sse"),
    url: HttpUrl,
    headers: optional(StringRecord),
    oauth: optional(McpOAuthClient),
  }),
);
export type McpServerInput = typeof McpServerInput.Type;

export const McpGrant = Schema.Struct({
  botId: BotId,
  serverId: McpServerId,
  enabled: Schema.Boolean,
  allowedTools: Schema.Array(NonEmptyString).pipe(
    Schema.filter((tools) => new Set(tools).size === tools.length),
  ),
});
export type McpGrant = typeof McpGrant.Type;

export const McpConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  servers: Schema.Array(McpServer).pipe(Schema.filter((servers) => uniqueBy(servers, (s) => s.id))),
  grants: Schema.Array(McpGrant).pipe(
    Schema.filter((grants) => uniqueBy(grants, (grant) => `${grant.botId}:${grant.serverId}`)),
  ),
});
export type McpConfig = typeof McpConfig.Type;

export const ModelSelection = Schema.Struct({
  instanceId: NonEmptyString,
  model: NonEmptyString,
  effort: optional(NonEmptyString),
});
export type ModelSelection = typeof ModelSelection.Type;

export const BotConfig = Schema.Struct({
  id: BotId,
  name: NonEmptyString,
  characterId: optional(NonEmptyString),
  description: NonEmptyString,
  soul: Schema.String,
  modelSelection: ModelSelection,
  cwd: NonEmptyString,
  system: optional(Schema.Literal("primary")),
});
export type BotConfig = typeof BotConfig.Type;

export const BotsConfig = Schema.Array(BotConfig).pipe(
  Schema.filter((bots) => uniqueBy(bots, (bot) => bot.id)),
  Schema.filter((bots) => bots.filter((bot) => bot.system === "primary").length <= 1),
);
export type BotsConfig = typeof BotsConfig.Type;

export const HarnessInstanceConfig = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  kind: NonEmptyString,
  command: NonEmptyString,
  args: Schema.Array(Schema.String),
  env: optional(StringRecord),
  /** Provider-declared ACP auth method ids, ordered by preference. */
  authMethodIds: optional(Schema.Array(NonEmptyString)),
});
export type HarnessInstanceConfig = typeof HarnessInstanceConfig.Type;

export const ClassifierBackendConfig = Schema.Struct({
  backend: NonEmptyString,
  model: NonEmptyString.pipe(Schema.filter((model) => !/latest/i.test(model))),
  endpoint: HttpUrl,
  apiKeyRef: optional(NonEmptyString),
});
export type ClassifierBackendConfig = typeof ClassifierBackendConfig.Type;

export const ClassifierConfig = Schema.Struct({
  primary: ClassifierBackendConfig,
  fallback: optional(ClassifierBackendConfig),
});
export type ClassifierConfig = typeof ClassifierConfig.Type;

export const AutConfig = Schema.Struct({
  harnessInstances: Schema.Array(HarnessInstanceConfig).pipe(
    Schema.filter((instances) => uniqueBy(instances, (instance) => instance.id)),
  ),
  classifier: optional(ClassifierConfig),
});
export type AutConfig = typeof AutConfig.Type;

import { Schema } from "effect";
import { BotId, HttpUrl, NonEmptyString, optional, StringRecord, uniqueBy } from "./common.js";

export const McpServerConfig = Schema.Union(
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("stdio"),
    command: NonEmptyString,
    args: Schema.Array(Schema.String),
    env: optional(StringRecord),
  }),
  Schema.Struct({
    name: NonEmptyString,
    transport: Schema.Literal("http"),
    url: HttpUrl,
    headers: optional(StringRecord),
  }),
);
export type McpServerConfig = typeof McpServerConfig.Type;

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
  mcpServers: Schema.Array(McpServerConfig),
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

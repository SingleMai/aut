import { Schema } from "effect";
import { NonEmptyString, optional } from "./common.js";
import { HarnessInstanceConfig } from "./config.js";

export const BotModelDiscoveryInput = Schema.Struct({
  instance: HarnessInstanceConfig,
  cwd: NonEmptyString,
});
export type BotModelDiscoveryInput = typeof BotModelDiscoveryInput.Type;
export const BotModelParameterChoice = Schema.Struct({
  value: NonEmptyString,
  label: optional(NonEmptyString),
});
export const BotModelChoice = Schema.Struct({
  model: NonEmptyString,
  label: optional(NonEmptyString),
  effort: optional(NonEmptyString),
  speed: optional(NonEmptyString),
  efforts: optional(Schema.Array(BotModelParameterChoice)),
  speeds: optional(Schema.Array(BotModelParameterChoice)),
});
export const BotModelsResponse = Schema.Struct({
  models: Schema.Array(BotModelChoice),
  defaultModel: optional(NonEmptyString),
  source: Schema.Literal("catalog", "configured"),
});
export type BotModelsResponse = typeof BotModelsResponse.Type;
export const BotConnectionResponse = Schema.Struct({ instance: HarnessInstanceConfig });

export const BotModelOption = Schema.Struct({
  instance: HarnessInstanceConfig,
  configured: Schema.Boolean,
  availability: Schema.Literal("installed", "missing", "unsupported", "unknown"),
  discovery: Schema.Boolean,
  verification: Schema.Literal("verified", "preview"),
});
export type BotModelOption = typeof BotModelOption.Type;
export const BotModelOptionsResponse = Schema.Struct({ options: Schema.Array(BotModelOption) });
export type BotModelOptionsResponse = typeof BotModelOptionsResponse.Type;

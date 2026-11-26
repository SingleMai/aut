import { AdapterError, type BotModelsResponse, NonEmptyString } from "@aut/protocol";
import { Effect, Schema } from "effect";
import {
  type CodexDiscoveryOptions,
  forEachListedModel,
  ModelConfig,
  ModelEntry,
  openModelDiscovery,
  optionalText,
  readModelConfig,
} from "./model-discovery.js";
import { NodeTransport, type TransportFactory } from "./transport.js";

const CatalogConfig = Schema.Struct({ ...ModelConfig.fields, service_tier: optionalText });
const CatalogEntry = Schema.Struct({
  ...ModelEntry.fields,
  displayName: optionalText,
  supportedReasoningEfforts: Schema.optional(
    Schema.Array(Schema.Struct({ reasoningEffort: NonEmptyString })),
  ),
  serviceTiers: Schema.optional(
    Schema.Array(Schema.Struct({ id: NonEmptyString, name: optionalText })),
  ),
  defaultServiceTier: optionalText,
});
const failure = () =>
  new AdapterError({ code: "InvalidResponse", message: "Model discovery failed." });

function catalogSpeeds(tiers: NonNullable<typeof CatalogEntry.Type.serviceTiers>) {
  if (!tiers.length) return [];
  return [
    { value: "default", label: "Standard" },
    ...tiers
      .filter((tier) => tier.id !== "default")
      .map(({ id, name }) => ({
        value: id,
        ...(name ? { label: name } : {}),
      })),
  ];
}

function catalogChoice(model: typeof CatalogEntry.Type): BotModelsResponse["models"][number] {
  return {
    model: model.model,
    ...(model.displayName ? { label: model.displayName } : {}),
    ...(model.defaultReasoningEffort ? { effort: model.defaultReasoningEffort } : {}),
    ...(model.defaultServiceTier ? { speed: model.defaultServiceTier } : {}),
    ...(model.supportedReasoningEfforts
      ? {
          efforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => ({
            value: reasoningEffort,
          })),
        }
      : {}),
    ...(model.serviceTiers ? { speeds: catalogSpeeds(model.serviceTiers) } : {}),
  };
}

/** Projects only model metadata; native accounts, providers and project configuration stay untouched. */
export const readCodexModels = (
  options: CodexDiscoveryOptions,
  factory: TransportFactory = NodeTransport,
): Effect.Effect<BotModelsResponse, AdapterError> => {
  const timeout = options.timeoutMs ?? 8_000;
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* openModelDiscovery(factory, options, "aut-model-discovery", timeout);
      const config = yield* readModelConfig(transport, options.cwd, CatalogConfig);
      const configured = config.model
        ? {
            model: config.model,
            ...(config.model_reasoning_effort ? { effort: config.model_reasoning_effort } : {}),
            ...(config.service_tier ? { speed: config.service_tier } : {}),
          }
        : undefined;
      // A native catalog must not be represented as a custom provider's available models.
      if (config.model_provider && config.model_provider !== "openai")
        return {
          models: configured ? [configured] : [],
          ...(configured ? { defaultModel: configured.model } : {}),
          source: "configured" as const,
        };
      const choices = new Map<string, BotModelsResponse["models"][number]>();
      if (configured) choices.set(configured.model, configured);
      const defaults = new Set<string>();
      yield* forEachListedModel(transport, CatalogEntry, (model) => {
        if (model.isDefault) defaults.add(model.model);
        choices.set(model.model, catalogChoice(model));
      });
      const defaultModel =
        configured?.model ?? (defaults.size === 1 ? [...defaults][0] : undefined);
      const defaultChoice = defaultModel ? choices.get(defaultModel) : undefined;
      if (defaultModel && defaultChoice)
        choices.set(defaultModel, {
          ...defaultChoice,
          ...(config.model_reasoning_effort ? { effort: config.model_reasoning_effort } : {}),
          ...(config.service_tier ? { speed: config.service_tier } : {}),
        });
      return {
        models: [...choices.values()],
        ...(defaultModel ? { defaultModel } : {}),
        source: "catalog" as const,
      };
    }).pipe(Effect.interruptible, Effect.timeoutFail({ duration: timeout, onTimeout: failure })),
  ).pipe(Effect.mapError(failure));
};

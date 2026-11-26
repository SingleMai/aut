import { AdapterError, NonEmptyString } from "@aut/protocol";
import { Effect, Schema } from "effect";
import {
  type CodexDiscoveryOptions,
  forEachListedModel,
  ModelConfig,
  ModelEntry,
  openModelDiscovery,
  readModelConfig,
} from "./model-discovery.js";
import { NodeTransport, type TransportFactory } from "./transport.js";

export const CodexDefaults = Schema.Struct({
  model: NonEmptyString,
  effort: Schema.optionalWith(NonEmptyString, { exact: true }),
  provider: Schema.NullOr(NonEmptyString),
  source: Schema.Literal("configured", "reported-default"),
});
export type CodexDefaults = typeof CodexDefaults.Type;
export type ReadCodexDefaultsOptions = CodexDiscoveryOptions;
const invalid = () =>
  new AdapterError({
    code: "InvalidResponse",
    message: "Codex did not report an unambiguous model configuration.",
  });

/** Only reads native settings. No thread, model turn, config write, or provider override is issued. */
export const readCodexDefaults = (
  options: ReadCodexDefaultsOptions,
  factory: TransportFactory = NodeTransport,
): Effect.Effect<CodexDefaults, AdapterError> => {
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    return Effect.fail(
      new AdapterError({
        code: "InvalidResponse",
        message: "The defaults probe timeout must be a positive safe integer.",
      }),
    );
  return Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* openModelDiscovery(
        factory,
        options,
        "aut-config-discovery",
        timeout,
      );
      const config = yield* readModelConfig(transport, options.cwd, ModelConfig);
      if (config.model)
        return {
          model: config.model,
          provider: config.model_provider ?? null,
          source: "configured" as const,
          ...(config.model_reasoning_effort ? { effort: config.model_reasoning_effort } : {}),
        };
      const defaults: (typeof ModelEntry.Type)[] = [];
      yield* forEachListedModel(transport, ModelEntry, (model) => {
        if (model.isDefault) defaults.push(model);
      });
      const [selected, another] = defaults;
      if (!selected || another) return yield* Effect.fail(invalid());
      const effort = config.model_reasoning_effort ?? selected.defaultReasoningEffort;
      return {
        model: selected.model,
        provider: config.model_provider ?? null,
        source: "reported-default" as const,
        ...(effort ? { effort } : {}),
      };
    }).pipe(
      Effect.interruptible,
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new AdapterError({
            code: "TransportError",
            message: "The read-only Codex configuration probe timed out.",
          }),
      }),
    ),
  ).pipe(
    Effect.mapError(
      (error) =>
        new AdapterError({
          code: error.code,
          message: "Read-only Codex model discovery failed; native settings were not changed.",
        }),
    ),
  );
};

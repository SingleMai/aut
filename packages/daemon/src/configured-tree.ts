import { JEV_MODEL, makeJev } from "@aut/classifier";
import { Classifier } from "@aut/classifier/interface";
import { ConfigStore, DecisionLog, DecisionTree, DecisionTreeLive } from "@aut/core";
import {
  type ClassifierBackendConfig,
  ClassifierError,
  type Classifier as ClassifierShape,
} from "@aut/protocol";
import { Effect, Layer } from "effect";
import { SecretReader } from "./secret-reader.js";

/** Every run owns an immutable configuration snapshot, including its logged backend metadata. */
export const ConfiguredTreeLive = Layer.effect(
  DecisionTree,
  Effect.gen(function* () {
    const configStore = yield* ConfigStore;
    const logs = yield* DecisionLog;
    const secrets = yield* SecretReader;
    const backend = (config?: ClassifierBackendConfig): Effect.Effect<ClassifierShape> => {
      const configured = Effect.gen(function* () {
        if (config?.backend !== "jev")
          return yield* Effect.fail(
            new ClassifierError({
              code: "NotConfigured",
              message: "The selected classifier is not configured or supported",
            }),
          );
        const apiKey = yield* secrets.resolve(config.apiKeyRef).pipe(
          Effect.mapError(
            () =>
              new ClassifierError({
                code: "NotConfigured",
                message: "The classifier credential is unavailable",
              }),
          ),
        );
        return yield* makeJev({
          apiKey,
          config: { endpoint: config.endpoint, model: config.model },
        });
      });
      return configured.pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            backend: config?.backend ?? "jev",
            model: config?.model ?? JEV_MODEL,
            decide: () => Effect.fail(error),
          }),
        ),
      );
    };
    return {
      run: (tree, input) =>
        Effect.gen(function* () {
          const config = yield* configStore.readConfig;
          const primary = yield* backend(config.classifier?.primary);
          const fallback = config.classifier?.fallback
            ? yield* backend(config.classifier.fallback)
            : undefined;
          const layer = DecisionTreeLive(fallback ? { fallback } : {}).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(Classifier, primary), Layer.succeed(DecisionLog, logs)),
            ),
          );
          return yield* DecisionTree.pipe(
            Effect.flatMap((executor) => executor.run(tree, input)),
            Effect.provide(layer),
          );
        }),
    };
  }),
);

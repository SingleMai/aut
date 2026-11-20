import { isDeepStrictEqual } from "node:util";
import {
  ClassifierError,
  type Classifier as ClassifierShape,
  DecisionRequest,
  DecisionResponse,
} from "@aut/protocol";
import { Effect, Layer, Ref, Schema } from "effect";
import { Classifier } from "./interface.js";

export interface MockDecision {
  readonly request: DecisionRequest;
  readonly response?: DecisionResponse;
  readonly error?: ClassifierError;
}

export const makeMockClassifier = (
  fixtures: readonly MockDecision[],
): Effect.Effect<ClassifierShape> =>
  Effect.gen(function* () {
    const cursor = yield* Ref.make(0);
    return {
      backend: "mock",
      model: "mock-1.0.0",
      decide: (input) =>
        Effect.gen(function* () {
          const request = yield* Schema.decodeUnknown(DecisionRequest)(input).pipe(
            Effect.mapError(
              () =>
                new ClassifierError({ code: "InvalidResponse", message: "Invalid mock request." }),
            ),
          );
          const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1);
          const fixture = fixtures[index];
          if (!fixture || !isDeepStrictEqual(request, fixture.request))
            return yield* Effect.fail(
              new ClassifierError({
                code: "InvalidResponse",
                message: "No matching deterministic classifier fixture.",
              }),
            );
          if (fixture.error) return yield* Effect.fail(fixture.error);
          return yield* Schema.decodeUnknown(DecisionResponse)(fixture.response).pipe(
            Effect.mapError(
              () =>
                new ClassifierError({ code: "InvalidResponse", message: "Invalid mock response." }),
            ),
          );
        }),
    };
  });

export const makeMockClassifierLayer = (fixtures: readonly MockDecision[]) =>
  Layer.effect(Classifier, makeMockClassifier(fixtures));

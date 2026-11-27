// Validation and HTTP hygiene adapted from OpenMausBot server/decider/jev.ts,
// types.ts and room-routing.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
import {
  ClassifierError,
  type Classifier as ClassifierShape,
  type DecisionAnswer,
  DecisionRequest,
  DecisionResponse,
  FiniteNumber,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevServiceConfig,
  NonEmptyString,
  NonNegativeInteger,
  Probability,
} from "@aut/protocol";
import { Clock, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { Classifier } from "./interface.js";

export { JEV_ENDPOINT, JEV_MODEL } from "@aut/protocol";
export const JEV_TIMEOUT_MS = 1_500;
const SUM_TOLERANCE = 0.1;
const EPSILON = 1e-9;

export const JevConfig = Schema.Struct({
  ...JevServiceConfig.fields,
  timeoutMs: NonNegativeInteger.pipe(Schema.greaterThan(0)),
  maxRetries: NonNegativeInteger.pipe(Schema.lessThanOrEqualTo(2)),
  retryDelayMs: NonNegativeInteger.pipe(Schema.greaterThan(0)),
});
export type JevConfig = typeof JevConfig.Type;

const probabilityMap = Schema.Record({ key: Schema.String, value: Probability });
const WireAnswer = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: NonEmptyString,
    confidence: Probability,
    probabilities: probabilityMap,
  }),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: FiniteNumber,
    confidence: Probability,
    probabilities: probabilityMap,
    legend: Schema.Record({ key: Schema.String, value: Schema.String }),
  }),
);
const WireResponse = Schema.Struct({
  model: NonEmptyString,
  answers: Schema.Record({ key: Schema.String, value: WireAnswer }),
  usage: Schema.Struct({ input_tokens: NonNegativeInteger, output_tokens: NonNegativeInteger }),
});

const invalidResponse = () =>
  new ClassifierError({ code: "InvalidResponse", message: "Jev returned an invalid response." });
const invalidRequest = () =>
  new ClassifierError({
    code: "InvalidResponse",
    message: "The decision request violates the Jev API contract.",
  });
const sameKeys = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((key) => right.includes(key));
const validDistribution = (
  probabilities: Readonly<Record<string, number>>,
  keys: readonly string[],
) =>
  sameKeys(Object.keys(probabilities), keys) &&
  Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) <=
    SUM_TOLERANCE;

export const validateJevRequest = (input: DecisionRequest) =>
  Schema.decodeUnknown(DecisionRequest)(input).pipe(
    Effect.mapError(invalidRequest),
    Effect.filterOrFail(
      (request) =>
        Object.values(request.questions).every((question) =>
          question.type === "choice"
            ? Object.keys(question.criteria).length <= 255
            : question.type === "score"
              ? question.criteria.length <= 10
              : true,
        ),
      invalidRequest,
    ),
  );

export const parseJevResponse = (
  body: unknown,
  request: DecisionRequest,
  model: string,
  latencyMs: number,
): Effect.Effect<DecisionResponse, ClassifierError> =>
  Effect.gen(function* () {
    const wire = yield* Schema.decodeUnknown(WireResponse)(body).pipe(
      Effect.mapError(invalidResponse),
    );
    if (
      wire.model !== model ||
      !sameKeys(Object.keys(wire.answers), Object.keys(request.questions))
    )
      return yield* Effect.fail(invalidResponse());
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = wire.answers[id];
      if (!answer || answer.type !== question.type) return yield* Effect.fail(invalidResponse());
      if (question.type === "choice" && answer.type === "choice") {
        const probability = answer.probabilities[answer.choice];
        if (
          probability === undefined ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          !validDistribution(answer.probabilities, Object.keys(question.criteria)) ||
          Object.values(answer.probabilities).some((value) => value > probability + EPSILON)
        )
          return yield* Effect.fail(invalidResponse());
        answers[id] = {
          type: "choice",
          choice: answer.choice,
          confidence: probability,
          probabilities: answer.probabilities,
        };
      } else if (question.type === "score" && answer.type === "score") {
        const keys = question.criteria.map((_, index) => String(index));
        if (
          answer.score < 0 ||
          answer.score > question.criteria.length - 1 ||
          !validDistribution(answer.probabilities, keys) ||
          !sameKeys(Object.keys(answer.legend), keys) ||
          keys.some((key, index) => answer.legend[key] !== question.criteria[index])
        )
          return yield* Effect.fail(invalidResponse());
        answers[id] = { type: "score", score: answer.score, probabilities: answer.probabilities };
      } else if (answer.type === "noul") {
        answers[id] = { type: "noul", noul: answer.noul };
      }
    }
    return yield* Schema.decodeUnknown(DecisionResponse)({
      answers,
      latencyMs,
      usage: { inputTokens: wire.usage.input_tokens },
    }).pipe(Effect.mapError(invalidResponse));
  });

export interface JevOptions {
  readonly apiKey: Redacted.Redacted<string>;
  readonly config?: Partial<JevConfig>;
  readonly fetch?: typeof globalThis.fetch;
}

const retryDetail = (error: ClassifierError, key: string): number => {
  const detail = error.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return 0;
  const value = (detail as Readonly<Record<string, unknown>>)[key];
  return typeof value === "number" ? value : 0;
};
const retryable = (error: ClassifierError) =>
  error.code === "RateLimited" ||
  (retryDetail(error, "status") >= 500 && retryDetail(error, "status") <= 599);
const httpErrorCode = (status: number) => {
  if (status === 401 || status === 403) return "NotConfigured";
  return status === 429 ? "RateLimited" : "TransportError";
};
const retryAfter = (value: string | null, now: number): number => {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
};

export const makeJev = (options: JevOptions): Effect.Effect<ClassifierShape, ClassifierError> =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknown(JevConfig)({
      endpoint: JEV_ENDPOINT,
      model: JEV_MODEL,
      timeoutMs: JEV_TIMEOUT_MS,
      maxRetries: 1,
      retryDelayMs: 100,
      ...options.config,
    }).pipe(
      Effect.mapError(
        () => new ClassifierError({ code: "NotConfigured", message: "Invalid Jev configuration." }),
      ),
    );
    if (Redacted.value(options.apiKey).trim().length === 0)
      return yield* Effect.fail(
        new ClassifierError({ code: "NotConfigured", message: "A Jev API key is required." }),
      );
    const fetch = options.fetch ?? globalThis.fetch;
    const policy = Schedule.recurWhile<ClassifierError>(retryable).pipe(
      Schedule.intersect(Schedule.exponential(Duration.millis(config.retryDelayMs))),
      Schedule.modifyDelay(([error], delay) =>
        Duration.millis(Math.max(Duration.toMillis(delay), retryDetail(error, "retryAfterMs"))),
      ),
      Schedule.intersect(Schedule.recurs(config.maxRetries)),
    );
    return {
      backend: "jev",
      model: config.model,
      decide: (input) =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const request = yield* validateJevRequest(input);
          const attempt = Effect.acquireUseRelease(
            Effect.sync(() => new AbortController()),
            (controller) =>
              Effect.gen(function* () {
                const response = yield* Effect.tryPromise({
                  try: () =>
                    fetch(config.endpoint, {
                      method: "POST",
                      headers: {
                        authorization: `Bearer ${Redacted.value(options.apiKey)}`,
                        "content-type": "application/json",
                        accept: "application/json",
                      },
                      body: JSON.stringify({ model: config.model, ...request }),
                      signal: controller.signal,
                      redirect: "error",
                    }),
                  catch: () =>
                    new ClassifierError({ code: "TransportError", message: "Jev request failed." }),
                });
                if (!response.ok) {
                  const now = yield* Clock.currentTimeMillis;
                  yield* Effect.tryPromise({
                    try: () => response.body?.cancel() ?? Promise.resolve(),
                    catch: () => undefined,
                  }).pipe(Effect.ignore);
                  return yield* Effect.fail(
                    new ClassifierError({
                      code: httpErrorCode(response.status),
                      message: `Jev returned HTTP ${response.status}.`,
                      detail: {
                        status: response.status,
                        retryAfterMs: retryAfter(response.headers.get("retry-after"), now),
                      },
                    }),
                  );
                }
                const body = yield* Effect.tryPromise({
                  try: () => response.json() as Promise<unknown>,
                  catch: invalidResponse,
                });
                const ended = yield* Clock.currentTimeMillis;
                return yield* parseJevResponse(body, request, config.model, ended - started);
              }),
            (controller) => Effect.sync(() => controller.abort()),
          );
          return yield* attempt.pipe(Effect.retry(policy));
        }).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(config.timeoutMs),
            onTimeout: () =>
              new ClassifierError({
                code: "Timeout",
                message: "Jev exceeded the decision time budget.",
              }),
          }),
        ),
    };
  });

export const makeJevLayer = (options: JevOptions): Layer.Layer<Classifier, ClassifierError> =>
  Layer.effect(Classifier, makeJev(options));

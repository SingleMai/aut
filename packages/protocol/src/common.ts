import { Schema } from "effect";

export const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
export const FiniteNumber = Schema.Number.pipe(Schema.finite());
export const NonNegativeNumber = FiniteNumber.pipe(Schema.nonNegative());
export const NonNegativeInteger = NonNegativeNumber.pipe(
  Schema.int(),
  Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const PositiveInteger = NonNegativeInteger.pipe(Schema.greaterThan(0));
export const Probability = FiniteNumber.pipe(Schema.between(0, 1));
export const SafeKey = NonEmptyString.pipe(
  Schema.filter((value) => !["__proto__", "prototype", "constructor"].includes(value)),
);

export const RoutingCandidateId = SafeKey.pipe(
  Schema.filter((value) => value !== "none" && value !== "older_task"),
);

export const TaskId = NonEmptyString.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;
export const MessageId = NonEmptyString.pipe(Schema.brand("MessageId"));
export type MessageId = typeof MessageId.Type;
export const RequestId = NonEmptyString.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;
export const BotId = NonEmptyString.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;
export const TriggerId = NonEmptyString.pipe(Schema.brand("TriggerId"));
export type TriggerId = typeof TriggerId.Type;
export const TriggerRunId = NonEmptyString.pipe(Schema.brand("TriggerRunId"));
export type TriggerRunId = typeof TriggerRunId.Type;
export const McpServerId = NonEmptyString.pipe(Schema.brand("McpServerId"));
export type McpServerId = typeof McpServerId.Type;
export const Timestamp = NonNegativeInteger;
export type Timestamp = typeof Timestamp.Type;

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const isJsonValue = (input: unknown, ancestors = new Set<object>()): input is JsonValue => {
  if (input === null || typeof input === "string" || typeof input === "boolean") return true;
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input !== "object" || ancestors.has(input)) return false;
  if (!Array.isArray(input) && ![null, Object.prototype].includes(Object.getPrototypeOf(input))) {
    return false;
  }
  if (Object.getOwnPropertySymbols(input).length > 0) return false;
  const next = new Set(ancestors).add(input);
  if (Array.isArray(input)) {
    if (Reflect.ownKeys(input).length !== input.length + 1) return false;
    for (let index = 0; index < input.length; index++) {
      const property = Object.getOwnPropertyDescriptor(input, index);
      if (!property?.enumerable || !("value" in property) || !isJsonValue(property.value, next))
        return false;
    }
    return true;
  }
  return Object.getOwnPropertyNames(input).every((key) => {
    const property = Object.getOwnPropertyDescriptor(input, key);
    return (
      property?.enumerable === true && "value" in property && isJsonValue(property.value, next)
    );
  });
};

export const JsonValue: Schema.Schema<JsonValue> = Schema.declare<JsonValue>(
  (input): input is JsonValue => isJsonValue(input),
  {
    identifier: "JsonValue",
    jsonSchema: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        { type: "array" },
        { type: "object" },
      ],
    },
  },
);
export const JsonRecord = JsonValue.pipe(
  Schema.filter(
    (value): value is { readonly [key: string]: JsonValue } =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  ),
);
export const StringRecord = Schema.Record({ key: Schema.String, value: Schema.String });
export const optional = <S extends Schema.Schema.All>(schema: S) =>
  Schema.optionalWith(schema, { exact: true });

export const HttpUrl = NonEmptyString.pipe(
  Schema.filter((value) => {
    const decoded = Schema.decodeUnknownOption(Schema.URL)(value);
    return decoded._tag === "Some" && ["http:", "https:"].includes(decoded.value.protocol);
  }),
);

export const uniqueBy = <A>(values: readonly A[], key: (value: A) => string): boolean =>
  new Set(values.map(key)).size === values.length;

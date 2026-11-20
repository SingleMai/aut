import { isDeepStrictEqual } from "node:util";
import { type Expr, type JsonValue, type Predicate, SafeKey } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { TreeError } from "./errors.js";

export interface EvaluationContext {
  readonly state: JsonValue;
  readonly answers: JsonValue;
  readonly vars: Readonly<Record<string, JsonValue>>;
  readonly thresholds: Readonly<Record<string, number>>;
}

const invalid = (message: string) => Effect.fail(new TreeError({ code: "Expression", message }));
const lookup = (value: JsonValue, key: string): JsonValue =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? ((value as Readonly<Record<string, JsonValue>>)[key] ?? null)
    : null;
const pathValue = (value: JsonValue, path: readonly string[]): JsonValue =>
  path.reduce(lookup, value);
const array = (value: JsonValue) =>
  Array.isArray(value)
    ? Effect.succeed(value as readonly JsonValue[])
    : invalid("Expected an array.");

/** Evaluates only the protocol AST. No source text, globals or prototype properties are executable. */
export const evaluate = (
  expression: Expr,
  context: EvaluationContext,
  depth = 0,
): Effect.Effect<JsonValue, TreeError> =>
  Effect.suspend(() => {
    if (depth > 100) return invalid("Expression nesting exceeds the evaluation limit.");
    const child = (value: Expr, scope = context) => evaluate(value, scope, depth + 1);
    switch (expression.kind) {
      case "literal":
        return Effect.succeed(expression.value);
      case "ref":
        return Effect.succeed(pathValue(context as unknown as JsonValue, expression.path));
      case "object":
        return Effect.forEach(Object.entries(expression.fields), ([key, value]) =>
          child(value).pipe(Effect.map((result) => [key, result] as const)),
        ).pipe(Effect.map(Object.fromEntries));
      case "array":
        return Effect.forEach(expression.items, (value) => child(value));
      case "get":
        return Effect.gen(function* () {
          const from = yield* child(expression.from);
          const key = yield* child(expression.key);
          if (typeof key !== "string" || !Schema.is(SafeKey)(key))
            return yield* invalid("Lookup keys must be safe strings.");
          return lookup(from, key);
        });
      case "map":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          return yield* Effect.forEach(values, (value) =>
            child(expression.value, {
              ...context,
              vars: { ...context.vars, [expression.as]: value },
            }),
          );
        });
      case "entries":
        return Effect.gen(function* () {
          const from = yield* child(expression.from);
          if (from === null || typeof from !== "object" || Array.isArray(from))
            return yield* invalid("Entries requires an object.");
          return Object.entries(from).map(([key, value]) => ({ key, value }));
        });
      case "record":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          const pairs: [string, JsonValue][] = [];
          const keys = new Set<string>();
          for (const [index, value] of values.entries()) {
            const scope = {
              ...context,
              vars: {
                ...context.vars,
                ...(expression.indexAs && { [expression.indexAs]: index }),
                [expression.as]: value,
              },
            };
            const key = yield* child(expression.key, scope);
            if (typeof key !== "string" || !Schema.is(SafeKey)(key) || keys.has(key))
              return yield* invalid("Record keys must be unique safe strings.");
            keys.add(key);
            pairs.push([key, yield* child(expression.value, scope)]);
          }
          return Object.fromEntries(pairs);
        });
      case "filter":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          return yield* Effect.filter(values, (value) =>
            testPredicate(
              expression.where,
              { ...context, vars: { ...context.vars, [expression.as]: value } },
              depth + 1,
            ),
          );
        });
      case "choose":
        return testPredicate(expression.when, context, depth + 1).pipe(
          Effect.flatMap((match) => child(match ? expression.then : expression.else)),
        );
      case "take":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          const count = yield* child(expression.count);
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
            return yield* invalid("Take count must be a nonnegative safe integer.");
          return values.slice(0, count);
        });
      case "sort":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          const keyed = values.map((value) => ({ value, key: pathValue(value, expression.by) }));
          if (keyed.some(({ key }) => typeof key !== "number" && typeof key !== "string"))
            return yield* invalid("Sort keys must be strings or numbers.");
          if (new Set(keyed.map(({ key }) => typeof key)).size > 1)
            return yield* invalid("Sort keys must have the same scalar type.");
          const direction = expression.direction === "asc" ? 1 : -1;
          return keyed
            .sort((left, right) => {
              if (left.key === right.key) return 0;
              if (typeof left.key === "number" && typeof right.key === "number")
                return (left.key - right.key) * direction;
              return String(left.key) < String(right.key) ? -direction : direction;
            })
            .map(({ value }) => value);
        });
      case "budget":
        return Effect.gen(function* () {
          const values = yield* child(expression.from).pipe(Effect.flatMap(array));
          const limit = yield* child(expression.limit);
          if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
            return yield* invalid("Budget limit must be a nonnegative safe integer.");
          const selected: JsonValue[] = [];
          let remaining = limit;
          for (const value of values) {
            const cost = pathValue(value, expression.by);
            if (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 0)
              return yield* invalid("Budget costs must be nonnegative safe integers.");
            if (limit > 0 && cost <= remaining) {
              selected.push(value);
              remaining -= cost;
            }
          }
          return selected;
        });
      case "concat":
        return Effect.forEach(expression.items, (value) =>
          child(value).pipe(Effect.flatMap(array)),
        ).pipe(Effect.map((values) => values.flat()));
      case "length":
        return Effect.gen(function* () {
          const value = yield* child(expression.value);
          return typeof value === "string" || Array.isArray(value)
            ? value.length
            : yield* invalid("Length requires an array or string.");
        });
      case "template":
        return Effect.gen(function* () {
          const values = yield* Effect.forEach(Object.entries(expression.values), ([key, value]) =>
            child(value).pipe(Effect.map((result) => [key, result] as const)),
          );
          if (values.some(([, value]) => value !== null && typeof value === "object"))
            return yield* invalid("Template substitutions must be scalar values.");
          const fields = Object.fromEntries(values);
          const missing = [...expression.text.matchAll(/\{([^{}]+)\}/g)].some(
            (match) => !Object.hasOwn(fields, match[1] ?? ""),
          );
          if (missing) return yield* invalid("Template placeholder has no binding.");
          return expression.text.replace(/\{([^{}]+)\}/g, (_, key: string) =>
            String(fields[key] ?? ""),
          );
        });
    }
  });

export const testPredicate = (
  predicate: Predicate,
  context: EvaluationContext,
  depth = 0,
): Effect.Effect<boolean, TreeError> =>
  Effect.suspend(() => {
    if (depth > 100) return invalid("Predicate nesting exceeds the evaluation limit.");
    switch (predicate.kind) {
      case "exists":
        return evaluate(predicate.value, context, depth + 1).pipe(
          Effect.map((value) => value !== null),
        );
      case "not":
        return testPredicate(predicate.predicate, context, depth + 1).pipe(
          Effect.map((value) => !value),
        );
      case "all":
      case "any":
        return Effect.gen(function* () {
          for (const child of predicate.predicates) {
            const result = yield* testPredicate(child, context, depth + 1);
            if (predicate.kind === "all" && !result) return false;
            if (predicate.kind === "any" && result) return true;
          }
          return predicate.kind === "all";
        });
      case "compare":
        return Effect.gen(function* () {
          const left = yield* evaluate(predicate.left, context, depth + 1);
          const right = yield* evaluate(predicate.right, context, depth + 1);
          if (predicate.op === "eq") return isDeepStrictEqual(left, right);
          if (predicate.op === "ne") return !isDeepStrictEqual(left, right);
          if (typeof left !== "number" || typeof right !== "number")
            return yield* invalid("Ordered comparisons require numbers.");
          switch (predicate.op) {
            case "gt":
              return left > right;
            case "gte":
              return left >= right;
            case "lt":
              return left < right;
            case "lte":
              return left <= right;
          }
        });
    }
  });

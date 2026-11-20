import { Expr, type JsonValue, type Predicate } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { type EvaluationContext, evaluate, testPredicate } from "./expression.js";

const context: EvaluationContext = {
  state: {
    values: [
      { id: "a", score: 0.6 },
      { id: "b", score: 0.9 },
      { id: "c", score: 0.6 },
    ],
    text: "中文",
    dangerous: "__proto__",
  },
  answers: {},
  vars: {},
  thresholds: { low: 0.4 },
};
const literal = (value: JsonValue): Expr => ({ kind: "literal", value });
const ref = (...path: string[]): Expr => ({ kind: "ref", path });
const run = (value: Expr) =>
  Effect.runPromise(evaluate(Schema.decodeUnknownSync(Expr)(value), context));

describe("pure expression evaluation", () => {
  it("selects complete items within a cumulative budget and skips oversized items", async () => {
    const expression: Expr = {
      kind: "budget",
      from: literal([
        { id: "large", cost: 20 },
        { id: "a", cost: 4 },
        { id: "b", cost: 6 },
        { id: "c", cost: 1 },
      ]),
      by: ["cost"],
      limit: literal(10),
    };
    expect(await run(expression)).toEqual([
      { id: "a", cost: 4 },
      { id: "b", cost: 6 },
    ]);
    expect(await run({ ...expression, limit: literal(0) })).toEqual([]);
    expect(await run({ ...expression, from: literal([{ cost: 0 }]), limit: literal(0) })).toEqual(
      [],
    );
  });
  it.each([
    { kind: "budget", from: literal([{ cost: -1 }]), by: ["cost"], limit: literal(1) },
    { kind: "budget", from: literal([{ cost: 1.1 }]), by: ["cost"], limit: literal(2) },
    { kind: "budget", from: literal([{}]), by: ["cost"], limit: literal(2) },
    { kind: "budget", from: literal([]), by: ["cost"], limit: literal(-1) },
    { kind: "budget", from: literal([]), by: ["cost"], limit: literal(1.5) },
    { kind: "budget", from: literal([]), by: ["cost"], limit: literal(Number.POSITIVE_INFINITY) },
    {
      kind: "budget",
      from: literal([{ cost: Number.POSITIVE_INFINITY }]),
      by: ["cost"],
      limit: literal(2),
    },
  ] satisfies Expr[])("rejects malformed budget values", async (expression) => {
    const result = await Effect.runPromise(evaluate(expression, context).pipe(Effect.either));
    expect(result._tag === "Left" && result.left.code).toBe("Expression");
  });
  it("counts alternating expression and predicate nesting toward the same limit", async () => {
    let expression: Expr = literal(true);
    for (let index = 0; index < 110; index++)
      expression = {
        kind: "choose",
        when: { kind: "exists", value: expression },
        // biome-ignore lint/suspicious/noThenProperty: The fixture contains a data branch.
        then: literal(true),
        else: literal(false),
      };
    const result = await Effect.runPromise(Effect.either(evaluate(expression, context)));
    expect(result._tag === "Left" && result.left.code).toBe("Expression");
  });
  it("maps sorted candidates with scoped bindings, stable ties and a configurable take", async () => {
    expect(
      await run({
        kind: "map",
        as: "candidate",
        from: {
          kind: "take",
          from: { kind: "sort", from: ref("state", "values"), by: ["score"], direction: "desc" },
          count: literal(3),
        },
        value: ref("vars", "candidate", "id"),
      }),
    ).toEqual(["b", "a", "c"]);
    expect(context.vars).toEqual({});
  });

  it("constructs objects, arrays and templates without evaluating source strings", async () => {
    expect(
      await run({
        kind: "object",
        fields: {
          label: {
            kind: "template",
            text: "Message: {text}",
            values: { text: ref("state", "text") },
          },
          values: {
            kind: "concat",
            items: [{ kind: "array", items: [literal(1)] }, literal([2, 3])],
          },
          length: { kind: "length", value: ref("state", "text") },
          script: literal("process.exit(1)"),
        },
      }),
    ).toEqual({ label: "Message: 中文", values: [1, 2, 3], length: 2, script: "process.exit(1)" });
  });

  it("returns null for absent own properties and never reads prototypes", async () => {
    expect(await run(ref("state", "missing"))).toBe(null);
    expect(await run({ kind: "get", from: ref("state"), key: literal("toString") })).toBe(null);
    const result = await Effect.runPromise(
      Effect.either(
        evaluate({ kind: "get", from: ref("state"), key: ref("state", "dangerous") }, context),
      ),
    );
    expect(result._tag).toBe("Left");
  });

  it.each([
    { kind: "take", from: literal([]), count: literal(-1) },
    { kind: "map", from: literal(1), as: "value", value: ref("vars", "value") },
    { kind: "length", value: literal(null) },
    { kind: "template", text: "{missing}", values: {} },
    { kind: "template", text: "{value}", values: { value: literal({}) } },
  ] satisfies Expr[])(
    "fails invalid expression types without defects: $kind",
    async (expression) => {
      const result = await Effect.runPromise(Effect.either(evaluate(expression, context)));
      expect(result._tag === "Left" && result.left.code).toBe("Expression");
    },
  );

  it("short-circuits predicates and compares thresholds without coercion", async () => {
    const bad: Predicate = { kind: "compare", op: "gt", left: literal("1"), right: literal(0) };
    const valid: Predicate = {
      kind: "compare",
      op: "gte",
      left: literal(0.4),
      right: ref("thresholds", "low"),
    };
    expect(
      await Effect.runPromise(testPredicate({ kind: "any", predicates: [valid, bad] }, context)),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        testPredicate(
          { kind: "all", predicates: [{ kind: "not", predicate: valid }, bad] },
          context,
        ),
      ),
    ).toBe(false);
    expect((await Effect.runPromise(Effect.either(testPredicate(bad, context))))._tag).toBe("Left");
  });

  it("filters probability entries and reconstructs a record without changing values", async () => {
    const entries: Expr = { kind: "entries", from: literal({ a: 0.2, b: 0.8 }) };
    expect(
      await run({
        kind: "record",
        from: {
          kind: "filter",
          from: entries,
          as: "entry",
          where: {
            kind: "compare",
            op: "gte",
            left: ref("vars", "entry", "value"),
            right: literal(0.5),
          },
        },
        as: "entry",
        key: ref("vars", "entry", "key"),
        value: ref("vars", "entry", "value"),
      }),
    ).toEqual({ b: 0.8 });
  });

  it("evaluates only the chosen branch", async () => {
    expect(
      await run({
        kind: "choose",
        when: { kind: "exists", value: ref("state", "text") },
        // biome-ignore lint/suspicious/noThenProperty: The fixture contains a data branch.
        then: literal("selected"),
        else: { kind: "length", value: literal(null) },
      }),
    ).toBe("selected");
  });

  it.each([["a", "a"], ["__proto__"], ["constructor"]])(
    "rejects duplicate or prototype record keys %j",
    async (...keys) => {
      const from = literal(keys.flat());
      const result = await Effect.runPromise(
        Effect.either(
          evaluate(
            { kind: "record", from, as: "key", key: ref("vars", "key"), value: literal(1) },
            context,
          ),
        ),
      );
      expect(result._tag === "Left" && result.left.code).toBe("Expression");
    },
  );
});

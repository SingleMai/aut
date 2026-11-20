import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Expr, Predicate, QuestionBinding, TreeConfig, TreeNode } from "./tree.js";

const literal = (value: string | number | boolean | null): Expr => ({ kind: "literal", value });
const reference = (path: string[]): Expr => ({ kind: "ref", path });
const exists: Predicate = { kind: "exists", value: reference(["state", "message"]) };
const output: TreeNode = { type: "action", output: literal("result") };
const tree = (nodes: Record<string, TreeNode> = { start: output }): TreeConfig => ({
  name: "inbound",
  version: "1",
  entry: "start",
  thresholds: { confidence: 0.6, limit: 2 },
  nodes,
});

function roundTrip<A>(schema: Schema.Schema<A>, input: unknown) {
  const decoded = Schema.decodeUnknownSync(schema)(input);
  const json = JSON.stringify(Schema.encodeSync(schema)(decoded));
  expect(Schema.decodeUnknownSync(schema)(JSON.parse(json))).toEqual(decoded);
}

const expressions: Expr[] = [
  literal("hello"),
  reference(["state", "message"]),
  { kind: "object", fields: { text: literal("message") } },
  { kind: "array", items: [literal(1), literal(true), literal(null)] },
  { kind: "get", from: reference(["state"]), key: literal("message") },
  { kind: "entries", from: reference(["answers", "op", "probabilities"]) },
  {
    kind: "record",
    from: reference(["state", "candidates"]),
    as: "item",
    key: reference(["vars", "item", "id"]),
    value: reference(["vars", "item", "description"]),
  },
  {
    kind: "filter",
    from: reference(["state", "candidates"]),
    as: "item",
    where: { kind: "exists", value: reference(["vars", "item", "id"]) },
  },
  {
    kind: "choose",
    when: { kind: "exists", value: reference(["state", "fixedTargetId"]) },
    // biome-ignore lint/suspicious/noThenProperty: The fixture contains a data branch.
    then: reference(["state", "fixedTargetId"]),
    else: literal("none"),
  },
  {
    kind: "map",
    from: reference(["state", "candidates"]),
    as: "candidate",
    value: reference(["vars", "candidate"]),
  },
  {
    kind: "take",
    from: reference(["state", "candidates"]),
    count: reference(["thresholds", "limit"]),
  },
  {
    kind: "sort",
    from: reference(["state", "candidates"]),
    by: ["probability"],
    direction: "desc",
  },
  {
    kind: "concat",
    items: [
      { kind: "array", items: [] },
      { kind: "array", items: [literal("x")] },
    ],
  },
  { kind: "length", value: reference(["state", "candidates"]) },
  {
    kind: "budget",
    from: reference(["state", "candidates"]),
    by: ["cost"],
    limit: reference(["thresholds", "limit"]),
  },
  { kind: "template", text: "Selected {name}", values: { name: reference(["state", "name"]) } },
];

describe("pure expression schemas", () => {
  it.each(expressions)("round-trips $kind expressions", (expression) =>
    roundTrip(Expr, expression),
  );

  it.each([
    { kind: "eval", code: "process.exit()" },
    { kind: "call", function: "routeIntent" },
    { kind: "ref", path: [] },
    { kind: "ref", path: ["process", "env"] },
    { kind: "ref", path: ["state", "__proto__"] },
    { kind: "ref", path: ["state", "constructor"] },
    { kind: "ref", path: ["state", "prototype"] },
    { kind: "get", from: reference(["state"]), key: literal("__proto__") },
    { kind: "map", from: literal(null), as: "constructor", value: literal(null) },
    { kind: "sort", from: literal(null), by: ["prototype"], direction: "asc" },
    { kind: "budget", from: literal(null), by: [], limit: literal(1) },
    { kind: "budget", from: literal(null), by: ["__proto__"], limit: literal(1) },
    { kind: "literal", value: Number.POSITIVE_INFINITY },
    { kind: "literal", value: () => "not JSON" },
    { kind: "object", fields: JSON.parse('{"__proto__":{"kind":"literal","value":1}}') },
  ])("rejects invalid or executable expressions %#", (value) => {
    expect(Schema.is(Expr)(value)).toBe(false);
  });

  it("keeps script-like text inert inside a literal or template", () => {
    roundTrip(Expr, literal("process.exit()"));
    roundTrip(Expr, {
      kind: "template",
      text: "process.exit({code})",
      values: { code: literal(0) },
    });
  });
});

describe("predicate and question schemas", () => {
  it.each<Predicate>([
    exists,
    {
      kind: "compare",
      op: "gte",
      left: reference(["answers", "confidence"]),
      right: reference(["thresholds", "confidence"]),
    },
    { kind: "all", predicates: [exists] },
    { kind: "any", predicates: [exists, { kind: "not", predicate: exists }] },
    { kind: "not", predicate: { kind: "all", predicates: [exists] } },
  ])("round-trips $kind predicates", (predicate) => roundTrip(Predicate, predicate));

  it("rejects unknown predicate operators", () => {
    expect(
      Schema.is(Predicate)({ kind: "compare", op: "execute", left: literal(1), right: literal(2) }),
    ).toBe(false);
  });

  it.each(["choice", "noul", "score"] as const)("round-trips %s question bindings", (type) => {
    roundTrip(QuestionBinding, {
      id: reference(["vars", "candidate", "id"]),
      question:
        type === "noul"
          ? { type, instructions: "Is this relevant?" }
          : {
              type,
              instructions: "Select a matching option.",
              criteria: reference(["state", "criteria"]),
            },
      when: exists,
      repeat: { from: reference(["state", "candidates"]), as: "candidate" },
    });
  });

  it("rejects incomplete question bindings", () => {
    expect(
      Schema.is(QuestionBinding)({
        id: literal("q"),
        question: { type: "choice", instructions: "Choose." },
      }),
    ).toBe(false);
    expect(
      Schema.is(QuestionBinding)({
        id: literal("q"),
        question: { type: "noul", instructions: "" },
      }),
    ).toBe(false);
    for (const value of ["", 1, true, null]) {
      expect(
        Schema.is(QuestionBinding)({
          id: literal(value),
          question: { type: "noul", instructions: "Is this relevant?" },
        }),
      ).toBe(false);
    }
  });
});

describe("tree nodes and static graph validation", () => {
  const nodes: TreeNode[] = [
    // biome-ignore lint/suspicious/noThenProperty: This is the documented string edge, not a callable thenable.
    { type: "rule", when: exists, then: "done", else: "fallback" },
    { type: "branch", cases: [{ when: exists, next: "done" }], otherwise: "fallback" },
    {
      type: "classify",
      state: reference(["state"]),
      questions: [
        { id: literal("q"), question: { type: "noul", instructions: "Is this relevant?" } },
      ],
      next: "done",
      onError: "fallback",
    },
    output,
    { type: "slow", reason: literal("ambiguous"), messageIds: reference(["state", "messageIds"]) },
    { type: "rewrite", instructions: "Rewrite concisely.", next: "done", onError: "fallback" },
  ];

  it.each(nodes)("round-trips $type nodes", (node) => roundTrip(TreeNode, node));

  it("requires explicit failure edges for model nodes", () => {
    expect(
      Schema.is(TreeNode)({ type: "classify", state: literal(null), questions: [], next: "done" }),
    ).toBe(false);
    expect(Schema.is(TreeNode)({ type: "rewrite", instructions: "Rewrite.", next: "done" })).toBe(
      false,
    );
    expect(Schema.is(TreeNode)({ type: "execute", command: "routeIntent" })).toBe(false);
  });

  it.each(["inbound", "reply-gate", "request", "handoff-prune"] as const)(
    "round-trips a %s tree",
    (name) => {
      roundTrip(TreeConfig, { ...tree(), name });
    },
  );

  it.each(nodes)("validates outgoing edges of $type nodes", (node) => {
    const valid = {
      ...tree({ start: node, done: output, fallback: output }),
      name: node.type === "rewrite" ? "reply-gate" : "inbound",
    };
    roundTrip(TreeConfig, valid);
    if (["rule", "branch", "classify", "rewrite"].includes(node.type)) {
      expect(Schema.is(TreeConfig)({ ...valid, nodes: { start: node, done: output } })).toBe(false);
    }
  });

  it("rejects missing entry points and nonfinite thresholds", () => {
    expect(Schema.is(TreeConfig)({ ...tree(), entry: "missing" })).toBe(false);
    expect(Schema.is(TreeConfig)({ ...tree(), thresholds: { confidence: Number.NaN } })).toBe(
      false,
    );
  });

  it("validates threshold references inside nested expressions and predicates", () => {
    const nested: TreeNode = {
      type: "rule",
      when: {
        kind: "not",
        predicate: {
          kind: "all",
          predicates: [
            {
              kind: "compare",
              op: "gte",
              left: literal(1),
              right: {
                kind: "length",
                value: { kind: "array", items: [reference(["thresholds", "missing"])] },
              },
            },
          ],
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: This is the documented string edge, not a callable thenable.
      then: "done",
      else: "done",
    };
    expect(Schema.is(TreeConfig)(tree({ start: nested, done: output }))).toBe(false);
    expect(
      Schema.is(TreeConfig)(
        tree({
          start: {
            type: "action",
            output: { kind: "get", from: reference(["thresholds"]), key: literal("missing") },
          },
        }),
      ),
    ).toBe(false);
    roundTrip(
      TreeConfig,
      tree({
        start: {
          type: "action",
          output: {
            kind: "take",
            from: reference(["state", "candidates"]),
            count: reference(["thresholds", "limit"]),
          },
        },
      }),
    );
  });

  it("does not interpret JSON literal contents as expression references", () => {
    roundTrip(
      TreeConfig,
      tree({
        start: {
          type: "action",
          output: { kind: "literal", value: { kind: "ref", path: ["thresholds", "missing"] } },
        },
      }),
    );
  });

  it("restricts slow and rewrite nodes to their declared trees", () => {
    const slow: TreeNode = {
      type: "slow",
      reason: literal("reason"),
      messageIds: { kind: "array", items: [] },
    };
    const rewrite: TreeNode = {
      type: "rewrite",
      instructions: "Rewrite.",
      next: "done",
      onError: "done",
    };
    expect(Schema.is(TreeConfig)({ ...tree({ start: slow }), name: "request" })).toBe(false);
    expect(Schema.is(TreeConfig)(tree({ start: rewrite, done: output }))).toBe(false);
  });

  it("permits explicit loops without pretending to enforce the runtime execution budget", () => {
    roundTrip(TreeConfig, {
      ...tree({
        start: { type: "rewrite", instructions: "Rewrite.", next: "start", onError: "done" },
        done: output,
      }),
      name: "reply-gate",
    });
  });
});

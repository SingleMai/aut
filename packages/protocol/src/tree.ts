import { Schema } from "effect";
import { FiniteNumber, JsonValue, NonEmptyString, optional, SafeKey } from "./common.js";

// Recursive shapes close the schema cycle; public types are inferred from the schemas.
type ExprShape =
  | { readonly kind: "literal"; readonly value: JsonValue }
  | { readonly kind: "ref"; readonly path: readonly string[] }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ExprShape>> }
  | { readonly kind: "array" | "concat"; readonly items: readonly ExprShape[] }
  | { readonly kind: "get"; readonly from: ExprShape; readonly key: ExprShape }
  | { readonly kind: "entries"; readonly from: ExprShape }
  | {
      readonly kind: "record";
      readonly indexAs?: string;
      readonly from: ExprShape;
      readonly as: string;
      readonly key: ExprShape;
      readonly value: ExprShape;
    }
  | {
      readonly kind: "filter";
      readonly from: ExprShape;
      readonly as: string;
      readonly where: PredicateShape;
    }
  | {
      readonly kind: "choose";
      readonly when: PredicateShape;
      readonly then: ExprShape;
      readonly else: ExprShape;
    }
  | {
      readonly kind: "map";
      readonly from: ExprShape;
      readonly as: string;
      readonly value: ExprShape;
    }
  | { readonly kind: "take"; readonly from: ExprShape; readonly count: ExprShape }
  | {
      readonly kind: "budget";
      readonly from: ExprShape;
      readonly by: readonly string[];
      readonly limit: ExprShape;
    }
  | {
      readonly kind: "sort";
      readonly from: ExprShape;
      readonly by: readonly string[];
      readonly direction: "asc" | "desc";
    }
  | { readonly kind: "length"; readonly value: ExprShape }
  | {
      readonly kind: "template";
      readonly text: string;
      readonly values: Readonly<Record<string, ExprShape>>;
    };

type PredicateShape =
  | { readonly kind: "exists"; readonly value: ExprShape }
  | {
      readonly kind: "compare";
      readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      readonly left: ExprShape;
      readonly right: ExprShape;
    }
  | { readonly kind: "all" | "any"; readonly predicates: readonly PredicateShape[] }
  | { readonly kind: "not"; readonly predicate: PredicateShape };

const safeRecord = <A>(value: Schema.Schema<A>) =>
  Schema.declare<Readonly<Record<string, A>>>(
    (input): input is Readonly<Record<string, A>> =>
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      [null, Object.prototype].includes(Object.getPrototypeOf(input)) &&
      Object.getOwnPropertySymbols(input).length === 0 &&
      Object.keys(input).every(Schema.is(SafeKey)) &&
      Object.values(input).every(Schema.is(value, { onExcessProperty: "error" })),
    { identifier: "SafeTreeRecord" },
  );

const ReferencePath = Schema.Array(SafeKey).pipe(
  Schema.minItems(1),
  Schema.filter((path) => ["state", "answers", "vars", "thresholds"].includes(path[0] ?? ""), {
    message: () => "Reference root must be state, answers, vars or thresholds",
  }),
);

export const Expr: Schema.Schema<ExprShape> = Schema.suspend(() =>
  Schema.Union(
    Schema.Struct({ kind: Schema.Literal("literal"), value: JsonValue }),
    Schema.Struct({ kind: Schema.Literal("ref"), path: ReferencePath }),
    Schema.Struct({ kind: Schema.Literal("object"), fields: safeRecord(Expr) }),
    Schema.Struct({ kind: Schema.Literal("array"), items: Schema.Array(Expr) }),
    Schema.Struct({ kind: Schema.Literal("concat"), items: Schema.Array(Expr) }),
    Schema.Struct({ kind: Schema.Literal("get"), from: Expr, key: Expr }).pipe(
      Schema.filter(
        ({ key }) =>
          key.kind !== "literal" || typeof key.value !== "string" || Schema.is(SafeKey)(key.value),
        {
          message: () => "Literal lookup keys must be safe property names",
        },
      ),
    ),
    Schema.Struct({ kind: Schema.Literal("map"), from: Expr, as: SafeKey, value: Expr }),
    Schema.Struct({ kind: Schema.Literal("entries"), from: Expr }),
    Schema.Struct({
      kind: Schema.Literal("record"),
      indexAs: optional(SafeKey),
      from: Expr,
      as: SafeKey,
      key: Expr,
      value: Expr,
    }),
    Schema.Struct({
      kind: Schema.Literal("filter"),
      from: Expr,
      as: SafeKey,
      where: Schema.suspend(() => Predicate),
    }),
    Schema.Struct({
      kind: Schema.Literal("choose"),
      when: Schema.suspend(() => Predicate),
      // biome-ignore lint/suspicious/noThenProperty: This is a data expression branch, not a thenable.
      then: Expr,
      else: Expr,
    }),
    Schema.Struct({ kind: Schema.Literal("take"), from: Expr, count: Expr }),
    Schema.Struct({
      kind: Schema.Literal("budget"),
      from: Expr,
      by: Schema.Array(SafeKey).pipe(Schema.minItems(1)),
      limit: Expr,
    }),
    Schema.Struct({
      kind: Schema.Literal("sort"),
      from: Expr,
      by: Schema.Array(SafeKey).pipe(Schema.minItems(1)),
      direction: Schema.Literal("asc", "desc"),
    }),
    Schema.Struct({ kind: Schema.Literal("length"), value: Expr }),
    Schema.Struct({
      kind: Schema.Literal("template"),
      text: Schema.String,
      values: safeRecord(Expr),
    }),
  ),
);
export type Expr = typeof Expr.Type;

export const Predicate: Schema.Schema<PredicateShape> = Schema.suspend(() =>
  Schema.Union(
    Schema.Struct({ kind: Schema.Literal("exists"), value: Expr }),
    Schema.Struct({
      kind: Schema.Literal("compare"),
      op: Schema.Literal("eq", "ne", "gt", "gte", "lt", "lte"),
      left: Expr,
      right: Expr,
    }),
    Schema.Struct({ kind: Schema.Literal("all"), predicates: Schema.Array(Predicate) }),
    Schema.Struct({ kind: Schema.Literal("any"), predicates: Schema.Array(Predicate) }),
    Schema.Struct({ kind: Schema.Literal("not"), predicate: Predicate }),
  ),
);
export type Predicate = typeof Predicate.Type;

export const QuestionBinding = Schema.Struct({
  id: Expr,
  question: Schema.Union(
    Schema.Struct({ type: Schema.Literal("choice"), instructions: NonEmptyString, criteria: Expr }),
    Schema.Struct({ type: Schema.Literal("noul"), instructions: NonEmptyString }),
    Schema.Struct({ type: Schema.Literal("score"), instructions: NonEmptyString, criteria: Expr }),
  ),
  when: Schema.optionalWith(Predicate, { exact: true }),
  repeat: Schema.optionalWith(Schema.Struct({ from: Expr, as: SafeKey }), { exact: true }),
}).pipe(
  Schema.filter(({ id }) => id.kind !== "literal" || Schema.is(NonEmptyString)(id.value), {
    message: () => "Literal question IDs must be nonempty strings",
  }),
);
export type QuestionBinding = typeof QuestionBinding.Type;

export const TreeNode = Schema.Union(
  // biome-ignore lint/suspicious/noThenProperty: The protocol uses a string edge named then, not a callable thenable.
  Schema.Struct({ type: Schema.Literal("rule"), when: Predicate, then: SafeKey, else: SafeKey }),
  Schema.Struct({
    type: Schema.Literal("branch"),
    cases: Schema.Array(Schema.Struct({ when: Predicate, next: SafeKey })),
    otherwise: SafeKey,
  }),
  Schema.Struct({
    type: Schema.Literal("classify"),
    state: Expr,
    questions: Schema.Array(QuestionBinding),
    next: SafeKey,
    onError: SafeKey,
  }),
  Schema.Struct({ type: Schema.Literal("action"), output: Expr }),
  Schema.Struct({ type: Schema.Literal("slow"), reason: Expr, messageIds: Expr }),
  Schema.Struct({
    type: Schema.Literal("rewrite"),
    instructions: NonEmptyString,
    next: SafeKey,
    onError: SafeKey,
  }),
);
export type TreeNode = typeof TreeNode.Type;

const TreeConfigFields = Schema.Struct({
  name: Schema.Literal("inbound", "trigger", "reply-gate", "request", "handoff-prune"),
  version: NonEmptyString,
  entry: SafeKey,
  thresholds: safeRecord(FiniteNumber),
  nodes: safeRecord(TreeNode),
});

const expressionChildren = (expression: Expr): readonly Expr[] => {
  switch (expression.kind) {
    case "literal":
    case "ref":
      return [];
    case "object":
      return Object.values(expression.fields);
    case "array":
    case "concat":
      return expression.items;
    case "get":
      return [expression.from, expression.key];
    case "map":
      return [expression.from, expression.value];
    case "entries":
      return [expression.from];
    case "record":
      return [expression.from, expression.key, expression.value];
    case "filter":
      return [expression.from, ...predicateExpressions(expression.where)];
    case "choose":
      return [...predicateExpressions(expression.when), expression.then, expression.else];
    case "take":
      return [expression.from, expression.count];
    case "budget":
      return [expression.from, expression.limit];
    case "sort":
      return [expression.from];
    case "length":
      return [expression.value];
    case "template":
      return Object.values(expression.values);
  }
};

const predicateExpressions = (predicate: Predicate): readonly Expr[] => {
  switch (predicate.kind) {
    case "exists":
      return [predicate.value];
    case "compare":
      return [predicate.left, predicate.right];
    case "all":
    case "any":
      return predicate.predicates.flatMap(predicateExpressions);
    case "not":
      return predicateExpressions(predicate.predicate);
  }
};

const nodeReferences = (
  node: TreeNode,
): { readonly edges: readonly string[]; readonly expressions: readonly Expr[] } => {
  switch (node.type) {
    case "rule":
      return { edges: [node.then, node.else], expressions: predicateExpressions(node.when) };
    case "branch":
      return {
        edges: [...node.cases.map((entry) => entry.next), node.otherwise],
        expressions: node.cases.flatMap((entry) => predicateExpressions(entry.when)),
      };
    case "classify":
      return {
        edges: [node.next, node.onError],
        expressions: [
          node.state,
          ...node.questions.flatMap((binding) => [
            binding.id,
            ...(binding.question.type === "noul" ? [] : [binding.question.criteria]),
            ...(binding.when ? predicateExpressions(binding.when) : []),
            ...(binding.repeat ? [binding.repeat.from] : []),
          ]),
        ],
      };
    case "action":
      return { edges: [], expressions: [node.output] };
    case "slow":
      return { edges: [], expressions: [node.reason, node.messageIds] };
    case "rewrite":
      return { edges: [node.next, node.onError], expressions: [] };
  }
};

const validThresholdReferences = (
  expression: Expr,
  thresholds: Readonly<Record<string, number>>,
): boolean => {
  if (
    expression.kind === "ref" &&
    expression.path[0] === "thresholds" &&
    expression.path.length > 1
  ) {
    if (expression.path.length !== 2 || !Object.hasOwn(thresholds, expression.path[1] ?? ""))
      return false;
  }
  if (
    expression.kind === "get" &&
    expression.from.kind === "ref" &&
    expression.from.path.length === 1 &&
    expression.from.path[0] === "thresholds"
  ) {
    if (
      expression.key.kind !== "literal" ||
      typeof expression.key.value !== "string" ||
      !Object.hasOwn(thresholds, expression.key.value)
    )
      return false;
  }
  return expressionChildren(expression).every((child) =>
    validThresholdReferences(child, thresholds),
  );
};

export const TreeConfig = TreeConfigFields.pipe(
  Schema.filter((tree) => {
    if (!Object.hasOwn(tree.nodes, tree.entry)) return "Tree entry must name an existing node";
    for (const node of Object.values(tree.nodes)) {
      if (node.type === "slow" && tree.name !== "inbound")
        return "Slow nodes are only valid in inbound trees";
      if (node.type === "rewrite" && tree.name !== "reply-gate")
        return "Rewrite nodes are only valid in reply-gate trees";
      const { edges, expressions } = nodeReferences(node);
      if (edges.some((edge) => !Object.hasOwn(tree.nodes, edge)))
        return "All tree edges must name existing nodes";
      if (expressions.some((expression) => !validThresholdReferences(expression, tree.thresholds)))
        return "Threshold references must name existing threshold fields";
    }
    return true;
  }),
);
export type TreeConfig = typeof TreeConfig.Type;

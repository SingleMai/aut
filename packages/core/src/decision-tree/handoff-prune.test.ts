import { Classifier } from "@aut/classifier/interface";
import {
  ClassifierError,
  type DecisionRequest,
  type DecisionLog as LogRecord,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";
import { DecisionLog } from "../decision-log.js";
import { DecisionTree, DecisionTreeLive } from "./engine.js";
import { handoffPruneV1 } from "./handoff-prune.js";

const fixtures = [
  { name: "empty context", costs: [], probabilities: [], budget: 100, expected: [] },
  {
    name: "inclusive relevance threshold",
    costs: [1, 1, 1],
    probabilities: [0.499, 0.5, 0.501],
    budget: 10,
    expected: ["m1", "m2"],
  },
  {
    name: "probability priority",
    costs: [6, 6],
    probabilities: [0.7, 0.9],
    budget: 10,
    expected: ["m1"],
  },
  {
    name: "chronology restored",
    costs: [1, 1, 1],
    probabilities: [0.7, 0.9, 0.8],
    budget: 3,
    expected: ["m0", "m1", "m2"],
  },
  {
    name: "stable probability ties",
    costs: [6, 6],
    probabilities: [0.8, 0.8],
    budget: 6,
    expected: ["m0"],
  },
  {
    name: "skip oversized candidate",
    costs: [100, 10, 10],
    probabilities: [0.99, 0.8, 0.6],
    budget: 20,
    expected: ["m1", "m2"],
  },
  { name: "zero budget", costs: [1], probabilities: [1], budget: 0, expected: [] },
  { name: "all irrelevant", costs: [1, 1], probabilities: [0, 0.49], budget: 100, expected: [] },
  {
    name: "fallback latest two",
    costs: [1, 1, 1],
    probabilities: null,
    budget: 100,
    expected: ["m1", "m2"],
  },
  {
    name: "fallback remains bounded",
    costs: [1, 5, 100],
    probabilities: null,
    budget: 5,
    expected: ["m1"],
  },
];

for (const fixture of fixtures)
  it.effect(`handoff fixture: ${fixture.name}`, () =>
    Effect.gen(function* () {
      const records: LogRecord[] = [];
      const requests: DecisionRequest[] = [];
      const logs = Layer.succeed(DecisionLog, {
        write: (log) =>
          Effect.sync(() => {
            records.push(log);
            return log;
          }),
        get: () => Effect.succeed(Option.none()),
        complete: () => Effect.die("Unused"),
        correct: () => Effect.die("Unused"),
      });
      const layer = DecisionTreeLive().pipe(
        Layer.provide(
          Layer.merge(
            logs,
            Layer.succeed(Classifier, {
              backend: "mock",
              model: "deterministic",
              decide: (request) => {
                requests.push(request);
                return fixture.probabilities === null
                  ? Effect.fail(
                      new ClassifierError({
                        code: "TransportError",
                        message: "Synthetic backend failure",
                      }),
                    )
                  : Effect.succeed({
                      answers: Object.fromEntries(
                        Object.keys(request.questions).map((key, index) => [
                          key,
                          { type: "noul" as const, noul: fixture.probabilities?.[index] ?? 0 },
                        ]),
                      ),
                      latencyMs: 0,
                    });
              },
            }),
          ),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const tree = yield* DecisionTree;
        return yield* tree.run(handoffPruneV1, {
          eventRef: "fixture",
          state: {
            request: [{ messageId: "request", at: 100, text: "Synthetic request" }],
            candidates: fixture.costs.map((cost, order) => ({
              key: `candidate_${order}`,
              messageId: `m${order}`,
              order,
              cost,
              at: order,
              author: "user",
              text: `Context ${order}`,
            })),
            excerptBudget: fixture.budget,
          },
        });
      }).pipe(Effect.provide(layer));
      expect(result.output).toEqual({ excerpts: fixture.expected });
      expect(requests).toHaveLength(fixture.costs.length ? 1 : 0);
      expect(Object.keys(requests[0]?.questions ?? {})).toHaveLength(fixture.costs.length);
      expect(records).toHaveLength(1);
      if (fixture.probabilities === null) {
        expect(records[0]?.path).toEqual(["empty", "classify", "fallback"]);
        expect(records[0]?.classifierCalls[0]?.response).toBeUndefined();
        expect(records[0]?.classifierCalls[0]?.error).toContain("Synthetic backend failure");
      }
    }),
  );

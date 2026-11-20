import { randomUUID } from "node:crypto";
import { botChoiceQuestion, ConfigStore, DecisionLog, DecisionTree } from "@aut/core";
import {
  RouteTestInput,
  RouteTestResponse,
  RoutingCandidateId,
  type TreeConfig,
} from "@aut/protocol";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { DaemonError, decode } from "./errors.js";

export class RouteTest extends Context.Tag("aut/RouteTest")<
  RouteTest,
  {
    readonly run: (input: RouteTestInput) => Effect.Effect<RouteTestResponse, DaemonError>;
  }
>() {}

export const RouteTestLive = Layer.effect(
  RouteTest,
  Effect.gen(function* () {
    const config = yield* ConfigStore;
    const tree = yield* DecisionTree;
    const logs = yield* DecisionLog;
    return {
      run: (input) =>
        Effect.gen(function* () {
          const args = yield* decode(RouteTestInput, input);
          const id = randomUUID();
          const at = yield* Clock.currentTimeMillis;
          return yield* Effect.gen(function* () {
            const bots = yield* config.readBots;
            if (!bots.length || bots.some((bot) => !Schema.is(RoutingCandidateId)(bot.id)))
              return yield* Effect.fail(
                new DaemonError({
                  code: "Unavailable",
                  message: "At least one valid routable bot must be configured",
                }),
              );
            const configTree: TreeConfig = {
              name: "inbound",
              version: "route-test-1.1.0",
              entry: "classify",
              thresholds: {},
              nodes: {
                classify: {
                  type: "classify",
                  state: { kind: "ref", path: ["state"] },
                  questions: [botChoiceQuestion],
                  next: "selected",
                  onError: "unavailable",
                },
                selected: {
                  type: "action",
                  output: {
                    kind: "object",
                    fields: {
                      op: { kind: "literal", value: "new" },
                      botId: { kind: "ref", path: ["answers", "bot", "choice"] },
                      requestMessageIds: { kind: "literal", value: [] },
                    },
                  },
                },
                unavailable: {
                  type: "action",
                  output: {
                    kind: "literal",
                    value: {
                      op: "clarify",
                      card: {
                        id: `route-test:${id}`,
                        prompt: "分类服务暂时不可用",
                        options: [],
                        multiSelect: false,
                        allowFreeText: false,
                        state: "open",
                      },
                    },
                  },
                },
              },
            };
            yield* tree.run(configTree, {
              id,
              eventRef: `route-test:${id}`,
              state: {
                message: args.text,
                bots: bots.map(({ id, name, description }) => ({ id, name, description })),
              },
            });
            const log = yield* logs.get(id);
            const call = Option.isSome(log)
              ? [...log.value.classifierCalls].reverse().find((entry) => entry.response)
              : undefined;
            const answer = call?.response?.answers.bot;
            if (!call || answer?.type !== "choice") {
              yield* logs.complete(id, { ok: false, error: "Route test classifier unavailable" });
              return yield* Effect.fail(
                new DaemonError({
                  code: "Unavailable",
                  message: "The configured classifier could not complete the routing test",
                }),
              );
            }
            yield* logs.complete(id, { ok: true });
            return yield* decode(RouteTestResponse, {
              decisionLogId: id,
              selectedBotId: answer.choice,
              backend: call.backend,
              model: call.model,
              probabilities: bots.map((bot) => ({
                botId: bot.id,
                name: bot.name,
                probability: answer.probabilities[bot.id],
              })),
            });
          }).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                const previous = yield* logs.get(id);
                const execution = { ok: false, error: "The routing test could not be completed" };
                if (Option.isSome(previous)) yield* logs.complete(id, execution);
                else
                  yield* logs.write({
                    id,
                    at,
                    tree: "inbound",
                    treeVersion: "route-test-1.1.0",
                    input: {
                      eventRef: `route-test:${id}`,
                      state: { message: args.text },
                      dynamicOptions: {},
                    },
                    classifierCalls: [],
                    path: [],
                    execution,
                  });
              }),
            ),
          );
        }).pipe(
          Effect.mapError((error) =>
            error instanceof DaemonError
              ? error
              : new DaemonError({
                  code: "Unavailable",
                  message: "The routing test could not be completed",
                }),
          ),
        ),
    };
  }),
);

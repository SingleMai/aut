import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "@aut/classifier/interface";
import { BotId, type DecisionAnswer, MessageId, type Op, type Task } from "@aut/protocol";
import { Effect, Layer, Option } from "effect";
import { afterEach, expect, it } from "vitest";
import { Chief, ChiefLive } from "../chief/chief.js";
import { OpExecutor } from "../chief/ports.js";
import { StateSourceLive } from "../chief/state-source.js";
import { ConfigStore } from "../config-store.js";
import { DecisionTreeLive } from "../decision-tree/engine.js";
import { CoreLive } from "../index.js";
import { PrimaryAssistantLive, primaryBotConfig } from "../primary-assistant.js";
import { SessionManager } from "../session-manager/manager.js";
import { Store } from "../store.js";
import { SlowBrain, SlowBrainLive } from "./service.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it.each(["multi-intent", "low-confidence", "clarify-none"] as const)(
  "routes %s through the real Chief, inbound tree, stored state and slow-brain registration",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "aut-slow-integration-"));
    directories.push(directory);
    let classifierCalls = 0;
    let activations = 0;
    const registrations: { readonly op: Op; readonly origin: Task["origin"] | undefined }[] = [];
    const classifier = Layer.succeed(Classifier, {
      backend: "fixture",
      model: "fixture-1",
      decide: (request) =>
        Effect.sync(() => {
          classifierCalls += 1;
          const answers: Record<string, DecisionAnswer> = {};
          for (const [id, question] of Object.entries(request.questions)) {
            if (question.type === "noul") {
              answers[id] = {
                type: "noul",
                noul: id === "multi_intent" && mode === "multi-intent" ? 0.8 : 0.1,
              };
            } else if (question.type === "choice") {
              const keys = Object.keys(question.criteria);
              const choice = id === "op" ? "new_work" : id === "target" ? "none" : (keys[0] ?? "");
              const probability =
                keys.length === 1
                  ? 1
                  : id === "op"
                    ? mode === "low-confidence"
                      ? 0.3
                      : mode === "clarify-none"
                        ? 0.5
                        : 0.9
                    : 0.9;
              answers[id] = {
                type: "choice",
                choice,
                confidence: probability,
                probabilities: Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === choice ? probability : (1 - probability) / (keys.length - 1),
                  ]),
                ),
              };
            }
          }
          return { answers, latencyMs: 1 };
        }),
    });
    const manager = Layer.effect(
      SessionManager,
      Effect.gen(function* () {
        const store = yield* Store;
        return {
          snapshot: () => Effect.die("No session snapshots are needed during registration"),
          answer: () => Effect.die("No questions are answered during escalation"),
          register: (op, id, options) =>
            Effect.gen(function* () {
              registrations.push({ op, origin: options?.origin });
              expect(op.op).toBe("new");
              const existing = yield* store.transaction((tx) => tx.get("decision_logs", id));
              expect(Option.isSome(existing) && existing.value.output).toMatchObject({
                op: "escalate",
                decisionLogId: id,
              });
              return {
                execution: { ok: true },
                activate: store.transaction((tx) =>
                  Effect.gen(function* () {
                    const log = yield* tx.get("decision_logs", id);
                    const acknowledgement = yield* tx.get("main_thread_messages", `chief:${id}`);
                    expect(Option.isSome(log) && log.value.execution.ok).toBe(true);
                    expect(Option.isSome(acknowledgement) && acknowledgement.value.text).toBe(
                      "我想想",
                    );
                    activations += 1;
                  }),
                ),
              };
            }),
        };
      }),
    );
    const tree = DecisionTreeLive().pipe(
      Layer.provideMerge(Layer.merge(CoreLive({ dataDirectory: directory }), classifier)),
    );
    const dependencies = Layer.mergeAll(manager, StateSourceLive, PrimaryAssistantLive).pipe(
      Layer.provideMerge(tree),
    );
    const slow = SlowBrainLive.pipe(Layer.provideMerge(dependencies));
    const executor = Layer.effect(
      OpExecutor,
      Effect.gen(function* () {
        const service = yield* SlowBrain;
        return {
          execute: (op, id) =>
            op.op === "escalate"
              ? service.escalate(op, id)
              : op.op === "clarify"
                ? Effect.succeed({ execution: { ok: true } })
                : Effect.die("Unexpected operation"),
        };
      }),
    ).pipe(Layer.provideMerge(slow));
    const layer = ChiefLive.pipe(Layer.provideMerge(executor));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const config = yield* ConfigStore;
          const store = yield* Store;
          const chief = yield* Chief;
          const seed = {
            cwd: directory,
            modelSelection: { instanceId: "fixture", model: "fixture" },
          };
          yield* config.writeConfig({
            harnessInstances: [
              { id: "fixture", kind: "fixture", command: "unused", args: [], name: "Fixture" },
            ],
          });
          yield* config.writeBots([primaryBotConfig(BotId.make("aut"), seed)]);
          yield* store.transaction((tx) =>
            tx.insert("main_thread_messages", {
              id: MessageId.make("original"),
              at: 1,
              author: "user",
              kind: "text",
              text: "Original user request must be retained.",
            }),
          );
          const initial = yield* chief.submit(
            { source: "user", kind: "message", messageId: MessageId.make("original") },
            "original-event",
          );
          const result = yield* initial.awaitResult;
          expect(result.execution.ok).toBe(true);
          let finalLogId = initial.decisionLogId;
          if (mode === "clarify-none") {
            expect(result.op?.op).toBe("clarify");
            if (result.op?.op !== "clarify")
              return yield* Effect.die("Expected a clarification fixture");
            const selected = yield* chief.submit(
              {
                source: "user",
                kind: "ui-action",
                action: { type: "card-choice", cardId: result.op.card.id, optionId: "none" },
              },
              "none-event",
            );
            expect((yield* selected.awaitResult).execution.ok).toBe(true);
            finalLogId = selected.decisionLogId;
            const originalLog = yield* store.transaction((tx) =>
              tx.get("decision_logs", initial.decisionLogId),
            );
            expect(Option.isSome(originalLog) && originalLog.value.correction?.kind).toBe(
              "clarify-none",
            );
            const card = yield* store.transaction((tx) =>
              tx.get("main_thread_messages", `chief:${initial.decisionLogId}`),
            );
            expect(Option.isSome(card) && card.value.card?.state).toBe("answered");
          } else expect(result.op?.op).toBe("escalate");
          expect(registrations).toEqual([
            {
              op: { op: "new", botId: "aut", requestMessageIds: ["original"] },
              origin: { kind: "coordination", decisionLogId: finalLogId },
            },
          ]);
          expect(activations).toBe(1);
          expect(classifierCalls).toBe(1);
        }).pipe(Effect.provide(layer)),
      ),
    );
  },
);

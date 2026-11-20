import { BotId, type DecisionLog as LogRecord, MessageId, type Op, type Task } from "@aut/protocol";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { DecisionLog } from "../decision-log.js";
import { CoreError } from "../errors.js";
import { PrimaryAssistant, primaryBotConfig } from "../primary-assistant.js";
import { SessionManager } from "../session-manager/manager.js";
import { type EscalateOp, SlowBrain, SlowBrainLive } from "./service.js";

const op: EscalateOp = {
  op: "escalate",
  reason: "Uncertain routing",
  messageIds: [MessageId.make("original-message")],
  decisionLogId: "source",
};
const record = (id: string): LogRecord => ({
  id,
  at: 1,
  tree: "inbound",
  treeVersion: "1",
  input: { eventRef: "original-message", state: {}, dynamicOptions: {} },
  classifierCalls: [],
  path: ["slow"],
  output: op,
  execution: { ok: false, error: "Execution pending" },
});
const fixture = (
  records: Record<string, LogRecord> = { source: record("source"), current: record("current") },
  missingBot = false,
) => {
  const registrations: Array<{ op: Op; decisionLogId: string; origin?: Task["origin"] }> = [];
  let activated = false;
  const bot = primaryBotConfig(BotId.make("custom-slow-id"), {
    modelSelection: { instanceId: "local", model: "chosen" },
    cwd: "/project",
  });
  const unused = () => Effect.die("Escalation must not call this port");
  const receipt = {
    execution: { ok: true },
    activate: Effect.sync(() => {
      activated = true;
    }),
  };
  const layer = SlowBrainLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PrimaryAssistant, {
          get: missingBot
            ? Effect.fail(
                new CoreError({ code: "Configuration", message: "Missing primary assistant" }),
              )
            : Effect.succeed(bot),
        }),
        Layer.succeed(DecisionLog, {
          get: (id) => Effect.succeed(Option.fromNullable(records[id])),
          write: unused,
          correct: unused,
          complete: unused,
        }),
        Layer.succeed(SessionManager, {
          register: (newOp, decisionLogId, options) =>
            Effect.sync(() => {
              registrations.push({
                op: newOp,
                decisionLogId,
                ...(options?.origin ? { origin: options.origin } : {}),
              });
              return receipt;
            }),
          snapshot: unused,
          answer: unused,
        }),
      ),
    ),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, SlowBrain>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { run, registrations, receipt, activated: () => activated };
};

describe("slow-brain task registration", () => {
  it.each(["source", "current"])(
    "registers a normal task with immutable source provenance using %s decision",
    async (current) => {
      const records = { source: record("source"), current: record("current") };
      const before = structuredClone(records);
      const test = fixture(records);
      const registered = await test.run(
        Effect.flatMap(SlowBrain, (slow) => slow.escalate(op, current)),
      );
      expect(registered).toBe(test.receipt);
      expect(test.activated()).toBe(false);
      expect(test.registrations).toEqual([
        {
          op: { op: "new", botId: "custom-slow-id", requestMessageIds: ["original-message"] },
          decisionLogId: current,
          origin: { kind: "coordination", decisionLogId: "source" },
        },
      ]);
      expect(records).toEqual(before);
      if (registered.activate) await Effect.runPromise(registered.activate);
      expect(test.activated()).toBe(true);
    },
  );
  it.each(["missing source", "missing current", "mismatched source", "mismatched current"])(
    "rejects %s before any task registration",
    async (failure) => {
      const records: Record<string, LogRecord> = {
        source: record("source"),
        current: record("current"),
      };
      const key = failure.endsWith("source") ? "source" : "current";
      if (failure.startsWith("missing")) delete records[key];
      else records[key] = { ...record(key), output: { ...op, reason: "Different operation" } };
      const test = fixture(records);
      const result = await test.run(
        Effect.either(Effect.flatMap(SlowBrain, (slow) => slow.escalate(op, "current"))),
      );
      expect(result._tag).toBe("Left");
      expect(test.registrations).toHaveLength(0);
    },
  );
  it("does not create a placeholder task when the primary assistant is unconfigured", async () => {
    const test = fixture(undefined, true);
    const result = await test.run(
      Effect.either(Effect.flatMap(SlowBrain, (slow) => slow.escalate(op, "source"))),
    );
    expect(result._tag).toBe("Left");
    expect(test.registrations).toHaveLength(0);
  });
});

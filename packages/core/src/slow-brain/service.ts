import { isDeepStrictEqual } from "node:util";
import { Op } from "@aut/protocol";
import { Context, Effect, Layer, Option } from "effect";
import type { RegisteredExecution } from "../chief/ports.js";
import { DecisionLog } from "../decision-log.js";
import { CoreError, validate } from "../errors.js";
import { PrimaryAssistant } from "../primary-assistant.js";
import { SessionManager } from "../session-manager/manager.js";

export type EscalateOp = Extract<Op, { readonly op: "escalate" }>;
export class SlowBrain extends Context.Tag("aut/SlowBrain")<
  SlowBrain,
  {
    readonly escalate: (
      op: EscalateOp,
      currentDecisionLogId: string,
    ) => Effect.Effect<RegisteredExecution, CoreError>;
  }
>() {}
export const SlowBrainLive = Layer.effect(
  SlowBrain,
  Effect.gen(function* () {
    const primary = yield* PrimaryAssistant;
    const sessions = yield* SessionManager;
    const logs = yield* DecisionLog;
    return {
      escalate: (input, currentDecisionLogId) =>
        Effect.gen(function* () {
          const op = yield* validate(Op, input);
          if (op.op !== "escalate")
            return yield* Effect.fail(
              new CoreError({
                code: "InvalidRequest",
                message: "SlowBrain only accepts escalate operations.",
              }),
            );
          const source = yield* logs.get(op.decisionLogId);
          const current =
            currentDecisionLogId === op.decisionLogId
              ? source
              : yield* logs.get(currentDecisionLogId);
          if (
            Option.isNone(source) ||
            Option.isNone(current) ||
            !isDeepStrictEqual(source.value.output, op) ||
            !isDeepStrictEqual(current.value.output, op)
          )
            return yield* Effect.fail(
              new CoreError({
                code: "InvalidRequest",
                message: "The escalation does not match its persisted decision logs.",
              }),
            );
          const bot = yield* primary.get;
          return yield* sessions.register(
            { op: "new", botId: bot.id, requestMessageIds: op.messageIds },
            currentDecisionLogId,
            { origin: { kind: "coordination", decisionLogId: op.decisionLogId } },
          );
        }),
    };
  }),
);

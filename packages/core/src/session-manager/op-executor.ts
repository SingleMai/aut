import { Effect, Layer } from "effect";
import { OpExecutor } from "../chief/ports.js";
import { CoreError } from "../errors.js";
import { QuestionsService } from "../questions.js";
import { SessionManager } from "./manager.js";

/** MVP09 routes. Later operation services can compose the manager's register method. */
export const SessionOpExecutorLive = Layer.effect(
  OpExecutor,
  Effect.gen(function* () {
    const sessions = yield* SessionManager;
    const questions = yield* QuestionsService;
    return {
      execute: (op, decisionLogId, corrects) => {
        if (op.op === "new" || op.op === "new-trigger" || op.op === "send" || op.op === "control")
          return sessions.register(op, decisionLogId, corrects ? { corrects } : undefined);
        if (op.op === "clarify") return Effect.succeed({ execution: { ok: true } });
        if (op.op === "answer") return questions.register(op, decisionLogId);
        return Effect.fail(
          new CoreError({
            code: "Configuration",
            message: `The ${op.op} operation service is not configured`,
          }),
        );
      },
    };
  }),
);

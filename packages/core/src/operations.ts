import { Effect, Layer } from "effect";
import { OpExecutor } from "./chief/ports.js";
import { ProgressQuery } from "./progress/progress.js";
import { QuestionsService } from "./questions.js";
import { SessionManager } from "./session-manager/manager.js";
import { SlowBrain } from "./slow-brain/service.js";

/** Dispatches already decided operations; all routing decisions belong to the tree. */
export const OperationExecutorLive = Layer.effect(
  OpExecutor,
  Effect.gen(function* () {
    const sessions = yield* SessionManager;
    const questions = yield* QuestionsService;
    const progress = yield* ProgressQuery;
    const slow = yield* SlowBrain;
    return {
      execute: (op, decisionLogId, corrects) => {
        switch (op.op) {
          case "new":
          case "new-trigger":
          case "send":
          case "control":
            return sessions.register(op, decisionLogId, corrects ? { corrects } : undefined);
          case "answer":
            return questions.register(op, decisionLogId);
          case "ask":
            return progress.register(op, decisionLogId);
          case "escalate":
            return slow.escalate(op, decisionLogId);
          case "clarify":
            return Effect.succeed({ execution: { ok: true } });
        }
      },
    };
  }),
);

import { MessageId, type Op, SessionRequest } from "@aut/protocol";
import { Clock, Context, Effect, Layer, Option } from "effect";
import type { RegisteredExecution } from "./chief/ports.js";
import { DecisionLog } from "./decision-log.js";
import { DecisionTree } from "./decision-tree/engine.js";
import { requestV1 } from "./decision-tree/request.js";
import { CoreError, validate } from "./errors.js";
import { questionCardState } from "./request-cards.js";
import { SessionManager } from "./session-manager/manager.js";
import { SessionRequestRouter } from "./session-manager/ports.js";
import { Store } from "./store.js";

export const SessionRequestRouterLive = Layer.effect(
  SessionRequestRouter,
  Effect.gen(function* () {
    const store = yield* Store;
    const tree = yield* DecisionTree;
    const logs = yield* DecisionLog;
    return {
      opened: (raw, eventId) =>
        Effect.gen(function* () {
          const request = yield* validate(SessionRequest, raw);
          const result = yield* tree
            .run(requestV1, {
              id: `request:${request.id}`,
              eventRef: eventId,
              state: { ...request },
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "CoreError"
                  ? error
                  : new CoreError({ code: "InvalidRequest", message: "Request routing failed" }),
              ),
            );
          if (!("request" in result.output))
            return yield* Effect.fail(
              new CoreError({
                code: "InvalidRequest",
                message: "Invalid request routing output",
              }),
            );
          if (result.output.request === "relay") {
            const at = yield* Clock.currentTimeMillis;
            yield* store.transaction((tx) =>
              Effect.gen(function* () {
                const stored = yield* tx.get("session_requests", request.id);
                const task = yield* tx.get("tasks", request.taskId);
                if (Option.isNone(stored) || Option.isNone(task))
                  return yield* Effect.fail(
                    new CoreError({
                      code: "NotFound",
                      message: "The request owner is unavailable",
                    }),
                  );
                const id = MessageId.make(`question:${request.id}`);
                if (Option.isSome(yield* tx.get("main_thread_messages", id))) return;
                const prompt = request.questions.map((question) => question.text).join("\n\n");
                yield* tx.insert("main_thread_messages", {
                  id,
                  at,
                  author: { botId: task.value.botId, taskId: request.taskId },
                  kind: "question-card",
                  taskId: request.taskId,
                  decisionLogId: result.decisionLogId,
                  text: prompt,
                  card: {
                    id: `question:${request.id}`,
                    requestId: request.id,
                    prompt,
                    options: [],
                    multiSelect: false,
                    allowFreeText: false,
                    state: questionCardState(stored.value),
                  },
                });
              }),
            );
          }
          yield* logs.complete(result.decisionLogId, { ok: true });
        }),
    };
  }),
);

export class QuestionsService extends Context.Tag("aut/QuestionsService")<
  QuestionsService,
  {
    readonly register: (
      op: Extract<Op, { op: "answer" }>,
      decisionLogId: string,
    ) => Effect.Effect<RegisteredExecution, CoreError>;
  }
>() {}

export const QuestionsServiceLive = Layer.effect(
  QuestionsService,
  Effect.gen(function* () {
    const manager = yield* SessionManager;
    return { register: manager.answer };
  }),
);

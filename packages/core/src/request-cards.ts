import type { QuestionAnswer, RequestId, SessionRequest, TaskId } from "@aut/protocol";
import { Effect } from "effect";
import { CoreError } from "./errors.js";
import type { StoredRequest } from "./storage-model.js";
import type { StoreTransaction } from "./store.js";

const invalid = (message: string) =>
  Effect.fail(new CoreError({ code: "InvalidRequest", message }));

/** Structural validation alone cannot match answers to the original questions and options. */
export const validateQuestionAnswer = (request: SessionRequest, answer: QuestionAnswer) => {
  if (request.kind !== "question") return invalid("A permission request cannot receive an answer");
  if (answer.perQuestion.length !== request.questions.length)
    return invalid("Every question must be answered together");
  for (const question of request.questions) {
    const value = answer.perQuestion.find((entry) => entry.questionId === question.id);
    if (!value) return invalid("The answer does not match the original questions");
    const ids = value.optionIds ?? [];
    if (
      (!question.multiSelect && ids.length > 1) ||
      ids.some((id) => !question.options?.some((option) => option.id === id)) ||
      (value.text !== undefined && !question.allowFreeText)
    )
      return invalid("The answer is not allowed by the original question");
  }
  return Effect.void;
};

export const requireCardMessage = (tx: StoreTransaction, cardId: string) =>
  Effect.gen(function* () {
    const matches = yield* tx.messagesByCardId(cardId);
    const source = matches[0];
    if (
      matches.length !== 1 ||
      !source?.card ||
      (source.kind !== "question-card" && source.kind !== "clarify-card")
    )
      return yield* invalid(
        "The action does not identify a unique stored question or clarification card",
      );
    return { ...source, card: source.card };
  });

export const questionCardState = (request: StoredRequest) => {
  if (request.state === "answered" || request.answerClaim?.phase === "queued") return "answered";
  return request.state === "open" ? "open" : "expired";
};

export const markQuestionCards = (
  tx: StoreTransaction,
  requestId: RequestId,
  state: "answered" | "expired",
) =>
  Effect.gen(function* () {
    for (const message of yield* tx.cardsForRequest(requestId)) {
      if (message.card && message.card.state !== "answered" && message.card.state !== state)
        yield* tx.set("main_thread_messages", { ...message, card: { ...message.card, state } });
    }
  });

export const expireTaskRequests = (
  tx: StoreTransaction,
  taskId: TaskId,
  at: number,
  reason: "expired" | "cancelled" | "daemon.restart",
) =>
  Effect.gen(function* () {
    for (const request of yield* tx.openRequests(taskId)) {
      yield* tx.set("session_requests", {
        ...request,
        state: reason === "cancelled" ? "cancelled" : "expired",
        closedAt: at,
      });
    }
    for (const message of yield* tx.openTaskCards(taskId)) {
      if (message.card && (message.card.requestId || reason === "daemon.restart"))
        yield* tx.set("main_thread_messages", {
          ...message,
          card: { ...message.card, state: "expired" },
        });
    }
  });

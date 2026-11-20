import {
  type MessageId,
  type Op,
  type QuestionAnswer,
  RoutingCandidateId,
  type Task,
  type TaskId,
} from "@aut/protocol";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { ConfigStore } from "../config-store.js";
import { resolveDispatchChange } from "../dispatch-correction.js";
import { CoreError, validate } from "../errors.js";
import { requireCardMessage, validateQuestionAnswer } from "../request-cards.js";
import type { StoreRecords, StoreTable } from "../storage-model.js";
import { Store, type StoreTransaction } from "../store.js";
import { ChiefInput, InboundState, StateSource, type TaskCandidate } from "./ports.js";

const all = { limit: Number.MAX_SAFE_INTEGER };
const active = new Set<Task["status"]>([
  "created",
  "running",
  "waiting_user",
  "reporting",
  "failed",
  "interrupted",
]);
const excerpt = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");
const invalid = (message: string) =>
  Effect.fail(new CoreError({ code: "InvalidRequest", message }));
const required = <K extends StoreTable>(tx: StoreTransaction, table: K, id: string) =>
  tx.get(table, id).pipe(
    Effect.flatMap(
      (value): Effect.Effect<StoreRecords[K], CoreError> =>
        Option.isSome(value)
          ? Effect.succeed(value.value)
          : Effect.fail(
              new CoreError({
                code: "NotFound",
                message: `Unknown ${table} record: ${id}`,
              }),
            ),
    ),
  );

const opMessages = (op: Op): readonly MessageId[] => {
  switch (op.op) {
    case "new":
      return op.requestMessageIds;
    case "send":
    case "escalate":
      return op.messageIds;
    case "ask":
      return [op.messageId];
    default:
      return [];
  }
};

export const StateSourceLive = Layer.effect(
  StateSource,
  Effect.gen(function* () {
    const store = yield* Store;
    const config = yield* ConfigStore;
    return {
      prepare: (input: ChiefInput) =>
        Effect.gen(function* () {
          const checked = yield* validate(ChiefInput, input);
          if (checked.event.source !== "user")
            return yield* invalid("Only user events enter the inbound tree");
          const event = checked.event;
          const bots = yield* config.readBots;
          const primary = bots.find((bot) => bot.system === "primary");
          if (!primary)
            return yield* Effect.fail(
              new CoreError({
                code: "Configuration",
                message: "The primary assistant is not configured",
              }),
            );
          const now = yield* Clock.currentTimeMillis;
          return yield* store.transaction((tx) =>
            Effect.gen(function* () {
              const tasks = [...(yield* tx.list("tasks", all))].sort(
                (left, right) =>
                  right.createdAt - left.createdAt || left.id.localeCompare(right.id),
              );
              const requests = yield* tx.openRequests();
              if (
                [...bots, ...tasks, ...requests].some(
                  (entry) => !Schema.is(RoutingCandidateId)(entry.id),
                )
              )
                return yield* invalid("A configured ID conflicts with a reserved routing key");
              let message = "";
              let messageId: MessageId | null = null;
              let messageIds: readonly MessageId[] = [];
              let fixedTargetId: TaskId | null = null;
              let selectedOp: Op | null = null;
              const uiAction = event.kind === "ui-action" ? event.action : null;
              if (event.kind === "message") {
                const source = yield* required(tx, "main_thread_messages", event.messageId);
                if (source.author !== "user" || source.kind !== "text")
                  return yield* invalid("The inbound message must be original user text");
                message = source.text;
                messageId = source.id;
                messageIds = [source.id];
              } else if (event.action.type === "quote-reply") {
                const quoted = yield* required(
                  tx,
                  "main_thread_messages",
                  event.action.quotedMessageId,
                );
                const source = yield* required(
                  tx,
                  "main_thread_messages",
                  `quote:${checked.eventRef}`,
                );
                if (
                  source.author !== "user" ||
                  source.kind !== "text" ||
                  source.text !== event.action.text
                )
                  return yield* invalid(
                    "The quoted reply does not match its admitted user message",
                  );
                if (quoted.taskId) {
                  yield* required(tx, "tasks", quoted.taskId);
                  fixedTargetId = quoted.taskId;
                }
                message = source.text;
                messageId = source.id;
                messageIds = [source.id];
              } else if (event.action.type === "correct-dispatch") {
                selectedOp = yield* resolveDispatchChange(
                  tx,
                  event.action.decisionLogId,
                  event.action.change,
                  bots,
                );
                messageIds = opMessages(selectedOp);
                messageId = messageIds[0] ?? null;
              } else if (event.action.type === "task-control") {
                yield* required(tx, "tasks", event.action.taskId);
              } else {
                const action = event.action;
                const source = yield* requireCardMessage(tx, action.cardId);
                const card = source.card;
                if (card.state === "answered")
                  return yield* invalid("The card has already been answered");
                const checkAnswer = (
                  requestId: string,
                  answer: QuestionAnswer,
                  requireBinding = true,
                ) =>
                  Effect.gen(function* () {
                    if (
                      (requireBinding || card.requestId !== undefined) &&
                      card.requestId !== requestId
                    )
                      return yield* invalid("The card belongs to another request");
                    const stored = yield* required(tx, "session_requests", requestId);
                    if (stored.state === "answered")
                      return yield* invalid("The request has already been answered");
                    yield* required(tx, "tasks", stored.taskId);
                    yield* validateQuestionAnswer(stored.request, answer);
                  });
                if (action.type === "question-answer") {
                  yield* checkAnswer(action.requestId, action.answer);
                } else {
                  const option = card.options.find((value) => value.id === action.optionId);
                  if (!option)
                    return yield* invalid("The selected option does not exist on the stored card");
                  if (option.op) {
                    selectedOp = option.op;
                    if (selectedOp.op === "answer")
                      yield* checkAnswer(selectedOp.requestId, selectedOp.answer, false);
                    else if (card.state !== "open")
                      return yield* invalid("The clarification card has expired");
                  } else if (card.requestId) {
                    const stored = yield* required(tx, "session_requests", card.requestId);
                    const question = stored.request.questions[0];
                    if (
                      stored.request.kind !== "question" ||
                      stored.request.questions.length !== 1 ||
                      !question ||
                      !question.options?.some((value) => value.id === option.id)
                    )
                      return yield* invalid(
                        "Use the complete question form to answer this request",
                      );
                    const answer = {
                      perQuestion: [{ questionId: question.id, optionIds: [option.id] }],
                    };
                    yield* checkAnswer(card.requestId, answer);
                    selectedOp = { op: "answer", requestId: card.requestId, answer };
                  } else
                    return yield* invalid("The clarification option has no executable operation");
                  if (selectedOp) {
                    messageIds = opMessages(selectedOp);
                    messageId = messageIds[0] ?? null;
                    const originals = yield* Effect.forEach(messageIds, (id) =>
                      required(tx, "main_thread_messages", id),
                    );
                    message = originals.map((entry) => entry.text).join("\n");
                  }
                  if (
                    option.id === "none" &&
                    selectedOp?.op === "escalate" &&
                    source.decisionLogId
                  ) {
                    const previous = yield* required(tx, "decision_logs", source.decisionLogId);
                    yield* tx.set("decision_logs", {
                      ...previous,
                      correction: { at: now, kind: "clarify-none" },
                    });
                  }
                }
              }
              const recent = yield* tx.list("main_thread_messages", {
                ...(messageId ? { before: messageId } : {}),
                limit: 6,
              });
              const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
              const pendingByTask = new Map(
                tasks.map((task) => [task.id, new Set(task.pendingRequestIds)]),
              );
              const taskCandidates: TaskCandidate[] = [];
              const olderTasks: TaskCandidate[] = [];
              for (const [index, task] of tasks.entries()) {
                const title = task.title.trim() || `Task ${task.id}`;
                const included = index < 10 || active.has(task.status) || task.id === fixedTargetId;
                const group = included ? taskCandidates : olderTasks;
                group.push({
                  id: task.id,
                  title,
                  status: task.status,
                  description: `Task ${index + 1} by creation recency. Title: ${JSON.stringify(title)}. Bot: ${JSON.stringify(botNames.get(task.botId) ?? task.botId)} (${task.botId}). Status: ${task.status}. Created ${Math.max(0, Math.floor((now - task.createdAt) / 1000))} seconds ago; last active ${Math.max(0, Math.floor((now - task.lastActivityAt) / 1000))} seconds ago. Latest report excerpt: ${JSON.stringify(excerpt(task.lastReport?.delivered ?? "", 160))}.`,
                });
              }
              return yield* validate(InboundState, {
                message,
                messageId,
                messageIds,
                uiAction,
                selectedOp,
                fixedTargetId,
                primaryBotId: primary.id,
                bots: bots.map(({ id, name, description }) => ({ id, name, description })),
                taskCandidates,
                olderTasks,
                pendingRequests: requests
                  .filter(
                    (request) =>
                      request.request.kind === "question" &&
                      pendingByTask.get(request.taskId)?.has(request.id),
                  )
                  .map((request) => request.request),
                recentMessages: recent.map((entry) => ({
                  id: entry.id,
                  text: excerpt(entry.text, 200),
                  taskId: entry.taskId ?? null,
                })),
              });
            }),
          );
        }),
    };
  }),
);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotConfig,
  BotId,
  DecisionLog as LogRecord,
  MainThreadMessage,
  MessageId,
  RequestId,
  SessionRequest,
  Task,
  TaskId,
  type UiAction,
} from "@aut/protocol";
import { Effect, Either, Layer, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ConfigStore } from "../config-store.js";
import { CoreLive } from "../index.js";
import { Store } from "../store.js";
import { insertTaskWithSession } from "../task-registry.js";
import { StateSource } from "./ports.js";
import { StateSourceLive } from "./state-source.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "aut",
  name: "aut",
  description: "General assistant",
  system: "primary",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
});
const message = (id: string, text = id) =>
  Schema.decodeUnknownSync(MainThreadMessage)({ id, at: 1, author: "user", kind: "text", text });
const task = (id: string, createdAt = 1, status = "idle") =>
  Schema.decodeUnknownSync(Task)({
    id,
    botId: bot.id,
    title: `Title ${id}`,
    status,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  });
const question = Schema.decodeUnknownSync(SessionRequest)({
  id: "request",
  taskId: "task",
  kind: "question",
  openedAt: 1,
  raw: null,
  questions: [
    {
      id: "color",
      text: "Choose color",
      multiSelect: false,
      allowFreeText: false,
      options: [
        { id: "red", label: "红色" },
        { id: "blue", label: "蓝色" },
      ],
    },
    { id: "name", text: "Name?", multiSelect: false, allowFreeText: true },
  ],
});
const card = Schema.decodeUnknownSync(MainThreadMessage)({
  id: "card-message",
  at: 2,
  author: "chief",
  kind: "question-card",
  text: "请回答",
  card: {
    id: "card",
    prompt: "请回答",
    requestId: "request",
    options: [],
    state: "open",
    multiSelect: false,
    allowFreeText: true,
  },
});
const validAnswer = {
  perQuestion: [
    { questionId: "color", optionIds: ["red"] },
    { questionId: "name", text: "名称" },
  ],
} as const;
const input = (action: UiAction) => ({
  event: { source: "user" as const, kind: "ui-action" as const, action },
  eventRef: "event",
  decisionLogId: "decision",
});
const messageInput = (id: string) => ({
  event: { source: "user" as const, kind: "message" as const, messageId: MessageId.make(id) },
  eventRef: "event",
  decisionLogId: "decision",
});
const run = <A, E>(body: Effect.Effect<A, E, StateSource | Store | ConfigStore>) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-state-"));
  directories.push(dataDirectory);
  const core = CoreLive({ dataDirectory });
  return Effect.runPromise(
    Effect.scoped(body.pipe(Effect.provide(StateSourceLive.pipe(Layer.provideMerge(core))))),
  );
};
const seed = Effect.gen(function* () {
  yield* (yield* ConfigStore).writeBots([bot]);
  const store = yield* Store;
  yield* store.transaction((tx) =>
    Effect.gen(function* () {
      yield* insertTaskWithSession(tx, {
        ...task("task", 1, "waiting_user"),
        pendingRequestIds: [question.id],
      });
      yield* tx.insert("session_requests", {
        id: question.id,
        taskId: question.taskId,
        request: question,
        state: "open",
      });
      yield* tx.insert("main_thread_messages", card);
    }),
  );
});

it("keeps the selected specialist and original message bound to a clarification option", async () => {
  await run(
    Effect.gen(function* () {
      const { system: _, ...ordinary } = bot;
      const specialist = { ...ordinary, id: BotId.make("notes") };
      yield* (yield* ConfigStore).writeBots([bot, specialist]);
      const request = message("source", "Original work");
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("main_thread_messages", request);
          yield* tx.insert("main_thread_messages", {
            ...card,
            kind: "clarify-card",
            card: {
              id: "selection",
              prompt: "Choose",
              state: "open",
              multiSelect: false,
              allowFreeText: false,
              options: [
                {
                  id: "new",
                  label: "交给笔记助手",
                  op: { op: "new", botId: specialist.id, requestMessageIds: [request.id] },
                },
              ],
            },
          });
        }),
      );
      const state = yield* (yield* StateSource).prepare(
        input({ type: "card-choice", cardId: "selection", optionId: "new" }),
      );
      expect(state.bots.map((bot) => bot.id)).toEqual([bot.id, specialist.id]);
      expect(state.primaryBotId).toBe(bot.id);
      expect(state.selectedOp).toEqual({
        op: "new",
        botId: specialist.id,
        requestMessageIds: [request.id],
      });
    }),
  );
});

it("bounds context before the admitted message and includes active tasks outside the latest ten", async () => {
  const state = await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots([bot]);
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          for (let i = 0; i < 14; i++)
            yield* insertTaskWithSession(tx, task(`t${i}`, i, i === 0 ? "failed" : "idle"));
          for (let i = 0; i < 9; i++)
            yield* tx.insert("main_thread_messages", message(`m${i}`, `text${i}`));
        }),
      );
      return yield* (yield* StateSource).prepare(messageInput("m7"));
    }),
  );
  expect(state.message).toBe("text7");
  expect(state.recentMessages.map((entry) => entry.id)).toEqual([
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
    "m6",
  ]);
  expect(state.taskCandidates.map((entry) => entry.id)).toEqual([
    "t13",
    "t12",
    "t11",
    "t10",
    "t9",
    "t8",
    "t7",
    "t6",
    "t5",
    "t4",
    "t0",
  ]);
  expect(state.olderTasks.map((entry) => entry.id)).toEqual(["t3", "t2", "t1"]);
  expect(state.taskCandidates[0]?.description).toContain("Task 1 by creation recency");
});

it("binds an old quoted task and uses only the atomically admitted reply", async () => {
  const state = await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots([bot]);
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          for (let i = 0; i < 12; i++)
            yield* insertTaskWithSession(tx, {
              ...task(`t${i}`, i),
              title: i === 0 ? "" : `Task ${i}`,
            });
          yield* tx.insert("main_thread_messages", {
            ...message("original"),
            author: "chief",
            kind: "reply",
            taskId: TaskId.make("t0"),
          });
          yield* tx.insert("main_thread_messages", message("quote:event", "接着做"));
          yield* tx.insert("main_thread_messages", message("future"));
        }),
      );
      return yield* (yield* StateSource).prepare(
        input({ type: "quote-reply", quotedMessageId: MessageId.make("original"), text: "接着做" }),
      );
    }),
  );
  expect(state.fixedTargetId).toBe("t0");
  expect(state.taskCandidates.find((entry) => entry.id === "t0")?.title).toBe("Task t0");
  expect(state.messageIds).toEqual(["quote:event"]);
  expect(state.recentMessages.map((entry) => entry.id)).toEqual(["original"]);
});

it("reads pending questions only from open requests registered on their task", async () => {
  const state = await run(
    Effect.gen(function* () {
      yield* seed;
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("main_thread_messages", message("m"));
          for (const id of ["orphan", "closed"])
            yield* tx.insert("session_requests", {
              id: RequestId.make(id),
              taskId: question.taskId,
              request: { ...question, id: RequestId.make(id) },
              state: id === "closed" ? "expired" : "open",
            });
        }),
      );
      return yield* (yield* StateSource).prepare(messageInput("m"));
    }),
  );
  expect(state.pendingRequests.map((entry) => entry.id)).toEqual(["request"]);
});

it("routes an admitted quote of a main-thread message without a fixed task", async () => {
  const state = await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots([bot]);
      yield* (yield* Store).transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("main_thread_messages", message("original"));
          yield* tx.insert("main_thread_messages", message("quote:event", "接着做"));
        }),
      );
      return yield* (yield* StateSource).prepare(
        input({ type: "quote-reply", quotedMessageId: MessageId.make("original"), text: "接着做" }),
      );
    }),
  );
  expect(state.fixedTargetId).toBeNull();
  expect(state.message).toBe("接着做");
  expect(state.messageIds).toEqual(["quote:event"]);
});

it.each(["open", "expired", "cancelled"] as const)(
  "allows a complete %s question answer for executor delivery handling",
  async (status) => {
    const state = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.set("session_requests", {
              id: question.id,
              taskId: question.taskId,
              request: question,
              state: status,
            });
            if (!card.card) return yield* Effect.dieMessage("Missing fixture card");
            yield* tx.set("main_thread_messages", {
              ...card,
              card: { ...card.card, state: status === "open" ? "open" : "expired" },
            });
          }),
        );
        return yield* (yield* StateSource).prepare(
          input({
            type: "question-answer",
            cardId: "card",
            requestId: question.id,
            answer: validAnswer,
          }),
        );
      }),
    );
    expect(state.uiAction?.type).toBe("question-answer");
  },
);

it.each([
  { perQuestion: [validAnswer.perQuestion[0]] },
  { perQuestion: [{ questionId: "color", text: "red" }, validAnswer.perQuestion[1]] },
  { perQuestion: [{ questionId: "color", optionIds: ["green"] }, validAnswer.perQuestion[1]] },
  {
    perQuestion: [{ questionId: "color", optionIds: ["red", "blue"] }, validAnswer.perQuestion[1]],
  },
  { perQuestion: [{ questionId: "injected", optionIds: ["red"] }, validAnswer.perQuestion[1]] },
])("rejects incomplete or request-incompatible answers %#", async (answer) => {
  const result = await run(
    Effect.gen(function* () {
      yield* seed;
      return yield* Effect.either(
        (yield* StateSource).prepare(
          input({ type: "question-answer", cardId: "card", requestId: question.id, answer }),
        ),
      );
    }),
  );
  expect(Either.isLeft(result) && result.left.code).toBe("InvalidRequest");
});

it("rejects replay of answered requests and request identity substitution", async () => {
  const results = await run(
    Effect.gen(function* () {
      yield* seed;
      const source = yield* StateSource;
      const substituted = yield* Effect.either(
        source.prepare(
          input({
            type: "question-answer",
            cardId: "card",
            requestId: RequestId.make("other"),
            answer: validAnswer,
          }),
        ),
      );
      yield* (yield* Store).transaction((tx) =>
        tx.set("session_requests", {
          id: question.id,
          taskId: question.taskId,
          request: question,
          state: "answered",
        }),
      );
      return [
        substituted,
        yield* Effect.either(
          source.prepare(
            input({
              type: "question-answer",
              cardId: "card",
              requestId: question.id,
              answer: validAnswer,
            }),
          ),
        ),
      ];
    }),
  );
  expect(results.every(Either.isLeft)).toBe(true);
});

it("accepts an answer bound by a trusted clarification option without a parent request binding", async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* seed;
      const op = { op: "answer" as const, requestId: question.id, answer: validAnswer };
      yield* (yield* Store).transaction((tx) =>
        tx.set("main_thread_messages", {
          ...card,
          kind: "clarify-card",
          card: {
            id: "choose-request",
            prompt: "回答哪个问题",
            state: "open",
            multiSelect: false,
            allowFreeText: false,
            options: [{ id: "request", label: "原问题", op }],
          },
        }),
      );
      const source = yield* StateSource;
      const selected = yield* source.prepare(
        input({ type: "card-choice", cardId: "choose-request", optionId: "request" }),
      );
      const substituted = yield* Effect.either(
        source.prepare(
          input({
            type: "question-answer",
            cardId: "choose-request",
            requestId: question.id,
            answer: validAnswer,
          }),
        ),
      );
      return { selected, substituted };
    }),
  );
  expect(result.selected.selectedOp).toEqual({
    op: "answer",
    requestId: question.id,
    answer: validAnswer,
  });
  expect(Either.isLeft(result.substituted)).toBe(true);
});

it("binds stored clarification operations and records none against the original decision", async () => {
  const results = await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots([bot]);
      const op = {
        op: "escalate" as const,
        reason: "No matching option",
        decisionLogId: "original-log",
        messageIds: [MessageId.make("original")],
      };
      const store = yield* Store;
      yield* store.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("main_thread_messages", message("original", "原始请求"));
          yield* tx.insert(
            "decision_logs",
            Schema.decodeUnknownSync(LogRecord)({
              id: "original-log",
              at: 1,
              tree: "inbound",
              treeVersion: "1",
              input: { eventRef: "original", state: {}, dynamicOptions: {} },
              classifierCalls: [],
              path: [],
              execution: { ok: false },
            }),
          );
          yield* tx.insert("main_thread_messages", {
            ...card,
            kind: "clarify-card",
            decisionLogId: "original-log",
            card: {
              id: "clarify",
              prompt: "选择",
              options: [{ id: "none", label: "都不是", op }],
              state: "open",
              multiSelect: false,
              allowFreeText: false,
            },
          });
        }),
      );
      const source = yield* StateSource;
      const selected = yield* source.prepare(
        input({ type: "card-choice", cardId: "clarify", optionId: "none" }),
      );
      const unknown = yield* Effect.either(
        source.prepare(input({ type: "card-choice", cardId: "clarify", optionId: "injected" })),
      );
      const log = yield* store.transaction((tx) => tx.get("decision_logs", "original-log"));
      return { selected, unknown, log };
    }),
  );
  expect(results.selected.selectedOp?.op).toBe("escalate");
  expect(results.selected.message).toBe("原始请求");
  expect(results.selected.messageIds).toEqual(["original"]);
  expect(Either.isLeft(results.unknown)).toBe(true);
  expect(results.log._tag === "Some" && results.log.value.correction?.kind).toBe("clarify-none");
});

it("refuses synthetic quote text, missing primary assistant, reserved IDs and non-user messages", async () => {
  const results = await run(
    Effect.gen(function* () {
      const source = yield* StateSource;
      const missingConfig = yield* Effect.either(source.prepare(messageInput("m")));
      yield* (yield* ConfigStore).writeBots([bot]);
      const store = yield* Store;
      yield* store.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("main_thread_messages", { ...message("m"), author: "chief" });
          yield* tx.insert("main_thread_messages", {
            ...message("quoted"),
            taskId: TaskId.make("task"),
          });
        }),
      );
      const nonUser = yield* Effect.either(source.prepare(messageInput("m")));
      const missingQuote = yield* Effect.either(
        source.prepare(
          input({
            type: "quote-reply",
            quotedMessageId: MessageId.make("quoted"),
            text: "unadmitted",
          }),
        ),
      );
      yield* store.transaction((tx) => insertTaskWithSession(tx, task("none")));
      const reservedId = yield* Effect.either(source.prepare(messageInput("m")));
      return [missingConfig, nonUser, missingQuote, reservedId];
    }),
  );
  expect(results.every(Either.isLeft)).toBe(true);
});

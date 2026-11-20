import {
  AutEvent,
  BotId,
  DecisionLog,
  MainThreadMessage,
  MessageId,
  NonEmptyString,
  optional,
  QuestionAnswer,
  RequestId,
  ResumeCursor,
  SessionRequest,
  Task,
  TaskId,
  Timestamp,
} from "@aut/protocol";
import { Schema } from "effect";
import { SessionExecution } from "./session-manager/model.js";

export const StoredSession = Schema.Struct({
  id: TaskId,
  instanceId: NonEmptyString,
  cursor: optional(ResumeCursor),
  execution: SessionExecution,
});
export type StoredSession = typeof StoredSession.Type;
export const AnswerClaim = Schema.Struct({
  claimId: NonEmptyString,
  answer: QuestionAnswer,
  decisionLogId: NonEmptyString,
  phase: Schema.Literal("registered", "submitting", "delivered", "indeterminate", "queued"),
  updatedAt: Timestamp,
});
export type AnswerClaim = typeof AnswerClaim.Type;
export const StoredRequest = Schema.Struct({
  id: RequestId,
  taskId: TaskId,
  request: SessionRequest,
  state: Schema.Literal("open", "answered", "expired", "cancelled"),
  closedAt: optional(Timestamp),
  answerClaim: optional(AnswerClaim),
}).pipe(
  Schema.filter((value) => value.id === value.request.id && value.taskId === value.request.taskId),
);
export type StoredRequest = typeof StoredRequest.Type;
export const StoredEvent = Schema.Struct({ id: NonEmptyString, at: Timestamp, event: AutEvent });
export type StoredEvent = typeof StoredEvent.Type;

export const StoredBotCreation = Schema.Struct({
  id: BotId,
  messageId: MessageId,
  taskId: TaskId,
  name: NonEmptyString,
  at: Timestamp,
  configDigest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  phase: Schema.Literal("creating", "active", "undoing"),
});
export type StoredBotCreation = typeof StoredBotCreation.Type;

export const storageSchemas = {
  main_thread_messages: MainThreadMessage,
  tasks: Task,
  sessions: StoredSession,
  session_requests: StoredRequest,
  events: StoredEvent,
  decision_logs: DecisionLog,
  bot_creations: StoredBotCreation,
} as const;
export type StoreTable = keyof typeof storageSchemas;
export type StoreRecords = {
  readonly [K in StoreTable]: Schema.Schema.Type<(typeof storageSchemas)[K]>;
};
export type StoreEncodedRecords = {
  readonly [K in StoreTable]: Schema.Schema.Encoded<(typeof storageSchemas)[K]>;
};
export const storeTables = Object.keys(storageSchemas) as StoreTable[];

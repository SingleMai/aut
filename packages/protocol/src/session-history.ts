import { Schema } from "effect";
import { NonEmptyString, optional, Timestamp } from "./common.js";

export const SessionItemStatus = Schema.Literal(
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
);
export type SessionItemStatus = typeof SessionItemStatus.Type;
export const SessionTool = Schema.Struct({
  name: NonEmptyString,
  input: Schema.String,
  output: Schema.String,
  exitCode: optional(Schema.Int),
});
export const SessionItem = Schema.Struct({
  id: NonEmptyString,
  kind: Schema.Literal("user", "assistant", "tool", "note"),
  status: SessionItemStatus,
  text: Schema.String,
  startedAt: optional(Timestamp),
  completedAt: optional(Timestamp),
  phase: optional(Schema.Literal("commentary", "final")),
  tool: optional(SessionTool),
});
export type SessionItem = typeof SessionItem.Type;
export const SessionTurn = Schema.Struct({
  id: NonEmptyString,
  status: SessionItemStatus,
  startedAt: optional(Timestamp),
  completedAt: optional(Timestamp),
  error: optional(Schema.String),
  items: Schema.Array(SessionItem).pipe(
    Schema.filter((items) => new Set(items.map((item) => item.id)).size === items.length),
  ),
});
export type SessionTurn = typeof SessionTurn.Type;
export const SessionHistory = Schema.Struct({
  turns: Schema.Array(SessionTurn).pipe(
    Schema.filter((turns) => new Set(turns.map((turn) => turn.id)).size === turns.length),
  ),
});
export type SessionHistory = typeof SessionHistory.Type;

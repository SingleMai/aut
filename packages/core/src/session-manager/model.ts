import {
  MessageId,
  NonEmptyString,
  NonNegativeInteger,
  optional,
  Timestamp,
  TurnInput,
} from "@aut/protocol";
import { Schema } from "effect";

export const Delivery = Schema.Struct({
  id: NonEmptyString,
  messageIds: Schema.Array(MessageId),
  queuedAt: Timestamp,
  decisionLogId: NonEmptyString,
  directive: Schema.Literal("queue", "steer", "restart"),
  ready: Schema.Boolean,
});
export type Delivery = typeof Delivery.Type;
export const Attempt = Schema.Struct({
  generation: NonNegativeInteger,
  deliveries: Schema.Array(Delivery),
  mode: Schema.Literal("new", "send", "retry", "resume"),
  decisionLogIds: Schema.Array(NonEmptyString),
  phase: Schema.Literal(
    "preparing",
    "starting",
    "running",
    "reporting",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "indeterminate",
  ),
  input: optional(TurnInput),
  turnId: optional(NonEmptyString),
  restart: Schema.Boolean,
  reportEventId: optional(NonEmptyString),
  error: optional(Schema.String),
});
export type Attempt = typeof Attempt.Type;
export const SessionExecution = Schema.Struct({
  generation: NonNegativeInteger,
  pending: Schema.Array(Delivery),
  seenOperations: Schema.Array(NonEmptyString),
  uncertain: Schema.Array(Delivery),
  active: optional(Attempt),
  lastAttempt: optional(Attempt),
  steering: optional(Schema.Struct({ generation: NonNegativeInteger, delivery: Delivery })),
  nextStart: optional(
    Schema.Struct({
      kind: Schema.Literal("retry", "resume"),
      decisionLogId: NonEmptyString,
      ready: Schema.Boolean,
    }),
  ),
});
export type SessionExecution = typeof SessionExecution.Type;

export const emptyExecution = (): SessionExecution => ({
  generation: 0,
  pending: [],
  seenOperations: [],
  uncertain: [],
});

/** Adapted from OMB admission.ts@738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0).
 * Adjacent timestamps define the window. There is no timer and no input debounce. */
export const coalesce = (
  items: readonly Delivery[],
  windowMs: number,
  maxItems: number,
): readonly Delivery[] => {
  const group: Delivery[] = [];
  let previousAt: number | undefined;
  for (const item of items) {
    if (!item.ready) break;
    const gap = item.queuedAt - (previousAt ?? item.queuedAt);
    if (group.length > 0 && (gap < 0 || gap > windowMs || group.length >= maxItems)) break;
    group.push(item);
    previousAt = item.queuedAt;
    if (group.length >= maxItems) break;
  }
  return group;
};

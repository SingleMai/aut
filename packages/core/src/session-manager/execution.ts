// Delivery ownership adapted from OpenMausBot server/steer-queue.ts and runtime/runtime.ts
// at 738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0). See NOTICE.
import type { Task } from "@aut/protocol";
import { Effect, Option } from "effect";
import { CoreError } from "../errors.js";
import type { StoreTransaction } from "../store.js";
import type { SessionExecution } from "./model.js";

export const noActive = (execution: SessionExecution): SessionExecution => {
  const { active: _, ...rest } = execution;
  return rest;
};
export const noSteering = (execution: SessionExecution): SessionExecution => {
  const { steering: _, ...rest } = execution;
  return rest;
};
export const noNext = (execution: SessionExecution): SessionExecution => {
  const { nextStart: _, ...rest } = execution;
  return rest;
};

export const executionFor = (
  tx: StoreTransaction,
  task: Task,
): Effect.Effect<SessionExecution, CoreError> =>
  Effect.gen(function* () {
    const session = yield* tx.get("sessions", task.id);
    if (Option.isNone(session))
      return yield* Effect.fail(
        new CoreError({
          code: "Storage",
          message: `Missing execution record for task: ${task.id}`,
        }),
      );
    return session.value.execution;
  });

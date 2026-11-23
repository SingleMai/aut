// Trigger dispatch lifecycle adapted from OpenMausBot's due timer and
// routine recovery boundaries at 738ec88472a3b888ff7b7793755d89da613ed301.
// See NOTICE. No enterprise-directory code is included.

import { Chief, TriggerRegistry } from "@aut/core";
import { TaskId, type Trigger, type TriggerRun } from "@aut/protocol";
import { Cause, Context, Effect, Layer, Schedule } from "effect";

export class TriggerScheduler extends Context.Tag("aut/TriggerScheduler")<
  TriggerScheduler,
  { readonly tick: (now?: number) => Effect.Effect<void> }
>() {}

export const TriggerSchedulerLive = Layer.scoped(
  TriggerScheduler,
  Effect.gen(function* () {
    const registry = yield* TriggerRegistry;
    const chief = yield* Chief;
    const dispatch = (run: TriggerRun, trigger: Trigger) =>
      Effect.gen(function* () {
        const started = yield* registry.start(run.id, {
          triggerId: trigger.id,
          botId: trigger.botId,
          prompt: trigger.prompt,
          payload: trigger.payload,
        });
        if (!started) return;
        const receipt = yield* chief.submit(
          {
            source: "trigger",
            kind: "fired",
            triggerId: trigger.id,
            runId: run.id,
            occurrenceKey: run.occurrenceKey,
            scheduledAt: run.scheduledAt,
            botId: trigger.botId,
            prompt: trigger.prompt,
            payload: trigger.payload,
          },
          `trigger:${run.id}`,
        );
        const result = yield* receipt.awaitResult;
        if (result.execution.ok) yield* registry.accepted(run.id, TaskId.make(`trigger:${run.id}`));
        else yield* registry.failed(run.id, result.execution.error ?? "Trigger dispatch failed");
      }).pipe(
        Effect.catchAllCause((cause) =>
          registry.failed(run.id, Cause.pretty(cause)).pipe(Effect.catchAll(() => Effect.void)),
        ),
      );
    const tick = (now?: number) =>
      Effect.gen(function* () {
        const dispatches = yield* registry.advance(now);
        yield* Effect.forEach(dispatches, ({ run, trigger }) => dispatch(run, trigger), {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.catchAllCause(() => Effect.void));
    yield* Effect.repeat(tick(), { schedule: Schedule.spaced("1 second") }).pipe(Effect.forkScoped);
    return { tick: (now?: number) => tick(now) };
  }),
);

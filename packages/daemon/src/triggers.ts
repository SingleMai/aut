// Trigger dispatch lifecycle adapted from OpenMausBot's due timer and
// routine recovery boundaries at 738ec88472a3b888ff7b7793755d89da613ed301.
// See NOTICE. No enterprise-directory code is included.

import { Chief, isMemoryDreamTrigger, type TriggerDispatch, TriggerRegistry } from "@aut/core";
import { TaskId, type Trigger, type TriggerRun } from "@aut/protocol";
import { Cause, Context, Effect, Layer, Schedule } from "effect";
import { MemoryDreams } from "./memory-dreams.js";

export class TriggerScheduler extends Context.Tag("aut/TriggerScheduler")<
  TriggerScheduler,
  { readonly tick: (now?: number) => Effect.Effect<void> }
>() {}

export const TriggerSchedulerLive = Layer.scoped(
  TriggerScheduler,
  Effect.gen(function* () {
    const registry = yield* TriggerRegistry;
    const chief = yield* Chief;
    const dreams = yield* MemoryDreams;
    const mutex = yield* Effect.makeSemaphore(1);
    const dispatch = (run: TriggerRun, trigger: Trigger) =>
      Effect.gen(function* () {
        if (!(yield* dreams.ready(trigger))) return;
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
      mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* dreams.ensure.pipe(
            Effect.catchAll(() =>
              Effect.logWarning("Unable to initialize memory consolidation schedules"),
            ),
          );
          const dispatches = yield* registry.advance(now);
          const byBot = new Map<string, TriggerDispatch[]>();
          for (const candidate of dispatches) {
            const candidates = byBot.get(candidate.trigger.botId) ?? [];
            candidates.push(candidate);
            byBot.set(candidate.trigger.botId, candidates);
          }
          yield* Effect.forEach(
            byBot.values(),
            (candidates) =>
              Effect.forEach(
                candidates.toSorted(
                  (a, b) =>
                    Number(isMemoryDreamTrigger(a.trigger)) -
                    Number(isMemoryDreamTrigger(b.trigger)),
                ),
                // Await ordinary task registration before checking this bot's dream readiness.
                ({ run, trigger }) => dispatch(run, trigger),
                { concurrency: 1, discard: true },
              ),
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(Effect.catchAllCause(() => Effect.void)),
      );
    yield* Effect.repeat(tick(), { schedule: Schedule.spaced("1 second") }).pipe(Effect.forkScoped);
    return { tick: (now?: number) => tick(now) };
  }),
);

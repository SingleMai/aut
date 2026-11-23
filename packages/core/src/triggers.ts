// Trigger scheduling and run-ledger boundaries adapted from OpenMausBot
// (Apache-2.0), server/routines.ts, routine-schedules.ts, due-timer.ts,
// routine-catch-up.ts, routine-ledger.ts and routine-recovery.ts at
// 738ec88472a3b888ff7b7793755d89da613ed301. See NOTICE.

import { randomUUID } from "node:crypto";
import {
  type BotId,
  CreateTriggerInput,
  type JsonValue,
  type TaskId,
  Trigger,
  TriggerId,
  type TriggerRun,
  TriggerRunId,
  type TriggerSchedule,
  UpdateTriggerInput,
} from "@aut/protocol";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { ConfigStore } from "./config-store.js";
import { CoreError, validate } from "./errors.js";
import { Store } from "./store.js";

export const CATCH_UP_MS = 12 * 60 * 60 * 1_000;
const minuteMs = 60 * 1_000;
const maxScheduleSearchMs = 366 * 24 * 60 * minuteMs;
const maxEnumeratedOccurrences = 2_000;

export interface TriggerDispatch {
  readonly trigger: Trigger;
  readonly run: TriggerRun;
}

export class TriggerRegistry extends Context.Tag("aut/TriggerRegistry")<
  TriggerRegistry,
  {
    readonly create: (input: CreateTriggerInput) => Effect.Effect<Trigger, CoreError>;
    readonly get: (id: TriggerId) => Effect.Effect<Option.Option<Trigger>, CoreError>;
    readonly list: () => Effect.Effect<readonly Trigger[], CoreError>;
    readonly update: (
      id: TriggerId,
      input: UpdateTriggerInput,
    ) => Effect.Effect<Trigger, CoreError>;
    readonly listRuns: (id: TriggerId) => Effect.Effect<readonly TriggerRun[], CoreError>;
    readonly advance: (now?: number) => Effect.Effect<readonly TriggerDispatch[], CoreError>;
    readonly start: (
      runId: TriggerRunId,
      event: {
        readonly triggerId: TriggerId;
        readonly botId: BotId;
        readonly prompt: string;
        readonly payload: JsonValue;
      },
    ) => Effect.Effect<boolean, CoreError>;
    readonly accepted: (runId: TriggerRunId, taskId: TaskId) => Effect.Effect<void, CoreError>;
    readonly failed: (runId: TriggerRunId, error: string) => Effect.Effect<void, CoreError>;
  }
>() {}

interface ClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const partNumber = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => {
  const value = parts.find((part) => part.type === type)?.value;
  return value === undefined ? undefined : Number(value);
};

const partsAt = (at: number, timeZone = "UTC"): ClockParts => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(new Date(at));
  const weekdayText = parts.find((part) => part.type === "weekday")?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayText ?? "");
  const values = {
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
    hour: partNumber(parts, "hour"),
    minute: partNumber(parts, "minute"),
  };
  if (Object.values(values).some((value) => value === undefined) || weekday < 0)
    throw new Error("Unable to read the configured schedule timezone");
  return { ...values, weekday } as ClockParts;
};

interface CronField {
  readonly min: number;
  readonly max: number;
  readonly values: ReadonlySet<number>;
}

const parseCronField = (text: string, min: number, max: number): CronField => {
  const values = new Set<number>();
  for (const piece of text.split(",")) {
    const [rangeText = "", stepText] = piece.split("/", 2);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step <= 0) throw new Error("Invalid cron step");
    const range = rangeText === "*" ? [min, max] : rangeText.split("-", 2).map(Number);
    if (
      range.length < 1 ||
      range.some((value) => !Number.isSafeInteger(value) || value < min || value > max)
    )
      throw new Error("Invalid cron range");
    const first = range[0] as number;
    const last = (range[1] ?? first) as number;
    if (last < first) throw new Error("Invalid cron range");
    for (let value = first; value <= last; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error("Cron field is empty");
  return { min, max, values };
};

const parseCron = (expression: string) => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must contain five fields");
  return [
    parseCronField(fields[0] as string, 0, 59),
    parseCronField(fields[1] as string, 0, 23),
    parseCronField(fields[2] as string, 1, 31),
    parseCronField(fields[3] as string, 1, 12),
    parseCronField(fields[4] as string, 0, 6),
  ] as const;
};

const cronMatches = (at: number, expression: string, timeZone?: string) => {
  const [minute, hour, day, month, weekday] = parseCron(expression);
  const parts = partsAt(at, timeZone);
  return (
    minute.values.has(parts.minute) &&
    hour.values.has(parts.hour) &&
    day.values.has(parts.day) &&
    month.values.has(parts.month) &&
    weekday.values.has(parts.weekday)
  );
};

const dailyMatches = (at: number, value: string, timeZone?: string) => {
  const [hour, minute] = value.split(":").map(Number);
  const parts = partsAt(at, timeZone);
  return parts.hour === hour && parts.minute === minute;
};

export const nextOccurrence = (schedule: TriggerSchedule, after: number): number | undefined => {
  switch (schedule.kind) {
    case "once":
      return schedule.at > after ? schedule.at : undefined;
    case "interval": {
      if (after < schedule.startAt) return schedule.startAt;
      const count = Math.floor((after - schedule.startAt) / schedule.everyMs) + 1;
      return schedule.startAt + count * schedule.everyMs;
    }
    case "daily":
    case "cron": {
      const matches =
        schedule.kind === "daily"
          ? (at: number) => dailyMatches(at, schedule.at, schedule.timeZone)
          : (at: number) => cronMatches(at, schedule.expression, schedule.timeZone);
      const start = Math.floor(after / minuteMs) * minuteMs + minuteMs;
      for (let at = start; at - after <= maxScheduleSearchMs; at += minuteMs)
        if (matches(at)) return at;
      return undefined;
    }
  }
};

const dueOccurrences = (trigger: Trigger, now: number): readonly number[] => {
  if (trigger.nextAt === undefined || trigger.nextAt > now) return [];
  const first = trigger.nextAt;
  const schedule = trigger.schedule;
  if (schedule.kind === "interval") {
    const count = Math.floor((now - first) / schedule.everyMs) + 1;
    const latest = first + (count - 1) * schedule.everyMs;
    return count > maxEnumeratedOccurrences
      ? [latest]
      : Array.from({ length: count }, (_, index) => first + index * schedule.everyMs);
  }
  const values: number[] = [];
  let cursor: number | undefined = first;
  while (cursor !== undefined && cursor <= now && values.length < maxEnumeratedOccurrences) {
    values.push(cursor);
    cursor = nextOccurrence(schedule, cursor);
  }
  return values;
};

const fail = (code: CoreError["code"], message: string) =>
  Effect.fail(new CoreError({ code, message }));

const validateScheduleRuntime = (schedule: TriggerSchedule) =>
  Effect.try({
    try: () => {
      if (schedule.kind === "cron") parseCron(schedule.expression);
      if (schedule.kind === "daily" || schedule.kind === "cron")
        partsAt(Date.now(), schedule.timeZone);
      return schedule;
    },
    catch: (cause) =>
      new CoreError({
        code: "Validation",
        message: "Invalid trigger schedule",
        detail: String(cause),
      }),
  });

const validateBot = (config: typeof ConfigStore.Service, botId: BotId) =>
  config.readBots.pipe(
    Effect.flatMap((bots) =>
      bots.some((bot) => bot.id === botId)
        ? Effect.void
        : fail("Configuration", `Unknown bot: ${botId}`),
    ),
  );

const activeRun = (run: TriggerRun) => run.status === "queued" || run.status === "running";
const terminalTask = (status: string) =>
  ["idle", "failed", "interrupted", "cancelled", "archived"].includes(status);

export const TriggerRegistryLive = Layer.effect(
  TriggerRegistry,
  Effect.gen(function* () {
    const store = yield* Store;
    const config = yield* ConfigStore;
    const create = (input: CreateTriggerInput) =>
      Effect.gen(function* () {
        const checked = yield* validate(CreateTriggerInput, input);
        yield* validateScheduleRuntime(checked.schedule);
        yield* validateBot(config, checked.botId);
        const now = yield* Clock.currentTimeMillis;
        const nextAt = nextOccurrence(checked.schedule, now - 1);
        const id = checked.id ?? TriggerId.make(randomUUID());
        const trigger = yield* validate(Trigger, {
          ...checked,
          id,
          overlap: "skip",
          createdAt: now,
          updatedAt: now,
          ...(nextAt === undefined ? {} : { nextAt }),
        });
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            if (Option.isSome(yield* tx.get("triggers", id)))
              return yield* fail("Conflict", `Trigger ID already exists: ${id}`);
            yield* tx.insert("triggers", trigger);
          }),
        );
        return trigger;
      });
    const get = (id: TriggerId) => store.transaction((tx) => tx.get("triggers", id));
    const list = () =>
      store.transaction((tx) =>
        tx
          .list("triggers", { limit: Number.MAX_SAFE_INTEGER })
          .pipe(Effect.map((values) => values.toSorted((a, b) => b.updatedAt - a.updatedAt))),
      );
    const update = (id: TriggerId, input: UpdateTriggerInput) =>
      Effect.gen(function* () {
        const checked = yield* validate(UpdateTriggerInput, input);
        const now = yield* Clock.currentTimeMillis;
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.get("triggers", id);
            if (Option.isNone(current)) return yield* fail("NotFound", `Unknown trigger: ${id}`);
            const schedule = checked.schedule ?? current.value.schedule;
            const botId = checked.botId ?? current.value.botId;
            const candidate = { ...current.value, ...checked, schedule, botId, updatedAt: now };
            yield* validateScheduleRuntime(schedule);
            yield* validateBot(config, botId);
            const scheduleChanged =
              checked.schedule !== undefined &&
              JSON.stringify(checked.schedule) !== JSON.stringify(current.value.schedule);
            const nextAt = scheduleChanged
              ? nextOccurrence(schedule, now - 1)
              : current.value.nextAt;
            const value = yield* validate(Trigger, {
              ...candidate,
              ...(nextAt === undefined ? { nextAt: undefined } : { nextAt }),
            });
            yield* tx.set("triggers", value);
            return value;
          }),
        );
      });
    const listRuns = (id: TriggerId) =>
      store.transaction((tx) =>
        tx
          .list("trigger_runs", { limit: Number.MAX_SAFE_INTEGER })
          .pipe(
            Effect.map((runs) =>
              runs
                .filter((run) => run.triggerId === id)
                .toSorted((a, b) => b.scheduledAt - a.scheduledAt),
            ),
          ),
      );
    const advance = (nowInput?: number) =>
      Effect.gen(function* () {
        const now = nowInput ?? (yield* Clock.currentTimeMillis);
        yield* validate(Schema.Number.pipe(Schema.nonNegative()), now);
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            const triggers = yield* tx.list("triggers", { limit: Number.MAX_SAFE_INTEGER });
            const runs = yield* tx.list("trigger_runs", { limit: Number.MAX_SAFE_INTEGER });
            const dispatches: TriggerDispatch[] = [];
            for (const run of runs.filter((value) => value.status === "running")) {
              if (!run.taskId) {
                const { startedAt: _startedAt, ...withoutStart } = run;
                yield* tx.set("trigger_runs", { ...withoutStart, status: "queued" });
                continue;
              }
              const task = yield* tx.get("tasks", run.taskId);
              if (Option.isSome(task) && terminalTask(task.value.status)) {
                yield* tx.set("trigger_runs", {
                  ...run,
                  status: task.value.status === "idle" ? "ran" : "failed",
                  finishedAt: now,
                  ...(task.value.status === "idle"
                    ? {}
                    : { error: `Trigger task ended as ${task.value.status}` }),
                });
              }
            }
            for (const trigger of triggers) {
              if (!trigger.enabled) continue;
              const due = dueOccurrences(trigger, now);
              if (!due.length) continue;
              const latestDue = due[due.length - 1] as number;
              const latest = latestDue >= now - CATCH_UP_MS ? latestDue : undefined;
              const existing = runs.filter((run) => run.triggerId === trigger.id);
              const known = new Set(existing.map((run) => run.occurrenceKey));
              const missed = latest === undefined ? due : due.slice(0, -1);
              for (const scheduledAt of missed) {
                const occurrenceKey = `${trigger.id}:${scheduledAt}`;
                if (!known.has(occurrenceKey)) {
                  yield* tx.insert("trigger_runs", {
                    id: TriggerRunId.make(`run:${occurrenceKey}`),
                    triggerId: trigger.id,
                    occurrenceKey,
                    scheduledAt,
                    status: "missed",
                    finishedAt: now,
                  });
                }
              }
              if (latest !== undefined) {
                const latestKey = `${trigger.id}:${latest}`;
                if (!known.has(latestKey)) {
                  const busy = existing.some(activeRun);
                  const run: TriggerRun = {
                    id: TriggerRunId.make(`run:${latestKey}`),
                    triggerId: trigger.id,
                    occurrenceKey: latestKey,
                    scheduledAt: latest,
                    status: busy ? "skipped" : "queued",
                    ...(busy ? { finishedAt: now } : {}),
                  };
                  yield* tx.insert("trigger_runs", run);
                  if (!busy) dispatches.push({ trigger, run });
                }
              }
              const nextAt = nextOccurrence(trigger.schedule, latestDue);
              const { nextAt: _nextAt, ...withoutNextAt } = trigger;
              yield* tx.set(
                "triggers",
                nextAt === undefined
                  ? { ...withoutNextAt, updatedAt: now, enabled: false }
                  : { ...withoutNextAt, updatedAt: now, nextAt },
              );
            }
            return dispatches;
          }),
        );
      });
    const start = (
      runId: TriggerRunId,
      event: {
        readonly triggerId: TriggerId;
        readonly botId: BotId;
        readonly prompt: string;
        readonly payload: JsonValue;
      },
    ) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.get("trigger_runs", runId);
          if (Option.isNone(current))
            return yield* fail("NotFound", `Unknown trigger run: ${runId}`);
          if (current.value.status !== "queued") return false;
          const now = yield* Clock.currentTimeMillis;
          yield* tx.set("trigger_runs", { ...current.value, status: "running", startedAt: now });
          const storedEvent = {
            source: "trigger",
            kind: "fired",
            triggerId: event.triggerId,
            botId: event.botId,
            prompt: event.prompt,
            runId,
            occurrenceKey: current.value.occurrenceKey,
            scheduledAt: current.value.scheduledAt,
            payload: event.payload,
          } as const;
          yield* tx.insert("events", { id: `trigger:${runId}`, at: now, event: storedEvent });
          return true;
        }),
      );
    const accepted = (runId: TriggerRunId, taskId: TaskId) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.get("trigger_runs", runId);
          if (Option.isNone(current))
            return yield* fail("NotFound", `Unknown trigger run: ${runId}`);
          if (current.value.status !== "running") return;
          yield* tx.set("trigger_runs", { ...current.value, taskId });
        }),
      );
    const failed = (runId: TriggerRunId, error: string) =>
      store.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.get("trigger_runs", runId);
          if (Option.isNone(current))
            return yield* fail("NotFound", `Unknown trigger run: ${runId}`);
          const now = yield* Clock.currentTimeMillis;
          yield* tx.set("trigger_runs", {
            ...current.value,
            status: "failed",
            finishedAt: now,
            error: error.slice(0, 1_000),
          });
        }),
      );
    return { create, get, list, update, listRuns, advance, start, accepted, failed };
  }),
);

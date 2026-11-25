import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotConfig, BotId, Task, TaskId, Trigger, TriggerId, type TriggerRun } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "./config-store.js";
import { CoreLive } from "./index.js";
import { Store } from "./store.js";
import { CATCH_UP_MS, nextOccurrence, TriggerRegistry } from "./triggers.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-trigger-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const run = <A, E>(
  effect: Effect.Effect<A, E, Store | ConfigStore | TriggerRegistry>,
  dataDirectory: string,
) => Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(CoreLive({ dataDirectory })))));

const trigger = Schema.decodeUnknownSync(Trigger)({
  id: "trigger-1",
  name: "Every minute",
  enabled: true,
  botId: "bot-1",
  prompt: "Run the check",
  payload: {},
  schedule: { kind: "interval", startAt: 1_000, everyMs: 1_000 },
  overlap: "skip",
  createdAt: 1,
  updatedAt: 1,
  nextAt: 1_000,
});
const configuredBot = Schema.decodeUnknownSync(BotConfig)({
  id: "bot-1",
  name: "Worker",
  description: "Runs scheduled checks",
  soul: "",
  modelSelection: { instanceId: "local", model: "test" },
  cwd: "/tmp",
});

describe("TriggerRegistry", () => {
  it("preserves an explicit trigger ID and rejects duplicate creation", async () => {
    const path = directory();
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ConfigStore;
        yield* config.writeBots([configuredBot]);
        const registry = yield* TriggerRegistry;
        const input = {
          id: TriggerId.make("stable-trigger"),
          name: "Stable check",
          botId: BotId.make("bot-1"),
          prompt: "Run the stable check",
          payload: {},
          enabled: true,
          schedule: { kind: "once" as const, at: Date.now() + 60_000 },
        };
        const created = yield* registry.create(input);
        const duplicate = yield* Effect.either(registry.create(input));
        return { created, duplicate };
      }),
      path,
    );
    expect(result.created.id).toBe("stable-trigger");
    expect(result.duplicate._tag).toBe("Left");
    if (result.duplicate._tag === "Left") expect(result.duplicate.left.code).toBe("Conflict");
  });

  it("deduplicates due occurrences and records older occurrences as missed", async () => {
    const path = directory();
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* store.transaction((tx) => tx.insert("triggers", trigger));
        const dispatches = yield* registry.advance(2_500);
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]?.run.scheduledAt).toBe(2_000);
        const second = yield* registry.advance(2_500);
        expect(second.map((value) => value.run.id)).toEqual(
          dispatches.map((value) => value.run.id),
        );
        const runs = yield* registry.listRuns(TriggerId.make("trigger-1"));
        return runs;
      }),
      path,
    );
    expect(result.map((run) => [run.scheduledAt, run.status])).toEqual([
      [2_000, "queued"],
      [1_000, "missed"],
    ]);
  });

  it("keeps an occurrence running through Chief acceptance and persists its event", async () => {
    const path = directory();
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* store.transaction((tx) => tx.insert("triggers", trigger));
        const [dispatch] = yield* registry.advance(1_000);
        if (!dispatch) return yield* Effect.die("Missing dispatch");
        expect(
          yield* registry.start(dispatch.run.id, {
            triggerId: dispatch.trigger.id,
            botId: BotId.make("bot-1"),
            prompt: dispatch.trigger.prompt,
            payload: {},
          }),
        ).toBe(true);
        expect(
          yield* registry.start(dispatch.run.id, {
            triggerId: dispatch.trigger.id,
            botId: configuredBot.id,
            prompt: dispatch.trigger.prompt,
            payload: {},
          }),
        ).toBe(false);
        yield* registry.accepted(dispatch.run.id, TaskId.make("task-1"));
        const runs = yield* registry.listRuns(TriggerId.make("trigger-1"));
        const events = yield* store.transaction((tx) => tx.list("events"));
        return { runs, events };
      }),
      path,
    );
    expect(result.runs[0]).toMatchObject<Partial<TriggerRun>>({
      status: "running",
      taskId: TaskId.make("task-1"),
    });
    expect(result.events[0]?.event).toMatchObject({
      source: "trigger",
      kind: "fired",
      triggerId: "trigger-1",
    });
    expect(result.events).toHaveLength(1);
  });

  it("retries queued once occurrences and expires them after the catch-up window", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* store.transaction((tx) =>
          tx.insert("triggers", {
            ...trigger,
            schedule: { kind: "once", at: 1_000 },
          }),
        );
        const first = yield* registry.advance(1_000);
        expect(first).toHaveLength(1);
        expect((yield* registry.advance(1_001))[0]?.run.id).toBe(first[0]?.run.id);
        expect(yield* registry.advance(CATCH_UP_MS + 1_001)).toEqual([]);
        expect(yield* registry.listRuns(trigger.id)).toMatchObject([
          { status: "missed", finishedAt: CATCH_UP_MS + 1_001 },
        ]);
      }),
      directory(),
    );
  });

  it("pausing cancels queued occurrences and works after the target bot was removed", async () => {
    await run(
      Effect.gen(function* () {
        const config = yield* ConfigStore;
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* config.writeBots([configuredBot]);
        yield* store.transaction((tx) =>
          tx.insert("triggers", {
            ...trigger,
            schedule: { kind: "once", at: 1_000 },
          }),
        );
        const [dispatch] = yield* registry.advance(1_000);
        if (!dispatch) return yield* Effect.die("Missing dispatch");
        yield* config.writeBots([]);
        expect((yield* registry.update(trigger.id, { enabled: false })).enabled).toBe(false);
        expect(
          yield* registry.start(dispatch.run.id, {
            triggerId: trigger.id,
            botId: configuredBot.id,
            prompt: trigger.prompt,
            payload: {},
          }),
        ).toBe(false);
        yield* config.writeBots([configuredBot]);
        yield* registry.update(trigger.id, { enabled: true });
        expect(yield* registry.advance(1_001)).toEqual([]);
        expect(yield* registry.listRuns(trigger.id)).toMatchObject([{ status: "skipped" }]);
      }),
      directory(),
    );
  });

  it("recovers interrupted dispatch without duplicating its event or an already-created task", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* store.transaction((tx) => tx.insert("triggers", trigger));
        const [dispatch] = yield* registry.advance(1_000);
        if (!dispatch) return yield* Effect.die("Missing dispatch");
        const event = {
          triggerId: trigger.id,
          botId: configuredBot.id,
          prompt: trigger.prompt,
          payload: {},
        };
        yield* registry.start(dispatch.run.id, event);
        expect((yield* registry.advance(1_001))[0]?.run.id).toBe(dispatch.run.id);
        expect(yield* registry.start(dispatch.run.id, event)).toBe(true);
        const taskId = TaskId.make(`trigger:${dispatch.run.id}`);
        const task = Schema.decodeUnknownSync(Task)({
          id: taskId,
          botId: configuredBot.id,
          title: "Synthetic trigger task",
          status: "idle",
          createdAt: 1_001,
          updatedAt: 1_001,
          lastActivityAt: 1_001,
          session: { instanceId: "local" },
          pendingRequestIds: [],
          queue: [],
          origin: { kind: "trigger" },
        });
        yield* store.transaction((tx) => tx.insert("tasks", task));
        expect(yield* registry.advance(1_002)).toEqual([]);
        expect(yield* registry.listRuns(trigger.id)).toMatchObject([{ status: "ran", taskId }]);
        expect(yield* store.transaction((tx) => tx.list("events"))).toHaveLength(1);
      }),
      directory(),
    );
  });

  it("marks occurrences outside the restart catch-up window as missed", async () => {
    const path = directory();
    const stale = Schema.decodeUnknownSync(Trigger)({
      ...trigger,
      id: "trigger-stale",
      schedule: { kind: "once", at: 1_000 },
      nextAt: 1_000,
    });
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const registry = yield* TriggerRegistry;
        yield* store.transaction((tx) => tx.insert("triggers", stale));
        const dispatches = yield* registry.advance(CATCH_UP_MS + 2_000);
        const runs = yield* registry.listRuns(TriggerId.make("trigger-stale"));
        return { dispatches, runs };
      }),
      path,
    );
    expect(result.dispatches).toHaveLength(0);
    expect(result.runs).toMatchObject([{ scheduledAt: 1_000, status: "missed" }]);
  });

  it("calculates daily and cron occurrences in the configured timezone", () => {
    const day = Date.UTC(2026, 0, 1, 8, 59);
    expect(nextOccurrence({ kind: "daily", at: "09:00", timeZone: "UTC" }, day)).toBe(
      Date.UTC(2026, 0, 1, 9),
    );
    expect(nextOccurrence({ kind: "cron", expression: "*/15 * * * *", timeZone: "UTC" }, day)).toBe(
      Date.UTC(2026, 0, 1, 9),
    );
  });
});

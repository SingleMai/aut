import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Chief,
  ConfigStore,
  CoreLive,
  isMemoryDreamTask,
  isMemoryDreamTrigger,
  memoryDreamTriggerId,
  Store,
  TriggerRegistry,
} from "@aut/core";
import {
  type AutEvent,
  BotConfig,
  BotId,
  MessageId,
  Task,
  TaskId,
  Trigger,
  TriggerId,
} from "@aut/protocol";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { MemoryDreams, MemoryDreamsLive } from "./memory-dreams.js";
import { TriggerScheduler, TriggerSchedulerLive } from "./triggers.js";

const directories: string[] = [];
const layer = () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-memory-dreams-"));
  directories.push(dataDirectory);
  return MemoryDreamsLive.pipe(Layer.provideMerge(CoreLive({ dataDirectory })));
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "dream-bot",
  name: "Dream bot",
  description: "Fixture",
  soul: "",
  modelSelection: { instanceId: "local", model: "configured-model" },
  cwd: "/tmp",
});
const makeTask = (id: string, status: Task["status"], queue: Task["queue"] = []): Task =>
  Schema.decodeUnknownSync(Task)({
    id,
    botId: bot.id,
    title: "Synthetic work",
    status,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue,
    origin: { kind: "user" },
  });
const run = <A, E>(
  program: Effect.Effect<A, E, MemoryDreams | ConfigStore | Store | TriggerRegistry>,
) => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer()))));

it("creates default plans for existing and new bots while retaining pause, schedule and orphan history", async () => {
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const registry = yield* TriggerRegistry;
      const dreams = yield* MemoryDreams;
      yield* config.writeBots([bot]);
      yield* dreams.ensure;
      const initial = (yield* registry.list())[0];
      expect(initial).toMatchObject({
        id: memoryDreamTriggerId(bot.id),
        enabled: true,
        botId: bot.id,
        schedule: {
          kind: "daily",
          at: "03:00",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        payload: { kind: "memory-dream" },
      });
      yield* registry.update(memoryDreamTriggerId(bot.id), {
        enabled: false,
        schedule: { kind: "daily", at: "04:15", timeZone: "UTC" },
      });
      const second = { ...bot, id: BotId.make("second-bot"), name: "Second" };
      yield* config.writeBots([bot, second]);
      yield* dreams.ensure;
      const triggers = yield* registry.list();
      expect(triggers).toHaveLength(2);
      expect(triggers.find((value) => value.botId === bot.id)).toMatchObject({
        enabled: false,
        schedule: { at: "04:15" },
      });
      expect(triggers.find((value) => value.botId === second.id)?.enabled).toBe(true);
      expect(
        (yield* registry
          .update(memoryDreamTriggerId(bot.id), { botId: second.id })
          .pipe(Effect.flip)).code,
      ).toBe("ImmutableField");
      expect(
        (yield* registry.update(memoryDreamTriggerId(bot.id), { payload: {} }).pipe(Effect.flip))
          .code,
      ).toBe("ImmutableField");
      yield* config.writeBots([bot]);
      yield* dreams.ensure;
      expect((yield* registry.list()).find((value) => value.botId === second.id)?.enabled).toBe(
        false,
      );
      expect(yield* config.readBots).toEqual([bot]);
    }),
  );
});

it("checks all busy states without overlooking older work and ignores unrelated trigger payloads", async () => {
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const registry = yield* TriggerRegistry;
      const store = yield* Store;
      const dreams = yield* MemoryDreams;
      yield* config.writeBots([bot]);
      yield* dreams.ensure;
      const trigger = (yield* registry.list())[0];
      if (!trigger) return yield* Effect.die("Missing dream plan");
      const busy = makeTask("old-busy", "created");
      yield* store.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert("tasks", busy);
          for (let index = 0; index < 60; index++)
            yield* tx.insert("tasks", makeTask(`idle-${index}`, "idle"));
        }),
      );
      for (const status of ["created", "running", "waiting_user", "reporting"] as const) {
        yield* store.transaction((tx) => tx.set("tasks", { ...busy, status }));
        expect(yield* dreams.ready(trigger)).toBe(false);
      }
      const queued = [{ messageIds: [MessageId.make("pending")], queuedAt: 1 }];
      for (const status of ["idle", "failed", "interrupted"] as const) {
        yield* store.transaction((tx) => tx.set("tasks", makeTask(busy.id, status, queued)));
        expect(yield* dreams.ready(trigger)).toBe(false);
      }
      expect(yield* dreams.ready({ ...trigger, id: TriggerId.make("unrelated") })).toBe(true);
      yield* store.transaction((tx) => tx.set("tasks", makeTask(busy.id, "idle")));
      expect(yield* dreams.ready(trigger)).toBe(true);
      expect(isMemoryDreamTrigger({ ...trigger, id: TriggerId.make("unrelated") })).toBe(false);
      expect(
        isMemoryDreamTask({
          ...busy,
          id: TaskId.make(`trigger:run:${trigger.id}:1000`),
          origin: { kind: "trigger" },
        }),
      ).toBe(true);
      expect(
        isMemoryDreamTask({
          ...busy,
          id: TaskId.make(`trigger:run:${trigger.id}:1000`),
          origin: { kind: "user" },
        }),
      ).toBe(false);
    }),
  );
});

it("keeps a busy dream queued, then dispatches once through Chief when its bot becomes idle", async () => {
  const submitted: AutEvent[] = [];
  const chief = Layer.succeed(Chief, {
    submit: (event) =>
      Effect.sync(() => {
        submitted.push(event);
        return {
          decisionLogId: "dream-test",
          awaitResult: Effect.succeed({ decisionLogId: "dream-test", execution: { ok: true } }),
        };
      }),
    propose: () => Effect.die("Unused proposal"),
    results: Stream.empty,
  });
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const registry = yield* TriggerRegistry;
      const store = yield* Store;
      const dreams = yield* MemoryDreams;
      yield* config.writeBots([bot]);
      yield* dreams.ensure;
      const original = (yield* registry.list())[0];
      if (!original) return yield* Effect.die("Missing dream plan");
      const scheduledAt = Date.now() - 100;
      const trigger = Schema.decodeUnknownSync(Trigger)({
        ...original,
        nextAt: scheduledAt,
        schedule: { kind: "once", at: scheduledAt },
      });
      const busy = makeTask("busy-work", "waiting_user");
      yield* store.transaction((tx) =>
        tx.set("triggers", trigger).pipe(Effect.zipRight(tx.insert("tasks", busy))),
      );
      yield* Effect.gen(function* () {
        const scheduler = yield* TriggerScheduler;
        yield* scheduler.tick();
        expect(submitted).toEqual([]);
        expect(yield* registry.listRuns(trigger.id)).toMatchObject([{ status: "queued" }]);
        yield* store.transaction((tx) => tx.set("tasks", { ...busy, status: "idle" }));
        yield* scheduler.tick();
        yield* scheduler.tick();
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toMatchObject({
          source: "trigger",
          botId: bot.id,
          triggerId: trigger.id,
          prompt: trigger.prompt,
          payload: { kind: "memory-dream" },
        });
        expect(yield* registry.listRuns(trigger.id)).toMatchObject([
          { status: "running", taskId: expect.stringContaining("trigger:run:memory-dream:") },
        ]);
      }).pipe(Effect.provide(TriggerSchedulerLive.pipe(Layer.provide(chief))));
    }),
  );
});

it("registers ordinary work before a same-bot dream without blocking other bots", async () => {
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const registry = yield* TriggerRegistry;
      const store = yield* Store;
      const dreams = yield* MemoryDreams;
      const second = { ...bot, id: BotId.make("second-bot"), name: "Second" };
      yield* config.writeBots([bot, second]);
      yield* dreams.ensure;
      const ordinaryId = TriggerId.make("ordinary-work");
      const ordinary = yield* registry.create({
        id: ordinaryId,
        name: "Ordinary work",
        botId: bot.id,
        enabled: true,
        schedule: { kind: "once", at: Date.now() + 60_000 },
        prompt: "Do ordinary work",
        payload: {},
      });
      const scheduledAt = Date.now() - 100;
      const plans = yield* registry.list();
      yield* store.transaction((tx) =>
        Effect.gen(function* () {
          for (const trigger of plans)
            yield* tx.set("triggers", {
              ...trigger,
              schedule: { kind: "once", at: scheduledAt },
              nextAt: scheduledAt,
            });
        }),
      );
      const submitted: string[] = [];
      const releaseRegistration = yield* Deferred.make<void>();
      const ordinarySubmitted = yield* Deferred.make<void>();
      const otherBotSubmitted = yield* Deferred.make<void>();
      const ordinaryTaskId = `trigger:run:${ordinary.id}:${scheduledAt}`;
      const chief = Layer.succeed(Chief, {
        submit: (event) =>
          Effect.gen(function* () {
            if (event.source !== "trigger") return yield* Effect.die("Unexpected event");
            submitted.push(event.triggerId);
            if (event.triggerId === ordinaryId)
              yield* Deferred.succeed(ordinarySubmitted, undefined);
            if (event.botId === second.id) yield* Deferred.succeed(otherBotSubmitted, undefined);
            return {
              decisionLogId: "ordered-dream-test",
              awaitResult: Effect.gen(function* () {
                if (event.triggerId === ordinaryId) {
                  yield* Deferred.await(releaseRegistration);
                  yield* store
                    .transaction((tx) => tx.insert("tasks", makeTask(ordinaryTaskId, "running")))
                    .pipe(Effect.orDie);
                }
                return { decisionLogId: "ordered-dream-test", execution: { ok: true } };
              }),
            };
          }),
        propose: () => Effect.die("Unused proposal"),
        results: Stream.empty,
      });
      yield* Effect.gen(function* () {
        const scheduler = yield* TriggerScheduler;
        const tick = yield* scheduler.tick().pipe(Effect.fork);
        yield* Deferred.await(ordinarySubmitted);
        yield* Deferred.await(otherBotSubmitted);
        expect(submitted).toContain(ordinaryId);
        expect(submitted).not.toContain(memoryDreamTriggerId(bot.id));
        yield* Deferred.succeed(releaseRegistration, undefined);
        yield* Fiber.join(tick);
        expect(yield* registry.listRuns(memoryDreamTriggerId(bot.id))).toMatchObject([
          { status: "queued" },
        ]);
        yield* store.transaction((tx) => tx.set("tasks", makeTask(ordinaryTaskId, "idle")));
        yield* scheduler.tick();
        expect(submitted.filter((id) => id === memoryDreamTriggerId(bot.id))).toHaveLength(1);
      }).pipe(Effect.provide(TriggerSchedulerLive.pipe(Layer.provide(chief))));
    }),
  );
});

it("fails interrupted dispatch explicitly when its recorded trigger intent was edited", async () => {
  await run(
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const registry = yield* TriggerRegistry;
      const store = yield* Store;
      const dreams = yield* MemoryDreams;
      yield* config.writeBots([bot]);
      yield* dreams.ensure;
      const original = (yield* registry.list())[0];
      if (!original) return yield* Effect.die("Missing dream plan");
      const scheduledAt = Date.now() - 100;
      yield* store.transaction((tx) =>
        tx.set("triggers", {
          ...original,
          schedule: { kind: "once", at: scheduledAt },
          nextAt: scheduledAt,
        }),
      );
      const [dispatch] = yield* registry.advance();
      if (!dispatch) return yield* Effect.die("Missing dream occurrence");
      yield* registry.start(dispatch.run.id, {
        triggerId: original.id,
        botId: original.botId,
        prompt: original.prompt,
        payload: original.payload,
      });
      yield* registry.update(original.id, { prompt: "Updated maintenance instructions" });
      const chief = Layer.succeed(Chief, {
        submit: () => Effect.die("Changed intent must not be submitted"),
        propose: () => Effect.die("Unused proposal"),
        results: Stream.empty,
      });
      yield* Effect.gen(function* () {
        const scheduler = yield* TriggerScheduler;
        yield* scheduler.tick();
        yield* scheduler.tick();
      }).pipe(Effect.provide(TriggerSchedulerLive.pipe(Layer.provide(chief))));
      expect(yield* registry.listRuns(original.id)).toMatchObject([
        {
          status: "failed",
          error: expect.stringContaining("trigger changed after its occurrence was recorded"),
        },
      ]);
      expect(yield* store.transaction((tx) => tx.list("events"))).toMatchObject([
        { event: { prompt: original.prompt, payload: original.payload } },
      ]);
    }),
  );
});

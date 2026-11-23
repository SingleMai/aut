import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotConfig, BotId, TaskId, Trigger, TriggerId, type TriggerRun } from "@aut/protocol";
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
  mcpServers: [],
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
        expect(second).toHaveLength(0);
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

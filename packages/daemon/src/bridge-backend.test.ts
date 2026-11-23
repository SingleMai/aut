import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Chief,
  type ChiefProposal,
  ConfigStore,
  CoreLive,
  insertTaskWithSession,
  Store,
} from "@aut/core";
import { BridgeBackend, type SessionIdentity } from "@aut/mcp-bridge";
import { BotConfig, BotId, MessageId, Task, TaskId, TriggerId, TriggerRun } from "@aut/protocol";
import { Effect, Either, Layer, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { AdministrationLive } from "./admin.js";
import { BridgeBackendLive } from "./bridge-backend.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "worker",
  name: "Worker",
  description: "Do work",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
  mcpServers: [],
});
const task = Schema.decodeUnknownSync(Task)({
  id: "worker-task",
  botId: "worker",
  title: "Work",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "local" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
});
const worker: SessionIdentity = { botId: bot.id, taskId: task.id, role: "worker" };
const slow: SessionIdentity = {
  botId: BotId.make("slow"),
  taskId: TaskId.make("slow-task"),
  role: "coordinator",
};
const run = <A, E>(
  body: Effect.Effect<A, E, BridgeBackend | Store | ConfigStore>,
  proposals: ChiefProposal[] = [],
) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-bridge-data-"));
  directories.push(dataDirectory);
  const chief = Layer.succeed(Chief, {
    submit: () => Effect.dieMessage("Unexpected user event in bridge test"),
    propose: (input) =>
      Effect.sync(() => {
        proposals.push(input);
        return {
          decisionLogId: "proposal-log",
          awaitResult: Effect.succeed({
            decisionLogId: "proposal-log",
            op: input.op,
            execution: { ok: true },
          }),
        };
      }),
    results: Stream.empty,
  });
  const services = AdministrationLive.pipe(
    Layer.provideMerge(Layer.merge(CoreLive({ dataDirectory }), chief)),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeConfig({
          harnessInstances: [
            { id: "local", name: "Local", kind: "codex", command: "codex", args: [] },
          ],
        });
        yield* (yield* ConfigStore).writeBots([bot, { ...bot, id: slow.botId, system: "primary" }]);
        yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            yield* insertTaskWithSession(tx, task);
            yield* insertTaskWithSession(tx, {
              ...task,
              id: slow.taskId,
              botId: slow.botId,
              origin: { kind: "coordination", decisionLogId: "source-decision" },
            });
            for (let i = 0; i < 55; i++)
              yield* tx.insert("main_thread_messages", {
                id: MessageId.make(`m${i}`),
                author: "user",
                kind: "text",
                at: i,
                text: `Message ${i}`,
              });
          }),
        );
        return yield* body;
      }).pipe(Effect.provide(BridgeBackendLive.pipe(Layer.provideMerge(services)))),
    ),
  );
};

it("provides bounded chronological reads, ID selection and structured task reports", async () => {
  const result = await run(
    Effect.gen(function* () {
      const backend = yield* BridgeBackend;
      return {
        latest: yield* backend.readMainThread(worker, {}),
        older: yield* backend.readMainThread(worker, { before: MessageId.make("m5"), limit: 2 }),
        selected: yield* backend.readMainThread(worker, {
          ids: [MessageId.make("m3"), MessageId.make("m1")],
        }),
        tasks: yield* backend.listTasks(worker, { botId: bot.id }),
        task: yield* backend.getTask(worker, { taskId: task.id }),
        oversized: yield* Effect.either(backend.listTasks(worker, { limit: 51 })),
        mixed: yield* Effect.either(
          backend.readMainThread(worker, { ids: [MessageId.make("m1")], limit: 1 }),
        ),
      };
    }),
  );
  expect(result.latest).toHaveLength(50);
  expect(result.latest[0]?.id).toBe("m5");
  expect(result.older.map((entry) => entry.id)).toEqual(["m3", "m4"]);
  expect(result.selected.map((entry) => entry.id)).toEqual(["m3", "m1"]);
  expect(result.tasks.map((entry) => entry.id)).toEqual([task.id]);
  expect(result.task).toEqual(task);
  expect(Either.isLeft(result.oversized)).toBe(true);
  expect(Either.isLeft(result.mixed)).toBe(true);
});

it("rechecks role and task ownership and revokes access after cancellation", async () => {
  const result = await run(
    Effect.gen(function* () {
      const backend = yield* BridgeBackend;
      const wrongRole = yield* Effect.either(backend.authorize({ ...worker, role: "coordinator" }));
      const wrongTask = yield* Effect.either(
        backend.getTask({ ...worker, taskId: slow.taskId }, { taskId: task.id }),
      );
      yield* (yield* Store).transaction((tx) => tx.set("tasks", { ...task, status: "cancelled" }));
      const cancelled = yield* Effect.either(backend.readMainThread(worker, {}));
      return [wrongRole, wrongTask, cancelled];
    }),
  );
  expect(result.every((entry) => entry._tag === "Left" && entry.left.code === "Forbidden")).toBe(
    true,
  );
});

it("sends only authenticated slow-brain proposals to the serial Chief", async () => {
  const proposals: ChiefProposal[] = [];
  const proposal = {
    op: {
      op: "send" as const,
      taskId: task.id,
      delivery: "queue" as const,
      messageIds: [MessageId.make("m1")],
    },
    rationale: "Continue the requested task",
  };
  const result = await run(
    Effect.gen(function* () {
      const backend = yield* BridgeBackend;
      const direct = { ...slow, role: "worker" as const, taskId: TaskId.make("primary-direct") };
      yield* (yield* Store).transaction((tx) =>
        insertTaskWithSession(tx, { ...task, id: direct.taskId, botId: direct.botId }),
      );
      yield* backend.authorize(direct);
      expect((yield* Effect.flip(backend.proposeRoute(direct, proposal, "direct"))).code).toBe(
        "Forbidden",
      );
      expect((yield* Effect.flip(backend.authorize({ ...direct, role: "coordinator" }))).code).toBe(
        "Forbidden",
      );
      const denied = yield* Effect.either(backend.proposeRoute(worker, proposal, "request-1"));
      const accepted = yield* backend.proposeRoute(slow, proposal, "request-2");
      return { denied, accepted };
    }),
    proposals,
  );
  expect(Either.isLeft(result.denied) && result.denied.left.code).toBe("Forbidden");
  expect(result.accepted).toEqual({ accepted: true, result: "proposal-log" });
  expect(proposals).toEqual([
    { originTaskId: slow.taskId, originBotId: slow.botId, ...proposal, eventRef: "mcp:request-2" },
  ]);
});

it("creates ordinary bots through either live role with shared defaults and conflicts", async () => {
  await run(
    Effect.gen(function* () {
      const bridge = yield* BridgeBackend;
      const config = yield* ConfigStore;
      const make = (id: string) => ({
        id: BotId.make(id),
        name: "日程助手",
        description: "整理日程",
        soul: "请用中文回答",
      });
      const custom = {
        name: "calendar",
        transport: "http" as const,
        url: "https://example.com/calendar",
      };
      yield* config.updateBots((bots) => bots.map((b) => ({ ...b, mcpServers: [custom] })));
      const child = make("calendar");
      expect(yield* bridge.createBot(worker, child)).toEqual({ id: child.id, name: child.name });
      expect((yield* config.readBots).find((b) => b.id === child.id)).toEqual({
        ...child,
        cwd: bot.cwd,
        modelSelection: bot.modelSelection,
        mcpServers: [],
      });
      const explicit = {
        ...make("planner"),
        characterId: "custom-planner",
        cwd: "/tmp/planner",
        modelSelection: { instanceId: "local", model: "planner" },
        mcpServers: [custom],
      };
      yield* bridge.createBot(slow, explicit);
      expect((yield* config.readBots).find((b) => b.id === explicit.id)).toEqual(explicit);
      const receipts = yield* (yield* Store).transaction((tx) => tx.list("main_thread_messages"));
      expect(receipts.filter((message) => message.botCreation)).toMatchObject([
        { taskId: worker.taskId, botCreation: { botId: child.id, status: "available" } },
        { taskId: slow.taskId, botCreation: { botId: explicit.id, status: "available" } },
      ]);
      for (const rejected of [
        child,
        make("none"),
        make("__proto__"),
        { ...make("other"), modelSelection: { instanceId: "missing", model: "x" } },
      ]) {
        expect((yield* Effect.flip(bridge.createBot(worker, rejected))).code).toBe("InvalidInput");
      }
      expect(
        (yield* Effect.flip(bridge.createBot({ ...worker, taskId: slow.taskId }, make("forged"))))
          .code,
      ).toBe("Forbidden");
      yield* (yield* Store).transaction((tx) => tx.set("tasks", { ...task, status: "cancelled" }));
      expect((yield* Effect.flip(bridge.createBot(worker, make("stale")))).code).toBe("Forbidden");
      expect((yield* config.readBots).map((b) => b.id)).toEqual([
        bot.id,
        slow.botId,
        child.id,
        explicit.id,
      ]);
    }),
  );
});

it("creates triggers with role-scoped Bot targets and stable-ID conflicts", async () => {
  await run(
    Effect.gen(function* () {
      const bridge = yield* BridgeBackend;
      const input = {
        id: TriggerId.make("worker-trigger"),
        name: "Worker schedule",
        botId: bot.id,
        prompt: "Run the worker schedule",
        payload: {},
        enabled: true,
        schedule: { kind: "once" as const, at: Date.now() + 60_000 },
      };
      const created = yield* bridge.createTrigger(worker, input);
      expect(created).toMatchObject({
        id: "worker-trigger",
        botId: bot.id,
        overlap: "skip",
      });
      yield* (yield* Store).transaction((tx) =>
        tx.insert(
          "trigger_runs",
          Schema.decodeUnknownSync(TriggerRun)({
            id: "run:worker-trigger:1",
            triggerId: created.id,
            occurrenceKey: "worker-trigger:1",
            scheduledAt: 1,
            status: "failed",
            error: "Synthetic failure",
          }),
        ),
      );
      expect(yield* bridge.getTrigger(worker, { triggerId: created.id })).toEqual(created);
      expect(
        yield* bridge.listTriggers(worker, { botId: bot.id, enabled: true, limit: 10 }),
      ).toContainEqual(created);
      expect(
        yield* bridge.listTriggerRuns(worker, { triggerId: created.id, limit: 10 }),
      ).toMatchObject([{ id: "run:worker-trigger:1", status: "failed" }]);
      expect(
        (yield* Effect.flip(
          bridge.listTriggerRuns(worker, { triggerId: TriggerId.make("missing-trigger") }),
        )).code,
      ).toBe("NotFound");
      const paused = yield* bridge.updateTrigger(worker, {
        triggerId: created.id,
        update: { enabled: false },
      });
      expect(paused.enabled).toBe(false);
      expect(
        (yield* Effect.flip(
          bridge.updateTrigger(worker, {
            triggerId: created.id,
            update: { botId: slow.botId },
          }),
        )).code,
      ).toBe("Forbidden");
      const retargeted = yield* bridge.updateTrigger(slow, {
        triggerId: created.id,
        update: { botId: slow.botId, enabled: true },
      });
      expect(retargeted.botId).toBe(slow.botId);
      expect(
        (yield* Effect.flip(
          bridge.getTrigger(worker, { triggerId: TriggerId.make("missing-trigger") }),
        )).code,
      ).toBe("NotFound");
      expect(
        (yield* Effect.flip(
          bridge.createTrigger(worker, {
            ...input,
            id: TriggerId.make("worker-trigger-2"),
            botId: slow.botId,
          }),
        )).code,
      ).toBe("Forbidden");
      const coordinator = yield* bridge.createTrigger(slow, {
        ...input,
        id: TriggerId.make("slow-target-trigger"),
        botId: bot.id,
      });
      expect(coordinator.id).toBe("slow-target-trigger");
      expect((yield* Effect.flip(bridge.createTrigger(worker, input))).code).toBe("Conflict");
    }),
  );
});

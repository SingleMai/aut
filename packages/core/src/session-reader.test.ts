import {
  AdapterError,
  type HarnessAdapter,
  type ResumeCursor,
  type SessionHistory,
  type StartSessionInput,
  Task,
  TaskId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, TestClock } from "effect";
import { expect } from "vitest";
import { CoreError } from "./errors.js";
import { HarnessResolver, type SessionSnapshot } from "./session-manager/ports.js";
import { SessionReader, SessionReaderLive, SessionSnapshotSource } from "./session-reader.js";

const history: SessionHistory = {
  turns: Array.from({ length: 25 }, (_, i) => ({
    id: `turn-${i}`,
    status: "completed",
    items: [
      { id: `user-${i}`, kind: "user", status: "completed", text: `Request ${i}` },
      {
        id: `tool-${i}`,
        kind: "tool",
        status: "completed",
        text: "Read files",
        tool: { name: "commandExecution", input: "pwd", output: "/tmp/synthetic", exitCode: 0 },
      },
      { id: `reply-${i}`, kind: "assistant", status: "completed", text: `Result ${i}` },
    ],
  })),
};
const task = Schema.decodeUnknownSync(Task)({
  id: "task",
  botId: "worker",
  title: "Synthetic task",
  status: "running",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  session: {
    instanceId: "configured-instance",
    cursor: { kind: "fixture", data: { id: "native" } },
  },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
});
const unsupported = () =>
  Effect.fail(new AdapterError({ code: "NotSupported", message: "No work may start in a read" }));
const fixture = (sessionContext = false) => {
  const state = {
    snapshot: { task } as SessionSnapshot,
    history,
    resolved: [] as string[],
    opened: [] as ResumeCursor[],
    closed: 0,
    read: Effect.succeed(history) as Effect.Effect<SessionHistory, AdapterError>,
  };
  const adapter: HarnessAdapter = {
    kind: "fixture",
    capabilities: {
      resume: true,
      fork: false,
      steer: false,
      nativeFullAccess: true,
      questions: { native: true, multiQuestion: true, multiSelect: false, freeText: true },
      transcript: true,
      sessionHistory: true,
      sessionContext,
    },
    startSession: () => Effect.die("History reads cannot start sessions"),
    resumeSession: () => Effect.die("History reads cannot resume sessions"),
    readSession: (cursor) =>
      Effect.acquireRelease(
        Effect.sync(() => state.opened.push(cursor)),
        () => Effect.sync(() => state.closed++),
      ).pipe(Effect.zipRight(Effect.suspend(() => state.read))),
  };
  const layer = SessionReaderLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SessionSnapshotSource, {
          snapshot: (id) =>
            id === TaskId.make("missing")
              ? Effect.fail(new CoreError({ code: "NotFound", message: "Unknown task" }))
              : Effect.sync(() => ({ ...state.snapshot, task: { ...state.snapshot.task, id } })),
        }),
        Layer.succeed(HarnessResolver, {
          resolve: (id) =>
            Effect.sync(() => {
              state.resolved.push(id);
              return adapter;
            }),
        }),
      ),
    ),
  );
  return { state, adapter, layer };
};

it.effect(
  "pages turns without paging native context and respects capability-based omission",
  () => {
    const context = {
      usage: { tokens: 1234, window: 200000 },
      compaction: { turnId: "turn-24", itemId: "compact", status: "completed" as const },
    };
    const f = fixture(true);
    f.state.read = Effect.succeed({ ...history, context });
    const unsupported = fixture();
    unsupported.state.read = Effect.succeed({ ...history, context });
    return Effect.gen(function* () {
      const reader = yield* SessionReader;
      const newest = yield* reader.read(task.id, { limit: 1 });
      const earlier = yield* reader.read(task.id, { before: newest.nextBefore, limit: 1 });
      expect(newest.history.context).toEqual(context);
      expect(earlier.history.context).toEqual(context);
      expect(earlier.history.turns[0]?.id).toBe("turn-23");
      const hidden = yield* Effect.gen(function* () {
        return yield* (yield* SessionReader).read(task.id);
      }).pipe(Effect.provide(unsupported.layer));
      expect(hidden.history.context).toBeUndefined();
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "reads the configured native history without starting/resuming work and releases only its reader",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const reader = yield* SessionReader;
      const newest = yield* reader.read(task.id);
      expect(newest.availability).toBe("available");
      expect(newest.task).toEqual(task);
      expect(newest.history.turns).toEqual(history.turns.slice(15));
      expect(newest.hasEarlier).toBe(true);
      expect(newest.nextBefore).toBe("turn-15");
      const middle = yield* reader.read(task.id, { before: newest.nextBefore });
      expect(middle.history.turns).toEqual(history.turns.slice(5, 15));
      expect(middle.nextBefore).toBe("turn-5");
      const oldest = yield* reader.read(task.id, { before: middle.nextBefore });
      expect(oldest.history.turns).toEqual(history.turns.slice(0, 5));
      expect(oldest.hasEarlier).toBe(false);
      expect(oldest.nextBefore).toBeUndefined();
      expect(f.state.resolved).toEqual(Array(3).fill("configured-instance"));
      expect(f.state.opened).toEqual(Array(3).fill(task.session.cursor));
      expect(f.state.closed).toBe(3);
      expect(f.state.snapshot.task).toBe(task);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("uses an existing live reader without resolving or closing the worker", () => {
  const f = fixture();
  let reads = 0;
  f.state.snapshot = {
    task,
    live: {
      adapter: f.adapter,
      input: {} as StartSessionInput,
      session: {
        cursor: { kind: "fixture", data: "live-cursor" },
        fork: unsupported,
        transcript: () => Effect.die("Flattened transcript is not full history"),
        readSession: () =>
          Effect.sync(() => {
            reads++;
            return history;
          }),
      },
    },
  };
  return Effect.gen(function* () {
    const result = yield* (yield* SessionReader).read(task.id, { limit: 1 });
    expect(result.history.turns).toEqual(history.turns.slice(-1));
    expect(reads).toBe(1);
    expect(f.state.resolved).toEqual([]);
    expect(f.state.opened).toEqual([]);
    expect(f.state.closed).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("distinguishes no native cursor from an available empty history", () => {
  const f = fixture();
  f.state.snapshot = { task: { ...task, session: { instanceId: "configured-instance" } } };
  return Effect.gen(function* () {
    const reader = yield* SessionReader;
    const pending = yield* reader.read(task.id);
    expect(pending.availability).toBe("pending");
    expect(pending.hasEarlier).toBe(false);
    expect(f.state.resolved).toEqual([]);
    f.state.snapshot = { task };
    f.state.read = Effect.succeed({ turns: [] });
    expect((yield* reader.read(task.id)).availability).toBe("available");
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects unknown tasks, unknown cursors, and invalid page sizes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const reader = yield* SessionReader;
    expect((yield* reader.read(TaskId.make("missing")).pipe(Effect.flip)).code).toBe("NotFound");
    expect((yield* reader.read(task.id, { before: "absent" }).pipe(Effect.flip)).code).toBe(
      "NotFound",
    );
    for (const limit of [0, 21, 1.5])
      expect((yield* reader.read(task.id, { limit }).pipe(Effect.flip)).code).toBe("Validation");
    expect(f.state.opened).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "reports missing capability/method as unsupported without falling back to incomplete events",
  () => {
    const f = fixture();
    const noRead = {
      cursor: { kind: "fixture", data: null },
      fork: unsupported,
      transcript: () => Effect.succeed([]),
    };
    f.state.snapshot = {
      task,
      live: { adapter: f.adapter, input: {} as StartSessionInput, session: noRead },
    };
    return Effect.gen(function* () {
      const reader = yield* SessionReader;
      expect((yield* reader.read(task.id)).availability).toBe("unsupported");
      f.state.snapshot = {
        task,
        live: {
          adapter: {
            ...f.adapter,
            capabilities: { ...f.adapter.capabilities, sessionHistory: false },
          },
          input: {} as StartSessionInput,
          session: {
            ...noRead,
            readSession: () => Effect.die("Unsupported capability cannot be called"),
          },
        },
      };
      expect((yield* reader.read(task.id)).availability).toBe("unsupported");
      expect(f.state.opened).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "exposes failed or invalid native reads as retryable unavailable and closes the reader",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const reader = yield* SessionReader;
      f.state.read = Effect.fail(
        new AdapterError({ code: "ProcessExited", message: "fixture failure" }),
      );
      const failed = yield* reader.read(task.id);
      expect(failed.availability).toBe("unavailable");
      expect(failed.message).toContain("重试");
      f.state.read = Effect.succeed({
        turns: [history.turns[0], history.turns[0]],
      } as SessionHistory);
      expect((yield* reader.read(task.id)).availability).toBe("unavailable");
      expect(f.state.closed).toBe(2);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("bounds native reads to twenty seconds and releases their scope", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    f.state.read = Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never));
    const reader = yield* SessionReader;
    const pending = yield* reader.read(task.id).pipe(Effect.fork);
    yield* Deferred.await(started);
    yield* TestClock.adjust("20 seconds");
    expect((yield* Fiber.join(pending)).availability).toBe("unavailable");
    expect(f.state.closed).toBe(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("serializes reads of one task while keeping different tasks independent", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const parallelStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.state.read = Effect.suspend(() =>
      Deferred.succeed(f.state.opened.length === 1 ? started : parallelStarted, undefined),
    ).pipe(Effect.zipRight(Deferred.await(release)), Effect.as(history));
    const reader = yield* SessionReader;
    const first = yield* reader.read(task.id).pipe(Effect.fork);
    yield* Deferred.await(started);
    const second = yield* reader.read(task.id).pipe(Effect.fork);
    yield* Effect.yieldNow();
    expect(f.state.opened).toHaveLength(1);
    const other = yield* reader.read(TaskId.make("independent")).pipe(Effect.fork);
    yield* Deferred.await(parallelStarted);
    expect(f.state.opened).toHaveLength(2);
    yield* Deferred.succeed(release, undefined);
    yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(other)]);
    expect(f.state.opened).toHaveLength(3);
    expect(f.state.closed).toBe(3);
  }).pipe(Effect.provide(f.layer));
});

it.effect("interruption closes a temporary reader and permits the next read", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    f.state.read = Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never));
    const reader = yield* SessionReader;
    const reading = yield* reader.read(task.id).pipe(Effect.fork);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(reading);
    expect(f.state.closed).toBe(1);
    f.state.read = Effect.succeed(history);
    expect((yield* reader.read(task.id)).availability).toBe("available");
    expect(f.state.closed).toBe(2);
  }).pipe(Effect.provide(f.layer));
});

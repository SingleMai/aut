import {
  SessionHistory,
  type Task,
  type TaskId,
  TaskSessionInput,
  type TaskSessionResponse,
} from "@aut/protocol";
import { Context, Effect, Layer, Option } from "effect";
import { CoreError, validate } from "./errors.js";
import { SessionManager } from "./session-manager/manager.js";
import { HarnessResolver, type SessionSnapshot } from "./session-manager/ports.js";
import { TaskRegistry } from "./task-registry.js";

/** Reading a session must not register work or acquire ownership of a worker's scope. */
export class SessionSnapshotSource extends Context.Tag("aut/SessionSnapshotSource")<
  SessionSnapshotSource,
  { readonly snapshot: (taskId: TaskId) => Effect.Effect<SessionSnapshot, CoreError> }
>() {}

export const SessionSnapshotSourceLive = Layer.effect(
  SessionSnapshotSource,
  Effect.map(SessionManager, (manager) => ({ snapshot: manager.snapshot })),
);

/** The API-only runtime has no worker manager; persisted tasks still support cold history reads. */
export const StoredSessionSnapshotSourceLive = Layer.effect(
  SessionSnapshotSource,
  Effect.map(TaskRegistry, (tasks) => ({
    snapshot: (taskId: TaskId) =>
      tasks.get(taskId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new CoreError({ code: "NotFound", message: "Unknown task" })),
            onSome: (task) => Effect.succeed({ task }),
          }),
        ),
      ),
  })),
);

export class SessionReader extends Context.Tag("aut/SessionReader")<
  SessionReader,
  {
    readonly read: (
      taskId: TaskId,
      input?: TaskSessionInput,
    ) => Effect.Effect<TaskSessionResponse, CoreError>;
  }
>() {}

const unavailable = (
  task: Task,
  availability: "pending" | "unsupported" | "unavailable",
  message: string,
): TaskSessionResponse => ({
  task,
  history: { turns: [] },
  availability,
  message,
  hasEarlier: false,
});

export const SessionReaderLive = Layer.effect(
  SessionReader,
  Effect.gen(function* () {
    const source = yield* SessionSnapshotSource;
    const resolver = yield* HarnessResolver;
    const locks = new Map<TaskId, Effect.Semaphore>();
    const read = (taskId: TaskId, input: TaskSessionInput = {}) =>
      Effect.gen(function* () {
        const query = yield* validate(TaskSessionInput, input);
        const lock = yield* Effect.sync(() => {
          let existing = locks.get(taskId);
          if (!existing) {
            existing = Effect.unsafeMakeSemaphore(1);
            locks.set(taskId, existing);
          }
          return existing;
        });
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const snapshot = yield* source.snapshot(taskId);
            const { task, live } = snapshot;
            const cursor = live?.session.cursor ?? task.session.cursor;
            if (!cursor) return unavailable(task, "pending", "尚未建立可读取的会话。");
            const loaded = yield* Effect.gen(function* () {
              const adapter = live?.adapter ?? (yield* resolver.resolve(task.session.instanceId));
              const readHistory = live
                ? live.session.readSession?.bind(live.session)
                : adapter.readSession?.bind(adapter, cursor);
              if (!adapter.capabilities.sessionHistory || !readHistory)
                return { availability: "unsupported" as const };
              const history = yield* Effect.scoped(readHistory()).pipe(
                Effect.flatMap((value) => validate(SessionHistory, value)),
                Effect.timeout("20 seconds"),
              );
              return { availability: "available" as const, history };
            }).pipe(
              Effect.catchAll(() => Effect.succeed({ availability: "unavailable" as const })),
            );
            if (loaded.availability !== "available")
              return unavailable(
                task,
                loaded.availability,
                loaded.availability === "unsupported"
                  ? "此执行器暂不支持读取完整会话。"
                  : "暂时无法读取会话，请重试。",
              );
            const turns = loaded.history.turns;
            const end =
              query.before === undefined
                ? turns.length
                : turns.findIndex((turn) => turn.id === query.before);
            if (end < 0)
              return yield* Effect.fail(
                new CoreError({ code: "NotFound", message: "Unknown session turn cursor" }),
              );
            const start = Math.max(0, end - (query.limit ?? 10));
            const page = turns.slice(start, end);
            const nextBefore = start > 0 ? page[0]?.id : undefined;
            return {
              task,
              history: { turns: page },
              availability: "available" as const,
              hasEarlier: start > 0,
              ...(nextBefore ? { nextBefore } : {}),
            };
          }),
        );
      });
    return { read };
  }),
);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DecisionLog as LogSchema,
  MainThreadMessage,
  MessageId,
  RequestId,
  Task,
  TaskId,
} from "@aut/protocol";
import { Deferred, Effect, Either, Fiber, Option, Schema, type Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "./config-store.js";
import { DecisionLog } from "./decision-log.js";
import { CoreError } from "./errors.js";
import type { EventBus } from "./event-bus.js";
import { CoreLive } from "./index.js";
import { MainThread } from "./main-thread.js";
import { Store } from "./store.js";
import { TaskRegistry } from "./task-registry.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-storage-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
type Services =
  | Store
  | MainThread
  | TaskRegistry
  | DecisionLog
  | ConfigStore
  | EventBus
  | Scope.Scope;
const run = <A, E>(effect: Effect.Effect<A, E, Services>, dataDirectory: string) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(CoreLive({ dataDirectory })))));

const message = (id: string, text = id) =>
  Schema.decodeUnknownSync(MainThreadMessage)({ id, at: 1, author: "user", kind: "text", text });
const task = Schema.decodeUnknownSync(Task)({
  id: "task-1",
  botId: "bot-1",
  title: "0",
  status: "created",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "local" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
});
const log = Schema.decodeUnknownSync(LogSchema)({
  id: "decision-1",
  at: 1,
  tree: "inbound",
  treeVersion: "1",
  input: { eventRef: "m1", state: { text: "hello" }, dynamicOptions: {} },
  classifierCalls: [],
  path: ["R0", "A0"],
  output: { op: "new", botId: "bot-1", requestMessageIds: ["m1"] },
  execution: { ok: true },
});

describe("SQLite persistence and domain services", () => {
  it("initializes the database and persists messages, tasks, cursors, requests, events and logs across reopen", async () => {
    const path = directory();
    await run(
      Effect.gen(function* () {
        const thread = yield* MainThread;
        const tasks = yield* TaskRegistry;
        const logs = yield* DecisionLog;
        const store = yield* Store;
        yield* thread.append(message("m1", "text with '); DROP TABLE tasks; --"));
        yield* tasks.create(task);
        yield* tasks.update(task.id, (current) => ({
          ...current,
          session: { ...current.session, cursor: { kind: "codex", data: { threadId: "native" } } },
        }));
        yield* logs.write(log);
        yield* store.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert("session_requests", {
              id: RequestId.make("r1"),
              taskId: task.id,
              state: "open",
              request: {
                id: RequestId.make("r1"),
                taskId: task.id,
                kind: "question",
                openedAt: 1,
                raw: null,
                questions: [{ id: "q", text: "Choose", multiSelect: false, allowFreeText: true }],
              },
            });
            yield* tx.insert("events", {
              id: "e1",
              at: 1,
              event: { source: "user", kind: "message", messageId: MessageId.make("m1") },
            });
          }),
        );
      }),
      path,
    );
    const reopened = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            return {
              messages: yield* tx.list("main_thread_messages"),
              tasks: yield* tx.list("tasks"),
              sessions: yield* tx.list("sessions"),
              requests: yield* tx.list("session_requests"),
              events: yield* tx.list("events"),
              logs: yield* tx.list("decision_logs"),
            };
          }),
        );
      }),
      path,
    );
    for (const values of Object.values(reopened)) expect(values).toHaveLength(1);
    expect(reopened.sessions[0]?.cursor?.data).toEqual({ threadId: "native" });
    expect(reopened.messages[0]?.text).toContain("DROP TABLE");
    const db = new DatabaseSync(join(path, "aut.db"));
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    db.close();
  });

  it("keeps delivery ownership in the session record from task creation", async () => {
    const path = directory();
    const queue = [{ messageIds: [MessageId.make("m1")], queuedAt: 1 }];
    await run(
      Effect.gen(function* () {
        const registry = yield* TaskRegistry;
        expect((yield* Effect.flip(registry.create({ ...task, queue }))).code).toBe(
          "InvalidTransition",
        );
        yield* registry.create(task);
        expect(
          (yield* Effect.flip(registry.update(task.id, (value) => ({ ...value, queue })))).code,
        ).toBe("ImmutableField");
        const stored = Option.getOrThrow(
          yield* (yield* Store).transaction((tx) => tx.get("sessions", task.id)),
        );
        expect(stored.execution).toEqual({
          generation: 0,
          pending: [],
          seenOperations: [],
          uncertain: [],
        });
      }),
      path,
    );
    const db = new DatabaseSync(join(path, "aut.db"));
    db.prepare("DELETE FROM sessions WHERE id = ?").run(task.id);
    db.close();
    await run(
      Effect.gen(function* () {
        const registry = yield* TaskRegistry;
        expect(
          (yield* Effect.flip(registry.transition(task.id, { type: "turn.started" }))).code,
        ).toBe("Storage");
        expect(Option.getOrThrow(yield* registry.get(task.id)).status).toBe("created");
      }),
      path,
    );
  });

  it("resolves the latest decision and user events by insertion order", async () => {
    await run(
      Effect.gen(function* () {
        yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert("decision_logs", { ...log, id: "first", at: 99 });
            yield* tx.insert("decision_logs", { ...log, id: "last", at: 1 });
            for (const [id, event] of [
              ["first", { source: "user", kind: "message", messageId: MessageId.make("m1") }],
              [
                "worker",
                {
                  source: "session",
                  taskId: task.id,
                  kind: "turn.started",
                  event: { kind: "turn.started", turnId: "turn" },
                },
              ],
              ["second", { source: "user", kind: "message", messageId: MessageId.make("m2") }],
            ] as const)
              yield* tx.insert("events", { id, at: 1, event });
            expect(Option.getOrThrow(yield* tx.latestDecisionForEvent("m1")).id).toBe("last");
            expect(Option.isNone(yield* tx.latestDecisionForEvent("absent"))).toBe(true);
            expect((yield* tx.userEvents).map((event) => event.id)).toEqual(["first", "second"]);
            expect((yield* tx.list("decision_logs")).map((entry) => entry.id)).toEqual([
              "first",
              "last",
            ]);
          }),
        );
      }),
      directory(),
    );
  });

  it("uses stable chronological pages and preserves requested ID order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const thread = yield* MainThread;
        yield* Effect.forEach(["a", "b", "c", "d"], (id) => thread.append(message(id)));
        return {
          latest: yield* thread.page({ limit: 2 }),
          previous: yield* thread.page({ before: "c", limit: 2 }),
          selected: yield* thread.getByIds([
            MessageId.make("d"),
            MessageId.make("missing"),
            MessageId.make("a"),
            MessageId.make("d"),
          ]),
          empty: yield* thread.getByIds([]),
          missing: yield* Effect.either(thread.page({ before: "missing" })),
        };
      }),
      directory(),
    );
    expect(result.latest.map((value) => value.id)).toEqual(["c", "d"]);
    expect(result.previous.map((value) => value.id)).toEqual(["a", "b"]);
    expect(result.selected.map((value) => value.id)).toEqual(["d", "a", "d"]);
    expect(result.empty).toEqual([]);
    expect(Either.isLeft(result.missing) && result.missing.left.code).toBe("NotFound");
  });

  it("rolls back a failed multi-table transaction", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const failure = yield* Effect.either(
          store.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert("main_thread_messages", message("rollback"));
              yield* tx.insert("decision_logs", log);
              return yield* Effect.fail(
                new CoreError({ code: "Conflict", message: "Expected failure" }),
              );
            }),
          ),
        );
        return {
          failure,
          rows: yield* store.transaction((tx) => tx.list("main_thread_messages")),
          logs: yield* store.transaction((tx) => tx.list("decision_logs")),
        };
      }),
      directory(),
    );
    expect(Either.isLeft(result.failure)).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.logs).toEqual([]);
  });

  it("rolls back on Fiber interruption and releases the connection for the next transaction", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const inserted = yield* Deferred.make<void>();
        const fiber = yield* Effect.fork(
          store.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert("main_thread_messages", message("interrupted"));
              yield* Deferred.succeed(inserted, undefined);
              yield* Effect.never;
            }),
          ),
        );
        yield* Deferred.await(inserted);
        yield* Fiber.interrupt(fiber);
        yield* store.transaction((tx) => tx.insert("main_thread_messages", message("after")));
        return yield* store.transaction((tx) => tx.list("main_thread_messages"));
      }).pipe(Effect.timeout("5 seconds")),
      directory(),
    );
    expect(result.map((value) => value.id)).toEqual(["after"]);
  });

  it("serializes concurrent updates without losing changes and preserves task identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRegistry;
        yield* tasks.create(task);
        yield* Effect.all(
          Array.from({ length: 50 }, () =>
            tasks.update(task.id, (current) => ({
              ...current,
              title: String(Number(current.title) + 1),
            })),
          ),
          { concurrency: "unbounded" },
        );
        const forbidden = yield* Effect.either(
          tasks.update(task.id, (current) => ({
            ...current,
            session: { ...current.session, instanceId: "other" },
          })),
        );
        const changedOrigin = yield* Effect.flip(
          tasks.update(task.id, (current) => ({
            ...current,
            origin: { kind: "coordination", decisionLogId: "other" },
          })),
        );
        expect(changedOrigin.code).toBe("ImmutableField");
        return { value: yield* tasks.get(task.id), forbidden };
      }),
      directory(),
    );
    expect(Option.isSome(result.value) && result.value.value.title).toBe("50");
    expect(Either.isLeft(result.forbidden) && result.forbidden.left.code).toBe("ImmutableField");
  });

  it("persists conditional transitions and retains immutable decision-log fields during correction", async () => {
    const path = directory();
    await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRegistry;
        const logs = yield* DecisionLog;
        yield* tasks.create(task);
        yield* tasks.transition(task.id, { type: "turn.started" });
        yield* tasks.transition(task.id, {
          type: "request.opened",
          requestId: RequestId.make("r1"),
        });
        yield* tasks.transition(task.id, {
          type: "request.opened",
          requestId: RequestId.make("r2"),
        });
        const partial = yield* tasks.transition(task.id, {
          type: "request.answered",
          requestId: RequestId.make("r1"),
        });
        expect(partial.status).toBe("waiting_user");
        yield* logs.write(log);
        yield* logs.correct(log.id, {
          at: 2,
          kind: "reroute",
          detail: "User selected another bot",
        });
      }),
      path,
    );
    const result = await run(
      Effect.gen(function* () {
        const logs = yield* DecisionLog;
        const tasks = yield* TaskRegistry;
        return { task: yield* tasks.get(task.id), log: yield* logs.get(log.id) };
      }),
      path,
    );
    expect(Option.isSome(result.task) && result.task.value.pendingRequestIds).toEqual(["r2"]);
    expect(Option.isSome(result.log) && result.log.value).toEqual({
      ...log,
      correction: { at: 2, kind: "reroute", detail: "User selected another bot" },
    });
  });

  it("completes execution without losing concurrent corrections or the original decision", async () => {
    const correction = { at: 3, kind: "reroute" as const, detail: "User selected another bot" };
    const execution = { ok: false, error: "Worker failed" };
    const result = await run(
      Effect.gen(function* () {
        const logs = yield* DecisionLog;
        yield* logs.write(log);
        yield* Effect.all([logs.correct(log.id, correction), logs.complete(log.id, execution)], {
          concurrency: "unbounded",
        });
        const missing = yield* Effect.either(logs.complete("missing", execution));
        const invalid = yield* Effect.either(
          logs.complete(log.id, { ok: true, error: 1 } as unknown as LogSchema["execution"]),
        );
        return { record: yield* logs.get(log.id), missing, invalid };
      }),
      directory(),
    );
    expect(Option.isSome(result.record) && result.record.value).toEqual({
      ...log,
      execution,
      correction,
    });
    expect(Either.isLeft(result.missing) && result.missing.left.code).toBe("NotFound");
    expect(Either.isLeft(result.invalid) && result.invalid.left.code).toBe("Validation");
  });

  it("prevents update from bypassing pending-request state transitions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRegistry;
        yield* tasks.create(task);
        yield* tasks.transition(task.id, { type: "turn.started" });
        const inject = yield* Effect.either(
          tasks.update(task.id, (current) => ({
            ...current,
            pendingRequestIds: [RequestId.make("injected")],
          })),
        );
        yield* tasks.transition(task.id, {
          type: "request.opened",
          requestId: RequestId.make("r1"),
        });
        const clear = yield* Effect.either(
          tasks.update(task.id, (current) => ({ ...current, pendingRequestIds: [] })),
        );
        return { inject, clear, current: yield* tasks.get(task.id) };
      }),
      directory(),
    );
    expect(Either.isLeft(result.inject) && result.inject.left.code).toBe("ImmutableField");
    expect(Either.isLeft(result.clear) && result.clear.left.code).toBe("ImmutableField");
    expect(Option.isSome(result.current) && result.current.value.status).toBe("waiting_user");
    expect(Option.isSome(result.current) && result.current.value.pendingRequestIds).toEqual(["r1"]);
  });

  it("rejects corrupt persisted records", async () => {
    const path = directory();
    await run(
      Effect.gen(function* () {
        yield* (yield* MainThread).append(message("bad"));
      }),
      path,
    );
    const db = new DatabaseSync(join(path, "aut.db"));
    db.prepare("UPDATE main_thread_messages SET data = ? WHERE id = ?").run('{"id":"bad"}', "bad");
    db.close();
    const corrupted = await run(
      Effect.gen(function* () {
        return yield* Effect.either((yield* MainThread).get(MessageId.make("bad")));
      }),
      path,
    );
    expect(Either.isLeft(corrupted) && corrupted.left.code).toBe("Validation");
  });

  it.each([0, 1, 2, 3, 99])(
    "refuses unsupported database version %i without rewriting it",
    async (version) => {
      const path = directory();
      const filename = join(path, "aut.db");
      const db = new DatabaseSync(filename);
      db.exec(
        `CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('keep'); PRAGMA user_version = ${version}`,
      );
      db.close();
      const outcome = await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            Effect.succeed(undefined).pipe(Effect.provide(CoreLive({ dataDirectory: path }))),
          ),
        ),
      );
      expect(Either.isLeft(outcome) && outcome.left.code).toBe("Storage");
      const unchanged = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        expect(unchanged.prepare("SELECT value FROM marker").get()?.value).toBe("keep");
        expect(unchanged.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
      } finally {
        unchanged.close();
      }
    },
  );

  it("rejects malformed writes and duplicate IDs without changing earlier rows", async () => {
    const result = await run(
      Effect.gen(function* () {
        const thread = yield* MainThread;
        yield* thread.append(message("same", "original"));
        const duplicate = yield* Effect.either(thread.append(message("same", "replacement")));
        const invalid = yield* Effect.either(thread.append({ ...message("invalid"), at: -1 }));
        const tasks = yield* TaskRegistry;
        const absent = yield* tasks.get(TaskId.make("missing"));
        return { duplicate, invalid, rows: yield* thread.page(), absent };
      }),
      directory(),
    );
    expect(Either.isLeft(result.duplicate)).toBe(true);
    expect(Either.isLeft(result.invalid) && result.invalid.left.code).toBe("Validation");
    expect(result.rows.map((row) => row.text)).toEqual(["original"]);
    expect(Option.isNone(result.absent)).toBe(true);
  });
});

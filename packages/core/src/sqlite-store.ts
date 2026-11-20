import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonResource } from "@aut/protocol";
import { Effect, Exit, Layer, Option, Schema } from "effect";
import { Changes } from "./changes.js";
import { type CoreOptions, resolveDataDirectory } from "./data-directory.js";
import { boundary, CoreError } from "./errors.js";
import {
  type StoreEncodedRecords,
  type StoreRecords,
  type StoreTable,
  storageSchemas,
  storeTables,
} from "./storage-model.js";
import { Store, type StoreTransaction } from "./store.js";

const schemaFor = <K extends StoreTable>(
  table: K,
): Schema.Schema<StoreRecords[K], StoreEncodedRecords[K]> =>
  storageSchemas[table] as unknown as Schema.Schema<StoreRecords[K], StoreEncodedRecords[K]>;

const decode = <K extends StoreTable>(table: K, json: unknown) =>
  Schema.decodeUnknown(Schema.parseJson(schemaFor(table)))(json).pipe(
    Effect.mapError(
      (cause) =>
        new CoreError({
          code: "Validation",
          message: `Invalid stored ${table} value`,
          detail: String(cause),
        }),
    ),
  );

const encode = <K extends StoreTable>(table: K, value: StoreRecords[K]) =>
  Schema.encode(Schema.parseJson(schemaFor(table)))(value).pipe(
    Effect.mapError(
      (cause) =>
        new CoreError({
          code: "Validation",
          message: `Invalid ${table} value`,
          detail: String(cause),
        }),
    ),
  );

const rollback = (db: DatabaseSync) =>
  boundary("Failed to roll back transaction", () => {
    if (db.isTransaction) db.exec("ROLLBACK");
  });

const transact = <A, E, R>(
  db: DatabaseSync,
  body: Effect.Effect<A, E, R>,
  committed: Effect.Effect<void> = Effect.void,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* boundary("Failed to begin transaction", () => db.exec("BEGIN IMMEDIATE"));
      const exit = yield* Effect.exit(restore(body));
      if (Exit.isFailure(exit)) {
        yield* rollback(db);
        return yield* Effect.failCause(exit.cause);
      }
      yield* boundary("Failed to commit transaction", () => db.exec("COMMIT")).pipe(
        Effect.tapError(() => rollback(db)),
      );
      yield* committed;
      return exit.value;
    }),
  );

const databaseVersion = 4;

const initializeDatabase = (db: DatabaseSync) =>
  transact(
    db,
    Effect.gen(function* () {
      const version = yield* boundary(
        "Failed to read database version",
        () => db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (version === databaseVersion) return;
      if (version !== 0)
        return yield* Effect.fail(
          new CoreError({
            code: "Storage",
            message: `Unsupported database schema version: ${String(version)}. Use a new AUT_DATA_DIR for this build.`,
          }),
        );
      const existing = yield* boundary("Failed to inspect unversioned database", () =>
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get(),
      );
      if (existing)
        return yield* Effect.fail(
          new CoreError({
            code: "Storage",
            message:
              "The unversioned database is not empty. Use a new AUT_DATA_DIR for this build.",
          }),
        );
      yield* boundary("Failed to initialize database", () => {
        for (const table of storeTables) {
          db.exec(
            `CREATE TABLE ${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT, data TEXT NOT NULL CHECK(json_valid(data)))`,
          );
          db.exec(`CREATE INDEX ${table}_task_idx ON ${table}(task_id)`);
        }
        db.exec(`
          CREATE INDEX decision_logs_event_ref_idx ON decision_logs(json_extract(data, '$.input.eventRef'));
          CREATE INDEX events_user_idx ON events(seq) WHERE json_extract(data, '$.event.source') = 'user';
          CREATE INDEX messages_card_id_idx ON main_thread_messages(json_extract(data, '$.card.id'))
            WHERE json_extract(data, '$.card.id') IS NOT NULL;
          CREATE INDEX messages_request_idx ON main_thread_messages(json_extract(data, '$.card.requestId'))
            WHERE json_extract(data, '$.card.requestId') IS NOT NULL;
          CREATE INDEX messages_open_task_cards_idx ON main_thread_messages(task_id) WHERE json_extract(data, '$.card.state') = 'open';
          CREATE INDEX session_requests_open_idx ON session_requests(task_id) WHERE json_extract(data, '$.state') = 'open';
          CREATE INDEX tasks_bot_id_idx ON tasks(json_extract(data, '$.botId'));
          PRAGMA user_version = ${databaseVersion};
        `);
      });
    }),
  );

const makeTransaction = (
  db: DatabaseSync,
  written: (table: StoreTable) => void,
): StoreTransaction => {
  // SQL identifiers come exclusively from the fixed internal table catalog.
  const statements = Object.fromEntries(
    storeTables.map((table) => [
      table,
      {
        get: db.prepare(`SELECT data FROM ${table} WHERE id = ?`),
        insert: db.prepare(`INSERT INTO ${table} (id, task_id, data) VALUES (?, ?, ?)`),
        set: db.prepare(
          `INSERT INTO ${table} (id, task_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, data = excluded.data WHERE data IS NOT excluded.data OR task_id IS NOT excluded.task_id`,
        ),
        cursor: db.prepare(`SELECT seq FROM ${table} WHERE id = ?`),
        list: db.prepare(`SELECT data FROM ${table} WHERE seq < ? ORDER BY seq DESC LIMIT ?`),
      },
    ]),
  ) as Record<
    StoreTable,
    {
      get: ReturnType<DatabaseSync["prepare"]>;
      insert: ReturnType<DatabaseSync["prepare"]>;
      set: ReturnType<DatabaseSync["prepare"]>;
      cursor: ReturnType<DatabaseSync["prepare"]>;
      list: ReturnType<DatabaseSync["prepare"]>;
    }
  >;
  const select = <K extends StoreTable>(table: K, clause: string) => {
    const statement = db.prepare(`SELECT data FROM ${table} WHERE ${clause}`);
    return (...parameters: string[]) =>
      boundary(`Failed to query ${table}`, () => statement.all(...parameters)).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(table, row.data))),
      );
  };
  const messagesByIds = select(
    "main_thread_messages",
    "id IN (SELECT value FROM json_each(?)) ORDER BY seq",
  );
  const open = "json_extract(data, '$.state') = 'open'";
  const openRequests = select("session_requests", `${open} ORDER BY seq`);
  const openRequestsByTask = select("session_requests", `task_id = ? AND ${open} ORDER BY seq`);
  const taskForBot = db.prepare(
    "SELECT 1 FROM tasks WHERE json_extract(data, '$.botId') = ? LIMIT 1",
  );
  const forgetCreation = db.prepare("DELETE FROM bot_creations WHERE id = ?");
  const decisionsForEvent = select(
    "decision_logs",
    "json_extract(data, '$.input.eventRef') = ? ORDER BY seq DESC LIMIT 1",
  );
  const write = <K extends StoreTable>(
    table: K,
    value: StoreRecords[K],
    operation: "insert" | "set",
  ) =>
    Effect.gen(function* () {
      const json = yield* encode(table, value);
      const taskId =
        table === "tasks" || table === "sessions"
          ? value.id
          : "taskId" in value
            ? value.taskId
            : null;
      const result = yield* boundary(`Failed to ${operation} ${table}`, () =>
        statements[table][operation].run(value.id, taskId ?? null, json),
      );
      if (Number(result.changes) > 0) written(table);
    });
  return {
    botHasTasks: (id) => boundary("Failed to check bot usage", () => !!taskForBot.get(id)),
    forgetBotCreation: (id) =>
      boundary("Failed to retire bot creation", () => {
        forgetCreation.run(id);
      }),
    messagesByIds: (ids) => messagesByIds(JSON.stringify(ids)),
    messagesByCardId: select("main_thread_messages", "json_extract(data, '$.card.id') = ? LIMIT 2"),
    cardsForRequest: select(
      "main_thread_messages",
      "json_extract(data, '$.card.requestId') = ? ORDER BY seq",
    ),
    openRequests: (id) => (id === undefined ? openRequests() : openRequestsByTask(id)),
    openTaskCards: select(
      "main_thread_messages",
      "task_id = ? AND json_extract(data, '$.card.state') = 'open' ORDER BY seq",
    ),
    userEvents: select("events", "json_extract(data, '$.event.source') = 'user' ORDER BY seq")(),
    latestDecisionForEvent: (ref) =>
      decisionsForEvent(ref).pipe(Effect.map((rows) => Option.fromNullable(rows[0]))),
    get: (table, id) =>
      Effect.gen(function* () {
        const row = yield* boundary(`Failed to read ${table}`, () => statements[table].get.get(id));
        return row ? Option.some(yield* decode(table, row.data)) : Option.none();
      }),
    insert: (table, value) => write(table, value, "insert"),
    set: (table, value) => write(table, value, "set"),
    list: (table, options = {}) =>
      Effect.gen(function* () {
        const limit = options.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit <= 0)
          return yield* Effect.fail(
            new CoreError({
              code: "Validation",
              message: "Page limit must be a positive safe integer",
            }),
          );
        let before = Number.MAX_SAFE_INTEGER;
        if (options.before !== undefined) {
          const cursor = options.before;
          const row = yield* boundary("Failed to resolve pagination cursor", () =>
            statements[table].cursor.get(cursor),
          );
          if (!row)
            return yield* Effect.fail(
              new CoreError({
                code: "NotFound",
                message: `Unknown pagination cursor: ${options.before}`,
              }),
            );
          before = Number(row.seq);
        }
        const rows = yield* boundary(`Failed to list ${table}`, () =>
          statements[table].list.all(before, limit),
        );
        return yield* Effect.forEach(rows.reverse(), (row) => decode(table, row.data));
      }),
  };
};

export const StoreLive = (options: CoreOptions = {}) =>
  Layer.scoped(
    Store,
    Effect.gen(function* () {
      const changes = yield* Changes;
      const written = new Set<StoreTable>();
      const resources: Record<StoreTable, readonly DaemonResource[]> = {
        main_thread_messages: ["messages"],
        tasks: ["tasks"],
        sessions: ["tasks"],
        session_requests: ["requests"],
        events: [],
        decision_logs: [],
        bot_creations: [],
      };
      const directory = resolveDataDirectory(options);
      if (directory.length === 0)
        return yield* Effect.fail(
          new CoreError({ code: "Configuration", message: "Data directory must not be empty" }),
        );
      yield* boundary("Failed to create data directory", () =>
        mkdirSync(directory, { recursive: true, mode: 0o700 }),
      );
      const db = yield* Effect.acquireRelease(
        boundary("Failed to open database", () => new DatabaseSync(join(directory, "aut.db"))),
        (connection) =>
          boundary("Failed to close database", () => connection.close()).pipe(Effect.orDie),
      );
      yield* boundary("Failed to configure database", () =>
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"),
      );
      yield* initializeDatabase(db);
      yield* boundary("Failed to enable database WAL", () => db.exec("PRAGMA journal_mode=WAL"));
      const tx = yield* boundary("Failed to prepare database statements", () =>
        makeTransaction(db, (table) => written.add(table)),
      );
      const semaphore = yield* Effect.makeSemaphore(1);
      return {
        transaction: <A, E, R>(body: (transaction: StoreTransaction) => Effect.Effect<A, E, R>) =>
          semaphore.withPermits(1)(
            Effect.suspend(() => {
              written.clear();
              return transact(
                db,
                Effect.suspend(() => body(tx)),
                Effect.suspend(() =>
                  changes.publish(Array.from(written).flatMap((table) => resources[table])),
                ),
              );
            }),
          ),
      };
    }),
  );

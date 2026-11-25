/** Synthetic integration of the production adapter's native-memory policy. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Queue, Schema, Stream, Take } from "effect";
import { makeCodexAdapter, readCodexDefaults } from "../../packages/adapters/dist/index.js";
import { NodeTransport, type Transport, type TransportFactory } from "../../packages/adapters/dist/codex/transport.js";
import { BotId, type StartSessionInput, TaskId } from "../../packages/protocol/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "aut-memory-adapter-"));
const cwd = join(root, "project");
const sqlite = join(root, "sqlite");
mkdirSync(cwd);
mkdirSync(sqlite);
const output = resolve(process.argv[2] ?? join(root, "result.json"));
const calls: { method: string; mode?: string }[] = [];
const evidence: Record<string, unknown>[] = [];
let opened = 0;
let closed = 0;
let firstTransport: Transport | undefined;
const factory: TransportFactory = {
  open: (options) => Effect.gen(function* () {
    const native = yield* NodeTransport.open(options);
    opened++;
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed++; }));
    firstTransport ??= native;
    return { ...native, request: (method, params) => Effect.gen(function* () {
      const result = yield* native.request(method, params);
      calls.push({ method });
      return result;
    }) };
  }),
};
const identity = (data: unknown) => Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }))(data).threadId;
const mode = (id: string) => {
  const filename = readdirSync(sqlite).find((name) => /^state_.*\.sqlite$/.test(name));
  assert.ok(filename);
  const db = new DatabaseSync(join(sqlite, filename), { readOnly: true });
  try { return (db.prepare("SELECT memory_mode FROM threads WHERE id = ?").get(id) as { memory_mode: string } | undefined)?.memory_mode; }
  finally { db.close(); }
};
const args = ["--enable", "memories", "-c", "memories.use_memories=true", "-c", "memories.generate_memories=true",
  "-c", `sqlite_home=${JSON.stringify(sqlite)}`, "-c", `log_dir=${JSON.stringify(join(root, "logs"))}`];
const result = await Effect.runPromise(Effect.gen(function* () {
  const defaults = yield* readCodexDefaults({ cwd });
  const input: StartSessionInput = {
    taskId: TaskId.make("native-memory-adapter-probe"), model: defaults.model, cwd,
    instructions: "This is a synthetic configuration test. Do not call tools, access files, use external services, ask questions or delegate.", mcpServers: [],
    bot: { id: BotId.make("native-memory-adapter-probe"), name: "Probe", description: "Synthetic test", soul: "", cwd,
      modelSelection: { instanceId: "fixture", model: defaults.model } },
  };
  const adapter = makeCodexAdapter({ args }, factory);
  const cursor = yield* Effect.scoped(Effect.gen(function* () {
    const session = yield* adapter.startSession(input);
    const queue = yield* Stream.toQueue(session.events);
    yield* Effect.yieldNow();
    yield* session.startTurn({ text: "Reply exactly AUT_MEMORY_ADAPTER_OK. Do not use tools or ask questions.", messageIds: [] });
    let completed = false;
    while (!completed) {
      const events = yield* Take.done(yield* Queue.take(queue));
      for (const event of events) {
        if (event.kind === "request.opened" || event.kind === "turn.failed" || event.kind === "process.exited")
          return yield* Effect.fail(new Error(`Unexpected probe event: ${event.kind}`));
        if (event.kind === "turn.completed") {
          assert.ok(event.ok);
          assert.ok(event.finalReport.includes("AUT_MEMORY_ADAPTER_OK"));
          completed = true;
        }
      }
    }
    const id = identity(session.cursor.data);
    assert.equal(mode(id), "disabled");
    evidence.push({ check: "start_with_conflicting_instance_flags", mode: mode(id) });
    assert.ok(firstTransport);
    yield* firstTransport.request("thread/memoryMode/set", { threadId: id, mode: "enabled" });
    assert.equal(mode(id), "enabled");
    return session.cursor;
  }));
  assert.equal(opened, closed);
  yield* Effect.scoped(Effect.gen(function* () {
    const resumed = yield* adapter.resumeSession(cursor, input);
    assert.equal(mode(identity(cursor.data)), "disabled");
    evidence.push({ check: "cold_resume_clears_previous_learning_eligibility", mode: mode(identity(cursor.data)) });
    const fork = yield* resumed.fork();
    assert.equal(mode(identity(fork.cursor.data)), "disabled");
    evidence.push({ check: "fork", mode: mode(identity(fork.cursor.data)) });
  }));
  assert.equal(opened, closed);
  return { model: defaults.model, provider: defaults.provider };
}).pipe(Effect.timeout("120 seconds")));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  cli: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), recordedAt: new Date().toISOString(),
  passed: true, ...result, modelTurnsStarted: 1, opened, closed, evidence, methods: calls.map((call) => call.method),
  scope: "Production adapter; synthetic session and isolated SQLite; cold resume and fork; original Provider and global config retained",
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, passed: true, evidence, opened, closed }));

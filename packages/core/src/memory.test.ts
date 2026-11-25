import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotId,
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_DIRECTORY_MAX_BYTES,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  MEMORY_MAX_SNAPSHOTS,
} from "@aut/protocol";
import { Effect, Layer, Queue } from "effect";
import { afterEach, expect, it } from "vitest";
import { Changes, ChangesLive } from "./changes.js";
import { ConfigStore, ConfigStoreLive } from "./config-store.js";
import { BotMemory, BotMemoryLive } from "./memory.js";

const directories: string[] = [];
const bot = BotId.make("../Bot A");
const other = BotId.make("../bot a");
const fixture = async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-memory-test-"));
  directories.push(dataDirectory);
  const services = BotMemoryLive({ dataDirectory }).pipe(
    Layer.provideMerge(ConfigStoreLive({ dataDirectory })),
    Layer.provideMerge(ChangesLive),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, BotMemory | ConfigStore | Changes>) =>
    Effect.runPromise(effect.pipe(Effect.provide(services)));
  await run(
    Effect.gen(function* () {
      yield* (yield* ConfigStore).writeBots(
        [bot, other].map((id) => ({
          id,
          name: id,
          description: "Fixture",
          soul: "",
          cwd: "/shared/workdir",
          modelSelection: { instanceId: "fixture", model: "fixture" },
        })),
      );
    }),
  );
  return { dataDirectory, run };
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("isolates bots sharing a workdir and persists editable Markdown across service restart", async () => {
  const { dataDirectory, run } = await fixture();
  const result = await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      const first = yield* memory.directory(bot);
      const second = yield* memory.directory(other);
      expect(first).not.toBe(second);
      expect(first).toMatch(/\/memory\/[a-f0-9]{64}$/u);
      expect(first.startsWith(realpathSync(dataDirectory))).toBe(true);
      expect((yield* memory.context(bot)).content).toBe("");
      const saved = yield* memory.write(bot, "knowledge/主题/事实.md", "记忆内容\n");
      expect(saved.bytes).toBe(Buffer.byteLength("记忆内容\n"));
      yield* memory.write(other, "MEMORY.md", "Other bot");
      return { first, second };
    }),
  );
  expect(statSync(join(result.first, "knowledge/主题/事实.md")).mode & 0o777).toBe(0o600);
  const file = await run(
    Effect.flatMap(BotMemory, (memory) => memory.read(bot, "knowledge/主题/事实.md")),
  );
  expect(file.content).toBe("记忆内容\n");
  const listing = await run(Effect.flatMap(BotMemory, (memory) => memory.list(other)));
  expect(listing.files.map((entry) => entry.path)).toEqual(["MEMORY.md"]);
  expect(
    await run(
      Effect.flatMap(BotMemory, (memory) => memory.directory(BotId.make("missing"))).pipe(
        Effect.flip,
      ),
    ),
  ).toMatchObject({ code: "NotFound" });
  expect(existsSync(join(dataDirectory, "aut.db"))).toBe(false);
});

it("snapshots before edits, removal and clear, preserves unknown files, and keeps history read-only", async () => {
  const { run } = await fixture();
  const directory = await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)));
  writeFileSync(join(directory, "unknown.bin"), Buffer.from([0, 255, 42]));
  const latest = await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      yield* memory.write(bot, "MEMORY.md", "Original");
      yield* memory.write(bot, "MEMORY.md", "Changed");
      let listing = yield* memory.list(bot);
      const edited = listing.snapshots[0];
      if (!edited) return yield* Effect.die("Missing edit snapshot");
      expect(edited.reason).toBe("edit");
      expect((yield* memory.read(bot, "MEMORY.md", edited.id)).content).toBe("Original");
      yield* memory.write(bot, "notes/session.md", "Working note");
      yield* memory.remove(bot, "notes/session.md");
      listing = yield* memory.list(bot);
      const removed = listing.snapshots[0];
      if (!removed) return yield* Effect.die("Missing delete snapshot");
      expect(removed.reason).toBe("delete");
      expect((yield* memory.read(bot, "notes/session.md", removed.id)).content).toBe(
        "Working note",
      );
      yield* memory.clear(bot);
      listing = yield* memory.list(bot);
      expect(listing.files.map((entry) => entry.path)).toEqual(["MEMORY.md"]);
      expect((yield* memory.read(bot, "MEMORY.md")).content).toBe("");
      const cleared = listing.snapshots[0];
      if (!cleared) return yield* Effect.die("Missing clear snapshot");
      expect(cleared.reason).toBe("clear");
      expect((yield* memory.read(bot, "MEMORY.md", cleared.id)).content).toBe("Changed");
      const history = yield* memory.list(bot, cleared.id);
      return history.directory;
    }),
  );
  expect(readFileSync(join(latest, "unknown.bin"))).toEqual(Buffer.from([0, 255, 42]));
  expect(existsSync(join(directory, "unknown.bin"))).toBe(false);
});

it("retains the ten latest snapshots even when multiple writes share a clock tick", async () => {
  const { run } = await fixture();
  await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      let first = "";
      let last = "";
      for (let i = 0; i < MEMORY_MAX_SNAPSHOTS + 3; i++) {
        const snapshot = yield* memory.snapshot(bot, "dream");
        if (i === 0) first = snapshot.id;
        last = snapshot.id;
      }
      const listing = yield* memory.list(bot);
      expect(listing.snapshots).toHaveLength(MEMORY_MAX_SNAPSHOTS);
      expect(listing.snapshots[0]?.id).toBe(last);
      expect(listing.snapshots.some((entry) => entry.id === first)).toBe(false);
      expect((yield* memory.read(bot, "MEMORY.md", first).pipe(Effect.flip)).code).toBe("NotFound");
    }),
  );
});

it("rejects traversal, cross-bot snapshots and symlinks without modifying their targets", async () => {
  const { dataDirectory, run } = await fixture();
  const directory = await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)));
  const outside = join(dataDirectory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "Untouched");
  await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      for (const path of [
        "../secret.md",
        "/tmp/secret.md",
        "notes/../MEMORY.md",
        "notes\\secret.md",
        "notes//secret.md",
        "notes/secret.md\0",
      ])
        expect((yield* memory.write(bot, path, "Bad").pipe(Effect.either))._tag).toBe("Left");
      const snapshot = yield* memory.snapshot(other, "dream");
      expect((yield* memory.read(bot, "MEMORY.md", snapshot.id).pipe(Effect.flip)).code).toBe(
        "NotFound",
      );
      expect((yield* memory.list(bot, "../outside").pipe(Effect.either))._tag).toBe("Left");
    }),
  );
  symlinkSync(outside, join(directory, "notes", "escape"));
  await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      for (const operation of [
        memory.read(bot, "notes/escape/secret.md"),
        memory.write(bot, "notes/escape/secret.md", "Bad"),
        memory.snapshot(bot, "dream"),
        memory.clear(bot),
      ])
        expect((yield* operation.pipe(Effect.either))._tag).toBe("Left");
    }),
  );
  expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("Untouched");
  expect(existsSync(join(directory, "MEMORY.md"))).toBe(true);
  expect(
    readdirSync(join(dataDirectory, "memory-history")).every(
      (name) => !name.startsWith(".pending-"),
    ),
  ).toBe(true);
});

it("rejects symlinked memory and snapshot roots and atomically replaces hard-linked documents", async () => {
  const { dataDirectory, run } = await fixture();
  const directory = await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)));
  const external = join(dataDirectory, "external.md");
  writeFileSync(external, "Keep external");
  linkSync(external, join(directory, "knowledge", "linked.md"));
  await run(
    Effect.flatMap(BotMemory, (memory) => memory.write(bot, "knowledge/linked.md", "Local edit")),
  );
  expect(readFileSync(external, "utf8")).toBe("Keep external");
  const snapshot = await run(Effect.flatMap(BotMemory, (memory) => memory.snapshot(bot, "dream")));
  const snapshotDirectory = (
    await run(Effect.flatMap(BotMemory, (memory) => memory.list(bot, snapshot.id)))
  ).directory;
  rmSync(join(snapshotDirectory, "MEMORY.md"));
  symlinkSync(external, join(snapshotDirectory, "MEMORY.md"));
  expect(
    (
      await run(
        Effect.flatMap(BotMemory, (memory) => memory.read(bot, "MEMORY.md", snapshot.id)).pipe(
          Effect.either,
        ),
      )
    )._tag,
  ).toBe("Left");
  rmSync(directory, { recursive: true });
  symlinkSync(dataDirectory, directory);
  expect(
    (await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)).pipe(Effect.either)))
      ._tag,
  ).toBe("Left");
  expect(readFileSync(external, "utf8")).toBe("Keep external");
});

it("bounds UTF-8 writes and full reads while providing an explicit bounded core context", async () => {
  const { run } = await fixture();
  const directory = await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)));
  await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      const text = `${"a".repeat(MEMORY_CONTEXT_MAX_CHARS - 1)}🙂${"b".repeat(20)}`;
      yield* memory.write(bot, "MEMORY.md", text);
      const context = yield* memory.context(bot);
      expect(context.truncated).toBe(true);
      expect(context.content).toBe("a".repeat(MEMORY_CONTEXT_MAX_CHARS - 1));
      expect((yield* memory.read(bot, "MEMORY.md")).content).toBe(text);
      expect(
        (yield* memory
          .write(bot, "notes/huge.md", "中".repeat(MEMORY_FILE_MAX_BYTES / 3 + 1))
          .pipe(Effect.either))._tag,
      ).toBe("Left");
    }),
  );
  writeFileSync(join(directory, "MEMORY.md"), "x".repeat(MEMORY_FILE_MAX_BYTES + 1));
  expect(
    (
      await run(
        Effect.flatMap(BotMemory, (memory) => memory.read(bot, "MEMORY.md")).pipe(Effect.either),
      )
    )._tag,
  ).toBe("Left");
  const context = await run(Effect.flatMap(BotMemory, (memory) => memory.context(bot)));
  expect(context.content).toHaveLength(MEMORY_CONTEXT_MAX_CHARS);
  expect(context.truncated).toBe(true);
});

it("enforces directory count and byte budgets before destructive or snapshot operations", async () => {
  const { run } = await fixture();
  const directory = await run(Effect.flatMap(BotMemory, (memory) => memory.directory(bot)));
  for (let i = 0; i < MEMORY_MAX_FILES; i++) writeFileSync(join(directory, "notes", `${i}.md`), "");
  expect(
    (
      await run(
        Effect.flatMap(BotMemory, (memory) => memory.snapshot(bot, "dream")).pipe(Effect.either),
      )
    )._tag,
  ).toBe("Left");
  expect(
    (await run(Effect.flatMap(BotMemory, (memory) => memory.clear(bot)).pipe(Effect.either)))._tag,
  ).toBe("Left");
  expect(readdirSync(join(directory, "notes"))).toHaveLength(MEMORY_MAX_FILES);
  rmSync(join(directory, "notes"), { recursive: true });
  mkdirSync(join(directory, "notes"));
  writeFileSync(join(directory, "unknown.bin"), Buffer.alloc(MEMORY_DIRECTORY_MAX_BYTES + 1));
  expect(
    (
      await run(
        Effect.flatMap(BotMemory, (memory) => memory.write(bot, "MEMORY.md", "Edit")).pipe(
          Effect.either,
        ),
      )
    )._tag,
  ).toBe("Left");
  expect(readFileSync(join(directory, "MEMORY.md"), "utf8")).toBe("");
});

it("publishes memory changes only after a successful mutation", async () => {
  const { run } = await fixture();
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* (yield* Changes).subscribe;
        const memory = yield* BotMemory;
        yield* memory.write(bot, "MEMORY.md", "Saved");
        expect(yield* Queue.take(queue)).toEqual({ type: "changed", resources: ["memory"] });
        yield* memory.write(bot, "../invalid.md", "Bad").pipe(Effect.either);
        expect(yield* Queue.isEmpty(queue)).toBe(true);
      }),
    ),
  );
});

it("rebuilds the knowledge graph from current files and isolated audit snapshots", async () => {
  const { run } = await fixture();
  await run(
    Effect.gen(function* () {
      const memory = yield* BotMemory;
      yield* memory.write(
        bot,
        "knowledge/release.md",
        "# Release\n\n[Environment](environment.md)",
      );
      yield* memory.write(bot, "knowledge/environment.md", "# Environment");
      yield* memory.write(other, "knowledge/private.md", "# Other bot's private knowledge");
      const before = yield* memory.snapshot(bot, "dream");
      const graph = yield* memory.graph(bot);
      expect(graph.nodes.map((node) => node.title)).toEqual(["Environment", "Release"]);
      expect(graph.edges).toEqual([
        { source: "knowledge/release.md", target: "knowledge/environment.md" },
      ]);
      const directory = yield* memory.directory(bot);
      writeFileSync(
        join(directory, "knowledge/release.md"),
        "# Native change\n\n[Missing](missing.md)",
      );
      const refreshed = yield* memory.graph(bot);
      expect(refreshed.nodes.find((node) => node.path === "knowledge/release.md")?.title).toBe(
        "Native change",
      );
      expect(refreshed.edges).toEqual([]);
      expect(refreshed.brokenLinks).toEqual([
        { source: "knowledge/release.md", target: "knowledge/missing.md" },
      ]);
      expect((yield* memory.graph(bot, before.id)).edges).toEqual(graph.edges);
      expect((yield* memory.graph(other)).nodes.map((node) => node.path)).toEqual([
        "knowledge/private.md",
      ]);
      expect((yield* memory.graph(other, before.id).pipe(Effect.flip)).code).toBe("NotFound");
      expect((yield* memory.graph(BotId.make("unknown")).pipe(Effect.flip)).code).toBe("NotFound");
      expect((yield* memory.graph(bot, "../escape").pipe(Effect.either))._tag).toBe("Left");
      symlinkSync(
        join(directory, "knowledge/environment.md"),
        join(directory, "knowledge/alias.md"),
      );
      expect((yield* memory.graph(bot).pipe(Effect.flip)).code).toBe("InvalidRequest");
    }),
  );
});

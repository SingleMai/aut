import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  BotId,
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_DIRECTORY_MAX_BYTES,
  MEMORY_FILE_MAX_BYTES,
  MEMORY_MAX_FILES,
  MEMORY_MAX_SNAPSHOTS,
  type MemoryFile,
  type MemoryFileEntry,
  type MemoryGraphResponse,
  type MemoryListing,
  MemoryPath,
  MemorySnapshot,
  MemorySnapshotReason,
} from "@aut/protocol";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Changes } from "./changes.js";
import { ConfigStore } from "./config-store.js";
import { type CoreOptions, resolveDataDirectory } from "./data-directory.js";
import { CoreError, validate } from "./errors.js";
import { buildMemoryGraph } from "./memory-graph.js";

type ScannedFile = { readonly path: string; readonly bytes: number; readonly updatedAt: number };
type MemoryContext = {
  readonly directory: string;
  readonly content: string;
  readonly truncated: boolean;
};
const fail = (message: string, code: CoreError["code"] = "Storage") =>
  new CoreError({ code, message });
const io = <A>(run: () => A, message = "The memory files could not be read or saved") =>
  Effect.try({ try: run, catch: () => fail(message) });
const stat = (path: string) => io(() => lstatSync(path, { throwIfNoEntry: false }));
const snapshotId = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const isMemoryPath = Schema.is(MemoryPath);
const safeDirectory = (path: string, create: boolean) =>
  Effect.gen(function* () {
    const current = yield* stat(path);
    if (!current) {
      if (!create)
        return yield* Effect.fail(fail("The memory directory was not found", "NotFound"));
      yield* io(() => mkdirSync(path, { mode: 0o700 }));
    } else if (current.isSymbolicLink() || !current.isDirectory()) {
      return yield* Effect.fail(
        fail("Memory directories must not be symbolic links or files", "InvalidRequest"),
      );
    }
    return path;
  });
const regularFile = (path: string, required = true) =>
  Effect.gen(function* () {
    const current = yield* stat(path);
    if (!current) {
      if (required) return yield* Effect.fail(fail("The memory file was not found", "NotFound"));
      return undefined;
    }
    if (current.isSymbolicLink() || !current.isFile())
      return yield* Effect.fail(fail("Only regular memory files are supported", "InvalidRequest"));
    return current;
  });

/** The API owns paths, not a separate document database or version protocol. */
export class BotMemory extends Context.Tag("aut/BotMemory")<
  BotMemory,
  {
    readonly directory: (botId: BotId) => Effect.Effect<string, CoreError>;
    readonly list: (botId: BotId, snapshotId?: string) => Effect.Effect<MemoryListing, CoreError>;
    readonly graph: (
      botId: BotId,
      snapshotId?: string,
    ) => Effect.Effect<MemoryGraphResponse, CoreError>;
    readonly read: (
      botId: BotId,
      path: string,
      snapshotId?: string,
    ) => Effect.Effect<MemoryFile, CoreError>;
    readonly write: (
      botId: BotId,
      path: string,
      content: string,
    ) => Effect.Effect<MemoryFile, CoreError>;
    readonly remove: (botId: BotId, path: string) => Effect.Effect<void, CoreError>;
    readonly clear: (botId: BotId) => Effect.Effect<void, CoreError>;
    readonly snapshot: (
      botId: BotId,
      reason: MemorySnapshotReason,
    ) => Effect.Effect<MemorySnapshot, CoreError>;
    readonly context: (botId: BotId) => Effect.Effect<MemoryContext, CoreError>;
  }
>() {}

const targetPath = (root: string, path: string, createParents = false) =>
  Effect.gen(function* () {
    yield* validate(MemoryPath, path);
    yield* safeDirectory(root, false);
    const parts = path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      yield* safeDirectory(parent, createParents);
    }
    const target = join(root, path);
    yield* regularFile(target, false);
    return target;
  });
const scan = (root: string) =>
  Effect.gen(function* () {
    const files: ScannedFile[] = [];
    let total = 0;
    const walk = (relative: string): Effect.Effect<void, CoreError> =>
      Effect.gen(function* () {
        const directory = join(root, relative);
        yield* safeDirectory(directory, false);
        const names = yield* io(() => readdirSync(directory));
        for (const name of names.sort()) {
          const path = relative ? `${relative}/${name}` : name;
          const absolute = join(root, path);
          const entry = yield* stat(absolute);
          if (!entry) return yield* Effect.fail(fail("A memory file changed while listing"));
          if (entry.isSymbolicLink())
            return yield* Effect.fail(
              fail("Memory directories must not contain symbolic links", "InvalidRequest"),
            );
          if (entry.isDirectory()) yield* walk(path);
          else {
            if (!entry.isFile())
              return yield* Effect.fail(
                fail("Only regular memory files are supported", "InvalidRequest"),
              );
            total += entry.size;
            if (files.length >= MEMORY_MAX_FILES || total > MEMORY_DIRECTORY_MAX_BYTES)
              return yield* Effect.fail(
                fail("The memory directory exceeds its file count or size limit", "InvalidRequest"),
              );
            files.push({
              path,
              bytes: entry.size,
              updatedAt: Math.max(0, Math.floor(entry.mtimeMs)),
            });
          }
        }
      });
    yield* walk("");
    return files;
  });
const readBytes = (path: string, maximum: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* regularFile(path);
      const descriptor = yield* Effect.acquireRelease(
        io(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
        (fd) => io(() => closeSync(fd)).pipe(Effect.ignore),
      );
      const opened = yield* io(() => fstatSync(descriptor));
      if (!opened.isFile() || opened.size > maximum)
        return yield* Effect.fail(fail("The memory file exceeds its size limit", "InvalidRequest"));
      const buffer = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = yield* io(() =>
          readSync(descriptor, buffer, offset, buffer.length - offset, offset),
        );
        if (read === 0) break;
        offset += read;
      }
      const ended = yield* io(() => fstatSync(descriptor));
      if (offset !== opened.size || ended.size !== opened.size)
        return yield* Effect.fail(fail("The memory file changed while reading; refresh and retry"));
      return {
        bytes: buffer.subarray(0, offset),
        updatedAt: Math.max(0, Math.floor(ended.mtimeMs)),
      };
    }),
  );
const writeAtomic = (path: string, content: Uint8Array | string) =>
  Effect.gen(function* () {
    const temporary = join(dirname(path), `.memory-${randomUUID()}.tmp`);
    yield* Effect.acquireUseRelease(
      io(() => openSync(temporary, "wx", 0o600)),
      (fd) =>
        Effect.gen(function* () {
          yield* io(() => {
            writeFileSync(fd, content);
            fsyncSync(fd);
          });
          yield* regularFile(path, false);
          yield* io(() => renameSync(temporary, path));
        }),
      (fd) =>
        io(() => {
          closeSync(fd);
          rmSync(temporary, { force: true });
        }).pipe(Effect.ignore),
    );
  });

export const BotMemoryLive = (options: CoreOptions = {}) =>
  Layer.effect(
    BotMemory,
    Effect.gen(function* () {
      const config = yield* ConfigStore;
      const changes = yield* Changes;
      const serial = yield* Effect.makeSemaphore(1);
      const dataDirectory = resolve(resolveDataDirectory(options));
      yield* io(() => mkdirSync(dataDirectory, { recursive: true, mode: 0o700 }));
      const dataRoot = yield* io(() => realpathSync(dataDirectory));
      const roots = (botId: BotId) =>
        Effect.gen(function* () {
          yield* validate(BotId, botId);
          if (!(yield* config.readBots).some((bot) => bot.id === botId))
            return yield* Effect.fail(fail("The bot was not found", "NotFound"));
          const key = createHash("sha256").update(botId).digest("hex");
          yield* safeDirectory(join(dataRoot, "memory"), true);
          yield* safeDirectory(join(dataRoot, "memory-history"), true);
          const directory = yield* safeDirectory(join(dataRoot, "memory", key), true);
          const history = yield* safeDirectory(join(dataRoot, "memory-history", key), true);
          yield* safeDirectory(join(directory, "knowledge"), true);
          yield* safeDirectory(join(directory, "notes"), true);
          const core = join(directory, "MEMORY.md");
          if (!(yield* regularFile(core, false)))
            yield* io(() => writeFileSync(core, "", { flag: "wx", mode: 0o600 }));
          return { directory, history };
        });
      const snapshots = (history: string) =>
        Effect.gen(function* () {
          yield* safeDirectory(history, false);
          const entries: MemorySnapshot[] = [];
          for (const id of yield* io(() => readdirSync(history))) {
            if (!Schema.is(snapshotId)(id)) continue;
            const directory = yield* safeDirectory(join(history, id), false);
            const metadata = join(directory, "snapshot.json");
            const data = yield* readBytes(metadata, 4096);
            const value = yield* validate(
              Schema.parseJson(MemorySnapshot),
              data.bytes.toString("utf8"),
            );
            if (value.id !== id)
              return yield* Effect.fail(
                fail("The memory snapshot identity is invalid", "Validation"),
              );
            entries.push(value);
          }
          return entries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        });
      const selectDirectory = (paths: { directory: string; history: string }, id?: string) =>
        Effect.gen(function* () {
          if (id === undefined) return paths.directory;
          yield* validate(snapshotId, id);
          const selected = (yield* snapshots(paths.history)).find((entry) => entry.id === id);
          if (!selected)
            return yield* Effect.fail(fail("The memory snapshot was not found", "NotFound"));
          return yield* safeDirectory(join(paths.history, id, "files"), false);
        });
      const capture = (
        paths: { directory: string; history: string },
        reason: MemorySnapshotReason,
      ) =>
        Effect.gen(function* () {
          yield* validate(MemorySnapshotReason, reason);
          const files = yield* scan(paths.directory);
          const previous = yield* snapshots(paths.history);
          const snapshot: MemorySnapshot = {
            id: randomUUID(),
            createdAt: Math.max(yield* Clock.currentTimeMillis, (previous[0]?.createdAt ?? -1) + 1),
            reason,
          };
          const staging = join(paths.history, `.pending-${snapshot.id}`);
          yield* Effect.acquireUseRelease(
            io(() => mkdirSync(staging, { mode: 0o700 })),
            () =>
              Effect.gen(function* () {
                const saved = join(staging, "files");
                yield* io(() => mkdirSync(saved, { mode: 0o700 }));
                let bytes = 0;
                for (const file of files) {
                  const source = join(paths.directory, file.path);
                  const value = yield* readBytes(source, MEMORY_DIRECTORY_MAX_BYTES - bytes);
                  bytes += value.bytes.length;
                  const destination = join(saved, file.path);
                  yield* io(() =>
                    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }),
                  );
                  yield* io(() =>
                    writeFileSync(destination, value.bytes, { flag: "wx", mode: 0o600 }),
                  );
                }
                yield* io(() =>
                  writeFileSync(join(staging, "snapshot.json"), JSON.stringify(snapshot), {
                    flag: "wx",
                    mode: 0o600,
                  }),
                );
                yield* io(() => renameSync(staging, join(paths.history, snapshot.id)));
              }),
            () => io(() => rmSync(staging, { recursive: true, force: true })).pipe(Effect.ignore),
          );
          for (const old of (yield* snapshots(paths.history)).slice(MEMORY_MAX_SNAPSHOTS)) {
            const directory = yield* safeDirectory(join(paths.history, old.id), false);
            yield* io(() => rmSync(directory, { recursive: true }));
          }
          return snapshot;
        });
      const readDocument = (root: string, path: string) =>
        Effect.gen(function* () {
          const target = yield* targetPath(root, path);
          const value = yield* readBytes(target, MEMORY_FILE_MAX_BYTES);
          const content = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(value.bytes),
            catch: () => fail("The memory document is not valid UTF-8 text", "InvalidRequest"),
          });
          return { path, content, bytes: value.bytes.length, updatedAt: value.updatedAt };
        });
      const changed = <A>(effect: Effect.Effect<A, CoreError>) =>
        Effect.uninterruptible(effect.pipe(Effect.tap(() => changes.publish(["memory"]))));
      return {
        directory: (botId) =>
          serial.withPermits(1)(roots(botId).pipe(Effect.map((value) => value.directory))),
        list: (botId, id) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              const paths = yield* roots(botId);
              const directory = yield* selectDirectory(paths, id);
              const files: MemoryFileEntry[] = (yield* scan(directory)).filter((file) =>
                isMemoryPath(file.path),
              );
              return { botId, directory, files, snapshots: yield* snapshots(paths.history) };
            }),
          ),
        graph: (botId, id) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              const paths = yield* roots(botId);
              const directory = yield* selectDirectory(paths, id);
              const entries = (yield* scan(directory)).filter(
                (file) => isMemoryPath(file.path) && file.path.startsWith("knowledge/"),
              );
              const documents = yield* Effect.forEach(entries, (file) =>
                readDocument(directory, file.path),
              );
              return yield* io(
                () => buildMemoryGraph(botId, documents),
                "The knowledge graph could not be read",
              );
            }),
          ),
        read: (botId, path, id) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              const paths = yield* roots(botId);
              return yield* readDocument(yield* selectDirectory(paths, id), path);
            }),
          ),
        write: (botId, path, content) =>
          serial.withPermits(1)(
            changed(
              Effect.gen(function* () {
                yield* validate(MemoryPath, path);
                yield* validate(Schema.String, content);
                const bytes = Buffer.byteLength(content, "utf8");
                if (bytes > MEMORY_FILE_MAX_BYTES)
                  return yield* Effect.fail(
                    fail("The memory file exceeds 256 KiB", "InvalidRequest"),
                  );
                const paths = yield* roots(botId);
                const files = yield* scan(paths.directory);
                const previous = files.find((file) => file.path === path);
                if (
                  (!previous && files.length >= MEMORY_MAX_FILES) ||
                  files.reduce((sum, file) => sum + file.bytes, 0) -
                    (previous?.bytes ?? 0) +
                    bytes >
                    MEMORY_DIRECTORY_MAX_BYTES
                )
                  return yield* Effect.fail(
                    fail(
                      "The memory directory exceeds its file count or size limit",
                      "InvalidRequest",
                    ),
                  );
                const target = yield* targetPath(paths.directory, path, true);
                yield* capture(paths, "edit");
                yield* writeAtomic(target, content);
                return yield* readDocument(paths.directory, path);
              }),
            ),
          ),
        remove: (botId, path) =>
          serial.withPermits(1)(
            changed(
              Effect.gen(function* () {
                const paths = yield* roots(botId);
                const target = yield* targetPath(paths.directory, path);
                yield* regularFile(target);
                yield* capture(paths, "delete");
                yield* io(() => rmSync(target));
              }),
            ),
          ),
        clear: (botId) =>
          serial.withPermits(1)(
            changed(
              Effect.gen(function* () {
                const paths = yield* roots(botId);
                yield* capture(paths, "clear");
                for (const name of yield* io(() => readdirSync(paths.directory)))
                  yield* io(() =>
                    rmSync(join(paths.directory, name), { recursive: true, force: true }),
                  );
                yield* roots(botId);
              }),
            ),
          ),
        snapshot: (botId, reason) =>
          serial.withPermits(1)(
            changed(
              Effect.gen(function* () {
                return yield* capture(yield* roots(botId), reason);
              }),
            ),
          ),
        context: (botId) =>
          serial.withPermits(1)(
            Effect.scoped(
              Effect.gen(function* () {
                const { directory } = yield* roots(botId);
                const path = yield* targetPath(directory, "MEMORY.md");
                const descriptor = yield* Effect.acquireRelease(
                  io(() =>
                    openSync(
                      path,
                      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
                    ),
                  ),
                  (fd) => io(() => closeSync(fd)).pipe(Effect.ignore),
                );
                const value = yield* io(() => fstatSync(descriptor));
                if (!value.isFile())
                  return yield* Effect.fail(
                    fail("The core memory is not a regular file", "InvalidRequest"),
                  );
                const bytes = Buffer.alloc(Math.min(value.size, MEMORY_CONTEXT_MAX_CHARS * 4 + 4));
                let offset = 0;
                while (offset < bytes.length) {
                  const length = yield* io(() =>
                    readSync(descriptor, bytes, offset, bytes.length - offset, offset),
                  );
                  if (length === 0) break;
                  offset += length;
                }
                const text = new StringDecoder("utf8").write(bytes.subarray(0, offset));
                let content = text.slice(0, MEMORY_CONTEXT_MAX_CHARS);
                if (/[\uD800-\uDBFF]$/u.test(content)) content = content.slice(0, -1);
                return {
                  directory,
                  content,
                  truncated: offset < value.size || text.length > content.length,
                };
              }),
            ),
          ),
      };
    }),
  );

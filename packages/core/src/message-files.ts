// Local-link extraction and file-handle validation adapted from OpenMausBot server/message-file.ts,
// commit 4250c53a3acb0218870a4041101cb08b116160ce, Apache-2.0; see NOTICE.
// aut adds Effect services, authenticated IDs and immutable report snapshots.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_DRAFT_TTL_MS,
  FILE_MAX_BYTES,
  FILE_MAX_COUNT,
  FileId,
  FileIds,
  type FileIssue,
  type MessageFile as FileRecord,
  FileUploadInput,
  MessageFile,
  Timestamp,
} from "@aut/protocol";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { type CoreOptions, resolveDataDirectory } from "./data-directory.js";
import { CoreError, validate } from "./errors.js";
import { containedBy, mimeFor, safeDisplayName } from "./openmausbot/message-file.js";
import { Store } from "./store.js";

const failure = (message: string, code: CoreError["code"] = "Storage") =>
  new CoreError({ code, message });
const io = <A>(operation: () => Promise<A>, message = "The file could not be read or saved") =>
  Effect.tryPromise({ try: operation, catch: () => failure(message) });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const DraftLease = Schema.Struct({ expiresAt: Timestamp });
const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const optionalText = (path: string) =>
  io(async () => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  });

type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
// Adapted from OpenMausBot's messageFileTargets: rendered local links only, never prose or code.
export const reportFileTargets = (text: string): string[] => {
  const tree: Node = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const visit = (node: Node, f: (node: Node) => void) => {
    if (["code", "inlineCode", "html"].includes(node.type)) return;
    f(node);
    for (const child of node.children ?? []) visit(child, f);
  };
  visit(tree, (node) => {
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
  });
  const targets: string[] = [];
  visit(tree, (node) => {
    const url = ["link", "image"].includes(node.type)
      ? node.url
      : ["linkReference", "imageReference"].includes(node.type) && node.identifier
        ? definitions.get(node.identifier)
        : undefined;
    if (
      url &&
      !url.startsWith("#") &&
      !url.startsWith("//") &&
      (!/^[a-z][a-z\d+.-]*:/i.test(url) || /^file:/i.test(url))
    )
      targets.push(url);
  });
  return [...new Set(targets)];
};

export interface ReportFiles {
  readonly files?: readonly FileRecord[];
  readonly fileIssues?: readonly FileIssue[];
}
export class MessageFiles extends Context.Tag("aut/MessageFiles")<
  MessageFiles,
  {
    readonly upload: (input: FileUploadInput) => Effect.Effect<FileRecord, CoreError>;
    readonly get: (id: string) => Effect.Effect<FileRecord, CoreError>;
    readonly read: (id: string) => Effect.Effect<{ file: FileRecord; base64: string }, CoreError>;
    readonly withFiles: <A, E, R>(
      ids: readonly string[],
      body: (files: readonly FileRecord[]) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CoreError, R>;
    readonly renew: (ids: readonly string[]) => Effect.Effect<void, CoreError>;
    readonly discard: (id: string) => Effect.Effect<boolean, CoreError>;
    readonly collect: Effect.Effect<{ readonly removed: number }, CoreError>;
    readonly captureReport: (
      report: string,
      cwd: string,
      eventId: string,
    ) => Effect.Effect<ReportFiles>;
  }
>() {}

/** Reads the exact opened handle after canonicalizing twice, following OpenMausBot's message-file boundary. */
const readWithin = (path: string, root: string, hidden = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const canonicalRoot = yield* io(() => realpath(root));
      const canonicalBefore = yield* io(() => realpath(path), "The linked file is unavailable");
      if (
        !containedBy(canonicalRoot, canonicalBefore) ||
        (!hidden &&
          relative(canonicalRoot, canonicalBefore)
            .split(/[\\/]/)
            .some((part) => part.startsWith(".")))
      )
        return yield* Effect.fail(
          failure("The linked file is outside the task's visible working files", "InvalidRequest"),
        );
      const handle = yield* Effect.acquireRelease(
        io(() =>
          open(canonicalBefore, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
        ),
        (handle) => io(() => handle.close()).pipe(Effect.ignore),
      );
      const before = yield* io(() => handle.stat());
      if (!before.isFile() || before.size > FILE_MAX_BYTES)
        return yield* Effect.fail(
          failure("Only regular files up to 20 MiB can be attached", "InvalidRequest"),
        );
      const canonicalAfter = yield* io(() => realpath(path));
      const after = yield* io(() => stat(canonicalAfter));
      if (
        canonicalBefore !== canonicalAfter ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        return yield* Effect.fail(failure("The linked file changed while opening", "Conflict"));
      // Bound reads even if a producer grows the file after the stat check.
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = yield* io(() => handle.read(buffer, offset, buffer.length - offset, offset));
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const end = yield* io(() => handle.stat());
      if (offset !== before.size || end.size !== before.size || end.mtimeMs !== before.mtimeMs)
        return yield* Effect.fail(
          failure("The linked file changed while reading; deliver it again", "Conflict"),
        );
      return buffer.subarray(0, offset);
    }),
  );

export const MessageFilesLive = (options: CoreOptions = {}) =>
  Layer.effect(
    MessageFiles,
    Effect.gen(function* () {
      const store = yield* Store;
      const root = resolve(resolveDataDirectory(options), "files");
      const serial = yield* Effect.makeSemaphore(1);
      const get = (id: string) =>
        Effect.gen(function* () {
          yield* validate(FileId, id);
          const file = yield* io(
            () => readFile(join(root, id, "metadata.json"), "utf8"),
            "The saved file is unavailable",
          ).pipe(Effect.flatMap((text) => validate(Schema.parseJson(MessageFile), text)));
          if (
            file.id !== id ||
            file.path !== join(root, id, file.name) ||
            ["metadata.json", "draft.json"].includes(file.name)
          )
            return yield* Effect.fail(failure("The file metadata is invalid", "Validation"));
          return file;
        });
      const read = (id: string) =>
        Effect.gen(function* () {
          const file = yield* get(id);
          const content = yield* readWithin(file.path, join(root, id), true);
          if (content.length !== file.size || hash(content) !== file.sha256)
            return yield* Effect.fail(
              failure("The saved file no longer matches its snapshot", "Conflict"),
            );
          return { file, base64: content.toString("base64") };
        });
      const lease = (id: string) =>
        optionalText(join(root, id, "draft.json")).pipe(
          Effect.flatMap((text) =>
            text === undefined
              ? Effect.succeed(undefined)
              : validate(Schema.parseJson(DraftLease), text),
          ),
        );
      const renewOne = (id: string) =>
        Effect.gen(function* () {
          if (!(yield* lease(id))) return;
          const expiresAt = (yield* Clock.currentTimeMillis) + FILE_DRAFT_TTL_MS;
          const temporary = join(root, id, `.lease-${randomUUID()}`);
          yield* io(() =>
            writeFile(temporary, JSON.stringify({ expiresAt }), { flag: "wx", mode: 0o600 }),
          );
          yield* io(() => rename(temporary, join(root, id, "draft.json"))).pipe(
            Effect.ensuring(io(() => rm(temporary, { force: true })).pipe(Effect.ignore)),
          );
        });
      const withFiles = <A, E, R>(
        ids: readonly string[],
        body: (files: readonly FileRecord[]) => Effect.Effect<A, E, R>,
      ) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            yield* validate(FileIds, ids);
            return yield* body(yield* Effect.forEach(ids, get));
          }),
        );
      const discard = (id: string) =>
        serial.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* validate(FileId, id);
              const metadata = yield* optionalText(join(root, id, "metadata.json"));
              if (metadata === undefined) return false;
              yield* get(id);
              if (!(yield* lease(id))) return false;
              const referenced = yield* store.transaction((tx) => tx.referencedFileIds([id]));
              if (referenced.length) return false;
              yield* io(() => rm(join(root, id), { recursive: true, force: true }));
              return true;
            }),
          ),
        );
      const collect = serial.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const entries = yield* io(async () => {
              try {
                return await readdir(root, { withFileTypes: true });
              } catch (error) {
                if (missing(error)) return [];
                throw error;
              }
            });
            const candidates: string[] = [];
            let removed = 0;
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
              if (/^\.upload-[a-f0-9-]{36}$/.test(entry.name)) {
                const info = yield* io(() => lstat(join(root, entry.name)));
                if (info.mtimeMs < now - FILE_DRAFT_TTL_MS) {
                  yield* io(() => rm(join(root, entry.name), { recursive: true, force: true }));
                  removed++;
                }
              } else if (Schema.is(FileId)(entry.name)) {
                const draft = yield* Effect.gen(function* () {
                  yield* get(entry.name);
                  return yield* lease(entry.name);
                }).pipe(Effect.option);
                if (draft._tag === "Some" && draft.value && draft.value.expiresAt <= now)
                  candidates.push(entry.name);
              }
            }
            if (candidates.length) {
              const referenced = new Set(
                yield* store.transaction((tx) => tx.referencedFileIds(candidates)),
              );
              for (const id of candidates)
                if (!referenced.has(id)) {
                  yield* io(() => rm(join(root, id), { recursive: true, force: true }));
                  removed++;
                }
            }
            return { removed };
          }),
        ),
      );
      const save = (id: string, name: string, bytes: Uint8Array, draft = false) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            if (bytes.length > FILE_MAX_BYTES)
              return yield* Effect.fail(failure("The file exceeds 20 MiB", "InvalidRequest"));
            const safe = safeDisplayName(name);
            const filename = ["metadata.json", "draft.json", ".", ".."].includes(safe)
              ? `file-${safe.replaceAll(".", "_")}`
              : safe;
            const file = yield* validate(MessageFile, {
              id,
              name: filename,
              mime: mimeFor(filename),
              size: bytes.length,
              sha256: hash(bytes),
              path: join(root, id, filename),
            });
            const existing = yield* get(id).pipe(Effect.option);
            if (existing._tag === "Some") return existing.value;
            const temporary = join(root, `.upload-${randomUUID()}`);
            yield* io(() => mkdir(root, { recursive: true, mode: 0o700 }));
            return yield* Effect.acquireUseRelease(
              io(() => mkdir(temporary, { mode: 0o700 })),
              () =>
                Effect.gen(function* () {
                  yield* io(() =>
                    writeFile(join(temporary, filename), bytes, { flag: "wx", mode: 0o400 }),
                  );
                  const json = yield* Schema.encode(Schema.parseJson(MessageFile))(file).pipe(
                    Effect.mapError(() => failure("Invalid file metadata")),
                  );
                  yield* io(() =>
                    writeFile(join(temporary, "metadata.json"), json, { flag: "wx", mode: 0o400 }),
                  );
                  if (draft) {
                    const expiresAt = (yield* Clock.currentTimeMillis) + FILE_DRAFT_TTL_MS;
                    yield* io(() =>
                      writeFile(join(temporary, "draft.json"), JSON.stringify({ expiresAt }), {
                        flag: "wx",
                        mode: 0o600,
                      }),
                    );
                  }
                  yield* io(() => rename(temporary, join(root, id)));
                  return file;
                }),
              () => io(() => rm(temporary, { force: true, recursive: true })).pipe(Effect.ignore),
            );
          }),
        );
      return {
        get: (id) => serial.withPermits(1)(get(id)),
        read: (id) => serial.withPermits(1)(read(id)),
        withFiles,
        discard,
        collect,
        renew: (ids) => withFiles(ids, () => Effect.forEach(ids, renewOne, { discard: true })),
        upload: (input) =>
          Effect.gen(function* () {
            const checked = yield* validate(FileUploadInput, input);
            const bytes = Buffer.from(checked.base64, "base64");
            if (bytes.toString("base64") !== checked.base64)
              return yield* Effect.fail(failure("Invalid base64 file data", "Validation"));
            return yield* save(hash(randomUUID()), checked.name, bytes, true);
          }),
        captureReport: (report, cwd, eventId) =>
          Effect.gen(function* () {
            const targets = reportFileTargets(report);
            const files: FileRecord[] = [];
            const fileIssues: FileIssue[] = [];
            for (const target of targets.slice(0, FILE_MAX_COUNT)) {
              const result = yield* Effect.gen(function* () {
                const id = hash(`${eventId}\0${target}`);
                const saved = yield* get(id).pipe(Effect.option);
                if (saved._tag === "Some") return saved.value;
                const path = yield* Effect.try({
                  try: () =>
                    /^file:/i.test(target)
                      ? fileURLToPath(target)
                      : decodeURIComponent(target.split(/[?#]/, 1)[0] ?? ""),
                  catch: () => failure("The file link is invalid", "InvalidRequest"),
                });
                if (!path || path.includes("\0"))
                  return yield* Effect.fail(failure("The file link is invalid", "InvalidRequest"));
                const absolute = isAbsolute(path) ? path : resolve(cwd, path);
                return yield* save(id, basename(path), yield* readWithin(absolute, cwd));
              }).pipe(Effect.either);
              if (result._tag === "Right") files.push(result.right);
              else fileIssues.push({ name: safeDisplayName(target), message: result.left.message });
            }
            if (targets.length > FILE_MAX_COUNT)
              fileIssues.push({
                name: "Additional files",
                message:
                  "Only the first 16 linked files were saved; deliver the remaining files separately.",
              });
            return {
              ...(files.length ? { files } : {}),
              ...(fileIssues.length ? { fileIssues } : {}),
            };
          }),
      };
    }),
  );

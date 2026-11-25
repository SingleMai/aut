import { Either, Schema } from "effect";
import { BotId, NonEmptyString, NonNegativeInteger, Timestamp } from "./common.js";
import { Trigger } from "./domain.js";

export const MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const MEMORY_DIRECTORY_MAX_BYTES = 16 * 1024 * 1024;
export const MEMORY_MAX_FILES = 512;
export const MEMORY_CONTEXT_MAX_CHARS = 8000;
export const MEMORY_MAX_SNAPSHOTS = 10;

export const MemoryPath = NonEmptyString.pipe(
  Schema.maxLength(512),
  Schema.filter(
    (path) =>
      path === "MEMORY.md" ||
      (/^(?:knowledge|notes)\/.+\.md$/u.test(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
  ),
);
export const MemoryFileEntry = Schema.Struct({
  path: MemoryPath,
  bytes: NonNegativeInteger,
  updatedAt: Timestamp,
});
export type MemoryFileEntry = typeof MemoryFileEntry.Type;
export const MemoryFile = Schema.Struct({
  ...MemoryFileEntry.fields,
  content: Schema.String,
});
export type MemoryFile = typeof MemoryFile.Type;
export const MemorySnapshotReason = Schema.Literal("edit", "delete", "clear", "dream");
export type MemorySnapshotReason = typeof MemorySnapshotReason.Type;
export const MemorySnapshot = Schema.Struct({
  id: NonEmptyString,
  createdAt: Timestamp,
  reason: MemorySnapshotReason,
});
export type MemorySnapshot = typeof MemorySnapshot.Type;
export const MemoryListing = Schema.Struct({
  botId: BotId,
  directory: NonEmptyString,
  files: Schema.Array(MemoryFileEntry),
  snapshots: Schema.Array(MemorySnapshot),
});
export type MemoryListing = typeof MemoryListing.Type;
export const BotMemoryResponse = Schema.Struct({
  ...MemoryListing.fields,
  dream: Schema.NullOr(Trigger),
});
export type BotMemoryResponse = typeof BotMemoryResponse.Type;
export const MemoryListInput = Schema.Struct({ snapshot: Schema.optional(NonEmptyString) });
export const MemoryReadInput = Schema.Struct({
  path: MemoryPath,
  snapshot: Schema.optional(NonEmptyString),
});
export const MemoryWriteInput = Schema.Struct({
  path: MemoryPath,
  content: Schema.String.pipe(Schema.maxLength(MEMORY_FILE_MAX_BYTES)),
});
export type MemoryWriteInput = typeof MemoryWriteInput.Type;
export const MemoryFileResponse = Schema.Struct({ file: MemoryFile });

const KnowledgePath = MemoryPath.pipe(Schema.filter((path) => path.startsWith("knowledge/")));
export const MemoryGraphNode = Schema.Struct({
  path: KnowledgePath,
  title: NonEmptyString,
  updatedAt: Timestamp,
});
export type MemoryGraphNode = typeof MemoryGraphNode.Type;
export const MemoryGraphEdge = Schema.Struct({ source: KnowledgePath, target: KnowledgePath });
export type MemoryGraphEdge = typeof MemoryGraphEdge.Type;
export const MemoryGraphResponse = Schema.Struct({
  botId: BotId,
  nodes: Schema.Array(MemoryGraphNode),
  edges: Schema.Array(MemoryGraphEdge),
  brokenLinks: Schema.Array(MemoryGraphEdge),
});
export type MemoryGraphResponse = typeof MemoryGraphResponse.Type;

const validMemoryPath = Schema.is(MemoryPath);
const scheme = /^[a-z][a-z\d+.-]*:/iu;

/** Resolve document-relative links without granting navigation outside this bot's memory. */
export const resolveMemoryLink = (sourcePath: string, href: string): string | undefined => {
  if (!validMemoryPath(sourcePath)) return undefined;
  const raw = href.trim().split(/[?#]/u)[0] ?? "";
  if (!raw) return undefined;
  const decoded = Either.try(() => decodeURIComponent(raw));
  if (Either.isLeft(decoded)) return undefined;
  const relative = decoded.right;
  if (
    relative.startsWith("/") ||
    ["", ".", ".."].includes(relative.split("/").at(-1) ?? "") ||
    relative.includes("\\") ||
    scheme.test(relative) ||
    Array.from(relative).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return undefined;
  const parts = sourcePath.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else if (part !== "." && part !== "") parts.push(part);
  }
  const target = parts.join("/");
  return validMemoryPath(target) ? target : undefined;
};

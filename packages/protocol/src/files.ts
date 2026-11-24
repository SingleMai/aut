import { Schema } from "effect";
import { NonEmptyString, NonNegativeInteger, uniqueBy } from "./common.js";

export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const FILE_MAX_COUNT = 16;
export const FILE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FILE_DRAFT_RENEW_MS = 5 * 60 * 1000;
export const FILE_BODY_LIMIT = Math.ceil(FILE_MAX_BYTES / 3) * 4 + 8192;
export const FileId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export type FileId = typeof FileId.Type;
export const FileIds = Schema.Array(FileId).pipe(
  Schema.maxItems(FILE_MAX_COUNT),
  Schema.filter((values) => new Set(values).size === values.length),
);
export const MessageFile = Schema.Struct({
  id: FileId,
  name: NonEmptyString.pipe(
    Schema.maxLength(180),
    Schema.filter(
      (name) =>
        !name.includes("/") &&
        !name.includes("\\") &&
        [...name].every((character) => character.charCodeAt(0) >= 32),
    ),
  ),
  mime: NonEmptyString,
  size: NonNegativeInteger.pipe(Schema.lessThanOrEqualTo(FILE_MAX_BYTES)),
  sha256: FileId,
  path: NonEmptyString.pipe(Schema.pattern(/^\//)),
});
export type MessageFile = typeof MessageFile.Type;
export const MessageFileList = Schema.Array(MessageFile).pipe(
  Schema.maxItems(FILE_MAX_COUNT),
  Schema.filter((values) => uniqueBy(values, (value) => value.id)),
);
export const FileIssue = Schema.Struct({ name: NonEmptyString, message: NonEmptyString });
export type FileIssue = typeof FileIssue.Type;
export const FileIssues = Schema.Array(FileIssue).pipe(Schema.maxItems(FILE_MAX_COUNT + 1));
export const FileUploadInput = Schema.Struct({
  name: NonEmptyString.pipe(Schema.maxLength(1024)),
  base64: Schema.String.pipe(
    Schema.maxLength(Math.ceil(FILE_MAX_BYTES / 3) * 4),
    Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export type FileUploadInput = typeof FileUploadInput.Type;
export const FileResponse = Schema.Struct({ file: MessageFile });
export const FileLeaseInput = Schema.Struct({ ids: FileIds });
export const FileReleaseResponse = Schema.Struct({ released: Schema.Boolean });
export const FileContentResponse = Schema.Struct({ file: MessageFile, base64: Schema.String });
export type FileContentResponse = typeof FileContentResponse.Type;

// Adapted from OpenMausBot server/message-file.ts, commit 4250c53a3acb0218870a4041101cb08b116160ce.
// Apache-2.0; see NOTICE. aut uses bounded snapshots and Effect for I/O; only macOS paths are supported.
import { extname, isAbsolute, relative, sep } from "node:path";

function utf8Prefix(value: string, maximumBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximumBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Below common 255-byte name limits, with room for the app's temporary-file suffix. */
function boundedDisplayName(value: string, maximumBytes = 180): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const extension = extname(value);
  const extensionBytes = Buffer.byteLength(extension);
  if (extension && extensionBytes <= 32 && extensionBytes < maximumBytes) {
    const stem = utf8Prefix(value.slice(0, -extension.length), maximumBytes - extensionBytes);
    if (stem) return `${stem}${extension}`;
  }
  return utf8Prefix(value, maximumBytes) || "download";
}

export function safeDisplayName(value: string): string {
  const portable = value.split(/[\\/]/).at(-1) ?? "";
  const clean = Array.from(portable, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const invalid =
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    return invalid ? "_" : character;
  })
    .join("")
    .trim();
  return boundedDisplayName(clean || "download");
}

export function containedBy(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

export function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".tsv":
      return "text/tab-separated-values; charset=utf-8";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".rtf":
      return "application/rtf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".m4v":
      return "video/x-m4v";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".opus":
      return "audio/opus";
    case ".flac":
      return "audio/flac";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".odt":
      return "application/vnd.oasis.opendocument.text";
    case ".ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case ".odp":
      return "application/vnd.oasis.opendocument.presentation";
    // Archives are typed by name only and stay downloads: never previewed, never unpacked. foo.tar.gz is a .gz.
    case ".zip":
      return "application/zip";
    case ".rar":
      return "application/vnd.rar";
    case ".7z":
      return "application/x-7z-compressed";
    case ".tar":
      return "application/x-tar";
    case ".gz":
      return "application/gzip";
    case ".tgz":
      return "application/x-compressed-tar";
    case ".bz2":
      return "application/x-bzip2";
    case ".xz":
      return "application/x-xz";
    default:
      return "application/octet-stream";
  }
}

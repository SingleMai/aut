import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FileContentResponse, RemoteId } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { type BrowserWindow, dialog, shell } from "electron";
import { FileAction, type FileActionResult } from "./bridge.js";
import type { DesktopConnection } from "./connection.js";
import { DesktopError } from "./desktop-error.js";

const failure = () => new DesktopError({ code: "File", message: "无法读取或保存文件，请重试。" });
export const nativeFileAction = (
  input: unknown,
  window: BrowserWindow,
  service: Pick<typeof DesktopConnection.Service, "request">,
  remote?: { readonly directory: string; readonly hostId: string },
): Effect.Effect<FileActionResult> =>
  Effect.gen(function* () {
    const action = yield* Schema.decodeUnknown(FileAction)(input, { onExcessProperty: "error" });
    const result = yield* service.request({ method: "GET", path: `/v1/files/${action.id}` });
    if (!result.ok) return { ok: false, error: result.error.message };
    const { file, base64 } = yield* Schema.decodeUnknown(FileContentResponse)(result.data);
    const bytes = Buffer.from(base64, "base64");
    let localPath = file.path;
    if (remote) {
      yield* Schema.decodeUnknown(RemoteId)(remote.hostId);
      if (
        file.id !== action.id ||
        bytes.length !== file.size ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      )
        return { ok: false, error: "文件校验未通过，请重新获取。" };
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Sanitize remote filenames before writing a local cache file.
      const name = basename(file.name).replace(/[\x00-\x1f\x7f/\\:]/g, "_");
      const directory = join(remote.directory, remote.hostId, action.id);
      localPath = join(directory, !name || name === "." || name === ".." ? "file" : name);
      const target = localPath;
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = join(directory, `.aut-cache-${randomUUID()}`);
          try {
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await rename(temporary, target);
          } finally {
            await rm(temporary, { force: true });
          }
        },
        catch: failure,
      });
    }
    if (action.action === "save") {
      const destination = yield* Effect.tryPromise({
        try: () =>
          dialog.showSaveDialog(window, { defaultPath: file.name, buttonLabel: "保存副本" }),
        catch: failure,
      });
      if (destination.canceled || !destination.filePath) return { ok: true, cancelled: true };
      const target = resolve(destination.filePath);
      const parent = yield* Effect.tryPromise({
        try: () => realpath(dirname(target)),
        catch: failure,
      });
      const snapshotRoot = yield* Effect.tryPromise({
        try: () => realpath(remote ? remote.directory : dirname(dirname(file.path))),
        catch: failure,
      });
      const suffix = relative(snapshotRoot, parent);
      // Resolve directory aliases as well; neither file contents nor manifests may be replaced.
      if (suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix)))
        return { ok: false, error: "请选择其他位置保存副本。" };
      const temporary = join(parent, `.aut-save-${randomUUID()}`);
      yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            try {
              await writeFile(temporary, bytes, {
                flag: "wx",
                mode: 0o600,
              });
              await rename(temporary, target);
            } finally {
              await rm(temporary, { force: true });
            }
          },
          catch: failure,
        }),
      );
    } else if (action.action === "reveal")
      yield* Effect.try({ try: () => shell.showItemInFolder(localPath), catch: failure });
    else yield* Effect.try({ try: () => window.previewFile(localPath, file.name), catch: failure });
    return { ok: true };
  }).pipe(Effect.catchAll(() => Effect.succeed({ ok: false, error: "无法操作文件，请重试。" })));

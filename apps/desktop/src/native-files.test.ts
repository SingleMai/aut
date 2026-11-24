import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { type BrowserWindow, dialog, shell } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopConnection } from "./connection.js";
import { nativeFileAction } from "./native-files.js";

vi.mock("electron", () => ({
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));
const window = { previewFile: vi.fn() } as unknown as BrowserWindow;
const file = {
  id: "a".repeat(64),
  name: "report.md",
  mime: "text/plain",
  size: 8,
  sha256: "b".repeat(64),
  path: "/tmp/snapshot/report.md",
};
const request = vi.fn(() =>
  Effect.succeed({ ok: true as const, data: { file, base64: "VE9UQUw9NDI=" } }),
);
const service: typeof DesktopConnection.Service = { request, notices: Stream.empty };
const paths: string[] = [];
beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), "aut-native-snapshot-"));
  paths.push(directory);
  const snapshot = join(directory, "files", file.id);
  mkdirSync(snapshot, { recursive: true });
  file.path = join(snapshot, file.name);
  writeFileSync(file.path, "TOTAL=42");
});
afterEach(() => {
  vi.clearAllMocks();
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("saves validated daemon bytes at the chosen destination and leaves cancellation untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aut-save-file-"));
  paths.push(directory);
  const target = join(directory, "copy.md");
  vi.mocked(dialog.showSaveDialog)
    .mockResolvedValueOnce({ canceled: true, filePath: "" })
    .mockResolvedValueOnce({ canceled: false, filePath: target });
  expect(
    await Effect.runPromise(nativeFileAction({ id: file.id, action: "save" }, window, service)),
  ).toEqual({ ok: true, cancelled: true });
  expect(
    await Effect.runPromise(nativeFileAction({ id: file.id, action: "save" }, window, service)),
  ).toEqual({ ok: true });
  expect(readFileSync(target, "utf8")).toBe("TOTAL=42");
  expect(request).toHaveBeenLastCalledWith({ method: "GET", path: `/v1/files/${file.id}` });
});

it("rejects arbitrary renderer paths and prevents saving over the retained snapshot", async () => {
  expect(
    (
      await Effect.runPromise(
        nativeFileAction({ id: "../../private", action: "reveal" }, window, service),
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await Effect.runPromise(
        nativeFileAction({ id: file.id, action: "reveal", path: "/private/file" }, window, service),
      )
    ).ok,
  ).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: file.path });
  expect(
    (await Effect.runPromise(nativeFileAction({ id: file.id, action: "save" }, window, service)))
      .ok,
  ).toBe(false);
  await Effect.runPromise(nativeFileAction({ id: file.id, action: "reveal" }, window, service));
  expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file.path);
  await Effect.runPromise(nativeFileAction({ id: file.id, action: "preview" }, window, service));
  expect(window.previewFile).toHaveBeenCalledExactlyOnceWith(file.path, file.name);
});

it("rejects snapshot directory aliases and leaves targets unchanged when atomic replacement fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aut-save-alias-"));
  paths.push(directory);
  const alias = join(directory, "snapshot-alias");
  symlinkSync(join(file.path, ".."), alias);
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
    canceled: false,
    filePath: join(alias, "metadata.json"),
  });
  expect(
    (await Effect.runPromise(nativeFileAction({ id: file.id, action: "save" }, window, service)))
      .ok,
  ).toBe(false);
  const target = join(directory, "existing-directory");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "keep");
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: target });
  expect(
    (await Effect.runPromise(nativeFileAction({ id: file.id, action: "save" }, window, service)))
      .ok,
  ).toBe(false);
  expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  expect(readdirSync(directory).some((name) => name.startsWith(".aut-save-"))).toBe(false);
});

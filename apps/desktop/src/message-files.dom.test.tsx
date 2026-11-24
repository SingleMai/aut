// @vitest-environment happy-dom
import type { MessageFile } from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { useFileDrafts } from "./file-drafts.js";
import { FileCard } from "./message-files.js";

const file: MessageFile = {
  id: "a".repeat(64),
  name: "report.md",
  mime: "text/markdown; charset=utf-8",
  size: 8,
  sha256: "b".repeat(64),
  path: "/tmp/files/report.md",
};
beforeEach(() => {
  vi.spyOn(desktopApi, "keepFiles").mockReturnValue(Effect.succeed({ accepted: true }));
  vi.spyOn(desktopApi, "discardFile").mockReturnValue(Effect.succeed({ released: true }));
  vi.stubGlobal("aut", {});
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    Object.defineProperty(this, "result", { value: "data:text/plain;base64,VE9UQUw9NDI=" });
    this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function DraftProbe({
  capture,
  inheritedCount,
}: {
  capture: (value: ReturnType<typeof useFileDrafts>) => void;
  inheritedCount: number;
}) {
  capture(useFileDrafts(vi.fn(), inheritedCount));
  return null;
}
function draftView(inheritedCount = 0) {
  let current: ReturnType<typeof useFileDrafts> | undefined;
  const view = renderView(
    <DraftProbe
      inheritedCount={inheritedCount}
      capture={(value) => {
        current = value;
      }}
    />,
  );
  const get = () => {
    if (!current) throw new Error("Draft hook not mounted");
    return current;
  };
  return { ...view, get };
}

it("keeps a failed draft for retry and clears only the files in the submitted message", async () => {
  const upload = vi
    .spyOn(desktopApi, "uploadFile")
    .mockReturnValueOnce(Effect.fail(new UiError({ message: "Connection lost" })))
    .mockReturnValue(Effect.succeed({ file }));
  const view = draftView();
  const source = new File(["TOTAL=42"], "report.md");
  await act(async () => view.get().add([source]));
  expect(view.get().entries[0]?.status).toBe("failed");
  const failed = view.get().entries[0];
  if (!failed) throw new Error("Missing failed draft");
  await act(async () => view.get().retry(failed));
  expect(view.get().entries[0]?.status).toBe("ready");
  expect(upload).toHaveBeenLastCalledWith({ name: "report.md", base64: "VE9UQUw9NDI=" });
  const submitted = view.get().entries.map((entry) => entry.key);
  await act(async () => view.get().add([new File(["new"], "later.txt")]));
  await act(async () => view.get().clear(submitted));
  expect(view.get().entries.map((entry) => entry.source.name)).toEqual(["later.txt"]);
});

it("counts quoted files toward the message attachment limit", async () => {
  const upload = vi.spyOn(desktopApi, "uploadFile").mockReturnValue(Effect.succeed({ file }));
  const view = draftView(14);
  await act(async () =>
    view.get().add([new File(["a"], "a.txt"), new File(["b"], "b.txt"), new File(["c"], "c.txt")]),
  );
  expect(view.get().entries).toHaveLength(2);
  expect(upload).toHaveBeenCalledTimes(2);
});

it("does not resurrect a removed upload when its request completes later", async () => {
  const pending = Effect.runSync(Deferred.make<{ file: MessageFile }, UiError>());
  vi.spyOn(desktopApi, "uploadFile").mockReturnValue(Deferred.await(pending));
  const view = draftView();
  await act(async () => view.get().add([new File(["pending"], "report.md")]));
  const entry = view.get().entries[0];
  if (!entry) throw new Error("Missing pending draft");
  await act(async () => view.get().remove(entry.key));
  await act(async () => {
    await Effect.runPromise(Deferred.succeed(pending, { file }));
  });
  expect(view.get().entries).toEqual([]);
  expect(desktopApi.discardFile).toHaveBeenCalledWith(file.id);
});

it("renews open drafts, releases removed drafts, and keeps submitted files on unmount", async () => {
  vi.spyOn(desktopApi, "uploadFile").mockReturnValue(Effect.succeed({ file }));
  const view = draftView();
  await act(async () => view.get().add([new File(["a"], "a.txt")]));
  expect(desktopApi.keepFiles).toHaveBeenCalledWith([file.id]);
  const entry = view.get().entries[0];
  if (!entry) throw new Error("Missing draft");
  await act(async () => view.get().remove(entry.key));
  expect(desktopApi.discardFile).toHaveBeenCalledTimes(1);
  await act(async () => view.get().add([new File(["b"], "b.txt")]));
  await act(async () => view.get().clear(view.get().entries.map((entry) => entry.key)));
  view.dispose();
  expect(desktopApi.discardFile).toHaveBeenCalledTimes(1);
});

it("retries failed preview reads and sends only the saved identity to native actions", async () => {
  const getFile = vi
    .spyOn(desktopApi, "getFile")
    .mockReturnValueOnce(Effect.fail(new UiError({ message: "Temporary read failure" })))
    .mockReturnValue(Effect.succeed({ file, base64: "VE9UQUw9NDI=" }));
  const fileAction = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, cancelled: true })
    .mockResolvedValue({ ok: true });
  vi.stubGlobal("aut", { fileAction });
  const view = renderView(<FileCard file={file} flash={vi.fn()} />);
  const preview = view.element.querySelector<HTMLButtonElement>('[aria-label="预览 report.md"]');
  await act(async () => preview?.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Temporary read failure");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="alert"] button')?.click(),
  );
  expect(document.querySelector(".file-preview-text")?.textContent).toBe("TOTAL=42");
  expect(getFile).toHaveBeenCalledTimes(2);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.click());
  const save = view.element.querySelector<HTMLButtonElement>('[aria-label="另存为 report.md"]');
  await act(async () => save?.click());
  expect(save?.textContent).toContain("另存为");
  await act(async () => save?.click());
  expect(save?.textContent).toContain("已保存");
  expect(fileAction).toHaveBeenLastCalledWith({ action: "save", id: file.id });
});

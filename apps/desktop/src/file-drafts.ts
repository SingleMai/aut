import {
  FILE_DRAFT_RENEW_MS,
  FILE_MAX_BYTES,
  FILE_MAX_COUNT,
  type MessageFile,
} from "@aut/protocol";
import { Effect, Fiber, Schedule } from "effect";
import { useEffect, useRef, useState } from "react";
import { desktopApi, UiError } from "./api.js";
import { t } from "./i18n.js";
import { type Flash, runUi } from "./ui/use-action.js";

export const fileBase64 = (file: File) =>
  Effect.async<string, UiError>((resume) => {
    const reader = new FileReader();
    reader.onload = () =>
      resume(
        typeof reader.result === "string"
          ? Effect.succeed(reader.result.slice(reader.result.indexOf(",") + 1))
          : Effect.fail(new UiError({ message: t.fileReadFailed })),
      );
    reader.onerror = () => resume(Effect.fail(new UiError({ message: t.fileReadFailed })));
    reader.onabort = reader.onerror;
    reader.readAsDataURL(file);
    return Effect.sync(() => {
      reader.onload = reader.onerror = reader.onabort = null;
      if (reader.readyState === 1) reader.abort();
    });
  });
export interface FileDraft {
  readonly key: string;
  readonly source: File;
  readonly status: "uploading" | "ready" | "failed";
  readonly file?: MessageFile;
  readonly error?: string;
}
const releaseDraft = (id: string) => Effect.runFork(desktopApi.discardFile(id).pipe(Effect.ignore));
export function useFileDrafts(flash: Flash, inheritedCount = 0) {
  const [entries, setEntries] = useState<readonly FileDraft[]>([]);
  const current = useRef(entries);
  const jobs = useRef(new Set<Fiber.RuntimeFiber<unknown, never>>());
  const update = (f: (value: readonly FileDraft[]) => readonly FileDraft[]) => {
    current.current = f(current.current);
    setEntries(current.current);
  };
  useEffect(
    () => () => {
      for (const fiber of jobs.current) Effect.runFork(Fiber.interrupt(fiber));
      for (const entry of current.current) if (entry.file) releaseDraft(entry.file.id);
    },
    [],
  );
  const leaseIds = entries.flatMap((entry) => (entry.file ? [entry.file.id] : [])).join(",");
  useEffect(() => {
    if (!leaseIds) return;
    const fiber = Effect.runFork(
      desktopApi
        .keepFiles(leaseIds.split(","))
        .pipe(Effect.ignore, Effect.repeat({ schedule: Schedule.spaced(FILE_DRAFT_RENEW_MS) })),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [leaseIds]);
  const upload = (entry: FileDraft) => {
    update((values) =>
      values.map((value) =>
        value.key === entry.key
          ? { key: entry.key, source: entry.source, status: "uploading" }
          : value,
      ),
    );
    const fiber = runUi(
      fileBase64(entry.source).pipe(
        Effect.flatMap((base64) => desktopApi.uploadFile({ name: entry.source.name, base64 })),
        Effect.tap(({ file }) =>
          Effect.sync(() => {
            if (!current.current.some((value) => value.key === entry.key)) {
              releaseDraft(file.id);
              return;
            }
            update((values) =>
              values.map((value) =>
                value.key === entry.key ? { ...entry, status: "ready", file } : value,
              ),
            );
          }),
        ),
        Effect.catchAll((error) =>
          Effect.sync(() =>
            update((values) =>
              values.map((value) =>
                value.key === entry.key
                  ? { ...entry, status: "failed", error: error.message }
                  : value,
              ),
            ),
          ),
        ),
      ),
      flash,
    );
    jobs.current.add(fiber);
    fiber.addObserver(() => jobs.current.delete(fiber));
  };
  return {
    entries,
    add: (files: Iterable<File>) => {
      for (const source of files) {
        if (current.current.length + inheritedCount >= FILE_MAX_COUNT) {
          flash(t.fileCountLimit);
          break;
        }
        if (source.size > FILE_MAX_BYTES) {
          flash(`${source.name}：${t.fileSizeLimit}`);
          continue;
        }
        const entry: FileDraft = { key: crypto.randomUUID(), source, status: "uploading" };
        update((values) => [...values, entry]);
        upload(entry);
      }
    },
    retry: upload,
    remove: (key: string) => {
      const entry = current.current.find((value) => value.key === key);
      if (entry?.file) releaseDraft(entry.file.id);
      update((values) => values.filter((value) => value.key !== key));
    },
    clear: (keys: readonly string[]) =>
      update((values) => values.filter((value) => !keys.includes(value.key))),
  };
}

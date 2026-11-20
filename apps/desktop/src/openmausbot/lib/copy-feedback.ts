// Copied from OpenMausBot src/lib/copy-text.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0; see NOTICE.
// aut uses the Web Clipboard API in the local, secure Electron page.
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyResult = "copied" | "empty" | "failed";
export type CopyFeedback = "idle" | "copied" | "failed";

export const COPY_FEEDBACK_MS = 1200;

/** Bounds a web write that never settles; Chromium rejects an unfocused write at once. */
export const WEB_WRITE_TIMEOUT_MS = 3000;

function writeWeb(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WEB_WRITE_TIMEOUT_MS);
    try {
      if (!navigator.clipboard?.writeText) return finish(false);
      Promise.resolve(navigator.clipboard.writeText(text)).then(
        () => finish(true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}

export async function copyText(text: string): Promise<CopyResult> {
  return !text ? "empty" : (await writeWeb(text)) ? "copied" : "failed";
}
interface CopyFeedbackOptions {
  copy: (text: string) => Promise<CopyResult>;
  onChange: (state: CopyFeedback) => void;
  resetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createCopyFeedback({
  copy,
  onChange,
  resetMs = COPY_FEEDBACK_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: CopyFeedbackOptions) {
  let pending = false;
  let disposed = false;
  let timer: unknown;

  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  return {
    async click(text: string): Promise<CopyResult | "busy"> {
      if (pending) return "busy";
      pending = true;
      let result: CopyResult;
      try {
        result = await copy(text);
      } catch {
        result = "failed";
      } finally {
        pending = false;
      }
      if (disposed || result === "empty") return result;
      clear();
      onChange(result === "copied" ? "copied" : "failed");
      timer = setTimer(() => {
        timer = undefined;
        onChange("idle");
      }, resetMs);
      return result;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

export function useCopyFeedback(
  text: string,
  write: (text: string) => Promise<CopyResult> = copyText,
) {
  const [state, setState] = useState<CopyFeedback>("idle");
  const controller = useRef<ReturnType<typeof createCopyFeedback> | null>(null);
  useEffect(() => {
    const next = createCopyFeedback({ copy: write, onChange: setState });
    controller.current = next;
    return () => {
      next.dispose();
      controller.current = null;
    };
  }, [write]);
  const copy = useCallback(() => void controller.current?.click(text), [text]);
  return { state, copy };
}

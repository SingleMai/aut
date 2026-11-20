// Extracted from OpenMausBot src/lib/transcript-follow.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Anchor lookup uses daemon message IDs. Every loaded row is persisted, including IDs beginning with live:.
/**
 * Whether the transcript keeps its live end in view. `atEnd` only matters once released: while following, the
 * transcript is at its end by definition.
 */
export type TranscriptFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TranscriptFollowEvent =
  /** The person moved the transcript away from where it follows: a scroll up, a scroll key, a scrollbar grab. */
  | { readonly type: "navigated" }
  /** The person asked for the end: they sent a message, pressed "latest", or pulled down at the end. */
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TranscriptFollow = { mode: "following" };

export function initialTranscriptFollow(followEnd: boolean): TranscriptFollow {
  return followEnd ? FOLLOWING : { mode: "released", atEnd: false };
}

export function transitionTranscriptFollow(
  state: TranscriptFollow,
  event: TranscriptFollowEvent,
): TranscriptFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // A scroll key pressed at the end stays released until the transcript has left the end and come back.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, every streamed chunk leaves the end band for a frame before the follow scroll catches up.
      return state.mode === "released" && state.atEnd ? { mode: "released", atEnd: false } : state;
  }
}

export function wantsJumpToLatest(state: TranscriptFollow): boolean {
  return state.mode === "released" && !state.atEnd;
}

/** A row's box: transcript rows are `display: contents`, so their own box is empty and their content's is used. */
function rowBox(row: Element): { top: number; bottom: number } {
  const own = row.getBoundingClientRect();
  if (
    own.height > 0 ||
    typeof document === "undefined" ||
    typeof document.createRange !== "function"
  )
    return own;
  const range = document.createRange();
  range.selectNodeContents(row);
  return range.getBoundingClientRect();
}

const ROW_SELECTOR = "[data-message-id]";

/** The first saved row at the top of the view, and how far above the view's top its own top lies. */
export function topRow(
  scroller: HTMLElement,
  transcript: HTMLElement,
): { rowId: string; offsetWithinRow: number } | null {
  if (typeof transcript.querySelectorAll !== "function") return null;
  const top = scroller.getBoundingClientRect().top;
  for (const row of Array.from(transcript.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const rowId = row.dataset.messageId;
    if (!rowId) continue;
    const box = rowBox(row);
    if (box.bottom > top) return { rowId, offsetWithinRow: top - box.top };
  }
  return null;
}

/** The scrollTop that puts `rowId` back where `topRow` found it, or undefined when the row is not drawn. */
export function rowScrollTop(
  scroller: HTMLElement,
  transcript: HTMLElement,
  rowId: string,
  offsetWithinRow: number,
): number | undefined {
  if (typeof transcript.querySelectorAll !== "function") return undefined;
  const row = Array.from(transcript.querySelectorAll<HTMLElement>(ROW_SELECTOR)).find(
    (candidate) => candidate.dataset.messageId === rowId,
  );
  if (!row) return undefined;
  const target =
    scroller.scrollTop + rowBox(row).top - scroller.getBoundingClientRect().top + offsetWithinRow;
  return Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
}

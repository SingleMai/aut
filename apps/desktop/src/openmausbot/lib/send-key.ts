// Extracted from OpenMausBot src/lib/send-key.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// aut uses the Enter mode from ADR-0034.
type SendKey = "enter" | "shift-enter" | "mod-enter";

/** isComposing, or keyCode 229: WebKit delivers the confirming Enter after compositionend. */
export function imeComposing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function sendsMessage(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode"
  >,
  mode: SendKey,
): boolean {
  if (event.key !== "Enter" || imeComposing(event)) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return mode === "enter" ? !event.shiftKey : mode === "shift-enter" && event.shiftKey;
}

// Extracted from OpenMausBot src/lib/replies.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Only plain message text enters the preview. The desktop protocol has no attachment or citation markers.
export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function escapeCancelsReply(
  event: { key: string; isComposing?: boolean },
  { replying, recording }: { replying: boolean; recording: boolean },
): boolean {
  return event.key === "Escape" && replying && !recording && !event.isComposing;
}

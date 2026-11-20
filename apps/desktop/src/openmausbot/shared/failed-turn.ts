// Copied from OpenMausBot (Apache-2.0), packages/phone-protocol/src/failed-turn.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Extracted failedTurnCause and its constant verbatim; unrelated row creation omitted. See NOTICE.
const MARKER = "error:";

export function failedTurnCause(name: string): string | null {
  return name.startsWith(MARKER) ? name.slice(MARKER.length).trim() : null;
}

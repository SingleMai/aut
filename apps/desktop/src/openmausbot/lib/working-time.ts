// Copied from OpenMausBot (Apache-2.0), src/lib/working-time.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Imports and UI-only types adapted for aut; behavior retained. See NOTICE.
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// Copied from OpenMausBot (Apache-2.0), src/lib/transcript-derivations.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Extracted localDay verbatim; unrelated transcript store derivations omitted. See NOTICE.
export function localDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

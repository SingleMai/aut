// Copied from OpenMausBot (Apache-2.0), shared/client-cancel.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Only the stopped activity marker is used by the aut renderer. See NOTICE.

export function isStoppedTurnName(name: string): boolean {
  return name.startsWith("stopped:");
}

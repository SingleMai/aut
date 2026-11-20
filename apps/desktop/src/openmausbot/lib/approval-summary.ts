// biome-ignore-all lint/style/noNonNullAssertion: Preserve upstream index and optional-field guards.
// Copied from OpenMausBot (Apache-2.0), src/lib/approval-summary.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Extracted composioActionPhrase and its constant verbatim; approval UI omitted. See NOTICE.
/** Composio names its tools TOOLKIT_ACTION_WORDS, all upper case. */
const COMPOSIO_TOOL = /^[A-Z][A-Z0-9]+_([A-Z0-9_]+)$/;

export function composioActionPhrase(tool: string): string | undefined {
  const match = COMPOSIO_TOOL.exec(tool);
  if (!match) return undefined;
  return match[1]!.replace(/_+/g, " ").trim().toLowerCase() || undefined;
}

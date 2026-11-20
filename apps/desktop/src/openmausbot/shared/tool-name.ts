// Copied from OpenMausBot (Apache-2.0), shared/tool-name.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Imports and UI-only types adapted for aut; behavior retained. See NOTICE.
// A tool chip's display title is not a tool identity: Codex and ACP agents title
// a command chip with the command line itself. Anything that counts or groups
// tool calls needs the identity instead.

/** The generic identity every command-titled chip counts under. */
export const SHELL_TOOL = "shell";

/** A tool name that is itself a command line rather than a bare tool name
 * such as `Bash`. Whitespace or a slash: no provider names a tool that way,
 * and every shell command has one by the time it carries an argument or a
 * path. */
export function nameIsCommand(name: string): boolean {
  return /[\s/]/.test(name);
}

/** What a tool chip should be counted as. Command-titled chips collapse to
 * one `shell` bucket: keyed on the raw command they never aggregate (a turn
 * that ran one tool twelve times reads as twelve tools), and the raw title
 * is unredacted — unlike `tool.summary`, which drivers bound and redact. */
export function toolIdentity(name: string): string {
  return nameIsCommand(name) ? SHELL_TOOL : name;
}

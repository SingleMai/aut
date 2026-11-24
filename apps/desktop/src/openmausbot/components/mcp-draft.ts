// Adapted from OpenMausBot src/components/mcp-draft.ts at
// 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. Apache-2.0; see NOTICE.
// aut maps current server records and retains saved credential references only in draft state.
import type { McpServer } from "@aut/protocol";
import { gapIn, type PastedGap, type PastedMcpServer } from "../lib/mcp-paste.js";

export interface SecretRow {
  id: number;
  name: string;
  value: string;
  savedValue?: string;
  gap?: PastedGap;
}
export interface McpDraft {
  id: number;
  name: string;
  transport: "stdio" | "remote";
  command: string;
  args: string;
  cwd: string;
  env: SecretRow[];
  type: "http" | "sse";
  url: string;
  urlGap?: PastedGap;
  headers: SecretRow[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthSecretRef?: string;
  oauthForgetSecret: boolean;
}

let rowIds = 0;
export function secretRow(row: Omit<SecretRow, "id"> = { name: "", value: "" }): SecretRow {
  return { id: ++rowIds, ...row };
}
export function emptyDraft(): McpDraft {
  return {
    id: ++rowIds,
    name: "",
    transport: "remote",
    command: "",
    args: "",
    cwd: "",
    env: [secretRow()],
    type: "http",
    url: "",
    headers: [secretRow()],
    oauthClientId: "",
    oauthClientSecret: "",
    oauthForgetSecret: false,
  };
}
const savedRows = (values: Readonly<Record<string, string>> = {}) => {
  const rows = Object.entries(values).map(([name, savedValue]) =>
    secretRow({ name, value: "", savedValue }),
  );
  return rows.length ? rows : [secretRow()];
};
export function draftFor(server: McpServer): McpDraft {
  return server.transport === "stdio"
    ? {
        ...emptyDraft(),
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args.join("\n"),
        cwd: server.cwd ?? "",
        env: savedRows(server.env),
      }
    : {
        ...emptyDraft(),
        name: server.name,
        type: server.transport,
        url: server.url,
        headers: savedRows(server.headers),
        oauthClientId: server.oauth?.clientId ?? "",
        ...(server.oauth?.clientSecretRef ? { oauthSecretRef: server.oauth.clientSecretRef } : {}),
      };
}
export function draftFromPaste(server: PastedMcpServer): McpDraft {
  const rows = (values: readonly Omit<SecretRow, "id">[]) =>
    values.length ? values.map(secretRow) : [secretRow()];
  return server.transport === "remote"
    ? {
        ...emptyDraft(),
        name: server.name,
        type: server.type,
        url: server.url,
        ...(server.urlGap ? { urlGap: server.urlGap } : {}),
        headers: rows(server.headers),
        oauthClientId: server.oauthClientId ?? "",
      }
    : {
        ...emptyDraft(),
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args.join("\n"),
        env: rows(server.env),
        cwd: "cwd" in server && typeof server.cwd === "string" ? server.cwd : "",
      };
}
export function rowValue(row: SecretRow): string {
  const typed = row.value.trim();
  if (!row.gap || !typed) return row.value;
  const { before, after } = row.gap;
  if (before.trim() && typed.toLowerCase().startsWith(before.trim().toLowerCase())) return typed;
  return `${before}${typed}${after}`;
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Error text identifies a field, never a credential value. */
export function rowsBody(
  rows: readonly SecretRow[],
  kind: "header" | "env",
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = kind === "header" ? rowValue(row).trim() : rowValue(row);
    if (!name && !value && !row.savedValue) continue;
    if (!name) return { ok: false, error: "请填写凭据名称。" };
    if (!(kind === "header" ? HEADER_NAME : ENV_NAME).test(name))
      return { ok: false, error: `名称格式不正确：${name}` };
    const canonical = kind === "header" ? name.toLowerCase() : name;
    if (names.has(canonical)) return { ok: false, error: `名称重复：${name}` };
    names.add(canonical);
    const resolved = value || row.savedValue;
    if (!resolved || gapIn(resolved)) return { ok: false, error: `请填写 ${name} 的真实值。` };
    Object.defineProperty(values, name, { value: resolved, enumerable: true });
  }
  return { ok: true, values };
}
export function parseMcpArguments(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

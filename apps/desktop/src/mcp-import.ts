import { McpServerInput } from "@aut/protocol";
import { Effect } from "effect";
import { desktopApi, UiError, validate } from "./api.js";
import { type McpDraft, parseMcpArguments, rowsBody } from "./openmausbot/components/mcp-draft.js";
import { gapIn, readMcpPaste } from "./openmausbot/lib/mcp-paste.js";

export const parseMcpPaste = (text: string, taken: readonly string[]) =>
  Effect.try({
    try: () => readMcpPaste(text, taken),
    catch: () => new UiError({ message: "无法解析这份 MCP 配置，请检查格式。" }),
  }).pipe(
    Effect.flatMap((result) =>
      result?.ok
        ? Effect.succeed(result.servers)
        : Effect.fail(
            new UiError({
              message:
                result && !result.ok && result.error === "mcp.paste.badJson"
                  ? "JSON 格式有误，请检查输入。"
                  : "请粘贴服务地址、MCP 添加命令或 JSON 配置。",
            }),
          ),
    ),
  );

/** Adapt the upstream editor draft at the existing Effect/Schema boundary before saving any secrets. */
export const prepareMcpDraft = (draft: McpDraft) =>
  Effect.gen(function* () {
    const rows = rowsBody(
      draft.transport === "stdio" ? draft.env : draft.headers,
      draft.transport === "stdio" ? "env" : "header",
    );
    if (!rows.ok) return yield* Effect.fail(new UiError({ message: rows.error }));
    const args = parseMcpArguments(draft.args);
    if (draft.transport === "stdio" && [draft.command, ...args].some((value) => gapIn(value)))
      return yield* Effect.fail(new UiError({ message: "请补齐启动命令和参数中的变量或占位符。" }));
    if (draft.transport === "remote") {
      const url = yield* Effect.try({
        try: () => new URL(draft.url.trim()),
        catch: () => new UiError({ message: "请填写完整的 HTTP 或 HTTPS 服务地址。" }),
      });
      if (gapIn(draft.url) || url.username || url.password)
        return yield* Effect.fail(
          new UiError({ message: "请填写完整服务地址，登录凭据请放在请求头中。" }),
        );
    }
    const oauthSecret = draft.oauthClientSecret.trim();
    if (oauthSecret && gapIn(oauthSecret))
      return yield* Effect.fail(new UiError({ message: "请填写真实的 OAuth 客户端密钥。" }));
    const secretRef = oauthSecret
      ? "secret:pending-oauth"
      : !draft.oauthForgetSecret
        ? draft.oauthSecretRef
        : undefined;
    const input = yield* validate(
      McpServerInput,
      draft.transport === "stdio"
        ? {
            name: draft.name.trim(),
            transport: "stdio",
            command: draft.command.trim(),
            args,
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
            env: rows.values,
          }
        : {
            name: draft.name.trim(),
            transport: draft.type,
            url: draft.url.trim(),
            headers: rows.values,
            ...(draft.oauthClientId.trim() || secretRef
              ? {
                  oauth: {
                    ...(draft.oauthClientId.trim() ? { clientId: draft.oauthClientId.trim() } : {}),
                    ...(secretRef ? { clientSecretRef: secretRef } : {}),
                  },
                }
              : {}),
          },
    );
    return {
      input,
      values: Object.entries(rows.values).map(([name, value]) => ({ name, value })),
      ...(draft.transport === "remote" && oauthSecret ? { oauthSecret } : {}),
    };
  });

export const saveMcpImportSecrets = (
  prepared: Effect.Effect.Success<ReturnType<typeof prepareMcpDraft>>,
  key: string,
) =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(prepared.values, ({ name, value }, index) =>
      /^(?:secret:|env:)[A-Za-z0-9_-]+$/.test(value)
        ? Effect.succeed([name, value] as const)
        : desktopApi
            .saveSecret({ name: `mcp-${key}-${index}`, key: value })
            .pipe(Effect.map((saved) => [name, saved.apiKeyRef] as const)),
    );
    const references = Object.fromEntries(entries);
    const oauthSecret = prepared.oauthSecret
      ? yield* desktopApi.saveSecret({
          name: `mcp-${key}-oauth`,
          key: prepared.oauthSecret,
        })
      : undefined;
    return prepared.input.transport === "stdio"
      ? { ...prepared.input, env: references }
      : {
          ...prepared.input,
          headers: references,
          ...(oauthSecret
            ? {
                oauth: {
                  ...prepared.input.oauth,
                  clientSecretRef: oauthSecret.apiKeyRef,
                },
              }
            : {}),
        };
  });

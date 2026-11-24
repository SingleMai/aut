import { McpServerInput } from "@aut/protocol";
import { Effect } from "effect";
import { desktopApi, UiError, validate } from "./api.js";
import { gapIn, type PastedMcpServer, readMcpPaste } from "./openmausbot/lib/mcp-paste.js";

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

/** The copied parser is an input adapter; persisted data still uses the current Effect Schema. */
export const prepareMcpImport = (draft: PastedMcpServer, form: FormData) =>
  Effect.gen(function* () {
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const secrets = draft.transport === "stdio" ? draft.env : draft.headers;
    const values = secrets.map((secret, i) => {
      const entered = String(form.get(`secret-${i}`) ?? "");
      return {
        name: secret.name,
        value: secret.gap ? `${secret.gap.before}${entered}${secret.gap.after}` : entered,
      };
    });
    if (
      secrets.some((secret, i) => secret.gap && !String(form.get(`secret-${i}`) ?? "").trim()) ||
      values.some(({ value }) => !value || gapIn(value))
    )
      return yield* Effect.fail(
        new UiError({ message: "请填写真实的凭据值，不能保留变量或占位符。" }),
      );
    const references = Object.fromEntries(
      values.map(({ name }, i) => [name, `secret:pending-${i}`]),
    );
    const args =
      draft.transport === "stdio"
        ? yield* Effect.try({
            try: () => JSON.parse(text("args")) as unknown,
            catch: () => new UiError({ message: "启动参数必须是 JSON 数组。" }),
          })
        : undefined;
    const input = yield* validate(
      McpServerInput,
      draft.transport === "stdio"
        ? {
            name: text("name"),
            transport: "stdio",
            command: text("command"),
            args,
            env: references,
            ...("cwd" in draft && typeof draft.cwd === "string" ? { cwd: draft.cwd } : {}),
          }
        : {
            name: text("name"),
            transport: draft.type,
            url: text("url"),
            headers: references,
            ...(draft.oauthClientId ? { oauth: { clientId: draft.oauthClientId } } : {}),
          },
    );
    if (input.transport === "stdio") {
      if ([input.command, ...input.args].some((value) => gapIn(value)))
        return yield* Effect.fail(
          new UiError({ message: "请补齐启动命令和参数中的变量或占位符。" }),
        );
    } else {
      const url = new URL(input.url);
      if (gapIn(input.url) || url.username || url.password)
        return yield* Effect.fail(
          new UiError({ message: "请填写完整服务地址，登录凭据请放在请求头中。" }),
        );
    }
    return { input, values };
  });

export const saveMcpImportSecrets = (
  prepared: Effect.Effect.Success<ReturnType<typeof prepareMcpImport>>,
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
    return prepared.input.transport === "stdio"
      ? { ...prepared.input, env: references }
      : { ...prepared.input, headers: references };
  });

export const saveMcpServerSecrets = (input: McpServerInput, key: string) =>
  saveMcpImportSecrets(
    {
      input,
      values: Object.entries(
        input.transport === "stdio" ? (input.env ?? {}) : (input.headers ?? {}),
      ).map(([name, value]) => ({ name, value })),
    },
    key,
  );

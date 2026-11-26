// @vitest-environment happy-dom
import {
  type AutConfig,
  type BotConfig,
  BotId,
  type BotModelOption,
  type BotModelsResponse,
  type McpGrant,
  type McpServer,
  McpServerId,
} from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { BotEditor } from "./bot-editor.js";
import { createDesktopData } from "./desktop-data.js";

afterEach(() => vi.restoreAllMocks());
const bot: BotConfig = {
  id: BotId.make("research"),
  name: "研究助手",
  description: "研究",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
};
const config: AutConfig = {
  harnessInstances: [{ id: "local", name: "Local", kind: "codex", command: "codex", args: [] }],
};
const presets: readonly BotModelOption[] = [
  {
    instance: { id: "builtin:codex", name: "Codex", kind: "codex", command: "codex", args: [] },
    configured: false,
    availability: "installed",
    discovery: true,
    verification: "verified",
  },
  {
    instance: {
      id: "builtin:claude",
      name: "Claude Code",
      kind: "claude",
      command: "claude",
      args: [],
    },
    configured: false,
    availability: "installed",
    discovery: true,
    verification: "verified",
  },
  {
    instance: {
      id: "builtin:opencode",
      name: "OpenCode",
      kind: "acp",
      command: "opencode",
      args: ["acp"],
    },
    configured: false,
    availability: "missing",
    discovery: true,
    verification: "verified",
  },
  {
    instance: {
      id: "builtin:grok",
      name: "Grok",
      kind: "acp",
      command: "grok",
      args: ["agent", "stdio"],
    },
    configured: false,
    availability: "installed",
    discovery: true,
    verification: "preview",
  },
];
const server: McpServer = {
  id: McpServerId.make("search"),
  name: "搜索",
  transport: "http",
  url: "https://example.com/mcp",
  enabled: false,
  auth: { status: "none" },
  health: { status: "ready" },
  tools: [
    { name: "search", inputSchema: { type: "object" } },
    { name: "fetch", inputSchema: { type: "object" } },
  ],
};
const query = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const checks = () => [
  ...document.querySelectorAll<HTMLInputElement>(".bot-mcp-grants .mcp-tool-check [role=checkbox]"),
];
const submit = () =>
  act(async () => {
    query<HTMLFormElement>(".editor-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const mount = (
  options: {
    creating?: boolean;
    bot?: BotConfig;
    config?: AutConfig;
    grants?: readonly McpGrant[];
    servers?: readonly McpServer[];
  } = {},
) => {
  const entries: readonly BotModelOption[] = [
    ...(options.config ?? config).harnessInstances.map((instance) => ({
      instance,
      configured: true,
      availability: "installed" as const,
      discovery: true,
      verification: "verified" as const,
    })),
    ...presets,
  ];
  const listOptions = vi
    .spyOn(desktopApi, "listBotModelOptions")
    .mockReturnValue(Effect.succeed({ options: entries }));
  if (!vi.isMockFunction(desktopApi.discoverBotModels))
    vi.spyOn(desktopApi, "discoverBotModels").mockReturnValue(
      Effect.succeed({ models: [{ model: "my-model" }, { model: "test" }], source: "catalog" }),
    );
  const data = createDesktopData();
  const list = vi
    .spyOn(desktopApi, "listMcpServers")
    .mockReturnValue(Effect.succeed({ servers: options.servers ?? [server] }));
  const grants = vi
    .spyOn(data, "listMcpGrants")
    .mockReturnValue(Effect.succeed({ grants: options.grants ?? [] }));
  const save = vi
    .spyOn(desktopApi, "saveBot")
    .mockImplementation((value) => Effect.succeed({ bot: value }));
  const connection = vi
    .spyOn(desktopApi, "ensureBotConnection")
    .mockImplementation((instance) => Effect.succeed({ instance: { ...instance, id: "local" } }));
  const setGrant = vi.spyOn(data, "setMcpGrant").mockImplementation((botId, serverId, input) =>
    Effect.succeed({
      grant: { botId: BotId.make(botId), serverId: McpServerId.make(serverId), ...input },
    }),
  );
  vi.spyOn(data, "refresh").mockReturnValue(Effect.void);
  const flash = vi.fn();
  const close = vi.fn();
  const view = renderView(
    <BotEditor
      bot={options.creating ? undefined : (options.bot ?? bot)}
      bots={options.creating ? [] : [options.bot ?? bot]}
      config={options.config ?? config}
      focusCharacter={false}
      flash={flash}
      close={close}
      data={data}
    />,
  );
  return { data, list, listOptions, grants, save, connection, setGrant, flash, close, view };
};

it("keeps authorization changes as drafts and discards them on cancel", async () => {
  const test = mount();
  await flush();
  expect(checks()).toHaveLength(0);
  await act(async () =>
    query<HTMLButtonElement>('[role="switch"][aria-label="授权给 搜索"]').click(),
  );
  await act(async () => checks()[0]?.click());
  expect(checks()[0]?.getAttribute("aria-checked") === "true").toBe(true);
  expect(test.setGrant).not.toHaveBeenCalled();
  await act(async () => query<HTMLButtonElement>('.form-actions button[type="button"]').click());
  expect(test.close).toHaveBeenCalledOnce();
  expect(test.save).not.toHaveBeenCalled();
  expect(test.connection).not.toHaveBeenCalled();
  expect(test.setGrant).not.toHaveBeenCalled();
});

const fill = (name: string, value: string) =>
  act(async () => {
    const input = query<HTMLInputElement>(`[name="${name}"]`);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const openModels = () => act(async () => query<HTMLButtonElement>(".bot-model-trigger").click());
const program = (name: string) =>
  act(async () => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(".bot-model-programs button"),
    ].find((item) => item.textContent?.startsWith(name));
    if (!button) throw new Error(`Missing program ${name}`);
    button.click();
  });
const chooseModel = async (model: string, source?: string) => {
  await openModels();
  if (source) await program(source);
  await act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".bot-model-list button")].find(
      (item) => item.textContent?.includes(model),
    );
    if (!button) throw new Error(`Missing model ${model}`);
    button.click();
  });
  await act(async () => query<HTMLButtonElement>(".bot-model-close").click());
};
const parameter = (name: string, text: string) =>
  act(async () => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(
        `.bot-model-parameter[aria-label="${name}"] button`,
      ),
    ].find((item) => item.textContent === text);
    if (!button) throw new Error(`Missing parameter ${name}: ${text}`);
    button.click();
  });

it("removes connection details and switches to an adapted program in the same picker", async () => {
  vi.spyOn(desktopApi, "discoverBotModels").mockImplementation(({ instance }) =>
    Effect.succeed({
      models: [{ model: `${instance.kind}-native`, label: "Native model" }],
      source: "catalog",
    }),
  );
  const test = mount();
  test.connection.mockImplementation((instance) =>
    Effect.succeed({ instance: { ...instance, id: "saved-claude" } }),
  );
  await flush();
  for (const text of ["连接细节", "CLI 命令", "环境变量", "启动参数", "Harness 实例", "前往设置"])
    expect(document.body.textContent).not.toContain(text);
  expect(document.querySelector('[name^="connection."]')).toBeNull();
  await openModels();
  for (const text of ["Codex", "Claude Code", "OpenCode", "Grok"])
    expect(document.querySelector(".bot-model-programs")?.textContent).toContain(text);
  await program("Claude Code");
  expect(query<HTMLInputElement>('[name="model"]').value).toBe("test");
  await act(async () => query<HTMLButtonElement>(".bot-model-list button").click());
  await submit();
  expect(test.connection.mock.calls[0]?.[0]).toMatchObject({
    kind: "claude",
    command: "claude",
    args: [],
  });
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual({
    instanceId: "saved-claude",
    model: "claude-native",
  });
  expect(config.harnessInstances).toHaveLength(1);
});

it("preserves an existing instance identity even when another instance has identical settings", async () => {
  const existing = config.harnessInstances[0];
  if (!existing) throw new Error("Missing fixture");
  const test = mount({ config: { harnessInstances: [{ ...existing, id: "other" }, existing] } });
  await flush();
  await submit();
  expect(test.connection).not.toHaveBeenCalled();
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual(bot.modelSelection);
});

it("saves the exact stored instance selected from a refreshed provider list", async () => {
  const original = config.harnessInstances[0];
  if (!original) throw new Error("Missing fixture");
  const test = mount();
  await flush();
  await openModels();
  // A second instance with identical launch settings was saved after the editor opened.
  test.listOptions.mockReturnValueOnce(
    Effect.succeed({
      options: [original, { ...original, id: "added-while-editing" }].map((instance) => ({
        instance,
        configured: true,
        availability: "installed" as const,
        discovery: true,
        verification: "verified" as const,
      })),
    }),
  );
  await act(async () =>
    query<HTMLButtonElement>('.bot-model-picker-header [aria-label="刷新"]').click(),
  );
  const providers = [...document.querySelectorAll<HTMLButtonElement>(".bot-model-programs button")];
  expect(providers.map((button) => button.textContent)).toEqual([original.name, original.name]);
  await act(async () =>
    query<HTMLButtonElement>(".bot-model-programs button:last-of-type").click(),
  );
  await act(async () => query<HTMLButtonElement>(".bot-model-list button").click());
  await act(async () => query<HTMLButtonElement>(".bot-model-close").click());
  await submit();
  expect(test.connection).not.toHaveBeenCalled();
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual({
    instanceId: "added-while-editing",
    model: "my-model",
  });
});

it("requires a model and can configure the first Bot without launch fields", async () => {
  const test = mount({ creating: true, config: { harnessInstances: [] }, servers: [] });
  await flush();
  await fill("name", "New Bot");
  const description = query<HTMLTextAreaElement>('[name="description"]');
  description.value = "Research";
  await fill("cwd", "/project");
  await submit();
  expect(test.connection).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(query(".bot-model-trigger"));
  await chooseModel("my-model", "Claude Code");
  await submit();
  expect(test.connection.mock.calls[0]?.[0]).toMatchObject({
    command: "claude",
    kind: "claude",
    args: [],
  });
  expect(test.save.mock.calls[0]?.[0]).toMatchObject({
    name: "New Bot",
    modelSelection: { model: "my-model" },
  });
  expect(test.close).toHaveBeenCalledOnce();
});

it("reads models without replacing a saved model or writing configuration", async () => {
  const discover = vi.spyOn(desktopApi, "discoverBotModels").mockReturnValue(
    Effect.succeed({
      models: [{ model: "new-default" }],
      defaultModel: "new-default",
      source: "catalog",
    }),
  );
  const test = mount();
  await flush();
  await openModels();
  expect(discover.mock.calls[0]?.[0]).toMatchObject({
    instance: { id: "local", command: "codex" },
    cwd: "/tmp",
  });
  expect(query<HTMLInputElement>('[name="model"]').value).toBe("test");
  expect(document.body.textContent).toContain("new-default");
  expect(test.connection).not.toHaveBeenCalled();
  expect(test.save).not.toHaveBeenCalled();
});

it("ignores a late response from another program and clears incompatible effort when switching", async () => {
  const pending = await Effect.runPromise(Deferred.make<BotModelsResponse>());
  vi.spyOn(desktopApi, "discoverBotModels").mockImplementation(({ instance }) =>
    instance.kind === "codex"
      ? Deferred.await(pending)
      : Effect.succeed({ models: [{ model: "claude-choice" }], source: "catalog" }),
  );
  const test = mount({
    bot: { ...bot, modelSelection: { ...bot.modelSelection, effort: "high", speed: "priority" } },
  });
  await flush();
  await openModels();
  await program("Claude Code");
  await act(async () => query<HTMLButtonElement>(".bot-model-list button").click());
  await act(async () => {
    await Effect.runPromise(
      Deferred.succeed(pending, {
        models: [{ model: "late" }],
        defaultModel: "late",
        source: "catalog",
      }),
    );
  });
  expect(query<HTMLInputElement>('[name="model"]').value).toBe("claude-choice");
  expect(query<HTMLInputElement>('[name="effort"]').value).toBe("");
  expect(query<HTMLInputElement>('[name="speed"]').value).toBe("");
  await act(async () => query<HTMLButtonElement>('.form-actions button[type="button"]').click());
  expect(test.save).not.toHaveBeenCalled();
  expect(test.connection).not.toHaveBeenCalled();
});

it("keeps missing programs visible and retains the saved model on discovery failure", async () => {
  const discover = vi
    .spyOn(desktopApi, "discoverBotModels")
    .mockReturnValue(Effect.fail(new UiError({ message: "Unavailable" })));
  const test = mount();
  await flush();
  await openModels();
  expect(document.body.textContent).toContain("读取失败");
  await program("OpenCode");
  expect(document.body.textContent).toContain("执行电脑上未检测到 OpenCode");
  expect(discover).toHaveBeenCalledTimes(1);
  expect(query<HTMLInputElement>('[name="model"]').value).toBe("test");
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await submit();
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual(bot.modelSelection);
});

it("loads existing grants and saves an exact tool change without enabling the service", async () => {
  const enable = vi.spyOn(desktopApi, "setMcpServerEnabled");
  const grant = { botId: bot.id, serverId: server.id, enabled: true, allowedTools: ["search"] };
  const test = mount({ grants: [grant] });
  await flush();
  expect(query('[role="switch"][aria-label="授权给 搜索"]').getAttribute("aria-checked")).toBe(
    "true",
  );
  await act(async () => query<HTMLButtonElement>(".mcp-grant-expand").click());
  expect(checks().map((item) => item.getAttribute("aria-checked") === "true")).toEqual([
    true,
    false,
  ]);
  expect(document.body.textContent).toContain("服务尚未启用");
  await act(async () => checks()[0]?.click());
  await act(async () => checks()[1]?.click());
  await submit();
  expect(test.save).toHaveBeenCalledOnce();
  expect(test.setGrant).toHaveBeenCalledExactlyOnceWith(bot.id, server.id, {
    enabled: true,
    allowedTools: ["fetch"],
  });
  expect(enable).not.toHaveBeenCalled();
  expect(test.close).toHaveBeenCalledOnce();
});

it("does not rewrite unchanged authorization when saving Bot details", async () => {
  const test = mount({
    grants: [{ botId: bot.id, serverId: server.id, enabled: true, allowedTools: ["search"] }],
  });
  await flush();
  await submit();
  expect(test.save).toHaveBeenCalledOnce();
  expect(test.setGrant).not.toHaveBeenCalled();
});

it("retries only failed grants and updates the already created Bot instead of recreating it", async () => {
  const other = { ...server, id: McpServerId.make("other"), name: "其他" };
  const test = mount({ creating: true, servers: [server, other] });
  await flush();
  await act(async () => {
    for (const [name, value] of Object.entries({
      id: bot.id,
      name: bot.name,
      description: bot.description,
      cwd: "/tmp",
    })) {
      const input = query<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await chooseModel("test", "Local");
  for (const name of ["搜索", "其他"]) {
    await act(async () =>
      query<HTMLButtonElement>(`[role="switch"][aria-label="授权给 ${name}"]`).click(),
    );
    await act(async () =>
      query<HTMLInputElement>(
        `section[aria-label="${name}"] [role="checkbox"][aria-label="search"]`,
      ).click(),
    );
  }
  let failed = false;
  test.setGrant.mockImplementation((botId, serverId, input) =>
    Effect.suspend(() => {
      if (serverId === other.id && !failed) {
        failed = true;
        return Effect.fail(new UiError({ message: "Connection interrupted" }));
      }
      return Effect.succeed({
        grant: { botId: BotId.make(botId), serverId: McpServerId.make(serverId), ...input },
      });
    }),
  );
  await submit();
  expect(test.save).toHaveBeenCalledOnce();
  expect(test.save.mock.calls[0]?.[1]).toBeUndefined();
  expect(test.setGrant).toHaveBeenCalledTimes(2);
  expect(test.flash).toHaveBeenCalledWith(expect.stringContaining("Bot 已保存"));
  expect(test.close).not.toHaveBeenCalled();
  expect(checks().map((item) => item.getAttribute("aria-checked") === "true")).toEqual([
    true,
    false,
    true,
    false,
  ]);
  expect(query<HTMLInputElement>('[name="id"]').disabled).toBe(true);
  await submit();
  expect(test.save).toHaveBeenCalledTimes(2);
  expect(test.save.mock.calls[1]?.[1]).toBe(bot.id);
  expect(test.setGrant.mock.calls.map((call) => call[1])).toEqual([server.id, other.id, other.id]);
  expect(test.close).toHaveBeenCalledOnce();
});

it("does not revoke unread grants on load failure and allows an explicit read retry", async () => {
  const test = mount();
  test.grants.mockReturnValueOnce(Effect.fail(new UiError({ message: "Unavailable" })));
  // Remount so the failing read is used by the editor's own loading effect.
  test.view.dispose();
  renderView(
    <BotEditor
      bot={bot}
      bots={[bot]}
      config={config}
      focusCharacter={false}
      flash={test.flash}
      close={test.close}
      data={test.data}
    />,
  );
  await flush();
  expect(query<HTMLElement>('.bot-mcp-grants [role="alert"]').textContent).toContain("重试");
  expect(checks()).toHaveLength(0);
  await submit();
  expect(test.setGrant).not.toHaveBeenCalled();
  test.grants.mockReturnValue(
    Effect.succeed({
      grants: [{ botId: bot.id, serverId: server.id, enabled: true, allowedTools: ["fetch"] }],
    }),
  );
  await act(async () => query<HTMLButtonElement>('.bot-mcp-grants [role="alert"] button').click());
  await act(async () => query<HTMLButtonElement>(".mcp-grant-expand").click());
  expect(checks().map((item) => item.getAttribute("aria-checked") === "true")).toEqual([
    false,
    true,
  ]);
});

it("edits supported effort and speed in the picker, preserves edits on refresh, and saves the Bot draft", async () => {
  const discover = vi.spyOn(desktopApi, "discoverBotModels").mockReturnValue(
    Effect.succeed({
      models: [
        {
          model: "test",
          label: "Test model",
          effort: "low",
          efforts: [{ value: "low" }, { value: "high" }],
          speeds: [{ value: "default" }, { value: "priority" }],
        },
      ],
      source: "catalog",
    }),
  );
  const test = mount();
  await flush();
  await openModels();
  expect(document.querySelector(".bot-model-custom")).toBeNull();
  expect(document.querySelector('input[name="effort"][type="text"]')).toBeNull();
  await act(async () => query<HTMLButtonElement>(".bot-model-list button").click());
  expect(document.querySelector(".bot-model-picker")).not.toBeNull();
  await parameter("思考强度", "高");
  await parameter("速度", "快速");
  expect(test.save).not.toHaveBeenCalled();
  await act(async () =>
    query<HTMLButtonElement>('.bot-model-picker-header button[aria-label="刷新"]').click(),
  );
  expect(discover).toHaveBeenCalledTimes(2);
  expect(query<HTMLInputElement>('[name="effort"]').value).toBe("high");
  expect(query<HTMLInputElement>('[name="speed"]').value).toBe("priority");
  await act(async () => query<HTMLButtonElement>(".bot-model-close").click());
  expect(query(".bot-model-trigger").textContent).toContain("高 · 快速");
  await submit();
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual({
    ...bot.modelSelection,
    effort: "high",
    speed: "priority",
  });
});

it("preserves saved parameters when discovery fails and clears them only on an explicit new model choice", async () => {
  const discover = vi
    .spyOn(desktopApi, "discoverBotModels")
    .mockReturnValue(Effect.fail(new UiError({ message: "Offline" })));
  const saved = {
    ...bot,
    modelSelection: { ...bot.modelSelection, effort: "future-effort", speed: "future-speed" },
  };
  const test = mount({ bot: saved });
  await flush();
  await openModels();
  expect(document.querySelector(".bot-model-parameters")?.textContent).toContain(
    "future-speed · 已保留",
  );
  await act(async () => query<HTMLButtonElement>(".bot-model-close").click());
  await submit();
  expect(test.save.mock.calls[0]?.[0].modelSelection).toEqual(saved.modelSelection);
  discover.mockReturnValue(Effect.succeed({ models: [{ model: "simple" }], source: "catalog" }));
  await openModels();
  await program("Claude Code");
  expect(query<HTMLInputElement>('[name="speed"]').value).toBe("future-speed");
  await act(async () => query<HTMLButtonElement>(".bot-model-list button").click());
  expect(query<HTMLInputElement>('[name="speed"]').value).toBe("");
  expect(query<HTMLInputElement>('[name="effort"]').value).toBe("");
  expect(document.querySelectorAll(".bot-model-parameter button")).toHaveLength(0);
});

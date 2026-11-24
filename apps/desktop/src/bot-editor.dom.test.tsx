// @vitest-environment happy-dom
import {
  type AutConfig,
  type BotConfig,
  BotId,
  type McpGrant,
  type McpServer,
  McpServerId,
} from "@aut/protocol";
import { Effect } from "effect";
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
    grants?: readonly McpGrant[];
    servers?: readonly McpServer[];
  } = {},
) => {
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
      bot={options.creating ? undefined : bot}
      bots={options.creating ? [] : [bot]}
      config={config}
      focusCharacter={false}
      flash={flash}
      close={close}
      settings={vi.fn()}
      data={data}
    />,
  );
  return { data, list, grants, save, setGrant, flash, close, view };
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
  expect(test.setGrant).not.toHaveBeenCalled();
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
      model: "test",
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
      settings={vi.fn()}
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

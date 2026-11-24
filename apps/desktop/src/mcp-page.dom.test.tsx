// @vitest-environment happy-dom
import { type BotConfig, BotId, type McpGrant, type McpServer, McpServerId } from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { UiError } from "./api.js";
import { createDesktopData } from "./desktop-data.js";
import { McpPage } from "./mcp-page.js";

afterEach(() => vi.restoreAllMocks());
const bot: BotConfig = {
  id: BotId.make("research"),
  name: "研究助手",
  description: "研究",
  soul: "",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
};
const server: McpServer = {
  id: McpServerId.make("search"),
  name: "搜索",
  transport: "http",
  url: "https://example.com/mcp",
  enabled: true,
  auth: { status: "none" },
  health: { status: "ready" },
  tools: [{ name: "search", inputSchema: { type: "object" } }],
};

it("updates Bot and tool checkboxes from the saved grant without reopening the page", async () => {
  const data = createDesktopData();
  let grant: McpGrant = { botId: bot.id, serverId: server.id, enabled: false, allowedTools: [] };
  vi.spyOn(data, "listMcpGrants").mockImplementation(() => Effect.succeed({ grants: [grant] }));
  vi.spyOn(data, "refresh").mockReturnValue(Effect.void);
  const save = vi.spyOn(data, "setMcpGrant").mockImplementation((_bot, _server, input) =>
    Effect.sync(() => {
      grant = { ...grant, ...input };
      return { grant };
    }),
  );
  const view = renderView(<McpPage servers={[server]} bots={[bot]} data={data} flash={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  const botCheck = view.element.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="授权给 研究助手"]',
  );
  if (!botCheck) throw new Error("Missing Bot grant");
  expect(view.element.querySelector(".mcp-tool-check")).toBeNull();
  await act(async () => botCheck.click());
  expect(botCheck.getAttribute("aria-checked")).toBe("true");
  const toolCheck = view.element.querySelector<HTMLButtonElement>(
    '.mcp-tool-check [role="checkbox"]',
  );
  if (!toolCheck) throw new Error("Missing tool grant");
  expect(toolCheck.disabled).toBe(false);
  await act(async () => toolCheck.click());
  expect(toolCheck.getAttribute("aria-checked") === "true").toBe(true);
  expect(save).toHaveBeenLastCalledWith(bot.id, server.id, {
    enabled: true,
    allowedTools: ["search"],
  });
  await act(async () => toolCheck.click());
  expect(toolCheck.getAttribute("aria-checked") === "true").toBe(false);
});

it("keeps rejected tool grants unchanged and shows the error beside the service", async () => {
  const data = createDesktopData();
  vi.spyOn(data, "listMcpGrants").mockReturnValue(
    Effect.succeed({
      grants: [{ botId: bot.id, serverId: server.id, enabled: true, allowedTools: [] }],
    }),
  );
  vi.spyOn(data, "setMcpGrant").mockReturnValue(
    Effect.fail(new UiError({ message: "Grant could not be saved" })),
  );
  const view = renderView(<McpPage servers={[server]} bots={[bot]} data={data} flash={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () =>
    view.element.querySelector<HTMLButtonElement>(".mcp-grant-expand")?.click(),
  );
  const tool = view.element.querySelector<HTMLButtonElement>('.mcp-tool-check [role="checkbox"]');
  if (!tool) throw new Error("Missing tool");
  await act(async () => tool.click());
  expect(tool.getAttribute("aria-checked") === "true").toBe(false);
  expect(view.element.querySelector('[role="alert"]')?.textContent).toContain(
    "Grant could not be saved",
  );
});

it("requires explicit deletion confirmation and leaves the service on cancel", async () => {
  const data = createDesktopData();
  const remove = vi
    .spyOn(data, "deleteMcpServer")
    .mockReturnValue(Effect.succeed({ deleted: true }));
  const view = renderView(<McpPage servers={[server]} bots={[]} data={data} flash={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  const trigger = view.element.querySelector<HTMLButtonElement>(
    '[aria-label="删除 MCP 服务 搜索"]',
  );
  if (!trigger) throw new Error("Missing delete button");
  await act(async () => trigger.click());
  expect(remove).not.toHaveBeenCalled();
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "取消",
  );
  await act(async () => cancel?.click());
  expect(remove).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "删除 MCP 服务",
  );
  await act(async () => confirm?.click());
  expect(remove).toHaveBeenCalledExactlyOnceWith(server.id);
});

it("preserves expanded tool search across the daemon refresh after saving a grant", async () => {
  const data = createDesktopData();
  const result = {
    grants: [{ botId: bot.id, serverId: server.id, enabled: true, allowedTools: ["search"] }],
  };
  const pending = await Effect.runPromise(Deferred.make<typeof result>());
  vi.spyOn(data, "listMcpGrants")
    .mockReturnValueOnce(Effect.succeed(result))
    .mockReturnValue(Deferred.await(pending));
  const bots = [bot];
  const flash = vi.fn();
  const view = renderView(<McpPage servers={[server]} bots={bots} data={data} flash={flash} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () =>
    view.element.querySelector<HTMLButtonElement>(".mcp-grant-expand")?.click(),
  );
  const input = view.element.querySelector<HTMLInputElement>(
    '.mcp-grant-body input[aria-label="搜索工具名称或说明 · 研究助手"]',
  );
  if (!input) throw new Error("Missing tool search");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "search",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  view.update(<McpPage servers={[{ ...server }]} bots={bots} data={data} flash={flash} />);
  expect(
    view.element.querySelector('.mcp-grant-body input[aria-label="搜索工具名称或说明 · 研究助手"]'),
  ).toBe(input);
  expect(input.value).toBe("search");
  expect(view.element.querySelector<HTMLButtonElement>('[role="checkbox"]')?.disabled).toBe(true);
  await act(async () => {
    await Effect.runPromise(Deferred.succeed(pending, result));
  });
  expect(
    view.element.querySelector('.mcp-grant-body input[aria-label="搜索工具名称或说明 · 研究助手"]'),
  ).toBe(input);
  expect(view.element.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe(
    "true",
  );
});

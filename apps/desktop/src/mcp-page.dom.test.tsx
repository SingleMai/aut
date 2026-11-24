// @vitest-environment happy-dom
import { type BotConfig, BotId, type McpGrant, type McpServer, McpServerId } from "@aut/protocol";
import { Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
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
  const checks = view.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const botCheck = checks[0];
  const toolCheck = checks[1];
  if (!botCheck || !toolCheck) throw new Error("Missing grants");
  expect(toolCheck.disabled).toBe(true);
  await act(async () => botCheck.click());
  expect(botCheck.checked).toBe(true);
  expect(toolCheck.disabled).toBe(false);
  await act(async () => toolCheck.click());
  expect(toolCheck.checked).toBe(true);
  expect(save).toHaveBeenLastCalledWith(bot.id, server.id, {
    enabled: true,
    allowedTools: ["search"],
  });
  await act(async () => toolCheck.click());
  expect(toolCheck.checked).toBe(false);
});

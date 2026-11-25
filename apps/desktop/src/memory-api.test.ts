import { BotId } from "@aut/protocol";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { desktopApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());
it("encodes bot, relative file and snapshot identifiers in the declared memory routes", async () => {
  const path = "knowledge/项目 & notes.md";
  const file = { path, content: "fixture", bytes: 7, updatedAt: 1 };
  const request = vi.fn().mockResolvedValue({ ok: true, data: { file } });
  vi.stubGlobal("window", { aut: { request } });
  await Effect.runPromise(desktopApi.readBotMemory("bot/one", path, "snapshot & one"));
  expect(request).toHaveBeenLastCalledWith({
    method: "GET",
    path: `/v1/bots/bot%2Fone/memory/file?path=${encodeURIComponent(path)}&snapshot=snapshot%20%26%20one`,
  });
  await Effect.runPromise(desktopApi.writeBotMemory("bot/one", { path, content: "fixture" }));
  expect(request).toHaveBeenLastCalledWith({
    method: "PUT",
    path: "/v1/bots/bot%2Fone/memory/file",
    body: { path, content: "fixture" },
  });
  request.mockResolvedValue({ ok: true, data: { accepted: true } });
  await Effect.runPromise(desktopApi.deleteBotMemory("bot/one", path));
  expect(request).toHaveBeenLastCalledWith({
    method: "DELETE",
    path: `/v1/bots/bot%2Fone/memory/file?path=${encodeURIComponent(path)}`,
  });
  await Effect.runPromise(desktopApi.clearBotMemory("bot/one"));
  expect(request).toHaveBeenLastCalledWith({
    method: "POST",
    path: "/v1/bots/bot%2Fone/memory/clear",
  });
  request.mockResolvedValue({
    ok: true,
    data: {
      botId: BotId.make("bot/one"),
      directory: "/tmp/memory",
      files: [],
      snapshots: [],
      dream: null,
    },
  });
  await Effect.runPromise(desktopApi.listBotMemory("bot/one", "snapshot & one"));
  expect(request).toHaveBeenLastCalledWith({
    method: "GET",
    path: "/v1/bots/bot%2Fone/memory?snapshot=snapshot%20%26%20one",
  });
  request.mockResolvedValue({
    ok: true,
    data: { botId: BotId.make("bot/one"), nodes: [], edges: [], brokenLinks: [] },
  });
  await Effect.runPromise(desktopApi.getBotMemoryGraph("bot/one", "snapshot & one"));
  expect(request).toHaveBeenLastCalledWith({
    method: "GET",
    path: "/v1/bots/bot%2Fone/memory/graph?snapshot=snapshot%20%26%20one",
  });
});

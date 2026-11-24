// @vitest-environment happy-dom
import { BotId, type MainThreadMessage, MessageId, TaskId } from "@aut/protocol";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { ConversationMessage } from "./conversation-message.js";
import { createDesktopData } from "./desktop-data.js";

afterEach(() => vi.restoreAllMocks());

it("copies the complete original URL from a short source label beneath a gated reply", async () => {
  const url = `https://modelcontextprotocol.io/docs/${"long-path/".repeat(50)}intro?q=one&lang=zh#section`;
  const message: MainThreadMessage = {
    id: MessageId.make("report"),
    author: { botId: BotId.make("research"), taskId: TaskId.make("task") },
    kind: "reply",
    at: 1,
    text: "资料已整理。…\n详情见任务面板",
    fullReportRef: "event:original",
    sources: [{ url, label: "MCP 官方文档" }],
  };
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const view = renderView(
    <ConversationMessage
      message={message}
      layout={{ showTime: false, showAuthor: false, joinedAbove: false, joinedBelow: false }}
      source="研究助手"
      typedPast
      data={createDesktopData()}
      revision={0}
      flash={vi.fn()}
      onQuote={vi.fn()}
      openTask={vi.fn()}
      showReport={vi.fn()}
      focusComposer={vi.fn()}
    />,
  );
  const source = view.element.querySelector<HTMLButtonElement>(".message-sources button");
  expect(source?.textContent).toContain("MCP 官方文档");
  expect(source?.getAttribute("title")).toContain(url);
  expect(view.element.querySelector(".message-text")?.textContent).not.toContain(url);
  expect(view.element.querySelector("a, iframe, img")).toBeNull();
  await act(async () => source?.click());
  expect(copy).toHaveBeenCalledExactlyOnceWith(url);
});

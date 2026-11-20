// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationBody, isLongUserMessage } from "./conversation-body.js";

let host: HTMLElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const render = (text: string, user = false) =>
  act(() => root.render(<ConversationBody text={text} user={user} />));
const query = (s: string) => {
  const result = host.querySelector<HTMLElement>(s);
  expect(result).toBeTruthy();
  if (!result) throw Error(s);
  return result;
};
it("retains the upstream 600-character and eight-line boundaries and expands the original input", () => {
  expect(isLongUserMessage("a".repeat(600))).toBe(false);
  expect(isLongUserMessage("a".repeat(601))).toBe(true);
  expect(isLongUserMessage(Array(8).fill("a").join("\n"))).toBe(false);
  const lines = Array(9).fill("**literal input**").join("\n");
  render(lines, true);
  expect(query(".chat-user-clipped").textContent).toBe(lines);
  expect(host.querySelector("strong")).toBeNull();
  act(() => query("button").click());
  expect(host.querySelector(".chat-user-clipped")).toBeNull();
  expect(query("button").getAttribute("aria-expanded")).toBe("true");
  act(() => query("button").click());
  expect(query(".chat-user-clipped").textContent).toBe(lines);
});
it("renders GFM, preserved soft breaks, mixed-direction prose and literal fenced tokens", async () => {
  const code = 'const a = "<&>"';
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    [
      "## 结果",
      "",
      "**完成**",
      "下一行",
      "",
      "| A | B |",
      "|--|--|",
      "| left<br>right | [site](https://example.com) |",
      "",
      "مرحبا",
      "",
      "```js",
      code,
      "```",
    ].join("\n"),
  );
  const blocks = [...query("[data-reply-bubble]").children];
  expect(blocks.map((block) => block.hasAttribute("data-reply-table"))).toEqual([
    false,
    true,
    false,
  ]);
  expect(blocks[1]?.querySelector("table")).toBeTruthy();
  expect(query(".markdown-body h2").textContent).toBe("结果");
  expect(query("strong").textContent).toBe("完成");
  expect(host.querySelectorAll("br")).toHaveLength(2);
  expect(query("p[dir=rtl]").textContent).toBe("مرحبا");
  expect(host.querySelectorAll("td")).toHaveLength(2);
  expect(query("pre").textContent).toBe(code);
  expect(query("pre .hljs-keyword").textContent).toBe("const");
  await act(async () => query("button[aria-label=复制代码]").click());
  expect(copy).toHaveBeenCalledWith(code);
  act(() => query("button[aria-label=自动换行]").click());
  expect(query("button[aria-label=自动换行]").getAttribute("aria-pressed")).toBe("true");
  await act(async () => query(".markdown-link").click());
  expect(copy).toHaveBeenCalledWith("https://example.com/");
});
it("does not mount raw HTML, external image requests, active content or local file navigations", () => {
  render(
    "![alt](https://example.com/resource) [blocked](file:///private/data) [script](javascript:alert%281%29) <iframe src=x></iframe> <img src=x>",
  );
  expect(host.querySelector("a, img, iframe, script, button")).toBeNull();
  expect(host.textContent).toContain("alt");
  expect(host.textContent).toContain("blocked");
});

it("keeps table-like text inside a fence and preserves the unbroken document view", () => {
  const table = "| A | B |\n|---|---|\n| 1 | 2 |";
  render(`~~~text\n${table}\n~~~`);
  expect(host.querySelector("[data-reply-table]")).toBeNull();
  expect(query("pre").textContent).toBe(table);
  act(() => root.render(<ConversationBody text={table} user={false} document />));
  expect(host.querySelector("[data-reply-bubble]")).toBeNull();
  expect(query("table")).toBeTruthy();
});

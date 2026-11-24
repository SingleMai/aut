// @vitest-environment happy-dom
import { type McpServer, McpServerId } from "@aut/protocol";
import { Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { createDesktopData } from "./desktop-data.js";
import { McpServerEditor } from "./openmausbot/components/McpServerEditor.js";

afterEach(() => vi.restoreAllMocks());
const fixture = (name: string): McpServer => ({
  id: McpServerId.make(name),
  name,
  transport: "http",
  url: `https://${name}.example/mcp`,
  enabled: false,
  auth: { status: "none" },
  health: { status: "ready" },
  tools: [],
});
const fill = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const button = (element: HTMLElement, text: string) => {
  const value = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
  if (!value) throw new Error(`Missing button: ${text}`);
  return value;
};

it("recognizes pasted configuration immediately and requests only missing credentials", async () => {
  const data = createDesktopData();
  const create = vi
    .spyOn(data, "createMcpServer")
    .mockReturnValue(Effect.succeed({ server: fixture("notes") }));
  vi.spyOn(data, "testMcpServer").mockReturnValue(Effect.succeed({ server: fixture("notes") }));
  const secret = vi
    .spyOn(desktopApi, "saveSecret")
    .mockReturnValue(Effect.succeed({ apiKeyRef: "secret:fixture", configured: true }));
  const view = renderView(
    <McpServerEditor servers={[]} data={data} flash={vi.fn()} onClose={vi.fn()} />,
  );
  const paste = view.element.querySelector("textarea");
  if (!paste) throw new Error("Missing paste input");
  await fill(
    paste,
    `claude mcp add notes https://notes.example/mcp -H 'Authorization: Bearer $TOKEN'`,
  );
  expect(view.element.textContent).toContain("已识别 notes");
  expect(view.element.querySelector(".mcp-form-grid")).toBeNull();
  await act(async () => button(view.element, "保存并测试").click());
  expect(create).not.toHaveBeenCalled();
  const credential = view.element.querySelector<HTMLInputElement>('input[type="password"]');
  if (!credential) throw new Error("Missing credential input");
  await fill(credential, "fixture-key");
  await act(async () => button(view.element, "保存并测试").click());
  expect(secret).toHaveBeenCalledWith({ name: expect.any(String), key: "Bearer fixture-key" });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ headers: { Authorization: "secret:fixture" } }),
  );
  expect(view.element.textContent).toContain("连接正常");
});

it("retries failed connection checks without recreating successful batch entries", async () => {
  const data = createDesktopData();
  const create = vi
    .spyOn(data, "createMcpServer")
    .mockImplementation((input) => Effect.succeed({ server: fixture(input.name) }));
  let fail = true;
  const test = vi
    .spyOn(data, "testMcpServer")
    .mockImplementation((id) =>
      id === "two" && fail
        ? Effect.fail(new UiError({ message: "Fixture connection failed" }))
        : Effect.succeed({ server: fixture(id) }),
    );
  const view = renderView(
    <McpServerEditor servers={[]} data={data} flash={vi.fn()} onClose={vi.fn()} />,
  );
  const paste = view.element.querySelector("textarea");
  if (!paste) throw new Error("Missing paste input");
  await fill(
    paste,
    JSON.stringify({
      mcpServers: {
        one: { url: "https://one.example/mcp" },
        two: { url: "https://two.example/mcp" },
      },
    }),
  );
  await act(async () => button(view.element, "保存并测试").click());
  expect(create).toHaveBeenCalledTimes(2);
  expect(view.element.textContent).toContain("Fixture connection failed");
  fail = false;
  await act(async () => button(view.element, "重试未完成项").click());
  expect(create).toHaveBeenCalledTimes(2);
  expect(test.mock.calls.map(([id]) => id)).toEqual(["one", "two", "two"]);
});

it("does not expose or rewrite existing credentials during an edit", async () => {
  const data = createDesktopData();
  const server = { ...fixture("notes"), headers: { Authorization: "secret:existing" } };
  const update = vi.spyOn(data, "updateMcpServer").mockReturnValue(Effect.succeed({ server }));
  const secrets = vi.spyOn(desktopApi, "saveSecret");
  vi.spyOn(data, "testMcpServer").mockReturnValue(Effect.succeed({ server }));
  const view = renderView(
    <McpServerEditor
      server={server}
      servers={[server]}
      data={data}
      flash={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const credential = view.element.querySelector<HTMLInputElement>(
    'input[aria-label="Authorization"]',
  );
  expect(credential?.value).toBe("");
  expect(credential?.placeholder).toBe("已保存，留空保留");
  expect(view.element.innerHTML).not.toContain("secret:existing");
  await act(async () => button(view.element, "保存并测试").click());
  expect(update).toHaveBeenCalledWith(
    server.id,
    expect.objectContaining({ headers: server.headers }),
  );
  expect(secrets).not.toHaveBeenCalled();
});

it("does not submit stale parsed data after a later paste becomes invalid", async () => {
  const data = createDesktopData();
  const create = vi.spyOn(data, "createMcpServer");
  const view = renderView(
    <McpServerEditor servers={[]} data={data} flash={vi.fn()} onClose={vi.fn()} />,
  );
  const paste = view.element.querySelector("textarea");
  if (!paste) throw new Error("Missing paste input");
  await fill(paste, "https://notes.example/mcp");
  await act(async () => button(view.element, "连接细节 / 手动配置").click());
  await fill(paste, '{"mcpServers":');
  expect(button(view.element, "保存并测试").disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
});

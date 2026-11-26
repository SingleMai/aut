// @vitest-environment happy-dom

import { Schema } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { ApiRequest } from "./bridge.js";
import { DesktopApp } from "./desktop-app.js";
import { DeviceSettings } from "./settings/device-settings.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps execution settings available when the remote host is offline and config cannot load", async () => {
  const connection = vi.fn(async () => ({
    ok: true as const,
    status: {
      mode: "remote" as const,
      name: "Office Pro",
      phase: "login" as const,
      canLogin: true,
    },
  }));
  vi.stubGlobal("aut", {
    connection,
    request: vi.fn(async () => ({
      ok: false as const,
      error: { code: "Offline", message: "offline" },
    })),
    onNotice: () => () => {},
  });
  const view = renderView(<DesktopApp />);
  await act(async () => {});
  const settings = view.element.querySelector<HTMLButtonElement>('[data-view="settings"]');
  if (!settings) throw new Error("Missing settings navigation");
  act(() => settings.click());
  expect(view.element.textContent).toContain("Office Pro");
  expect(view.element.textContent).toContain("登录 Tailscale");
  expect(view.element.textContent).toContain("切换到本机");
  expect(
    [...view.element.querySelectorAll("button")].some(
      (button) => button.getAttribute("aria-label") === "允许其他设备连接",
    ),
  ).toBe(false);
  const login = [...view.element.querySelectorAll("button")].find(
    (button) => button.textContent === "登录 Tailscale",
  );
  await act(async () => login?.click());
  expect(connection).toHaveBeenCalledWith({ action: "login" });
});
it("shows recognized identity before confirming, clears pasted text and staged credentials, and blocks ordinary credential export", async () => {
  const preview = { id: "32f6aa10-f361-44c5-9e3b-312e1c0b9b56", name: "New Pro", hostId: "host" };
  const connection = vi.fn(async () => ({ ok: true as const, preview, cancelled: true }));
  vi.stubGlobal("aut", { connection, request: vi.fn(), onNotice: () => () => {} });
  const view = renderView(
    <DeviceSettings
      status={{ mode: "remote", name: "Pro", phase: "disconnected", canLogin: false }}
      flash={vi.fn()}
    />,
  );
  const add = [...view.element.querySelectorAll("button")].find(
    (button) => button.textContent === "连接另一台电脑",
  );
  await act(async () => add?.click());
  const input = document.querySelector<HTMLInputElement>(".pairing-manual input"),
    form = document.querySelector<HTMLFormElement>(".pairing-manual form");
  if (!input || !form) throw new Error("Missing pairing form");
  const info = {
    version: 1,
    hostId: "host",
    nodeId: "node",
    name: "New Pro",
    token: "f".repeat(64),
  };
  input.value = JSON.stringify(info);
  await act(async () => form.requestSubmit());
  expect(connection).toHaveBeenCalledWith({ action: "inspect", text: JSON.stringify(info) });
  expect(input.value).toBe("");
  expect(document.querySelector(".pairing-recognized")?.textContent).toContain("New Pro");
  expect(document.body.textContent).not.toContain(info.token);
  expect(connection).not.toHaveBeenCalledWith({ action: "pair", id: preview.id });
  const confirm = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "连接并重启",
  );
  await act(async () => confirm?.click());
  expect(connection).toHaveBeenCalledWith({ action: "pair", id: preview.id });
  expect(document.querySelector(".pairing-recognized")).not.toBeNull();
  const cancel = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "取消",
  );
  await act(async () => cancel?.click());
  expect(connection).toHaveBeenCalledWith({ action: "clear-pairing" });
  expect(document.querySelector(".pairing-recognized")).toBeNull();
  expect(Schema.is(ApiRequest)({ method: "POST", path: "/v1/remote/connection" })).toBe(false);
});

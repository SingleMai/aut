// @vitest-environment happy-dom
import { Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { createDesktopData } from "./desktop-data.js";
import { SettingsPage } from "./settings-page.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = () => {
  vi.stubGlobal("aut", { request: vi.fn(), onNotice: () => () => {} });
  const data = createDesktopData();
  const config = {
    harnessInstances: [{ id: "one", name: "Codex", kind: "codex", command: "codex", args: [] }],
  };
  const current = {
    harnessInstances: [
      ...config.harnessInstances,
      {
        id: "new",
        name: "Custom ACP",
        kind: "acp",
        command: "/opt/acp",
        args: ["agent", "stdio"],
        env: { REGION: "fixture" },
        authMethodIds: ["cached_token", "browser"],
      },
    ],
  };
  vi.spyOn(desktopApi, "getConfig").mockReturnValue(Effect.succeed(current));
  const save = vi.spyOn(data, "saveConfig").mockImplementation((value) => Effect.succeed(value));
  const flash = vi.fn();
  const view = renderView(
    <SettingsPage
      config={config}
      data={data}
      flash={flash}
      status={{ mode: "remote", name: "Office Pro", phase: "connected", canLogin: false }}
    />,
  );
  const form = view.element.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Missing settings form");
  return { view, form, current, save, flash };
};
it("keeps model management out of global settings and preserves connections added after opening it", async () => {
  const test = mount();
  expect(test.view.element.textContent).not.toContain("AI 服务");
  expect(test.view.element.querySelector('[name$=".command"]')).toBeNull();
  await act(async () => test.form.requestSubmit());
  expect(test.save).toHaveBeenCalledWith(test.current);
});
it("opens the erroneous classifier field and retains its draft when saving fails", async () => {
  const test = mount();
  const backend = test.form.querySelector<HTMLInputElement>('[name="primary.backend"]');
  const model = test.form.querySelector<HTMLInputElement>('[name="primary.model"]');
  const endpoint = test.form.querySelector<HTMLInputElement>('[name="primary.endpoint"]');
  if (!backend || !model || !endpoint) throw new Error("Missing classifier fields");
  backend.value = "jev";
  model.value = "jev-fixed";
  endpoint.value = "broken";
  await act(async () => test.form.requestSubmit());
  expect(document.activeElement).toBe(endpoint);
  expect(test.form.querySelector<HTMLDetailsElement>(".settings-advanced")?.open).toBe(true);
  expect(test.save).not.toHaveBeenCalled();
  endpoint.value = "https://example.com/jev";
  test.save.mockReturnValueOnce(Effect.fail(new UiError({ message: "Disconnected" })));
  await act(async () => test.form.requestSubmit());
  expect(model.value).toBe("jev-fixed");
  expect(test.flash).toHaveBeenCalledWith(expect.stringContaining("Disconnected"));
  await act(async () => test.form.requestSubmit());
  expect(test.save).toHaveBeenLastCalledWith({
    ...test.current,
    classifier: { primary: { backend: "jev", model: "jev-fixed", endpoint: endpoint.value } },
  });
});

// @vitest-environment happy-dom
import { type ClassifierConfig, JEV_ENDPOINT, JEV_MODEL } from "@aut/protocol";
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
const mount = (classifier?: ClassifierConfig) => {
  vi.stubGlobal("aut", { request: vi.fn(), onNotice: () => () => {} });
  const data = createDesktopData();
  const config = {
    harnessInstances: [{ id: "one", name: "Codex", kind: "codex", command: "codex", args: [] }],
    ...(classifier && { classifier }),
  };
  const current = {
    ...config,
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
  const field = (name: string) => {
    const input =
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`) ??
      form.querySelector<HTMLInputElement>(`[data-field="${name}"] input`);
    if (!input) throw new Error(`Missing field: ${name}`);
    return input;
  };
  const select = async (slot: string, source: string) => {
    const input = form.querySelector<HTMLInputElement>(
      `input[name="${slot}.source"][value="${source}"]`,
    );
    if (!input) throw new Error(`Missing service choice: ${source}`);
    await act(async () => input.click());
  };
  const enter = async (name: string, value: string) => {
    const input = field(name);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = () => act(async () => form.requestSubmit());
  const backupButton = (label: string) =>
    act(async () => {
      const button = Array.from(
        form.querySelectorAll<HTMLButtonElement>(".fast-brain-backup button"),
      ).find((candidate) => candidate.textContent === label);
      if (!button) throw new Error(`Missing backup action: ${label}`);
      button.click();
    });
  return { view, form, current, save, flash, field, select, enter, submit, backupButton };
};
it("keeps model management out of global settings and preserves connections added after opening it", async () => {
  const test = mount();
  expect(test.view.element.querySelector(".fast-brain-heading")?.textContent).toBe(
    "快脑模型待配置",
  );
  expect(test.view.element.textContent).not.toContain("AI 服务");
  expect(test.view.element.querySelector('[name$=".command"]')).toBeNull();
  expect(
    Array.from(
      test.form.querySelectorAll<HTMLInputElement>('[name="primary.source"]'),
      (input) => input.value,
    ),
  ).toEqual(["official", "custom"]);
  expect(test.form.querySelector('[name="primary.source"]:checked')).toBeNull();
  await test.submit();
  expect(test.save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(test.field("primary.source"));
  await test.select("primary", "official");
  await test.submit();
  expect(test.save).toHaveBeenCalledWith({
    ...test.current,
    classifier: { primary: { backend: "jev", model: JEV_MODEL, endpoint: JEV_ENDPOINT } },
  });
});
it("opens the erroneous classifier field and retains its draft when saving fails", async () => {
  const test = mount();
  await test.select("primary", "custom");
  const model = test.field("primary.model");
  const endpoint = test.field("primary.endpoint");
  await test.enter("primary.model", "jev-1.13.0");
  await test.enter("primary.endpoint", "http://public.example/jev");
  await test.submit();
  expect(document.activeElement).toBe(endpoint);
  expect(test.form.closest("details")?.open).toBe(true);
  expect(test.save).not.toHaveBeenCalled();
  await test.enter("primary.endpoint", "https://example.com/jev");
  test.save.mockReturnValueOnce(Effect.fail(new UiError({ message: "Disconnected" })));
  await test.submit();
  expect(model.value).toBe("jev-1.13.0");
  expect(test.flash).toHaveBeenCalledWith(expect.stringContaining("Disconnected"));
  await test.submit();
  expect(test.save).toHaveBeenLastCalledWith({
    ...test.current,
    classifier: {
      primary: {
        backend: "jev",
        model: model.value,
        endpoint: endpoint.value,
        apiKeyRef: expect.stringMatching(/^secret:primary-/),
      },
    },
  });
});

it("adds and removes a backup independently of the configured primary", async () => {
  const test = mount();
  expect(test.form.querySelector('[name="fallback.source"]')).toBeNull();
  await test.select("primary", "official");
  expect(test.form.querySelector('[name="primary.endpoint"]')).toBeNull();
  expect(test.field("primary.model").value).toBe(JEV_MODEL);
  await test.submit();
  const primary = { backend: "jev", model: JEV_MODEL, endpoint: JEV_ENDPOINT };
  expect(test.save).toHaveBeenLastCalledWith({ ...test.current, classifier: { primary } });
  await test.backupButton("添加备用快脑");
  await test.select("fallback", "custom");
  await test.enter("fallback.endpoint", "http://127.0.0.1:4310/decide");
  await test.submit();
  expect(test.save).toHaveBeenLastCalledWith({
    ...test.current,
    classifier: {
      primary,
      fallback: {
        backend: "jev",
        model: JEV_MODEL,
        endpoint: "http://127.0.0.1:4310/decide",
        apiKeyRef: expect.stringMatching(/^secret:fallback-/),
      },
    },
  });
  await test.backupButton("移除备用快脑");
  await test.submit();
  expect(test.save).toHaveBeenLastCalledWith({ ...test.current, classifier: { primary } });
});

it("round-trips pinned versions, existing credentials and an unsupported saved backend", async () => {
  const classifier = {
    primary: {
      backend: "jev",
      model: "jev-1.13.0",
      endpoint: JEV_ENDPOINT,
      apiKeyRef: "env:OFFICIAL_KEY",
    },
    fallback: {
      backend: "old-service",
      model: "old-v1",
      endpoint: "https://legacy.example/fast",
      apiKeyRef: "vault:existing",
    },
  };
  const test = mount(classifier);
  expect(test.view.element.querySelector(".fast-brain-heading")?.textContent).toBe(
    "快脑模型Jev 官方",
  );
  expect(
    test.form.querySelector<HTMLInputElement>('[name="fallback.source"][value="existing"]')
      ?.checked,
  ).toBe(true);
  await test.submit();
  expect(test.save).toHaveBeenLastCalledWith(test.current);
  await test.select("primary", "custom");
  await test.enter("primary.endpoint", "https://alternate.example/decide");
  await test.submit();
  expect(test.save).toHaveBeenLastCalledWith({
    ...test.current,
    classifier: {
      primary: {
        backend: "jev",
        model: JEV_MODEL,
        endpoint: "https://alternate.example/decide",
        apiKeyRef: expect.stringMatching(/^secret:primary-/),
      },
      fallback: classifier.fallback,
    },
  });
});

it("saves a key separately and binds it to the custom service the user chose", async () => {
  const test = mount();
  const saveKey = vi
    .spyOn(desktopApi, "saveSecret")
    .mockImplementation(({ name }) =>
      Effect.succeed({ apiKeyRef: `secret:${name}`, configured: true }),
    );
  const checkKey = vi
    .spyOn(desktopApi, "getSecretStatus")
    .mockImplementation((apiKeyRef) => Effect.succeed({ apiKeyRef, configured: true }));
  await test.select("primary", "custom");
  await test.enter("primary.endpoint", "https://one.example/v1/systemone");
  await test.enter("primary.credential", "test-value");
  await test.submit();
  expect(test.save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(test.field("primary.credential"));

  const buttons = Array.from(
    test.form.querySelectorAll<HTMLButtonElement>(".credential-actions button"),
  );
  const click = (text: string) =>
    act(async () => {
      const button = buttons.find((candidate) => candidate.textContent === text);
      if (!button) throw new Error(`Missing button: ${text}`);
      button.click();
    });
  await click("保存密钥");
  const keyRef = test.field("primary.key").value;
  expect(keyRef).toMatch(/^secret:primary-/);
  expect(saveKey).toHaveBeenCalledWith({ name: keyRef.slice("secret:".length), key: "test-value" });
  expect(test.field("primary.credential").value).toBe("");
  await click("检查密钥状态");
  expect(checkKey).toHaveBeenCalledWith(keyRef);
  await test.submit();
  expect(test.save.mock.lastCall?.[0].classifier?.primary.apiKeyRef).toBe(keyRef);
  expect(JSON.stringify(test.save.mock.calls)).not.toContain("test-value");

  await test.enter("primary.endpoint", "https://one.example/another-path");
  expect(test.field("primary.key").value).toBe(keyRef);
  await test.enter("primary.endpoint", "https://two.example/v1/systemone");
  expect(test.field("primary.key").value).not.toBe(keyRef);
  expect(test.field("primary.key").value).toMatch(/^secret:primary-/);
});

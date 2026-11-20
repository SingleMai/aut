// @vitest-environment happy-dom
import { Effect } from "effect";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { createDesktopData } from "./desktop-data.js";
import { SettingsPage } from "./settings-page.js";

it("focuses the first erroneous control in the current row order and keeps drafts across row deletion", async () => {
  const data = createDesktopData();
  const save = vi.spyOn(data, "saveConfig").mockImplementation((value) => Effect.succeed(value));
  const harnessInstances = ["one", "two"].map((id) => ({
    id,
    name: id,
    kind: "codex",
    command: "codex",
    args: [],
  }));
  const view = renderView(
    <SettingsPage config={{ harnessInstances }} data={data} flash={vi.fn()} />,
  );
  const form = view.element.querySelector("form");
  const rows = form?.querySelectorAll(".settings-section");
  const first = rows?.[0]?.querySelector<HTMLInputElement>('[name$=".args"]');
  const second = rows?.[1]?.querySelector<HTMLTextAreaElement>('[name$=".env"]');
  const remove = rows?.[0]?.querySelector("button");
  if (!form || !first || !second || !remove) throw new Error("Missing fixture fields");
  first.value = "[";
  second.value = '{"VALUE":false}';
  await act(async () => form.requestSubmit());
  expect(document.activeElement).toBe(first);
  expect(second.getAttribute("aria-invalid")).toBe("true");
  const hintId = second.getAttribute("aria-describedby") ?? "";
  expect(document.getElementById(hintId)?.textContent).toContain("字符串");
  expect(save).not.toHaveBeenCalled();
  act(() => remove.click());
  await act(async () => form.requestSubmit());
  expect(document.activeElement).toBe(second);
  expect(second.value).toBe('{"VALUE":false}');
  second.value = '{"VALUE":"yes"}';
  await act(async () => form.requestSubmit());
  expect(save).toHaveBeenCalledExactlyOnceWith({
    harnessInstances: [{ ...harnessInstances[1], env: { VALUE: "yes" } }],
  });
  expect(second.hasAttribute("aria-invalid")).toBe(false);
});

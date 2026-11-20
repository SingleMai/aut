// @vitest-environment happy-dom
import { type BotConfig, BotId } from "@aut/protocol";
import { Deferred, Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { desktopApi, UiError } from "./api.js";
import { createDesktopData } from "./desktop-data.js";
import { DispatchCorrection } from "./dispatch-correction.js";
import { t } from "./i18n.js";

afterEach(() => vi.restoreAllMocks());
const setup = () => {
  const data = createDesktopData();
  const bot: BotConfig = {
    id: BotId.make("first"),
    name: "同名助手",
    description: "Example",
    soul: "",
    cwd: "/tmp",
    modelSelection: { instanceId: "local", model: "test" },
    mcpServers: [],
  };
  const snapshot = {
    ...data.snapshot(),
    bots: [
      bot,
      { ...bot, id: BotId.make("second") },
      { ...bot, id: BotId.make("aut"), system: "primary" as const },
    ],
  };
  vi.spyOn(data, "snapshot").mockReturnValue(snapshot);
  vi.spyOn(data, "refresh").mockReturnValue(Effect.void);
  const flash = vi.fn();
  const render = (status: "open" | "undo" | "reroute", canUndo = true) => (
    <DispatchCorrection
      dispatch={{ status, canUndo, botId: bot.id }}
      decisionLogId="old-dispatch"
      data={data}
      flash={flash}
    />
  );
  const view = renderView(render("open"));
  const button = (name: string) => {
    const control = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent === name,
    );
    if (!control) throw new Error(`Missing button: ${name}`);
    return control;
  };
  act(() => button(t.correctDispatch).click());
  return { ...view, button, render, flash };
};
it("selects the new bot by ID and submits just once before rendering the durable result", async () => {
  const entry = setup();
  const pending = Effect.runSync(Deferred.make<{ accepted: true }>());
  const calls: string[] = [];
  vi.spyOn(desktopApi, "sendAction").mockImplementation((input) =>
    Effect.sync(() => calls.push(JSON.stringify(input))).pipe(
      Effect.zipRight(Deferred.await(pending)),
    ),
  );
  const select = document.querySelector<HTMLElement>('[role="dialog"] [role="combobox"]');
  if (!select) throw new Error("Missing bot selector");
  expect(entry.button(t.reroute).disabled).toBe(true);
  act(() => {
    select.focus();
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual([
    "同名助手 (second)",
    "同名助手 (aut)",
  ]);
  act(() => {
    options[0]?.focus();
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const submit = entry.button(t.reroute);
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(calls.map((s) => JSON.parse(s))).toEqual([
    {
      type: "correct-dispatch",
      decisionLogId: "old-dispatch",
      change: { kind: "reroute", botId: "second" },
    },
  ]);
  await act(async () => {
    await Effect.runPromise(Deferred.succeed(pending, { accepted: true as const }));
  });
  expect(entry.flash).toHaveBeenCalledWith(t.correctionSubmitted);
  entry.update(entry.render("reroute"));
  expect(entry.element.textContent).toBe(t.dispatchStatus.reroute);
});
it("keeps a failed undo available to retry and hides it once cancellation is unavailable", async () => {
  const send = vi
    .spyOn(desktopApi, "sendAction")
    .mockReturnValueOnce(Effect.fail(new UiError({ message: "offline" })))
    .mockReturnValue(Effect.succeed({ accepted: true }));
  const entry = setup();
  await act(async () => entry.button(t.undoDispatch).click());
  expect(entry.flash).toHaveBeenCalledWith(expect.stringContaining("offline"));
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  await act(async () => entry.button(t.undoDispatch).click());
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith({
    type: "correct-dispatch",
    decisionLogId: "old-dispatch",
    change: { kind: "undo" },
  });
  entry.update(entry.render("open", false));
  act(() => entry.button(t.correctDispatch).click());
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain(t.undoDispatch);
  entry.update(entry.render("undo"));
  expect(entry.element.textContent).toBe(t.dispatchStatus.undo);
});

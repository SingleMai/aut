// @vitest-environment happy-dom
import { paperBird, wink } from "@aut/characters";
import { type BotConfig, BotId } from "@aut/protocol";
import { Effect } from "effect";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../../test/render.js";
import { readBotForm } from "../configuration-forms.js";
import { t } from "../i18n.js";
import { botCharacter, botInitial } from "./bot-avatar.js";
import { CharacterEditor } from "./character-editor.js";

afterEach(() => {
  vi.useRealTimers();
});

const bot: BotConfig = {
  id: BotId.make("research"),
  name: "研究助手",
  soul: "",
  cwd: "/tmp",
  description: "Research",
  modelSelection: { instanceId: "local", model: "fixture" },
  mcpServers: [],
};

function previewPaperBird() {
  const view = renderView(
    <CharacterEditor bot={{ ...bot, characterId: paperBird.id }} name={bot.name} />,
  );
  return {
    click(label: string) {
      const button = Array.from(view.element.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === label,
      );
      if (!button) throw new Error(`Missing preview control: ${label}`);
      act(() => button.click());
    },
    caption: () => view.element.querySelector(".character-caption")?.textContent,
  };
}
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

it("previews the full conversation using the selected character's action durations", () => {
  vi.useFakeTimers();
  const preview = previewPaperBird();
  expect(preview.caption()).toBe("等你回答");
  preview.click(t.previewConversation);
  expect(preview.caption()).toBe("思考");
  tick(1450);
  expect(preview.caption()).toBe("等你回答");
  tick(1800);
  expect(preview.caption()).toBe("答案已送达");
  tick(paperBird.actions.received.durationMs);
  expect(preview.caption()).toBe("报告就绪");
  tick(paperBird.actions.report.durationMs);
  expect(preview.caption()).toBe("待命");
});

it("cancels the demo and an in-flight gesture on manual selections", () => {
  vi.useFakeTimers();
  const preview = previewPaperBird();
  preview.click(t.previewConversation);
  preview.click("收翼休息");
  tick(3000);
  expect(preview.caption()).toBe("收翼休息");
  preview.click("扇翅");
  expect(preview.caption()).toBe("扇翅");
  preview.click(wink.label);
  tick(3000);
  expect(preview.caption()).toBe("等你回答");
  preview.click(t.previewConversation);
  preview.click(t.stopPreview);
  tick(3000);
  expect(preview.caption()).toBe("待命");
});

it("preserves an uninstalled ID through unrelated edits and supports explicitly restoring the default", async () => {
  expect(botCharacter({ ...bot, system: "primary" })).toBe(wink);
  expect(botCharacter({ ...bot, system: "primary", characterId: "unknown" })).toBe(wink);
  expect(botCharacter({ ...bot, characterId: "unknown" })).toBeUndefined();
  expect(botInitial("👩🏽‍💻研究")).toBe("👩🏽‍💻");
  const saved = { ...bot, characterId: "future/ink" };
  const view = renderView(
    <form>
      <CharacterEditor bot={saved} name={bot.name} />
    </form>,
  );
  const form = new FormData(view.element.querySelector("form") ?? undefined);
  for (const [key, value] of Object.entries({
    name: bot.name,
    description: bot.description,
    instance: "local",
    model: "fixture",
    cwd: bot.cwd,
    mcp: "[]",
  }))
    form.set(key, value);
  expect(form.get("characterId")).toBe("future/ink");
  expect(view.element.querySelector(".character-monogram")?.textContent).toBe("研");
  expect((await Effect.runPromise(readBotForm(form, saved))).characterId).toBe("future/ink");
  form.delete("characterId");
  expect((await Effect.runPromise(readBotForm(form, saved))).characterId).toBe("future/ink");
  form.set("characterId", "");
  expect(await Effect.runPromise(readBotForm(form, saved))).toEqual(bot);
  form.set("characterId", paperBird.id);
  expect((await Effect.runPromise(readBotForm(form, saved))).characterId).toBe(paperBird.id);
});

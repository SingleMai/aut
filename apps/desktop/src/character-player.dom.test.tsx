// @vitest-environment happy-dom
import {
  type CharacterDefinition,
  CharacterPlayer,
  characters,
  conversationActions,
  conversationStates,
  createCharacterRegistry,
  ReducedCharacterMotion,
} from "@aut/characters";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";

const cloud: CharacterDefinition = {
  id: "cloud",
  label: "Cloud",
  states: { ...conversationStates, sleeping: { label: "Sleeping" } },
  Render: ({ state, action, animate }) => (
    <img alt="" src={`/${action ?? state}.png`} data-moving={String(animate)} />
  ),
  actions: { ...conversationActions, wave: { label: "Wave", durationMs: 400 } },
};
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("plays a registered image character's custom action once over the latest state", () => {
  vi.useFakeTimers();
  const registry = createCharacterRegistry([...characters.list, cloud]);
  expect(registry.get("cloud")).toBe(cloud);
  expect(characters.get("cloud")).toBeUndefined();
  const ended = vi.fn();
  const two = (state: string, key: number) => (
    <>
      <CharacterPlayer
        character={cloud}
        state={state}
        event={{ name: "wave", key }}
        onActionEnd={ended}
      />
      <CharacterPlayer character={cloud} state="question" />
    </>
  );
  const view = renderView(two("question", 1));
  const poses = () =>
    Array.from(view.element.querySelectorAll("img"), (img) => img.getAttribute("src"));
  expect(poses()).toEqual(["/wave.png", "/question.png"]);
  tick(300);
  view.update(two("sleeping", 1));
  tick(100);
  expect(poses()).toEqual(["/sleeping.png", "/question.png"]);
  expect(ended).toHaveBeenCalledExactlyOnceWith({ name: "wave", key: 1 });
  view.update(two("idle", 1));
  expect(poses()).toEqual(["/idle.png", "/question.png"]);
  view.update(two("idle", 2));
  tick(200);
  view.update(two("idle", 3));
  tick(200);
  expect(poses()[0]).toBe("/wave.png");
  tick(200);
  expect(ended.mock.calls.map(([event]) => event.key)).toEqual([1, 3]);
  view.update(two("idle", 4));
  view.dispose();
  tick(400);
  expect(ended).toHaveBeenCalledTimes(2);
});

it("shows a timed still with reduced motion and ignores unsupported actions", () => {
  vi.useFakeTimers();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  vi.spyOn(media, "matches", "get").mockReturnValue(true);
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const view = renderView(
    <CharacterPlayer character={cloud} state="question" event={{ name: "wave", key: 1 }} />,
  );
  const img = () => view.element.querySelector("img");
  expect(img()?.getAttribute("src")).toBe("/wave.png");
  expect(img()?.dataset.moving).toBe("false");
  tick(400);
  expect(img()?.getAttribute("src")).toBe("/question.png");
  view.update(
    <CharacterPlayer character={cloud} state="thinking" event={{ name: "toString", key: 2 }} />,
  );
  expect(img()?.getAttribute("src")).toBe("/thinking.png");
});

it("switches an active gesture to a still without restarting its feedback timer", () => {
  vi.useFakeTimers();
  const ended = vi.fn();
  const render = (reduce: boolean) => (
    <ReducedCharacterMotion value={reduce}>
      <CharacterPlayer
        character={cloud}
        state="thinking"
        event={{ name: "wave", key: 1 }}
        onActionEnd={ended}
      />
    </ReducedCharacterMotion>
  );
  const view = renderView(render(false));
  expect(view.element.querySelector("img")?.dataset.moving).toBe("true");
  tick(250);
  view.update(render(true));
  expect(view.element.querySelector("img")?.dataset.moving).toBe("false");
  expect(view.element.querySelector("img")?.getAttribute("src")).toBe("/wave.png");
  tick(150);
  expect(ended).toHaveBeenCalledExactlyOnceWith({ name: "wave", key: 1 });
  expect(view.element.querySelector("img")?.getAttribute("src")).toBe("/thinking.png");
});

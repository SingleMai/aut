// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderView } from "../test/render.js";
import { MessageActions } from "./message-actions.js";

function find<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}
function fire(node: EventTarget, event: Event) {
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}
async function tick() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
function key(key: string, isComposing = false) {
  return fire(
    document.activeElement ?? document.body,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing }),
  );
}
const context = (node: HTMLElement, x = 70, y = 30) =>
  fire(
    node,
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
function fixture(side: "user" | "bot" = "bot") {
  const quote = vi.fn(() => find("textarea").focus());
  const copy = vi.fn();
  renderView(
    <>
      <article>
        <MessageActions
          side={side}
          menu={[
            { key: "quote", label: "Quote", icon: null, onSelect: quote },
            { key: "copy", label: "Copy", icon: null, onSelect: copy },
          ]}
        >
          <span>Some text</span>
          <a href="#sample">Sample report</a>
          <button type="button">Choose</button>
        </MessageActions>
      </article>
      <textarea aria-label="Composer" />
    </>,
  );
  const trigger = find<HTMLButtonElement>("[aria-haspopup=menu]");
  const bubble = find("[data-chat-bubble]");
  const press = () =>
    fire(
      trigger,
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
  return { trigger, bubble, quote, copy, press };
}
afterEach(async () => {
  await tick();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe("conversation message menu", () => {
  it("opens from the bubble and restores the action button on Escape", async () => {
    const { trigger, bubble } = fixture();
    expect(context(bubble).defaultPrevented).toBe(true);
    const menu = find("[role=menu]");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(
      ["Quote", "Copy"],
    );
    expect(find("article").contains(menu)).toBe(false);
    key("Escape");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(menu.isConnected).toBe(false);
  });
  it.each([
    ["bot", "start"],
    ["user", "end"],
  ] as const)("aligns the %s menu to its action button", async (side, align) => {
    const { trigger, press } = fixture(side);
    press();
    const menu = find("[role=menu]");
    expect(menu.dataset.align).toBe(align);
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    key("Escape");
    await tick();
  });
  it("preserves the native context menu for controls, selections and the row outside the bubble", () => {
    const { bubble } = fixture();
    for (const target of [find("article"), find("a"), find("[data-chat-bubble] button")])
      expect(context(target).defaultPrevented).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(bubble);
    window.getSelection()?.addRange(range);
    expect(context(bubble).defaultPrevented).toBe(false);
    expect(document.querySelector("[role=menu]")).toBeNull();
  });
  it("wraps keyboard focus and returns it on Escape without invoking an action", async () => {
    const { trigger, quote, copy } = fixture();
    act(() => trigger.focus());
    key("ArrowDown");
    const [first, last] = document.querySelectorAll("[role=menuitem]");
    expect(first).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(first));
    for (const [name, item] of [
      ["ArrowUp", last],
      ["ArrowDown", first],
      ["End", last],
      ["Home", first],
    ] as const) {
      key(name);
      await tick();
      await vi.waitFor(() => expect(document.activeElement).toBe(item));
    }
    key("Escape", true);
    expect(find("[role=menu]")).toBeTruthy();
    key("Escape");
    await tick();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(quote).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
  it("keeps focus on the quote destination and closes on outside press and feed scroll", async () => {
    const { press, bubble, quote, copy } = fixture();
    press();
    act(() => find("[role=menuitem]").click());
    expect(quote).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.querySelector("[role=menu]")).toBeNull());
    expect(document.activeElement).toBe(find("textarea"));
    press();
    // The library attaches its document-level outside listener after the opening press.
    await tick();
    fire(
      find("textarea"),
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    );
    expect(document.querySelector("[role=menu]")).toBeNull();
    context(bubble);
    fire(find("article"), new Event("scroll"));
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(copy).not.toHaveBeenCalled();
  });
});

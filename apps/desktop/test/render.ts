import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { DesktopTheme } from "../src/ui/theme.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted = new Set<() => void>();
export function renderView(
  content: ReactNode,
  element: HTMLElement = document.createElement("div"),
) {
  if (!element.isConnected) document.body.append(element);
  const root = createRoot(element);
  const update = (next: ReactNode) =>
    act(() => root.render(createElement(DesktopTheme, null, next)));
  const dispose = () => {
    act(() => root.unmount());
    element.remove();
    mounted.delete(dispose);
  };
  mounted.add(dispose);
  update(content);
  return { element, update, dispose };
}
afterEach(() => {
  for (const dispose of mounted) dispose();
});

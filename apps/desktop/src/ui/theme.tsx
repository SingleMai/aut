import { Theme } from "@radix-ui/themes";
import { type ReactNode, useLayoutEffect, useSyncExternalStore } from "react";

export type DesktopAppearance = "system" | "light" | "dark";
const query = "(prefers-color-scheme: dark)";
const systemDark = () => window.matchMedia?.(query).matches ?? false;
function subscribe(notify: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}

export function DesktopTheme({
  children,
  appearance = "system",
}: {
  children: ReactNode;
  appearance?: DesktopAppearance;
}) {
  const dark = useSyncExternalStore(subscribe, systemDark, () => false);
  const resolved = appearance === "system" ? (dark ? "dark" : "light") : appearance;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = resolved;
    return () => {
      delete root.dataset.appearance;
    };
  }, [resolved]);
  return (
    <Theme
      appearance={resolved}
      accentColor="teal"
      grayColor="sand"
      radius="large"
      panelBackground="solid"
    >
      {children}
    </Theme>
  );
}

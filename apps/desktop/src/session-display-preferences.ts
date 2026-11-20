// Adapted from OpenMausBot src/lib/interface-mode.ts (Apache-2.0), commit
// 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// aut persists only renderer display preferences; session history remains daemon-owned.
export type DisplayOption = "advanced" | "showToolCalls";
const defaults = { advanced: false, showToolCalls: true };
export function createDisplayPreferences(storage: () => Pick<Storage, "getItem" | "setItem">) {
  const choices: Partial<Record<DisplayOption, boolean>> = {};
  const listeners = new Set<() => void>();
  const key = (option: DisplayOption) => `aut-session-display-${option}`;
  return {
    read(option: DisplayOption): boolean {
      if (choices[option] !== undefined) return choices[option];
      try {
        const stored = storage().getItem(key(option));
        if (stored === "1" || stored === "0") return stored === "1";
      } catch {
        /* Session choices still work when storage is unavailable. */
      }
      return defaults[option];
    },
    set(option: DisplayOption, value: boolean) {
      choices[option] = value;
      try {
        storage().setItem(key(option), value ? "1" : "0");
      } catch {
        /* Memory fallback. */
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export const sessionDisplay = createDisplayPreferences(() => window.localStorage);

// Copied from OpenMausBot, src/lib/place.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: extract place types, label and tool-surface mappings; server capability selection stays outside this UI island.
import type { LocaleKey } from "../locales.js";
import { toolSurfaceKind } from "../shared/tool-surface.js";

export type Place = "cloud" | "vm" | "local" | "browser";
export const PLACES: readonly Place[] = ["cloud", "vm", "local", "browser"];
export type EffectivePlace = Place | "auto" | "off";

export function isComputerPlace(place: EffectivePlace): place is "cloud" | "vm" | "local" {
  return place === "cloud" || place === "vm" || place === "local";
}

/** The place a tool belongs to, which is independent of the conversation's pin for browser tools. */
export function toolPlace(toolName: string, effective: EffectivePlace): Place | null {
  const kind = toolSurfaceKind(toolName);
  if (kind === "browser") return "browser";
  if (kind === "computer") return isComputerPlace(effective) ? effective : null;
  return null;
}

export function placeLabelKey(place: EffectivePlace): LocaleKey {
  return `place.${place}` as LocaleKey;
}

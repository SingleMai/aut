// Copied from OpenMausBot, src/components/PlaceIcon.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local ESM imports and UI ports only; render/hook logic and class names retained.
import { Box, Cloud, Globe, type LucideProps, Monitor, Power, Sparkles } from "lucide-react";
import type { EffectivePlace } from "../lib/place.js";

const ICONS = {
  cloud: Cloud,
  vm: Box,
  local: Monitor,
  browser: Globe,
  auto: Sparkles,
  off: Power,
} as const;

export function PlaceIcon({ place, ...props }: { place: EffectivePlace } & LucideProps) {
  const Icon = ICONS[place];
  return <Icon {...props} />;
}

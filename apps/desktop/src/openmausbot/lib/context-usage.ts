// Adapted from OpenMausBot src/lib/{context-usage,usage}.ts, Apache-2.0.
// Copyright 2026 Milind Soni and contributors. Commit 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc.
// Only native context readings and token formatting are retained. See NOTICE.
export interface ContextReading {
  tokens: number;
  window?: number;
  percent?: number;
  tone: "quiet" | "warning" | "danger";
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function contextReading(tokens: unknown, window: unknown): ContextReading | null {
  if (!positive(tokens)) return null;
  const size = positive(window) ? window : undefined;
  const percent = size ? Math.min(999, Math.round((tokens / size) * 100)) : undefined;
  return {
    tokens,
    ...(size === undefined ? {} : { window: size }),
    ...(percent === undefined ? {} : { percent }),
    tone: percent === undefined || percent < 50 ? "quiet" : percent < 80 ? "warning" : "danger",
  };
}

const trim = (value: number) =>
  value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  return `${trim(value / 1_000_000)}M`;
}

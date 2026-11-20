// biome-ignore-all lint/style/noNonNullAssertion: Preserve upstream index and optional-field guards.
// Copied from OpenMausBot (Apache-2.0), src/lib/i18n.ts.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Formatting functions retained; aut uses static scoped catalogs and its own product name. See NOTICE.
import { en, type LocaleKey, type LocalePack, locales } from "../locales.js";

export function resolveLocale(tag: string | undefined, available: ReadonlySet<string>): string {
  if (!tag) return "en";
  let candidate = tag.toLowerCase();
  while (candidate) {
    if (available.has(candidate)) return candidate;
    const separator = candidate.lastIndexOf("-");
    if (separator < 0) break;
    candidate = candidate.slice(0, separator);
  }
  return "en";
}

let active = "zh";
let activePack: LocalePack = locales.zh ?? en;

export function setLocale(tag: string | undefined): string {
  const resolved = resolveLocale(tag, new Set(Object.keys(locales)));
  activePack = locales[resolved] ?? en;
  active = resolved;
  return resolved;
}

export function documentLanguage(code: string): string {
  return code
    .split("-")
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part.length === 2
          ? part.toUpperCase()
          : part.length === 4
            ? part[0]!.toUpperCase() + part.slice(1).toLowerCase()
            : part.toLowerCase(),
    )
    .join("-");
}

export function activeLocale(): string {
  return active;
}

export function intlLocale(system: string | undefined = globalThis.navigator?.language): string {
  const tag = documentLanguage(active);
  if (tag.includes("-") || !system) return tag;
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(system)[0];
  } catch {
    return tag;
  }
  return canonical?.toLowerCase().split("-")[0] === tag ? canonical : tag;
}

export function tFromServer(
  key: string | undefined,
  fallback: string,
  params?: Record<string, string | number>,
): string;
export function tFromServer(
  key: string | undefined,
  fallback: string | undefined,
  params?: Record<string, string | number>,
): string | undefined;
export function tFromServer(
  key: string | undefined,
  fallback: string | undefined,
  params?: Record<string, string | number>,
): string | undefined {
  if (!key || !Object.hasOwn(en, key)) return fallback;
  const template = activePack[key as LocaleKey] ?? en[key as LocaleKey];
  const unfilled = [...template.matchAll(/\{(\w+)\}/g)].some(
    ([, name]) => !params || !Object.hasOwn(params, name!),
  );
  return unfilled ? fallback : t(key as LocaleKey, params);
}

export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = activePack[key] ?? en[key];
  if (!params && !template.includes("{app}")) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : name === "app" ? "aut" : match,
  );
}

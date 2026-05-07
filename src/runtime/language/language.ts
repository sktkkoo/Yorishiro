export type AppLanguage = "auto" | "en" | "ja";
export type ResolvedLanguage = "en" | "ja";

export const DEFAULT_LANGUAGE: AppLanguage = "auto";

export function toAppLanguage(value: unknown): AppLanguage {
  return value === "auto" || value === "en" || value === "ja" ? value : DEFAULT_LANGUAGE;
}

function normalizeLocales(
  locales: readonly string[] | string | null | undefined,
): readonly string[] {
  if (typeof locales === "string") return locales ? [locales] : [];
  return locales ?? [];
}

export function detectLanguage(
  locales: readonly string[] | string | null | undefined,
): ResolvedLanguage {
  const [first] = normalizeLocales(locales);
  return first?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function resolveLanguage(
  configured: AppLanguage,
  locales?: readonly string[] | string | null,
): ResolvedLanguage {
  if (configured === "en" || configured === "ja") return configured;
  return detectLanguage(locales);
}

export function getBrowserLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [];
}

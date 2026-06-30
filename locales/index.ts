// i18n barrel — results page UI strings
// Usage: import { LangCode, TRANSLATIONS, getTranslation } from "../locales";

import { en } from "./en";
import { he } from "./he";
import { ru } from "./ru";
import { es } from "./es";

export type LangCode = "en" | "he" | "ru" | "es";

/** Merged translation map — one record per supported language. */
export const TRANSLATIONS: Record<LangCode, Record<string, string>> = {
  en,
  he,
  ru,
  es,
};

/**
 * Look up a UI string for the given language.
 * Falls back to English if the key is missing in the target language,
 * and falls back to the key itself if missing in English too.
 */
export function getTranslation(lang: LangCode, key: string): string {
  return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
}

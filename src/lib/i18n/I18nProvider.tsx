import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ar, dictionaries, en, type Language, type TranslationKey } from "./dictionary";

const STORAGE_KEY = "alyq.lang";

/** ES2020-safe `{{var}}` interpolation. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{{${k}}}`).join(String(v)),
    template,
  );
}

export interface I18nContextValue {
  lang: Language;
  dir: "rtl" | "ltr";
  isRTL: boolean;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  /** Translate a key, with optional {{var}} interpolation. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  /** Pick a pluralised key (products.count / products.count_other). */
  tPlural: (
    base: string,
    count: number,
    vars?: Record<string, string | number>,
  ) => string;
  /** Pick the correct field of a bilingual pair for the active language. */
  pick: (arabic: string | null | undefined, english: string | null | undefined) => string;
  /** Format a money amount using the active language. */
  money: (value: number | null | undefined) => string;
  /** Format an ISO date using the active language. */
  date: (value: string | null | undefined) => string;
  /** Format a number using the active language. */
  num: (value: number | null | undefined, digits?: number) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectInitialLang(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav?.toLowerCase().startsWith("ar") ? "ar" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => detectInitialLang());

  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = dir;
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang, dir]);

  const setLang = useCallback((next: Language) => setLangState(next), []);
  const toggleLang = useCallback(
    () => setLangState((prev) => (prev === "ar" ? "en" : "ar")),
    [],
  );

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const table = lang === "ar" ? ar : en;
      return interpolate(table[key] ?? en[key] ?? String(key), vars);
    },
    [lang],
  );

  const tPlural = useCallback(
    (base: string, count: number, vars?: Record<string, string | number>) => {
      const table = lang === "ar" ? ar : en;
      const key = (count === 1 ? `${base}` : `${base}_other`) as TranslationKey;
      const chosen = (table[key] ?? en[key] ?? table[base as TranslationKey] ?? base) as string;
      return interpolate(chosen, { count, ...(vars ?? {}) });
    },
    [lang],
  );

  const pick = useCallback(
    (arabic: string | null | undefined, english: string | null | undefined) => {
      const value = lang === "ar" ? arabic || english : english || arabic;
      return value ?? "—";
    },
    [lang],
  );

  const money = useCallback(
    (value: number | null | undefined) => {
      const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
      const locale = lang === "ar" ? "ar-EG" : "en-US";
      const currency = (import.meta.env.VITE_CURRENCY || "EGP").toUpperCase();
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: 2,
          minimumFractionDigits: 2,
          numberingSystem: lang === "ar" ? "latn" : undefined,
        } as Intl.NumberFormatOptions).format(amount);
      } catch {
        return `${amount.toFixed(2)} ${currency}`;
      }
    },
    [lang],
  );

  const date = useCallback(
    (value: string | null | undefined) => {
      if (!value) return "—";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return "—";
      const locale = lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
      try {
        return new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          numberingSystem: "latn",
        } as Intl.DateTimeFormatOptions).format(parsed);
      } catch {
        return parsed.toISOString().slice(0, 16).replace("T", " ");
      }
    },
    [lang],
  );

  const num = useCallback(
    (value: number | null | undefined, digits = 2) => {
      const amount = typeof value === "number" && Number.isFinite(value) ? value : 0;
      const locale = lang === "ar" ? "ar-EG-u-nu-latn" : "en-US";
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits: digits,
        minimumFractionDigits: 0,
      }).format(amount);
    },
    [lang],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      dir,
      isRTL: dir === "rtl",
      setLang,
      toggleLang,
      t,
      tPlural,
      pick,
      money,
      date,
      num,
    }),
    [lang, dir, setLang, toggleLang, t, tPlural, pick, money, date, num],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export type { TranslationKey, Language };
export { dictionaries };

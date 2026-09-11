import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import alyqLogoUrl from "@/assets/alyq-logo.png";

/**
 * Public storefront layout — no sidebar, no admin chrome.
 * Branding: ALYQ logo + tagline, language switcher, back-to-POS link.
 */
export function StorefrontLayout({ children }: { children: ReactNode }) {
  const { t, lang, toggleLang } = useI18n();

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/store" className="flex items-center gap-3">
            <img src={alyqLogoUrl} alt="" className="h-10 w-10 rounded-xl" />
            <div>
              <p className="text-sm font-bold text-slate-900">{t("app.name")}</p>
              <p className="text-[11px] font-medium text-slate-500">{t("app.tagline")}</p>
            </div>
          </Link>

          <nav className="flex items-center gap-3">
            <Link
              to="/store"
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              {t("storefront.home")}
            </Link>
            <Link
              to="/store/products"
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              {t("storefront.allProducts")}
            </Link>
            <button
              onClick={toggleLang}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
              aria-label={t("mode.switch")}
            >
              {lang === "ar" ? "English" : "العربية"}
            </button>
            <Link
              to="/login"
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-700"
            >
              {t("auth.signIn")}
            </Link>
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-xs text-slate-500">
        <p>
          © {new Date().getFullYear()} {t("app.name")} — {t("app.tagline")}
        </p>
      </footer>
    </div>
  );
}

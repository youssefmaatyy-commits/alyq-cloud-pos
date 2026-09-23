/**
 * The chrome every public auth screen shares: logo, language switch, one card.
 *
 * The login screen predates this and is deliberately left alone — `scripts/auth.flow.mjs`
 * drives it by DOM structure, and reshaping it to fit a helper would put a
 * working, tested screen at risk for no functional gain. The two recovery screens
 * are new, so they start from the shared shell.
 */
import type { ReactNode } from "react";
import { Button, Card, GlobeIcon } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import alyqLogoUrl from "@/assets/alyq-logo.png";

export function AuthScreen({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t, lang, setLang, dir } = useI18n();

  return (
    <div dir={dir} className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={alyqLogoUrl} alt="" className="h-10 w-10 rounded-xl" />
            <div>
              <p className="text-sm font-bold text-slate-900">{t("app.name")}</p>
              <p className="text-[11px] font-medium text-slate-600">{t("app.tagline")}</p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            aria-label={t("mode.switch")}
          >
            <GlobeIcon className="h-4 w-4" />
            {lang === "ar" ? "English" : "العربية"}
          </Button>
        </div>

        <Card>
          <div className="mb-4">
            <h1 className="text-lg font-bold text-slate-900">{title}</h1>
            {subtitle ? <p className="mt-1 text-xs text-slate-600">{subtitle}</p> : null}
          </div>
          {children}
        </Card>

        {footer ? <div className="mt-4 text-center text-[11px] text-slate-500">{footer}</div> : null}
      </div>
    </div>
  );
}

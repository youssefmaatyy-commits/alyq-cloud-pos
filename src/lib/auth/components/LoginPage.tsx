import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Card, Field, GlobeIcon, TextInput } from "@/components/ui";
import { DEMO_CREDENTIAL_HINT, DEMO_PASSWORD } from "../demoUsers";
import { useAuth } from "../hooks/AuthProvider";
import { resolveNextTarget } from "./RequireAuth";
import type { AuthErrorCode } from "../types";
import alyqLogoUrl from "@/assets/alyq-logo.png";
import { brandDisplayName, useBrand } from "@/lib/branding/brand";

/**
 * Login screen.
 *
 * Deliberately outside the app shell: no sidebar, and no module provider is
 * mounted while it is on screen, so nothing loads business data before a
 * session exists. It is bilingual (EN/AR) like the rest of the app and reuses
 * the shared form controls, so no new design language is introduced.
 *
 * Accounts come from the user repository — this component never knows a
 * username or a password of its own.
 */
export function LoginPage() {
  const { t, lang, setLang, dir } = useI18n();
  // The shared brand (Phase 46) — one source with the sidebar, dashboard and
  // receipts; the shipped ALYQ asset is the fallback when nothing is set.
  const brand = useBrand();
  const { signIn, status, error, endReason, clearError, mode } = useAuth();
  const [params] = useSearchParams();
  const next = resolveNextTarget(params.get("next"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // A fresh form should not inherit the previous failure.
  useEffect(() => {
    clearError();
  }, [clearError]);

  if (status === "authenticated") {
    return <Navigate to={next} replace />;
  }

  const message = errorMessage(error, t);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!username.trim() || !password) return;
    setSubmitting(true);
    try {
      // Persistence is the secure default on every ALYQ runtime. The provider
      // owns refresh-token rotation; the login form never chooses a weaker,
      // tab-only session and never stores the password.
      await signIn({ username, password });
    } finally {
      // Cleared on every path, not just the happy one. A refused credential is
      // handled inside `signIn` and shown on the form; anything that *rejects*
      // used to leave this button spinning forever with no message — and this is
      // the one screen where a wedged control means nobody can get in at all.
      setSubmitting(false);
    }
  }

  return (
    <div
      dir={dir}
      className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10"
    >
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              src={brand?.logoUrl ?? alyqLogoUrl}
              alt=""
              className="h-10 w-10 rounded-xl object-contain"
              data-testid="login-brand-logo"
            />
            <div>
              <p className="text-sm font-bold text-slate-900" data-testid="login-brand-name">
                {brand ? brandDisplayName(brand, lang) : t("app.name")}
              </p>
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
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <h1 className="text-lg font-bold text-slate-900">{t("auth.login.title")}</h1>
              <p className="mt-1 text-xs text-slate-600">{t("auth.login.subtitle")}</p>
            </div>

            {endReason === "expired" ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                {t("auth.sessionExpired")}
              </p>
            ) : null}
            {endReason === "signed_out" ? (
              <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
                {t("auth.signedOut")}
              </p>
            ) : null}
            {message ? (
              <p
                role="alert"
                className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
              >
                {message}
              </p>
            ) : null}

            <Field
              label={t("auth.username")}
              required
              error={submitted && !username.trim() ? t("auth.error.usernameRequired") : undefined}
            >
              <TextInput
                value={username}
                autoComplete="username"
                autoFocus
                dir="ltr"
                aria-label={t("auth.username")}
                invalid={submitted && !username.trim()}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (error) clearError();
                }}
                placeholder="admin"
              />
            </Field>

            <Field
              label={t("auth.password")}
              required
              error={submitted && !password ? t("auth.error.passwordRequired") : undefined}
            >
              <TextInput
                type="password"
                value={password}
                autoComplete="current-password"
                dir="ltr"
                aria-label={t("auth.password")}
                invalid={submitted && !password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) clearError();
                }}
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? t("auth.signingIn") : t("auth.signIn")}
            </Button>

            {/* Recovery is offered on the screen where its absence is felt. It is
                a link rather than a button so the flow's "click Sign in" step
                still finds exactly one sign-in control. */}
            <p className="text-center text-xs font-semibold">
              <Link to="/forgot-password" className="text-indigo-700 underline-offset-2 hover:underline">
                {t("auth.forgot.link")}
              </Link>
            </p>
          </form>

          {mode === "demo" ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                {t("auth.demoAccounts")}
              </p>
              <p className="mt-1 text-[11px] text-slate-600">
                {DEMO_CREDENTIAL_HINT.map((entry) => entry.username).join(" · ")}
              </p>
              <p className="mt-1 text-[11px] text-slate-600">
                {t("auth.demoPassword")}: <span className="font-mono font-bold">{DEMO_PASSWORD}</span>
              </p>
            </div>
          ) : null}
        </Card>

        <p className="mt-4 text-center text-[11px] text-slate-500">
          {mode === "supabase" ? t("mode.liveHint") : t("mode.demoHint")}
        </p>
      </div>
    </div>
  );
}

/** Map a coded failure to a translated message (never a raw string from the auth layer). */
function errorMessage(
  code: AuthErrorCode | null,
  t: (key: Parameters<ReturnType<typeof useI18n>["t"]>[0]) => string,
): string | null {
  if (!code) return null;
  if (code === "missing_username") return t("auth.error.usernameRequired");
  if (code === "missing_password") return t("auth.error.passwordRequired");
  if (code === "network") return t("auth.error.network");
  // Abuse resistance, not a credential verdict: it names no account and gives
  // the one instruction that helps — wait, then try again.
  if (code === "rate_limited") return t("auth.error.rate_limited");
  // A deactivated account is told the truth: "incorrect password" would send the
  // person back to a form that can never succeed, and to a manager who cannot
  // work out why. It reveals only that the account exists and is switched off,
  // which an employee is entitled to know about their own.
  if (code === "user_inactive") return t("auth.error.user_inactive");
  return t("auth.error.invalid");
}

import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { Button, Field, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { resetPageUrl } from "../services/recoveryUrl";
import { useAuth } from "../hooks/AuthProvider";
import { AuthScreen } from "./AuthScreen";
import type { PasswordResetErrorCode } from "../types";

/**
 * "I forgot my password."
 *
 * One field, one answer, and the answer is the same whether or not the account
 * exists. That is not vagueness for its own sake: a form that says "no such user"
 * is a directory of who works here, and Supabase deliberately answers
 * identically, so this screen would be the only place that leaked it.
 *
 * Offline there is no mail server, and the screen says so instead of pretending a
 * link was sent — the recovery path in demo mode is an admin reset from
 * Settings → Users, and telling the truth about that is more useful than a
 * fake success message.
 */
export function ForgotPasswordPage() {
  const { t } = useI18n();
  const { requestPasswordReset, status, mode } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: true; channel: "email" | "demo" } | { ok: false; code: PasswordResetErrorCode } | null
  >(null);

  // Somebody who is already signed in does not need a link: the reset page will
  // take the session they have.
  if (status === "authenticated") return <Navigate to="/reset-password" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!identifier.trim()) return;
    setSubmitting(true);
    try {
      // The link comes back to this app, on the reset route. Built from the
      // current origin so a preview host, a LAN address and production all work.
      setOutcome(await requestPasswordReset(identifier, resetPageUrl()));
    } finally {
      setSubmitting(false);
    }
  }

  const message =
    outcome && !outcome.ok
      ? t(`auth.forgot.error.${outcome.code}` as Parameters<typeof t>[0])
      : null;

  return (
    <AuthScreen
      title={t("auth.forgot.title")}
      subtitle={t("auth.forgot.subtitle")}
      footer={
        <Link to="/login" className="font-bold text-indigo-700 underline-offset-2 hover:underline">
          {t("auth.forgot.backToLogin")}
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {outcome?.ok ? (
          <p
            role="status"
            className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900"
          >
            {outcome.channel === "demo" ? t("auth.forgot.successDemo") : t("auth.forgot.successEmail")}
          </p>
        ) : null}

        {message ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            {message}
          </p>
        ) : null}

        <Field
          label={t("auth.forgot.label")}
          required
          hint={mode === "supabase" ? t("auth.forgot.hint") : t("auth.forgot.successDemo")}
          error={submitted && !identifier.trim() ? t("auth.forgot.error.missing_identifier") : undefined}
        >
          <TextInput
            value={identifier}
            dir="ltr"
            autoFocus
            autoComplete="username"
            aria-label={t("auth.forgot.label")}
            invalid={submitted && !identifier.trim()}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="admin"
          />
        </Field>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? t("auth.forgot.submitting") : t("auth.forgot.submit")}
        </Button>
      </form>
    </AuthScreen>
  );
}

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Field, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { evaluatePassword } from "../services/passwordPolicy";
import { useAuth } from "../hooks/AuthProvider";
import { AuthScreen } from "./AuthScreen";
import { PasswordField } from "./PasswordField";

/**
 * Signed-in self-service password change — the mirror of the recovery flow:
 *
 *   · /reset-password asks for NO current password, because the emailed,
 *     single-use recovery link was the authority for it.
 *   · this page asks for THE CURRENT password, because the authority here is
 *     just a session somebody could have walked up to. The re-proof runs
 *     through the repository's `changePassword`, which re-verifies credentials
 *     with the same machinery a daily login uses — so a wrong current password
 *     changes nothing, and a deactivated account is refused outright.
 *
 * Recovery state is never touched from here: no URL material is read, the
 * consume-the-link path is never called, and the audit row records
 * `via: "current_password"` rather than `via: "recovery_link"`.
 */
export function ChangePasswordPage() {
  const { t } = useI18n();
  const { changePassword, status, user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // A session is the entry ticket; without one there is nothing to re-prove.
  if (status !== "authenticated") {
    return (
      <AuthScreen title={t("auth.change.title")}>
        <p role="status" className="rounded-xl bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">
          {t("auth.change.requiresSignIn")}
        </p>
        <div className="mt-4">
          <Link to="/login">
            <Button className="w-full">{t("auth.forgot.backToLogin")}</Button>
          </Link>
        </div>
      </AuthScreen>
    );
  }

  if (done) {
    return (
      <AuthScreen title={t("auth.change.title")}>
        <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
          {t("auth.change.success")}
        </p>
        <div className="mt-4">
          <Link to="/">
            <Button className="w-full">{t("common.backToDashboard")}</Button>
          </Link>
        </div>
      </AuthScreen>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setError(t("settings.users.error.password_mismatch"));
      return;
    }
    // The same policy the login-adjacent screens enforce — checked here so a
    // pileup is refused locally, and again by the provider/offline store.
    const verdict = evaluatePassword(next, user?.username);
    if (!verdict.ok) {
      const failed = verdict.rules.find((rule) => !rule.ok);
      setError(
        failed
          ? t(`settings.password.rule.${failed.key}` as Parameters<typeof t>[0])
          : t("auth.change.error.weak_password"),
      );
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const outcome = await changePassword(current, next);
      if (!outcome.ok) {
        setError(t(`auth.change.error.${outcome.code}` as Parameters<typeof t>[0]));
        return;
      }
      setDone(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AuthScreen
      title={t("auth.change.title")}
      subtitle={user ? `${t("auth.signedInAs")} ${user.name} — ${t("auth.change.subtitle")}` : t("auth.change.subtitle")}
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
        {error ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            {error}
          </p>
        ) : null}

        <Field label={t("auth.change.current")} required>
          <TextInput
            type="password"
            value={current}
            dir="ltr"
            autoComplete="current-password"
            aria-label={t("auth.change.current")}
            required
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>

        <PasswordField
          value={next}
          username={user?.username}
          onChange={setNext}
          label={t("settings.users.form.password")}
        />

        <Field label={t("settings.users.form.confirmPassword")} required>
          <TextInput
            type="password"
            value={confirm}
            autoComplete="new-password"
            required
            invalid={Boolean(confirm) && confirm !== next}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        <Button type="submit" className="w-full" disabled={saving || !current}>
          {saving ? t("auth.change.submitting") : t("auth.change.submit")}
        </Button>
      </form>
    </AuthScreen>
  );
}

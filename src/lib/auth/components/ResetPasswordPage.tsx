import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, LoadingBlock, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { consumePasswordRecoveryLink } from "../services/authService";
import { readRecoveryParts, recoveryParams } from "../services/recoveryUrl";
import { useAuth } from "../hooks/AuthProvider";
import { AuthScreen } from "./AuthScreen";
import { PasswordField } from "./PasswordField";
import type { PasswordResetErrorCode } from "../types";

type Phase = "checking" | "ready" | "failed" | "done";

/**
 * The page a reset link lands on.
 *
 * It has three jobs, in this order:
 *
 *   1. Consume the link. Whatever the provider put in the URL — a PKCE `?code=`
 *      or an implicit-flow `#access_token=…&type=recovery` — is handed to
 *      `consumePasswordRecoveryLink`, which exchanges it for a session. Until
 *      that succeeds there is no form, because a password field on a page with no
 *      recovery session is a field that cannot work.
 *   2. Let the person choose a new password, against the same policy an admin
 *      meets when creating an account.
 *   3. Say plainly when the link is no good. Expired, already used, or opened in
 *      a browser the provider does not recognise all report the same thing,
 *      because the only action available is "request a new one" — and because
 *      distinguishing them would tell a stranger how close they got.
 *
 * Auditing happens in `AuthProvider.updatePassword` (`user.password_changed`),
 * not here: the screen reports, the service records.
 */
export function ResetPasswordPage() {
  const { t } = useI18n();
  const { updatePassword, mode, user } = useAuth();
  const [phase, setPhase] = useState<Phase>("checking");
  const [failure, setFailure] = useState<PasswordResetErrorCode | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const consumed = useRef(false);

  // Read the URL once. React StrictMode mounts effects twice in development, and
  // exchanging a single-use code twice would fail the second time and report a
  // good link as expired.
  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    void (async () => {
      const parts = readRecoveryParts();
      const params = recoveryParams(parts);

      // The provider can also refuse in the URL itself (`error=access_denied`).
      if (params.get("error")) {
        setFailure("expired");
        setPhase("failed");
        return;
      }

      const result = await consumePasswordRecoveryLink(parts);
      if (!result.ok) {
        setFailure(result.code);
        setPhase("failed");
        return;
      }
      setPhase("ready");
    })();
  }, []);

  async function onSubmit() {
    if (password !== confirm) {
      setError(t("settings.users.error.password_mismatch"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const outcome = await updatePassword(password);
      if (!outcome.ok) {
        setError(t(`auth.reset.error.${outcome.code}` as Parameters<typeof t>[0]));
        return;
      }
      setPhase("done");
    } finally {
      setSaving(false);
    }
  }

  const backToLogin = (
    <Link to="/login" className="font-bold text-indigo-700 underline-offset-2 hover:underline">
      {t("auth.reset.backToLogin")}
    </Link>
  );

  if (phase === "checking") {
    return (
      <AuthScreen title={t("auth.reset.title")} subtitle={t("auth.reset.subtitle")}>
        <LoadingBlock label={t("common.loading")} />
      </AuthScreen>
    );
  }

  if (phase === "failed") {
    return (
      <AuthScreen title={t("auth.reset.title")} footer={backToLogin}>
        <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          {t(`auth.reset.error.${failure ?? "expired"}` as Parameters<typeof t>[0])}
        </p>
        <div className="mt-4">
          {/* The way out of a dead link is a new one, so it is offered here rather
              than leaving the person to find the login screen and hunt for it. */}
          <Link to="/forgot-password">
            <Button variant="secondary" className="w-full">
              {t("auth.forgot.submit")}
            </Button>
          </Link>
        </div>
      </AuthScreen>
    );
  }

  if (phase === "done") {
    return (
      <AuthScreen title={t("auth.reset.title")} footer={backToLogin}>
        <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
          {t("auth.reset.success")}
        </p>
        <div className="mt-4">
          <Link to="/">
            <Button className="w-full">{t("common.backToDashboard")}</Button>
          </Link>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={t("auth.reset.title")}
      subtitle={user ? `${t("auth.signedInAs")} ${user.name}` : t("auth.reset.subtitle")}
      footer={backToLogin}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit();
        }}
      >
        {error ? (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            {error}
          </p>
        ) : null}

        <PasswordField
          value={password}
          username={user?.username}
          onChange={setPassword}
          label={t("settings.users.form.password")}
        />

        <Field label={t("settings.users.form.confirmPassword")} required>
          <TextInput
            type="password"
            value={confirm}
            autoComplete="new-password"
            invalid={Boolean(confirm) && confirm !== password}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        {mode === "demo" ? (
          <p className="text-xs font-medium text-slate-600">{t("auth.reset.demoNotice")}</p>
        ) : null}

        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? t("auth.reset.submitting") : t("auth.reset.submit")}
        </Button>
      </form>
    </AuthScreen>
  );
}

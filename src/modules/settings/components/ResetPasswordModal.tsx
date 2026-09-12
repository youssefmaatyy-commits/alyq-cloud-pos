import { useEffect, useState } from "react";
import { Button, Field, Modal, TextInput } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth/hooks/AuthProvider";
import { evaluatePassword } from "@/lib/auth/services/passwordPolicy";
import { PasswordField } from "@/lib/auth/components/PasswordField";
import type { ManagedUser } from "../types";

export interface ResetPasswordModalProps {
  open: boolean;
  user: ManagedUser | null;
  onClose: () => void;
  onSubmit: (password: string, confirmPassword: string) => Promise<void>;
}

/**
 * An administrator setting somebody else's password.
 *
 * Kept separate from the user form on purpose. It is a privileged, auditable act
 * (`user.password_reset`), it needs the policy checklist in front of the person
 * typing, and burying it in a general edit dialog is how an admin overwrites a
 * password they meant to leave alone.
 *
 * Live mode sends the value to the `alyq-admin` edge function, which hands it to
 * `auth.admin.updateUserById`; offline it becomes a fresh salt and digests in the
 * directory. Either way the password itself is written to no log and no audit
 * entry — only the fact that it was reset, by whom.
 */
export function ResetPasswordModal({ open, user, onClose, onSubmit }: ResetPasswordModalProps) {
  const { t } = useI18n();
  const { mode } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setConfirm("");
    setError(null);
    setSaving(false);
  }, [open, user]);

  async function submit() {
    const verdict = evaluatePassword(password, user?.username);
    if (!verdict.ok) {
      const failed = verdict.rules.find((rule) => !rule.ok);
      setError(t(`settings.password.rule.${failed?.key ?? "length"}` as Parameters<typeof t>[0]));
      return;
    }
    if (password !== confirm) {
      setError(t("settings.users.error.password_mismatch"));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit(password, confirm);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings.users.reset.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !user}>
            {saving ? t("common.saving") : t("settings.users.reset.button")}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {user ? (
          <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
            {t("settings.users.reset.body", { name: `${user.name} (${user.username})` })}
          </p>
        ) : null}

        <PasswordField
          value={password}
          username={user?.username}
          onChange={setPassword}
          error={error && !confirm ? error : undefined}
          label={t("settings.users.form.password")}
        />

        <Field
          label={t("settings.users.form.confirmPassword")}
          required
          error={error && confirm ? error : undefined}
        >
          <TextInput
            type="password"
            value={confirm}
            autoComplete="new-password"
            invalid={Boolean(error) && Boolean(confirm)}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>

        {mode === "demo" ? (
          <p className="text-xs font-medium text-slate-600">{t("settings.users.demoNotice")}</p>
        ) : null}
      </form>
    </Modal>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Button, Field, Modal, SelectInput, TextInput, ToggleSwitch } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { useAuth } from "@/lib/auth/hooks/AuthProvider";
import { APP_ROLES } from "@/lib/permissions/roles";
import type { CustomRole } from "@/lib/permissions/customRoles";
import { PasswordField } from "@/lib/auth/components/PasswordField";
import { roleLabel } from "./UserStatusBadge";
import { validateUserForm } from "../validation";
import { EMPTY_USER_FORM, type ManagedUser, type UserFormState } from "../types";

export interface UserFormModalProps {
  open: boolean;
  /** Null when creating. */
  editing: ManagedUser | null;
  existing: ManagedUser[];
  roles: CustomRole[];
  onClose: () => void;
  onSubmit: (form: UserFormState) => Promise<void>;
}

export function formFromUser(user: ManagedUser | null): UserFormState {
  if (!user) return { ...EMPTY_USER_FORM };
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email ?? "",
    phone: user.phone ?? "",
    role: user.role,
    custom_role_id: user.custom_role_id,
    active: user.active,
    password: "",
    confirmPassword: "",
  };
}

/**
 * Create or edit one account.
 *
 * The password fields appear only when they mean something: on create (a new
 * account needs one) and never on edit — changing somebody's password is a
 * separate, deliberate act with its own dialog and its own audit entry, not a
 * field an admin might overwrite by accident while fixing a phone number.
 *
 * The form validates with the same function the service uses, so what the admin
 * sees refused here is what the service would refuse too.
 */
export function UserFormModal({ open, editing, existing, roles, onClose, onSubmit }: UserFormModalProps) {
  const { t } = useI18n();
  const { user: actor, mode } = useAuth();
  const [form, setForm] = useState<UserFormState>(() => formFromUser(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(formFromUser(editing));
    setErrors({});
    setSaving(false);
  }, [open, editing]);

  const requirePassword = !editing;
  const isSelf = Boolean(actor && editing && actor.id === editing.id);
  const assignableRoles = useMemo(() => roles.filter((role) => role.active), [roles]);

  const errorFor = (field: string) => {
    const key = errors[field];
    return key ? t(key as Parameters<typeof t>[0]) : undefined;
  };

  async function submit() {
    const verdict = validateUserForm(form, {
      mode,
      existing,
      roles,
      requirePassword,
    });
    if (!verdict.ok) {
      setErrors(verdict.errors as Record<string, string>);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await onSubmit(form);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? t("settings.users.form.titleEdit") : t("settings.users.form.titleCreate")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
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
        {isSelf ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {t("settings.users.selfWarning")}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("settings.users.form.name")} required error={errorFor("name")}>
            <TextInput
              value={form.name}
              invalid={Boolean(errors.name)}
              autoComplete="off"
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
            />
          </Field>
          <Field
            label={t("settings.users.form.username")}
            required
            hint={t("settings.users.form.usernameHint")}
            error={errorFor("username")}
          >
            <TextInput
              value={form.username}
              invalid={Boolean(errors.username)}
              autoComplete="off"
              dir="ltr"
              onChange={(event) => setForm((f) => ({ ...f, username: event.target.value }))}
            />
          </Field>
          <Field
            label={t("settings.users.form.email")}
            required={mode === "supabase"}
            hint={mode === "supabase" ? t("settings.users.form.emailRequiredHint") : t("settings.users.form.emailHint")}
            error={errorFor("email")}
            optional={mode === "supabase" ? false : t("common.optional")}
          >
            <TextInput
              type="email"
              value={form.email}
              dir="ltr"
              invalid={Boolean(errors.email)}
              autoComplete="off"
              onChange={(event) => setForm((f) => ({ ...f, email: event.target.value }))}
            />
          </Field>
          <Field label={t("settings.users.form.phone")} error={errorFor("phone")} optional={t("common.optional")}>
            <TextInput
              type="tel"
              value={form.phone}
              dir="ltr"
              invalid={Boolean(errors.phone)}
              autoComplete="off"
              onChange={(event) => setForm((f) => ({ ...f, phone: event.target.value }))}
            />
          </Field>
          <Field label={t("settings.users.form.role")} required hint={t("settings.users.form.roleHint")} error={errorFor("role")}>
            <SelectInput
              value={form.role}
              invalid={Boolean(errors.role)}
              onChange={(event) =>
                setForm((f) => ({
                  ...f,
                  role: event.target.value as UserFormState["role"],
                  // A hand-picked system role and an overlay would contradict each
                  // other, so choosing one clears the other — the same rule the
                  // SQL RPC applies.
                  custom_role_id: null,
                }))
              }
            >
              <option value="">{t("settings.users.error.role")}</option>
              {APP_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(t, role)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field
            label={t("settings.users.form.customRole")}
            hint={t("settings.users.form.customRoleHint")}
            error={errorFor("custom_role_id")}
            optional={t("common.optional")}
          >
            <SelectInput
              value={form.custom_role_id ?? ""}
              invalid={Boolean(errors.custom_role_id)}
              onChange={(event) => {
                const id = event.target.value || null;
                const chosen = roles.find((role) => role.id === id);
                setForm((f) => ({
                  ...f,
                  custom_role_id: id,
                  // The overlay carries its own base role; showing that in the
                  // system-role select keeps the two from disagreeing on screen.
                  role: chosen ? chosen.base_role : f.role,
                }));
              }}
            >
              <option value="">{t("settings.users.form.customRoleNone")}</option>
              {assignableRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name_en}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {requirePassword ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <PasswordField
              value={form.password}
              username={form.username}
              error={errorFor("password")}
              label={t("settings.users.form.password")}
              onChange={(value) => setForm((f) => ({ ...f, password: value }))}
            />
            <Field label={t("settings.users.form.confirmPassword")} required error={errorFor("confirmPassword")}>
              <TextInput
                type="password"
                value={form.confirmPassword}
                autoComplete="new-password"
                invalid={Boolean(errors.confirmPassword)}
                onChange={(event) => setForm((f) => ({ ...f, confirmPassword: event.target.value }))}
              />
            </Field>
          </div>
        ) : null}

        <ToggleSwitch
          checked={form.active}
          // An admin cannot deactivate themselves; the switch says so rather than
          // letting the service refuse it after a round trip.
          disabled={isSelf}
          onChange={(active) => setForm((f) => ({ ...f, active }))}
          label={t("settings.users.form.active")}
          hint={t("settings.users.form.activeHint")}
        />
      </form>
    </Modal>
  );
}

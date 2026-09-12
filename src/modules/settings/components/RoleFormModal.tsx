import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Field, Modal, SelectInput, TextInput, TextArea, ToggleSwitch } from "@/components/ui";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { APP_ROLES, capabilitiesOf, type AppRole, type Capability } from "@/lib/permissions/roles";
import { CUSTOM_ROLE_PRESETS, normalizeRoleKey, type CustomRole } from "@/lib/permissions/customRoles";
import { PermissionPicker } from "./PermissionPicker";
import { roleLabel } from "./UserStatusBadge";
import { validateRoleForm } from "../validation";
import { EMPTY_ROLE_FORM, type RoleFormState } from "../types";

export interface RoleFormModalProps {
  open: boolean;
  editing: CustomRole | null;
  existing: CustomRole[];
  onClose: () => void;
  onSubmit: (form: RoleFormState) => Promise<void>;
}

export function formFromRole(role: CustomRole | null): RoleFormState {
  if (!role) return { ...EMPTY_ROLE_FORM, capabilities: [] };
  return {
    id: role.id,
    key: role.key,
    name_en: role.name_en,
    name_ar: role.name_ar,
    description_en: role.description_en ?? "",
    description_ar: role.description_ar ?? "",
    base_role: role.base_role,
    capabilities: [...role.capabilities],
    active: role.active,
  };
}

/**
 * Create or edit a custom role.
 *
 * Three ways in, because "start from nothing" is almost never what an admin
 * actually wants:
 *   · a preset (Sales Manager, Accountant, …) fills the form in one click;
 *   · choosing a base role offers "start from this role's permissions";
 *   · the picker itself, grouped by area, for the exact list.
 *
 * The key is generated from the name and shown, but not editable after creation:
 * it is what audit entries and stored assignments refer to, and `custom_roles.key`
 * is unique for that reason.
 */
export function RoleFormModal({ open, editing, existing, onClose, onSubmit }: RoleFormModalProps) {
  const { t, lang } = useI18n();
  const [form, setForm] = useState<RoleFormState>(() => formFromRole(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(formFromRole(editing));
    setErrors({});
    setSaving(false);
  }, [open, editing]);

  const presets = useMemo(() => CUSTOM_ROLE_PRESETS, []);
  const generatedKey = form.key || normalizeRoleKey(form.name_en);

  const errorFor = (field: string) => {
    const key = errors[field];
    return key ? t(key as Parameters<typeof t>[0]) : undefined;
  };

  function applyPreset(preset: (typeof CUSTOM_ROLE_PRESETS)[number]) {
    setForm((current) => ({
      ...current,
      // Only fill what the admin has not typed: a preset is a starting point, not
      // an overwrite of work already done.
      key: current.key || normalizeRoleKey(preset.name_en),
      name_en: current.name_en || preset.name_en,
      name_ar: current.name_ar || preset.name_ar,
      base_role: preset.base_role,
      capabilities: [...preset.capabilities],
    }));
    setErrors({});
  }

  function startFromBase(base: AppRole) {
    setForm((current) => ({ ...current, base_role: base, capabilities: capabilitiesOf(base) as Capability[] }));
  }

  async function submit() {
    const verdict = validateRoleForm(form, { existing });
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
      title={editing ? t("settings.roles.form.titleEdit") : t("settings.roles.form.titleCreate")}
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
        {!editing ? (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-indigo-900">{t("settings.roles.presets.title")}</p>
              <span className="text-[11px] font-medium text-indigo-700">{t("settings.roles.presets.hint")}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.presetKey}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 text-xs font-bold text-indigo-800 shadow-sm transition hover:bg-indigo-100"
                >
                  {lang === "ar" ? preset.name_ar : preset.name_en}
                  <span className="ms-1 font-medium text-slate-500">· {preset.capabilities.length}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("settings.roles.form.name_en")} required error={errorFor("name_en")} dir="ltr">
            <TextInput
              value={form.name_en}
              dir="ltr"
              invalid={Boolean(errors.name_en)}
              onChange={(event) =>
                setForm((f) => ({
                  ...f,
                  name_en: event.target.value,
                  key: f.id ? f.key : normalizeRoleKey(event.target.value),
                }))
              }
            />
          </Field>
          <Field label={t("settings.roles.form.name_ar")} required error={errorFor("name_ar")} dir="rtl">
            <TextInput
              value={form.name_ar}
              dir="rtl"
              invalid={Boolean(errors.name_ar)}
              onChange={(event) => setForm((f) => ({ ...f, name_ar: event.target.value }))}
            />
          </Field>
          <Field label={t("settings.roles.form.description_en")} optional={t("common.optional")} dir="ltr">
            <TextArea
              rows={2}
              dir="ltr"
              value={form.description_en}
              onChange={(event) => setForm((f) => ({ ...f, description_en: event.target.value }))}
            />
          </Field>
          <Field label={t("settings.roles.form.description_ar")} optional={t("common.optional")} dir="rtl">
            <TextArea
              rows={2}
              dir="rtl"
              value={form.description_ar}
              onChange={(event) => setForm((f) => ({ ...f, description_ar: event.target.value }))}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t("settings.roles.form.base_role")}
            required
            hint={t("settings.roles.form.baseRoleHint")}
            error={errorFor("base_role")}
          >
            <SelectInput
              value={form.base_role ?? ""}
              invalid={Boolean(errors.base_role)}
              onChange={(event) => {
                const base = (event.target.value || null) as AppRole | null;
                setForm((f) => ({ ...f, base_role: base }));
              }}
            >
              {APP_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(t, role)}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={t("settings.roles.col.key")} hint={t("settings.roles.form.keyHint")} error={errorFor("key")}>
            <div className="flex items-center gap-2">
              <TextInput
                value={form.id ? form.key : generatedKey}
                dir="ltr"
                readOnly={Boolean(form.id)}
                invalid={Boolean(errors.key)}
                onChange={(event) => setForm((f) => ({ ...f, key: normalizeRoleKey(event.target.value) }))}
              />
              {form.base_role ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => startFromBase(form.base_role as AppRole)}
                  title={t("settings.roles.form.baseRoleHint")}
                >
                  <Badge tone="neutral">{capabilitiesOf(form.base_role).length}</Badge>
                </Button>
              ) : null}
            </div>
          </Field>
        </div>

        <PermissionPicker
          value={form.capabilities}
          baseRole={form.base_role}
          error={errorFor("capabilities")}
          onChange={(capabilities) => setForm((f) => ({ ...f, capabilities }))}
        />

        <ToggleSwitch
          checked={form.active}
          onChange={(active) => setForm((f) => ({ ...f, active }))}
          label={t("settings.roles.form.active")}
          hint={t("settings.roles.form.activeHint")}
        />
      </form>
    </Modal>
  );
}

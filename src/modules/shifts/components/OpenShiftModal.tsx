import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, Modal, SelectInput, TextInput, useToast } from "@/components/ui";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { useBranch } from "@/lib/branch";
import { useRegister } from "@/modules/registers";
import { useShifts } from "../hooks/ShiftProvider";
import { EMPTY_SHIFT_FORM, SHIFT_REGISTERS, type ShiftFormValues } from "../types";
import { parseMoney, validateShiftDraft } from "../validation";

export interface OpenShiftModalProps {
  open: boolean;
  onClose: () => void;
}

export function OpenShiftModal({ open, onClose }: OpenShiftModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const { openShiftAction, canOpen } = useShifts();
  const branch = useBranch();
  const registerContext = useRegister();
  const user = getCurrentUser();

  const [values, setValues] = useState<ShiftFormValues>(EMPTY_SHIFT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues({
        ...EMPTY_SHIFT_FORM,
        branch: branch.current?.name_en ?? "",
        register: registerContext.state.register?.name ?? EMPTY_SHIFT_FORM.register,
      });
      setAttempted(false);
      setFormError(null);
    }
  }, [branch.current?.name_en, open, registerContext.state.register?.name]);

  const registerAllowsOpen = registerContext.state.kind === "web" || registerContext.state.kind === "desktop-ready";
  const errors = attempted ? validateShiftDraft(values) : {};
  const fieldError = (key: keyof ShiftFormValues): string | undefined =>
    errors[key] ? t(errors[key] as Parameters<typeof t>[0]) : undefined;

  async function submit() {
    setAttempted(true);
    const nextErrors = validateShiftDraft(values);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const shift = await openShiftAction({
        branch: values.branch.trim(),
        register: values.register,
        opening_cash: parseMoney(values.opening_cash),
      });
      toast.success(`${t("shifts.openedToast")} · ${shift.shift_number}`);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("shifts.openTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !canOpen || !registerAllowsOpen}>
            {submitting ? t("common.saving") : t("shifts.open")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
          {t("shifts.openHint")}
        </p>

        <Field label={t("shifts.cashier")}>
          <TextInput value={user.name} readOnly disabled />
        </Field>

        <Field label={t("shifts.branch")} required error={fieldError("branch")}>
          <TextInput
            value={values.branch}
            invalid={Boolean(errors.branch)}
            onChange={(e) => setValues((v) => ({ ...v, branch: e.target.value }))}
            placeholder={t("shifts.branchPlaceholder")}
            maxLength={80}
            readOnly={Boolean(branch.current)}
          />
        </Field>

        <Field label={t("shifts.register")} required error={fieldError("register")}>
          {registerContext.state.kind === "web" ? (
            <SelectInput
              value={values.register}
              invalid={Boolean(errors.register)}
              onChange={(e) => setValues((v) => ({ ...v, register: e.target.value }))}
            >
              {SHIFT_REGISTERS.map((register) => (
                <option key={register} value={register}>{register}</option>
              ))}
            </SelectInput>
          ) : (
            <TextInput value={registerContext.state.register?.name ?? registerContext.state.reason ?? ""} readOnly disabled />
          )}
        </Field>

        <Field
          label={t("shifts.openingCash")}
          required
          error={fieldError("opening_cash")}
          hint={t("shifts.openingCashHint")}
        >
          <TextInput
            value={values.opening_cash}
            invalid={Boolean(errors.opening_cash)}
            onChange={(e) => setValues((v) => ({ ...v, opening_cash: e.target.value }))}
            inputMode="decimal"
            dir="ltr"
            placeholder="0.00"
          />
        </Field>

        {formError ? (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</p>
        ) : null}
      </div>
    </Modal>
  );
}

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { Button, Field, Modal, SelectInput, TextArea, TextInput, useToast } from "@/components/ui";
import { useShifts } from "@/modules/shifts/hooks/ShiftProvider";
import {
  EMPTY_EXPENSE_FORM,
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type Expense,
  type ExpenseFormValues,
} from "../types";
import { MAX_EXPENSE_NAME, MAX_EXPENSE_NOTES, toDateTimeLocal, toSpentAtIso, validateExpense } from "../validation";
import { useExpenses } from "../hooks/ExpenseProvider";

export interface ExpenseFormModalProps {
  open: boolean;
  onClose: () => void;
  /** When set the modal edits this expense instead of creating a new one. */
  expense?: Expense | null;
}

export function ExpenseFormModal({ open, onClose, expense }: ExpenseFormModalProps) {
  const { t } = useI18n();
  const toast = useToast();
  const { addExpense, editExpense } = useExpenses();
  const { openShift } = useShifts();

  const [values, setValues] = useState<ExpenseFormValues>(EMPTY_EXPENSE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isEdit = Boolean(expense);

  useEffect(() => {
    if (!open) return;
    setAttempted(false);
    setFormError(null);
    if (expense) {
      setValues({
        name: expense.name,
        category: expense.category,
        amount: String(expense.amount),
        payment_method: expense.payment_method,
        spent_at: toDateTimeLocal(expense.spent_at),
        branch: expense.branch ?? "",
        notes: expense.notes ?? "",
        attachment_url: expense.attachment_url ?? "",
        attachment_name: expense.attachment_name ?? "",
      });
    } else {
      setValues({
        ...EMPTY_EXPENSE_FORM,
        branch: openShift?.branch ?? "",
        spent_at: toDateTimeLocal(new Date().toISOString()),
      });
    }
  }, [open, expense, openShift]);

  const result = attempted ? validateExpense(values) : { valid: false, errors: {}, amount: 0 };
  const fieldError = (key: keyof typeof result.errors, max?: number): string | undefined =>
    result.errors[key]
      ? t(result.errors[key] as Parameters<typeof t>[0], max ? { max } : undefined)
      : undefined;

  async function submit() {
    setAttempted(true);
    const check = validateExpense(values);
    if (!check.valid) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        name: values.name.trim(),
        category: values.category,
        amount: check.amount,
        payment_method: values.payment_method,
        spent_at: toSpentAtIso(values.spent_at),
        branch: values.branch.trim() || openShift?.branch || null,
        shift_id: openShift?.id ?? null,
        notes: values.notes.trim() || null,
        attachment_url: values.attachment_url.trim() || null,
        attachment_name: values.attachment_name.trim() || null,
      };
      if (expense) {
        const updated = await editExpense(expense.id, payload);
        toast.success(`${t("expenses.updatedToast")} · ${updated.expense_number}`);
      } else {
        const created = await addExpense(payload);
        toast.success(`${t("expenses.createdToast")} · ${created.expense_number}`);
      }
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
      size="lg"
      title={isEdit ? t("expenses.edit") : t("expenses.add")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p
          className={
            openShift
              ? "rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-800"
              : "rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900"
          }
        >
          {openShift
            ? `${t("expenses.openShiftHint")} · ${openShift.shift_number}`
            : t("expenses.noOpenShiftHint")}
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("expenses.name")} required error={fieldError("name", MAX_EXPENSE_NAME)}>
            <TextInput
              value={values.name}
              invalid={Boolean(result.errors.name)}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder={t("expenses.namePlaceholder")}
              maxLength={MAX_EXPENSE_NAME}
            />
          </Field>

          <Field label={t("expenses.category")} required error={fieldError("category")}>
            <SelectInput
              value={values.category}
              invalid={Boolean(result.errors.category)}
              onChange={(e) =>
                setValues((v) => ({ ...v, category: e.target.value as ExpenseFormValues["category"] }))
              }
            >
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`expenses.category.${category}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label={t("expenses.amount")} required error={fieldError("amount")}>
            <TextInput
              value={values.amount}
              invalid={Boolean(result.errors.amount)}
              onChange={(e) => setValues((v) => ({ ...v, amount: e.target.value }))}
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
            />
          </Field>

          <Field label={t("expenses.method")} required error={fieldError("payment_method")}>
            <SelectInput
              value={values.payment_method}
              invalid={Boolean(result.errors.payment_method)}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  payment_method: e.target.value as ExpenseFormValues["payment_method"],
                }))
              }
            >
              {EXPENSE_PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`pos.payment.${method}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label={t("expenses.date")} required>
            <TextInput
              type="datetime-local"
              value={values.spent_at}
              onChange={(e) => setValues((v) => ({ ...v, spent_at: e.target.value }))}
              dir="ltr"
            />
          </Field>

          <Field label={t("expenses.branch")}>
            <TextInput
              value={values.branch}
              onChange={(e) => setValues((v) => ({ ...v, branch: e.target.value }))}
              placeholder={t("shifts.branchPlaceholder")}
              maxLength={80}
            />
          </Field>
        </div>

        <Field label={t("expenses.notes")} error={fieldError("notes", MAX_EXPENSE_NOTES)}>
          <TextArea
            value={values.notes}
            invalid={Boolean(result.errors.notes)}
            onChange={(e) => setValues((v) => ({ ...v, notes: e.target.value }))}
            placeholder={t("expenses.notesPlaceholder")}
            rows={3}
            maxLength={MAX_EXPENSE_NOTES}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t("expenses.attachmentUrl")} hint={t("expenses.attachmentHint")}>
            <TextInput
              value={values.attachment_url}
              onChange={(e) => setValues((v) => ({ ...v, attachment_url: e.target.value }))}
              dir="ltr"
              placeholder="https://…"
            />
          </Field>
          <Field label={t("expenses.attachmentName")}>
            <TextInput
              value={values.attachment_name}
              onChange={(e) => setValues((v) => ({ ...v, attachment_name: e.target.value }))}
              placeholder="receipt-1234.jpg"
            />
          </Field>
        </div>

        {formError ? (
          <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</p>
        ) : null}
      </div>
    </Modal>
  );
}

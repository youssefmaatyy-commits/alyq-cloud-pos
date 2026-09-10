import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, type ExpenseFormValues } from "./types";

export const MAX_EXPENSE_NAME = 80;
export const MAX_EXPENSE_NOTES = 300;
export const MAX_EXPENSE_AMOUNT = 1_000_000;

export type ExpenseFieldCode =
  | "name"
  | "amount"
  | "category"
  | "payment_method"
  | "spent_at"
  | "notes";

export type ExpenseErrors = Partial<Record<ExpenseFieldCode, string>>;

export interface ExpenseValidationResult {
  valid: boolean;
  errors: ExpenseErrors;
  /** Parsed, rounded amount; 0 when invalid. */
  amount: number;
}

/** Round to 2 decimals (money). */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Validate an expense draft. Returns an i18n key per field, so the UI and the
 * repository can both produce the same message.
 */
export function validateExpense(values: ExpenseFormValues): ExpenseValidationResult {
  const errors: ExpenseErrors = {};
  const name = values.name.trim();
  const amount = roundMoney(Number(values.amount));

  if (!name) errors.name = "expenses.error.nameRequired";
  else if (name.length > MAX_EXPENSE_NAME) errors.name = "expenses.error.nameTooLong";

  if (!Number.isFinite(amount) || amount <= 0) errors.amount = "expenses.error.amountPositive";
  else if (amount > MAX_EXPENSE_AMOUNT) errors.amount = "expenses.error.amountTooLarge";

  if (!EXPENSE_CATEGORIES.includes(values.category)) {
    errors.category = "expenses.error.categoryInvalid";
  }
  if (!EXPENSE_PAYMENT_METHODS.includes(values.payment_method)) {
    errors.payment_method = "expenses.error.methodInvalid";
  }
  if (values.notes.trim().length > MAX_EXPENSE_NOTES) {
    errors.notes = "expenses.error.notesTooLong";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    amount: Number.isFinite(amount) ? amount : 0,
  };
}

/** Convert a form draft into the ISO timestamp stored on the record. */
export function toSpentAtIso(localValue: string): string {
  const trimmed = localValue.trim();
  if (!trimmed) return new Date().toISOString();
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** Convert an ISO timestamp into a value usable by <input type="datetime-local">. */
export function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

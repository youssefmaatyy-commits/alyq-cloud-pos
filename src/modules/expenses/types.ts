/**
 * Expenses module (Phase 8).
 *
 * A shop expense (transport, maintenance, supplies, other) paid from a
 * register. Expenses are attributed to a cashier shift by time window and, for
 * cash payments, reduce the expected cash in the drawer.
 */

/** Matches the POS payment methods so a refund/expense method is consistent. */
export const EXPENSE_PAYMENT_METHODS = ["cash", "instapay", "visa"] as const;
export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export const EXPENSE_CATEGORIES = [
  "transport",
  "maintenance",
  "supplies",
  "utilities",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface Expense {
  id: string;
  /** Human-readable sequential number, e.g. EXP-000001. */
  expense_number: string;
  /** Free-text name, e.g. "Delivery to Nasr City". */
  name: string;
  category: ExpenseCategory;
  amount: number;
  payment_method: ExpensePaymentMethod;
  /** ISO timestamp of when the expense happened (user-editable). */
  spent_at: string;
  notes: string | null;
  /** Optional attachment reference (data URL / storage path). */
  attachment_url: string | null;
  attachment_name: string | null;
  /** Branch the expense was paid from (null when no branch was selected). */
  branch: string | null;
  /** Shift the expense belongs to, when one was open. */
  shift_id: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
  updated_at: string;
}

export type NewExpense = Omit<Expense, "id" | "expense_number" | "created_at" | "updated_at">;
export type ExpensePatch = Partial<Omit<NewExpense, "user_id" | "user_name">>;

export interface ExpenseFormValues {
  name: string;
  category: ExpenseCategory;
  amount: string;
  payment_method: ExpensePaymentMethod;
  spent_at: string;
  branch: string;
  notes: string;
  /** Empty string = no attachment. */
  attachment_url: string;
  attachment_name: string;
}

export const EMPTY_EXPENSE_FORM: ExpenseFormValues = {
  name: "",
  category: "other",
  amount: "",
  payment_method: "cash",
  spent_at: "",
  branch: "",
  notes: "",
  attachment_url: "",
  attachment_name: "",
};

export interface ExpenseFiltersValue {
  search: string;
  category: ExpenseCategory | "all";
  method: ExpensePaymentMethod | "all";
  /**
   * Inclusive `yyyy-mm-dd` window on `spent_at`; `""` means unbounded on that
   * side. The reports' date picker produces exactly these strings, so the
   * expense screen and the expense report filter the same way — and the list,
   * the tiles and the export all read one filtered array.
   */
  from: string;
  to: string;
}

export const EMPTY_EXPENSE_FILTERS: ExpenseFiltersValue = {
  search: "",
  category: "all",
  method: "all",
  from: "",
  to: "",
};

/**
 * Cashier Shifts module — domain types (Phase 8).
 *
 * A shift is the accounting window a cashier works inside one branch/register:
 * it opens with a counted cash float and closes with a counted drawer. Every
 * sale, return, refund and expense that happens between those two instants
 * belongs to the shift and rolls into its Z-report summary.
 *
 * Design note — the summary is *derived*, never guessed:
 *   expected_cash = opening_cash + cash_sales − cash_refunds − cash_expenses
 * InstaPay / Visa never touch the drawer, so they are reported but excluded
 * from the expected-cash formula. The `summary` field is persisted on close
 * (a frozen snapshot for the Z-report) and recomputed live while open.
 */

export const SHIFT_STATUSES = ["open", "closed"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Full computed picture of a shift's money. */
export interface ShiftSummary {
  /** All non-voided sales created inside the window. */
  sales_count: number;
  sales_total: number;
  /** Voided sales inside the window — reported, never counted as revenue. */
  voided_count: number;
  voided_total: number;
  /**
   * List-price sales before discounts. Informational only — expected cash
   * uses already-net paid cash and never subtracts these again.
   */
  gross_sales: number;
  /** Invoice totals (net of discounts). Alias of sales_total, kept named. */
  net_sales: number;
  discounts_automatic: number;
  discounts_promo: number;
  discounts_manual_item: number;
  discounts_invoice: number;
  discounts_total: number;
  /** Cash applied to non-voided sales (drawer in). */
  cash_sales: number;
  /** Confirmed InstaPay applied to non-voided sales (no drawer impact). */
  instapay_sales: number;
  /** Confirmed Visa/card — reported, never in the drawer. */
  visa_sales: number;
  /** Other paid methods actually used (today: COD). Never in the drawer. */
  other_sales: number;
  /** InstaPay still awaiting confirmation — excluded from totals. */
  instapay_pending: number;
  /** Sales paid with more than one payment method. */
  mixed_count: number;
  mixed_total: number;
  /** Sales whose payments were split across methods, per-method breakdown. */
  payments_breakdown: { method: string; amount: number; count: number }[];

  returns_count: number;
  returns_total: number;
  refunds_count: number;
  /** Refunds actually paid out (status === completed). */
  refunds_total: number;
  /** Completed cash refunds — drawer out. */
  cash_refunds: number;
  instapay_refunds: number;
  visa_refunds: number;
  pending_refunds: number;

  expenses_count: number;
  expenses_total: number;
  /** Cash expenses — drawer out. */
  cash_expenses: number;
  instapay_expenses: number;
  visa_expenses: number;

  expected_cash: number;
  /** Only present once the cashier counted the drawer at close. */
  actual_cash: number | null;
  /** actual_cash − expected_cash (positive = over, negative = short). */
  difference: number | null;
}

export interface Shift {
  id: string;
  /** Human-readable sequential number, e.g. SH-000001. */
  shift_number: string;
  branch: string;
  register: string;
  status: ShiftStatus;
  opening_cash: number;
  opening_at: string;
  opened_by: string;
  opened_by_name: string;
  /** Closing cash counted in the drawer (null while open). */
  closing_cash: number | null;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  notes: string | null;
  /** Frozen summary snapshot taken at close (null while open). */
  summary: ShiftSummary | null;
  /** Cash-difference adjustment approved by a manager, if any. */
  adjustment_approved_by: string | null;
  adjustment_approved_by_name: string | null;
  adjustment_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewShift {
  branch: string;
  register: string;
  opening_cash: number;
  opening_at?: string;
  opened_by: string;
  opened_by_name: string;
}

export interface CloseShiftInput {
  /** Cash actually counted in the drawer. */
  closing_cash: number;
  notes?: string | null;
  closed_by: string;
  closed_by_name: string;
  closed_at?: string;
  /** Snapshot of everything the shift accumulated. */
  summary: ShiftSummary;
}

export interface ShiftFiltersValue {
  search: string;
  status: "all" | ShiftStatus;
}

export const EMPTY_SHIFT_FILTERS: ShiftFiltersValue = {
  search: "",
  status: "all",
};

export interface ShiftFormValues {
  branch: string;
  register: string;
  opening_cash: string;
}

export const EMPTY_SHIFT_FORM: ShiftFormValues = {
  branch: "",
  register: "Register 1",
  opening_cash: "",
};

export interface CloseShiftFormValues {
  closing_cash: string;
  notes: string;
}

export const EMPTY_CLOSE_SHIFT_FORM: CloseShiftFormValues = {
  closing_cash: "",
  notes: "",
};

/** Default registers offered when opening a shift. */
export const SHIFT_REGISTERS = ["Register 1", "Register 2", "Register 3"] as const;

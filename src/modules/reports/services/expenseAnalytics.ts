/**
 * Expense analytics — the same spending the Expenses screen shows, answered
 * three more ways: by category, by employee, and by day.
 *
 * Requirement 4 asks for expense reports over a date range. The module already
 * had the totals (`summarizeExpenses`, which the page's tiles read) and the raw
 * extract (`buildExpensesSheets`); what it did not have was a breakdown by the
 * person who filed the money, or a window to ask the question about. Both are
 * here, and the totals are *reused*, not recomputed — one arithmetic, three
 * presentations.
 *
 * The date a report is about is `spent_at`, not `created_at`: an expense filed
 * on Monday for a Sunday delivery belongs to Sunday, which is the day the money
 * left the drawer and the day the shift that paid it was open. That is also the
 * field the Expenses screen and the cash ledger already use, so this report and
 * those two agree about which day a cost happened on.
 */
import { roundMoney } from "@/modules/expenses/validation";
import { withinDateRange } from "@/lib/export";
import type { Expense, ExpenseCategory, ExpensePaymentMethod } from "@/modules/expenses/types";
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS } from "@/modules/expenses/types";
import { summarizeExpenses, type ExpenseSummary } from "@/modules/expenses/services/expenseService";
import { dayKeyOf } from "./salesAnalytics";
import type { DateRange } from "./financialExport";

/** One line of a breakdown: a category, an employee, a branch, a day. */
export interface ExpenseBreakdownRow {
  /** Stable key — a category id, a user id, a day. The caller translates it. */
  key: string;
  /** Human label as recorded (an employee's name, a branch). Empty for keys. */
  label: string;
  count: number;
  total: number;
  cash: number;
  instapay: number;
  visa: number;
  /** Percent of the report's total. */
  share: number;
  /** Average per entry — the number that separates a habit from an incident. */
  avg: number;
}

export interface ExpenseDayRow {
  date: string;
  count: number;
  total: number;
  /** Largest single expense that day, and what it was for. */
  largest: number;
  largestName: string;
}

export interface ExpenseReport {
  range: DateRange;
  /** The rows the report is about, already inside the window. */
  expenses: Expense[];
  /** Totals from `summarizeExpenses` — the same numbers the screen's tiles show. */
  totals: ExpenseSummary;
  byCategory: ExpenseBreakdownRow[];
  byEmployee: ExpenseBreakdownRow[];
  byMethod: ExpenseBreakdownRow[];
  byBranch: ExpenseBreakdownRow[];
  byDay: ExpenseDayRow[];
  /** Distinct days in the window that hold at least one expense. */
  activeDays: number;
  /** Total ÷ active days: what a working day costs the shop. */
  avgPerActiveDay: number;
  largest: Expense | null;
}

/** The expenses inside a window, by the day the money was spent. */
export function expensesInRange(expenses: readonly Expense[], range: DateRange): Expense[] {
  return expenses.filter((expense) => withinDateRange(expense.spent_at, range.from, range.to));
}

function breakdown(
  expenses: readonly Expense[],
  keyOf: (expense: Expense) => string,
  labelOf: (expense: Expense) => string,
  whole: number,
  order?: readonly string[],
): ExpenseBreakdownRow[] {
  const rows = new Map<string, ExpenseBreakdownRow>();

  for (const expense of expenses) {
    const key = keyOf(expense);
    const row =
      rows.get(key) ??
      ({
        key,
        label: labelOf(expense),
        count: 0,
        total: 0,
        cash: 0,
        instapay: 0,
        visa: 0,
        share: 0,
        avg: 0,
      } satisfies ExpenseBreakdownRow);
    row.count += 1;
    row.total = roundMoney(row.total + expense.amount);
    if (expense.payment_method === "cash") row.cash = roundMoney(row.cash + expense.amount);
    if (expense.payment_method === "instapay")
      row.instapay = roundMoney(row.instapay + expense.amount);
    if (expense.payment_method === "visa") row.visa = roundMoney(row.visa + expense.amount);
    rows.set(key, row);
  }

  const finished = [...rows.values()].map((row) => ({
    ...row,
    share: whole > 0 ? roundMoney((row.total / whole) * 100) : 0,
    avg: row.count > 0 ? roundMoney(row.total / row.count) : 0,
  }));

  // A known vocabulary (categories, methods) reads in the app's own order;
  // anything else reads biggest first, which is the order the question is asked in.
  if (order) {
    return finished.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return finished.sort((a, b) => b.total - a.total || b.count - a.count);
}

/** Every category the app knows, so a category with no spending still shows a zero. */
function byCategoryRows(expenses: readonly Expense[], whole: number): ExpenseBreakdownRow[] {
  const rows = breakdown(
    expenses,
    (expense) => expense.category,
    () => "",
    whole,
    EXPENSE_CATEGORIES as readonly string[],
  );
  const present = new Set(rows.map((row) => row.key));
  const empty = (EXPENSE_CATEGORIES as readonly string[])
    .filter((category) => !present.has(category))
    .map(
      (category) =>
        ({
          key: category,
          label: "",
          count: 0,
          total: 0,
          cash: 0,
          instapay: 0,
          visa: 0,
          share: 0,
          avg: 0,
        }) satisfies ExpenseBreakdownRow,
    );
  return [...rows, ...empty].sort(
    (a, b) =>
      (EXPENSE_CATEGORIES as readonly string[]).indexOf(a.key) -
      (EXPENSE_CATEGORIES as readonly string[]).indexOf(b.key),
  );
}

/** One row per day that holds spending, oldest first — the shape a trend draws. */
export function expensesByDay(expenses: readonly Expense[]): ExpenseDayRow[] {
  const days = new Map<string, ExpenseDayRow>();

  for (const expense of expenses) {
    const key = dayKeyOf(expense.spent_at);
    if (!key) continue;
    const row =
      days.get(key) ??
      ({ date: key, count: 0, total: 0, largest: 0, largestName: "" } satisfies ExpenseDayRow);
    row.count += 1;
    row.total = roundMoney(row.total + expense.amount);
    if (expense.amount > row.largest) {
      row.largest = expense.amount;
      row.largestName = expense.name;
    }
    days.set(key, row);
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** The whole expense report for a window, in one call. */
export function buildExpenseReport(
  expenses: readonly Expense[],
  range: DateRange,
): ExpenseReport {
  const inRange = expensesInRange(expenses, range);
  const totals = summarizeExpenses(inRange);
  const days = expensesByDay(inRange);
  const largest = inRange.reduce<Expense | null>(
    (best, expense) => (!best || expense.amount > best.amount ? expense : best),
    null,
  );

  return {
    range,
    expenses: inRange,
    totals,
    byCategory: byCategoryRows(inRange, totals.total),
    byEmployee: breakdown(
      inRange,
      (expense) => expense.user_id || "unknown",
      (expense) => expense.user_name || "—",
      totals.total,
    ),
    byMethod: breakdown(
      inRange,
      (expense) => expense.payment_method,
      () => "",
      totals.total,
      EXPENSE_PAYMENT_METHODS as readonly string[],
    ),
    byBranch: breakdown(
      inRange,
      (expense) => expense.branch || "__none__",
      (expense) => expense.branch ?? "",
      totals.total,
    ),
    byDay: days,
    activeDays: days.length,
    avgPerActiveDay: days.length > 0 ? roundMoney(totals.total / days.length) : 0,
    largest,
  };
}

/** Category keys the report can hold, for callers that build a filter from them. */
export const EXPENSE_REPORT_CATEGORIES: readonly ExpenseCategory[] = EXPENSE_CATEGORIES;
export const EXPENSE_REPORT_METHODS: readonly ExpensePaymentMethod[] = EXPENSE_PAYMENT_METHODS;

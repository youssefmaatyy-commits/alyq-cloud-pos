/**
 * Shift math — pure functions, no I/O.
 *
 * Everything a Z-report shows is derived here so the numbers are testable in
 * isolation and the same code path feeds the live dashboard, the close modal
 * and the frozen snapshot saved on close.
 */

import type { Sale } from "@/modules/pos/types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";
import { roundMoney } from "@/modules/expenses/validation";
import type { Shift, ShiftSummary } from "../types";

export interface ShiftWindow {
  start: string;
  /** Exclusive end; `null` = still open, i.e. "up to now". */
  end: string | null;
}

export interface ShiftSources {
  sales: Sale[];
  returns: SalesReturn[];
  refunds: RefundRecord[];
  expenses: Expense[];
}

export function shiftWindowOf(shift: Shift): ShiftWindow {
  return { start: shift.opening_at, end: shift.closed_at };
}

/** `start <= iso < end` (end is exclusive; `null` end = everything after start). */
export function isWithinWindow(iso: string, window: ShiftWindow): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const start = new Date(window.start).getTime();
  if (!Number.isNaN(start) && t < start) return false;
  if (window.end) {
    const end = new Date(window.end).getTime();
    if (!Number.isNaN(end) && t >= end) return false;
  }
  return true;
}

/**
 * An expense belongs to a shift when it is explicitly linked to it, or when it
 * was recorded inside the shift window with no link at all (expenses captured
 * before/outside an open shift). Explicitly linked expenses always win, so an
 * expense can never be counted by two shifts.
 */
export function expenseBelongsToShift(expense: Expense, shift: Shift, window: ShiftWindow): boolean {
  if (expense.shift_id) return expense.shift_id === shift.id;
  // Unlinked (legacy / non-shift) expenses fall back to the shift window.
  return isWithinWindow(expense.spent_at, window);
}

export function expectedCashOf(input: {
  opening_cash: number;
  cash_sales: number;
  cash_refunds: number;
  cash_expenses: number;
}): number {
  return roundMoney(
    input.opening_cash + input.cash_sales - input.cash_refunds - input.cash_expenses,
  );
}

/**
 * Roll every sale, return, refund and expense inside `shift`'s window into the
 * shift summary.
 *
 * Cash handling rules:
 *   - a sale only counts when it is not voided;
 *   - an InstaPay payment only counts once confirmed (`status === "paid"`);
 *     unconfirmed amounts are reported separately as `instapay_pending`;
 *   - a refund only leaves the drawer once it is `completed`;
 *   - only cash movements enter `expected_cash`.
 */
export function computeShiftSummary(
  shift: Shift,
  sources: ShiftSources,
  now: string = new Date().toISOString(),
): ShiftSummary {
  const window: ShiftWindow = {
    start: shift.opening_at,
    end: shift.closed_at ?? now,
  };

  const breakdown = new Map<string, { amount: number; count: number }>();
  let salesCount = 0;
  let salesTotal = 0;
  let voidedCount = 0;
  let voidedTotal = 0;
  let cashSales = 0;
  let instapaySales = 0;
  let instapayPending = 0;
  let mixedCount = 0;
  let mixedTotal = 0;

  for (const sale of sources.sales) {
    if (!isWithinWindow(sale.created_at, window)) continue;

    if (sale.status === "voided") {
      voidedCount += 1;
      voidedTotal += sale.total;
      continue;
    }

    salesCount += 1;
    salesTotal += sale.total;

    if (sale.payments.length > 1) {
      mixedCount += 1;
      mixedTotal += sale.total;
    }

    for (const payment of sale.payments) {
      const bucket = breakdown.get(payment.method) ?? { amount: 0, count: 0 };
      bucket.count += 1;
      if (payment.method === "cash") {
        bucket.amount += payment.amount;
        cashSales += payment.amount;
      } else if (payment.method === "instapay") {
        if (payment.status === "paid") {
          bucket.amount += payment.amount;
          instapaySales += payment.amount;
        } else {
          instapayPending += payment.amount;
        }
      } else {
        bucket.amount += payment.amount;
      }
      breakdown.set(payment.method, bucket);
    }
  }

  let returnsCount = 0;
  let returnsTotal = 0;
  for (const record of sources.returns) {
    if (!isWithinWindow(record.created_at, window)) continue;
    returnsCount += 1;
    returnsTotal += record.refund_amount;
  }

  let refundsCount = 0;
  let refundsTotal = 0;
  let cashRefunds = 0;
  let instapayRefunds = 0;
  let visaRefunds = 0;
  let pendingRefunds = 0;
  for (const refund of sources.refunds) {
    if (!isWithinWindow(refund.created_at, window)) continue;
    if (refund.status !== "completed") {
      pendingRefunds += refund.amount;
      continue;
    }
    refundsCount += 1;
    refundsTotal += refund.amount;
    if (refund.payment_method === "cash") cashRefunds += refund.amount;
    else if (refund.payment_method === "instapay") instapayRefunds += refund.amount;
    else visaRefunds += refund.amount;
  }

  let expensesCount = 0;
  let expensesTotal = 0;
  let cashExpenses = 0;
  let instapayExpenses = 0;
  let visaExpenses = 0;
  for (const expense of sources.expenses) {
    if (!expenseBelongsToShift(expense, shift, window)) continue;
    expensesCount += 1;
    expensesTotal += expense.amount;
    if (expense.payment_method === "cash") cashExpenses += expense.amount;
    else if (expense.payment_method === "instapay") instapayExpenses += expense.amount;
    else visaExpenses += expense.amount;
  }

  const opening = shift.opening_cash;
  const expectedCash = expectedCashOf({
    opening_cash: opening,
    cash_sales: cashSales,
    cash_refunds: cashRefunds,
    cash_expenses: cashExpenses,
  });

  const actualCash = shift.status === "closed" && shift.closing_cash !== null ? shift.closing_cash : null;

  return {
    sales_count: salesCount,
    sales_total: roundMoney(salesTotal),
    voided_count: voidedCount,
    voided_total: roundMoney(voidedTotal),
    cash_sales: roundMoney(cashSales),
    instapay_sales: roundMoney(instapaySales),
    instapay_pending: roundMoney(instapayPending),
    mixed_count: mixedCount,
    mixed_total: roundMoney(mixedTotal),
    payments_breakdown: [...breakdown.entries()]
      .map(([method, v]) => ({ method, amount: roundMoney(v.amount), count: v.count }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    returns_count: returnsCount,
    returns_total: roundMoney(returnsTotal),
    refunds_count: refundsCount,
    refunds_total: roundMoney(refundsTotal),
    cash_refunds: roundMoney(cashRefunds),
    instapay_refunds: roundMoney(instapayRefunds),
    visa_refunds: roundMoney(visaRefunds),
    pending_refunds: roundMoney(pendingRefunds),
    expenses_count: expensesCount,
    expenses_total: roundMoney(expensesTotal),
    cash_expenses: roundMoney(cashExpenses),
    instapay_expenses: roundMoney(instapayExpenses),
    visa_expenses: roundMoney(visaExpenses),
    expected_cash: expectedCash,
    actual_cash: actualCash,
    difference: actualCash === null ? null : roundMoney(actualCash - expectedCash),
  };
}

/** `actual − expected`; positive = drawer over, negative = drawer short. */
export function cashDifference(actual: number, expected: number): number {
  return roundMoney(actual - expected);
}

export type DifferenceTone = "neutral" | "success" | "danger" | "warning";

export function differenceTone(difference: number | null): DifferenceTone {
  if (difference === null) return "neutral";
  if (difference === 0) return "success";
  return Math.abs(difference) <= 5 ? "warning" : "danger";
}

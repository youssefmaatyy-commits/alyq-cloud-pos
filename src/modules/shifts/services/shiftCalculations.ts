/**
 * Shift math — pure functions, no I/O.
 *
 * Everything a Z-report shows is derived here so the numbers are testable in
 * isolation and the same code path feeds the live dashboard, the close modal
 * and the frozen snapshot saved on close.
 *
 * Expected cash (the drawer, never InstaPay / Visa / COD):
 *   opening_cash + cash_sales − cash_refunds − cash_expenses
 *
 * Discounts are reported in their own buckets. They are not subtracted from
 * expected cash: cash_sales is already the net amount paid into the drawer.
 */

import type { Sale, SaleItem } from "@/modules/pos/types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";
import { roundMoney } from "@/modules/expenses/validation";
import { lineListAmount } from "@/modules/reports/services/profitability";
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
 * Till sales carry `shift_id` (migration 0040). When it is set, that is the
 * authority — a sale cannot land in two drawers. Online-channel sales without
 * a till shift never enter a cashier Z-report. Legacy POS rows without
 * `shift_id` still fall back to the opening/close window.
 */
export function saleBelongsToShift(sale: Sale, shift: Shift, window: ShiftWindow): boolean {
  if (sale.shift_id) return sale.shift_id === shift.id;
  if ((sale.source ?? "pos") === "online") return false;
  return isWithinWindow(sale.created_at, window);
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

function money(n: number): number {
  return roundMoney(n);
}

/** Four discount buckets that never double-count, matching Phase 53. */
export function saleDiscountBuckets(sale: Sale): {
  gross: number;
  automatic: number;
  promo: number;
  manualItem: number;
  invoice: number;
} {
  const invoice = money(Number(sale.discount_amount || 0));
  if (!sale.items.length) {
    const automatic = money(Number(sale.automatic_discount_amount ?? 0));
    const manualItem = money(Number(sale.item_discount_amount ?? 0));
    return {
      gross: money(sale.total + automatic + manualItem + invoice),
      automatic,
      promo: 0,
      manualItem,
      invoice,
    };
  }
  let gross = 0;
  let automatic = 0;
  let manualItem = 0;
  for (const item of sale.items as SaleItem[]) {
    gross = money(gross + lineListAmount(item));
    automatic = money(automatic + Number(item.automatic_discount_amount ?? 0));
    manualItem = money(manualItem + Number(item.discount_amount ?? 0));
  }
  return { gross, automatic, promo: 0, manualItem, invoice };
}

/**
 * Fill fields a frozen close snapshot written before Phase 54 does not have.
 * Never recomputes expected cash — historical numbers stay as they were stored.
 */
export function padShiftSummary(raw: ShiftSummary): ShiftSummary {
  const net = raw.net_sales ?? raw.sales_total;
  const automatic = raw.discounts_automatic ?? 0;
  const promo = raw.discounts_promo ?? 0;
  const manualItem = raw.discounts_manual_item ?? 0;
  const invoice = raw.discounts_invoice ?? 0;
  const discountsTotal = raw.discounts_total ?? money(automatic + promo + manualItem + invoice);
  return {
    ...raw,
    gross_sales: raw.gross_sales ?? raw.sales_total,
    net_sales: net,
    discounts_automatic: automatic,
    discounts_promo: promo,
    discounts_manual_item: manualItem,
    discounts_invoice: invoice,
    discounts_total: discountsTotal,
    visa_sales: raw.visa_sales ?? 0,
    other_sales: raw.other_sales ?? 0,
  };
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
  let grossSales = 0;
  let discountsAutomatic = 0;
  let discountsPromo = 0;
  let discountsManualItem = 0;
  let discountsInvoice = 0;
  let voidedCount = 0;
  let voidedTotal = 0;
  let cashSales = 0;
  let instapaySales = 0;
  let visaSales = 0;
  let otherSales = 0;
  let instapayPending = 0;
  let mixedCount = 0;
  let mixedTotal = 0;

  for (const sale of sources.sales) {
    if (!saleBelongsToShift(sale, shift, window)) continue;

    if (sale.status === "voided") {
      voidedCount += 1;
      voidedTotal += sale.total;
      continue;
    }

    salesCount += 1;
    salesTotal += sale.total;
    const buckets = saleDiscountBuckets(sale);
    grossSales = money(grossSales + buckets.gross);
    discountsAutomatic = money(discountsAutomatic + buckets.automatic);
    discountsPromo = money(discountsPromo + buckets.promo);
    discountsManualItem = money(discountsManualItem + buckets.manualItem);
    discountsInvoice = money(discountsInvoice + buckets.invoice);

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
      } else if (payment.method === "visa") {
        if (payment.status === "paid") {
          bucket.amount += payment.amount;
          visaSales += payment.amount;
        }
      } else if (payment.status === "paid") {
        bucket.amount += payment.amount;
        otherSales += payment.amount;
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
  const discountsTotal = money(
    discountsAutomatic + discountsPromo + discountsManualItem + discountsInvoice,
  );

  return {
    sales_count: salesCount,
    sales_total: money(salesTotal),
    gross_sales: money(grossSales),
    net_sales: money(salesTotal),
    discounts_automatic: discountsAutomatic,
    discounts_promo: discountsPromo,
    discounts_manual_item: discountsManualItem,
    discounts_invoice: discountsInvoice,
    discounts_total: discountsTotal,
    voided_count: voidedCount,
    voided_total: money(voidedTotal),
    cash_sales: money(cashSales),
    instapay_sales: money(instapaySales),
    visa_sales: money(visaSales),
    other_sales: money(otherSales),
    instapay_pending: money(instapayPending),
    mixed_count: mixedCount,
    mixed_total: money(mixedTotal),
    payments_breakdown: [...breakdown.entries()]
      .map(([method, v]) => ({ method, amount: money(v.amount), count: v.count }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    returns_count: returnsCount,
    returns_total: money(returnsTotal),
    refunds_count: refundsCount,
    refunds_total: money(refundsTotal),
    cash_refunds: money(cashRefunds),
    instapay_refunds: money(instapayRefunds),
    visa_refunds: money(visaRefunds),
    pending_refunds: money(pendingRefunds),
    expenses_count: expensesCount,
    expenses_total: money(expensesTotal),
    cash_expenses: money(cashExpenses),
    instapay_expenses: money(instapayExpenses),
    visa_expenses: money(visaExpenses),
    expected_cash: expectedCash,
    actual_cash: actualCash,
    difference: actualCash === null ? null : money(actualCash - expectedCash),
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

export function differenceLabelKey(
  difference: number | null,
): "shifts.pendingOpen" | "shifts.balanced" | "shifts.over" | "shifts.short" {
  if (difference === null) return "shifts.pendingOpen";
  if (difference === 0) return "shifts.balanced";
  return difference > 0 ? "shifts.over" : "shifts.short";
}

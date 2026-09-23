/**
 * End-of-day roll-up — closed drawers for complete calendar days.
 *
 * A shift belongs to the window when it *opened* inside it (the same rule the
 * shift report uses). Closed shifts contribute counted cash. Open shifts are
 * listed as pending: expected cash is live, actual cash is unknown, and they
 * never pretend to close the day.
 *
 * Multiple shifts stay separate. The EOD total difference is the sum of each
 * closed shift's own difference — never one unexplained merged number.
 */

import { roundMoney } from "@/modules/expenses/validation";
import { withinDateRange } from "@/lib/export";
import type { DateRange } from "@/modules/reports/services/financialExport";
import { shiftsInRange, type ShiftSummarizer } from "@/modules/reports/services/shiftAnalytics";
import type { Shift, ShiftSummary } from "../types";
import { padShiftSummary } from "./shiftCalculations";

export interface EndOfDayShiftRow {
  shift: Shift;
  summary: ShiftSummary | null;
}

export interface EndOfDayTotals {
  closed_shifts: number;
  open_shifts: number;
  sales_count: number;
  gross_sales: number;
  discounts_total: number;
  net_sales: number;
  cash_sales: number;
  instapay_sales: number;
  visa_sales: number;
  other_sales: number;
  returns_total: number;
  expenses_total: number;
  cash_refunds: number;
  cash_expenses: number;
  expected_cash: number;
  actual_cash: number;
  difference: number;
}

export interface EndOfDayReport {
  range: DateRange;
  closed: EndOfDayShiftRow[];
  pending: EndOfDayShiftRow[];
  totals: EndOfDayTotals;
}

function money(n: number): number {
  return roundMoney(n);
}

function summaryOf(shift: Shift, summaryFor: ShiftSummarizer): ShiftSummary | null {
  const live = shift.summary ?? summaryFor(shift);
  return live ? padShiftSummary(live) : null;
}

export function buildEndOfDay(input: {
  shifts: readonly Shift[];
  summaryFor: ShiftSummarizer;
  range: DateRange;
}): EndOfDayReport {
  const inWindow = shiftsInRange(input.shifts, input.range).sort((a, b) =>
    a.opening_at.localeCompare(b.opening_at),
  );

  const closed: EndOfDayShiftRow[] = [];
  const pending: EndOfDayShiftRow[] = [];
  for (const shift of inWindow) {
    const row = { shift, summary: summaryOf(shift, input.summaryFor) };
    if (shift.status === "closed") closed.push(row);
    else pending.push(row);
  }

  const totals: EndOfDayTotals = {
    closed_shifts: closed.length,
    open_shifts: pending.length,
    sales_count: 0,
    gross_sales: 0,
    discounts_total: 0,
    net_sales: 0,
    cash_sales: 0,
    instapay_sales: 0,
    visa_sales: 0,
    other_sales: 0,
    returns_total: 0,
    expenses_total: 0,
    cash_refunds: 0,
    cash_expenses: 0,
    expected_cash: 0,
    actual_cash: 0,
    difference: 0,
  };

  for (const { summary } of closed) {
    if (!summary) continue;
    totals.sales_count += summary.sales_count;
    totals.gross_sales = money(totals.gross_sales + (summary.gross_sales ?? summary.sales_total));
    totals.discounts_total = money(totals.discounts_total + (summary.discounts_total ?? 0));
    totals.net_sales = money(totals.net_sales + (summary.net_sales ?? summary.sales_total));
    totals.cash_sales = money(totals.cash_sales + summary.cash_sales);
    totals.instapay_sales = money(totals.instapay_sales + summary.instapay_sales);
    totals.visa_sales = money(totals.visa_sales + (summary.visa_sales ?? 0));
    totals.other_sales = money(totals.other_sales + (summary.other_sales ?? 0));
    totals.returns_total = money(totals.returns_total + summary.returns_total);
    totals.expenses_total = money(totals.expenses_total + summary.expenses_total);
    totals.cash_refunds = money(totals.cash_refunds + summary.cash_refunds);
    totals.cash_expenses = money(totals.cash_expenses + summary.cash_expenses);
    totals.expected_cash = money(totals.expected_cash + summary.expected_cash);
    if (summary.actual_cash !== null) {
      totals.actual_cash = money(totals.actual_cash + summary.actual_cash);
    }
    if (summary.difference !== null) {
      totals.difference = money(totals.difference + summary.difference);
    }
  }

  return { range: input.range, closed, pending, totals };
}

export { shiftsInRange, withinDateRange };

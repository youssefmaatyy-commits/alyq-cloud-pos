/**
 * Shift detail and end-of-day workbooks — the same numbers the screens show.
 */

import { buildSheets, toDate, type BuiltSheet, type ExportSheet, type Translate } from "@/lib/export";
import type { Expense } from "@/modules/expenses/types";
import { rangeLabelOf, type DateRange } from "@/modules/reports/services/financialExport";
import type { Shift, ShiftSummary } from "../types";
import { padShiftSummary } from "./shiftCalculations";
import type { EndOfDayReport } from "./endOfDay";

interface MetricRow {
  label: string;
  count: number | null;
  amount: number | null;
  note: string | null;
}

function metricSheet(
  name: string,
  rows: readonly MetricRow[],
  notes: readonly string[],
  t: Translate,
): ExportSheet<MetricRow> {
  return {
    name,
    rows,
    columns: [
      { header: t("export.col.metric"), value: (m) => m.label, width: 36 },
      { header: t("export.col.count"), value: (m) => m.count, kind: "number", width: 12 },
      { header: t("export.col.amount"), value: (m) => m.amount, kind: "money", width: 18 },
      { header: t("export.col.share"), value: (m) => m.note, width: 24 },
    ],
    notes,
  };
}

function statusLabel(status: Shift["status"], t: Translate): string {
  return status === "open" ? t("shifts.statusOpen") : t("shifts.statusClosed");
}

function differenceNote(difference: number | null, t: Translate): string {
  if (difference === null) return t("shifts.pendingOpen");
  if (difference === 0) return t("shifts.balanced");
  return difference > 0 ? t("shifts.over") : t("shifts.short");
}

export function buildShiftDetailSheets(input: {
  shift: Shift;
  summary: ShiftSummary | null;
  expenses?: readonly Expense[];
  t: Translate;
}): BuiltSheet[] {
  const { shift, t } = input;
  const summary = input.summary ? padShiftSummary(input.summary) : null;
  const notes = [
    `${t("shifts.shiftNumber")}: ${shift.shift_number}`,
    t(shift.status === "closed" ? "shifts.frozenNotice" : "shifts.liveNotice"),
  ];

  const summarySheet = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("shifts.openingCash"), count: null, amount: shift.opening_cash, note: null },
      { label: t("shifts.grossSales"), count: summary?.sales_count ?? null, amount: summary?.gross_sales ?? 0, note: null },
      { label: t("shifts.discounts"), count: null, amount: summary?.discounts_total ?? 0, note: null },
      { label: t("shifts.netSales"), count: null, amount: summary?.net_sales ?? summary?.sales_total ?? 0, note: null },
      { label: t("shifts.cashSales"), count: null, amount: summary?.cash_sales ?? 0, note: null },
      { label: t("shifts.instapaySales"), count: null, amount: summary?.instapay_sales ?? 0, note: null },
      { label: t("shifts.visaSales"), count: null, amount: summary?.visa_sales ?? 0, note: null },
      { label: t("shifts.cashRefunds"), count: null, amount: summary?.cash_refunds ?? 0, note: null },
      { label: t("shifts.cashExpenses"), count: null, amount: summary?.cash_expenses ?? 0, note: null },
      { label: t("shifts.expectedCash"), count: null, amount: summary?.expected_cash ?? 0, note: t("shifts.expectedCashHint") },
      {
        label: t("shifts.actualCash"),
        count: null,
        amount: summary?.actual_cash ?? null,
        note: summary?.actual_cash === null || summary?.actual_cash === undefined ? t("shifts.pendingOpen") : null,
      },
      {
        label: t("shifts.difference"),
        count: null,
        amount: summary?.difference ?? null,
        note: differenceNote(summary?.difference ?? null, t),
      },
    ],
    notes,
    t,
  );

  const discountSheet: ExportSheet<{ key: string; amount: number }> = {
    name: t("shifts.groupDiscounts"),
    rows: [
      { key: t("shifts.discountAuto"), amount: summary?.discounts_automatic ?? 0 },
      { key: t("shifts.discountPromo"), amount: summary?.discounts_promo ?? 0 },
      { key: t("shifts.discountManualItem"), amount: summary?.discounts_manual_item ?? 0 },
      { key: t("shifts.discountInvoice"), amount: summary?.discounts_invoice ?? 0 },
    ],
    columns: [
      { header: t("export.col.metric"), value: (r) => r.key, width: 32 },
      { header: t("export.col.amount"), value: (r) => r.amount, kind: "money", width: 16 },
    ],
    totals: [t("export.totalRow"), summary?.discounts_total ?? 0],
    notes: [...notes, t("reports.adv.historicalCost")],
  };

  const expenses = input.expenses ?? [];
  const expenseSheet: ExportSheet<Expense> = {
    name: t("export.sheet.expenses"),
    rows: expenses,
    columns: [
      { header: t("export.col.expenseNumber"), value: (e) => e.expense_number, width: 16 },
      { header: t("export.col.dateTime"), value: (e) => toDate(e.spent_at), kind: "datetime", width: 20 },
      { header: t("export.col.name"), value: (e) => e.name, width: 28 },
      { header: t("export.col.category"), value: (e) => t(`expenses.category.${e.category}` as never), width: 16 },
      {
        header: t("export.col.paymentMethod"),
        value: (e) => t(`pos.payment.${e.payment_method}` as never),
        width: 16,
      },
      { header: t("export.col.amount"), value: (e) => e.amount, kind: "money", width: 14 },
    ],
    notes,
  };

  return buildSheets([summarySheet, discountSheet, expenseSheet] as ExportSheet<unknown>[]);
}

interface EodShiftRow {
  shift: Shift;
  summary: ShiftSummary | null;
}

function shiftColumns(t: Translate): ExportSheet<EodShiftRow>["columns"] {
  return [
    { header: t("export.col.shiftNumber"), value: (r) => r.shift.shift_number, width: 14 },
    { header: t("export.col.status"), value: (r) => statusLabel(r.shift.status, t), width: 12 },
    { header: t("export.col.branch"), value: (r) => r.shift.branch, width: 16 },
    { header: t("export.col.register"), value: (r) => r.shift.register, width: 14 },
    { header: t("export.col.openedBy"), value: (r) => r.shift.opened_by_name, width: 20 },
    { header: t("export.col.openedAt"), value: (r) => toDate(r.shift.opening_at), kind: "datetime", width: 20 },
    { header: t("export.col.closedAt"), value: (r) => toDate(r.shift.closed_at), kind: "datetime", width: 20 },
    { header: t("export.col.openingCash"), value: (r) => r.shift.opening_cash, kind: "money", width: 14 },
    { header: t("export.col.grossSales"), value: (r) => r.summary?.gross_sales ?? 0, kind: "money", width: 14 },
    { header: t("export.col.discounts"), value: (r) => r.summary?.discounts_total ?? 0, kind: "money", width: 14 },
    { header: t("export.col.netSales"), value: (r) => r.summary?.net_sales ?? r.summary?.sales_total ?? 0, kind: "money", width: 14 },
    { header: t("export.col.cash"), value: (r) => r.summary?.cash_sales ?? 0, kind: "money", width: 14 },
    { header: t("export.col.instapay"), value: (r) => r.summary?.instapay_sales ?? 0, kind: "money", width: 14 },
    { header: t("export.col.card"), value: (r) => r.summary?.visa_sales ?? 0, kind: "money", width: 14 },
    { header: t("export.col.returns"), value: (r) => r.summary?.returns_total ?? 0, kind: "money", width: 14 },
    { header: t("export.col.expenses"), value: (r) => r.summary?.expenses_total ?? 0, kind: "money", width: 14 },
    { header: t("export.col.expectedCash"), value: (r) => r.summary?.expected_cash ?? 0, kind: "money", width: 16 },
    { header: t("export.col.actualCash"), value: (r) => r.summary?.actual_cash, kind: "money", width: 16 },
    { header: t("export.col.difference"), value: (r) => r.summary?.difference, kind: "money", width: 14 },
    { header: t("export.col.notes"), value: (r) => r.shift.notes ?? "", width: 28 },
  ];
}

export function buildEndOfDaySheets(input: {
  report: EndOfDayReport;
  range: DateRange;
  t: Translate;
}): BuiltSheet[] {
  const { report, range, t } = input;
  const notes = [
    `${t("export.dateRange")}: ${rangeLabelOf(range, t)}`,
    t("export.note.eodClosedOnly"),
    t("export.note.eodDifferences"),
  ];
  const totals = report.totals;

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("shifts.closedCount"), count: totals.closed_shifts, amount: null, note: null },
      { label: t("shifts.openCount"), count: totals.open_shifts, amount: null, note: t("shifts.pendingOpen") },
      { label: t("shifts.grossSales"), count: totals.sales_count, amount: totals.gross_sales, note: null },
      { label: t("shifts.discounts"), count: null, amount: totals.discounts_total, note: null },
      { label: t("shifts.netSales"), count: null, amount: totals.net_sales, note: null },
      { label: t("shifts.cashSales"), count: null, amount: totals.cash_sales, note: null },
      { label: t("shifts.instapaySales"), count: null, amount: totals.instapay_sales, note: null },
      { label: t("shifts.visaSales"), count: null, amount: totals.visa_sales, note: null },
      { label: t("shifts.returnsTotal"), count: null, amount: totals.returns_total, note: null },
      { label: t("shifts.expensesTotal"), count: null, amount: totals.expenses_total, note: null },
      { label: t("shifts.expectedCash"), count: null, amount: totals.expected_cash, note: null },
      { label: t("shifts.actualCash"), count: null, amount: totals.actual_cash, note: null },
      {
        label: t("shifts.difference"),
        count: null,
        amount: totals.difference,
        note: differenceNote(totals.closed_shifts === 0 ? null : totals.difference, t),
      },
    ],
    notes,
    t,
  );

  const closedSheet: ExportSheet<EodShiftRow> = {
    name: t("export.sheet.eod"),
    rows: report.closed,
    columns: shiftColumns(t),
    notes,
  };

  const pendingSheet: ExportSheet<EodShiftRow> = {
    name: t("export.sheet.pendingShifts"),
    rows: report.pending,
    columns: shiftColumns(t),
    notes: [...notes, t("shifts.pendingOpenHint")],
  };

  return buildSheets([summary, closedSheet, pendingSheet] as ExportSheet<unknown>[]);
}

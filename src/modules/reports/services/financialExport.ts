/**
 * Financial reports export — the whole money picture for a date range.
 *
 * Six sheets, one per requested report:
 *
 *   **Summary**          revenue, cost of goods sold, gross profit, expenses,
 *                        net profit, returns/refunds and the per-method split.
 *   **Payments**         every payment line of every invoice (split payments
 *                        appear as several rows, which is the point).
 *   **Returns**          sales returns with their refund amount/method/status.
 *   **Refunds**          standalone refund records.
 *   **Expenses**         shop expenses as recorded.
 *   **Shift summaries**  one row per shift with its Z-report figures.
 *   **Cash movements**   a derived cash ledger: opening floats in, cash sales
 *                        in, cash refunds and cash expenses out, with a running
 *                        balance.
 *
 * Two accounting rules, both stated in the sheet notes:
 *
 *   - **Voided invoices are excluded** from every money figure. A void is a
 *     reversal; counting it would overstate revenue. The rows still appear in
 *     the sales export, labelled.
 *   - **Cost of goods sold uses the product's *current* purchase price.**
 *     `sale_items` snapshots `unit_price` but not cost, so a historical cost is
 *     not recoverable from the schema. Profit is therefore "at today's costs".
 *
 * Pure: no `xlsx`, no DOM, no repository. The date range is applied here, over
 * data the providers already hold.
 */
import {
  buildSheets,
  toDate,
  withinDateRange,
  type BuiltSheet,
  type ExportSheet,
  type Translate,
} from "@/lib/export";
import { paymentTotals } from "@/modules/pos/services/salesExport";
import type { Sale, SalePayment } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { Expense } from "@/modules/expenses/types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";

/** Inclusive calendar range; `null` on either side means unbounded. */
export interface DateRange {
  from: string | null;
  to: string | null;
}

export const OPEN_DATE_RANGE: DateRange = { from: null, to: null };

export interface FinancialExportInput {
  sales: readonly Sale[];
  /** Catalogue, used to cost sold items (see the COGS rule above). */
  products: readonly Product[];
  expenses: readonly Expense[];
  returnsList: readonly SalesReturn[];
  refundsList: readonly RefundRecord[];
  shifts: readonly Shift[];
  /** `ShiftProvider.summaryFor` — live for open shifts, frozen once closed. */
  summaryFor(shift: Shift): ShiftSummary | null;
  range: DateRange;
  t: Translate;
}

/** Every money figure the Summary sheet reports. */
export interface FinancialTotals {
  invoiceCount: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  cash: number;
  card: number;
  instapay: number;
  unsettled: number;
  voidedCount: number;
  voidedTotal: number;
  returnsCount: number;
  returnsTotal: number;
  refundsCount: number;
  refundsPaid: number;
  refundsPending: number;
  unitCount: number;
}

const money = (value: number) => Math.round(value * 100) / 100;

/** Invoices that count as revenue. */
export function revenueSales(sales: readonly Sale[]): Sale[] {
  return sales.filter((sale) => sale.status !== "voided");
}

/**
 * Cost of goods sold over the given invoices, at current purchase prices.
 * Items whose product no longer exists cost 0 and are reported in the notes.
 */
export function costOfGoodsSold(
  sales: readonly Sale[],
  costByProductId: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const sale of revenueSales(sales)) {
    for (const item of sale.items) {
      const cost = costByProductId.get(item.product_id) ?? 0;
      total += cost * item.quantity;
    }
  }
  return money(total);
}

export function computeFinancialTotals(
  input: Pick<FinancialExportInput, "sales" | "products" | "expenses" | "returnsList" | "refundsList">,
): FinancialTotals {
  const costByProductId = new Map(input.products.map((p) => [p.id, p.cost_price]));
  const live = revenueSales(input.sales);

  const revenue = money(live.reduce((acc, s) => acc + s.total, 0));
  const cogs = costOfGoodsSold(input.sales, costByProductId);
  const expenses = money(input.expenses.reduce((acc, e) => acc + e.amount, 0));

  let cash = 0;
  let card = 0;
  let instapay = 0;
  let unsettled = 0;
  let unitCount = 0;
  for (const sale of live) {
    const totals = paymentTotals(sale);
    cash += totals.cash;
    card += totals.visa;
    instapay += totals.instapay;
    unsettled += totals.pending;
    unitCount += sale.items.reduce((acc, item) => acc + item.quantity, 0);
  }

  const refundsPaid = money(
    input.refundsList
      .filter((r) => r.status === "completed")
      .reduce((acc, r) => acc + r.amount, 0),
  );
  const refundsPending = money(
    input.refundsList
      .filter((r) => r.status === "pending")
      .reduce((acc, r) => acc + r.amount, 0),
  );

  const voided = input.sales.filter((s) => s.status === "voided");

  return {
    invoiceCount: live.length,
    revenue,
    cogs,
    grossProfit: money(revenue - cogs),
    expenses,
    netProfit: money(revenue - cogs - expenses),
    cash: money(cash),
    card: money(card),
    instapay: money(instapay),
    unsettled: money(unsettled),
    voidedCount: voided.length,
    voidedTotal: money(voided.reduce((acc, s) => acc + s.total, 0)),
    returnsCount: input.returnsList.length,
    returnsTotal: money(input.returnsList.reduce((acc, r) => acc + r.refund_amount, 0)),
    refundsCount: input.refundsList.length,
    refundsPaid,
    refundsPending,
    unitCount,
  };
}

/** One row of a derived cash movement. */
export interface CashMovementRow {
  at: string;
  /** Localised movement type. */
  kind: string;
  reference: string;
  description: string;
  /** Money into the drawer. */
  inn: number;
  /** Money out of the drawer. */
  out: number;
}

/**
 * Derive the drawer's cash ledger: opening floats and cash sales in, cash
 * refunds and cash expenses out. InstaPay and card never touch the drawer, so
 * they are deliberately absent — the same rule `ShiftSummary.expected_cash`
 * uses. Sorted ascending and given a running balance by the sheet builder.
 */
export function buildCashLedger(input: {
  sales: readonly Sale[];
  expenses: readonly Expense[];
  refundsList: readonly RefundRecord[];
  shifts: readonly Shift[];
  t: Translate;
}): CashMovementRow[] {
  const { t } = input;
  const rows: CashMovementRow[] = [];

  for (const shift of input.shifts) {
    if (shift.opening_cash > 0) {
      rows.push({
        at: shift.opening_at,
        kind: t("export.ledger.openingFloat"),
        reference: shift.shift_number,
        description: `${shift.branch} · ${shift.register} · ${shift.opened_by_name}`,
        inn: shift.opening_cash,
        out: 0,
      });
    }
  }

  for (const sale of revenueSales(input.sales)) {
    const cash = paymentTotals(sale).cash;
    if (cash <= 0) continue;
    rows.push({
      at: sale.created_at,
      kind: t("export.ledger.cashSale"),
      reference: sale.sale_number,
      description: sale.customer_name || sale.user_name,
      inn: cash,
      out: 0,
    });
  }

  for (const refund of input.refundsList) {
    if (refund.payment_method !== "cash" || refund.status !== "completed") continue;
    rows.push({
      at: refund.created_at,
      kind: t("export.ledger.cashRefund"),
      reference: refund.refund_number,
      description: refund.reason || refund.sale_number,
      inn: 0,
      out: refund.amount,
    });
  }

  for (const expense of input.expenses) {
    if (expense.payment_method !== "cash") continue;
    rows.push({
      at: expense.spent_at,
      kind: t("export.ledger.cashExpense"),
      reference: expense.expense_number,
      description: expense.name,
      inn: 0,
      out: expense.amount,
    });
  }

  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

interface MetricRow {
  label: string;
  count: number | null;
  amount: number | null;
}

interface PaymentRow {
  sale: Sale;
  payment: SalePayment;
}

interface LedgerRow extends CashMovementRow {
  balance: number;
}

export function buildFinancialSheets(input: FinancialExportInput): BuiltSheet[] {
  const { t, range } = input;
  const inRange = (iso: string | null | undefined) => withinDateRange(iso, range.from, range.to);

  // ── apply the date range once, then report over the filtered sets ────────
  const sales = input.sales.filter((s) => inRange(s.created_at));
  const expenses = input.expenses.filter((e) => inRange(e.spent_at));
  const returnsList = input.returnsList.filter((r) => inRange(r.created_at));
  const refundsList = input.refundsList.filter((r) => inRange(r.created_at));
  // A shift belongs to the range when it *opened* inside it.
  const shifts = input.shifts.filter((s) => inRange(s.opening_at));

  const totals = computeFinancialTotals({
    sales,
    products: input.products,
    expenses,
    returnsList,
    refundsList,
  });

  const rangeLabel =
    range.from || range.to
      ? `${range.from ?? "…"} → ${range.to ?? "…"}`
      : t("export.range.allTime");

  // ── 1. Summary ───────────────────────────────────────────────────────────
  const metrics: MetricRow[] = [
    { label: t("export.metric.revenue"), count: totals.invoiceCount, amount: totals.revenue },
    { label: t("export.metric.cogs"), count: totals.unitCount, amount: -totals.cogs },
    { label: t("export.metric.grossProfit"), count: null, amount: totals.grossProfit },
    { label: t("export.metric.expenses"), count: expenses.length, amount: -totals.expenses },
    { label: t("export.metric.netProfit"), count: null, amount: totals.netProfit },
    { label: t("export.metric.cash"), count: null, amount: totals.cash },
    { label: t("export.metric.card"), count: null, amount: totals.card },
    { label: t("export.metric.instapay"), count: null, amount: totals.instapay },
    { label: t("export.metric.unsettled"), count: null, amount: totals.unsettled },
    { label: t("export.metric.returns"), count: totals.returnsCount, amount: -totals.returnsTotal },
    { label: t("export.metric.refundsPaid"), count: totals.refundsCount, amount: -totals.refundsPaid },
    { label: t("export.metric.refundsPending"), count: null, amount: totals.refundsPending },
    { label: t("export.metric.voided"), count: totals.voidedCount, amount: totals.voidedTotal },
  ];

  const summary: ExportSheet<MetricRow> = {
    name: t("export.sheet.summary"),
    rows: metrics,
    columns: [
      { header: t("export.col.metric"), value: (m) => m.label, width: 34 },
      { header: t("export.col.count"), value: (m) => m.count, kind: "number", width: 12 },
      { header: t("export.col.amount"), value: (m) => m.amount, kind: "money", width: 18 },
    ],
    notes: [
      `${t("export.dateRange")}: ${rangeLabel}`,
      t("export.note.profit"),
      t("export.note.totalsExcludeVoided"),
      t("export.note.negativeIsOutflow"),
    ],
  };

  // ── 2. Payments (one row per payment, so splits are visible) ─────────────
  const paymentRows: PaymentRow[] = [];
  for (const sale of sales) {
    for (const payment of sale.payments) paymentRows.push({ sale, payment });
  }

  const payments: ExportSheet<PaymentRow> = {
    name: t("export.sheet.payments"),
    rows: paymentRows,
    columns: [
      { header: t("export.col.dateTime"), value: (r) => toDate(r.sale.created_at), kind: "datetime" },
      { header: t("export.col.invoiceNumber"), value: (r) => r.sale.sale_number, width: 16 },
      { header: t("export.col.status"), value: (r) => t(`pos.status.${r.sale.status}` as never), width: 12 },
      { header: t("export.col.customer"), value: (r) => r.sale.customer_name ?? "", width: 24 },
      { header: t("export.col.cashier"), value: (r) => r.sale.user_name, width: 20 },
      {
        header: t("export.col.paymentMethod"),
        value: (r) => t(`pos.payment.${r.payment.method}` as never),
        width: 16,
      },
      { header: t("export.col.amount"), value: (r) => r.payment.amount, kind: "money" },
      {
        header: t("export.col.paymentStatus"),
        value: (r) => t(`pos.status.${r.payment.status}` as never),
        width: 14,
      },
      { header: t("export.col.confirmedAt"), value: (r) => toDate(r.payment.paid_at), kind: "datetime" },
      { header: t("export.col.confirmedBy"), value: (r) => r.payment.paid_by_name ?? "", width: 20 },
    ],
    totals: [
      t("export.totalRow"),
      "",
      "",
      "",
      "",
      "",
      money(paymentRows.reduce((acc, r) => acc + r.payment.amount, 0)),
      "",
      null,
      "",
    ],
    notes: [`${t("export.col.amount")}: ${paymentRows.length}`],
  };

  // ── 3–5. Returns, refunds and expenses ─────────────────────────────────
  // Sheet definitions live in the exported factories below so the Returns and
  // Expenses screens write exactly the same sheets as this report.
  const returns = returnsSheetOf(returnsList, t);
  const refunds = refundsSheetOf(refundsList, t);
  const expensesSheet = expensesSheetOf(expenses, t);

  // ── 6. Shift summaries ───────────────────────────────────────────────────
  interface ShiftRow {
    shift: Shift;
    summary: ShiftSummary | null;
  }
  const shiftRows: ShiftRow[] = shifts.map((shift) => ({
    shift,
    summary: shift.summary ?? input.summaryFor(shift),
  }));

  const shiftsSheet: ExportSheet<ShiftRow> = {
    name: t("export.sheet.shifts"),
    rows: shiftRows,
    columns: [
      { header: t("export.col.shiftNumber"), value: (r) => r.shift.shift_number, width: 14 },
      { header: t("export.col.branch"), value: (r) => r.shift.branch, width: 16 },
      { header: t("export.col.register"), value: (r) => r.shift.register, width: 14 },
      {
        header: t("export.col.status"),
        value: (r) => (r.shift.status === "open" ? t("shifts.statusOpen") : t("shifts.statusClosed")),
        width: 12,
      },
      { header: t("export.col.openedBy"), value: (r) => r.shift.opened_by_name, width: 20 },
      { header: t("export.col.openedAt"), value: (r) => toDate(r.shift.opening_at), kind: "datetime" },
      { header: t("export.col.closedAt"), value: (r) => toDate(r.shift.closed_at), kind: "datetime" },
      { header: t("export.col.openingCash"), value: (r) => r.shift.opening_cash, kind: "money" },
      { header: t("export.col.salesCount"), value: (r) => r.summary?.sales_count ?? 0, kind: "number" },
      { header: t("export.col.salesTotal"), value: (r) => r.summary?.sales_total ?? 0, kind: "money" },
      { header: t("export.col.cash"), value: (r) => r.summary?.cash_sales ?? 0, kind: "money" },
      { header: t("export.col.instapay"), value: (r) => r.summary?.instapay_sales ?? 0, kind: "money" },
      { header: t("export.col.returns"), value: (r) => r.summary?.returns_total ?? 0, kind: "money" },
      { header: t("export.col.refunds"), value: (r) => r.summary?.refunds_total ?? 0, kind: "money" },
      { header: t("export.col.expenses"), value: (r) => r.summary?.expenses_total ?? 0, kind: "money" },
      { header: t("export.col.expectedCash"), value: (r) => r.summary?.expected_cash ?? 0, kind: "money" },
      { header: t("export.col.actualCash"), value: (r) => r.summary?.actual_cash, kind: "money" },
      { header: t("export.col.difference"), value: (r) => r.summary?.difference, kind: "money" },
      { header: t("export.col.notes"), value: (r) => r.shift.notes ?? "", width: 30 },
    ],
    notes: [
      `${t("export.col.shiftNumber")}: ${shiftRows.length}`,
      t("export.note.shiftRange"),
    ],
  };

  // ── 7. Cash movements (derived ledger with a running balance) ────────────
  const ledger = buildCashLedger({ sales, expenses, refundsList, shifts, t });
  let running = 0;
  const ledgerRows: LedgerRow[] = ledger.map((row) => {
    running = money(running + row.inn - row.out);
    return { ...row, balance: running };
  });

  const cashSheet: ExportSheet<LedgerRow> = {
    name: t("export.sheet.cashLedger"),
    rows: ledgerRows,
    columns: [
      { header: t("export.col.dateTime"), value: (r) => toDate(r.at), kind: "datetime" },
      { header: t("export.col.type"), value: (r) => r.kind, width: 20 },
      { header: t("export.col.reference"), value: (r) => r.reference, width: 16 },
      { header: t("export.col.details"), value: (r) => r.description, width: 34 },
      { header: t("export.col.cashIn"), value: (r) => (r.inn > 0 ? r.inn : null), kind: "money" },
      { header: t("export.col.cashOut"), value: (r) => (r.out > 0 ? r.out : null), kind: "money" },
      { header: t("export.col.balance"), value: (r) => r.balance, kind: "money" },
    ],
    totals: [
      t("export.totalRow"),
      "",
      "",
      "",
      money(ledgerRows.reduce((acc, r) => acc + r.inn, 0)),
      money(ledgerRows.reduce((acc, r) => acc + r.out, 0)),
      ledgerRows.length > 0 ? ledgerRows[ledgerRows.length - 1].balance : 0,
    ],
    notes: [t("export.note.cashLedger"), `${t("export.col.type")}: ${ledgerRows.length}`],
  };

  return buildSheets([summary, payments, returns, refunds, expensesSheet, shiftsSheet, cashSheet]);
}

// ── Sheets shared with the standalone Returns and Expenses exports ─────────

/**
 * The Returns sheet of the financial report.
 *
 * Exported on its own so the Returns screen can write the very same sheet:
 * one definition, so a standalone file and the report cannot drift apart.
 */
export function returnsSheetOf(returnsList: readonly SalesReturn[], t: Translate): ExportSheet<SalesReturn> {
return {
  name: t("export.sheet.returns"),
  rows: returnsList,
  columns: [
    { header: t("export.col.returnNumber"), value: (r) => r.return_number, width: 16 },
    { header: t("export.col.dateTime"), value: (r) => toDate(r.created_at), kind: "datetime" },
    { header: t("export.col.invoiceNumber"), value: (r) => r.sale_number, width: 16 },
    { header: t("export.col.customer"), value: (r) => r.customer_name ?? "", width: 24 },
    { header: t("export.col.reason"), value: (r) => r.reason, width: 28 },
    { header: t("export.col.itemsCount"), value: (r) => r.items.length, kind: "number", width: 10 },
    { header: t("export.col.refundAmount"), value: (r) => r.refund_amount, kind: "money" },
    {
      header: t("export.col.refundMethod"),
      value: (r) => t(`pos.payment.${r.refund_method}` as never),
      width: 16,
    },
    {
      header: t("export.col.refundStatus"),
      value: (r) => t(`pos.status.${r.refund_status}` as never),
      width: 14,
    },
    { header: t("export.col.user"), value: (r) => r.user_name, width: 20 },
  ],
  totals: [
    t("export.totalRow"),
    null,
    "",
    "",
    "",
    returnsList.reduce((acc, r) => acc + r.items.length, 0),
    money(returnsList.reduce((acc, r) => acc + r.refund_amount, 0)),
    "",
    "",
    "",
  ],
  notes: [`${t("export.col.returnNumber")}: ${returnsList.length}`],
}
}

/**
 * The Refunds sheet — one row per refund record, cash and InstaPay alike.
 *
 * Shared with the Returns screen's export, see `returnsSheetOf`.
 */
export function refundsSheetOf(refundsList: readonly RefundRecord[], t: Translate): ExportSheet<RefundRecord> {
return {
  name: t("export.sheet.refunds"),
  rows: refundsList,
  columns: [
    { header: t("export.col.refundNumber"), value: (r) => r.refund_number, width: 16 },
    { header: t("export.col.dateTime"), value: (r) => toDate(r.created_at), kind: "datetime" },
    { header: t("export.col.invoiceNumber"), value: (r) => r.sale_number, width: 16 },
    { header: t("export.col.returnNumber"), value: (r) => r.return_id ?? "", width: 16 },
    { header: t("export.col.amount"), value: (r) => r.amount, kind: "money" },
    {
      header: t("export.col.refundMethod"),
      value: (r) => t(`pos.payment.${r.payment_method}` as never),
      width: 16,
    },
    {
      header: t("export.col.refundStatus"),
      value: (r) => t(`pos.status.${r.status}` as never),
      width: 14,
    },
    { header: t("export.col.reason"), value: (r) => r.reason ?? "", width: 28 },
    { header: t("export.col.user"), value: (r) => r.user_name, width: 20 },
  ],
  totals: [
    t("export.totalRow"),
    null,
    "",
    "",
    money(refundsList.reduce((acc, r) => acc + r.amount, 0)),
    "",
    "",
    "",
    "",
  ],
  notes: [`${t("export.col.refundNumber")}: ${refundsList.length}`],
}
}

/**
 * The Expenses sheet.
 *
 * Shared with the Expenses screen's export, see `returnsSheetOf`.
 */
export function expensesSheetOf(expenses: readonly Expense[], t: Translate): ExportSheet<Expense> {
return {
  name: t("export.sheet.expenses"),
  rows: expenses,
  columns: [
    { header: t("export.col.expenseNumber"), value: (e) => e.expense_number, width: 16 },
    { header: t("export.col.dateTime"), value: (e) => toDate(e.spent_at), kind: "datetime" },
    { header: t("export.col.name"), value: (e) => e.name, width: 30 },
    {
      header: t("export.col.category"),
      value: (e) => t(`expenses.category.${e.category}` as never),
      width: 18,
    },
    { header: t("export.col.amount"), value: (e) => e.amount, kind: "money" },
    {
      header: t("export.col.paymentMethod"),
      value: (e) => t(`pos.payment.${e.payment_method}` as never),
      width: 16,
    },
    { header: t("export.col.branch"), value: (e) => e.branch ?? "", width: 16 },
    { header: t("export.col.user"), value: (e) => e.user_name, width: 20 },
    { header: t("export.col.notes"), value: (e) => e.notes ?? "", width: 34 },
  ],
  totals: [
    t("export.totalRow"),
    null,
    "",
    "",
    money(expenses.reduce((acc, e) => acc + e.amount, 0)),
    "",
    "",
    "",
    "",
  ],
  notes: [`${t("export.col.expenseNumber")}: ${expenses.length}`],
}
}

/**
 * Advanced report exports — the analytics, as workbooks.
 *
 * Every builder here takes rows the analytics services already computed and lays
 * them out for Excel. None of them does arithmetic of their own beyond the
 * totals row each sheet prints, which is the discipline that keeps a file and a
 * screen telling the same story: `buildSalesAnalyticsSheets` writes the numbers
 * `buildSalesAnalytics` returned, so a figure can only be wrong in one place,
 * and fixing it fixes both.
 *
 * Conventions inherited from the rest of the export system, deliberately:
 *
 *   · Money columns are `kind: "money"`, percentages `kind: "percent"`, dates
 *     `kind: "date"` — the writer applies the currency format, so EGP is EGP in
 *     every file the app produces.
 *   · The first sheet is a Summary of metric rows, because that is the sheet
 *     somebody forwards; the breakdowns follow it.
 *   · The date range is printed in the notes of every sheet, since a workbook
 *     detached from the screen it came from has no other way of saying what it
 *     is about.
 *   · Rows carry keys, the builder translates them. A category, a payment method
 *     and a record status are all resolved through the dictionary here, so an
 *     Arabic export reads in Arabic.
 *
 * These are *reports* — summarised documents — so the buttons that call them
 * pass `authority="report"`, which asserts `export_reports`. The raw extracts
 * (every invoice row, the whole customer book) stay where they already are,
 * behind `export_data`.
 */
import {
  buildSheets,
  toDate,
  type BuiltSheet,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "@/lib/export";
import { withoutSensitiveMoney } from "./sensitiveExport";
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS, type Expense } from "@/modules/expenses/types";
import type { Customer } from "@/modules/customers/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Sale } from "@/modules/pos/types";
import type { Shift } from "@/modules/shifts/types";
import { rangeLabelOf, type DateRange } from "./financialExport";
import {
  bestSellers,
  buildSalesAnalytics,
  customerPurchaseHistory,
  customerSpendingSummary,
  marginSummary,
  productPerformance,
  slowMovers,
  stockValueTotals,
  topCustomers,
  UNATTRIBUTED_REGISTER,
  type CustomerReportRow,
  type EmployeeSalesRow,
  type PaymentMethodSalesRow,
  type ProductPerformanceRow,
  type RegisterSalesRow,
  type SlowMoverRow,
  type TrendPoint,
} from "./salesAnalytics";
import {
  buildExpenseReport,
  type ExpenseBreakdownRow,
  type ExpenseDayRow,
  type ExpenseReport,
} from "./expenseAnalytics";
import {
  buildShiftReport,
  cashDifferenceRows,
  cashDifferenceSummary,
  dailyShiftReport,
  employeeShiftPerformance,
  type DailyShiftRow,
  type EmployeeShiftRow,
  type ShiftReportRow,
  type ShiftSummarizer,
} from "./shiftAnalytics";

/** A label / count / amount line — the shape every Summary sheet uses. */
interface MetricRow {
  label: string;
  count: number | null;
  amount: number | null;
  /** Optional third column, for shares and rates that are not money. */
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
      { header: t("export.col.share"), value: (m) => m.note, width: 20 },
    ],
    notes,
  };
}

function rangeNote(range: DateRange, t: Translate): string {
  return `${t("export.dateRange")}: ${rangeLabelOf(range, t)}`;
}

/** A drawer is either open or counted; the screen uses these two labels for it. */
function shiftStatusKey(status: Shift["status"]): "shifts.statusOpen" | "shifts.statusClosed" {
  return status === "open" ? "shifts.statusOpen" : "shifts.statusClosed";
}

// ── 1. sales ───────────────────────────────────────────────────────────────
export interface SalesAnalyticsExportInput {
  sales: readonly Sale[];
  shifts: readonly Shift[];
  range: DateRange;
  t: Translate;
}

export function buildSalesAnalyticsSheets(input: SalesAnalyticsExportInput): BuiltSheet[] {
  const { t, range } = input;
  const analytics = buildSalesAnalytics(input);
  const notes = [rangeNote(range, t), t("export.note.totalsExcludeVoided")];

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("export.metric.revenue"), count: analytics.invoices, amount: analytics.revenue, note: null },
      { label: t("export.col.unitsSold"), count: analytics.units, amount: null, note: null },
      { label: t("export.col.avgInvoice"), count: null, amount: analytics.avgInvoice, note: null },
      { label: t("export.col.discountsGiven"), count: null, amount: analytics.discounts, note: null },
      {
        label: t("export.col.employee"),
        count: analytics.byEmployee.length,
        amount: null,
        note: null,
      },
      {
        label: t("export.sheet.byRegister"),
        count: analytics.byRegister.filter((row) => row.key !== UNATTRIBUTED_REGISTER).length,
        amount: null,
        note: analytics.byRegister.some((row) => row.key === UNATTRIBUTED_REGISTER)
          ? t("export.note.unattributedSales")
          : null,
      },
    ],
    notes,
    t,
  );

  const byEmployee: ExportSheet<EmployeeSalesRow> = {
    name: t("export.sheet.byEmployee"),
    rows: analytics.byEmployee,
    columns: [
      { header: t("export.col.employee"), value: (r) => r.userName, width: 26 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
      { header: t("export.col.revenue"), value: (r) => r.revenue, kind: "money", width: 16 },
      { header: t("export.col.discountsGiven"), value: (r) => r.discounts, kind: "money", width: 16 },
      { header: t("export.col.avgInvoice"), value: (r) => r.avgInvoice, kind: "money", width: 16 },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
    ],
    totals: [
      t("export.totalRow"),
      analytics.invoices,
      analytics.units,
      analytics.revenue,
      analytics.discounts,
      analytics.avgInvoice,
      null,
    ],
    notes,
  };

  const byRegister: ExportSheet<RegisterSalesRow> = {
    name: t("export.sheet.byRegister"),
    rows: analytics.byRegister,
    columns: [
      {
        header: t("export.col.branch"),
        value: (r) => (r.key === UNATTRIBUTED_REGISTER ? t("export.row.unattributed") : r.branch),
        width: 20,
      },
      {
        header: t("export.col.register"),
        value: (r) => (r.key === UNATTRIBUTED_REGISTER ? "—" : r.register),
        width: 16,
      },
      { header: t("export.col.shifts"), value: (r) => r.shifts, kind: "number", width: 10 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
      { header: t("export.col.revenue"), value: (r) => r.revenue, kind: "money", width: 16 },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
    ],
    totals: [t("export.totalRow"), null, null, analytics.invoices, analytics.units, analytics.revenue, null],
    notes: [...notes, t("export.note.branchAttribution")],
  };

  const byMethod: ExportSheet<PaymentMethodSalesRow> = {
    name: t("export.sheet.payments"),
    rows: analytics.byPaymentMethod,
    columns: [
      {
        header: t("export.col.paymentMethod"),
        value: (r) => t(`pos.payment.${r.method}` as never),
        width: 20,
      },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.amount"), value: (r) => r.amount, kind: "money", width: 16 },
      { header: t("export.col.paid"), value: (r) => r.paid, kind: "money", width: 16 },
      { header: t("export.col.pending"), value: (r) => r.pending, kind: "money", width: 16 },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
    ],
    notes: [...notes, t("export.note.paymentSplit")],
  };

  const trend: ExportSheet<TrendPoint> = {
    name: t("export.sheet.salesTrend"),
    rows: analytics.trend,
    columns: [
      { header: t("export.col.date"), value: (r) => toDate(r.date), kind: "date", width: 14 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
      { header: t("export.col.revenue"), value: (r) => r.revenue, kind: "money", width: 16 },
      { header: t("export.col.discountsGiven"), value: (r) => r.discounts, kind: "money", width: 16 },
    ],
    totals: [t("export.totalRow"), analytics.invoices, analytics.units, analytics.revenue, analytics.discounts],
    notes: [...notes, t("export.note.trendFilled")],
  };

  return buildSheets([summary, byEmployee, byRegister, byMethod, trend] as ExportSheet<unknown>[]);
}

// ── 2. products ────────────────────────────────────────────────────────────
export interface ProductAnalyticsExportInput {
  sales: readonly Sale[];
  products: readonly Product[];
  /** Phase 43: the catalogue's combinations, for the stock summary tiles. */
  variants?: readonly ProductVariant[];
  range: DateRange;
  t: Translate;
  pick: PickBilingual;
  /** Same flag as the financial workbook. Omitted means the cost columns stay. */
  maySeeCost?: boolean;
}

export function buildProductAnalyticsSheets(input: ProductAnalyticsExportInput): BuiltSheet[] {
  const { t, pick, range } = input;
  const sales = buildSalesAnalytics({ sales: input.sales, shifts: [], range }).sales;
  const rows = productPerformance(sales, input.products);
  const margin = marginSummary(sales, input.products, rows);
  const stock = stockValueTotals(input.products, input.variants ?? []);
  const notes = [rangeNote(range, t), t("export.note.costIsCurrent")];

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("export.metric.revenue"), count: null, amount: margin.revenue, note: null },
      { label: t("export.metric.cogs"), count: null, amount: -margin.cogs, note: null },
      { label: t("export.col.profit"), count: null, amount: margin.profit, note: `${margin.margin}%` },
      { label: t("export.sheet.productPerformance"), count: margin.soldProducts, amount: null, note: null },
      {
        label: t("export.note.lossMakers"),
        count: margin.lossMakers.length,
        amount: margin.lossMakers.reduce((acc, row) => acc + row.profit, 0),
        note: null,
      },
      { label: t("export.col.stockValue"), count: stock.units, amount: stock.atCost, note: null },
      { label: t("export.col.retailValue"), count: null, amount: stock.atRetail, note: null },
      {
        label: t("export.col.potentialMargin"),
        count: null,
        amount: stock.potentialMargin,
        note: null,
      },
    ],
    [...notes, t("export.note.negativeIsOutflow")],
    t,
  );

  const performance: ExportSheet<ProductPerformanceRow> = {
    name: t("export.sheet.productPerformance"),
    rows: [...rows].sort((a, b) => b.revenue - a.revenue),
    columns: [
      { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
      { header: t("export.col.product"), value: (r) => pick(r.nameAr, r.nameEn), width: 34 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
      { header: t("export.col.revenue"), value: (r) => r.revenue, kind: "money", width: 16 },
      { header: t("export.col.unitCost"), value: (r) => r.cost, kind: "money", width: 16 },
      { header: t("export.col.profit"), value: (r) => r.profit, kind: "money", width: 16 },
      { header: t("export.col.margin"), value: (r) => r.margin / 100, kind: "percent", width: 12 },
      { header: t("export.col.currentQty"), value: (r) => r.stock, kind: "number", width: 12 },
      { header: t("export.col.stockValue"), value: (r) => r.stockValue, kind: "money", width: 16 },
    ],
    totals: [
      t("export.totalRow"),
      null,
      rows.reduce((acc, r) => acc + r.invoices, 0),
      rows.reduce((acc, r) => acc + r.units, 0),
      margin.revenue,
      margin.cogs,
      margin.profit,
      null,
      stock.units,
      stock.atCost,
    ],
    notes,
  };

  // A rank is the row's position, which only the ranked list knows — so the
  // sheet's rows carry it explicitly rather than a column pretending to compute it.
  const ranked = bestSellers(rows, 20).map((row, index) => ({ rank: index + 1, row }));
  const best: ExportSheet<(typeof ranked)[number]> = {
    name: t("export.sheet.bestSellers"),
    rows: ranked,
    columns: [
      { header: t("export.col.rank"), value: (r) => r.rank, kind: "number", width: 8 },
      { header: t("export.col.sku"), value: (r) => r.row.sku, width: 16 },
      { header: t("export.col.product"), value: (r) => pick(r.row.nameAr, r.row.nameEn), width: 34 },
      { header: t("export.col.unitsSold"), value: (r) => r.row.units, kind: "number", width: 12 },
      { header: t("export.col.revenue"), value: (r) => r.row.revenue, kind: "money", width: 16 },
      { header: t("export.col.profit"), value: (r) => r.row.profit, kind: "money", width: 16 },
      { header: t("export.col.margin"), value: (r) => r.row.margin / 100, kind: "percent", width: 12 },
    ],
    notes,
  };

  const slow: ExportSheet<SlowMoverRow> = {
    name: t("export.sheet.slowMovers"),
    rows: slowMovers(input.products, rows, 50),
    columns: [
      { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
      { header: t("export.col.product"), value: (r) => pick(r.nameAr, r.nameEn), width: 34 },
      { header: t("export.col.currentQty"), value: (r) => r.stock, kind: "number", width: 12 },
      { header: t("export.col.tiedUp"), value: (r) => r.tiedUp, kind: "money", width: 16 },
      { header: t("export.col.unitsSold"), value: (r) => r.units, kind: "number", width: 12 },
      { header: t("export.col.sellingPrice"), value: (r) => r.sellingPrice, kind: "money", width: 16 },
    ],
    notes: [...notes, t("export.note.slowMovers")],
  };

  const stockSheet: ExportSheet<Product> = {
    name: t("export.sheet.stockValue"),
    rows: input.products.filter((product) => product.stock_tracking_enabled),
    columns: [
      { header: t("export.col.sku"), value: (r) => r.sku, width: 16 },
      { header: t("export.col.product"), value: (r) => pick(r.name_ar, r.name_en), width: 34 },
      { header: t("export.col.currentQty"), value: (r) => r.stock_quantity, kind: "number", width: 12 },
      { header: t("export.col.costPrice"), value: (r) => r.cost_price, kind: "money", width: 14 },
      { header: t("export.col.sellingPrice"), value: (r) => r.selling_price, kind: "money", width: 14 },
      {
        header: t("export.col.stockValue"),
        value: (r) => Math.round(r.stock_quantity * r.cost_price * 100) / 100,
        kind: "money",
        width: 16,
      },
      {
        header: t("export.col.retailValue"),
        value: (r) => Math.round(r.stock_quantity * r.selling_price * 100) / 100,
        kind: "money",
        width: 16,
      },
      { header: t("export.col.lowStockLevel"), value: (r) => r.low_stock_level, kind: "number", width: 14 },
    ],
    totals: [
      t("export.totalRow"),
      `${stock.tracked} ${t("export.col.product").toLowerCase()}`,
      stock.units,
      null,
      null,
      stock.atCost,
      stock.atRetail,
      null,
    ],
    notes: [...notes, t("export.note.stockValue")],
  };

  const sheets = buildSheets([summary, performance, best, slow, stockSheet] as ExportSheet<unknown>[]);
  return input.maySeeCost === false ? withoutSensitiveMoney(sheets, t) : sheets;
}

// ── 3. customers ───────────────────────────────────────────────────────────
export interface CustomerAnalyticsExportInput {
  customers: readonly Customer[];
  sales: readonly Sale[];
  range: DateRange;
  t: Translate;
  /** Set to write one customer's invoices instead of the ranked book. */
  customerId?: string | null;
}

export function buildCustomerAnalyticsSheets(input: CustomerAnalyticsExportInput): BuiltSheet[] {
  const { t, range } = input;
  const sales = buildSalesAnalytics({ sales: input.sales, shifts: [], range }).sales;
  const spending = customerSpendingSummary(input.customers, sales);
  const rows = topCustomers(input.customers, sales, input.customers.length || 1);
  const notes = [rangeNote(range, t), t("export.note.walkInSales")];

  if (input.customerId) {
    const history = customerPurchaseHistory(sales, input.customerId);
    const customer = input.customers.find((entry) => entry.id === input.customerId);
    const sheet: ExportSheet<(typeof history)[number]> = {
      name: t("export.sheet.purchaseHistory"),
      rows: history,
      columns: [
        { header: t("export.col.invoiceNumber"), value: (r) => r.saleNumber, width: 18 },
        { header: t("export.col.dateTime"), value: (r) => toDate(r.at), kind: "datetime", width: 20 },
        { header: t("export.col.status"), value: (r) => t(`pos.status.${r.status}` as never), width: 14 },
        { header: t("export.col.itemsCount"), value: (r) => r.items, kind: "number", width: 12 },
        { header: t("export.col.total"), value: (r) => r.total, kind: "money", width: 16 },
        { header: t("export.col.paid"), value: (r) => r.paid, kind: "money", width: 16 },
        { header: t("export.col.remaining"), value: (r) => r.owed, kind: "money", width: 16 },
      ],
      totals: [
        t("export.totalRow"),
        null,
        null,
        history.reduce((acc, r) => acc + r.items, 0),
        history.reduce((acc, r) => acc + r.total, 0),
        history.reduce((acc, r) => acc + r.paid, 0),
        history.reduce((acc, r) => acc + r.owed, 0),
      ],
      notes: [
        `${t("export.col.customer")}: ${customer?.name ?? input.customerId}`,
        ...notes,
      ],
    };
    return buildSheets([sheet] as ExportSheet<unknown>[]);
  }

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("export.sheet.customers"), count: spending.customers, amount: null, note: null },
      { label: t("export.col.buying"), count: spending.buying, amount: null, note: null },
      {
        label: t("export.metric.revenue"),
        count: null,
        amount: spending.attributedRevenue,
        note: `${spending.attributedShare}%`,
      },
      {
        label: t("export.note.walkInSales"),
        count: null,
        amount: spending.unattributedRevenue,
        note: null,
      },
      { label: t("export.col.avgSpend"), count: null, amount: spending.avgSpend, note: null },
      { label: t("export.col.avgInvoice"), count: null, amount: spending.avgInvoice, note: null },
      { label: t("export.col.repeatCustomers"), count: spending.repeat, amount: null, note: null },
      { label: t("export.col.oneTimeCustomers"), count: spending.oneTime, amount: null, note: null },
      { label: t("export.col.outstanding"), count: null, amount: spending.outstanding, note: null },
      {
        label: t("export.col.topCustomerShare"),
        count: null,
        amount: null,
        note: `${spending.topCustomerShare}%`,
      },
    ],
    notes,
    t,
  );

  const ranked: ExportSheet<CustomerReportRow> = {
    name: t("export.sheet.topCustomers"),
    rows,
    columns: [
      { header: t("export.col.customer"), value: (r) => r.name, width: 28 },
      { header: t("export.col.phone"), value: (r) => r.phone, width: 18 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.totalSpent"), value: (r) => r.spend, kind: "money", width: 16 },
      { header: t("export.col.avgInvoice"), value: (r) => r.avgInvoice, kind: "money", width: 16 },
      { header: t("export.col.outstanding"), value: (r) => r.outstanding, kind: "money", width: 16 },
      {
        header: t("export.col.lastPurchase"),
        value: (r) => toDate(r.lastPurchaseAt),
        kind: "datetime",
        width: 20,
      },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
    ],
    totals: [
      t("export.totalRow"),
      null,
      rows.reduce((acc, r) => acc + r.invoices, 0),
      spending.attributedRevenue,
      null,
      spending.outstanding,
      null,
      null,
    ],
    notes,
  };

  return buildSheets([summary, ranked] as ExportSheet<unknown>[]);
}

// ── 4. expenses ────────────────────────────────────────────────────────────
export interface ExpenseAnalyticsExportInput {
  expenses: readonly Expense[];
  range: DateRange;
  t: Translate;
}

export function buildExpenseAnalyticsSheets(input: ExpenseAnalyticsExportInput): BuiltSheet[] {
  const { t, range } = input;
  const report: ExpenseReport = buildExpenseReport(input.expenses, range);
  const notes = [rangeNote(range, t), t("export.note.expenseDay")];

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("export.metric.expenses"), count: report.totals.count, amount: report.totals.total, note: null },
      { label: t("export.metric.cash"), count: null, amount: report.totals.cash, note: null },
      { label: t("export.metric.instapay"), count: null, amount: report.totals.instapay, note: null },
      { label: t("export.metric.card"), count: null, amount: report.totals.visa, note: null },
      { label: t("export.col.activeDays"), count: report.activeDays, amount: null, note: null },
      { label: t("export.col.avgPerDay"), count: null, amount: report.avgPerActiveDay, note: null },
      {
        label: t("export.col.largest"),
        count: null,
        amount: report.largest?.amount ?? null,
        note: report.largest?.name ?? null,
      },
    ],
    notes,
    t,
  );

  const breakdownSheet = (
    name: string,
    rows: readonly ExpenseBreakdownRow[],
    labelHeader: string,
    labelOf: (row: ExpenseBreakdownRow) => string,
  ): ExportSheet<ExpenseBreakdownRow> => ({
    name,
    rows,
    columns: [
      { header: labelHeader, value: labelOf, width: 26 },
      { header: t("export.col.count"), value: (r) => r.count, kind: "number", width: 12 },
      { header: t("export.col.total"), value: (r) => r.total, kind: "money", width: 16 },
      { header: t("export.col.cash"), value: (r) => r.cash, kind: "money", width: 14 },
      { header: t("export.col.instapay"), value: (r) => r.instapay, kind: "money", width: 14 },
      { header: t("export.col.card"), value: (r) => r.visa, kind: "money", width: 14 },
      { header: t("export.col.avg"), value: (r) => r.avg, kind: "money", width: 14 },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
    ],
    totals: [
      t("export.totalRow"),
      report.totals.count,
      report.totals.total,
      report.totals.cash,
      report.totals.instapay,
      report.totals.visa,
      null,
      null,
    ],
    notes,
  });

  const byCategory = breakdownSheet(
    t("export.sheet.byCategory"),
    report.byCategory,
    t("export.col.category"),
    (row) => t(`expenses.category.${row.key}` as never),
  );
  const byEmployee = breakdownSheet(
    t("export.sheet.byEmployee"),
    report.byEmployee,
    t("export.col.employee"),
    (row) => row.label,
  );
  const byBranch = breakdownSheet(
    t("export.sheet.byRegister"),
    report.byBranch,
    t("export.col.branch"),
    (row) => (row.key === "__none__" ? t("export.row.none") : row.label),
  );

  const byDay: ExportSheet<ExpenseDayRow> = {
    name: t("export.sheet.byDay"),
    rows: report.byDay,
    columns: [
      { header: t("export.col.date"), value: (r) => toDate(r.date), kind: "date", width: 14 },
      { header: t("export.col.count"), value: (r) => r.count, kind: "number", width: 12 },
      { header: t("export.col.total"), value: (r) => r.total, kind: "money", width: 16 },
      { header: t("export.col.largest"), value: (r) => r.largest, kind: "money", width: 16 },
      { header: t("export.col.description"), value: (r) => r.largestName, width: 30 },
    ],
    totals: [
      t("export.totalRow"),
      report.totals.count,
      report.totals.total,
      report.largest?.amount ?? null,
      report.largest?.name ?? null,
    ],
    notes,
  };

  return buildSheets(
    [summary, byCategory, byEmployee, byBranch, byDay] as ExportSheet<unknown>[],
  );
}

/** The category and method vocabularies, for callers that build a filter from them. */
export const EXPENSE_REPORT_CATEGORIES = EXPENSE_CATEGORIES;
export const EXPENSE_REPORT_METHODS = EXPENSE_PAYMENT_METHODS;

// ── 5. shifts ──────────────────────────────────────────────────────────────
export interface ShiftAnalyticsExportInput {
  shifts: readonly Shift[];
  summaryFor: ShiftSummarizer;
  range: DateRange;
  t: Translate;
}

export function buildShiftAnalyticsSheets(input: ShiftAnalyticsExportInput): BuiltSheet[] {
  const { t, range } = input;
  const report = buildShiftReport(input);
  const gaps = cashDifferenceRows(report.rows);
  const gapsSummary = cashDifferenceSummary(report.rows);
  const daily = dailyShiftReport(report.rows);
  const people = employeeShiftPerformance(report.rows);
  const notes = [rangeNote(range, t), t("export.note.differencesCounted")];

  const summary = metricSheet(
    t("export.sheet.summary"),
    [
      { label: t("export.sheet.shifts"), count: report.totals.shifts, amount: null, note: null },
      { label: t("export.col.invoices"), count: report.totals.invoices, amount: null, note: null },
      { label: t("export.col.salesTotal"), count: null, amount: report.totals.salesTotal, note: null },
      { label: t("export.metric.expenses"), count: null, amount: report.totals.expensesTotal, note: null },
      { label: t("export.col.openingCash"), count: null, amount: report.totals.openingCash, note: null },
      { label: t("export.col.expectedCash"), count: null, amount: report.totals.expectedCash, note: null },
      { label: t("export.col.actualCash"), count: null, amount: report.totals.actualCash, note: null },
      { label: t("export.col.difference"), count: null, amount: report.totals.difference, note: null },
      {
        label: t("export.sheet.cashDifferences"),
        count: gapsSummary.discrepancies,
        amount: gapsSummary.net,
        note: `${gapsSummary.discrepancyRate}%`,
      },
      { label: t("export.col.exactCount"), count: gapsSummary.exact, amount: null, note: null },
    ],
    [...notes, t("export.note.negativeIsOutflow")],
    t,
  );

  const shiftsSheet: ExportSheet<ShiftReportRow> = {
    name: t("export.sheet.shifts"),
    rows: report.rows,
    columns: [
      { header: t("export.col.shiftNumber"), value: (r) => r.shiftNumber, width: 16 },
      { header: t("export.col.status"), value: (r) => t(shiftStatusKey(r.status)), width: 12 },
      { header: t("export.col.branch"), value: (r) => r.branch, width: 16 },
      { header: t("export.col.register"), value: (r) => r.register, width: 14 },
      { header: t("export.col.openedBy"), value: (r) => r.userName, width: 22 },
      { header: t("export.col.openedAt"), value: (r) => toDate(r.openedAt), kind: "datetime", width: 20 },
      { header: t("export.col.closedAt"), value: (r) => toDate(r.closedAt), kind: "datetime", width: 20 },
      { header: t("export.col.duration"), value: (r) => r.duration, width: 12 },
      { header: t("export.col.openingCash"), value: (r) => r.openingCash, kind: "money", width: 14 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.salesTotal"), value: (r) => r.salesTotal, kind: "money", width: 16 },
      { header: t("export.col.expenses"), value: (r) => r.expensesTotal, kind: "money", width: 16 },
      { header: t("export.col.expectedCash"), value: (r) => r.expectedCash, kind: "money", width: 16 },
      { header: t("export.col.actualCash"), value: (r) => r.actualCash, kind: "money", width: 16 },
      { header: t("export.col.difference"), value: (r) => r.difference, kind: "money", width: 14 },
      { header: t("export.col.notes"), value: (r) => r.notes, width: 30 },
    ],
    totals: [
      t("export.totalRow"),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      report.totals.openingCash,
      report.totals.invoices,
      report.totals.salesTotal,
      report.totals.expensesTotal,
      report.totals.expectedCash,
      report.totals.actualCash,
      report.totals.difference,
      null,
    ],
    notes,
  };

  const differences: ExportSheet<ShiftReportRow> = {
    name: t("export.sheet.cashDifferences"),
    rows: gaps,
    columns: [
      { header: t("export.col.shiftNumber"), value: (r) => r.shiftNumber, width: 16 },
      { header: t("export.col.date"), value: (r) => toDate(r.openedAt), kind: "date", width: 14 },
      { header: t("export.col.openedBy"), value: (r) => r.userName, width: 22 },
      { header: t("export.col.branch"), value: (r) => r.branch, width: 16 },
      { header: t("export.col.expectedCash"), value: (r) => r.expectedCash, kind: "money", width: 16 },
      { header: t("export.col.actualCash"), value: (r) => r.actualCash, kind: "money", width: 16 },
      { header: t("export.col.difference"), value: (r) => r.difference, kind: "money", width: 14 },
      { header: t("export.col.notes"), value: (r) => r.notes, width: 34 },
    ],
    totals: [
      t("export.totalRow"),
      null,
      null,
      null,
      null,
      null,
      gapsSummary.net,
      `${gapsSummary.unexplained} ${t("export.note.unexplained")}`,
    ],
    notes: [...notes, t("export.note.differenceSign")],
  };

  const dailySheet: ExportSheet<DailyShiftRow> = {
    name: t("export.sheet.dailyShifts"),
    rows: daily,
    columns: [
      { header: t("export.col.date"), value: (r) => toDate(r.date), kind: "date", width: 14 },
      { header: t("export.col.shifts"), value: (r) => r.shifts, kind: "number", width: 10 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.salesTotal"), value: (r) => r.salesTotal, kind: "money", width: 16 },
      { header: t("export.col.openingCash"), value: (r) => r.openingCash, kind: "money", width: 14 },
      { header: t("export.col.expenses"), value: (r) => r.expensesTotal, kind: "money", width: 16 },
      { header: t("export.col.expectedCash"), value: (r) => r.expectedCash, kind: "money", width: 16 },
      { header: t("export.col.actualCash"), value: (r) => r.actualCash, kind: "money", width: 16 },
      { header: t("export.col.difference"), value: (r) => r.difference, kind: "money", width: 14 },
    ],
    notes,
  };

  const peopleSheet: ExportSheet<EmployeeShiftRow> = {
    name: t("export.sheet.employeeShifts"),
    rows: people,
    columns: [
      { header: t("export.col.employee"), value: (r) => r.userName, width: 24 },
      { header: t("export.col.shifts"), value: (r) => r.shifts, kind: "number", width: 10 },
      { header: t("export.col.invoices"), value: (r) => r.invoices, kind: "number", width: 12 },
      { header: t("export.col.salesTotal"), value: (r) => r.salesTotal, kind: "money", width: 16 },
      { header: t("export.col.avgInvoice"), value: (r) => r.avgInvoice, kind: "money", width: 16 },
      { header: t("export.col.share"), value: (r) => r.share / 100, kind: "percent", width: 12 },
      { header: t("export.col.expenses"), value: (r) => r.expensesTotal, kind: "money", width: 16 },
      { header: t("export.col.expectedCash"), value: (r) => r.expectedCash, kind: "money", width: 16 },
      { header: t("export.col.actualCash"), value: (r) => r.actualCash, kind: "money", width: 16 },
      { header: t("export.col.difference"), value: (r) => r.difference, kind: "money", width: 14 },
      { header: t("export.col.discrepancies"), value: (r) => r.discrepancies, kind: "number", width: 14 },
      { header: t("export.col.exactCount"), value: (r) => r.exact, kind: "number", width: 12 },
    ],
    totals: [
      t("export.totalRow"),
      report.totals.shifts,
      report.totals.invoices,
      report.totals.salesTotal,
      null,
      null,
      report.totals.expensesTotal,
      report.totals.expectedCash,
      report.totals.actualCash,
      report.totals.difference,
      gapsSummary.discrepancies,
      gapsSummary.exact,
    ],
    notes,
  };

  return buildSheets(
    [summary, shiftsSheet, differences, dailySheet, peopleSheet] as ExportSheet<unknown>[],
  );
}

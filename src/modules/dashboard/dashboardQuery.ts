/**
 * Dashboard query — pure computations over existing module data.
 *
 * Every function in this module is a stateless reducer: it takes arrays of
 * domain records and returns a summary object. No side-effects, no network
 * calls, no fake numbers. The dashboard page feeds it live data from the
 * module providers that are already mounted in the app tree.
 */

// The dashboard reads the reports' analytics rather than re-deriving its own:
// requirement 8 asks for KPIs and charts, not for a second set of numbers that
// could drift from what the Reports hub shows for the same window. The date
// windows come from the picker's presets for the same reason.
import {
  computeFinancialTotals,
  type DateRange,
  type FinancialTotals,
} from "@/modules/reports/services/financialExport";
import {
  bestSellers,
  productPerformance,
  salesByPaymentMethod,
  salesInRange,
  salesTrend,
  type PaymentMethodSalesRow,
  type TrendPoint,
} from "@/modules/reports/services/salesAnalytics";
import { expensesByDay, expensesInRange } from "@/modules/reports/services/expenseAnalytics";
import {
  lastDaysRange as reportLastDaysRange,
  monthToDateRange,
} from "@/modules/reports/services/dateRanges";

import type { Product } from "@/modules/products/types";
import { stockStatus } from "@/modules/products/types";
import type { Sale } from "@/modules/pos/types";
import type { SalesReturn, RefundRecord } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";
import type { Customer } from "@/modules/customers/types";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Start of today in the local timezone (midnight). */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Is an ISO timestamp within today (local timezone)? */
function isToday(iso: string): boolean {
  return new Date(iso) >= startOfToday();
}

// ── Sales KPIs ─────────────────────────────────────────────────────────────

export interface SalesKpis {
  /** Total revenue from completed (non-voided) sales today. */
  todayRevenue: number;
  /** Number of completed (non-voided) sales today. */
  todayCount: number;
  /** Total revenue from all completed (non-voided) sales. */
  totalRevenue: number;
  /** Total number of completed (non-voided) sales. */
  totalCount: number;
  /** Sales still awaiting InstaPay confirmation. */
  pendingCount: number;
  /** Total value of pending InstaPay sales. */
  pendingTotal: number;
}

export function computeSalesKpis(sales: Sale[]): SalesKpis {
  let todayRevenue = 0;
  let todayCount = 0;
  let totalRevenue = 0;
  let totalCount = 0;
  let pendingCount = 0;
  let pendingTotal = 0;

  for (const sale of sales) {
    if (sale.status === "voided") continue;

    if (sale.status === "pending") {
      pendingCount++;
      pendingTotal += sale.total;
      continue;
    }

    // completed
    totalRevenue += sale.total;
    totalCount++;
    if (isToday(sale.created_at)) {
      todayRevenue += sale.total;
      todayCount++;
    }
  }

  return { todayRevenue, todayCount, totalRevenue, totalCount, pendingCount, pendingTotal };
}

// ── Catalog KPIs ───────────────────────────────────────────────────────────

export interface CatalogKpis {
  total: number;
  active: number;
  lowStock: number;
  outOfStock: number;
  /** Sum of (stock_quantity × cost_price) for tracked products. */
  inventoryValue: number;
}

export function computeCatalogKpis(products: Product[]): CatalogKpis {
  let active = 0;
  let lowStock = 0;
  let outOfStock = 0;
  let inventoryValue = 0;

  for (const p of products) {
    if (p.active) active++;
    const status = stockStatus(p);
    if (status === "low") lowStock++;
    if (status === "out") outOfStock++;
    if (p.stock_tracking_enabled && p.stock_quantity > 0) {
      inventoryValue += p.stock_quantity * p.cost_price;
    }
  }

  return {
    total: products.length,
    active,
    lowStock,
    outOfStock,
    inventoryValue,
  };
}

// ── Returns KPIs ───────────────────────────────────────────────────────────

export interface ReturnsKpis {
  todayCount: number;
  todayTotal: number;
  totalCount: number;
  totalRefunded: number;
  pendingRefunds: number;
}

export function computeReturnsKpis(
  returns: SalesReturn[],
  refunds: RefundRecord[],
): ReturnsKpis {
  let todayCount = 0;
  let todayTotal = 0;
  let totalCount = 0;
  let totalRefunded = 0;
  let pendingRefunds = 0;

  for (const r of returns) {
    // A rejected return is history, not a completed return/refund. It must not
    // inflate the operational count or be presented as money paid back.
    if (r.refund_status === "rejected") continue;
    totalCount++;
    if (isToday(r.created_at)) todayCount++;
    // Pending returns are work still owed; only a completed settlement counts
    // as refunded value. This is intentionally separate from the count above.
    if (r.refund_status === "completed") {
      totalRefunded += r.refund_amount;
      if (isToday(r.created_at)) todayTotal += r.refund_amount;
    }
  }

  for (const ref of refunds) {
    if (ref.status === "pending") pendingRefunds++;
  }

  return { todayCount, todayTotal, totalCount, totalRefunded, pendingRefunds };
}

// ── Recent sales ───────────────────────────────────────────────────────────

export interface RecentSale {
  id: string;
  sale_number: string;
  total: number;
  status: Sale["status"];
  payment_method: Sale["payment_method"];
  created_at: string;
  user_name: string;
  items_count: number;
}

/** Most recent non-voided sales, newest first. */
export function recentSales(sales: Sale[], limit: number): RecentSale[] {
  return sales
    .filter((s) => s.status !== "voided")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      sale_number: s.sale_number,
      total: s.total,
      status: s.status,
      payment_method: s.payment_method,
      created_at: s.created_at,
      user_name: s.user_name,
      items_count: s.items.length,
    }));
}

// ── Expenses summary ───────────────────────────────────────────────────────

export interface ExpensesKpis {
  todayTotal: number;
  todayCount: number;
  totalAmount: number;
}

export function computeExpensesKpis(expenses: Expense[]): ExpensesKpis {
  let todayTotal = 0;
  let todayCount = 0;
  let totalAmount = 0;

  for (const e of expenses) {
    totalAmount += e.amount;
    if (isToday(e.spent_at)) {
      todayTotal += e.amount;
      todayCount++;
    }
  }

  return { todayTotal, todayCount, totalAmount };
}

// ── Composite dashboard snapshot ───────────────────────────────────────────

export interface DashboardSnapshot {
  sales: SalesKpis;
  catalog: CatalogKpis;
  returns: ReturnsKpis;
  expenses: ExpensesKpis;
  customerCount: number;
  recentSales: RecentSale[];
  openShift: Shift | null;
  shiftSummary: ShiftSummary | null;
}

export function buildDashboardSnapshot(input: {
  sales: Sale[];
  products: Product[];
  returns: SalesReturn[];
  refunds: RefundRecord[];
  expenses: Expense[];
  customers: Customer[];
  openShift: Shift | null;
  shiftSummary: ShiftSummary | null;
}): DashboardSnapshot {
  return {
    sales: computeSalesKpis(input.sales),
    catalog: computeCatalogKpis(input.products),
    returns: computeReturnsKpis(input.returns, input.refunds),
    expenses: computeExpensesKpis(input.expenses),
    customerCount: input.customers.length,
    recentSales: recentSales(input.sales, 5),
    openShift: input.openShift,
    shiftSummary: input.shiftSummary,
  };
}

/* -------------------------------------------------------------------------- */
/*  Phase 14 additions — KPI cards and chart series                            */
/* -------------------------------------------------------------------------- */

/** How many days the trend and revenue-vs-expenses charts cover. */
export const DASHBOARD_TREND_DAYS = 14;

/**
 * This month so far, in the inclusive `DateRange` the report builders accept.
 *
 * "Monthly sales" on an operations dashboard means the calendar month to date,
 * not a rolling thirty days — a shopkeeper comparing the tile with their own
 * books expects the window their accountant uses. The span is the reports
 * screen's own `thisMonth` preset, so the two screens cannot define the month
 * differently.
 */
export function monthRangeOf(now: Date = new Date()): DateRange {
  return monthToDateRange(now);
}

/**
 * The last `days` calendar days, today included — the reports' helper, with the
 * dashboard's default span. Re-exported because the dashboard tests assert the
 * window the charts are drawn over.
 */
export function lastDaysRange(
  now: Date = new Date(),
  days: number = DASHBOARD_TREND_DAYS,
): DateRange {
  return reportLastDaysRange(now, days);
}

export interface MonthlyKpis {
  /** Completed invoices in the month to date. */
  revenue: number;
  invoices: number;
  /** Units behind that revenue. */
  units: number;
  /** Cost of the goods sold, on the reports' current-cost convention. */
  cost: number;
  grossProfit: number;
  /** Expenses recorded in the same window. */
  expenses: number;
  /** Revenue − cost − expenses: the month's net position. */
  profit: number;
  /** Net profit as a percent of revenue — the same 0..100 convention the
   * product analytics use, so one formatter serves both. 0 when nothing sold. */
  margin: number;
  /** Paid back out as settled refunds in the window. */
  refunds: number;
}

/**
 * This month's trading position, off the same `computeFinancialTotals` the
 * Reports hub's financial workbook is built from — so the dashboard tile and the
 * exported sheet can never disagree.
 */
export function computeMonthlyKpis(input: {
  sales: Sale[];
  products: Product[];
  expenses: Expense[];
  returnsList: SalesReturn[];
  refundsList: RefundRecord[];
  now?: Date;
}): MonthlyKpis {
  const range = monthRangeOf(input.now);
  const totals = computeFinancialTotals({
    sales: salesInRange(input.sales, range),
    products: input.products,
    expenses: expensesInRange(input.expenses, range),
    returnsList: input.returnsList,
    refundsList: input.refundsList,
  });
  return monthlyKpisFromTotals(totals);
}

/**
 * The dashboard's monthly tile, from any `FinancialTotals`.
 *
 * Split out of `computeMonthlyKpis` so the tile can be fed from either side of
 * the same agreement: totals this browser summed from the rows it holds, or
 * totals the database summed over every invoice in the month
 * (`reports_financial_summary`, via `reportAggregates.ts`). Both are
 * `FinancialTotals`, so both pass through this one mapping and the tile cannot
 * drift from the report it summarises whichever way it was filled.
 */
export function monthlyKpisFromTotals(totals: FinancialTotals): MonthlyKpis {
  return {
    revenue: totals.revenue,
    invoices: totals.invoiceCount,
    units: totals.unitCount,
    cost: totals.cogs,
    grossProfit: totals.grossProfit,
    expenses: totals.expenses,
    profit: totals.netProfit,
    margin: totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0,
    refunds: totals.refundsPaid,
  };
}

export interface RevenueVsExpensePoint {
  date: string;
  revenue: number;
  expenses: number;
}

/**
 * Revenue against expenses, one point per day, oldest first.
 *
 * Both series come from the reports analytics — `salesTrend`, which pads the
 * window so a quiet day is a flat line rather than a gap, and `expensesByDay` —
 * merged on the day key. A day with spending but no sales therefore still shows
 * its expense bar.
 */
export function revenueVsExpensesSeries(input: {
  sales: Sale[];
  expenses: Expense[];
  days?: number;
  now?: Date;
}): RevenueVsExpensePoint[] {
  const now = input.now ?? new Date();
  const range = lastDaysRange(now, input.days);
  const byDate = new Map(
    expensesByDay(expensesInRange(input.expenses, range)).map((day) => [day.date, day.total]),
  );
  return salesTrend(input.sales, range).map((point) => ({
    date: point.date,
    revenue: point.revenue,
    expenses: byDate.get(point.date) ?? 0,
  }));
}

/** Daily sales totals for the trend chart — padded and sorted by `salesTrend`. */
export function salesTrendSeries(input: {
  sales: Sale[];
  days?: number;
  now?: Date;
}): TrendPoint[] {
  const now = input.now ?? new Date();
  return salesTrend(input.sales, lastDaysRange(now, input.days));
}

/**
 * Payment-method totals for the distribution donut, over the month to date so it
 * lines up with the monthly tiles beside it.
 */
export function paymentMix(sales: Sale[], now?: Date): PaymentMethodSalesRow[] {
  return salesByPaymentMethod(salesInRange(sales, monthRangeOf(now)));
}

export interface TopProductRow {
  id: string;
  nameEn: string;
  nameAr: string;
  units: number;
  revenue: number;
  profit: number;
}

/**
 * Best sellers for the dashboard card.
 *
 * Ranked by the same `bestSellers` the advanced product report uses, so the
 * dashboard's "top selling products" and the top of that report's table are the
 * same list. Names are carried in both languages and the page picks, because a
 * query module has no locale.
 */
export function topProducts(input: {
  sales: Sale[];
  products: Product[];
  limit?: number;
  now?: Date;
  days?: number;
}): TopProductRow[] {
  const now = input.now ?? new Date();
  const range = lastDaysRange(now, input.days);
  const limit = Math.max(1, Math.floor(input.limit ?? 5));
  return bestSellers(
    productPerformance(salesInRange(input.sales, range), input.products),
    limit,
  ).map((row) => ({
    id: row.productId,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    units: row.units,
    revenue: row.revenue,
    profit: row.profit,
  }));
}

/**
 * Month-to-date expense total, for the "expenses summary" tile.
 *
 * Kept beside {@link computeExpensesKpis} (all-time + today) rather than folded
 * into it, so the existing tiles and their tests stay exactly as they were.
 */
export function monthExpensesTotal(expenses: Expense[], now: Date = new Date()): number {
  return expensesInRange(expenses, monthRangeOf(now)).reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

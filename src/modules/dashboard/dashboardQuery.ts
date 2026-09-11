/**
 * Dashboard query — pure computations over existing module data.
 *
 * Every function in this module is a stateless reducer: it takes arrays of
 * domain records and returns a summary object. No side-effects, no network
 * calls, no fake numbers. The dashboard page feeds it live data from the
 * module providers that are already mounted in the app tree.
 */

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
  let totalCount = returns.length;
  let totalRefunded = 0;
  let pendingRefunds = 0;

  for (const r of returns) {
    totalRefunded += r.refund_amount;
    if (isToday(r.created_at)) {
      todayCount++;
      todayTotal += r.refund_amount;
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

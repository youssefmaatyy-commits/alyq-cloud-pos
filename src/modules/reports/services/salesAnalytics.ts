/**
 * Sales, product and customer analytics — the arithmetic behind the reports.
 *
 * Requirement 7 asks for numbers the app already holds in different shapes:
 * sales by employee, by register, by payment method and by day; best sellers,
 * slow movers, stock value and margin; top customers and what they bought. None
 * of it is new *data*, so none of it gets a new source of truth. This file is
 * pure functions over the rows the providers already fetched, and it leans on
 * the calculations that were already written and already tested:
 *
 *   · `revenueSales` / `costOfGoodsSold` / `computeFinancialTotals`
 *     (financialExport) decide what counts as revenue and what a unit cost —
 *     a voided invoice is not a sale here exactly as it is not a sale there.
 *   · `paymentTotals` / `paymentRowsOf` (salesExport, financialExport) split an
 *     invoice across methods, so a split payment is counted once per method and
 *     never twice.
 *   · `customerPurchaseStats` (customersExport) is the per-customer roll-up the
 *     customer book already shows; "top customers" is that map, ranked.
 *   · `stockValueAtCost` / `stockValueAtRetail` (inventoryExport) value a
 *     product the way the stock screen does.
 *   · `shiftWindowOf` / `isWithinWindow` (shiftCalculations) attribute an
 *     invoice to a branch and register, because a sale row does not carry them —
 *     the shift it happened inside does.
 *
 * Two rules the whole file follows:
 *
 *   1. **Percentages are shares of the same denominator the row was built
 *      from**, and a share is 0 rather than NaN when the denominator is 0. A
 *      report that shows "NaN%" on an empty range is a report nobody trusts.
 *   2. **Nothing here knows about translation, money formatting or Excel.** Rows
 *      carry keys (`method: "instapay"`, `category: "supplies"`) and the caller
 *      turns them into words, so the same function feeds an Arabic screen, an
 *      English screen and a spreadsheet without branching.
 */
import { roundMoney } from "@/modules/expenses/validation";
import { withinDateRange } from "@/lib/export";
import { PAYMENT_METHODS, type PaymentMethod, type Sale } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { Customer } from "@/modules/customers/types";
import type { Shift } from "@/modules/shifts/types";
import { paymentTotals, totalQuantity } from "@/modules/pos/services/salesExport";
import { customerPurchaseStats } from "@/modules/customers/services/customersExport";
import {
  stockValueAtCost,
  stockValueAtRetail,
} from "@/modules/inventory/services/inventoryExport";
import { isWithinWindow, shiftWindowOf } from "@/modules/shifts/services/shiftCalculations";
import {
  costOfGoodsSold,
  revenueSales,
  type DateRange,
} from "./financialExport";

/**
 * Share of a whole, in percent, with the empty case answered as 0.
 *
 * Exported for `reportAggregates.ts`: the database returns the additive parts
 * (an employee's revenue, the range's revenue) and the percentage is derived
 * here, in the one place that has always defined it. A second definition of
 * `share` in the database would be a second answer to the same question.
 */
export function share(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return roundMoney((part / whole) * 100);
}

/** The invoices that count, inside a range. One definition, used everywhere. */
export function salesInRange(sales: readonly Sale[], range: DateRange): Sale[] {
  return revenueSales(sales).filter((sale) =>
    withinDateRange(sale.created_at, range.from, range.to),
  );
}

function sumRevenue(sales: readonly Sale[]): number {
  return roundMoney(sales.reduce((acc, sale) => acc + sale.total, 0));
}

// ── sales by employee ──────────────────────────────────────────────────────
export interface EmployeeSalesRow {
  userId: string;
  userName: string;
  invoices: number;
  units: number;
  revenue: number;
  /** Discount given away on this person's invoices — the number a supervisor asks for. */
  discounts: number;
  avgInvoice: number;
  /** Percent of the range's revenue. */
  share: number;
}

/**
 * Who sold what.
 *
 * Attribution is the `user_id` stamped on the invoice, which is the till
 * operator signed in when it was completed — including an approver replaying an
 * over-limit draft, because that sale is theirs to have written. Sorted by
 * revenue, because that is the order the question is asked in.
 */
export function salesByEmployee(sales: readonly Sale[]): EmployeeSalesRow[] {
  const rows = new Map<string, EmployeeSalesRow>();
  const live = revenueSales(sales);
  const total = sumRevenue(live);

  for (const sale of live) {
    const key = sale.user_id || "unknown";
    const row =
      rows.get(key) ??
      ({
        userId: key,
        userName: sale.user_name || "—",
        invoices: 0,
        units: 0,
        revenue: 0,
        discounts: 0,
        avgInvoice: 0,
        share: 0,
      } satisfies EmployeeSalesRow);
    row.invoices += 1;
    row.units += totalQuantity(sale);
    row.revenue = roundMoney(row.revenue + sale.total);
    row.discounts = roundMoney(row.discounts + (sale.discount_amount || 0));
    rows.set(key, row);
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      avgInvoice: row.invoices > 0 ? roundMoney(row.revenue / row.invoices) : 0,
      share: share(row.revenue, total),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.invoices - a.invoices);
}

// ── sales by branch / register ─────────────────────────────────────────────
export interface RegisterSalesRow {
  /** `branch · register`, or the unattributed key when no shift contains the sale. */
  key: string;
  branch: string;
  register: string;
  shifts: number;
  invoices: number;
  units: number;
  revenue: number;
  share: number;
}

/** The bucket an invoice goes in when no shift window contains it. */
export const UNATTRIBUTED_REGISTER = "__unattributed__";

/**
 * Where the money was taken.
 *
 * An invoice carries no branch or register of its own — the shift it happened
 * inside does — so attribution is by time window, using the same
 * `shiftWindowOf` / `isWithinWindow` the shift summary uses. That has one
 * honest consequence: a sale completed outside any shift (a demo import, an
 * online order approved with no till open) cannot be placed, and is reported in
 * its own row rather than being silently folded into a branch it did not happen
 * at. Callers render that row with `registerLabelOf`.
 */
export function salesByRegister(sales: readonly Sale[], shifts: readonly Shift[]): RegisterSalesRow[] {
  const live = revenueSales(sales);
  const total = sumRevenue(live);
  const rows = new Map<string, RegisterSalesRow>();
  const shiftCount = new Map<string, number>();

  for (const shift of shifts) {
    const key = `${shift.branch} · ${shift.register}`;
    shiftCount.set(key, (shiftCount.get(key) ?? 0) + 1);
  }

  const windows = shifts.map((shift) => ({
    key: `${shift.branch} · ${shift.register}`,
    branch: shift.branch,
    register: shift.register,
    window: shiftWindowOf(shift),
  }));

  for (const sale of live) {
    const placed = windows.find((candidate) => isWithinWindow(sale.created_at, candidate.window));
    const key = placed?.key ?? UNATTRIBUTED_REGISTER;
    const row =
      rows.get(key) ??
      ({
        key,
        branch: placed?.branch ?? "",
        register: placed?.register ?? "",
        shifts: placed ? (shiftCount.get(placed.key) ?? 0) : 0,
        invoices: 0,
        units: 0,
        revenue: 0,
        share: 0,
      } satisfies RegisterSalesRow);
    row.invoices += 1;
    row.units += totalQuantity(sale);
    row.revenue = roundMoney(row.revenue + sale.total);
    rows.set(key, row);
  }

  return [...rows.values()]
    .map((row) => ({ ...row, share: share(row.revenue, total) }))
    .sort((a, b) => b.revenue - a.revenue);
}

// ── sales by payment method ────────────────────────────────────────────────
export interface PaymentMethodSalesRow {
  method: PaymentMethod;
  /** Invoices that used this method at all (a split payment counts in both). */
  invoices: number;
  amount: number;
  paid: number;
  pending: number;
  share: number;
}

/**
 * How the range was paid for.
 *
 * Built from `paymentTotals`, the same per-invoice split the payments export and
 * the financial summary use, so the three cannot disagree. The share is of the
 * money *applied* to invoices, which sums to more than the invoice total when a
 * payment was tendered with change — the denominator here is the sum of the
 * method amounts, which is what makes the column add to 100%.
 */
export function salesByPaymentMethod(sales: readonly Sale[]): PaymentMethodSalesRow[] {
  const rows = new Map<PaymentMethod, PaymentMethodSalesRow>();
  const live = revenueSales(sales);

  for (const method of PAYMENT_METHODS) {
    rows.set(method, { method, invoices: 0, amount: 0, paid: 0, pending: 0, share: 0 });
  }

  let whole = 0;
  for (const sale of live) {
    const totals = paymentTotals(sale);
    for (const method of PAYMENT_METHODS) {
      const amount = totals[method] || 0;
      if (amount <= 0) continue;
      const row = rows.get(method)!;
      row.invoices += 1;
      row.amount = roundMoney(row.amount + amount);
      whole += amount;
    }
    // Settled vs still owed, per invoice: an invoice with any unpaid payment
    // contributes its unpaid remainder to `pending` on its own method.
    for (const payment of sale.payments) {
      const row = rows.get(payment.method);
      if (!row) continue;
      if (payment.status === "paid") row.paid = roundMoney(row.paid + payment.amount);
      else row.pending = roundMoney(row.pending + payment.amount);
    }
    if (sale.payments.length === 0) {
      const row = rows.get(sale.payment_method ?? "cash");
      if (row) {
        if (sale.payment_status === "paid") row.paid = roundMoney(row.paid + sale.total);
        else row.pending = roundMoney(row.pending + sale.total);
      }
    }
  }

  return [...rows.values()]
    .filter((row) => row.invoices > 0 || row.amount > 0)
    .map((row) => ({ ...row, share: share(row.amount, whole) }))
    .sort((a, b) => PAYMENT_METHODS.indexOf(a.method) - PAYMENT_METHODS.indexOf(b.method));
}

// ── sales trend ────────────────────────────────────────────────────────────
export interface TrendPoint {
  /** `yyyy-mm-dd`, in local time — the unit a shop thinks in. */
  date: string;
  invoices: number;
  units: number;
  revenue: number;
  discounts: number;
}

/** The local calendar day an ISO timestamp falls in. */
export function dayKeyOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Revenue per day, oldest first.
 *
 * When both bounds of the range are known the series is *filled*: a day with no
 * sales appears as a zero rather than disappearing, because a trend line that
 * skips quiet days draws a shop that never has any. With an open-ended range
 * only days that happened are returned — inventing months of zeros for "all
 * time" would be worse than showing the days that exist.
 */
export function salesTrend(sales: readonly Sale[], range?: DateRange): TrendPoint[] {
  const live = revenueSales(sales);
  const days = new Map<string, TrendPoint>();

  const put = (key: string): TrendPoint => {
    let point = days.get(key);
    if (!point) {
      point = { date: key, invoices: 0, units: 0, revenue: 0, discounts: 0 };
      days.set(key, point);
    }
    return point;
  };

  for (const sale of live) {
    if (range && !withinDateRange(sale.created_at, range.from, range.to)) continue;
    const key = dayKeyOf(sale.created_at);
    if (!key) continue;
    const point = put(key);
    point.invoices += 1;
    point.units += totalQuantity(sale);
    point.revenue = roundMoney(point.revenue + sale.total);
    point.discounts = roundMoney(point.discounts + (sale.discount_amount || 0));
  }

  if (range?.from && range?.to) {
    const from = new Date(`${range.from}T00:00:00`);
    const to = new Date(`${range.to}T00:00:00`);
    // A guard as much as a limit: a typo'd range of ten years would otherwise
    // build four thousand empty points to draw a flat line.
    const MAX_DAYS = 400;
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && to >= from) {
      const span = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
      if (span <= MAX_DAYS) {
        for (let index = 0; index < span; index += 1) {
          const day = new Date(from.getTime() + index * 86_400_000);
          const pad = (n: number) => String(n).padStart(2, "0");
          put(`${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`);
        }
      }
    }
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── product performance ────────────────────────────────────────────────────
export interface ProductPerformanceRow {
  productId: string;
  sku: string;
  nameEn: string;
  nameAr: string;
  /** In the catalogue but not sold in the range: `false`. */
  sold: boolean;
  invoices: number;
  units: number;
  revenue: number;
  /** The price it is on the shelf at now — what a non-mover is asking for. */
  sellingPrice: number;
  /** Units sold × the product's *current* cost — the COGS convention the financial report uses. */
  cost: number;
  profit: number;
  /** Percent of revenue. 0 when nothing was sold. */
  margin: number;
  stock: number;
  stockValue: number;
}

/**
 * What each product did in the range.
 *
 * Every catalogue product gets a row, sold or not: "slow mover" is only
 * meaningful against the things that did not move, and a report that lists only
 * winners cannot answer the question it is being asked. Cost is the *current*
 * purchase price, the same convention `costOfGoodsSold` uses, so this table's
 * profit column and the financial report's gross profit agree — with the same
 * caveat the financial export prints: a product whose cost changed mid-range is
 * costed at today's price.
 */
export function productPerformance(
  sales: readonly Sale[],
  products: readonly Product[],
): ProductPerformanceRow[] {
  const live = revenueSales(sales);
  const costById = new Map(products.map((product) => [product.id, Number(product.cost_price ?? 0)]));

  const rows = new Map<string, ProductPerformanceRow>();
  for (const product of products) {
    rows.set(product.id, {
      productId: product.id,
      sku: product.sku,
      nameEn: product.name_en,
      nameAr: product.name_ar,
      sold: false,
      invoices: 0,
      units: 0,
      revenue: 0,
      sellingPrice: Number(product.selling_price ?? 0),
      cost: 0,
      profit: 0,
      margin: 0,
      stock: product.stock_tracking_enabled ? product.stock_quantity : 0,
      stockValue: roundMoney(stockValueAtCost(product)),
    });
  }

  for (const sale of live) {
    for (const item of sale.items) {
      const row = rows.get(item.product_id);
      if (!row) continue; // a product deleted since the sale: its money is still in the invoice total
      row.sold = true;
      row.invoices += 1;
      row.units += item.quantity;
      row.revenue = roundMoney(row.revenue + item.line_total);
    }
  }

  // Cost and profit come from `costOfGoodsSold`'s own rule, applied per product.
  for (const row of rows.values()) {
    row.cost = roundMoney(row.units * (costById.get(row.productId) ?? 0));
    row.profit = roundMoney(row.revenue - row.cost);
    row.margin = share(row.profit, row.revenue);
  }

  return [...rows.values()];
}

/** The products that moved most, by units then by revenue. */
export function bestSellers(rows: readonly ProductPerformanceRow[], limit = 5): ProductPerformanceRow[] {
  return rows
    .filter((row) => row.units > 0)
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
    .slice(0, limit);
}

export interface SlowMoverRow extends ProductPerformanceRow {
  /** What the unsold stock is worth at cost — the money the slow mover is holding. */
  tiedUp: number;
}

/**
 * The products that did not move.
 *
 * Tracked, active, in stock, and (almost) unsold in the range — ranked by the
 * money tied up in them, because "this did not sell" is only interesting in
 * proportion to what it is costing the shop to hold. Untracked and inactive
 * products are left out: neither is a purchasing mistake waiting to be noticed.
 */
export function slowMovers(
  products: readonly Product[],
  rows: readonly ProductPerformanceRow[],
  limit = 10,
): SlowMoverRow[] {
  const byId = new Map(products.map((product) => [product.id, product]));
  return rows
    .map((row) => ({ ...row, tiedUp: row.stockValue }))
    .filter((row) => {
      const product = byId.get(row.productId);
      if (!product) return false;
      if (!product.active) return false;
      if (!product.stock_tracking_enabled) return false;
      if (product.stock_quantity <= 0) return false;
      return row.units <= 0;
    })
    .sort((a, b) => b.tiedUp - a.tiedUp || a.units - b.units)
    .slice(0, limit);
}

export interface StockValueTotals {
  products: number;
  tracked: number;
  units: number;
  atCost: number;
  atRetail: number;
  /** atRetail − atCost: what the shelf is worth if all of it sells. */
  potentialMargin: number;
  lowStock: number;
  outOfStock: number;
}

/** The whole shelf, valued the way the stock screen values one product. */
export function stockValueTotals(products: readonly Product[]): StockValueTotals {
  const tracked = products.filter((product) => product.stock_tracking_enabled);
  let units = 0;
  let atCost = 0;
  let atRetail = 0;
  let lowStock = 0;
  let outOfStock = 0;

  for (const product of tracked) {
    units += product.stock_quantity;
    atCost += stockValueAtCost(product);
    atRetail += stockValueAtRetail(product);
    if (product.stock_quantity <= 0) outOfStock += 1;
    else if (product.stock_quantity <= product.low_stock_level) lowStock += 1;
  }

  return {
    products: products.length,
    tracked: tracked.length,
    units,
    atCost: roundMoney(atCost),
    atRetail: roundMoney(atRetail),
    potentialMargin: roundMoney(atRetail - atCost),
    lowStock,
    outOfStock,
  };
}

export interface MarginSummary {
  revenue: number;
  cogs: number;
  profit: number;
  /** Percent of revenue across the range. */
  margin: number;
  soldProducts: number;
  /** Highest and lowest margin among products that actually sold. */
  best: ProductPerformanceRow | null;
  worst: ProductPerformanceRow | null;
  /** Products sold below cost, which is the finding the summary exists to surface. */
  lossMakers: ProductPerformanceRow[];
}

/**
 * Margin across the range, and the products at either end of it.
 *
 * Revenue and COGS come from `computeFinancialTotals`' building blocks, so this
 * agrees with the financial report by construction rather than by coincidence.
 */
export function marginSummary(
  sales: readonly Sale[],
  products: readonly Product[],
  rows: readonly ProductPerformanceRow[],
): MarginSummary {
  const live = revenueSales(sales);
  const revenue = sumRevenue(live);
  const cogs = costOfGoodsSold(
    sales,
    new Map(products.map((product) => [product.id, Number(product.cost_price ?? 0)])),
  );
  const sold = rows.filter((row) => row.units > 0);
  const ranked = [...sold].sort((a, b) => b.margin - a.margin || b.profit - a.profit);

  return {
    revenue,
    cogs,
    profit: roundMoney(revenue - cogs),
    margin: share(revenue - cogs, revenue),
    soldProducts: sold.length,
    best: ranked[0] ?? null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    lossMakers: sold.filter((row) => row.profit < 0).sort((a, b) => a.profit - b.profit),
  };
}

// ── customers ──────────────────────────────────────────────────────────────
export interface CustomerReportRow {
  customerId: string;
  name: string;
  phone: string;
  invoices: number;
  spend: number;
  /** Unsettled portion of their invoices — money the shop is still owed. */
  outstanding: number;
  avgInvoice: number;
  lastPurchaseAt: string | null;
  /** Percent of the range's attributed revenue. */
  share: number;
}

/**
 * The customer book, ranked.
 *
 * The per-customer numbers are `customerPurchaseStats` — the same roll-up the
 * customer export writes — so "top customers" and the customer book cannot tell
 * two different stories about the same person. Invoices with no customer on
 * them (walk-in till sales) are not attributed to anybody, and the summary
 * reports how much of the range that is.
 */
export function topCustomers(
  customers: readonly Customer[],
  sales: readonly Sale[],
  limit = 10,
): CustomerReportRow[] {
  const stats = customerPurchaseStats(sales);
  const attributed = roundMoney(
    [...stats.values()].reduce((acc, entry) => acc + entry.totalSpent, 0),
  );

  const rows: CustomerReportRow[] = [];
  for (const customer of customers) {
    const entry = stats.get(customer.id);
    if (!entry || entry.count === 0) continue;
    rows.push({
      customerId: customer.id,
      name: customer.name,
      phone: customer.phone,
      invoices: entry.count,
      spend: entry.totalSpent,
      outstanding: entry.outstanding,
      avgInvoice: entry.count > 0 ? roundMoney(entry.totalSpent / entry.count) : 0,
      lastPurchaseAt: entry.lastPurchaseAt,
      share: share(entry.totalSpent, attributed),
    });
  }

  return rows.sort((a, b) => b.spend - a.spend || b.invoices - a.invoices).slice(0, limit);
}

export interface CustomerHistoryRow {
  saleId: string;
  saleNumber: string;
  at: string;
  status: Sale["status"];
  items: number;
  total: number;
  paid: number;
  owed: number;
}

/** One customer's invoices, newest first — what the customer detail page lists. */
export function customerPurchaseHistory(
  sales: readonly Sale[],
  customerId: string,
): CustomerHistoryRow[] {
  return sales
    .filter((sale) => sale.customer_id === customerId)
    .map((sale) => {
      const totals = paymentTotals(sale);
      return {
        saleId: sale.id,
        saleNumber: sale.sale_number,
        at: sale.created_at,
        status: sale.status,
        items: totalQuantity(sale),
        total: sale.total,
        paid: totals.paid,
        owed: roundMoney(Math.max(0, sale.total - totals.paid)),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export interface CustomerSpendingSummary {
  customers: number;
  /** Customers with at least one invoice in the range. */
  buying: number;
  attributedRevenue: number;
  /** Revenue with no customer on the invoice — the walk-in till. */
  unattributedRevenue: number;
  /** Percent of the range's revenue that carries a name. */
  attributedShare: number;
  avgSpend: number;
  avgInvoice: number;
  /** Bought more than once: the number a loyalty decision is made on. */
  repeat: number;
  oneTime: number;
  outstanding: number;
  /** Percent of attributed revenue held by the top customer. */
  topCustomerShare: number;
}

/** How concentrated the spending is — the question behind "who are our customers?". */
export function customerSpendingSummary(
  customers: readonly Customer[],
  sales: readonly Sale[],
): CustomerSpendingSummary {
  const rows = topCustomers(customers, sales, customers.length || 1);
  const attributed = roundMoney(rows.reduce((acc, row) => acc + row.spend, 0));
  const totalRevenue = sumRevenue(revenueSales(sales));
  const invoices = rows.reduce((acc, row) => acc + row.invoices, 0);

  return {
    customers: customers.length,
    buying: rows.length,
    attributedRevenue: attributed,
    unattributedRevenue: roundMoney(Math.max(0, totalRevenue - attributed)),
    attributedShare: share(attributed, totalRevenue),
    avgSpend: rows.length > 0 ? roundMoney(attributed / rows.length) : 0,
    avgInvoice: invoices > 0 ? roundMoney(attributed / invoices) : 0,
    repeat: rows.filter((row) => row.invoices > 1).length,
    oneTime: rows.filter((row) => row.invoices === 1).length,
    outstanding: roundMoney(rows.reduce((acc, row) => acc + row.outstanding, 0)),
    topCustomerShare: rows.length > 0 ? rows[0].share : 0,
  };
}

/**
 * Everything the sales reports need, in one call.
 *
 * The page and the export both build from this, which is the point: a number on
 * screen and the same number in the file come from one function, so they cannot
 * drift apart the way two implementations eventually do.
 */
export interface SalesAnalytics {
  range: DateRange;
  sales: Sale[];
  invoices: number;
  units: number;
  revenue: number;
  discounts: number;
  avgInvoice: number;
  byEmployee: EmployeeSalesRow[];
  byRegister: RegisterSalesRow[];
  byPaymentMethod: PaymentMethodSalesRow[];
  trend: TrendPoint[];
}

export function buildSalesAnalytics(input: {
  sales: readonly Sale[];
  shifts: readonly Shift[];
  range: DateRange;
}): SalesAnalytics {
  const sales = salesInRange(input.sales, input.range);
  const revenue = sumRevenue(sales);
  const units = sales.reduce((acc, sale) => acc + totalQuantity(sale), 0);
  const discounts = roundMoney(sales.reduce((acc, sale) => acc + (sale.discount_amount || 0), 0));

  return {
    range: input.range,
    sales,
    invoices: sales.length,
    units,
    revenue,
    discounts,
    avgInvoice: sales.length > 0 ? roundMoney(revenue / sales.length) : 0,
    byEmployee: salesByEmployee(sales),
    byRegister: salesByRegister(sales, input.shifts),
    byPaymentMethod: salesByPaymentMethod(sales),
    trend: salesTrend(sales, input.range),
  };
}

/**
 * Dashboard query self-test (headless, Node).
 *
 * Covers every pure function in dashboardQuery.ts: sales KPIs, catalog KPIs,
 * returns KPIs, expenses KPIs, recent-sales ordering, and the composite
 * snapshot builder, plus the Phase 14 additions — month-to-date KPIs and the
 * chart series the dashboard draws. No React, no network, no mock data — just
 * reducers over domain records.
 *
 * The Phase 14 cases pin a fixed "now" rather than using the clock: the windows
 * they assert on (this month, the last N days) are defined relative to today, so
 * a test that reads the wall clock would change meaning on the first of a month.
 */
import assert from "node:assert/strict";
import {
  computeSalesKpis,
  computeCatalogKpis,
  computeReturnsKpis,
  computeExpensesKpis,
  recentSales,
  buildDashboardSnapshot,
  computeMonthlyKpis,
  lastDaysRange,
  monthExpensesTotal,
  monthRangeOf,
  paymentMix,
  revenueVsExpensesSeries,
  salesTrendSeries,
  topProducts,
} from "../dashboardQuery";
import type { Sale, SaleItem, SalePayment } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { SalesReturn, RefundRecord } from "@/modules/returns/types";
import type { Expense } from "@/modules/expenses/types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A timestamp that is inside today at *any* hour the suite happens to run.
 *
 * Anchored to noon rather than to `now` on purpose. Subtracting hours from the
 * current time rolled fixtures into yesterday between 00:00 and 03:00, which
 * made "expenses: today vs total" fail depending on the clock instead of the
 * code — and clamping only the rolled values broke the ordering the
 * `recentSales` tests rely on, because a clamped 00:57 is *newer* than a real
 * 01:00. A fixed anchor keeps every fixture on the same day and monotonic:
 * a larger `hoursAgo` is always older.
 *
 * `isToday()` in the code under test is `>= startOfToday()`, so a timestamp
 * later today still counts as today.
 */
function todayISO(hoursAgo = 0): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setHours(d.getHours() - hoursAgo);
  return d.toISOString();
}

/** Yesterday at noon, for the same reason — never a rolling 24 hours ago. */
function yesterdayISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function sale(partial: Partial<Sale> & { id: string; total: number }): Sale {
  return {
    sale_number: `INV-${partial.id}`,
    client_ref: `ref-${partial.id}`,
    status: "completed",
    subtotal: partial.total,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    payments: [],
    created_at: todayISO(1),
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: partial.total,
    change: 0,
    paid_at: todayISO(1),
    paid_by: "u1",
    paid_by_name: "Cashier",
    ...partial,
  } as Sale;
}

function product(partial: Partial<Product> & { id: string }): Product {
  return {
    sku: `SKU-${partial.id}`,
    name_ar: "منتج",
    name_en: "Product",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "good",
    selling_price: 100,
    cost_price: 50,
    tax_rate: 0,
    barcode: null,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 3,
    show_on_website: true,
    is_featured: false,
    active: true,
    images: [],
    created_at: todayISO(),
    updated_at: todayISO(),
    ...partial,
  } as Product;
}

function salesReturn(partial: Partial<SalesReturn> & { id: string; refund_amount: number }): SalesReturn {
  return {
    return_number: `RET-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-1",
    customer_id: null,
    customer_name: null,
    reason: "test",
    refund_method: "cash",
    refund_status: "completed",
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    created_at: todayISO(1),
    ...partial,
  } as SalesReturn;
}

function refund(partial: Partial<RefundRecord> & { id: string; amount: number }): RefundRecord {
  return {
    refund_number: `REF-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-1",
    return_id: null,
    payment_method: "cash",
    status: "completed",
    reason: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: todayISO(1),
    ...partial,
  } as RefundRecord;
}

function expense(partial: Partial<Expense> & { id: string; amount: number }): Expense {
  return {
    expense_number: `EXP-${partial.id}`,
    name: "Transport",
    category: "transport",
    payment_method: "cash",
    spent_at: todayISO(1),
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: null,
    shift_id: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: todayISO(1),
    updated_at: todayISO(1),
    ...partial,
  } as Expense;
}

// ── Sales KPIs ──────────────────────────────────────────────────────────────

test("sales: empty list yields zeroes", () => {
  const kpis = computeSalesKpis([]);
  assert.equal(kpis.todayRevenue, 0);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalRevenue, 0);
  assert.equal(kpis.totalCount, 0);
  assert.equal(kpis.pendingCount, 0);
  assert.equal(kpis.pendingTotal, 0);
});

test("sales: completed sales today counted in both today and total", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(2) }),
    sale({ id: "2", total: 250, created_at: todayISO(1) }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.todayRevenue, 350);
  assert.equal(kpis.todayCount, 2);
  assert.equal(kpis.totalRevenue, 350);
  assert.equal(kpis.totalCount, 2);
});

test("sales: yesterday's sale excluded from today but included in total", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(1) }),
    sale({ id: "2", total: 200, created_at: yesterdayISO() }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.todayRevenue, 100);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.totalRevenue, 300);
  assert.equal(kpis.totalCount, 2);
});

test("sales: voided sales excluded from revenue and counts", () => {
  const sales = [
    sale({ id: "1", total: 100 }),
    sale({ id: "2", total: 500, status: "voided" }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.totalRevenue, 100);
  assert.equal(kpis.totalCount, 1);
});

test("sales: pending InstaPay sales tracked separately", () => {
  const sales = [
    sale({ id: "1", total: 100 }),
    sale({ id: "2", total: 200, status: "pending" }),
    sale({ id: "3", total: 50, status: "pending" }),
  ];
  const kpis = computeSalesKpis(sales);
  assert.equal(kpis.totalRevenue, 100);
  assert.equal(kpis.pendingCount, 2);
  assert.equal(kpis.pendingTotal, 250);
});

// ── Catalog KPIs ────────────────────────────────────────────────────────────

test("catalog: empty products yields zeroes", () => {
  const kpis = computeCatalogKpis([]);
  assert.equal(kpis.total, 0);
  assert.equal(kpis.active, 0);
  assert.equal(kpis.lowStock, 0);
  assert.equal(kpis.outOfStock, 0);
  assert.equal(kpis.inventoryValue, 0);
});

test("catalog: active/inactive counts", () => {
  const products = [
    product({ id: "1", active: true }),
    product({ id: "2", active: true }),
    product({ id: "3", active: false }),
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.total, 3);
  assert.equal(kpis.active, 2);
});

test("catalog: low stock detected", () => {
  const products = [
    product({ id: "1", stock_quantity: 2, low_stock_level: 5 }), // low
    product({ id: "2", stock_quantity: 10, low_stock_level: 3 }), // in
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.lowStock, 1);
});

test("catalog: out of stock detected", () => {
  const products = [
    product({ id: "1", stock_quantity: 0 }), // out
    product({ id: "2", stock_quantity: 5 }), // in
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.outOfStock, 1);
});

test("catalog: untracked products excluded from stock counts", () => {
  const products = [
    product({ id: "1", stock_tracking_enabled: false, stock_quantity: 0 }),
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.outOfStock, 0);
  assert.equal(kpis.lowStock, 0);
});

test("catalog: inventory value sums stock × cost_price for tracked products", () => {
  const products = [
    product({ id: "1", stock_quantity: 10, cost_price: 50 }),
    product({ id: "2", stock_quantity: 5, cost_price: 20 }),
    product({ id: "3", stock_quantity: 0, cost_price: 100 }), // zero stock → 0
    product({ id: "4", stock_tracking_enabled: false, stock_quantity: 10, cost_price: 30 }), // untracked → 0
  ];
  const kpis = computeCatalogKpis(products);
  assert.equal(kpis.inventoryValue, 10 * 50 + 5 * 20);
});

// ── Returns KPIs ────────────────────────────────────────────────────────────

test("returns: empty yields zeroes", () => {
  const kpis = computeReturnsKpis([], []);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalCount, 0);
  assert.equal(kpis.totalRefunded, 0);
  assert.equal(kpis.pendingRefunds, 0);
});

test("returns: today and total counts", () => {
  const returns = [
    salesReturn({ id: "1", refund_amount: 50, created_at: todayISO(1) }),
    salesReturn({ id: "2", refund_amount: 100, created_at: yesterdayISO() }),
  ];
  const kpis = computeReturnsKpis(returns, []);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.todayTotal, 50);
  assert.equal(kpis.totalCount, 2);
  assert.equal(kpis.totalRefunded, 150);
});

test("returns: pending refunds counted", () => {
  const refunds = [
    refund({ id: "1", amount: 100, status: "pending" }),
    refund({ id: "2", amount: 200, status: "completed" }),
    refund({ id: "3", amount: 50, status: "pending" }),
  ];
  const kpis = computeReturnsKpis([], refunds);
  assert.equal(kpis.pendingRefunds, 2);
});

test("returns: rejected or pending settlements never count as refunded money", () => {
  const returns = [
    salesReturn({ id: "done", refund_amount: 100, refund_status: "completed" }),
    salesReturn({ id: "waiting", refund_amount: 80, refund_status: "pending" }),
    salesReturn({ id: "declined", refund_amount: 60, refund_status: "rejected" }),
  ];
  const kpis = computeReturnsKpis(returns, []);
  assert.equal(kpis.todayCount, 2, "completed and pending returns remain operational work");
  assert.equal(kpis.totalCount, 2, "a rejected return is not a completed return");
  assert.equal(kpis.todayTotal, 100, "only completed money is shown as refunded");
  assert.equal(kpis.totalRefunded, 100);
});

// ── Expenses KPIs ───────────────────────────────────────────────────────────

test("expenses: empty yields zeroes", () => {
  const kpis = computeExpensesKpis([]);
  assert.equal(kpis.todayTotal, 0);
  assert.equal(kpis.todayCount, 0);
  assert.equal(kpis.totalAmount, 0);
});

test("expenses: today vs total", () => {
  const expenses = [
    expense({ id: "1", amount: 30, spent_at: todayISO(1) }),
    expense({ id: "2", amount: 70, spent_at: yesterdayISO() }),
  ];
  const kpis = computeExpensesKpis(expenses);
  assert.equal(kpis.todayTotal, 30);
  assert.equal(kpis.todayCount, 1);
  assert.equal(kpis.totalAmount, 100);
});

// ── Recent sales ────────────────────────────────────────────────────────────

test("recentSales: returns newest first, limited", () => {
  const sales = [
    sale({ id: "1", total: 100, created_at: todayISO(3) }),
    sale({ id: "2", total: 200, created_at: todayISO(1) }),
    sale({ id: "3", total: 300, created_at: todayISO(2) }),
  ];
  const result = recentSales(sales, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "2"); // newest
  assert.equal(result[1].id, "3");
});

test("recentSales: voided sales excluded", () => {
  const sales = [
    sale({ id: "1", total: 100, status: "voided" }),
    sale({ id: "2", total: 200 }),
  ];
  const result = recentSales(sales, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "2");
});

test("recentSales: items_count derived from items array", () => {
  const sales = [
    sale({
      id: "1",
      total: 100,
      items: [
        { id: "i1", sale_id: "1", product_id: "p1", variant_id: null, variant_color_ar: null, variant_color_en: null, variant_size: null, variant_size_label: null, name_ar: "", name_en: "", sku: "", barcode: null, unit_price: 50, quantity: 1, line_total: 50 },
        { id: "i2", sale_id: "1", product_id: "p2", variant_id: null, variant_color_ar: null, variant_color_en: null, variant_size: null, variant_size_label: null, name_ar: "", name_en: "", sku: "", barcode: null, unit_price: 50, quantity: 1, line_total: 50 },
      ],
    }),
  ];
  const result = recentSales(sales, 5);
  assert.equal(result[0].items_count, 2);
});

// ── Composite snapshot ──────────────────────────────────────────────────────

test("buildDashboardSnapshot: combines all KPIs", () => {
  const snap = buildDashboardSnapshot({
    sales: [sale({ id: "1", total: 100 })],
    products: [product({ id: "1" })],
    returns: [],
    refunds: [],
    expenses: [expense({ id: "1", amount: 20 })],
    customers: [{ id: "c1" }] as any,
    openShift: null,
    shiftSummary: null,
  });

  assert.equal(snap.sales.totalRevenue, 100);
  assert.equal(snap.catalog.total, 1);
  assert.equal(snap.returns.totalCount, 0);
  assert.equal(snap.expenses.totalAmount, 20);
  assert.equal(snap.customerCount, 1);
  assert.equal(snap.recentSales.length, 1);
  assert.equal(snap.openShift, null);
});

// ── Phase 14: month-to-date KPIs and chart series ───────────────────────────

/** A fixed "now" so month and rolling-day windows are deterministic. */
const NOW = new Date(2026, 8, 12, 10, 30, 0); // 2026-09-12 10:30 local

function iso(year: number, monthIndex: number, day: number, hour = 12): string {
  return new Date(year, monthIndex, day, hour, 0, 0, 0).toISOString();
}

function line(productId: string, quantity: number, unitPrice: number): SaleItem {
  return {
    id: `${productId}-${quantity}`,
    sale_id: "s",
    product_id: productId,
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    name_ar: "منتج",
    name_en: `Product ${productId}`,
    sku: `SKU-${productId}`,
    barcode: null,
    unit_price: unitPrice,
    quantity,
    line_total: Math.round(quantity * unitPrice * 100) / 100,
  };
}

function paid(method: SalePayment["method"], amount: number): SalePayment {
  return {
    id: `pay-${method}-${amount}`,
    sale_id: "s",
    method,
    amount,
    status: "paid",
    paid_at: iso(2026, 8, 12),
    paid_by: "u1",
    paid_by_name: "Cashier",
  };
}

test("monthRangeOf spans the first of the month to today", () => {
  assert.deepEqual(monthRangeOf(NOW), { from: "2026-09-01", to: "2026-09-12" });
  // A window is inclusive of the day it ends on, not of its midnight start.
  assert.deepEqual(monthRangeOf(new Date(2026, 0, 1, 0, 5)), { from: "2026-01-01", to: "2026-01-01" });
});

test("lastDaysRange counts today as one of the days", () => {
  assert.deepEqual(lastDaysRange(NOW, 3), { from: "2026-09-10", to: "2026-09-12" });
  assert.deepEqual(lastDaysRange(NOW, 1), { from: "2026-09-12", to: "2026-09-12" });
  // Crossing a month boundary must not clamp to the first of the month.
  assert.deepEqual(lastDaysRange(new Date(2026, 8, 2, 9), 5), { from: "2026-08-29", to: "2026-09-02" });
});

test("computeMonthlyKpis totals the month, costs the goods and nets the expenses", () => {
  const products = [product({ id: "p1", cost_price: 50, selling_price: 100 })];
  const sales = [
    // In the window: 2 units at 100 = 200 revenue, 100 cost.
    sale({
      id: "in-month",
      total: 200,
      created_at: iso(2026, 8, 5),
      items: [line("p1", 2, 100)],
      payments: [paid("cash", 200)],
    }),
    // Last month: excluded from every figure.
    sale({
      id: "last-month",
      total: 900,
      created_at: iso(2026, 7, 20),
      items: [line("p1", 9, 100)],
      payments: [paid("cash", 900)],
    }),
    // Voided in the window: not revenue.
    sale({
      id: "voided",
      total: 70,
      status: "voided",
      created_at: iso(2026, 8, 6),
      items: [line("p1", 1, 70)],
      payments: [paid("cash", 70)],
    }),
  ];
  const expenses = [
    expense({ id: "e-in", amount: 40, spent_at: iso(2026, 8, 5) }),
    expense({ id: "e-out", amount: 500, spent_at: iso(2026, 7, 20) }),
  ];

  const kpis = computeMonthlyKpis({
    sales,
    products,
    expenses,
    returnsList: [],
    refundsList: [],
    now: NOW,
  });

  assert.equal(kpis.revenue, 200);
  assert.equal(kpis.invoices, 1);
  assert.equal(kpis.units, 2);
  assert.equal(kpis.cost, 100);
  assert.equal(kpis.grossProfit, 100);
  assert.equal(kpis.expenses, 40);
  assert.equal(kpis.profit, 60);
  // Net margin, in the analytics' 0..100 convention: 60 / 200.
  assert.equal(Math.round(kpis.margin * 10) / 10, 30);
});

test("computeMonthlyKpis reports a loss and zero margin when nothing sold", () => {
  const kpis = computeMonthlyKpis({
    sales: [],
    products: [],
    expenses: [expense({ id: "e", amount: 25, spent_at: iso(2026, 8, 3) })],
    returnsList: [],
    refundsList: [],
    now: NOW,
  });
  assert.equal(kpis.revenue, 0);
  assert.equal(kpis.profit, -25);
  assert.equal(kpis.margin, 0);
});

test("salesTrendSeries pads every day of the window and sorts oldest first", () => {
  const sales = [
    sale({ id: "d0", total: 100, created_at: iso(2026, 8, 10), payments: [paid("cash", 100)] }),
    sale({ id: "d2", total: 250, created_at: iso(2026, 8, 12), payments: [paid("cash", 250)] }),
  ];
  const points = salesTrendSeries({ sales, days: 3, now: NOW });

  assert.deepEqual(points.map((p) => p.date), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.deepEqual(points.map((p) => p.revenue), [100, 0, 250]);
  // A day outside the window is not drawn at all.
  assert.equal(
    salesTrendSeries({
      sales: [...sales, sale({ id: "old", total: 9, created_at: iso(2026, 8, 1) })],
      days: 3,
      now: NOW,
    }).reduce((sum, p) => sum + p.revenue, 0),
    350,
  );
});

test("revenueVsExpensesSeries merges both series on the day, keeping expense-only days", () => {
  const sales = [sale({ id: "s", total: 300, created_at: iso(2026, 8, 12), payments: [paid("cash", 300)] })];
  const expenses = [
    expense({ id: "e1", amount: 50, spent_at: iso(2026, 8, 11) }), // no sales that day
    expense({ id: "e2", amount: 70, spent_at: iso(2026, 8, 12) }),
  ];

  const points = revenueVsExpensesSeries({ sales, expenses, days: 3, now: NOW });

  assert.deepEqual(points.map((p) => p.date), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.deepEqual(points.map((p) => p.revenue), [0, 0, 300]);
  assert.deepEqual(points.map((p) => p.expenses), [0, 50, 70]);
});

test("paymentMix covers the month to date and skips voided invoices", () => {
  const sales = [
    sale({ id: "cash", total: 100, created_at: iso(2026, 8, 2), payments: [paid("cash", 100)] }),
    sale({
      id: "split",
      total: 300,
      created_at: iso(2026, 8, 4),
      payments: [paid("cash", 100), paid("instapay", 200)],
    }),
    sale({
      id: "old",
      total: 999,
      created_at: iso(2026, 7, 1),
      payments: [paid("visa", 999)],
    }),
    sale({
      id: "void",
      total: 55,
      status: "voided",
      created_at: iso(2026, 8, 5),
      payments: [paid("cash", 55)],
    }),
  ];

  const rows = paymentMix(sales, NOW);
  const byMethod = new Map(rows.map((r) => [r.method, r.amount]));

  assert.equal(byMethod.get("cash"), 200);
  assert.equal(byMethod.get("instapay"), 200);
  // Last month's card payment and the voided invoice are both out of the window.
  assert.equal(byMethod.has("visa"), false);
  assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), 400);
});

test("topProducts ranks by units, honours the limit and carries both names", () => {
  const products = [
    product({ id: "p1", name_en: "Tea", name_ar: "شاي", cost_price: 5, selling_price: 10 }),
    product({ id: "p2", name_en: "Earrings", name_ar: "أقراط", cost_price: 20, selling_price: 40 }),
    product({ id: "p3", name_en: "Water", name_ar: "ماء", cost_price: 1, selling_price: 3 }),
  ];
  const sales = [
    sale({
      id: "a",
      total: 100,
      created_at: iso(2026, 8, 11),
      items: [line("p1", 10, 10)],
      payments: [paid("cash", 100)],
    }),
    sale({
      id: "b",
      total: 120,
      created_at: iso(2026, 8, 12),
      items: [line("p2", 3, 40)],
      payments: [paid("cash", 120)],
    }),
  ];

  const top = topProducts({ sales, products, limit: 2, now: NOW, days: 3 });

  assert.deepEqual(top.map((row) => row.id), ["p1", "p2"]);
  assert.equal(top[0].units, 10);
  assert.equal(top[0].revenue, 100);
  assert.equal(top[0].profit, 50); // 10 units × (10 − 5)
  assert.equal(top[0].nameAr, "شاي");
  assert.equal(top[0].nameEn, "Tea");
  // A product nobody bought in the window is not a best seller, and neither is
  // one whose only sale fell outside it.
  assert.equal(top.some((row) => row.id === "p3"), false);
  assert.deepEqual(
    topProducts({
      sales: [...sales, sale({
        id: "outside",
        total: 30,
        created_at: iso(2026, 8, 1),
        items: [line("p3", 10, 3)],
        payments: [paid("cash", 30)],
      })],
      products,
      limit: 5,
      now: NOW,
      days: 3,
    }).map((row) => row.id),
    ["p1", "p2"],
  );
});

test("monthExpensesTotal counts the month to date only", () => {
  const expenses = [
    expense({ id: "a", amount: 30, spent_at: iso(2026, 8, 1) }),
    expense({ id: "b", amount: 12.5, spent_at: iso(2026, 8, 12) }),
    expense({ id: "c", amount: 1000, spent_at: iso(2026, 7, 31) }),
  ];
  assert.equal(monthExpensesTotal(expenses, NOW), 42.5);
  assert.equal(monthExpensesTotal([], NOW), 0);
});

// ── Runner ──────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

run();

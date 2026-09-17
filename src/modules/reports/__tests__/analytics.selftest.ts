/**
 * Advanced reports self-test (Phase 14, requirements 1, 3, 4, 7).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs analytics`).
 *
 * These are the numbers an owner makes decisions from, so the suite tests them
 * against fixtures whose correct answer is worked out by hand in the comments —
 * not against a second implementation of the same arithmetic, which would only
 * prove that two copies agree with each other.
 *
 * What is under test:
 *
 *   1. **Attribution.** A sale belongs to the employee who rang it, to the shift
 *      window it happened inside, and to each payment method it was split
 *      across — once, and never twice.
 *   2. **Exclusion.** A voided invoice is not revenue in any of these reports,
 *      exactly as it is not revenue in the financial report they reuse.
 *   3. **Arithmetic.** Margins, shares, averages and differences, including the
 *      empty-range cases where the honest answer is 0 rather than NaN.
 *   4. **Grouping.** Days, categories and employees that had no activity still
 *      appear where their absence would mislead (a trend line, a category list)
 *      and are left out where it would not.
 *   5. **Reuse.** The shift report reads `summaryFor` rather than recomputing a
 *      drawer, and the expense report's totals are `summarizeExpenses` — asserted
 *      here so a future edit cannot quietly fork either calculation.
 */
import assert from "node:assert/strict";
import process from "node:process";

import type { Translate, PickBilingual } from "@/lib/export";
import type { Sale, SaleItem, SalePayment } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { Customer } from "@/modules/customers/types";
import type { Expense } from "@/modules/expenses/types";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";
import { summarizeExpenses } from "@/modules/expenses/services/expenseService";
import { OPEN_DATE_RANGE } from "../services/financialExport";
import {
  UNATTRIBUTED_REGISTER,
  bestSellers,
  buildSalesAnalytics,
  customerPurchaseHistory,
  customerSpendingSummary,
  dayKeyOf,
  marginSummary,
  productPerformance,
  salesByEmployee,
  salesByPaymentMethod,
  salesByRegister,
  salesTrend,
  slowMovers,
  stockValueTotals,
  topCustomers,
} from "../services/salesAnalytics";
import { buildExpenseReport, expensesByDay, expensesInRange } from "../services/expenseAnalytics";
import {
  buildShiftReport,
  cashDifferenceRows,
  cashDifferenceSummary,
  dailyShiftReport,
  employeeShiftPerformance,
} from "../services/shiftAnalytics";
import {
  buildCustomerAnalyticsSheets,
  buildExpenseAnalyticsSheets,
  buildProductAnalyticsSheets,
  buildSalesAnalyticsSheets,
  buildShiftAnalyticsSheets,
} from "../services/analyticsExport";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

/** Answers with the key, so an untranslated label is visible in a failure. */
const t = ((key: string) => key) as unknown as Translate;
const pick = ((arabic: string | null, english: string | null) => english || arabic || "") as unknown as PickBilingual;

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

function item(productId: string, qty: number, unitPrice: number): SaleItem {
  return {
    id: nextId("item"),
    sale_id: "",
    product_id: productId,
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    name_ar: "منتج",
    name_en: "Product",
    sku: productId,
    barcode: null,
    unit_price: unitPrice,
    quantity: qty,
    line_total: Math.round(qty * unitPrice * 100) / 100,
  };
}

function payment(method: SalePayment["method"], amount: number, status: "paid" | "pending" = "paid"): SalePayment {
  return {
    id: nextId("pay"),
    sale_id: "",
    method,
    amount,
    status,
    paid_at: status === "paid" ? "2026-03-01T10:00:00.000Z" : null,
    paid_by: null,
    paid_by_name: null,
  };
}

/** A complete invoice. Totals are derived from the lines so a fixture cannot lie. */
function sale(patch: Partial<Sale> & { items: SaleItem[]; created_at: string }): Sale {
  const subtotal = patch.items.reduce((acc, line) => acc + line.line_total, 0);
  const discountAmount = patch.discount_amount ?? 0;
  const total = Math.round((subtotal - discountAmount) * 100) / 100;
  const payments = patch.payments ?? [payment("cash", total)];
  const base: Sale = {
    id: nextId("sale"),
    sale_number: `INV-${String(seq).padStart(6, "0")}`,
    client_ref: nextId("ref"),
    status: "completed",
    subtotal,
    discount_type: discountAmount > 0 ? "fixed" : "none",
    discount_value: discountAmount,
    discount_amount: discountAmount,
    total,
    user_id: "u-cashier",
    user_name: "Cashier",
    items: patch.items,
    payments,
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    created_at: patch.created_at,
    voided_at: null,
    void_reason: null,
    payment_method: payments[0]?.method ?? "cash",
    payment_status: payments.every((p) => p.status === "paid") ? "paid" : "pending",
    amount_received: null,
    change: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    source: "pos",
  };
  return { ...base, ...patch };
}

function product(patch: Partial<Product> & { id: string }): Product {
  return {
    sku: patch.id.toUpperCase(),
    barcode: null,
    name_ar: "منتج",
    name_en: patch.id,
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 100,
    cost_price: 60,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 3,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Product;
}

function customer(patch: Partial<Customer> & { id: string }): Customer {
  return {
    name: patch.id,
    phone: "01000000000",
    address: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Customer;
}

function expense(patch: Partial<Expense> & { id: string }): Expense {
  return {
    expense_number: `EXP-${patch.id}`,
    name: patch.name ?? "Expense",
    category: "supplies",
    amount: 100,
    payment_method: "cash",
    spent_at: "2026-03-10T09:00:00.000Z",
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: "Main",
    shift_id: null,
    user_id: "u-cashier",
    user_name: "Cashier",
    created_at: "2026-03-10T09:00:00.000Z",
    updated_at: "2026-03-10T09:00:00.000Z",
    ...patch,
  } as Expense;
}

function shift(patch: Partial<Shift> & { id: string }): Shift {
  return {
    shift_number: `SH-${patch.id}`,
    branch: "Main",
    register: "R1",
    status: "closed",
    opening_cash: 500,
    opening_at: "2026-03-10T09:00:00.000Z",
    opened_by: "u-cashier",
    opened_by_name: "Cashier",
    closing_cash: null,
    closed_at: "2026-03-10T17:00:00.000Z",
    closed_by: "u-cashier",
    closed_by_name: "Cashier",
    notes: null,
    summary: null,
    adjustment_approved_by: null,
    adjustment_approved_by_name: null,
    adjustment_approved_at: null,
    created_at: "2026-03-10T09:00:00.000Z",
    updated_at: "2026-03-10T17:00:00.000Z",
    ...patch,
  } as Shift;
}

/** The drawer picture the shift screen would show — the report must read it, not redo it. */
function summary(patch: Partial<ShiftSummary>): ShiftSummary {
  return {
    sales_count: 0,
    sales_total: 0,
    voided_count: 0,
    voided_total: 0,
    cash_sales: 0,
    instapay_sales: 0,
    instapay_pending: 0,
    mixed_count: 0,
    mixed_total: 0,
    payments_breakdown: [],
    returns_count: 0,
    returns_total: 0,
    refunds_count: 0,
    refunds_total: 0,
    cash_refunds: 0,
    instapay_refunds: 0,
    visa_refunds: 0,
    pending_refunds: 0,
    expenses_count: 0,
    expenses_total: 0,
    cash_expenses: 0,
    instapay_expenses: 0,
    visa_expenses: 0,
    expected_cash: 0,
    actual_cash: null,
    difference: null,
    ...patch,
  } as ShiftSummary;
}

const MARCH = { from: "2026-03-01", to: "2026-03-31" };

console.log("\nPhase 14 · advanced reports");

// ── 1. sales by employee ──────────────────────────────────────────────────
test("sales are attributed to the employee who rang them, voids to nobody", () => {
  const earrings = product({ id: "p1", selling_price: 100, cost_price: 60 });
  const sales = [
    // Cashier: 2 invoices, 200 + 300, one with a 20 discount already inside total.
    sale({ items: [item(earrings.id, 2, 100)], created_at: "2026-03-02T10:00:00.000Z", user_id: "u-1", user_name: "Cashier" }),
    sale({
      items: [item(earrings.id, 3, 100)],
      created_at: "2026-03-03T10:00:00.000Z",
      user_id: "u-1",
      user_name: "Cashier",
      discount_amount: 20,
    }),
    // Manager: 1 invoice, 500.
    sale({ items: [item(earrings.id, 5, 100)], created_at: "2026-03-04T10:00:00.000Z", user_id: "u-2", user_name: "Manager" }),
    // Voided: 999 that must not appear anywhere.
    sale({
      items: [item(earrings.id, 1, 999)],
      created_at: "2026-03-05T10:00:00.000Z",
      user_id: "u-3",
      user_name: "Ghost",
      status: "voided",
    }),
  ];

  const rows = salesByEmployee(sales);
  assert.equal(rows.length, 2, "the voided invoice's operator is not in the report");
  assert.deepEqual(
    rows.map((row) => row.userName),
    ["Manager", "Cashier"],
    "ranked by revenue, which is the order the question is asked in",
  );

  const cashier = rows.find((row) => row.userId === "u-1")!;
  assert.equal(cashier.invoices, 2);
  assert.equal(cashier.units, 5);
  assert.equal(cashier.revenue, 480, "200 + (300 − 20 discount)");
  assert.equal(cashier.discounts, 20, "the discount given away is its own column");
  assert.equal(cashier.avgInvoice, 240);

  const whole = rows.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(whole - 100) < 0.02, `shares add to 100 (got ${whole})`);
});

test("an empty range reports zeros rather than NaN", () => {
  const rows = salesByEmployee([]);
  assert.deepEqual(rows, []);
  assert.deepEqual(salesByPaymentMethod([]), []);
  assert.deepEqual(salesByRegister([], []), []);
  const analytics = buildSalesAnalytics({ sales: [], shifts: [], range: OPEN_DATE_RANGE });
  assert.equal(analytics.revenue, 0);
  assert.equal(analytics.avgInvoice, 0, "no invoices means no average, not a division by zero");
});

// ── 2. sales by branch / register ─────────────────────────────────────────
test("an invoice is placed by the shift window it happened inside", () => {
  const earrings = product({ id: "p1" });
  const morning = shift({
    id: "s1",
    branch: "Main",
    register: "R1",
    opening_at: "2026-03-10T08:00:00.000Z",
    closed_at: "2026-03-10T16:00:00.000Z",
  });
  const evening = shift({
    id: "s2",
    branch: "Branch 2",
    register: "R7",
    opening_at: "2026-03-10T16:00:00.000Z",
    closed_at: "2026-03-11T00:00:00.000Z",
  });

  const sales = [
    sale({ items: [item(earrings.id, 1, 100)], created_at: "2026-03-10T09:30:00.000Z" }),
    sale({ items: [item(earrings.id, 2, 100)], created_at: "2026-03-10T18:00:00.000Z" }),
    // No shift was open on the 1st: this one cannot be placed, and says so.
    sale({ items: [item(earrings.id, 3, 100)], created_at: "2026-03-01T09:00:00.000Z" }),
  ];

  const rows = salesByRegister(sales, [morning, evening]);
  assert.equal(rows.length, 3, "two registers and one honest 'unknown'");
  const unattributed = rows.find((row) => row.key === UNATTRIBUTED_REGISTER);
  assert.ok(unattributed, "a sale outside every shift window is reported, not folded into a branch");
  assert.equal(unattributed.revenue, 300);
  assert.equal(unattributed.shifts, 0);

  const main = rows.find((row) => row.register === "R1")!;
  assert.equal(main.branch, "Main");
  assert.equal(main.revenue, 100);
  assert.equal(main.shifts, 1);
});

// ── 3. sales by payment method ────────────────────────────────────────────
test("a split payment counts once per method and never twice", () => {
  const earrings = product({ id: "p1" });
  // 500 invoice: 300 cash + 200 InstaPay still pending confirmation.
  const split = sale({
    items: [item(earrings.id, 5, 100)],
    created_at: "2026-03-06T10:00:00.000Z",
    payments: [payment("cash", 300), payment("instapay", 200, "pending")],
  });
  const cashOnly = sale({
    items: [item(earrings.id, 1, 100)],
    created_at: "2026-03-07T10:00:00.000Z",
  });

  const rows = salesByPaymentMethod([split, cashOnly]);
  const cash = rows.find((row) => row.method === "cash")!;
  const instapay = rows.find((row) => row.method === "instapay")!;

  assert.equal(cash.amount, 400, "300 of the split + 100 cash-only");
  assert.equal(cash.invoices, 2, "the split invoice counts in both methods it used");
  assert.equal(instapay.amount, 200);
  assert.equal(instapay.invoices, 1);
  assert.equal(instapay.pending, 200, "unconfirmed InstaPay is pending, not paid");
  assert.equal(cash.paid, 400);

  const whole = rows.reduce((acc, row) => acc + row.amount, 0);
  assert.equal(whole, 600, "the methods add to the invoices' totals");
  const shares = rows.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(shares - 100) < 0.02, `shares add to 100 (got ${shares})`);
});

// ── 4. trend ──────────────────────────────────────────────────────────────
test("a trend fills the quiet days inside a bounded range", () => {
  const earrings = product({ id: "p1" });
  const sales = [
    sale({ items: [item(earrings.id, 1, 100)], created_at: "2026-03-01T10:00:00.000Z" }),
    sale({ items: [item(earrings.id, 2, 100)], created_at: "2026-03-04T10:00:00.000Z" }),
    // Outside the range: must not appear, and must not stretch the series.
    sale({ items: [item(earrings.id, 9, 100)], created_at: "2026-04-01T10:00:00.000Z" }),
  ];

  const series = salesTrend(sales, { from: "2026-03-01", to: "2026-03-05" });
  assert.deepEqual(
    series.map((point) => point.date),
    ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"],
    "every day in the window, oldest first",
  );
  assert.equal(series[1].revenue, 0, "a quiet day is a zero, not a gap");
  assert.equal(series[1].invoices, 0);
  assert.equal(series[3].revenue, 200);
  assert.equal(series.reduce((acc, point) => acc + point.revenue, 0), 300);

  const openEnded = salesTrend(sales);
  assert.equal(openEnded.length, 3, "with no bounds only days that happened are listed");
  assert.equal(dayKeyOf("2026-03-04T23:30:00.000Z"), "2026-03-04");
});

// ── 5. products ───────────────────────────────────────────────────────────
test("product performance costs sold units at the current purchase price", () => {
  const earrings = product({ id: "earrings", selling_price: 100, cost_price: 60, stock_quantity: 8 });
  const pearls = product({ id: "pearls", selling_price: 200, cost_price: 250, stock_quantity: 4 }); // sold below cost
  const idle = product({ id: "idle", selling_price: 500, cost_price: 300, stock_quantity: 6 }); // no sales
  const off = product({ id: "off", selling_price: 50, cost_price: 30, stock_quantity: 3, active: false });
  const untracked = product({ id: "service", stock_tracking_enabled: false, stock_quantity: 0 });

  const products = [earrings, pearls, idle, off, untracked];
  const sales = [
    sale({ items: [item(earrings.id, 3, 100), item(pearls.id, 1, 200)], created_at: "2026-03-02T10:00:00.000Z" }),
    sale({ items: [item(earrings.id, 2, 100)], created_at: "2026-03-03T10:00:00.000Z" }),
  ];

  const rows = productPerformance(sales, products);
  assert.equal(rows.length, products.length, "every catalogue product gets a row, sold or not");

  const earringsRow = rows.find((row) => row.productId === earrings.id)!;
  assert.equal(earringsRow.units, 5);
  assert.equal(earringsRow.revenue, 500);
  assert.equal(earringsRow.cost, 300, "5 × the current cost of 60");
  assert.equal(earringsRow.profit, 200);
  assert.equal(earringsRow.margin, 40, "200 of 500");
  assert.equal(earringsRow.stockValue, 480, "8 on hand × 60");

  const pearlsRow = rows.find((row) => row.productId === pearls.id)!;
  assert.equal(pearlsRow.profit, -50, "sold below cost, and the report says so in the negative");

  const idleRow = rows.find((row) => row.productId === idle.id)!;
  assert.equal(idleRow.sold, false);
  assert.equal(idleRow.margin, 0, "nothing sold means no margin, not a division by zero");

  // Best sellers rank by units; the idle product is not one.
  const best = bestSellers(rows, 5);
  assert.deepEqual(
    best.map((row) => row.productId),
    ["earrings", "pearls"],
  );

  // Slow movers: tracked, active, holding stock, unsold. Inactive and untracked
  // products are neither, and a sold-out product is not a purchasing mistake.
  const slow = slowMovers(products, rows, 10);
  assert.deepEqual(
    slow.map((row) => row.productId),
    ["idle"],
    "the inactive product and the untracked service are left out",
  );
  assert.equal(slow[0].tiedUp, 1800, "6 × 300: the money the non-mover is holding");

  const stock = stockValueTotals(products);
  assert.equal(stock.tracked, 4, "the untracked service is not stock");
  assert.equal(stock.units, 21);
  assert.equal(stock.atCost, 60 * 8 + 250 * 4 + 300 * 6 + 30 * 3);
  assert.equal(stock.potentialMargin, stock.atRetail - stock.atCost);
  assert.equal(stock.outOfStock, 0, "nothing tracked is at zero here");
  assert.equal(stock.lowStock, 1, "the deactivated product is at its threshold, which still counts as low");

  const margin = marginSummary(sales, products, rows);
  assert.equal(margin.revenue, 700, "500 earrings + 200 pearls");
  assert.equal(margin.cogs, 550, "(5 × 60) + (1 × 250) — pearls cost more than they sold for");
  assert.equal(margin.profit, 150);
  assert.equal(margin.margin, 21.43, "150 of 700");
  assert.deepEqual(
    margin.lossMakers.map((row) => row.productId),
    ["pearls"],
    "the finding the summary exists to surface",
  );
  assert.equal(margin.best?.productId, "earrings");
});

// ── 6. customers ──────────────────────────────────────────────────────────
test("top customers rank the book, and walk-in sales stay unattributed", () => {
  const earrings = product({ id: "p1" });
  const lana = customer({ id: "c-lana", name: "Lana" });
  const omar = customer({ id: "c-omar", name: "Omar" });
  const quiet = customer({ id: "c-quiet", name: "Quiet" });

  const sales = [
    sale({ items: [item(earrings.id, 5, 100)], created_at: "2026-03-02T10:00:00.000Z", customer_id: lana.id, customer_name: lana.name }),
    sale({
      items: [item(earrings.id, 2, 100)],
      created_at: "2026-03-05T10:00:00.000Z",
      customer_id: lana.id,
      customer_name: lana.name,
      payments: [payment("cash", 100), payment("instapay", 100, "pending")],
    }),
    sale({ items: [item(earrings.id, 3, 100)], created_at: "2026-03-06T10:00:00.000Z", customer_id: omar.id, customer_name: omar.name }),
    // Walk-in: no customer on the invoice.
    sale({ items: [item(earrings.id, 1, 100)], created_at: "2026-03-07T10:00:00.000Z" }),
  ];

  const rows = topCustomers([lana, omar, quiet], sales, 10);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Lana", "Omar"],
    "ranked by spend, and a customer who never bought is not in the report",
  );
  assert.equal(rows[0].invoices, 2);
  assert.equal(rows[0].spend, 700);
  assert.equal(rows[0].avgInvoice, 350);
  assert.equal(rows[0].outstanding, 100, "the unsettled InstaPay is money still owed");
  assert.equal(rows[0].lastPurchaseAt, "2026-03-05T10:00:00.000Z");

  const spending = customerSpendingSummary([lana, omar, quiet], sales);
  assert.equal(spending.customers, 3);
  assert.equal(spending.buying, 2);
  assert.equal(spending.attributedRevenue, 1000);
  assert.equal(spending.unattributedRevenue, 100, "the walk-in invoice is nobody's");
  assert.equal(spending.repeat, 1);
  assert.equal(spending.oneTime, 1);
  assert.equal(spending.outstanding, 100);
  assert.equal(spending.topCustomerShare, 70, "700 of the 1000 attributed");

  const history = customerPurchaseHistory(sales, lana.id);
  assert.deepEqual(
    history.map((row) => row.at),
    ["2026-03-05T10:00:00.000Z", "2026-03-02T10:00:00.000Z"],
    "newest first, the way the customer page reads",
  );
  assert.equal(history[0].owed, 100);
  assert.equal(history[1].owed, 0);
});

// ── 7. expenses ───────────────────────────────────────────────────────────
test("the expense report reuses the module's own totals and breaks them down", () => {
  const expenses = [
    expense({ id: "1", category: "transport", amount: 120, spent_at: "2026-03-01T08:00:00.000Z", user_id: "u-1", user_name: "Cashier" }),
    expense({ id: "2", category: "transport", amount: 80, spent_at: "2026-03-02T08:00:00.000Z", user_id: "u-1", user_name: "Cashier", payment_method: "instapay" }),
    expense({ id: "3", category: "maintenance", amount: 500, spent_at: "2026-03-02T12:00:00.000Z", user_id: "u-2", user_name: "Manager", branch: "Branch 2" }),
    // April: outside the window.
    expense({ id: "4", category: "supplies", amount: 999, spent_at: "2026-04-02T08:00:00.000Z" }),
  ];

  const report = buildExpenseReport(expenses, MARCH);
  assert.equal(report.expenses.length, 3, "ranged on the day the money was spent");
  assert.deepEqual(expensesInRange(expenses, MARCH).map((e) => e.id), ["1", "2", "3"]);

  // The totals are `summarizeExpenses` — the same numbers the Expenses screen
  // shows, asserted equal rather than reimplemented.
  assert.deepEqual(report.totals, summarizeExpenses(report.expenses));
  assert.equal(report.totals.total, 700);
  assert.equal(report.totals.cash, 620);
  assert.equal(report.totals.instapay, 80);

  const transport = report.byCategory.find((row) => row.key === "transport")!;
  assert.equal(transport.count, 2);
  assert.equal(transport.total, 200);
  assert.equal(transport.avg, 100);
  assert.ok(
    report.byCategory.some((row) => row.key === "utilities" && row.total === 0),
    "a category with no spending still appears, so the list reads as the vocabulary it is",
  );
  const shares = report.byCategory.reduce((acc, row) => acc + row.share, 0);
  assert.ok(Math.abs(shares - 100) < 0.02, `category shares add to 100 (got ${shares})`);

  const cashier = report.byEmployee.find((row) => row.key === "u-1")!;
  assert.equal(cashier.label, "Cashier");
  assert.equal(cashier.total, 200);
  assert.equal(report.byEmployee[0].key, "u-2", "biggest spender first");

  assert.equal(report.activeDays, 2);
  assert.equal(report.avgPerActiveDay, 350);
  assert.equal(report.largest?.id, "3");
  assert.deepEqual(
    report.byDay.map((day) => day.date),
    ["2026-03-01", "2026-03-02"],
    "oldest first — a spending trend reads forwards",
  );
  assert.equal(report.byDay[1].largest, 500);
  assert.equal(report.byDay[1].largestName, "Expense");

  const days = expensesByDay(expenses);
  assert.equal(days.length, 3, "unranged, April is its own day");
});

// ── 8. shifts ─────────────────────────────────────────────────────────────
test("the shift report reads the drawer instead of recomputing it", () => {
  const summaries = new Map<string, ShiftSummary>([
    [
      "s1",
      summary({
        sales_count: 12,
        sales_total: 1400,
        cash_sales: 900,
        cash_refunds: 50,
        cash_expenses: 100,
        expenses_count: 2,
        expenses_total: 150,
        expected_cash: 1250, // 500 float + 900 in − 50 refunds − 100 expenses
        actual_cash: 1238,
        difference: -12,
      }),
    ],
    [
      "s2",
      summary({
        sales_count: 5,
        sales_total: 600,
        cash_sales: 600,
        expected_cash: 1100,
        actual_cash: 1100,
        difference: 0,
      }),
    ],
  ]);
  const summaryFor = (candidate: Shift) => summaries.get(candidate.id) ?? null;

  const shifts = [
    shift({ id: "s1", opened_by: "u-1", opened_by_name: "Cashier", opening_at: "2026-03-10T08:00:00.000Z", notes: null }),
    shift({ id: "s2", opened_by: "u-2", opened_by_name: "Manager", branch: "Branch 2", register: "R7", opening_at: "2026-03-11T08:00:00.000Z" }),
    // Open drawer: sales but no counted cash yet.
    shift({
      id: "s3",
      status: "open",
      opened_by: "u-1",
      opened_by_name: "Cashier",
      opening_at: "2026-03-12T08:00:00.000Z",
      closed_at: null,
    }),
    // Outside the window.
    shift({ id: "s4", opening_at: "2026-02-01T08:00:00.000Z" }),
  ];

  const report = buildShiftReport({ shifts, summaryFor, range: MARCH });
  assert.equal(report.rows.length, 3, "the February drawer is out of range");
  assert.equal(report.rows[0].shiftId, "s3", "newest drawer first");

  const first = report.rows.find((row) => row.shiftId === "s1")!;
  assert.equal(first.openingCash, 500);
  assert.equal(first.expectedCash, 1250, "read from the summary, not recalculated here");
  assert.equal(first.actualCash, 1238);
  assert.equal(first.difference, -12);
  assert.equal(first.tone, "danger", "the same verdict the shift screen paints");
  assert.equal(first.invoices, 12);
  assert.equal(first.duration.length > 0, true);

  const open = report.rows.find((row) => row.shiftId === "s3")!;
  assert.equal(open.actualCash, null, "an open drawer has not been counted");
  assert.equal(open.difference, null);
  assert.equal(open.tone, "neutral");

  assert.equal(report.totals.shifts, 3);
  assert.equal(report.totals.closed, 2);
  assert.equal(report.totals.open, 1);
  assert.equal(report.totals.salesTotal, 2000);
  assert.equal(report.totals.expectedCash, 2350, "counted drawers only");
  assert.equal(report.totals.difference, -12);
  assert.equal(report.totals.exact, 1);

  // Cash differences: only counted drawers can disagree.
  const gaps = cashDifferenceRows(report.rows);
  assert.deepEqual(
    gaps.map((row) => row.shiftId),
    ["s1"],
    "the drawer that counted exactly right is not a difference",
  );
  const gapSummary = cashDifferenceSummary(report.rows);
  assert.equal(gapSummary.counted, 2);
  assert.equal(gapSummary.discrepancies, 1);
  assert.equal(gapSummary.discrepancyRate, 50);
  assert.equal(gapSummary.short, -12);
  assert.equal(gapSummary.over, 0);
  assert.equal(gapSummary.largestShort?.shiftId, "s1");
  assert.equal(gapSummary.unexplained, 1, "a gap nobody wrote a note about is the finding");

  // Daily report: one line per working day.
  const daily = dailyShiftReport(report.rows);
  assert.deepEqual(
    daily.map((day) => day.date),
    ["2026-03-12", "2026-03-11", "2026-03-10"],
    "newest day first",
  );
  const day10 = daily.find((day) => day.date === "2026-03-10")!;
  assert.equal(day10.difference, -12);
  const day12 = daily.find((day) => day.date === "2026-03-12")!;
  assert.equal(day12.actualCash, null, "a day whose drawer is still open has no counted cash, and 0 would be a lie");

  // Employee performance: grouped on whoever opened the drawer.
  const people = employeeShiftPerformance(report.rows);
  const cashier = people.find((row) => row.userId === "u-1")!;
  assert.equal(cashier.shifts, 2, "the open drawer is still theirs");
  assert.equal(cashier.closed, 1);
  assert.equal(cashier.difference, -12, "summed over counted drawers only");
  assert.equal(cashier.discrepancies, 1);
  assert.equal(cashier.exact, 0);
  const manager = people.find((row) => row.userId === "u-2")!;
  assert.equal(manager.exact, 1);
  assert.equal(manager.share, 30, "600 of the 2000 in the window");
});

// ── 9. the exports write what the reports computed ────────────────────────
test("each report exports, and the file carries the same rows", () => {
  const earrings = product({ id: "earrings", selling_price: 100, cost_price: 60 });
  const sales = [
    sale({ items: [item(earrings.id, 2, 100)], created_at: "2026-03-02T10:00:00.000Z", customer_id: "c-1" }),
  ];
  const shifts = [shift({ id: "s1" })];
  const summaries = new Map<string, ShiftSummary>([
    ["s1", summary({ sales_count: 1, sales_total: 200, expected_cash: 700, actual_cash: 700, difference: 0 })],
  ]);

  const salesSheets = buildSalesAnalyticsSheets({ sales, shifts, range: MARCH, t });
  assert.deepEqual(
    salesSheets.map((sheet) => sheet.name),
    [
      "export.sheet.summary",
      "export.sheet.byEmployee",
      "export.sheet.byRegister",
      "export.sheet.payments",
      "export.sheet.salesTrend",
    ],
  );
  const employeeSheet = salesSheets[1];
  assert.equal(employeeSheet.rowCount, 1);
  assert.equal(employeeSheet.header[0], "export.col.employee");
  assert.ok(
    employeeSheet.notes.some((note) => note.includes("2026-03-01")),
    "every sheet says which window it covers",
  );

  const productSheets = buildProductAnalyticsSheets({ sales, products: [earrings], range: MARCH, t, pick });
  assert.equal(productSheets.length, 5);
  const performance = productSheets[1];
  assert.equal(performance.rowCount, 1);
  assert.deepEqual(performance.rows[0].slice(0, 4), ["EARRINGS", "earrings", 1, 2]);

  const customerSheets = buildCustomerAnalyticsSheets({
    customers: [customer({ id: "c-1", name: "Lana" })],
    sales,
    range: MARCH,
    t,
  });
  assert.equal(customerSheets.length, 2);
  assert.equal(customerSheets[1].rows[0][0], "Lana");

  const historySheets = buildCustomerAnalyticsSheets({
    customers: [customer({ id: "c-1", name: "Lana" })],
    sales,
    range: MARCH,
    t,
    customerId: "c-1",
  });
  assert.deepEqual(
    historySheets.map((sheet) => sheet.name),
    ["export.sheet.purchaseHistory"],
    "one customer exports their invoices, not the whole book",
  );

  const expenseSheets = buildExpenseAnalyticsSheets({
    expenses: [expense({ id: "1", category: "transport", amount: 120, spent_at: "2026-03-01T08:00:00.000Z" })],
    range: MARCH,
    t,
  });
  assert.deepEqual(
    expenseSheets.map((sheet) => sheet.name),
    [
      "export.sheet.summary",
      "export.sheet.byCategory",
      "export.sheet.byEmployee",
      "export.sheet.byRegister",
      "export.sheet.byDay",
    ],
  );
  const categorySheet = expenseSheets[1];
  assert.equal(categorySheet.rowCount, 5, "every category, spent or not");
  assert.equal(categorySheet.rows[0][0], "expenses.category.transport");

  const shiftSheets = buildShiftAnalyticsSheets({
    shifts,
    summaryFor: (candidate) => summaries.get(candidate.id) ?? null,
    range: MARCH,
    t,
  });
  assert.deepEqual(
    shiftSheets.map((sheet) => sheet.name),
    [
      "export.sheet.summary",
      "export.sheet.shifts",
      "export.sheet.cashDifferences",
      "export.sheet.dailyShifts",
      "export.sheet.employeeShifts",
    ],
  );
  assert.equal(shiftSheets[2].rowCount, 0, "a drawer that counted right is not a difference");
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`\x1b[2m        ✓ ${name}\x1b[0m`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name} | ${message}`);
    console.log(`\x1b[2m        \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`\x1b[2m          ${message}\x1b[0m`);
  }
}

const label = `${passed}/${tests.length} advanced-report tests passed`;
if (failures.length > 0) {
  console.error(`\x1b[1m\x1b[31m\n✗ ${label}.\x1b[0m`);
  for (const failure of failures) console.error(`\x1b[31m•\x1b[0m ${failure}`);
  process.exit(1);
}
console.log(`\x1b[1m\x1b[32m\n✓ ${label}\x1b[0m`);

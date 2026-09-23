/**
 * Excel export self-test (headless, Node).
 *
 * Covers the pure half of the feature — everything that decides *what goes in
 * the file*: sheet naming, cell normalisation, number formats, the date range,
 * and each domain builder's columns, derived figures and totals. `xlsx` and the
 * DOM are never touched, so a wrong column or a wrong sum fails here rather
 * than in a downloaded spreadsheet.
 *
 * The accounting rules under test are the ones documented on the builders:
 *   - voided invoices are listed but excluded from every total;
 *   - the cash / card / InstaPay split of an invoice sums to its total;
 *   - cost of goods sold is quantity × the product's current purchase price;
 *   - the cash ledger only ever contains drawer money (never InstaPay/card);
 *   - a customer's balance is the unpaid part of their pending invoices.
 */
import assert from "node:assert/strict";
import {
  buildSheet,
  buildSheets,
  exportCurrency,
  exportFileName,
  formatFor,
  moneyFormat,
  sanitizeSheetName,
  toDate,
  uniqueSheetNames,
  withinDateRange,
  type ExportSheet,
  type PickBilingual,
  type Translate,
} from "../excelExport";
import {
  buildCashLedger,
  buildCashMovementsSheets,
  buildPaymentsSheets,
  computeFinancialTotals,
  costOfGoodsSold,
  buildFinancialSheets,
  OPEN_DATE_RANGE,
  paymentCountOf,
  revenueSales,
} from "@/modules/reports/services/financialExport";
import {
  buildSupplierActivity,
  buildSuppliersSheets,
  summarizeSuppliers,
} from "@/modules/reports/services/suppliersExport";
import {
  paymentTotals,
  remainingOf,
  totalQuantity,
  buildSalesSheets,
} from "@/modules/pos/services/salesExport";
import {
  stockValueAtCost,
  stockValueAtRetail,
  buildInventorySheets,
} from "@/modules/inventory/services/inventoryExport";
import { buildProductsSheets } from "@/modules/products/services/productsExport";
import { buildReturnsSheets } from "@/modules/returns/services/returnsExport";
import { buildExpensesSheets } from "@/modules/expenses/services/expensesExport";
import {
  customerPurchaseStats,
  buildCustomersSheets,
} from "@/modules/customers/services/customersExport";
import { ar, en } from "@/lib/i18n/dictionary";
import type {
  PaymentMethod,
  PaymentStatus,
  Sale,
  SaleItem,
  SalePayment,
  SaleStatus,
} from "@/modules/pos/types";
import type { Category, Product } from "@/modules/products/types";
import type { Customer } from "@/modules/customers/types";
import type { Expense } from "@/modules/expenses/types";
import type { RefundRecord, ReturnItem, SalesReturn } from "@/modules/returns/types";
import { PAYMENT_METHODS } from "@/modules/pos/types";
import type { Shift, ShiftSummary } from "@/modules/shifts/types";
import type { StockMovement } from "@/modules/inventory/types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ── i18n stubs ──────────────────────────────────────────────────────────────
// Headers come back as their dictionary key, so a test can assert on the exact
// column that was emitted without depending on translated copy.
const t = ((key: string) => String(key)) as unknown as Translate;
const pick: PickBilingual = (arabic, english) => english || arabic || "";

// ── Fixtures ────────────────────────────────────────────────────────────────
const ISO = "2026-03-10T09:30:00.000Z";

function product(partial: Partial<Product> & { id: string }): Product {
  return {
    sku: `SKU-${partial.id}`,
    variants_enabled: false,
    barcode: `622${partial.id}`,
    name_ar: `منتج ${partial.id}`,
    name_en: `Product ${partial.id}`,
    description_ar: null,
    description_en: null,
    category_id: "cat-1",
    product_type: "physical",
    selling_price: 100,
    cost_price: 40,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 3,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: ISO,
    updated_at: ISO,
    ...partial,
  };
}

function category(partial: Partial<Category> & { id: string }): Category {
  return {
    name_ar: "فئة",
    name_en: "Drinks",
    parent_id: null,
    active: true,
    sort_order: 0,
    created_at: ISO,
    updated_at: ISO,
    ...partial,
  };
}

function item(partial: Partial<SaleItem> & { id: string; sale_id: string }): SaleItem {
  return {
    product_id: "p1",
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    name_ar: "أقراط",
    name_en: "Earrings",
    sku: "ALYQ-1001",
    barcode: null,
    unit_price: 50,
    quantity: 2,
    line_total: 100,
    ...partial,
  };
}

function payment(partial: Partial<SalePayment> & { id: string; sale_id: string }): SalePayment {
  return {
    method: "cash" as PaymentMethod,
    amount: 100,
    status: "paid",
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    ...partial,
  };
}

function sale(partial: Partial<Sale> & { id: string; total: number }): Sale {
  const items = partial.items ?? [item({ id: "i1", sale_id: partial.id })];
  const payments = partial.payments ?? [
    payment({ id: "pay1", sale_id: partial.id, amount: partial.total }),
  ];
  const paid = payments.reduce((sum, p) => sum + (p.status === "paid" ? p.amount : 0), 0);
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
    items,
    payments,
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    created_at: ISO,
    voided_at: null,
    void_reason: null,
    payment_method: payments[0]?.method ?? "cash",
    payment_status: paid === partial.total ? "paid" : "pending",
    amount_received: paid,
    change: 0,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    ...partial,
  };
}

function customer(partial: Partial<Customer> & { id: string }): Customer {
  return {
    name: `Customer ${partial.id}`,
    phone: `0100000000${partial.id}`,
    email: null,
    address: null,
    notes: null,
    created_at: ISO,
    updated_at: ISO,
    ...partial,
  };
}

function expense(partial: Partial<Expense> & { id: string; amount: number }): Expense {
  return {
    expense_number: `EXP-${partial.id}`,
    name: `Expense ${partial.id}`,
    category: "transport",
    payment_method: "cash",
    spent_at: ISO,
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: "Main",
    shift_id: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: ISO,
    updated_at: ISO,
    ...partial,
  };
}

function salesReturn(partial: Partial<SalesReturn> & { id: string }): SalesReturn {
  return {
    return_number: `RET-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-s1",
    customer_id: null,
    customer_name: null,
    reason: "damaged",
    refund_amount: 50,
    refund_method: "cash",
    refund_status: "completed",
    user_id: "u1",
    user_name: "Cashier",
    items: [],
    created_at: ISO,
    ...partial,
  };
}

function refund(partial: Partial<RefundRecord> & { id: string; amount: number }): RefundRecord {
  return {
    refund_number: `REF-${partial.id}`,
    sale_id: "s1",
    sale_number: "INV-s1",
    return_id: null,
    payment_method: "cash",
    status: "completed",
    reason: null,
    user_id: "u1",
    user_name: "Cashier",
    created_at: ISO,
    rejection_reason: null,
    settled_at: ISO,
    settled_by: "u1",
    settled_by_name: "Cashier",
    ...partial,
  };
}

function shift(partial: Partial<Shift> & { id: string }): Shift {
  return {
    shift_number: `SH-${partial.id}`,
    branch: "Main",
    register: "R1",
    status: "closed",
    opening_cash: 500,
    opening_at: ISO,
    opened_by: "u1",
    opened_by_name: "Cashier",
    closing_cash: null,
    closed_at: null,
    closed_by: null,
    closed_by_name: null,
    notes: null,
    summary: null,
    adjustment_approved_by: null,
    adjustment_approved_by_name: null,
    adjustment_approved_at: null,
    created_at: ISO,
    updated_at: ISO,
    ...partial,
  };
}

function movement(partial: Partial<StockMovement> & { id: string }): StockMovement {
  return {
    product_id: "p1",
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    delta: 5,
    quantity_before: 5,
    quantity_after: 10,
    type: "receive",
    reason: "purchase",
    notes: null,
    user_id: "u1",
    user_name: "Clerk",
    created_at: ISO,
    ...partial,
  };
}

const PRODUCTS = [product({ id: "p1", cost_price: 40, selling_price: 100, stock_quantity: 10 })];
const CATEGORIES = [category({ id: "cat-1" })];

// ── workbook plumbing ───────────────────────────────────────────────────────

test("sheet names are made Excel-legal", () => {
  assert.equal(sanitizeSheetName("Cash / Ledger"), "Cash Ledger");
  assert.equal(sanitizeSheetName("A[B]:C*D?E"), "A B C D E");
  assert.equal(sanitizeSheetName("   "), "Sheet");
  assert.equal(sanitizeSheetName("x".repeat(40)).length, 31);
});

test("duplicate sheet names get a suffix instead of colliding", () => {
  assert.deepEqual(uniqueSheetNames(["Sales", "Sales", "Sales"]), [
    "Sales",
    "Sales (2)",
    "Sales (3)",
  ]);

  // Excel refuses tabs that differ only by case, so the check is
  // case-insensitive — while each name keeps the casing it was given.
  const cased = uniqueSheetNames(["Sales", "sales"]);
  assert.equal(cased.length, 2);
  assert.notEqual(cased[0].toLowerCase(), cased[1].toLowerCase());

  const long = uniqueSheetNames(["y".repeat(40), "y".repeat(40)]);
  assert.ok(long[1].length <= 31, "suffixed name still fits the 31-char limit");
  assert.notEqual(long[0], long[1]);
});

test("buildSheet normalises cells and derives widths", () => {
  interface Row {
    text: string | null;
    money: number;
    flag: boolean;
    when: string | null;
  }
  const sheet: ExportSheet<Row> = {
    name: "Rows",
    rows: [
      { text: null, money: 10.005, flag: true, when: ISO },
      { text: "x", money: Number.NaN, flag: false, when: null },
    ],
    columns: [
      { header: "Text", value: (r) => r.text },
      { header: "Money", value: (r) => r.money, kind: "money" },
      { header: "Flag", value: (r) => r.flag },
      { header: "When", value: (r) => toDate(r.when), kind: "datetime" },
    ],
    totals: ["Total", 10, "", null],
    notes: ["a note"],
  };

  const built = buildSheet(sheet);
  assert.equal(built.rowCount, 2);
  assert.deepEqual(built.header, ["Text", "Money", "Flag", "When"]);
  assert.deepEqual(built.kinds, ["text", "money", "text", "datetime"]);
  assert.deepEqual(built.widths, [22, 16, 22, 20], "width defaults follow the column kind");

  // null → empty cell, money rounded to 2dp, NaN dropped, booleans as text.
  assert.equal(built.rows[0][0], "");
  assert.equal(built.rows[0][1], 10.01);
  assert.equal(built.rows[0][2], "TRUE");
  assert.ok(built.rows[0][3] instanceof Date, "dates stay Date objects");
  assert.equal(built.rows[1][1], "", "a non-finite amount becomes an empty cell");
  assert.equal(built.rows[1][2], "FALSE");
  assert.equal(built.rows[1][3], "");

  assert.deepEqual(built.totals, ["Total", 10, "", null]);
  assert.deepEqual(built.notes, ["a note"]);
});

test("buildSheets accepts mixed row types and renames tabs uniquely", () => {
  const a = buildSheet<({ n: number })>({
    name: "Same",
    rows: [{ n: 1 }],
    columns: [{ header: "N", value: (r) => r.n, kind: "number" }],
  });
  const b = buildSheet<({ s: string })>({
    name: "Same",
    rows: [{ s: "x" }],
    columns: [{ header: "S", value: (r) => r.s }],
  });
  const built = buildSheets([
    { name: "Same", rows: [{ n: 1 }], columns: [{ header: "N", value: (r: { n: number }) => r.n }] },
    { name: "Same", rows: [{ s: "x" }], columns: [{ header: "S", value: (r: { s: string }) => r.s }] },
  ]);
  assert.deepEqual(built.map((s) => s.name), ["Same", "Same (2)"]);
  assert.equal(built[0].rows[0][0], a.rows[0][0]);
  assert.equal(built[1].rows[0][0], b.rows[0][0]);
});

test("money formats carry the EGP currency code", () => {
  assert.equal(exportCurrency(), "EGP");
  assert.equal(moneyFormat(), '#,##0.00 "EGP"');
  assert.equal(moneyFormat("USD"), '#,##0.00 "USD"');
  assert.equal(formatFor("money"), '#,##0.00 "EGP"');
  assert.equal(formatFor("datetime"), "yyyy-mm-dd hh:mm");
  assert.equal(formatFor("text"), null, "text keeps Excel's default");
});

test("export file names are slugged and timestamped", () => {
  const at = new Date(2026, 8, 12, 14, 5); // local time, September
  assert.equal(exportFileName("Financial Report", at), "alyq-financial-report-2026-09-12-1405.xlsx");
  assert.equal(exportFileName("", at), "alyq-export-2026-09-12-1405.xlsx");
  assert.ok(exportFileName("sales", at).endsWith(".xlsx"));
});

test("the date range is inclusive of both end days", () => {
  const morning = "2026-03-10T08:00:00.000Z";
  const evening = "2026-03-10T22:00:00.000Z";
  assert.equal(withinDateRange(morning, null, null), true, "unbounded accepts everything");
  assert.equal(withinDateRange(morning, "2026-03-10", "2026-03-10"), true);
  assert.equal(withinDateRange(evening, "2026-03-10", "2026-03-10"), true, "`to` covers the whole day");
  assert.equal(withinDateRange(morning, "2026-03-11", null), false);
  assert.equal(withinDateRange(evening, null, "2026-03-09"), false);
  assert.equal(withinDateRange(null, "2026-03-01", null), false, "a row with no date is excluded");
  assert.equal(withinDateRange("not-a-date", null, null), true, "unbounded never inspects the value");
});

// ── sales ───────────────────────────────────────────────────────────────────

test("split payments add up to the invoice total", () => {
  const split = sale({
    id: "s1",
    total: 500,
    payments: [
      payment({ id: "a", sale_id: "s1", method: "cash", amount: 300 }),
      payment({ id: "b", sale_id: "s1", method: "instapay", amount: 200, status: "pending" }),
    ],
  });
  const totals = paymentTotals(split);
  assert.equal(totals.cash, 300);
  assert.equal(totals.instapay, 200);
  assert.equal(totals.visa, 0);
  assert.equal(totals.cash + totals.instapay + totals.visa, split.total);
  assert.equal(totals.paid, 300);
  assert.equal(totals.pending, 200);
  assert.equal(remainingOf(split), 200, "the unsettled part is what remains");
});

test("a legacy sale with no payments array falls back to its method + total", () => {
  // A settled legacy row: no `payments`, but `payment_status` says it was paid.
  const legacy = sale({
    id: "s2",
    total: 80,
    payments: [],
    payment_method: "visa",
    payment_status: "paid",
  });
  const totals = paymentTotals(legacy);
  assert.equal(totals.visa, 80, "the whole total lands on the recorded method");
  assert.equal(totals.cash, 0);
  assert.equal(totals.paid, 80);
  assert.equal(remainingOf(legacy), 0);

  // The same row still awaiting confirmation keeps the money in `pending`.
  const unsettled = sale({ id: "s3", total: 80, payments: [], payment_method: "instapay" });
  const pending = paymentTotals(unsettled);
  assert.equal(pending.instapay, 80);
  assert.equal(pending.paid, 0);
  assert.equal(pending.pending, 80);
  assert.equal(remainingOf(unsettled), 80);
});

test("quantity sums every line", () => {
  const multi = sale({
    id: "s3",
    total: 0,
    items: [
      item({ id: "i1", sale_id: "s3", quantity: 2 }),
      item({ id: "i2", sale_id: "s3", quantity: 5 }),
    ],
  });
  assert.equal(totalQuantity(multi), 7);
});

test("sales export emits an invoices sheet and a line-items sheet", () => {
  const sales = [
    sale({ id: "s1", total: 100 }),
    sale({ id: "s2", total: 200, status: "voided" }),
  ];
  const sheets = buildSalesSheets({ sales, t, pick });
  assert.deepEqual(sheets.map((s) => s.name), ["export.sheet.invoices", "export.sheet.invoiceItems"]);

  const [invoices, items] = sheets;
  assert.equal(invoices.rowCount, 2, "voided invoices are still listed");
  assert.equal(items.rowCount, 2, "one row per line item");

  // The cash/card/InstaPay columns and the total are all present as headers.
  for (const key of [
    "export.col.invoiceNumber",
    "export.col.dateTime",
    "export.col.customer",
    "export.col.quantity",
    "export.col.discount",
    "export.col.paymentMethod",
    "export.col.total",
    "export.col.cash",
    "export.col.card",
    "export.col.instapay",
  ]) {
    assert.ok(invoices.header.includes(key), `invoices sheet has ${key}`);
  }

  // Totals exclude the voided invoice: 100, not 300.
  const totalColumn = invoices.header.indexOf("export.col.total");
  assert.equal(invoices.totals?.[totalColumn], 100);
  assert.ok(
    invoices.notes.some((note) => note === "export.note.totalsExcludeVoided"),
    "the exclusion is disclosed in the sheet notes",
  );
});

test("revenueSales drops voided invoices", () => {
  const sales = [sale({ id: "a", total: 1 }), sale({ id: "b", total: 2, status: "voided" })];
  assert.deepEqual(revenueSales(sales).map((s) => s.id), ["a"]);
});

// ── inventory + products ────────────────────────────────────────────────────

test("stock value is quantity × price on both bases", () => {
  const p = product({ id: "p1", stock_quantity: 7, cost_price: 12.5, selling_price: 30 });
  assert.equal(stockValueAtCost(p), 87.5);
  assert.equal(stockValueAtRetail(p), 210);
});

test("inventory export carries the requested columns and a totals row", () => {
  const rows = [
    product({ id: "p1", stock_quantity: 10, cost_price: 40, selling_price: 100 }),
    product({ id: "p2", stock_quantity: 3, cost_price: 10, selling_price: 25 }),
  ];
  const [sheet] = buildInventorySheets({
    products: rows,
    categoryName: (id) => (id === "cat-1" ? "Drinks" : "—"),
    t,
    pick,
    // Passed rather than read from a session: this suite runs signed out, and the
    // builder defaults to `canAct("view_cost")`, which is false for nobody.
    maySeeCost: true,
  });

  for (const key of [
    "export.col.name",
    "export.col.sku",
    "export.col.barcode",
    "export.col.category",
    "export.col.unit",
    "export.col.costPrice",
    "export.col.sellingPrice",
    "export.col.currentQty",
    "export.col.stockValue",
  ]) {
    assert.ok(sheet.header.includes(key), `inventory sheet has ${key}`);
  }

  const qtyCol = sheet.header.indexOf("export.col.currentQty");
  const valueCol = sheet.header.indexOf("export.col.stockValue");
  assert.equal(sheet.totals?.[qtyCol], 13);
  assert.equal(sheet.totals?.[valueCol], 430, "10×40 + 3×10");

  // The unit column exists but is blank, and says why.
  const unitCol = sheet.header.indexOf("export.col.unit");
  assert.deepEqual(sheet.rows.map((r) => r[unitCol]), ["", ""], "no unit field exists in the schema");
  assert.ok(sheet.notes.includes("export.note.unit"), "the blank column is explained");
  assert.equal(sheet.rows[0][sheet.header.indexOf("export.col.category")], "Drinks");
});

test("products export covers the whole catalogue record", () => {
  const [sheet] = buildProductsSheets({
    products: PRODUCTS,
    categories: CATEGORIES,
    t,
    pick,
    maySeeCost: true,
  });
  for (const key of [
    "export.col.sku",
    "export.col.barcode",
    "export.col.nameAr",
    "export.col.nameEn",
    "export.col.category",
    "export.col.productType",
    "export.col.costPrice",
    "export.col.sellingPrice",
    "export.col.margin",
    "export.col.currentQty",
    "export.col.stockStatus",
    "export.col.active",
  ]) {
    assert.ok(sheet.header.includes(key), `products sheet has ${key}`);
  }
  const margin = sheet.rows[0][sheet.header.indexOf("export.col.margin")];
  assert.equal(margin, 60, "(100 − 40) / 100 = 60%");
  assert.equal(sheet.rows[0][sheet.header.indexOf("export.col.category")], "Drinks");
});

// ── Phase 17: cost price leaves the building only with `view_cost` ─────────

test("a products export without cost authority carries no cost and no margin", () => {
  const [sheet] = buildProductsSheets({
    products: PRODUCTS,
    categories: CATEGORIES,
    t,
    pick,
    maySeeCost: false,
  });

  // Margin is cost in disguise — (price − cost) / price — so it goes too. What
  // remains is the whole catalogue record minus the supplier's number: the sheet
  // is still useful, which is why the column is dropped instead of the export
  // being refused.
  assert.equal(sheet.header.includes("export.col.costPrice"), false, "no cost column");
  assert.equal(sheet.header.includes("export.col.margin"), false, "no margin column");
  assert.ok(sheet.header.includes("export.col.sellingPrice"), "the till's price stays");
  assert.ok(sheet.header.includes("export.col.currentQty"), "stock stays");
  assert.equal(sheet.rows.length, PRODUCTS.length, "same rows, fewer columns");
});

test("an inventory export without cost authority keeps its totals aligned", () => {
  const rows = [
    product({ id: "p1", stock_quantity: 10, cost_price: 40, selling_price: 100 }),
    product({ id: "p2", stock_quantity: 3, cost_price: 10, selling_price: 25 }),
  ];
  const build = (maySeeCost: boolean) =>
    buildInventorySheets({
      products: rows,
      categoryName: () => "Drinks",
      t,
      pick,
      maySeeCost,
    })[0];

  const withCost = build(true);
  const without = build(false);

  assert.equal(withCost.header.length - without.header.length, 2, "cost price and stock value");
  // The totals row is positional, so a dropped column must drop its total too —
  // otherwise the retail sum lands under the quantity heading and the sheet
  // quietly lies about a number nobody can check.
  assert.equal(without.totals?.length, without.header.length, "totals line up with columns");
  assert.ok(without.totals?.includes(13), `quantity total survives (${JSON.stringify(without.totals)})`);
  assert.ok(without.totals?.includes(1075), `retail total survives (${JSON.stringify(without.totals)})`);
  assert.equal(without.totals?.includes(430), false, "the cost-basis total (10×40 + 3×10) is not in the sheet");
  assert.ok(withCost.totals?.includes(430), "…but it is when the seat may see cost");
});

// ── customers ───────────────────────────────────────────────────────────────

test("a customer's balance is the unpaid part of their pending invoices", () => {
  const sales = [
    sale({ id: "s1", total: 300, customer_id: "c1", status: "pending", payments: [
      payment({ id: "p1", sale_id: "s1", amount: 100, status: "paid" }),
      payment({ id: "p2", sale_id: "s1", method: "instapay", amount: 200, status: "pending" }),
    ] }),
    sale({ id: "s2", total: 50, customer_id: "c1" }),
    sale({ id: "s3", total: 999, customer_id: "c1", status: "voided" }),
    sale({ id: "s4", total: 70, customer_id: null }),
  ];

  const stats = customerPurchaseStats(sales).get("c1");
  assert.ok(stats);
  assert.equal(stats.count, 2, "the voided invoice is not a purchase");
  assert.equal(stats.totalSpent, 350, "300 + 50, voided excluded");
  assert.equal(stats.outstanding, 200, "only the unsettled InstaPay part");
  assert.equal(stats.lastPurchaseAt, ISO);
});

test("customers export emits the book plus a purchase-history sheet", () => {
  const customers = [customer({ id: "c1", phone: "0100", address: "Cairo" })];
  const sales = [sale({ id: "s1", total: 120, customer_id: "c1", customer_name: "Customer c1" })];
  const sheets = buildCustomersSheets({ customers, sales, t });

  assert.deepEqual(sheets.map((s) => s.name), [
    "export.sheet.customers",
    "export.sheet.purchaseHistory",
  ]);
  const [list, history] = sheets;
  for (const key of [
    "export.col.name",
    "export.col.phone",
    "export.col.address",
    "export.col.balance",
    "export.col.purchases",
    "export.col.totalSpent",
  ]) {
    assert.ok(list.header.includes(key), `customers sheet has ${key}`);
  }
  assert.equal(list.rows[0][list.header.indexOf("export.col.totalSpent")], 120);
  assert.equal(history.rowCount, 1);
  assert.ok(list.notes.includes("export.note.balance"), "the derived balance is explained");
});

// ── financial report ────────────────────────────────────────────────────────

test("profit is revenue − cost of goods sold − expenses", () => {
  const sales = [
    sale({
      id: "s1",
      total: 200,
      items: [item({ id: "i1", sale_id: "s1", product_id: "p1", quantity: 2, unit_price: 100, line_total: 200 })],
    }),
    sale({ id: "s2", total: 500, status: "voided" }),
  ];
  const products = [product({ id: "p1", cost_price: 40 })];
  const costById = new Map(products.map((p) => [p.id, p.cost_price]));

  assert.equal(costOfGoodsSold(sales, costById), 80, "2 × 40, voided sale ignored");

  const totals = computeFinancialTotals({
    sales,
    products,
    expenses: [expense({ id: "e1", amount: 30 })],
    returnsList: [salesReturn({ id: "r1", refund_amount: 25 })],
    refundsList: [refund({ id: "f1", amount: 25 })],
  });

  assert.equal(totals.revenue, 200);
  assert.equal(totals.cogs, 80);
  assert.equal(totals.grossProfit, 120);
  assert.equal(totals.expenses, 30);
  assert.equal(totals.netProfit, 90, "200 − 80 − 30");
  assert.equal(totals.cash, 200);
  assert.equal(totals.invoiceCount, 1);
  assert.equal(totals.voidedCount, 1);
  assert.equal(totals.voidedTotal, 500);
  assert.equal(totals.refundsPaid, 25);
  assert.equal(totals.unitCount, 2);
});

test("the cash ledger holds drawer money only, in date order, with a running balance", () => {
  const ledger = buildCashLedger({
    sales: [
      sale({ id: "s1", total: 100, created_at: "2026-03-10T10:00:00.000Z" }),
      sale({
        id: "s2",
        total: 80,
        created_at: "2026-03-10T09:00:00.000Z",
        payments: [payment({ id: "p", sale_id: "s2", method: "instapay", amount: 80 })],
      }),
      sale({ id: "s3", total: 40, status: "voided" }),
    ],
    expenses: [expense({ id: "e1", amount: 15, spent_at: "2026-03-10T11:00:00.000Z" })],
    refundsList: [refund({ id: "f1", amount: 20, created_at: "2026-03-10T12:00:00.000Z" })],
    shifts: [shift({ id: "sh1", opening_cash: 200, opening_at: "2026-03-10T08:00:00.000Z" })],
    t,
  });

  assert.deepEqual(
    ledger.map((r) => r.kind),
    [
      "export.ledger.openingFloat",
      "export.ledger.cashSale",
      "export.ledger.cashExpense",
      "export.ledger.cashRefund",
    ],
    "sorted ascending by time",
  );
  assert.deepEqual(ledger.map((r) => r.inn), [200, 100, 0, 0]);
  assert.deepEqual(ledger.map((r) => r.out), [0, 0, 15, 20]);
  assert.ok(
    !ledger.some((r) => r.reference === "INV-s2"),
    "an InstaPay sale never touches the drawer",
  );
  assert.ok(!ledger.some((r) => r.reference === "INV-s3"), "a voided sale is not a movement");
});

test("the financial workbook has one sheet per requested report and honours the range", () => {
  const sheets = buildFinancialSheets({
    sales: [
      sale({
        id: "in",
        total: 100,
        created_at: "2026-03-10T10:00:00.000Z",
        // Explicit line, so the expected arithmetic is visible: 1 × cost 40.
        items: [
          item({ id: "i1", sale_id: "in", product_id: "p1", quantity: 1, unit_price: 100, line_total: 100 }),
        ],
      }),
      sale({ id: "out", total: 900, created_at: "2026-01-01T10:00:00.000Z" }),
    ],
    products: PRODUCTS,
    expenses: [expense({ id: "e1", amount: 30 })],
    returnsList: [salesReturn({ id: "r1" })],
    refundsList: [refund({ id: "f1", amount: 50 })],
    shifts: [shift({ id: "sh1" })],
    summaryFor: () => null,
    range: { from: "2026-03-01", to: "2026-03-31" },
    t,
  });

  assert.deepEqual(sheets.map((s) => s.name), [
    "export.sheet.summary",
    "export.sheet.payments",
    "export.sheet.returns",
    "export.sheet.refunds",
    "export.sheet.expenses",
    "export.sheet.shifts",
    "export.sheet.cashLedger",
  ]);

  const [summary, payments] = sheets;
  const revenueRow = summary.rows.find((r) => r[0] === "export.metric.revenue");
  assert.ok(revenueRow, "the summary names a revenue line");
  assert.equal(revenueRow?.[2], 100, "only the in-range invoice counts");

  const cogsRow = summary.rows.find((r) => r[0] === "export.metric.cogs");
  assert.equal(cogsRow?.[2], -40, "money out is negative, and only the in-range line is costed");

  const profitRow = summary.rows.find((r) => r[0] === "export.metric.netProfit");
  assert.equal(profitRow?.[2], 100 - 40 - 30, "revenue − COGS (1 × 40) − expenses");

  assert.equal(payments.rowCount, 1, "the out-of-range invoice has no payment rows");
  assert.ok(summary.notes.some((n) => n.includes("2026-03-01")), "the range is printed on the sheet");
});

test("an unbounded range keeps everything", () => {
  const sales = [sale({ id: "a", total: 10, created_at: "2020-01-01T00:00:00.000Z" })];
  const [summary] = buildFinancialSheets({
    sales,
    products: PRODUCTS,
    expenses: [],
    returnsList: [],
    refundsList: [],
    shifts: [],
    summaryFor: () => null,
    range: OPEN_DATE_RANGE,
    t,
  });
  const revenueRow = summary.rows.find((r) => r[0] === "export.metric.revenue");
  assert.equal(revenueRow?.[2], 10);
});

test("shift summaries fall back to a live summary when none is frozen", () => {
  const live: Partial<ShiftSummary> = { sales_count: 4, sales_total: 250, expected_cash: 250 };
  const [sheet] = [
    ...buildFinancialSheets({
      sales: [],
      products: [],
      expenses: [],
      returnsList: [],
      refundsList: [],
      shifts: [shift({ id: "sh1", status: "open", summary: null })],
      summaryFor: () => live as ShiftSummary,
      range: OPEN_DATE_RANGE,
      t,
    }),
  ].filter((s) => s.name === "export.sheet.shifts");

  assert.equal(sheet.rowCount, 1);
  assert.equal(sheet.rows[0][sheet.header.indexOf("export.col.salesCount")], 4);
  assert.equal(sheet.rows[0][sheet.header.indexOf("export.col.salesTotal")], 250);
});

// ── suppliers (derived) ─────────────────────────────────────────────────────

test("supplier activity keeps only purchase and supplier-return movements", () => {
  const rows = buildSupplierActivity({
    movements: [
      movement({ id: "m1", reason: "purchase", type: "receive", delta: 5 }),
      movement({ id: "m2", reason: "supplier_return", type: "issue", delta: 2 }),
      movement({ id: "m3", reason: "damaged", type: "adjustment_out", delta: 1 }),
      movement({ id: "m4", reason: "recount", type: "correction", delta: 1 }),
    ],
    expenses: [expense({ id: "e1", amount: 60, name: "Delta Freight" })],
    products: PRODUCTS,
    range: OPEN_DATE_RANGE,
    t,
    pick,
  });

  assert.equal(rows.length, 3, "damaged / recount movements are not supplier activity");
  assert.deepEqual(rows.map((r) => r.kind), ["movement", "movement", "expense"]);

  const purchase = rows.find((r) => r.quantity > 0);
  assert.equal(purchase?.quantity, 5);
  assert.equal(purchase?.unitCost, 40);
  assert.equal(purchase?.amount, 200, "5 × the product's current cost price");

  const returned = rows.find((r) => r.quantity < 0);
  assert.equal(returned?.quantity, -2, "a supplier return is negative");
  assert.equal(returned?.amount, -80);

  const expenseRow = rows.find((r) => r.kind === "expense");
  assert.equal(expenseRow?.supplier, "Delta Freight", "the expense name is the only supplier label");
});

test("the supplier roll-up groups by name and states it is not a payable balance", () => {
  const rows = buildSupplierActivity({
    movements: [movement({ id: "m1", reason: "purchase", type: "receive", delta: 5 })],
    expenses: [
      expense({ id: "e1", amount: 60, name: "Delta Freight" }),
      expense({ id: "e2", amount: 40, name: "Delta Freight" }),
    ],
    products: PRODUCTS,
    range: OPEN_DATE_RANGE,
    t,
    pick,
  });

  const summary = summarizeSuppliers(rows, "(unnamed)");
  const unnamed = summary.find((s) => s.supplier === "(unnamed)");
  const delta = summary.find((s) => s.supplier === "Delta Freight");

  assert.equal(unnamed?.purchaseCount, 1);
  assert.equal(unnamed?.goodsValue, 200);
  assert.equal(unnamed?.netActivity, 200);
  assert.equal(delta?.expenseCount, 2);
  assert.equal(delta?.expenseTotal, 100);
  assert.equal(delta?.netActivity, -100);

  const sheets = buildSuppliersSheets({
    movements: [],
    expenses: [],
    products: PRODUCTS,
    range: OPEN_DATE_RANGE,
    t,
    pick,
  });
  const rollup = sheets.find((s) => s.name === "export.sheet.suppliers");
  assert.ok(rollup?.notes.includes("export.note.netActivity"), "the caveat travels with the sheet");
  assert.ok(
    sheets.every((s) => s.notes.includes("export.note.suppliers")),
    "both sheets disclose that no supplier records exist",
  );
});

// ── Runner ──────────────────────────────────────────────────────────────────


// ── Returns & Expenses: the standalone screens' exports ─────────────────────

const RETURN_ITEMS: ReturnItem[] = [
  { variant_id: null, variant_color_ar: null, variant_color_en: null, variant_size: null, variant_size_label: null,
    id: "ri1",
    return_id: "r1",
    sale_item_id: "si1",
    product_id: "p1",
    name_ar: "أقراط",
    name_en: "Earrings",
    sku: "ALYQ-1001",
    barcode: "6281000000013",
    unit_price: 30,
    quantity: 2,
    line_total: 60,
  },
  { variant_id: null, variant_color_ar: null, variant_color_en: null, variant_size: null, variant_size_label: null,
    id: "ri2",
    return_id: "r1",
    sale_item_id: "si2",
    product_id: "p2",
    name_ar: "شاي",
    name_en: "Tea",
    sku: "ALYQ-1002",
    barcode: null,
    unit_price: 15,
    quantity: 1,
    line_total: 15,
  },
];

test("the returns export writes returns, refunds and the items behind them", () => {
  const sheets = buildReturnsSheets({
    returnsList: [salesReturn({ id: "r1", items: RETURN_ITEMS, refund_amount: 75 })],
    refundsList: [refund({ id: "f1", amount: 75 })],
    t,
    pick,
  });

  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["export.sheet.returns", "export.sheet.refunds", "export.sheet.returnedItems"],
  );

  const items = sheets[2];
  assert.equal(items.rowCount, 2, "one row per returned line, not per return");
  assert.equal(items.rows[0][0], "RET-r1");
  assert.deepEqual(items.rows[0][1], new Date(ISO), "the return's date, as a real date");
  assert.equal(items.rows[0][2], "INV-s1", "the invoice it came from");
  assert.equal(items.rows[0][4], "Earrings", "the product name in the active language");
  assert.equal(items.rows[0][6], "6281000000013");
  assert.equal(items.rows[0][7], 2, "quantity");
  assert.equal(items.rows[0][8], 30, "unit price");
  assert.equal(items.rows[0][9], 60, "line total");
  assert.equal(items.rows[1][6], "", "a missing barcode stays blank");
  assert.equal(items.totals?.[7], 3, "quantity total");
  assert.equal(items.totals?.[9], 75, "line-total sum");
  assert.ok(
    items.notes.includes("export.note.returnedItems"),
    "the sheet explains that item values and refunds can differ",
  );
});

test("the standalone Returns, Refunds and Expenses sheets ARE the report's sheets", () => {
  const returnsList = [salesReturn({ id: "r1", items: RETURN_ITEMS })];
  const refundsList = [refund({ id: "f1", amount: 50 })];
  const expenses = [expense({ id: "e1", amount: 30 })];

  const report = buildFinancialSheets({
    sales: [],
    products: PRODUCTS,
    expenses,
    returnsList,
    refundsList,
    shifts: [],
    summaryFor: () => null,
    range: OPEN_DATE_RANGE,
    t,
  });

  const standaloneReturns = buildReturnsSheets({ returnsList, refundsList, t, pick });
  const byName = (name: string) => report.find((sheet) => sheet.name === name);

  // One definition each, so a screen export and the financial report cannot
  // drift apart in a column, a label or a total.
  assert.deepEqual(standaloneReturns[0], byName("export.sheet.returns"));
  assert.deepEqual(standaloneReturns[1], byName("export.sheet.refunds"));
  assert.deepEqual(buildExpensesSheets({ expenses, t })[0], byName("export.sheet.expenses"));
});

test("the expenses export writes exactly the filtered rows it is given", () => {
  const sheets = buildExpensesSheets({
    expenses: [expense({ id: "e1", amount: 30 }), expense({ id: "e2", amount: 12.5 })],
    t,
  });

  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "export.sheet.expenses");
  assert.equal(sheets[0].rowCount, 2);
  assert.equal(sheets[0].totals?.[4], 42.5, "the amount total");
  assert.equal(sheets[0].rows[0][3], "expenses.category.transport", "category is translated");
});

// ── standalone payments + cash movements exports ────────────────────────────
// The financial report has always contained both; these are the same two sheets
// offered on their own, so the tests below pin down that (a) the numbers are the
// drawer's and the till's, (b) the date range is honoured per source, and (c) the
// standalone file and the report cannot drift apart.

/** A split payment: 60 cash settled now, 40 InstaPay awaiting confirmation. */
const SPLIT_SALE = () =>
  sale({
    id: "split",
    total: 100,
    created_at: "2026-03-10T10:00:00.000Z",
    payments: [
      payment({ id: "p1", sale_id: "split", method: "cash", amount: 60, status: "paid" }),
      payment({ id: "p2", sale_id: "split", method: "instapay", amount: 40, status: "pending" }),
    ],
  });
const VISA_SALE = () =>
  sale({
    id: "visa",
    total: 250,
    created_at: "2026-03-11T10:00:00.000Z",
    payments: [payment({ id: "p3", sale_id: "visa", method: "visa", amount: 250, status: "paid" })],
  });
const MARCH = { from: "2026-03-01", to: "2026-03-31" };

test("paymentCountOf counts payment lines, not invoices", () => {
  assert.equal(paymentCountOf([SPLIT_SALE(), VISA_SALE()]), 3, "a split invoice is two lines");
  assert.equal(paymentCountOf([]), 0);
});

test("the payments workbook summarises per method and lists every payment line", () => {
  const sheets = buildPaymentsSheets({
    sales: [
      SPLIT_SALE(),
      VISA_SALE(),
      // Out of range: must not appear in either sheet.
      sale({ id: "old", total: 900, created_at: "2026-01-01T10:00:00.000Z" }),
    ],
    range: MARCH,
    t,
  });

  assert.deepEqual(sheets.map((sheet) => sheet.name), [
    "export.sheet.summary",
    "export.sheet.payments",
  ]);

  const [summary, payments] = sheets;
  // Canonical method order (cash, instapay, visa), one row per method used.
  assert.deepEqual(summary.rows, [
    ["pos.payment.cash", 1, 60, 0, 60],
    ["pos.payment.instapay", 1, 0, 40, 40],
    ["pos.payment.visa", 1, 250, 0, 250],
  ]);
  assert.deepEqual(summary.totals, ["export.totalRow", 3, 310, 40, 350]);
  assert.equal(
    summary.rows.reduce((acc, row) => acc + Number(row[4]), 0),
    350,
    "the per-method totals add up to the money taken in the range",
  );

  assert.equal(payments.rowCount, 3, "three payment lines from the two in-range invoices");
  assert.ok(
    !payments.rows.some((row) => row.includes("INV-old")),
    "the out-of-range invoice has no payment lines here",
  );
  assert.ok(
    summary.notes.some((note) => note.includes("2026-03-01")),
    "the range applied is printed on the sheet",
  );
  assert.ok(
    summary.notes.includes("export.note.paymentSplit"),
    "and the sheet explains why one invoice can be several rows",
  );
});

test("the cash movements workbook is the drawer ledger for the range, with a running balance", () => {
  const sheets = buildCashMovementsSheets({
    sales: [
      sale({ id: "cash1", total: 100, created_at: "2026-03-10T10:00:00.000Z" }),
      sale({
        id: "inet1",
        total: 80,
        created_at: "2026-03-10T09:00:00.000Z",
        payments: [payment({ id: "p", sale_id: "inet1", method: "instapay", amount: 80 })],
      }),
      sale({ id: "void1", total: 40, status: "voided" }),
      sale({ id: "old1", total: 700, created_at: "2026-01-05T10:00:00.000Z" }),
    ],
    expenses: [
      expense({ id: "e1", amount: 15, spent_at: "2026-03-10T11:00:00.000Z" }),
      expense({ id: "e2", amount: 900, spent_at: "2026-02-01T11:00:00.000Z" }),
    ],
    refundsList: [refund({ id: "f1", amount: 20, created_at: "2026-03-10T12:00:00.000Z" })],
    shifts: [
      shift({ id: "sh1", opening_cash: 200, opening_at: "2026-03-10T08:00:00.000Z" }),
      shift({ id: "sh2", opening_cash: 500, opening_at: "2026-01-02T08:00:00.000Z" }),
    ],
    range: MARCH,
    t,
  });

  assert.equal(sheets.length, 1);
  const [ledger] = sheets;
  assert.equal(ledger.name, "export.sheet.cashLedger");
  assert.equal(ledger.rowCount, 4, "float, cash sale, cash expense, cash refund");

  assert.deepEqual(
    ledger.rows.map((row) => row[1]),
    [
      "export.ledger.openingFloat",
      "export.ledger.cashSale",
      "export.ledger.cashExpense",
      "export.ledger.cashRefund",
    ],
    "ascending by time",
  );
  // A side that did not move is written blank, not as a zero: the ledger stays
  // readable and a column total in Excel is not padded with 0.00 rows.
  assert.deepEqual(ledger.rows.map((row) => row[4]), [200, 100, "", ""], "money in");
  assert.deepEqual(ledger.rows.map((row) => row[5]), ["", "", 15, 20], "money out");
  assert.deepEqual(
    ledger.rows.map((row) => row[6]),
    [200, 300, 285, 265],
    "the running balance",
  );
  assert.deepEqual(ledger.totals?.slice(4), [300, 35, 265], "in, out, closing balance");

  const references = ledger.rows.map((row) => String(row[2]));
  assert.ok(!references.includes("INV-inet1"), "InstaPay never touches the drawer");
  assert.ok(!references.includes("INV-void1"), "a voided invoice is not a movement");
  assert.ok(!references.includes("INV-old1"), "an out-of-range invoice is excluded");
  assert.ok(!references.includes("EXP-e2"), "an out-of-range expense is excluded");
  assert.ok(
    !ledger.rows.some((row) => Number(row[4]) === 500),
    "a shift that opened outside the range contributes no float",
  );
  assert.ok(
    ledger.notes.includes("export.note.cashLedger"),
    "the sheet states how the ledger is derived",
  );
  assert.ok(
    ledger.notes.some((note) => note.includes("2026-03-01")),
    "and which range it covers",
  );
});

test("the standalone Payments and Cash movements sheets ARE the report's sheets", () => {
  const sales = [SPLIT_SALE(), VISA_SALE()];
  const expenses = [expense({ id: "e1", amount: 15 })];
  const refundsList = [refund({ id: "f1", amount: 20 })];
  const shifts = [shift({ id: "sh1", opening_cash: 200 })];

  const report = buildFinancialSheets({
    sales,
    products: PRODUCTS,
    expenses,
    returnsList: [],
    refundsList,
    shifts,
    summaryFor: () => null,
    range: OPEN_DATE_RANGE,
    t,
  });
  const reportSheet = (name: string) => {
    const found = report.find((sheet) => sheet.name === name);
    assert.ok(found, `the report has a ${name} sheet`);
    return found;
  };

  const standalonePayments = buildPaymentsSheets({ sales, range: OPEN_DATE_RANGE, t })[1];
  const standaloneLedger = buildCashMovementsSheets({
    sales,
    expenses,
    refundsList,
    shifts,
    range: OPEN_DATE_RANGE,
    t,
  })[0];

  // Same header, columns, widths, cells and totals: one definition each, so a
  // standalone file and the financial report cannot disagree.
  for (const [standalone, fromReport] of [
    [standalonePayments, reportSheet("export.sheet.payments")],
    [standaloneLedger, reportSheet("export.sheet.cashLedger")],
  ] as const) {
    for (const field of ["header", "rows", "kinds", "widths", "totals", "rowCount"] as const) {
      assert.deepEqual(standalone[field], fromReport[field], `${field} matches the report`);
    }
    // The only difference is the range line the standalone file prints first.
    assert.deepEqual(standalone.notes, [
      "export.dateRange: export.range.allTime",
      ...fromReport.notes,
    ]);
  }
});

test("the payments and cash-movement workbooks are fully translated into Arabic", () => {
  // `ar` is typed Record<TranslationKey, string>, so a missing key is a compile
  // error; this proves it at runtime too, and that nothing reaches the file as a
  // raw dictionary key.
  const tAr = ((key: string) => ar[key as keyof typeof ar] ?? key) as unknown as Translate;

  const payments = buildPaymentsSheets({ sales: [SPLIT_SALE(), VISA_SALE()], t: tAr });
  const cash = buildCashMovementsSheets({
    sales: [sale({ id: "c1", total: 100 })],
    expenses: [expense({ id: "e1", amount: 15 })],
    refundsList: [refund({ id: "f1", amount: 20 })],
    shifts: [shift({ id: "sh1", opening_cash: 200 })],
    t: tAr,
  });

  assert.deepEqual(payments.map((sheet) => sheet.name), ["الملخص", "المدفوعات"]);
  assert.deepEqual(cash.map((sheet) => sheet.name), ["الحركات النقدية"]);

  for (const sheet of [...payments, ...cash]) {
    assert.ok(sheet.name.length <= 31, `"${sheet.name}" fits Excel's sheet-name limit`);
    const cells = [...sheet.header, ...sheet.rows.flat(), ...(sheet.totals ?? []), ...sheet.notes];
    for (const cell of cells) {
      assert.ok(
        !/^(export|pos|expenses|reports|products|inventory|common)\./.test(String(cell ?? "")),
        `no untranslated key reaches the file (found "${String(cell)}" in ${sheet.name})`,
      );
    }
  }
  assert.equal(
    payments[0].rows[0][0],
    "pos.payment.cash" in ar ? ar["pos.payment.cash" as keyof typeof ar] : "",
    "the payment method is written in Arabic",
  );
});

test("every status and method an export interpolates has an English and Arabic label", () => {
  // Export sheets build these labels by string interpolation —
  // `t(\`pos.status.${sale.status}\`)`, `t(\`pos.payment.${method}\`)` — which the
  // compiler cannot check. A value with no dictionary entry reaches the file as
  // the raw key: that is how "pos.status.paid" appeared in the Payment status
  // column of every settled invoice.
  //
  // The record below is exhaustive *by type*: adding a member to any of these
  // unions without listing it here is a compile error, so the list cannot rot.
  const statusValues: Record<
    SaleStatus | PaymentStatus | RefundRecord["status"] | SalesReturn["refund_status"],
    true
  > = { completed: true, pending: true, voided: true, paid: true, rejected: true };

  for (const status of Object.keys(statusValues)) {
    for (const [lang, table] of [["en", en], ["ar", ar]] as const) {
      const key = `pos.status.${status}` as keyof typeof en;
      assert.ok(key in table, `${key} exists in ${lang}`);
      assert.ok(table[key].trim().length > 0, `${key} is not blank in ${lang}`);
      assert.ok(!/^pos\./.test(table[key]), `${key} is a label, not another key, in ${lang}`);
    }
  }

  for (const method of PAYMENT_METHODS) {
    for (const [lang, table] of [["en", en], ["ar", ar]] as const) {
      const key = `pos.payment.${method}` as keyof typeof en;
      assert.ok(key in table, `${key} exists in ${lang}`);
      assert.ok(table[key].trim().length > 0, `${key} is not blank in ${lang}`);
    }
  }

  // And rendered through a real dictionary, no label comes back as its own key.
  const tAr = ((key: string) => ar[key as keyof typeof ar] ?? key) as unknown as Translate;
  const tEn = ((key: string) => en[key as keyof typeof en] ?? key) as unknown as Translate;
  for (const status of Object.keys(statusValues)) {
    // `as never` is the same cast the builders use: the key is assembled at
    // runtime, which is exactly why this test exists.
    assert.notEqual(tEn(`pos.status.${status}` as never), `pos.status.${status}`);
    assert.notEqual(tAr(`pos.status.${status}` as never), `pos.status.${status}`);
  }
  assert.equal(tEn("pos.status.paid"), "Paid", "a settled payment reads as Paid");
  assert.equal(tAr("pos.status.paid"), "مدفوع", "and as مدفوع in Arabic");
});

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
  console.log(`\n${passed}/${passed + failed} export tests passed`);
  if (failed > 0) process.exit(1);
}

run();

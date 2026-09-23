/**
 * Phase 54 — end-of-day cashier & shift reporting.
 * Run with the shared runner (`npm test`).
 */
import assert from "node:assert/strict";
import type { Sale } from "@/modules/pos/types";
import type { Expense } from "@/modules/expenses/types";
import type { RefundRecord } from "@/modules/returns/types";
import type { Shift, ShiftSummary } from "../types";
import {
  computeShiftSummary,
  differenceTone,
  padShiftSummary,
  saleBelongsToShift,
  shiftWindowOf,
} from "../services/shiftCalculations";
import { buildEndOfDay } from "../services/endOfDay";
import { buildEndOfDaySheets, buildShiftDetailSheets } from "../services/eodExport";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const OPENED_AT = "2026-03-01T08:00:00.000Z";
const NOON = "2026-03-01T12:00:00.000Z";

function baseShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: "shf-test-1",
    shift_number: "SH-000001",
    branch: "Main branch",
    register: "Register 1",
    status: "open",
    opening_cash: 1000,
    opening_at: OPENED_AT,
    opened_by: "user-demo-admin",
    opened_by_name: "ALYQ Admin",
    closing_cash: null,
    closed_at: null,
    closed_by: null,
    closed_by_name: null,
    notes: null,
    summary: null,
    adjustment_approved_by: null,
    adjustment_approved_by_name: null,
    adjustment_approved_at: null,
    created_at: OPENED_AT,
    updated_at: OPENED_AT,
    ...overrides,
  };
}

function sale(partial: {
  id: string;
  total: number;
  created_at?: string;
  status?: Sale["status"];
  payments: { method: "cash" | "instapay" | "visa" | "cod"; amount: number; status: "paid" | "pending" }[];
  items?: Sale["items"];
  shift_id?: string | null;
  source?: Sale["source"];
  discount_amount?: number;
  automatic_discount_amount?: number;
  item_discount_amount?: number;
}): Sale {
  const payments = partial.payments.map((p, index) => ({
    id: `${partial.id}-p${index}`,
    sale_id: partial.id,
    method: p.method,
    amount: p.amount,
    status: p.status,
    paid_at: p.status === "paid" ? "2026-03-01T09:00:00.000Z" : null,
    paid_by: null,
    paid_by_name: null,
  }));
  return {
    id: partial.id,
    sale_number: `INV-${partial.id}`,
    client_ref: partial.id,
    status: partial.status ?? "completed",
    subtotal: partial.total,
    discount_type: partial.discount_amount ? "fixed" : "none",
    discount_value: partial.discount_amount ?? 0,
    discount_amount: partial.discount_amount ?? 0,
    automatic_discount_amount: partial.automatic_discount_amount ?? 0,
    item_discount_amount: partial.item_discount_amount ?? 0,
    total: partial.total,
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    items: partial.items ?? [],
    payments,
    created_at: partial.created_at ?? "2026-03-01T09:00:00.000Z",
    voided_at: null,
    void_reason: null,
    payment_method: payments[0]?.method ?? "cash",
    payment_status: payments.every((p) => p.status === "paid") ? "paid" : "pending",
    amount_received: null,
    change: null,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    shift_id: partial.shift_id,
    source: partial.source,
  };
}

function expense(partial: Partial<Expense> & { amount: number; payment_method: Expense["payment_method"] }): Expense {
  return {
    id: `exp-${partial.shift_id ?? "x"}`,
    expense_number: "EXP-000001",
    name: "Delivery fuel",
    category: "transport",
    spent_at: "2026-03-01T10:00:00.000Z",
    notes: null,
    attachment_url: null,
    attachment_name: null,
    branch: "Main branch",
    shift_id: "shf-test-1",
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    created_at: "2026-03-01T10:00:00.000Z",
    updated_at: "2026-03-01T10:00:00.000Z",
    ...partial,
  } as Expense;
}

function refund(partial: Partial<RefundRecord> & { amount: number }): RefundRecord {
  return {
    id: "ref-1",
    refund_number: "REF-000001",
    sale_id: "sale-x",
    sale_number: "INV-sale-x",
    return_id: null,
    payment_method: "cash",
    status: "completed",
    reason: null,
    user_id: "user-demo-admin",
    user_name: "ALYQ Admin",
    created_at: "2026-03-01T10:30:00.000Z",
    ...partial,
  } as RefundRecord;
}

console.log("\nPhase 54 · end-of-day cashier & shift reporting");

test("acceptance: 500 opening + 1000 cash − 50 refund − 100 expense = 1350, actual 1330, short 20", () => {
  const sources = {
    sales: [
      sale({ id: "s1", total: 1000, payments: [{ method: "cash", amount: 1000, status: "paid" }] }),
      sale({ id: "s2", total: 400, payments: [{ method: "instapay", amount: 400, status: "paid" }] }),
    ],
    returns: [],
    refunds: [refund({ amount: 50, payment_method: "cash" })],
    expenses: [expense({ amount: 100, payment_method: "cash" })],
  };
  const live = computeShiftSummary(baseShift({ opening_cash: 500 }), sources, NOON);
  assert.equal(live.cash_sales, 1000);
  assert.equal(live.instapay_sales, 400, "InstaPay is reported");
  assert.equal(live.expected_cash, 1350, "500 + 1000 − 50 − 100");
  assert.equal(live.actual_cash, null, "open shift has no counted cash");

  const closed = computeShiftSummary(
    baseShift({
      opening_cash: 500,
      status: "closed",
      closing_cash: 1330,
      closed_at: "2026-03-01T16:00:00.000Z",
    }),
    sources,
    NOON,
  );
  assert.equal(closed.expected_cash, 1350);
  assert.equal(closed.actual_cash, 1330);
  assert.equal(closed.difference, -20);
  assert.equal(differenceTone(-20), "danger");
});

test("discounts are reported and never subtracted from expected cash after net cash", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 200 }),
    {
      sales: [
        sale({
          id: "s1",
          total: 170,
          discount_amount: 15,
          automatic_discount_amount: 10,
          item_discount_amount: 5,
          items: [
            {
              id: "i1",
              sale_id: "s1",
              product_id: "p1",
              variant_id: null,
              variant_color_ar: null,
              variant_color_en: null,
              variant_size: null,
              variant_size_label: null,
              name_ar: "صنف",
              name_en: "Item",
              sku: "SKU-1",
              barcode: null,
              unit_price: 200,
              quantity: 1,
              gross_total: 200,
              line_total: 185,
              discount_amount: 5,
              automatic_discount_amount: 10,
            },
          ],
          payments: [{ method: "cash", amount: 170, status: "paid" }],
        }),
      ],
      returns: [],
      refunds: [],
      expenses: [],
    },
    NOON,
  );
  assert.equal(summary.gross_sales, 210, "list 200 + auto 10");
  assert.equal(summary.discounts_automatic, 10);
  assert.equal(summary.discounts_manual_item, 5);
  assert.equal(summary.discounts_invoice, 15);
  assert.equal(summary.discounts_total, 30);
  assert.equal(summary.net_sales, 170);
  assert.equal(summary.cash_sales, 170);
  assert.equal(summary.expected_cash, 370, "200 + 170 — discounts are not subtracted again");
});

test("Visa and COD never enter expected cash", () => {
  const summary = computeShiftSummary(
    baseShift({ opening_cash: 100 }),
    {
      sales: [
        sale({ id: "s1", total: 80, payments: [{ method: "visa", amount: 80, status: "paid" }] }),
        sale({ id: "s2", total: 40, payments: [{ method: "cod", amount: 40, status: "paid" }] }),
        sale({ id: "s3", total: 25, payments: [{ method: "cash", amount: 25, status: "paid" }] }),
      ],
      returns: [],
      refunds: [],
      expenses: [],
    },
    NOON,
  );
  assert.equal(summary.visa_sales, 80);
  assert.equal(summary.other_sales, 40);
  assert.equal(summary.cash_sales, 25);
  assert.equal(summary.expected_cash, 125, "100 + 25 cash only");
});

test("a till sale is attributed by shift_id; online sales without a shift stay out", () => {
  const shift = baseShift({ id: "shf-test-1", opening_at: "2026-03-01T09:00:00.000Z" });
  const window = shiftWindowOf(shift);
  const mine = sale({
    id: "mine",
    total: 10,
    shift_id: "shf-test-1",
    created_at: "2026-03-01T07:00:00.000Z",
    payments: [{ method: "cash", amount: 10, status: "paid" }],
  });
  const theirs = sale({
    id: "theirs",
    total: 99,
    shift_id: "other-shift",
    created_at: "2026-03-01T10:00:00.000Z",
    payments: [{ method: "cash", amount: 99, status: "paid" }],
  });
  const online = sale({
    id: "web",
    total: 50,
    source: "online",
    created_at: "2026-03-01T10:00:00.000Z",
    payments: [{ method: "cod", amount: 50, status: "paid" }],
  });
  assert.equal(saleBelongsToShift(mine, shift, window), true);
  assert.equal(saleBelongsToShift(theirs, shift, window), false);
  assert.equal(saleBelongsToShift(online, shift, window), false);

  const summary = computeShiftSummary(shift, { sales: [mine, theirs, online], returns: [], refunds: [], expenses: [] }, NOON);
  assert.equal(summary.sales_count, 1);
  assert.equal(summary.cash_sales, 10);
  assert.equal(summary.expected_cash, 1010);
});

test("a frozen snapshot is padded, never recomputed", () => {
  const raw = {
    sales_count: 2,
    sales_total: 800,
    voided_count: 0,
    voided_total: 0,
    cash_sales: 500,
    instapay_sales: 300,
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
    expenses_count: 1,
    expenses_total: 100,
    cash_expenses: 100,
    instapay_expenses: 0,
    visa_expenses: 0,
    expected_cash: 1400,
    actual_cash: 1395,
    difference: -5,
  } as unknown as ShiftSummary;
  const padded = padShiftSummary(raw);
  assert.equal(padded.expected_cash, 1400, "historical expected cash is untouched");
  assert.equal(padded.gross_sales, 800);
  assert.equal(padded.net_sales, 800);
  assert.equal(padded.discounts_total, 0);
  assert.equal(padded.visa_sales, 0);
});

test("end of day sums two closed shifts and flags an open one as pending", () => {
  const closedA = baseShift({
    id: "a",
    shift_number: "SH-000001",
    status: "closed",
    opening_cash: 500,
    closing_cash: 1330,
    closed_at: "2026-03-01T16:00:00.000Z",
    opening_at: "2026-03-01T08:00:00.000Z",
    summary: computeShiftSummary(
      baseShift({
        id: "a",
        opening_cash: 500,
        status: "closed",
        closing_cash: 1330,
        closed_at: "2026-03-01T16:00:00.000Z",
      }),
      {
        sales: [sale({ id: "s1", total: 1000, payments: [{ method: "cash", amount: 1000, status: "paid" }] })],
        returns: [],
        refunds: [refund({ amount: 50, payment_method: "cash" })],
        expenses: [expense({ amount: 100, payment_method: "cash", shift_id: "a" })],
      },
    ),
  });
  const closedB = baseShift({
    id: "b",
    shift_number: "SH-000002",
    status: "closed",
    opening_cash: 200,
    closing_cash: 250,
    closed_at: "2026-03-01T22:00:00.000Z",
    opening_at: "2026-03-01T16:00:00.000Z",
    opened_by: "u-2",
    opened_by_name: "Second",
    summary: padShiftSummary({
      sales_count: 1,
      sales_total: 80,
      gross_sales: 80,
      net_sales: 80,
      discounts_automatic: 0,
      discounts_promo: 0,
      discounts_manual_item: 0,
      discounts_invoice: 0,
      discounts_total: 0,
      voided_count: 0,
      voided_total: 0,
      cash_sales: 50,
      instapay_sales: 30,
      visa_sales: 0,
      other_sales: 0,
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
      expected_cash: 250,
      actual_cash: 250,
      difference: 0,
    }),
  });
  const open = baseShift({
    id: "c",
    shift_number: "SH-000003",
    status: "open",
    opening_cash: 300,
    opening_at: "2026-03-01T22:30:00.000Z",
    summary: null,
    closing_cash: null,
    closed_at: null,
  });

  const report = buildEndOfDay({
    shifts: [closedA, closedB, open],
    summaryFor: (shift) => shift.summary,
    range: { from: "2026-03-01", to: "2026-03-01" },
  });
  assert.equal(report.closed.length, 2);
  assert.equal(report.pending.length, 1);
  assert.equal(report.pending[0].shift.id, "c");
  assert.equal(report.totals.closed_shifts, 2);
  assert.equal(report.totals.open_shifts, 1);
  assert.equal(report.totals.expected_cash, 1350 + 250);
  assert.equal(report.totals.actual_cash, 1330 + 250);
  assert.equal(report.totals.difference, -20, "sum of each closed difference, not a merged mystery");
  assert.equal(report.closed[0].summary?.difference, -20);
  assert.equal(report.closed[1].summary?.difference, 0);

  const t = ((key: string) => key) as never;
  const eodSheets = buildEndOfDaySheets({ report, range: { from: "2026-03-01", to: "2026-03-01" }, t });
  assert.deepEqual(
    eodSheets.map((sheet) => sheet.name),
    ["export.sheet.summary", "export.sheet.eod", "export.sheet.pendingShifts"],
  );
  assert.equal(eodSheets[1].rowCount, 2);
  assert.equal(eodSheets[2].rowCount, 1);

  const detail = buildShiftDetailSheets({ shift: closedA, summary: closedA.summary, t });
  assert.ok(detail.length >= 2);
});

let passed = 0;
async function main(): Promise<void> {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} Phase 54 EOD tests passed.\n`);
}

await main();

import assert from "node:assert/strict";
import type { Sale } from "../types";
import type { RefundRecord, SalesReturn } from "@/modules/returns/types";
import { EMPTY_TRANSACTION_FILTERS, searchTransactionCenter } from "../services/transactionCenter";
import { buildTransactionCenterSheets } from "../services/salesExport";

type Test = { name: string; run: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: () => Promise<void>) => tests.push({ name, run });

function sale(id: string, created: string, overrides: Partial<Sale> = {}): Sale {
  return {
    id,
    sale_number: `INV-${id}`,
    client_ref: `client-${id}`,
    status: "completed",
    subtotal: 100,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    total: 100,
    user_id: "cashier-1",
    user_name: "Mona Cashier",
    items: [{ id: `item-${id}`, sale_id: id, product_id: "p1", variant_id: "v1", variant_color_ar: "ذهبي", variant_color_en: "Gold", variant_size: 17, variant_size_label: null, name_ar: "خاتم", name_en: "Ring", sku: "RING-GOLD-17", barcode: "991700", unit_price: 100, quantity: 1, line_total: 100 }],
    payments: [{ id: `pay-${id}`, sale_id: id, method: "cash", amount: 100, status: "paid", paid_at: created, paid_by: "cashier-1", paid_by_name: "Mona Cashier" }],
    customer_id: "customer-1",
    customer_name: "Nour Customer",
    customer_phone: "01012345678",
    created_at: created,
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: 100,
    change: 0,
    paid_at: created,
    paid_by: "cashier-1",
    paid_by_name: "Mona Cashier",
    source: "pos",
    shift_id: "shift-1",
    ...overrides,
  };
}

const returns: SalesReturn[] = [{
  id: "return-1", client_ref: "return-client", return_number: "RET-0001", sale_id: "sale-1", sale_number: "INV-sale-1",
  customer_id: "customer-1", customer_name: "Nour Customer", reason: "Wrong size", refund_amount: 30,
  refund_method: "cash", refund_status: "pending", user_id: "cashier-1", user_name: "Mona Cashier", items: [], created_at: "2026-10-02T12:00:00Z",
}];
const refunds: RefundRecord[] = [
  { id: "refund-pending", refund_number: "REF-PENDING", sale_id: "sale-1", sale_number: "INV-sale-1", return_id: "return-1", amount: 30, payment_method: "cash", status: "pending", reason: null, user_id: "u", user_name: "U", created_at: "2026-10-02T12:00:00Z", rejection_reason: null, settled_at: null, settled_by: null, settled_by_name: null },
  { id: "refund-rejected", refund_number: "REF-REJECTED", sale_id: "sale-1", sale_number: "INV-sale-1", return_id: null, amount: 20, payment_method: "cash", status: "rejected", reason: null, user_id: "u", user_name: "U", created_at: "2026-10-02T12:05:00Z", rejection_reason: "No", settled_at: "2026-10-02T13:00:00Z", settled_by: "m", settled_by_name: "Manager" },
  { id: "refund-complete", refund_number: "REF-COMPLETE", sale_id: "sale-1", sale_number: "INV-sale-1", return_id: null, amount: 10, payment_method: "cash", status: "completed", reason: null, user_id: "u", user_name: "U", created_at: "2026-10-02T12:10:00Z", rejection_reason: null, settled_at: "2026-10-02T13:10:00Z", settled_by: "m", settled_by_name: "Manager" },
];
const sales = [sale("sale-1", "2026-10-02T10:00:00Z"), sale("sale-2", "2026-10-01T10:00:00Z", { client_ref: "special-client", payment_status: "pending" })];

test("demo center searches invoice, client, customer, product, SKU, barcode, return and refund evidence", async () => {
  for (const query of ["INV-sale-1", "client-sale-1", "Nour", "01012345678", "Ring", "RING-GOLD-17", "991700", "RET-0001", "REF-PENDING"]) {
    const result = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, query }, { sales, returns, refunds });
    assert.ok(result.rows.some((row) => row.id === "sale-1"), `query ${query}`);
  }
  const client = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, query: "special-client" }, { sales, returns, refunds });
  assert.deepEqual(client.rows.map((row) => row.id), ["sale-2"]);
});

test("completed refund money excludes pending and rejected records", async () => {
  const result = await searchTransactionCenter(EMPTY_TRANSACTION_FILTERS, { sales, returns, refunds });
  const row = result.rows.find((item) => item.id === "sale-1")!;
  assert.equal(row.completed_refund_total, 10);
  assert.equal(row.pending_refund_total, 30);
  assert.deepEqual(row.refunds.map((item) => item.status), ["pending", "rejected", "completed"]);
});

test("current-page export uses transaction rows rather than the recent-sales cache", async () => {
  const result = await searchTransactionCenter(EMPTY_TRANSACTION_FILTERS, { sales, returns, refunds });
  const sheets = buildTransactionCenterSheets({ rows: result.rows, t: ((key: string) => key) as never });
  assert.equal(sheets[0]?.rowCount, 2);
  assert.equal(sheets[1]?.rowCount, 4);
  assert.equal(sheets[0]?.rows[0]?.[0], "INV-sale-1");
  assert.equal(sheets[1]?.rows[0]?.[2], "RET-0001");
});

test("filters and pagination are deterministic", async () => {
  const pending = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, refundStatus: "pending" }, { sales, returns, refunds });
  assert.deepEqual(pending.rows.map((row) => row.id), ["sale-1"]);
  const paymentPending = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, paymentStatus: "pending" }, { sales, returns, refunds });
  assert.deepEqual(paymentPending.rows.map((row) => row.id), ["sale-2"]);
  const first = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, pageSize: 1 }, { sales, returns, refunds });
  const second = await searchTransactionCenter({ ...EMPTY_TRANSACTION_FILTERS, pageSize: 1, page: 2 }, { sales, returns, refunds });
  assert.equal(first.total, 2);
  assert.equal(first.page_count, 2);
  assert.deepEqual(first.rows.map((row) => row.id), ["sale-1"]);
  assert.deepEqual(second.rows.map((row) => row.id), ["sale-2"]);
});

let failures = 0;
for (const entry of tests) {
  try { await entry.run(); }
  catch (error) { failures += 1; console.error(`✗ ${entry.name}`, error); }
}
if (failures) throw new Error(`${failures} transaction center tests failed`);
console.log(`${tests.length}/${tests.length} transaction center tests passed`);

/**
 * Sales repository contract — the live read path (headless, no DOM, no network).
 *
 * Run with:
 *   npx esbuild src/modules/pos/__tests__/supabaseSales.contract.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-sales-contract.mjs && node /tmp/alyq-sales-contract.mjs
 *
 * `SupabaseSalesRepository` is the ONLY path a live till uses to read sales, and
 * CI has no reachable Supabase project, so every line of it is otherwise
 * unverified. This suite drives it against a stub client that records the calls
 * and answers with rows shaped exactly like the tables, and pins the contract
 * the returns workflow depends on:
 *
 *   · `listSales()` carries each sale's LINES and payments — a whole-sale read,
 *     not a header read. It used to map with `items: []`, and because an empty
 *     item list is indistinguishable from "nothing left to return", the returns
 *     modal reported a brand-new invoice as fully returned (INV-000004).
 *   · the reads stay scoped to the page's sale ids (`in("sale_id", …)`) and are
 *     never a full-table scan of `sale_items` / `sale_payments`.
 *   · `getSale()` keeps loading lines and payments for one sale.
 *   · a page with no sales performs no child reads at all.
 *
 * The last describe block is the anti-regression guard: it reads the repository
 * source and fails if `listSales` can go back to mapping a sale with no items.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SupabaseSalesRepository } from "../data/supabaseRepository";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── stub client ──────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

interface StubOptions {
  sales?: Row[];
  saleItems?: Row[];
  salePayments?: Row[];
  /** Tables that answer with a provider error, to prove failures surface. */
  errorOn?: string[];
}

/** One chainable, awaitable query builder over an in-memory row set. */
function makeTable(name: string, rows: Row[], calls: string[], errorOn: string[]) {
  const filters: Array<(row: Row) => boolean> = [];
  let headCount = false;

  const builder = {
    select(_columns?: string, options?: { count?: string; head?: boolean }) {
      calls.push(`from.${name}.select`);
      headCount = Boolean(options?.head);
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      calls.push(`from.${name}.in(${column})`);
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    gte(column: string, value: unknown) {
      filters.push((row) => String(row[column]) >= String(value));
      return builder;
    },
    lte(column: string, value: unknown) {
      filters.push((row) => String(row[column]) <= String(value));
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      calls.push(`from.${name}.order(${column})`);
      const descending = options?.ascending === false;
      const ordered = [...rows].sort((a, b) =>
        String(a[column]).localeCompare(String(b[column])) * (descending ? -1 : 1),
      );
      rows = ordered;
      return builder;
    },
    range(from: number, to: number) {
      filters.push((row) => rows.indexOf(row) >= from && rows.indexOf(row) <= to);
      return builder;
    },
    async single() {
      const matched = rows.filter((row) => filters.every((fn) => fn(row)));
      return { data: matched[0] ?? null, error: null };
    },
    async then(resolve: (value: unknown) => unknown) {
      if (errorOn.includes(name)) {
        return resolve({ data: null, error: { message: `stub failure: ${name}` } });
      }
      const matched = rows.filter((row) => filters.every((fn) => fn(row)));
      const result = headCount
        ? { data: null, error: null, count: matched.length }
        : { data: matched, error: null };
      return resolve(result);
    },
  };

  return builder;
}

function makeStub(options: StubOptions = {}) {
  const calls: string[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tables: Record<string, Row[]> = {
    sales: options.sales ?? [],
    sale_items: options.saleItems ?? [],
    sale_payments: options.salePayments ?? [],
  };
  const client = {
    from(name: string) {
      calls.push(`from.${name}`);
      return makeTable(name, tables[name] ?? [], calls, options.errorOn ?? []);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(`rpc.${name}`);
      rpcCalls.push({ name, args });
      return { data: { sale_id: "sale-a" }, error: null };
    },
  };
  return { client, calls, rpcCalls };
}

// ── fixtures: a fresh live sale, exactly as the tables hold it ───────────────
const SALE_A = {
  id: "sale-a",
  sale_number: "INV-000004",
  client_ref: "ref-a",
  status: "completed",
  payment_method: "cash",
  payment_status: "paid",
  subtotal: "700.00",
  discount_type: "none",
  discount_value: "0.00",
  discount_amount: "0.00",
  total: "700.00",
  amount_received: "700.00",
  change: "0.00",
  user_id: "u-cashier",
  user_name: "Karim Cashier",
  customer_id: "cust-1",
  customer_name: "أحمد الشريف",
  customer_phone: "0501234567",
  created_at: "2026-09-16T09:00:00.000Z",
  voided_at: null,
  void_reason: null,
  paid_at: "2026-09-16T09:00:00.000Z",
  paid_by: "u-cashier",
  paid_by_name: "Karim Cashier",
  source: "pos",
  shift_id: "shift-1",
};

const SALE_B = {
  ...SALE_A,
  id: "sale-b",
  sale_number: "INV-000005",
  client_ref: "ref-b",
  total: "300.00",
  subtotal: "300.00",
  created_at: "2026-09-16T10:00:00.000Z",
};

const ITEMS_A = [
  {
    id: "line-a1", sale_id: "sale-a", product_id: "prod-ring", name_ar: "خاتم", name_en: "Classic Gold Ring",
    sku: "SCN-A", barcode: "6291000000011", unit_price: "350.00", quantity: 1, line_total: "350.00",
    created_at: "2026-09-16T09:00:00.000Z",
  },
  {
    id: "line-a2", sale_id: "sale-a", product_id: "prod-bracelet", name_ar: "سوارة", name_en: "Silver Bracelet",
    sku: "SCN-B", barcode: "6291000000028", unit_price: "175.00", quantity: 2, line_total: "350.00",
    created_at: "2026-09-16T09:00:01.000Z",
  },
];
const ITEMS_B = [
  {
    id: "line-b1", sale_id: "sale-b", product_id: "prod-ring", name_ar: "خاتم", name_en: "Classic Gold Ring",
    sku: "SCN-A", barcode: null, unit_price: "300.00", quantity: 1, line_total: "300.00",
    created_at: "2026-09-16T10:00:00.000Z",
  },
];
const PAYMENTS = [
  { id: "pay-a", sale_id: "sale-a", method: "cash", amount: "700.00", status: "paid", paid_at: "2026-09-16T09:00:00.000Z", paid_by: "u-cashier", paid_by_name: "Karim Cashier", created_at: "2026-09-16T09:00:00.000Z" },
  { id: "pay-b", sale_id: "sale-b", method: "visa", amount: "300.00", status: "paid", paid_at: "2026-09-16T10:00:00.000Z", paid_by: "u-cashier", paid_by_name: "Karim Cashier", created_at: "2026-09-16T10:00:00.000Z" },
];

const repo = (stub: ReturnType<typeof makeStub>) =>
  new SupabaseSalesRepository(stub.client as never);

// ── the contract ─────────────────────────────────────────────────────────────
test("offline replay uses the evidence-validating RPC while normal sales keep the approval RPC", async () => {
  const stub = makeStub({ sales: [SALE_A], saleItems: ITEMS_A, salePayments: PAYMENTS });
  const common = {
    client_ref: "offline-contract-ref",
    lines: [{ product_id: "prod-ring", variant_id: "variant-black-42", qty: 1, discount_type: "none" as const, discount_value: 0 }],
    discount_type: "none" as const,
    discount_value: 0,
    payments: [{ method: "cash" as const, amount: 700, status: "paid" as const, tendered: 700 }],
    user_id: "u-cashier",
    user_name: "Karim Cashier",
  };
  await repo(stub).completeSale({
    ...common,
    offline_evidence: {
      schema_version: 1,
      branch_id: "branch-a",
      captured_at: "2026-10-03T10:00:00.000Z",
      subtotal: 700,
      discount_amount: 0,
      total: 700,
      lines: [{ product_id: "prod-ring", variant_id: "variant-black-42", qty: 1, unit_price: 700, sku: "ALYQ-01-BLK-42", barcode: "629ALYQ0142", color_ar: "أسود", color_en: "Black", size_value: "42" }],
    },
  });
  assert.equal(stub.rpcCalls[0]?.name, "pos_sync_offline_sale");
  assert.equal((stub.rpcCalls[0]?.args.p_evidence as { branch_id?: string })?.branch_id, "branch-a");
  assert.equal((stub.rpcCalls[0]?.args.p_payload as { client_ref?: string })?.client_ref, "offline-contract-ref");

  await repo(stub).completeSale({ ...common, client_ref: "online-contract-ref" }, "approval-1");
  assert.equal(stub.rpcCalls[1]?.name, "pos_complete_sale");
  assert.equal(stub.rpcCalls[1]?.args.p_approval_request_id, "approval-1");
});

test("listSales returns each sale with its own lines and payments", async () => {
  const stub = makeStub({ sales: [SALE_A, SALE_B], saleItems: [...ITEMS_A, ...ITEMS_B], salePayments: PAYMENTS });
  const sales = await repo(stub).listSales();

  assert.equal(sales.length, 2, "both sales come back");

  const a = sales.find((s) => s.id === "sale-a");
  const b = sales.find((s) => s.id === "sale-b");
  assert.ok(a && b, "the fixtures round-trip by id");

  assert.equal(a.items.length, 2, "INV-000004 carries its two lines");
  assert.equal(b.items.length, 1, "INV-000005 carries its one line");
  assert.deepEqual(
    a.items.map((i) => [i.id, i.quantity, i.unit_price]),
    [["line-a1", 1, 350], ["line-a2", 2, 175]],
    "lines keep their ids, quantities and prices (numbers, not strings)",
  );
  assert.equal(a.items[0].name_en, "Classic Gold Ring", "the line snapshot survives the mapping");
  assert.equal(b.items[0].sku, "SCN-A", "lines are attached to the right sale");
  assert.equal(a.items.some((i) => i.sale_id === "sale-b"), false, "no line leaks between sales");

  assert.equal(a.payments.length, 1, "the payment read still works");
  assert.equal(a.payments[0].amount, 700, "payment amounts are numbers");
  assert.equal(b.payments[0].method, "visa", "payments are attached to the right sale");
});

test("a fresh sale arrives with its real item count and no phantom return", async () => {
  const stub = makeStub({ sales: [SALE_A], saleItems: ITEMS_A, salePayments: PAYMENTS });
  const [sale] = await repo(stub).listSales();

  assert.equal(sale.items.length, 2, "a brand-new invoice has its lines");
  assert.equal(
    sale.items.reduce((sum, line) => sum + line.quantity, 0),
    3,
    "the units sold are all present (1 + 2)",
  );
});

test("the child reads are scoped to the page's sale ids — never a table scan", async () => {
  const stub = makeStub({ sales: [SALE_A, SALE_B], saleItems: [...ITEMS_A, ...ITEMS_B], salePayments: PAYMENTS });
  await repo(stub).listSales();

  assert.ok(
    stub.calls.includes("from.sale_items.in(sale_id)"),
    "sale_items is read with an `in (sale_id, …)` filter",
  );
  assert.ok(
    stub.calls.includes("from.sale_payments.in(sale_id)"),
    "sale_payments keeps its `in (sale_id, …)` filter",
  );
});

test("a page with no sales performs no child reads", async () => {
  const stub = makeStub({ sales: [], saleItems: ITEMS_A, salePayments: PAYMENTS });
  const sales = await repo(stub).listSales();

  assert.deepEqual(sales, [], "no sales, no rows");
  assert.equal(
    stub.calls.some((call) => call.startsWith("from.sale_items")),
    false,
    "an empty page does not query sale_items",
  );
  assert.equal(
    stub.calls.some((call) => call.startsWith("from.sale_payments")),
    false,
    "an empty page does not query sale_payments",
  );
});

test("a failing child read surfaces instead of silently emptying the list", async () => {
  const stub = makeStub({ sales: [SALE_A], saleItems: ITEMS_A, errorOn: ["sale_items"] });
  await assert.rejects(
    () => repo(stub).listSales(),
    "a sale_items failure must not be reported as a sale with no items",
  );
});

test("getSale still loads one sale with its lines and payments", async () => {
  const stub = makeStub({ sales: [SALE_A], saleItems: ITEMS_A, salePayments: PAYMENTS });
  const sale = await repo(stub).getSale("sale-a");

  assert.equal(sale.id, "sale-a");
  assert.equal(sale.items.length, 2, "the detail read loads lines");
  assert.equal(sale.payments.length, 1, "the detail read loads payments");
});

test("countSales ignores paging bounds and reports the matching total", async () => {
  const stub = makeStub({ sales: [SALE_A, SALE_B] });
  const count = await repo(stub).countSales();
  assert.equal(count, 2, "the exact count comes back");
});

// ── anti-regression: the exact defect, pinned twice ──────────────────────────
test("REGRESSION: a list-mapped sale can never come back with zero items", async () => {
  // This is INV-000004's shape: two lines in the database. Before the fix,
  // `listSales()` mapped every row through `mapSale(row, [], payments)`, so this
  // assertion read 0 — and the returns modal showed "all items already
  // returned" for an invoice nobody had returned anything from.
  const stub = makeStub({ sales: [SALE_A], saleItems: ITEMS_A, salePayments: PAYMENTS });
  const [sale] = await repo(stub).listSales();

  assert.notEqual(sale.items.length, 0, "a sale with rows in sale_items must not arrive item-less");
  assert.equal(sale.items.length, 2, "…and must carry exactly its own lines");
});

test("REGRESSION: listSales source still passes fetched items into mapSale", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/modules/pos/data/supabaseRepository.ts"),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("async listSales("),
    source.indexOf("async countSales("),
  );

  assert.ok(body.length > 0, "the listSales body was located");
  assert.match(body, /from\("sale_items"\)/, "listSales reads sale_items");
  assert.match(
    body,
    /mapSale\(\s*row,\s*itemsBySale\.get\(row\.id\)/,
    "mapSale receives the fetched lines for this sale",
  );
  assert.doesNotMatch(
    body,
    /mapSale\(row,\s*\[\],/,
    "the item-less mapping that caused the false 'fully returned' banner is gone",
  );
});

// ── runner ───────────────────────────────────────────────────────────────────
let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\n✗ sales repository contract: ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n✓ sales repository contract: ${tests.length} test(s) passed\n`);

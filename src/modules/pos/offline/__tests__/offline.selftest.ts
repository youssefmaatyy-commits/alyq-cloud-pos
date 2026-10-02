/**
 * POS offline-first self-test (headless, Node — MemoryBackend, since plain
 * Node has no `indexedDB`; see `db.ts`. `db.ts`'s two backends share the exact
 * same interface, so every assertion here about the outbox/cache LOGIC holds
 * for the real IndexedDB backend too — only true cross-reload persistence
 * itself needs a real browser, covered separately by a rendered Chromium test
 * where available.)
 *
 * Run with:
 *   node scripts/test.logic.mjs offline
 */
import assert from "node:assert/strict";
import { AppError, readableErrorMessage, toAppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { CompleteSaleInput, Sale } from "../../types";
import { resetOfflineDbForTests, getOfflineDb } from "../db";
import { resetConnectivityForTests, reportNetworkResult, getConnectivityStatus, subscribeConnectivity } from "../connectivity";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "../catalogCache";
import {
  enqueueOfflineSale,
  getOfflineSaleDisplay,
  getOfflineSalesForDisplay,
  getSyncSummary,
  processOutbox,
  retrySyncNow,
  getLastSyncedAt,
  type CompleteSaleFn,
} from "../outbox";
import { offlineSaleToDisplaySale, type OfflineSaleLine, type OfflineSaleRecord } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function freshEnv() {
  resetOfflineDbForTests();
  resetConnectivityForTests("online");
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    sku: "RG-001",
    barcode: "6001234567890",
    name_ar: "خاتم ذهب",
    name_en: "Gold Ring",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 500,
    cost_price: 300,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 2,
    variants_enabled: false,
    show_on_website: false,
    is_featured: false,
    active: true,
    image_url: null,
    ...overrides,
  } as Product;
}

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "var-1",
    product_id: "prod-1",
    sku: "RG-001-BLK-52",
    barcode: "6001234567891",
    color_key: "black",
    color_ar: "أسود",
    color_en: "Black",
    color_hex: null,
    size: 52,
    size_label: "52",
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 4,
    low_stock_level: 1,
    active: true,
    sort_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as ProductVariant;
}

function input(clientRef: string, overrides: Partial<CompleteSaleInput> = {}): CompleteSaleInput {
  return {
    client_ref: clientRef,
    lines: [{ product_id: "prod-1", variant_id: "var-1", qty: 1, discount_type: "none", discount_value: 0 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 500, status: "paid", tendered: 500 }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "user-1",
    user_name: "Cashier One",
    ...overrides,
  };
}

async function enqueueOne(clientRef: string, overrides: Partial<CompleteSaleInput> = {}) {
  const saleInput = input(clientRef, overrides);
  return enqueueOfflineSale(
    saleInput,
    [
      {
        product_id: "prod-1",
        variant_id: "var-1",
        qty: 1,
        discount_type: "none",
        discount_value: 0,
        name_en: "Gold Ring",
        name_ar: "خاتم ذهب",
        sku: "RG-001-BLK-52",
        unit_price: 500,
      },
    ],
    { subtotal: 500, discount_amount: 0, total: 500 },
  );
}

function fakeSale(id: string, saleNumber: string): Sale {
  return {
    id,
    sale_number: saleNumber,
    client_ref: id,
    status: "completed",
    subtotal: 500,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    total: 500,
    user_id: "user-1",
    user_name: "Cashier One",
    items: [],
    payments: [],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    created_at: new Date().toISOString(),
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: 500,
    change: 0,
    paid_at: null,
    paid_by: null,
    paid_by_name: null,
    source: "pos",
    shift_id: null,
  };
}

// ── catalog cache ───────────────────────────────────────────────────────────

test("catalog cache round-trips the exact live products/variants — nothing fabricated", async () => {
  freshEnv();
  const products = [product(), product({ id: "prod-2", sku: "NK-002", name_en: "Silver Necklace" })];
  const variants = [variant(), variant({ id: "var-2", product_id: "prod-2", sku: "NK-002-S" })];
  const before = await readCachedCatalog();
  assert.equal(before.products.length, 0, "nothing cached yet");
  assert.equal(before.cachedAt, null);

  await cacheCatalogSnapshot(products, variants);
  const after = await readCachedCatalog();
  assert.equal(after.products.length, 2);
  assert.equal(after.variants.length, 2);
  assert.ok(after.cachedAt, "cachedAt is stamped");
  // Every field the offline brief asks for is present, verbatim from the live object.
  const cachedRing = after.products.find((p) => p.id === "prod-1")!;
  assert.equal(cachedRing.name_en, "Gold Ring");
  assert.equal(cachedRing.name_ar, "خاتم ذهب");
  assert.equal(cachedRing.sku, "RG-001");
  assert.equal(cachedRing.barcode, "6001234567890");
  assert.equal(cachedRing.selling_price, 500);
  assert.equal(cachedRing.active, true);
  const cachedVariant = after.variants.find((v) => v.id === "var-1")!;
  assert.equal(cachedVariant.id, "var-1", "the exact variant UUID is preserved");
  assert.equal(cachedVariant.color_en, "Black");
  assert.equal(cachedVariant.size, 52);
  assert.equal(cachedVariant.price_override, null);
  assert.equal(cachedVariant.stock_quantity, 4);

  // A second live load overwrites (never merges stale + fresh) the cache.
  await cacheCatalogSnapshot([product({ stock_quantity: 999 })], [variant({ stock_quantity: 1 })]);
  const latest = await readCachedCatalog();
  assert.equal(latest.products.length, 1, "old snapshot fully replaced");
  assert.equal(latest.products[0].stock_quantity, 999);
});

// ── enqueue + local inventory ───────────────────────────────────────────────

test("known-offline exact-variant cash sale queues immediately and decrements cached stock once", async () => {
  freshEnv();
  const exactUuid = "123e4567-e89b-42d3-a456-426614174000";
  const liveProduct = product({ variants_enabled: true, stock_quantity: 10 });
  const liveVariant = variant({ id: exactUuid, stock_quantity: 10 });
  await cacheCatalogSnapshot([liveProduct], [liveVariant]);
  const saleInput = input("cr-fast-offline", {
    lines: [{ product_id: liveProduct.id, variant_id: exactUuid, qty: 1, discount_type: "none", discount_value: 0 }],
  });
  const plan = planOfflineInventory([liveProduct], [liveVariant], saleInput.lines, new Date().toISOString());
  const started = performance.now();
  const record = await enqueueOfflineSale(
    saleInput,
    [{
      product_id: liveProduct.id, variant_id: exactUuid, qty: 1,
      discount_type: "none", discount_value: 0,
      name_en: liveProduct.name_en, name_ar: liveProduct.name_ar,
      sku: liveVariant.sku, unit_price: liveProduct.selling_price,
    }],
    { subtotal: 500, discount_amount: 0, total: 500 },
    plan.writes,
  );
  assert.ok(performance.now() - started < 1_000, "local completion stays below the one-second target");
  assert.equal(record.sync_status, "pending");
  assert.equal(plan.products[0].stock_quantity, 9);
  assert.equal(plan.variants[0].stock_quantity, 9);
  const persisted = await readCachedCatalog();
  assert.equal(persisted.products[0].stock_quantity, 9, "product rollup survives refresh at 9");
  assert.equal(persisted.variants[0].stock_quantity, 9, "exact shelf survives refresh at 9");

  let calls = 0;
  await processOutbox(async (received) => {
    calls += 1;
    assert.equal(received.client_ref, "cr-fast-offline");
    assert.equal(received.lines[0].variant_id, exactUuid);
    return fakeSale("server-fast", "S-FAST");
  });
  await processOutbox(async () => {
    calls += 1;
    return fakeSale("duplicate", "DUPLICATE");
  });
  assert.equal(calls, 1, "sync does not decrement/create the sale twice");
  const afterSync = await readCachedCatalog();
  assert.equal(afterSync.variants[0].stock_quantity, 9, "sync itself does not apply a second local decrement");
});

// ── enqueue + local persistence within one process ─────────────────────────

test("a cash sale completed offline is queued with a stable client_ref and appears pending", async () => {
  freshEnv();
  const clientRef = "cr-offline-1";
  const record = await enqueueOne(clientRef);
  assert.equal(record.sync_status, "pending");
  assert.equal(record.client_ref, clientRef);
  assert.equal(record.total, 500);

  const display = await getOfflineSaleDisplay(record.id);
  assert.ok(display, "the freshly queued sale renders immediately");
  assert.equal(display!.total, 500);
  assert.equal(display!.offline_sync_status, "pending");
  assert.equal(display!.items.length, 1);
  assert.equal(display!.items[0].sku, "RG-001-BLK-52");

  const list = await getOfflineSalesForDisplay();
  assert.equal(list.length, 1, "shows up in the merged offline list");
  const summary = await getSyncSummary();
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.errorCount, 0);
});

test("the multi-store receipt/lines/outbox write is atomic when structured clone rejects a value", async () => {
  freshEnv();
  const db = getOfflineDb();
  await assert.rejects(() => db.putBatch([
    { store: "offline_sales", value: { id: "must-not-partially-write", total: 500 } },
    { store: "sync_outbox", value: { client_ref: "must-not-partially-write", uncloneable: () => true } },
  ]), /clone|could not be cloned/i);
  assert.equal(await db.get("offline_sales", "must-not-partially-write"), undefined);
  assert.equal(await db.get("sync_outbox", "must-not-partially-write"), undefined);
});

test("an offline sale survives being re-read from the store (simulated refresh)", async () => {
  freshEnv();
  const record = await enqueueOne("cr-refresh-1");
  // A page refresh re-creates every in-memory React state, but NOT the
  // storage backend itself — re-reading through fresh top-level calls (no
  // `resetOfflineDbForTests()` here) is exactly what a reloaded POS page
  // would do on mount.
  const reread = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.ok(reread, "the offline sale is still there after the equivalent of a reload");
  assert.equal(reread!.total, 500);
  const lines = await getOfflineDb().getAll<OfflineSaleLine>("offline_sale_lines");
  assert.equal(lines.filter((l) => l.local_sale_id === record.id).length, 1);
});

// ── sync engine ──────────────────────────────────────────────────────────────

test("a queued sale syncs successfully and is removed from the outbox (but kept as an audit row)", async () => {
  freshEnv();
  const record = await enqueueOne("cr-sync-ok");
  let calls = 0;
  const complete: CompleteSaleFn = async (received) => {
    calls += 1;
    assert.equal(received.client_ref, "cr-sync-ok", "the exact same client_ref is replayed");
    return fakeSale("server-sale-1", "S-0001");
  };
  const result = await processOutbox(complete);
  assert.equal(calls, 1);
  assert.deepEqual(result.synced, [record.id]);
  assert.deepEqual(result.failed, []);

  const summary = await getSyncSummary();
  assert.equal(summary.pendingCount, 0, "the outbox entry is gone");
  const visible = await getOfflineSalesForDisplay();
  assert.equal(visible.length, 0, "a synced sale drops out of the offline-only list (it now lives server-side)");

  const audit = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(audit!.sync_status, "synced");
  assert.equal(audit!.server_id, "server-sale-1");
  assert.equal(audit!.server_sale_number, "S-0001");
  assert.ok(audit!.synced_at);

  const lastSyncedAt = await getLastSyncedAt();
  assert.ok(lastSyncedAt, "last-synced timestamp recorded");
});

test("CRITICAL: a synced sale is never re-submitted — retrying afterwards is a no-op", async () => {
  freshEnv();
  await enqueueOne("cr-no-dup");
  let calls = 0;
  const complete: CompleteSaleFn = async () => {
    calls += 1;
    return fakeSale("server-sale-2", "S-0002");
  };
  await processOutbox(complete);
  assert.equal(calls, 1);
  // Two more automatic passes and a manual retry — none of them should touch
  // the server again: the outbox entry was deleted the moment sync #1 confirmed.
  await processOutbox(complete);
  await processOutbox(complete);
  await retrySyncNow(complete);
  assert.equal(calls, 1, "the server call never fires a second time for an already-synced sale");
});

test("simultaneous reconnect/timer/manual triggers share one sync pass", async () => {
  freshEnv();
  await enqueueOne("cr-concurrent");
  let calls = 0;
  const complete: CompleteSaleFn = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return fakeSale("server-concurrent", "S-CONCURRENT");
  };
  await Promise.all([
    processOutbox(complete),
    processOutbox(complete),
    retrySyncNow(complete),
  ]);
  assert.equal(calls, 1, "one queued sale makes one server call under concurrent triggers");
});

test("a network failure keeps the sale queued with an error status — never deleted", async () => {
  freshEnv();
  const record = await enqueueOne("cr-net-fail");
  const complete: CompleteSaleFn = async () => {
    throw new AppError("NETWORK", "Failed to fetch");
  };
  const result = await processOutbox(complete);
  assert.deepEqual(result.failed, [record.id]);

  const summary = await getSyncSummary();
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.errorCount, 1, "queued as an error, not silently pending forever");

  const stillThere = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.ok(stillThere, "never deleted");
  assert.equal(stillThere!.sync_status, "error");
  assert.equal(stillThere!.last_error_kind, "network");

  const visible = await getOfflineSalesForDisplay();
  assert.equal(visible.length, 1, "a failed sale is still visible to the cashier for staff resolution");
});

test("retry after reconnecting succeeds exactly once, replaying the identical client_ref", async () => {
  freshEnv();
  const record = await enqueueOne("cr-retry-then-ok");
  let attempt = 0;
  const seenRefs: string[] = [];
  const complete: CompleteSaleFn = async (received) => {
    attempt += 1;
    seenRefs.push(received.client_ref);
    if (attempt === 1) throw new AppError("NETWORK", "network request failed");
    return fakeSale("server-sale-3", "S-0003");
  };
  const first = await processOutbox(complete);
  assert.deepEqual(first.failed, [record.id]);
  const second = await retrySyncNow(complete); // manual retry — ignores backoff
  assert.equal(second.synced.length, 1);
  assert.equal(attempt, 2);
  assert.deepEqual(seenRefs, ["cr-retry-then-ok", "cr-retry-then-ok"], "same client_ref both times — this is what stops a duplicate sale");
  const summary = await getSyncSummary();
  assert.equal(summary.pendingCount + summary.errorCount, 0);
});

test("an inventory conflict at sync time is surfaced distinctly and the sale is preserved", async () => {
  freshEnv();
  const record = await enqueueOne("cr-conflict");
  const complete: CompleteSaleFn = async () => {
    // The exact shape `pos_complete_sale` (migration 0055) raises for a stock shortfall.
    throw new AppError("DB", "Only 1 of 2 in stock");
  };
  const result = await processOutbox(complete);
  assert.deepEqual(result.conflicts, [record.id]);
  const summary = await getSyncSummary();
  assert.equal(summary.conflictCount, 1);
  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored!.last_error_kind, "conflict");
  assert.ok(stored, "conflicting sale is never deleted — staff must resolve it");
});

test("cashier retry re-attempts network failures but preserves conflicts for review", async () => {
  freshEnv();
  await enqueueOne("cr-review-conflict");
  let calls = 0;
  const conflict: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("VALIDATION", "Only 0 of 1 in stock");
  };
  await processOutbox(conflict);
  await processOutbox(conflict, { retryNetwork: true });
  assert.equal(calls, 1, "a conflict is visible/preserved, not silently re-submitted by cashier retry");
  assert.equal((await getSyncSummary()).conflictCount, 1);
});

test("a rejected (business-rule) failure is not hammered automatically, but manual retry still attempts it", async () => {
  freshEnv();
  await enqueueOne("cr-rejected");
  let autoCalls = 0;
  const rejectingComplete: CompleteSaleFn = async () => {
    autoCalls += 1;
    throw new AppError("VALIDATION", "Discount exceeds the allowed limit");
  };
  await processOutbox(rejectingComplete);
  assert.equal(autoCalls, 1);
  // A second automatic pass should NOT re-attempt a "rejected" failure — only
  // network failures are eligible for the automatic loop (see outbox.ts).
  await processOutbox(rejectingComplete);
  assert.equal(autoCalls, 1, "automatic sync leaves a rejected sale for a human, not a retry loop");
  // The manual "Retry sync" button still attempts everything, unconditionally.
  await retrySyncNow(rejectingComplete);
  assert.equal(autoCalls, 2, "manual retry always attempts, regardless of error kind");
});

test("multiple queued sales sync safely in creation order, each exactly once", async () => {
  freshEnv();
  const a = await enqueueOne("cr-multi-a");
  await new Promise((r) => setTimeout(r, 2));
  const b = await enqueueOne("cr-multi-b");
  await new Promise((r) => setTimeout(r, 2));
  const c = await enqueueOne("cr-multi-c");
  const order: string[] = [];
  const complete: CompleteSaleFn = async (received) => {
    order.push(received.client_ref);
    return fakeSale(`server-${received.client_ref}`, `S-${received.client_ref}`);
  };
  const result = await processOutbox(complete);
  assert.deepEqual(order, ["cr-multi-a", "cr-multi-b", "cr-multi-c"], "oldest first");
  assert.equal(result.synced.length, 3);
  for (const rec of [a, b, c]) {
    const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", rec.id);
    assert.equal(stored!.sync_status, "synced");
  }
  const summary = await getSyncSummary();
  assert.equal(summary.pendingCount + summary.errorCount + summary.conflictCount, 0);
});

test("processOutbox with nothing queued does not call the network at all", async () => {
  freshEnv();
  let calls = 0;
  await processOutbox(async () => {
    calls += 1;
    return fakeSale("x", "x");
  });
  assert.equal(calls, 0);
});

// ── real Supabase offline error shape + connectivity ─────────────────────────

test("a structured Supabase fetch failure remains readable and enters the NETWORK offline branch", () => {
  const actualSupabaseShape = {
    message: "TypeError: Failed to fetch",
    details: "TypeError: Failed to fetch",
    hint: "",
    code: "",
  };
  assert.equal(String(actualSupabaseShape), "[object Object]", "proves the old String(error) failure mode");
  assert.equal(readableErrorMessage(actualSupabaseShape), "TypeError: Failed to fetch");
  const normalized = toAppError(actualSupabaseShape);
  assert.equal(normalized.name, "AppError");
  assert.equal(normalized.code, "NETWORK");
  assert.equal(normalized.message, "TypeError: Failed to fetch");
});

test("connectivity flips on a real network result, independent of any polling", () => {
  resetConnectivityForTests("online");
  assert.equal(getConnectivityStatus(), "online");
  const seen: string[] = [];
  const unsubscribe = subscribeConnectivity((status) => seen.push(status));
  reportNetworkResult("network-error");
  assert.equal(getConnectivityStatus(), "offline");
  reportNetworkResult("success");
  assert.equal(getConnectivityStatus(), "online");
  assert.deepEqual(seen, ["offline", "online"]);
  unsubscribe();
  reportNetworkResult("network-error");
  assert.equal(seen.length, 2, "no more notifications after unsubscribing");
});

// ── display mapping ──────────────────────────────────────────────────────────

test("offlineSaleToDisplaySale computes line/discount math the same way the live cart does", () => {
  const record: OfflineSaleRecord = {
    id: "local-1",
    client_ref: "cr-display",
    created_at: new Date().toISOString(),
    input: input("cr-display"),
    subtotal: 500,
    discount_amount: 50,
    total: 450,
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "user-1",
    user_name: "Cashier One",
    sync_status: "pending",
    server_id: null,
    server_sale_number: null,
    synced_at: null,
    last_error: null,
    last_error_kind: null,
  };
  const lines: OfflineSaleLine[] = [
    {
      id: "local-1::0",
      local_sale_id: "local-1",
      product_id: "prod-1",
      variant_id: "var-1",
      qty: 2,
      discount_type: "percent",
      discount_value: 10,
      name_en: "Gold Ring",
      name_ar: "خاتم ذهب",
      sku: "RG-001-BLK-52",
      unit_price: 500,
    },
  ];
  const sale = offlineSaleToDisplaySale(record, lines);
  assert.equal(sale.offline_sync_status, "pending");
  assert.equal(sale.items[0].gross_total, 1000);
  assert.equal(sale.items[0].discount_amount, 100, "10% of 1000");
  assert.equal(sale.items[0].line_total, 900);
  assert.equal(sale.sale_number.startsWith("OFFLINE-"), true, "an unsynced sale gets a clearly local, never-fabricated-as-server number");
});

// runner — sequential, matching the other POS logic suites
let passed = 0;
async function main() {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} POS offline tests passed.`);
}

await main();

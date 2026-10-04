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
import { resetConnectivityForTests, reportNetworkResult, getConnectivityStatus, getConnectivitySnapshot, reportQueueHealth, reportSyncActivity, subscribeConnectivity } from "../connectivity";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "../catalogCache";
import {
  enqueueOfflineSale,
  getOfflineSaleDisplay,
  getOfflineSalesForDisplay,
  getSyncSummary,
  processOutbox,
  retrySyncNow,
  getLastSyncedAt,
  listSafeSyncOperations,
  type CompleteSaleFn,
} from "../outbox";
import { offlineSaleToDisplaySale, type OfflineSaleLine, type OfflineSaleRecord } from "../types";
import { ensureOfflineSchema } from "../schema";

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

test("catalog cache never exposes one branch's last-known shelves in another branch", async () => {
  freshEnv();
  await cacheCatalogSnapshot(
    [product({ variants_enabled: true, stock_quantity: 10 })],
    [variant({ size_value: "42", stock_quantity: 10 })],
    "branch-a",
  );
  const branchA = await readCachedCatalog("branch-a");
  assert.equal(branchA.variants[0].id, "var-1");
  assert.equal(branchA.variants[0].branch_id, "branch-a");
  const branchB = await readCachedCatalog("branch-b");
  assert.equal(branchB.products.length, 0, "Branch A product totals do not leak to Branch B");
  assert.equal(branchB.variants.length, 0, "Branch A exact shelf does not leak to Branch B");
});

// ── enqueue + local inventory ───────────────────────────────────────────────

test("cache schema upgrade invalidates disposable catalog only and preserves unsynced business data", async () => {
  freshEnv();
  await cacheCatalogSnapshot([product()], [variant()], "branch-a");
  const record = await enqueueOne("cr-schema-upgrade");
  const db = getOfflineDb();
  await db.put("sync_metadata", { key: "offline_business_schema_version", value: "1" });
  await db.put("sync_metadata", { key: "offline_catalog_schema_version", value: "1" });
  const health = await ensureOfflineSchema();
  assert.equal(health.compatible, true);
  assert.equal(health.detail, "upgraded");
  const cached = await readCachedCatalog("branch-a");
  assert.equal(cached.products.length, 0, "old disposable catalog rows are cleared");
  assert.ok(await db.get<OfflineSaleRecord>("offline_sales", record.id), "queued sale survives cache invalidation");
  assert.equal((await getSyncSummary()).pendingCount, 1);
});

test("a newer durable record schema fails closed even when metadata is missing", async () => {
  freshEnv();
  const record = await enqueueOne("cr-newer-schema");
  const db = getOfflineDb();
  await db.put("offline_sales", { ...record, schema_version: 99 });
  await db.delete("sync_metadata", "offline_business_schema_version");
  const health = await ensureOfflineSchema();
  assert.equal(health.compatible, false);
  assert.equal(health.detail, "newer_than_app");
  assert.equal((await db.get<OfflineSaleRecord>("offline_sales", record.id))?.schema_version, 99, "newer business data is never rewritten by an older app");
});

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

test("safe Sync Center rows exclude customers, payments and raw payloads", async () => {
  freshEnv();
  await enqueueOne("cr-safe-projection", {
    customer_id: "customer-secret-id",
    customer_name: "Private Customer",
    customer_phone: "01000000000",
  });
  const [safe] = await listSafeSyncOperations();
  const text = JSON.stringify(safe);
  assert.ok(safe);
  assert.ok(!text.includes("Private Customer"));
  assert.ok(!text.includes("01000000000"));
  assert.ok(!text.includes("customer-secret-id"));
  assert.ok(!text.includes("payments"));
  assert.ok(!text.includes("tendered"));
  assert.ok(!text.includes("input"));
});

test("offline outbox preserves exact variant and waits for its originating branch", async () => {
  freshEnv();
  const saleInput = input("branch-a-black-42", {
    lines: [{ product_id: "prod-1", variant_id: "black-42", qty: 1 }],
  });
  const record = await enqueueOfflineSale(
    saleInput,
    [{
      product_id: "prod-1", variant_id: "black-42", qty: 1,
      discount_type: "none", discount_value: 0,
      name_en: "ALYQ-01", name_ar: "ALYQ-01", sku: "ALYQ-01-BLK-42", barcode: "ALYQ01BLK42",
      color_en: "Black", color_ar: "أسود", size_value: "42", unit_price: 500,
    }],
    { subtotal: 500, discount_amount: 0, total: 500, branch_id: "branch-a" },
  );
  assert.equal(record.branch_id, "branch-a");
  const storedLines = await getOfflineDb().getAll<OfflineSaleLine>("offline_sale_lines");
  assert.equal(storedLines[0].branch_id, "branch-a");
  assert.equal(storedLines[0].variant_id, "black-42");
  assert.equal(storedLines[0].sku, "ALYQ-01-BLK-42");
  assert.equal(storedLines[0].barcode, "ALYQ01BLK42");
  assert.equal(storedLines[0].color_en, "Black");
  assert.equal(storedLines[0].color_ar, "أسود");
  assert.equal(storedLines[0].size_value, "42");
  assert.equal(record.input.offline_evidence?.lines[0].variant_id, "black-42");
  assert.equal(record.input.offline_evidence?.lines[0].sku, "ALYQ-01-BLK-42");

  let calls = 0;
  const complete: CompleteSaleFn = async (received) => {
    calls += 1;
    assert.equal(received.lines[0].variant_id, "black-42");
    return fakeSale("branch-sale", "INV-BRANCH");
  };
  const wrongBranch = await processOutbox(complete, { branchId: "branch-b", retryNetwork: true });
  assert.equal(calls, 0, "switching branches cannot redirect queued stock");
  assert.deepEqual(wrongBranch.synced, []);
  assert.equal((await getSyncSummary()).deferredCount, 1);
  const deferred = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(deferred?.sync_status, "deferred");

  await processOutbox(complete, { branchId: "branch-a", retryNetwork: true });
  assert.equal(calls, 1);
  assert.equal((await getSyncSummary()).pendingCount, 0);
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
  assert.equal(summary.failedCount, 1, "queued as failed, not silently pending forever");

  const stillThere = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.ok(stillThere, "never deleted");
  assert.equal(stillThere!.sync_status, "failed");
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

test("lost server response replays the same reference and resolves to one authoritative sale", async () => {
  freshEnv();
  const record = await enqueueOne("cr-lost-response");
  const committed = new Map<string, Sale>();
  let writes = 0;
  let first = true;
  const complete: CompleteSaleFn = async (received) => {
    let sale = committed.get(received.client_ref);
    if (!sale) {
      sale = fakeSale("server-lost-response", "S-LOST");
      committed.set(received.client_ref, sale);
      writes += 1;
    }
    if (first) {
      first = false;
      throw new AppError("NETWORK", "Response was lost after commit");
    }
    return sale;
  };
  await processOutbox(complete);
  await retrySyncNow(complete);
  assert.equal(writes, 1, "stable client_ref makes the authoritative server write idempotent");
  assert.equal(committed.size, 1);
  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.server_id, "server-lost-response");
  assert.equal(stored?.sync_status, "synced");
});

test("automatic network recovery is capped while an explicit retry remains eligible", async () => {
  freshEnv();
  await enqueueOne("cr-bounded-network");
  let calls = 0;
  const fail: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("NETWORK", "Failed to fetch");
  };
  await processOutbox(fail);
  for (let index = 0; index < 10; index += 1) await processOutbox(fail, { recovery: true });
  assert.equal(calls, 5, "automatic recovery stops at the bounded attempt cap");
  await retrySyncNow(fail);
  assert.equal(calls, 6, "a deliberate retry may re-attempt the transient network row");
});

test("revoked sale authority is deferred without an automatic retry loop", async () => {
  freshEnv();
  const record = await enqueueOne("cr-revoked");
  let calls = 0;
  const complete: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("DB", "Offline sale sync is not permitted in the active branch");
  };
  await processOutbox(complete);
  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.sync_status, "deferred");
  assert.equal(stored?.last_error_kind, "permission");
  await processOutbox(complete);
  assert.equal(calls, 1, "a permanent permission refusal is not hammered automatically");
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

test("a rejected business rule is preserved and no manual force bypass is available", async () => {
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
  // Manual retry bypasses network backoff only; it never overrides a refusal.
  await retrySyncNow(rejectingComplete);
  assert.equal(autoCalls, 1, "manual retry cannot force a rejected business operation");
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

test("application connectivity distinguishes syncing, degraded and sync error facts", () => {
  resetConnectivityForTests("online");
  assert.equal(getConnectivitySnapshot().state, "online");
  reportSyncActivity("syncing");
  assert.equal(getConnectivitySnapshot().state, "syncing");
  reportSyncActivity("idle");
  reportNetworkResult("network-error");
  assert.equal(getConnectivitySnapshot().state, "degraded", "browser can be up while backend is unavailable");
  reportNetworkResult("success");
  reportQueueHealth({ pending: 0, failed: 1, deferred: 0, conflicts: 0 });
  assert.equal(getConnectivitySnapshot().state, "sync_error");
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

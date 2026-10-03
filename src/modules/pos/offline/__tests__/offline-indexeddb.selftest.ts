/**
 * Focused persistence acceptance against an IndexedDB implementation, rather
 * than the ordinary offline suite's in-memory fallback.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import type { CompleteSaleInput, Sale } from "../../types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { getOfflineDb, resetOfflineDbForTests } from "../db";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "../catalogCache";
import {
  enqueueOfflineSale,
  getOfflineSaleDisplay,
  getOfflineSalesForDisplay,
  getSyncSummary,
  processOutbox,
  retrySyncNow,
} from "../outbox";
import type { OfflineSaleLine, OfflineSaleRecord } from "../types";

const stores = [
  "cached_products", "cached_variants", "offline_sales",
  "offline_sale_lines", "sync_outbox", "sync_metadata",
] as const;
const exactVariantUuid = "123e4567-e89b-42d3-a456-426614174000";
const clientRef = "pos-indexeddb-stable-client-ref";
const branchId = "223e4567-e89b-42d3-a456-426614174001";
const registerId = "323e4567-e89b-42d3-a456-426614174002";
const installationId = "423e4567-e89b-42d3-a456-426614174003";

const db = getOfflineDb();
for (const store of stores) await db.clear(store);

const cachedProduct = {
  id: "prod-1", sku: "EXACT", barcode: null, name_ar: "منتج", name_en: "Product",
  description_ar: null, description_en: null, category_id: null, product_type: "physical",
  selling_price: 500, cost_price: 300, tax_rate: 0, stock_tracking_enabled: true,
  stock_quantity: 10, low_stock_level: 2, variants_enabled: true,
  show_on_website: false, is_featured: false, active: true, image_url: null,
  images: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} satisfies Product;
const cachedVariant = {
  id: exactVariantUuid, product_id: "prod-1", sku: "EXACT-UUID", barcode: null,
  color_key: "gold", color_ar: "ذهبي", color_en: "Gold", color_hex: null,
  size: 10, size_label: "10", image_url: null, price_override: null, cost_override: null,
  stock_quantity: 10, low_stock_level: 2, active: true, sort_order: 0,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} satisfies ProductVariant;
await cacheCatalogSnapshot([cachedProduct], [cachedVariant]);

const input: CompleteSaleInput = {
  client_ref: clientRef,
  lines: [{
    product_id: "prod-1", variant_id: exactVariantUuid, qty: 1,
    discount_type: "none", discount_value: 0,
  }],
  discount_type: "none",
  discount_value: 0,
  payments: [{ method: "cash", amount: 500, status: "paid", tendered: 500 }],
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  user_id: "cashier-1",
  user_name: "Cashier One",
  register_id: registerId,
  installation_id: installationId,
  register_name: "Front Till",
};
const inventory = planOfflineInventory([cachedProduct], [cachedVariant], input.lines, new Date().toISOString());
const started = performance.now();
const record = await enqueueOfflineSale(
  input,
  [{
    product_id: "prod-1", variant_id: exactVariantUuid, qty: 1,
    discount_type: "none", discount_value: 0,
    name_en: "Exact Variant", name_ar: "النوع المحدد", sku: "EXACT-UUID", unit_price: 500,
  }],
  { subtotal: 500, discount_amount: 0, total: 500, branch_id: branchId },
  inventory.writes,
);
const localCompletionMs = performance.now() - started;
assert.ok(localCompletionMs < 1_000, "real IndexedDB-shaped transaction completes below one second");
let summary = await getSyncSummary();
assert.equal(summary.pendingCount, 1, "cash sale increments Pending Sync");
assert.equal((await getOfflineSaleDisplay(record.id))?.offline_sync_status, "pending");

// Recreate the wrapper as a page reload would. The records must come from the
// same persistent IndexedDB database, not retained Maps or React state.
resetOfflineDbForTests();
const reopened = getOfflineDb();
const persisted = await reopened.get<OfflineSaleRecord>("offline_sales", record.id);
const persistedLines = await reopened.getAll<OfflineSaleLine>("offline_sale_lines");
assert.ok(persisted, "offline sale survives IndexedDB reopen");
assert.equal(persisted!.input.client_ref, clientRef);
assert.equal(persisted!.input.lines[0].variant_id, exactVariantUuid);
assert.equal(persisted!.branch_id, branchId);
assert.equal(persisted!.register_id, registerId, "original register survives desktop restart");
assert.equal(persisted!.installation_id, installationId, "original installation survives desktop restart");
assert.equal(persisted!.input.offline_evidence?.register_id, registerId);
assert.equal(persisted!.input.offline_evidence?.installation_id, installationId);
assert.equal(persistedLines.find((line) => line.local_sale_id === record.id)?.variant_id, exactVariantUuid);
const reopenedCatalog = await readCachedCatalog();
assert.equal(reopenedCatalog.products[0].stock_quantity, 9, "product stock remains 9 after reopen");
assert.equal(reopenedCatalog.variants[0].stock_quantity, 9, "exact variant stock remains 9 after reopen");
assert.equal((await getOfflineSalesForDisplay()).length, 1, "pending sale is restored after reopen");

let serverCalls = 0;
let simulatedServerStock = 10;
const seenRefs: string[] = [];
const complete = async (received: CompleteSaleInput): Promise<Sale> => {
  serverCalls += 1;
  seenRefs.push(received.client_ref);
  simulatedServerStock -= received.lines[0].qty;
  return { id: "server-sale-1", sale_number: "S-000001" } as Sale;
};
await processOutbox(complete);
await processOutbox(complete);
await retrySyncNow(complete);
assert.equal(serverCalls, 1, "reconnect/retry cannot create a duplicate server sale");
assert.equal(simulatedServerStock, 9, "server-side sale mutation decrements stock exactly once");
assert.deepEqual(seenRefs, [clientRef], "sync replays the original idempotency key unchanged");
assert.equal(persisted!.input.register_id, registerId, "replay retains original register evidence");
summary = await getSyncSummary();
assert.equal(summary.pendingCount + summary.errorCount + summary.conflictCount, 0, "Pending Sync decreases after success");
const audit = await reopened.get<OfflineSaleRecord>("offline_sales", record.id);
assert.equal(audit?.sync_status, "synced");
assert.equal(audit?.server_id, "server-sale-1");

// Prove a structured-clone failure aborts the whole multi-store transaction.
await assert.rejects(() => reopened.putBatch([
  { store: "offline_sales", value: { id: "partial-write-guard" } },
  { store: "sync_outbox", value: { client_ref: "partial-write-guard", bad: () => true } },
]), /clone|could not be cloned/i);
assert.equal(await reopened.get("offline_sales", "partial-write-guard"), undefined);
assert.equal(await reopened.get("sync_outbox", "partial-write-guard"), undefined);

console.log(`\n1/1 IndexedDB offline cash-sale flow passed in ${localCompletionMs.toFixed(2)} ms (queue, reopen, stock 10→9, exact UUID, sync once, atomic failure).\n`);

/**
 * Focused persistence acceptance against an IndexedDB implementation, rather
 * than the ordinary offline suite's in-memory fallback.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import type { CompleteSaleInput, Sale } from "../../types";
import { getOfflineDb, resetOfflineDbForTests } from "../db";
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

const db = getOfflineDb();
for (const store of stores) await db.clear(store);

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
};
const record = await enqueueOfflineSale(
  input,
  [{
    product_id: "prod-1", variant_id: exactVariantUuid, qty: 1,
    discount_type: "none", discount_value: 0,
    name_en: "Exact Variant", name_ar: "النوع المحدد", sku: "EXACT-UUID", unit_price: 500,
  }],
  { subtotal: 500, discount_amount: 0, total: 500 },
);
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
assert.equal(persistedLines.find((line) => line.local_sale_id === record.id)?.variant_id, exactVariantUuid);
assert.equal((await getOfflineSalesForDisplay()).length, 1, "pending sale is restored after reopen");

let serverCalls = 0;
const seenRefs: string[] = [];
const complete = async (received: CompleteSaleInput): Promise<Sale> => {
  serverCalls += 1;
  seenRefs.push(received.client_ref);
  return { id: "server-sale-1", sale_number: "S-000001" } as Sale;
};
await processOutbox(complete);
await processOutbox(complete);
await retrySyncNow(complete);
assert.equal(serverCalls, 1, "reconnect/retry cannot create a duplicate server sale");
assert.deepEqual(seenRefs, [clientRef], "sync replays the original idempotency key unchanged");
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

console.log("\n1/1 IndexedDB offline cash-sale flow passed (queue, reopen, exact UUID, sync once, atomic failure).\n");

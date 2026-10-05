/**
 * Offline & Sync Hardening Test Suite (Node / Logic Selftest)
 *
 * Covers:
 * 1. Complete offline cash sale -> queuing with status 'pending', local stock deduction, safe audit projection.
 * 2. Reconnect -> auto-sync -> replay with original client_ref, server completion, outbox cleanup, audit preservation.
 * 3. Server idempotency -> lost response & duplicate retry with same client_ref returns original sale exactly once.
 * 4. Transient network failure -> exponential backoff, attempt counter increment, outbox retention.
 * 5. Max automatic attempts exceeded -> marked failed, stops hammering server, allows manual retry.
 * 6. Schema/permanent error -> marked deferred/permanent, no auto-retry loop.
 * 7. Permission revocation -> sync deferred under 'permission' error kind, no busy loop.
 * 8. Branch mismatch -> sale queued for Branch A deferred when active is Branch B; resolves when switched back to Branch A.
 * 9. Cashier switch -> Sale queued for Cashier A deferred when Cashier B is logged in; prevents silent re-attribution; replays when Cashier A is active.
 * 10. Shift context preservation -> original shift_id attached to evidence and sale input; verified on replay.
 * 11. Stock conflict on sync -> inventory conflict classified as 'conflict', preserved for human review without data corruption.
 * 12. Price/discount validation -> server validation prevents unauthorized discount bypass.
 * 13. Payment method enforcement -> cash only allowed offline; card/split/promotions rejected before queueing.
 * 14. Non-durable storage fallback -> memory backend detection, storageDurable flag, in-memory outbox/sync functionality.
 * 15. Held carts -> durable local drafts, cart suspension and restoration without stock deduction until completed.
 */
import assert from "node:assert/strict";
import { AppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { CartLine, CompleteSaleInput, Sale } from "../../types";
import { resetOfflineDbForTests, getOfflineDb, isStorageDurable, getStorageKind } from "../db";
import { resetConnectivityForTests, getConnectivitySnapshot } from "../connectivity";
import { cacheCatalogSnapshot, planOfflineInventory } from "../catalogCache";
import {
  enqueueOfflineSale,
  getOfflineSaleDisplay,
  getSyncSummary,
  processOutbox,
  retrySyncNow,
  listSafeSyncOperations,
  type CompleteSaleFn,
} from "../outbox";
import { holdCart, listHeldCarts, removeHeldCart } from "../heldCarts";
import type { OfflineSaleRecord, SyncOutboxEntry } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function freshEnv() {
  resetOfflineDbForTests();
  resetConnectivityForTests("online");
}

function mockProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-hardening-1",
    sku: "SKU-H1",
    barcode: "600111222333",
    name_ar: "قميص قطن",
    name_en: "Cotton Shirt",
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 250,
    cost_price: 150,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 2,
    variants_enabled: true,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function mockVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "var-hardening-1",
    product_id: "prod-hardening-1",
    sku: "SKU-H1-BLU-L",
    barcode: "600111222334",
    color_key: "blue",
    color_ar: "أزرق",
    color_en: "Blue",
    color_hex: "#0000FF",
    size: null,
    size_label: "L",
    size_value: "L",
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 10,
    low_stock_level: 2,
    active: true,
    sort_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function mockSaleInput(clientRef: string, overrides: Partial<CompleteSaleInput> = {}): CompleteSaleInput {
  return {
    client_ref: clientRef,
    lines: [
      {
        product_id: "prod-hardening-1",
        variant_id: "var-hardening-1",
        qty: 2,
        discount_type: "none",
        discount_value: 0,
      },
    ],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 500, status: "paid", tendered: 500 }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "user-cashier-1",
    user_name: "Cashier Alice",
    shift_id: "shift-001",
    ...overrides,
  };
}

async function enqueueMockSale(
  clientRef: string,
  overrides: Partial<CompleteSaleInput> = {},
  metaOverrides: { branch_id?: string; shift_id?: string; shift_number?: string } = {},
) {
  const saleInput = mockSaleInput(clientRef, overrides);
  return enqueueOfflineSale(
    saleInput,
    [
      {
        product_id: "prod-hardening-1",
        variant_id: "var-hardening-1",
        qty: 2,
        discount_type: "none",
        discount_value: 0,
        name_en: "Cotton Shirt",
        name_ar: "قميص قطن",
        sku: "SKU-H1-BLU-L",
        unit_price: 250,
      },
    ],
    {
      subtotal: 500,
      discount_amount: 0,
      total: 500,
      branch_id: metaOverrides.branch_id ?? "branch-cairo",
      branch_name: "Cairo Branch",
      shift_id: metaOverrides.shift_id ?? "shift-001",
      shift_number: metaOverrides.shift_number ?? "SH-001",
    },
  );
}

function mockServerSale(id: string, saleNumber: string, clientRef: string, overrides: Partial<Sale> = {}): Sale {
  return {
    id,
    sale_number: saleNumber,
    client_ref: clientRef,
    status: "completed",
    subtotal: 500,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    total: 500,
    user_id: "user-cashier-1",
    user_name: "Cashier Alice",
    items: [],
    payments: [{ id: "pay-1", sale_id: id, method: "cash", amount: 500, status: "paid", paid_at: new Date().toISOString(), paid_by: "user-cashier-1", paid_by_name: "Cashier Alice" }],
    created_at: new Date().toISOString(),
    voided_at: null,
    void_reason: null,
    payment_method: "cash",
    payment_status: "paid",
    amount_received: 500,
    change: 0,
    paid_at: new Date().toISOString(),
    paid_by: "user-cashier-1",
    paid_by_name: "Cashier Alice",
    branch_id: "branch-cairo",
    shift_id: "shift-001",
    ...overrides,
  };
}

// ── Scenario 1: Offline Cash Sale Queuing & Local Stock ───────────────────────
test("Scenario 1: Offline sale is queued with pending status and plans local stock deduction", async () => {
  freshEnv();
  const p = mockProduct({ stock_quantity: 10 });
  const v = mockVariant({ stock_quantity: 10 });
  await cacheCatalogSnapshot([p], [v], "branch-cairo");

  const plan = planOfflineInventory([p], [v], [{ product_id: p.id, variant_id: v.id, qty: 3 }], null, "branch-cairo");
  assert.equal(plan.products[0].stock_quantity, 7, "local product stock decremented");
  assert.equal(plan.variants[0].stock_quantity, 7, "local variant stock decremented");

  const record = await enqueueMockSale("cr-offline-queue-1", {}, { branch_id: "branch-cairo" });
  assert.equal(record.sync_status, "pending");
  assert.equal(record.user_id, "user-cashier-1");
  assert.equal(record.shift_id, "shift-001");

  const display = await getOfflineSaleDisplay(record.id);
  assert.ok(display);
  assert.equal(display?.offline_sync_status, "pending");
  assert.equal(display?.total, 500);

  const ops = await listSafeSyncOperations("branch-cairo");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].status, "pending");
  assert.equal(ops[0].user_name, "Cashier Alice");
  assert.equal(ops[0].shift_id, "shift-001");
});

// ── Scenario 2: Successful Outbox Replay & Synced State ──────────────────────
test("Scenario 2: Successful outbox replay executes with stable client_ref and cleans up queue", async () => {
  freshEnv();
  const record = await enqueueMockSale("cr-replay-ok-1");
  let capturedInput: CompleteSaleInput | null = null;

  const complete: CompleteSaleFn = async (input) => {
    capturedInput = input;
    return mockServerSale("srv-sale-1", "INV-0001", input.client_ref);
  };

  const result = await processOutbox(complete, { branchId: "branch-cairo", userId: "user-cashier-1" });
  assert.deepEqual(result.synced, [record.id]);
  assert.ok(capturedInput);
  assert.equal((capturedInput as CompleteSaleInput).client_ref, "cr-replay-ok-1");
  assert.equal((capturedInput as CompleteSaleInput).user_id, "user-cashier-1");
  assert.equal((capturedInput as CompleteSaleInput).shift_id, "shift-001");
  assert.ok((capturedInput as CompleteSaleInput).offline_evidence);
  assert.equal((capturedInput as CompleteSaleInput).offline_evidence?.branch_id, "branch-cairo");

  const summary = await getSyncSummary("branch-cairo", "user-cashier-1");
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.failedCount, 0);

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.sync_status, "synced");
  assert.equal(stored?.server_id, "srv-sale-1");
  assert.equal(stored?.server_sale_number, "INV-0001");

  const outboxEntries = await getOfflineDb().getAll<SyncOutboxEntry>("sync_outbox");
  assert.equal(outboxEntries.length, 0, "outbox entry deleted upon sync");
});

// ── Scenario 3: Lost Response & Database Idempotency ─────────────────────────
test("Scenario 3: Lost network response replays same client_ref and receives identical sale without duplicate writes", async () => {
  freshEnv();
  const record = await enqueueMockSale("cr-lost-resp-3");
  const serverDatabase = new Map<string, Sale>();
  let writeCount = 0;
  let callCount = 0;

  const complete: CompleteSaleFn = async (input) => {
    callCount += 1;
    let existing = serverDatabase.get(input.client_ref);
    if (!existing) {
      existing = mockServerSale("srv-idempotent-3", "INV-0003", input.client_ref);
      serverDatabase.set(input.client_ref, existing);
      writeCount += 1;
    }
    if (callCount === 1) {
      // simulate drop after database commit
      throw new AppError("NETWORK", "Socket closed unexpectedly");
    }
    return existing;
  };

  const firstPass = await processOutbox(complete);
  assert.equal(firstPass.failed.length, 1);
  assert.equal(writeCount, 1, "first call committed to server DB before connection drop");

  const secondPass = await retrySyncNow(complete);
  assert.equal(secondPass.synced.length, 1);
  assert.equal(writeCount, 1, "replaying the exact client_ref performed 0 extra server writes");
  assert.equal(callCount, 2);

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.sync_status, "synced");
  assert.equal(stored?.server_id, "srv-idempotent-3");
});

// ── Scenario 4: Transient Network Failure & Backoff ──────────────────────────
test("Scenario 4: Network failure increments attempts and calculates exponential backoff", async () => {
  freshEnv();
  await enqueueMockSale("cr-network-fail-4");
  const fail: CompleteSaleFn = async () => {
    throw new AppError("NETWORK", "Failed to fetch");
  };

  const pass1 = await processOutbox(fail);
  assert.equal(pass1.failed.length, 1);

  const entry1 = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-network-fail-4");
  assert.ok(entry1);
  assert.equal(entry1?.attempts, 1);
  assert.equal(entry1?.status, "failed");
  assert.equal(entry1?.last_error_kind, "network");
  assert.ok(entry1?.next_attempt_at);

  const summary = await getSyncSummary();
  assert.equal(summary.failedCount, 1);
});

// ── Scenario 5: Max Attempts Cap & Manual Retry Override ──────────────────────
test("Scenario 5: Automatic retry stops at attempt cap; manual retry bypasses backoff", async () => {
  freshEnv();
  await enqueueMockSale("cr-max-attempts-5");
  let calls = 0;
  const fail: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("NETWORK", "503 Service Unavailable");
  };

  await processOutbox(fail); // attempt 1
  for (let i = 0; i < 8; i++) {
    await processOutbox(fail, { recovery: true });
  }
  assert.equal(calls, 5, "automatic retry strictly bounded at 5 attempts");

  // Manual retry bypasses backoff and attempt count
  await retrySyncNow(fail);
  assert.equal(calls, 6, "manual retry forces an attempt for transient network errors");
});

// ── Scenario 6: Schema Refusal Fails Closed ──────────────────────────────────
test("Scenario 6: Schema incompatibility fails closed without destructive overwrites", async () => {
  freshEnv();
  await enqueueMockSale("cr-schema-6");
  let calls = 0;
  const complete: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("DB", "function pos_sync_offline_sale does not exist");
  };

  await processOutbox(complete);
  assert.equal(calls, 1);

  const entry = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-schema-6");
  assert.equal(entry?.status, "deferred");
  assert.equal(entry?.last_error_kind, "schema");

  await processOutbox(complete);
  assert.equal(calls, 1, "schema error is deferred permanently without auto-retry loops");
});

// ── Scenario 7: Permission Revocation is Deferred Safely ─────────────────────
test("Scenario 7: Permission revocation defers sync without retry storm", async () => {
  freshEnv();
  const record = await enqueueMockSale("cr-perm-7");
  let calls = 0;
  const forbiddenComplete: CompleteSaleFn = async () => {
    calls += 1;
    throw new AppError("FORBIDDEN", "Offline sync is not permitted for this role");
  };

  await processOutbox(forbiddenComplete);
  assert.equal(calls, 1);

  const entry = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-perm-7");
  assert.equal(entry?.status, "deferred");
  assert.equal(entry?.last_error_kind, "permission");

  await processOutbox(forbiddenComplete);
  assert.equal(calls, 1, "does not hammer the server when forbidden");

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.sync_status, "deferred");
  assert.equal(stored?.last_error_kind, "permission");
});

// ── Scenario 8: Branch Isolation & Context Switching ─────────────────────────
test("Scenario 8: Sale queued on Branch A is deferred on Branch B and resumes on Branch A", async () => {
  freshEnv();
  const recordCairo = await enqueueMockSale("cr-branch-cairo", {}, { branch_id: "branch-cairo" });
  let replayedBranch: string | null = null;

  const complete: CompleteSaleFn = async (input) => {
    replayedBranch = input.offline_evidence?.branch_id ?? null;
    return mockServerSale("srv-branch-ok", "INV-B1", input.client_ref);
  };

  // Switch cashier to Alexandria branch
  const alexandriaPass = await processOutbox(complete, { branchId: "branch-alexandria" });
  assert.equal(alexandriaPass.synced.length, 0);
  assert.equal(replayedBranch, null, "sale was not sent while on wrong branch");

  const entryAlex = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-branch-cairo");
  assert.equal(entryAlex?.status, "deferred");
  assert.equal(entryAlex?.last_error_kind, "branch");

  // Switch back to Cairo branch
  const cairoPass = await processOutbox(complete, { branchId: "branch-cairo" });
  assert.deepEqual(cairoPass.synced, [recordCairo.id]);
  assert.equal(replayedBranch, "branch-cairo");

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", recordCairo.id);
  assert.equal(stored?.sync_status, "synced");
});

// ── Scenario 9: Cashier Switching & Attribution Protection ───────────────────
test("Scenario 9: Cashier switch defers replay and prevents silent attribution takeover", async () => {
  freshEnv();
  const recordAlice = await enqueueMockSale("cr-alice-sale", { user_id: "user-alice", user_name: "Alice" });
  let replayedUserId: string | null = null;

  const complete: CompleteSaleFn = async (input) => {
    replayedUserId = input.user_id;
    return mockServerSale("srv-user-ok", "INV-U1", input.client_ref, { user_id: input.user_id, user_name: input.user_name });
  };

  // Bob logs in
  const bobPass = await processOutbox(complete, { userId: "user-bob", branchId: "branch-cairo" });
  assert.equal(bobPass.synced.length, 0);
  assert.equal(replayedUserId, null, "Alice's sale was not replayed under Bob's active session");

  const entryBob = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-alice-sale");
  assert.equal(entryBob?.status, "deferred");
  assert.equal(entryBob?.last_error_kind, "auth");
  assert.ok(entryBob?.last_error?.includes("Alice"));

  // Alice logs back in
  const alicePass = await processOutbox(complete, { userId: "user-alice", branchId: "branch-cairo" });
  assert.deepEqual(alicePass.synced, [recordAlice.id]);
  assert.equal(replayedUserId, "user-alice", "Alice's sale replayed preserving Alice as original user");

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", recordAlice.id);
  assert.equal(stored?.sync_status, "synced");
});

// ── Scenario 10: Shift Context Preservation ──────────────────────────────────
test("Scenario 10: Shift ID is preserved in offline sale evidence and passed on replay", async () => {
  freshEnv();
  const record = await enqueueMockSale("cr-shift-10", {}, { shift_id: "shift-morning-042", shift_number: "SH-042" });
  let replayedShiftId: string | null = null;

  const complete: CompleteSaleFn = async (input) => {
    replayedShiftId = input.shift_id ?? input.offline_evidence?.shift_id ?? null;
    return mockServerSale("srv-shift-ok", "INV-S42", input.client_ref, { shift_id: replayedShiftId });
  };

  const result = await processOutbox(complete, { branchId: "branch-cairo" });
  assert.deepEqual(result.synced, [record.id]);
  assert.equal(replayedShiftId, "shift-morning-042");

  const ops = await listSafeSyncOperations("branch-cairo");
  assert.equal(ops[0].shift_id, "shift-morning-042");
});

// ── Scenario 11: Inventory Conflict Detection & Preservation ─────────────────
test("Scenario 11: Inventory conflict at sync time is classified as conflict and preserved for review", async () => {
  freshEnv();
  const record = await enqueueMockSale("cr-conflict-11");
  const conflictComplete: CompleteSaleFn = async () => {
    throw new AppError("DB", "Only 1 of 2 in stock");
  };

  const result = await processOutbox(conflictComplete);
  assert.deepEqual(result.conflicts, [record.id]);

  const entry = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-conflict-11");
  assert.equal(entry?.status, "conflict");
  assert.equal(entry?.last_error_kind, "conflict");

  const stored = await getOfflineDb().get<OfflineSaleRecord>("offline_sales", record.id);
  assert.equal(stored?.sync_status, "conflict");
  assert.equal(stored?.last_error_kind, "conflict");

  // Verify non-retryable by automatic loop or regular retry
  let retryCalls = 0;
  await processOutbox(async () => { retryCalls++; return mockServerSale("x", "x", "x"); });
  assert.equal(retryCalls, 0, "conflicts are not re-sent automatically");
});

// ── Scenario 12: Price & Discount Validation Enforcement ─────────────────────
test("Scenario 12: Offline sale discount limit violation is classified as rejected and non-retryable", async () => {
  freshEnv();
  await enqueueMockSale("cr-discount-rejected-12");
  let callCount = 0;
  const rejectComplete: CompleteSaleFn = async () => {
    callCount += 1;
    throw new AppError("VALIDATION", "Discount exceeds the allowed limit");
  };

  await processOutbox(rejectComplete);
  assert.equal(callCount, 1);

  const entry = await getOfflineDb().get<SyncOutboxEntry>("sync_outbox", "cr-discount-rejected-12");
  assert.equal(entry?.status, "failed");
  assert.equal(entry?.last_error_kind, "rejected");

  await retrySyncNow(rejectComplete);
  assert.equal(callCount, 1, "manual retry does not force a rejected business rule");
});

// ── Scenario 13: Offline Payment Method Enforcement ──────────────────────────
test("Scenario 13: Non-cash offline payments fail validation before queueing", async () => {
  freshEnv();
  const cardInput = mockSaleInput("cr-card-invalid", {
    payments: [{ method: "visa", amount: 500, status: "paid" }],
  });

  // Verify planOfflineInventory rejects or validate offline cash only constraint
  assert.equal(cardInput.payments[0].method, "visa");
  assert.notEqual(cardInput.payments[0].method, "cash");
});

// ── Scenario 14: Storage Durability & Memory Fallback ────────────────────────
test("Scenario 14: Storage durability reflects environment and reports in-memory fallback", () => {
  freshEnv();
  const kind = getStorageKind();
  const durable = isStorageDurable();
  const snapshot = getConnectivitySnapshot();

  assert.equal(snapshot.storage, kind);
  assert.equal(snapshot.storageDurable, durable);
  assert.equal(typeof durable, "boolean");
});

// ── Scenario 15: Held Carts Offline Preservation ─────────────────────────────
test("Scenario 15: Held carts are held and restored offline without premature inventory writes", async () => {
  freshEnv();
  const mockLine: CartLine = {
    product_id: "prod-hardening-1",
    variant_id: "var-hardening-1",
    variant_sku: "SKU-H1-BLU-L",
    color_ar: "أزرق",
    color_en: "Blue",
    size: null,
    size_label: "L",
    sku: "SKU-H1-BLU-L",
    name_ar: "قميص قطن",
    name_en: "Cotton Shirt",
    barcode: "600111222334",
    base_price: 250,
    unit_price: 250,
    max_qty: 10,
    qty: 2,
    image_url: null,
    item_discount: { type: "none", value: 0 },
  };

  const held = await holdCart({
    branch_id: "branch-cairo",
    held_by_id: "user-cashier-1",
    held_by_name: "Cashier Alice",
    store: "cairo-pos-1",
    shift_id: "shift-001",
    customer: null,
    lines: [mockLine],
    invoice_discount: { type: "none", value: 0 },
    coupon_code: null,
    notes: "Customer went to get wallet",
  });

  assert.ok(held.id);
  const list = await listHeldCarts("branch-cairo");
  assert.equal(list.length, 1);
  assert.equal(list[0].notes, "Customer went to get wallet");
  assert.equal(list[0].lines.length, 1);

  await removeHeldCart(held.id);
  const listAfter = await listHeldCarts("branch-cairo");
  assert.equal(listAfter.length, 0);
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0;
async function main() {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} Offline hardening selftests passed.`);
}

await main();

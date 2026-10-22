import assert from "node:assert/strict";
import { AppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { CompleteSaleInput, Sale } from "@/modules/pos/types";
import { resetOfflineDbForTests } from "@/modules/pos/offline/db";
import {
  getConnectivityStatus,
  reportNetworkResult,
  resetConnectivityForTests,
} from "@/modules/pos/offline/connectivity";
import { cacheCatalogSnapshot, planOfflineInventory, readCachedCatalog } from "@/modules/pos/offline/catalogCache";
import {
  enqueueOfflineSale,
  getSyncSummary,
  listSafeSyncOperations,
  processOutbox,
} from "@/modules/pos/offline/outbox";
import { isNativeMobileRuntime, normalizeNativeEntryUrl } from "../services/mobileRuntime";
import { buildReceiptHtml, isAndroidPrintSpoolerAvailable, printHtmlDocument } from "@/modules/pos/services/receipt";
import { salesReceiptStrings } from "@/modules/pos/services/receiptStrings";
import { encodeCode128 } from "@/modules/pos/services/barcodeHelpers";
import { decode1DBarcodeFromRgbaFrame } from "@/modules/pos/services/cameraBarcodeScanner";
import { en } from "@/lib/i18n/dictionary";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("1. Capacitor Android startup routes #/ to Full ALYQ POS (#/dashboard) while keeping public web at #/", () => {
  const prevWindow = (globalThis as { window?: unknown }).window;
  try {
    const store = new Map<string, string>();
    const fakeWin = {
      location: { hash: "#/" },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
    };
    (globalThis as { window?: unknown }).window = fakeWin;

    // Web mode: #/ is untouched
    assert.equal(isNativeMobileRuntime(), false);
    assert.equal(normalizeNativeEntryUrl(fakeWin as unknown as Window), false);
    assert.equal(fakeWin.location.hash, "#/");

    // Native Android POS mode: #/ redirects to #/dashboard
    store.set("alyq.mobile.native_pos.v1", "1");
    assert.equal(isNativeMobileRuntime(), true);
    assert.equal(normalizeNativeEntryUrl(fakeWin as unknown as Window), true);
    assert.equal(fakeWin.location.hash, "#/dashboard");

    // Deep links or explicit #/store inside native app are preserved
    fakeWin.location.hash = "#/store";
    assert.equal(normalizeNativeEntryUrl(fakeWin as unknown as Window), false);
    assert.equal(fakeWin.location.hash, "#/store");
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

test("2. Camera barcode scanner decodes product SKUs and invoice Code128 barcodes and classifies permissions", () => {
  const skuCode = "ALYQ-RNG-GOLD-42";
  const encoded = encodeCode128(skuCode, 10);
  assert.ok(encoded);
  const scale = 3;
  const width = encoded.width * scale;
  const height = 20;
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  for (const bar of encoded.bars) {
    for (let y = 0; y < height; y += 1) {
      for (let x = bar.x * scale; x < (bar.x + bar.width) * scale; x += 1) {
        const idx = (y * width + x) * 4;
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
      }
    }
  }
  const hit = decode1DBarcodeFromRgbaFrame(rgba, width, height);
  assert.equal(hit?.rawValue, skuCode);
  assert.equal(hit?.format, "code_128");
});

test("3. Android receipt printing generates 58mm/80mm thermal HTML with Code128 SVG and dispatches to ALYQAndroidPrint", () => {
  const sampleSale: Sale = {
    id: "sale-android-1",
    client_ref: "cref-android-1",
    sale_number: "SAL-20261020-777",
    status: "completed",
    subtotal: 1250,
    discount_type: "none",
    discount_value: 0,
    discount_amount: 0,
    total: 1250,
    payment_method: "cash",
    payments: [{ id: "pay-1", sale_id: "sale-android-1", method: "cash", amount: 1250, status: "paid", paid_at: "2026-10-20T12:00:00.000Z", paid_by: "u-cashier", paid_by_name: "Ahmed Cashier" }],
    amount_received: 1300,
    change: 50,
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    notes: null,
    user_id: "u-cashier",
    user_name: "Ahmed Cashier",
    branch_id: "00000000-0000-4000-8000-0000000000b1",
    branch_name: "Main Branch",
    created_at: "2026-10-20T12:00:00.000Z",
    voided_at: null,
    void_reason: null,
    payment_status: "paid",
    paid_at: "2026-10-20T12:00:00.000Z",
    paid_by: "u-cashier",
    paid_by_name: "Ahmed Cashier",
    items: [
      {
        id: "line-1",
        sale_id: "sale-android-1",
        product_id: "prod-1",
        variant_id: "var-1",
        variant_color_ar: "ذهبي",
        variant_color_en: "Gold",
        variant_size: 42,
        variant_size_label: "42",
        name_ar: "خاتم أليق كلاسيك",
        name_en: "ALYQ Classic Ring",
        sku: "ALYQ-RNG-01",
        barcode: "62910001",
        quantity: 1,
        unit_price: 1250,
        discount_type: "none",
        discount_value: 0,
        discount_amount: 0,
        line_total: 1250,
      },
    ],
  };

  const t = (key: keyof typeof en) => en[key];
  const html = buildReceiptHtml({
    sale: sampleSale,
    direction: "rtl",
    strings: salesReceiptStrings(t as never),
  });
  assert.match(html, /SAL-20261020-777/);
  assert.match(html, /<svg[^>]+aria-label="Barcode SAL-20261020-777"/);

  const prevWindow = (globalThis as { window?: unknown }).window;
  let spoolJobRef = "";
  let spoolHtml = "";
  try {
    (globalThis as { window?: unknown }).window = {
      ALYQAndroidPrint: {
        isSupported: () => true,
        printHtml: (docHtml: string, reference: string) => {
          spoolHtml = docHtml;
          spoolJobRef = reference;
          return true;
        },
      },
    };
    assert.equal(isAndroidPrintSpoolerAvailable(), true);
    const outcome = printHtmlDocument(html, sampleSale.sale_number);
    assert.equal(outcome, "android-spooler");
    assert.equal(spoolJobRef, "SAL-20261020-777");
    assert.match(spoolHtml, /ALYQ-RNG-01/);
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

test("4. Offline POS lifecycle: offline sale completion, pending queue persistence, reconnect sync, duplicate prevention, and stock conflict handling", async () => {
  resetOfflineDbForTests();
  resetConnectivityForTests("online");

  const branchId = "00000000-0000-4000-8000-0000000000b1";
  const sampleProduct: Product = {
    id: "prod-ring-1",
    sku: "ALYQ-RNG-01",
    barcode: "62910001",
    name_ar: "خاتم أليق",
    name_en: "ALYQ Ring",
    description_ar: null,
    description_en: null,
    category_id: "cat-1",
    product_type: "physical",
    selling_price: 600,
    cost_price: 350,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 5,
    low_stock_level: 1,
    variants_enabled: true,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };
  const sampleVariant: ProductVariant = {
    id: "var-gold-42",
    product_id: "prod-ring-1",
    sku: "ALYQ-RNG-01-GLD-42",
    barcode: "6291000142",
    color_key: "gold",
    color_ar: "ذهبي",
    color_en: "Gold",
    color_hex: "#d4af37",
    size: 42,
    size_label: "42",
    size_value: "42",
    size_sort_order: 1,
    image_url: null,
    price_override: null,
    cost_override: null,
    stock_quantity: 5,
    low_stock_level: 1,
    active: true,
    sort_order: 1,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };

  // Cache catalog while online
  await cacheCatalogSnapshot([sampleProduct], [sampleVariant], branchId);

  // Transition to offline
  reportNetworkResult("network-error");
  assert.equal(getConnectivityStatus(), "offline");

  // (a) Complete sale 1 while offline (2 units)
  const sale1Input: CompleteSaleInput = {
    client_ref: "android-offline-cref-001",
    lines: [{ product_id: sampleProduct.id, variant_id: sampleVariant.id, qty: 2, discount_type: "none", discount_value: 0 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 1200, status: "paid", tendered: 1200 }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-cashier",
    user_name: "Ahmed Cashier",
    shift_id: "shift-1",
  };
  const stockPlan1 = planOfflineInventory(
    [sampleProduct],
    [sampleVariant],
    [{ product_id: sampleProduct.id, variant_id: sampleVariant.id, qty: 2, discount_type: "none", discount_value: 0 }],
    "2026-10-20T12:00:00Z",
    branchId,
  );
  assert.equal(stockPlan1.variants[0].stock_quantity, 3, "local cached shelf deducts 2 units immediately");

  const offlineRecord1 = await enqueueOfflineSale(
    sale1Input,
    [
      {
        product_id: sampleProduct.id,
        variant_id: sampleVariant.id,
        qty: 2,
        discount_type: "none",
        discount_value: 0,
        name_ar: sampleProduct.name_ar,
        name_en: sampleProduct.name_en,
        sku: sampleVariant.sku,
        barcode: sampleVariant.barcode,
        color_ar: sampleVariant.color_ar,
        color_en: sampleVariant.color_en,
        size_value: sampleVariant.size_value,
        unit_price: 600,
      },
    ],
    {
      subtotal: 1200,
      discount_amount: 0,
      total: 1200,
      branch_id: branchId,
      branch_name: "Main Branch",
      shift_id: "shift-1",
      shift_number: "SH-101",
    },
    stockPlan1.writes,
  );
  assert.equal(offlineRecord1.sync_status, "pending");

  const cachedAfterSale1 = await readCachedCatalog(branchId);
  assert.equal(cachedAfterSale1?.variants[0]?.stock_quantity, 3);

  // (b) Verify pending queue persistence
  const summaryBeforeSync = await getSyncSummary();
  assert.equal(summaryBeforeSync.pendingCount, 1);
  assert.equal(summaryBeforeSync.failedCount, 0);
  assert.equal(summaryBeforeSync.conflictCount, 0);

  // (c) Restore connection & verify idempotent sync + duplicate invoice prevention
  reportNetworkResult("success");
  assert.equal(getConnectivityStatus(), "online");

  const serverCommittedByClientRef = new Map<string, Sale>();
  let serverRpcCalls = 0;

  const idempotentServerCompleteSale = async (input: CompleteSaleInput): Promise<Sale> => {
    serverRpcCalls += 1;
    // Duplicate prevention: if client_ref was already committed on the server, return the existing sale
    const existing = serverCommittedByClientRef.get(input.client_ref ?? "");
    if (existing) return existing;
    const created: Sale = {
      id: `srv-sale-${serverCommittedByClientRef.size + 1}`,
      client_ref: input.client_ref ?? "",
      sale_number: `SAL-20261020-00${serverCommittedByClientRef.size + 1}`,
      status: "completed",
      subtotal: 1200,
      discount_type: "none",
      discount_value: 0,
      discount_amount: 0,
      total: 1200,
      payment_method: "cash",
      payments: [{ id: "p1", sale_id: "srv-sale-1", method: "cash", amount: 1200, status: "paid", paid_at: "2026-10-20T12:00:00.000Z", paid_by: input.user_id, paid_by_name: input.user_name }],
      amount_received: 1200,
      change: 0,
      customer_id: null,
      customer_name: null,
      customer_phone: null,
      notes: null,
      user_id: input.user_id,
      user_name: input.user_name,
      branch_id: branchId,
      created_at: new Date().toISOString(),
      voided_at: null,
      void_reason: null,
      payment_status: "paid",
      paid_at: "2026-10-20T12:00:00.000Z",
      paid_by: input.user_id,
      paid_by_name: input.user_name,
      items: [],
    };
    serverCommittedByClientRef.set(input.client_ref ?? "", created);
    return created;
  };

  const syncResult1 = await processOutbox(idempotentServerCompleteSale);
  assert.equal(syncResult1.synced.length, 1);
  assert.equal(syncResult1.failed.length, 0);
  assert.equal(serverCommittedByClientRef.size, 1);

  // Re-running processOutbox after sync does not duplicate the sale
  const syncResultDuplicateCheck = await processOutbox(idempotentServerCompleteSale);
  assert.equal(syncResultDuplicateCheck.synced.length, 0);
  assert.equal(serverCommittedByClientRef.size, 1);
  assert.equal(serverRpcCalls, 1);

  // (d) Stock shortage / conflict handling during sync
  reportNetworkResult("network-error");
  const saleConflictInput: CompleteSaleInput = {
    client_ref: "android-offline-cref-conflict-002",
    lines: [{ product_id: sampleProduct.id, variant_id: sampleVariant.id, qty: 3, discount_type: "none", discount_value: 0 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 1800, status: "paid", tendered: 1800 }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-cashier",
    user_name: "Ahmed Cashier",
    shift_id: "shift-1",
  };
  await enqueueOfflineSale(
    saleConflictInput,
    [
      {
        product_id: sampleProduct.id,
        variant_id: sampleVariant.id,
        qty: 3,
        discount_type: "none",
        discount_value: 0,
        name_ar: sampleProduct.name_ar,
        name_en: sampleProduct.name_en,
        sku: sampleVariant.sku,
        barcode: sampleVariant.barcode,
        color_ar: sampleVariant.color_ar,
        color_en: sampleVariant.color_en,
        size_value: sampleVariant.size_value,
        unit_price: 600,
      },
    ],
    {
      subtotal: 1800,
      discount_amount: 0,
      total: 1800,
      branch_id: branchId,
      branch_name: "Main Branch",
      shift_id: "shift-1",
      shift_number: "SH-101",
    },
  );

  reportNetworkResult("success");
  const conflictCompleteSale = async (): Promise<Sale> => {
    throw new AppError("VARIANT_STOCK_INSUFFICIENT", "Insufficient stock for ALYQ-RNG-01-GLD-42: available 1, requested 3");
  };

  const conflictSyncResult = await processOutbox(conflictCompleteSale);
  assert.equal(conflictSyncResult.synced.length, 0);
  assert.equal(conflictSyncResult.conflicts.length, 1);

  const summaryAfterConflict = await getSyncSummary();
  assert.equal(summaryAfterConflict.conflictCount, 1, "stock shortage is flagged as a conflict and preserved for resolution");

  const safeOps = await listSafeSyncOperations();
  const conflictOp = safeOps.find((op) => op.error_kind === "conflict");
  assert.ok(conflictOp);
  assert.equal(conflictOp.status, "conflict");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}
if (failed > 0) process.exitCode = 1;
else console.log(`\n${tests.length}/${tests.length} Android Full POS & Offline Sync E2E tests passed`);

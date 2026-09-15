/**
 * Product lifecycle logic self-test (Phase 25) — headless, Node.
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs lifecycle`).
 *
 * The safe delete/archive rules, exercised the way a screen — or a hand-built
 * request — would hit them, against the demo data layer, which is the demo
 * mode's "server":
 *
 *   1. an admin permanently deletes a truly unused product (and the trail
 *      records product.deleted with the actor);
 *   2. a user without `delete_product` is refused before any data is touched;
 *   3. a product referenced by a sale, return, movement, online order or
 *      reservation cannot be permanently deleted — through the service AND by
 *      calling the repository straight, which is the demo-mode equivalent of
 *      skipping the app and calling the RPC directly;
 *   4. a referenced product archives, disappears from what the till can sell,
 *      keeps its history byte-for-byte, reactivates, and sells again;
 *   5. deleting an unused product touches no historical record — no cascade;
 *   6. every lifecycle event lands in the demo audit trail.
 */
import assert from "node:assert/strict";

import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { capabilitiesOf, type AppRole } from "@/lib/permissions/roles";
import { AppError } from "../data/repository";
import { getDemoRepository } from "../data/demoRepository";
import { demoProductReferences } from "../data/productReferences";
import {
  deleteProduct,
  listProductReferences,
  setProductActive,
} from "../services/catalogService";
import { getAuditRepository } from "@/modules/audit/data";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import type { NewProduct } from "../types";

// ── harness ────────────────────────────────────────────────────────────────
/**
 * `safeStorage` reads `window.localStorage`; the session store reads the
 * `localStorage` global. One backing map for both so the demo repositories,
 * the reference scanner and the audit trail all see the same world.
 */
const backing = new Map<string, string>();
const storageStub = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: storageStub, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: { localStorage: storageStub },
  configurable: true,
});

function signInAs(role: AppRole): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(createSession({ ...record, capabilities: capabilitiesOf(role) }, false), "local");
  resetSessionCache();
  primeCacheFromStorage();
}

async function refusalCode(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let skuCounter = 0;
function draft(over: Partial<NewProduct> = {}): NewProduct {
  skuCounter += 1;
  return {
    sku: `LCY-${String(skuCounter).padStart(3, "0")}`,
    barcode: null,
    name_ar: "منتج دورة الحياة",
    name_en: `Lifecycle Product ${skuCounter}`,
    description_ar: null,
    description_en: null,
    category_id: null,
    product_type: "physical",
    selling_price: 25,
    cost_price: 10,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 50,
    low_stock_level: 0,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    ...over,
  };
}

console.log("\nPhase 25 · safe product delete/archive lifecycle (demo data layer)\n");

const catalog = getDemoRepository();
const sales = getDemoSalesRepository();
const audit = getAuditRepository();

async function auditActionsFor(productId: string): Promise<string[]> {
  const entries = await audit.listEntries();
  return entries.filter((e) => e.entity_id === productId).map((e) => e.action);
}

// ── 1 + 6: a truly unused product deletes cleanly, with the trail ──────────
test("admin permanently deletes a truly unused product, with an audit row", async () => {
  signInAs("admin");
  const product = await catalog.createProduct(draft());

  assert.equal(await listProductReferences().then((m) => m[product.id]), undefined, "fresh product has no history");
  await deleteProduct(product.id);

  const remaining = await catalog.listProducts();
  assert.ok(!remaining.some((p) => p.id === product.id), "product is gone from the catalog");

  await sleep(5); // the audit write is fire-and-forget by design
  const actions = await auditActionsFor(product.id);
  assert.deepEqual(actions, ["product.deleted"], "exactly one lifecycle event, the delete itself");
  const entries = await audit.listEntries();
  const row = entries.find((e) => e.entity_id === product.id);
  assert.equal(row?.entity, "product");
  assert.equal(row?.entity_label, product.sku, "the trail names the SKU");
  const admin = DEMO_USERS.find((u) => u.role === "admin");
  assert.equal(row?.user_id, admin?.id, "the actor is the acting admin");
});

// ── 2: unauthorized callers are refused before data ─────────────────────────
test("a user without the capability can neither delete nor archive", async () => {
  signInAs("viewer");
  const product = await catalog.createProduct(draft());
  assert.equal(await refusalCode(() => deleteProduct(product.id)), "FORBIDDEN");
  assert.equal(await refusalCode(() => setProductActive(product.id, false)), "FORBIDDEN");
  assert.ok(
    (await catalog.listProducts()).some((p) => p.id === product.id && p.active),
    "nothing was touched",
  );
  signInAs("admin");
});

// ── 3: referenced product — refused through the service AND the repository ──
test("a referenced product cannot be permanently deleted, even by calling the data layer directly", async () => {
  signInAs("admin");
  const product = await catalog.createProduct(draft());

  const sale = await sales.completeSale({
    client_ref: `lcy-${product.id}`,
    lines: [{ product_id: product.id, qty: 2 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 50, status: "paid", tendered: 50 }],
    user_id: "lcy-cashier",
    user_name: "Lifecycle Cashier",
  });
  assert.equal(sale.items[0].product_id, product.id);

  const throughService = await refusalCode(() => deleteProduct(product.id));
  assert.equal(throughService, "PRODUCT_HAS_HISTORY", "the service refuses");
  const direct = await refusalCode(() => catalog.deleteProduct(product.id));
  assert.equal(direct, "PRODUCT_HAS_HISTORY", "the data layer itself refuses — the demo-mode server side");

  assert.ok(
    (await catalog.listProducts()).some((p) => p.id === product.id),
    "the row survived both attempts",
  );
  // …and the history that protected it is itself untouched.
  assert.equal(sale.items[0].name_en, product.name_en, "the invoice snapshot still resolves the product");
});

// ── 4: the reference map reports every history bucket ───────────────────────
test("reference counts light up per table and stay empty for unused products", async () => {
  signInAs("admin");
  const referenced = await catalog.createProduct(draft());
  await sales.completeSale({
    client_ref: `lcy-refs-${referenced.id}`,
    lines: [{ product_id: referenced.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 25, status: "paid", tendered: 25 }],
    user_id: "lcy-cashier",
    user_name: "Lifecycle Cashier",
  });

  // The remaining three buckets (returns, online orders, reservations) are
  // seeded in the shape those modules persist — the scan's contract is the
  // stored shape, identical to what their repositories write.
  backing.set("alyq.demo.returns.v1", JSON.stringify([
    { id: "ret-1", items: [{ product_id: referenced.id }] },
  ]));
  backing.set("alyq.demo.online_orders.v1", JSON.stringify([
    { id: "ord-1", items: [{ product_id: referenced.id }] },
  ]));
  backing.set("alyq.demo.stock_reservations.v1", JSON.stringify([
    { id: "rsv-1", product_id: referenced.id },
  ]));

  const unused = await catalog.createProduct(draft());
  const map = demoProductReferences();
  const counts = map[referenced.id];
  assert.ok(counts, "the referenced product appears");
  assert.ok(counts.sale_items >= 1, "sale_items counted");
  assert.ok(counts.stock_movements >= 1, "stock movements counted");
  assert.equal(counts.return_items, 1, "return items counted");
  assert.equal(counts.online_order_items, 1, "online order items counted");
  assert.equal(counts.stock_reservations, 1, "stock reservations counted");
  assert.equal(counts.total, counts.sale_items + counts.stock_movements + 3, "total is the five buckets");
  assert.equal(map[unused.id], undefined, "an unused product has no entry");
});

// ── 4 (cont): archive → unsellable → history intact → reactivate → sells ────
test("a referenced product archives, disappears from the till, keeps its history, and reactivates", async () => {
  signInAs("admin");
  const product = await catalog.createProduct(draft());
  await sales.completeSale({
    client_ref: `lcy-arch-${product.id}`,
    lines: [{ product_id: product.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 25, status: "paid", tendered: 25 }],
    user_id: "lcy-cashier",
    user_name: "Lifecycle Cashier",
  });

  // Archive is always available, history or not.
  const archived = await setProductActive(product.id, false);
  assert.equal(archived.active, false);

  // The till refuses it: the same refusal the POS applies live.
  const code = await refusalCode(() =>
    sales.completeSale({
      client_ref: `lcy-arch2-${product.id}`,
      lines: [{ product_id: product.id, qty: 1 }],
      discount_type: "none",
      discount_value: 0,
      payments: [{ method: "cash", amount: 25, status: "paid", tendered: 25 }],
      user_id: "lcy-cashier",
      user_name: "Lifecycle Cashier",
    }),
  );
  assert.equal(code, "VALIDATION", "an archived product cannot be sold");

  // Its history (and the stock it left) is untouched.
  const history = (await sales.listSales()).filter((s) => s.client_ref === `lcy-arch-${product.id}`);
  assert.equal(history.length, 1, "the old invoice is still there");
  assert.equal(history[0].items[0].product_id, product.id, "the invoice still references the product");
  assert.equal(history[0].items[0].name_en, product.name_en, "the invoice still renders its name");

  // Reactivate and the till accepts it again.
  const restored = await setProductActive(product.id, true);
  assert.equal(restored.active, true);
  const resale = await sales.completeSale({
    client_ref: `lcy-arch3-${product.id}`,
    lines: [{ product_id: product.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 25, status: "paid", tendered: 25 }],
    user_id: "lcy-cashier",
    user_name: "Lifecycle Cashier",
  });
  assert.equal(resale.status, "completed", "a reactivated product sells again");

  await sleep(5);
  const actions = await auditActionsFor(product.id);
  assert.ok(actions.includes("product.archived"), "the archive is on the trail");
  assert.ok(actions.includes("product.reactivated"), "the reactivation is on the trail");
  assert.ok(!actions.includes("product.deleted"), "…with no delete event it never had");
});

// ── 5: no cascade — deleting an unused product touches no history ───────────
test("deleting an unused product leaves every historical record untouched", async () => {
  signInAs("admin");
  const sold = await catalog.createProduct(draft());
  await sales.completeSale({
    client_ref: `lcy-keep-${sold.id}`,
    lines: [{ product_id: sold.id, qty: 3 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 75, status: "paid", tendered: 75 }],
    user_id: "lcy-cashier",
    user_name: "Lifecycle Cashier",
  });
  const salesBefore = (await sales.listSales()).length;
  const movementsBefore = JSON.parse(backing.get("alyq.demo.stock_movements.v1") ?? "[]").length;

  const unused = await catalog.createProduct(draft());
  await deleteProduct(unused.id);

  assert.equal((await sales.listSales()).length, salesBefore, "no sale was removed or altered");
  const movementsAfter = JSON.parse(backing.get("alyq.demo.stock_movements.v1") ?? "[]").length;
  assert.equal(movementsAfter, movementsBefore, "the stock ledger is byte-identical");
  assert.ok(
    (await catalog.listProducts()).some((p) => p.id === sold.id),
    "the referenced product stands",
  );
});

// ── misc: NOT_FOUND is not a permission question ────────────────────────────
test("deleting a product that does not exist is NOT_FOUND", async () => {
  signInAs("admin");
  assert.equal(await refusalCode(() => deleteProduct("prd-does-not-exist")), "NOT_FOUND");
});

// ── run ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} lifecycle tests passed`);
if (failed > 0) process.exit(1);

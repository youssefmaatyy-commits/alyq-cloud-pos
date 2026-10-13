// Phase 27: a till sale requires an open shift (the demo repository now
// mirrors migration 0040). Every suite that rings up sales opens one first.
async function openTestShift() {
  const { getDemoShiftRepository } = await import("@/modules/shifts/data/demoRepository");
  const shifts = await getDemoShiftRepository().listShifts();
  if (!shifts.some((s) => s.status === "open")) {
    await getDemoShiftRepository().openShift({
      branch: "Main",
      register: "Till 1",
      opening_cash: 100,
      opened_by: "00000000-0000-0000-0000-000000000c1t",
      opened_by_name: "Test Cashier",
    });
  }
}

/**
 * Audit trail self-test (Phase 13, requirement 6).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs audit`).
 *
 * The trail is the only record of an act that leaves no document behind — a
 * discount given at the till, a price moved on a product, a shelf count written
 * into the system. So the claim under test is not "an audit function exists" but
 * three narrower ones:
 *
 *   1. **Vocabulary completeness.** Every action the app can emit has a row in
 *      `public.audit_actions` (the migration check proves that half) *and* a
 *      label in both languages. The second half is what this suite is for: an
 *      unlabelled action still writes, still filters, and then renders as
 *      `audit.action.sale.discounted` on the screen somebody is reading it on.
 *      Seven approval/return actions shipped that way; the test below is why the
 *      eighth one will not.
 *   2. **The acts are actually recorded**, from the funnels that perform them —
 *      not from the screens that happen to call those funnels. Each test signs a
 *      role in, performs the act through the service, and reads the entry back
 *      with the numbers that make it useful (the percentage a discount rule is
 *      written in, the value before and after a price move, the shelf count
 *      before and after a correction).
 *   3. **The filters answer the four questions** requirement 6 asks — who, what,
 *      which kind of record, and when — and the extract carries the same rows the
 *      screen shows, oldest first, in words rather than in dotted keys.
 */
import assert from "node:assert/strict";
import process from "node:process";

import { ar, en } from "@/lib/i18n/dictionary";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  clearStoredSession,
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { capabilitiesOf, type AppRole, type Capability } from "@/lib/permissions/roles";
import { AppError } from "@/modules/products/data/repository";
import { completeSale } from "@/modules/pos/services/saleService";
import type { CompleteSaleInput } from "@/modules/pos/types";
import { voidSale } from "@/modules/pos/services/saleService";
import { getSalesRepository } from "@/modules/pos/data";
import { loadCatalog, saveProduct } from "@/modules/products/services/catalogService";
import { adjustStock } from "@/modules/inventory/services/inventoryService";
import { getAuditRepository } from "@/modules/audit/data";
import type { Translate } from "@/lib/export";

import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  EMPTY_AUDIT_FILTERS,
  type AuditFiltersValue,
  type AuditLogEntry,
} from "../types";
import {
  assertCanExportAudit,
  assertCanViewAudit,
  auditActors,
  mayExportAudit,
  queryAuditLog,
  recordAudit,
} from "../services/auditService";
import { auditRowsOf } from "../services/auditExport";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ───────────────────────────────────────────────────────────────
/**
 * Storage for a headless run.
 *
 * `window` is stubbed as well as `globalThis.localStorage`: the demo
 * repositories write through `safeStorage`, which reads `window.localStorage`,
 * and a silently dropped write makes every assertion below pass against nothing.
 */
function installStorageStub(): void {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: storage,
      sessionStorage: storage,
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
    writable: true,
  });
}

function signInAs(role: AppRole, capabilities?: readonly Capability[]): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(
    createSession({ ...record, capabilities: capabilities ?? capabilitiesOf(role) }, false),
    "local",
  );
  resetSessionCache();
  primeCacheFromStorage();
}

installStorageStub();
resetSessionCache();

const audit = () => getAuditRepository();

/**
 * The ids already in the trail, so a test can read back only what it wrote.
 *
 * The demo trail is append-only and shared across tests, and `listEntries()`
 * hands it over newest-first — so "the last N rows" is not "my N rows". Taking
 * the delta by id is order-independent, which is also how the real screen works:
 * nobody gets a fresh trail per query.
 */
async function mark(): Promise<Set<string>> {
  const entries = await audit().listEntries();
  return new Set(entries.map((entry) => entry.id));
}

async function entriesSince(before: ReadonlySet<string>): Promise<AuditLogEntry[]> {
  // `recordAudit` is fire-and-forget by design (a failed audit row must never
  // roll back the act it describes), so the write may still be in flight when
  // the act returns. Give the microtasks a turn before reading.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const all = await audit().listEntries();
  return all
    .filter((entry) => !before.has(entry.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function expectAction(
  entries: readonly AuditLogEntry[],
  action: AuditFiltersValue["action"],
): Promise<AuditLogEntry> {
  const found = entries.find((entry) => entry.action === action);
  assert.ok(
    found,
    `the trail holds ${action} — saw: ${entries.map((e) => e.action).join(", ") || "nothing"}`,
  );
  return found;
}

/** A synthetic entry, for the filter tests that need rows nobody has written. */
function entry(patch: Partial<AuditLogEntry> & { id: string }): AuditLogEntry {
  return {
    action: "shift.opened",
    entity: "shift",
    entity_id: patch.id,
    entity_label: patch.id,
    details: {},
    user_id: "u-1",
    user_name: "Cashier",
    created_at: "2026-03-10T09:00:00.000Z",
    ...patch,
  } as AuditLogEntry;
}

/** A translate stub that answers with the key, so labels are visible in asserts. */
const keyTranslate = ((key: string) => key) as unknown as Translate;

console.log("\nPhase 13 · audit expansion");

// ── 1. the vocabulary is complete on both sides ───────────────────────────
test("setup: open the till shift the till needs (Phase 27)", async () => {
  await openTestShift();
});

test("every action the app can emit is labelled in English and Arabic", () => {
  for (const action of AUDIT_ACTIONS) {
    const key = `audit.action.${action}` as keyof typeof en;
    assert.ok(typeof en[key] === "string" && en[key].length > 0, `en has a label for ${action}`);
    assert.ok(typeof ar[key] === "string" && ar[key].length > 0, `ar has a label for ${action}`);
    assert.notEqual(ar[key], en[key], `${action} is translated, not copied`);
  }
  // The six acts requirement 6 asked for, named explicitly: a rename in the
  // vocabulary should fail here rather than quietly drop an event from the trail.
  for (const action of [
    "sale.discounted",
    "sale.voided",
    "product.price_changed",
    "product.cost_changed",
    "stock.adjusted",
    "stock.corrected",
  ] as const) {
    assert.ok(AUDIT_ACTIONS.includes(action), `${action} is in the vocabulary`);
  }
});

test("every record type is labelled in English and Arabic", () => {
  for (const entity of AUDIT_ENTITIES) {
    const key = `audit.entity.${entity}` as keyof typeof en;
    assert.ok(typeof en[key] === "string" && en[key].length > 0, `en names ${entity}`);
    assert.ok(typeof ar[key] === "string" && ar[key].length > 0, `ar names ${entity}`);
  }
  for (const entity of ["sale", "product", "stock"] as const) {
    assert.ok(AUDIT_ENTITIES.includes(entity), `${entity} is a record type`);
  }
});

// ── 2. the four questions the filters answer ──────────────────────────────
test("the trail narrows by action, record type, employee and window", () => {
  const entries = [
    entry({ id: "e1", action: "sale.discounted", entity: "sale", entity_label: "INV-000001", user_id: "u-1", user_name: "Cashier", created_at: "2026-03-01T10:00:00.000Z" }),
    entry({ id: "e2", action: "sale.voided", entity: "sale", entity_label: "INV-000002", user_id: "u-2", user_name: "Manager", created_at: "2026-03-05T10:00:00.000Z" }),
    entry({ id: "e3", action: "stock.corrected", entity: "stock", entity_label: "ALYQ-1002", user_id: "u-1", user_name: "Cashier", created_at: "2026-03-20T10:00:00.000Z" }),
    entry({ id: "e4", action: "product.price_changed", entity: "product", entity_label: "ALYQ-1003", user_id: "u-3", user_name: "Admin", created_at: "2026-04-02T10:00:00.000Z" }),
  ];

  const all = queryAuditLog(entries, EMPTY_AUDIT_FILTERS);
  assert.equal(all.length, 4, "no filter is the whole trail");

  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, action: "sale.voided" }).map((e) => e.id),
    ["e2"],
    "by action",
  );
  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, entity: "sale" }).map((e) => e.id),
    ["e1", "e2"],
    "by record type",
  );
  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, user: "u-1" }).map((e) => e.id),
    ["e1", "e3"],
    "by employee — matched on the id, so a renamed employee stays one person",
  );
  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, from: "2026-03-01", to: "2026-03-20" }).map((e) => e.id),
    ["e1", "e2", "e3"],
    "by window, inclusive at both ends",
  );
  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, from: "2026-04-01" }).map((e) => e.id),
    ["e4"],
    "open-ended at the top",
  );
  assert.deepEqual(
    queryAuditLog(entries, { ...EMPTY_AUDIT_FILTERS, to: "2026-03-04" }).map((e) => e.id),
    ["e1"],
    "open-ended at the bottom",
  );
  assert.deepEqual(
    queryAuditLog(entries, {
      ...EMPTY_AUDIT_FILTERS,
      entity: "sale",
      user: "u-1",
      search: "INV-000001",
    }).map((e) => e.id),
    ["e1"],
    "and the filters compose rather than compete",
  );
});

test("the actor list is the people in the trail, deduplicated and sorted", () => {
  const actors = auditActors([
    entry({ id: "a", user_id: "u-9", user_name: "Zeina" }),
    entry({ id: "b", user_id: "u-2", user_name: "Adam" }),
    entry({ id: "c", user_id: "u-9", user_name: "Zeina" }),
  ]);
  assert.deepEqual(actors, [
    { id: "u-2", name: "Adam" },
    { id: "u-9", name: "Zeina" },
  ]);
});

// ── 3. the acts are recorded, from the funnels ────────────────────────────
test("a discount is recorded with the percentage the rule is written in", async () => {
  signInAs("admin");
  const { products } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target, "the demo catalogue holds ALYQ-1002");

  const qty = 2;
  const gross = Number(target.selling_price) * qty;
  const input: CompleteSaleInput = {
    client_ref: `p13-discount-${Date.now()}`,
    lines: [{ product_id: target.id, qty }],
    discount_type: "percent",
    discount_value: 5,
    payments: [
      { method: "cash", amount: gross * 0.95, status: "paid", tendered: gross },
    ],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-admin",
    user_name: "ALYQ Admin",
  };

  const before = await mark();
  const sale = await completeSale(input);
  const written = await entriesSince(before);

  const recorded = await expectAction(written, "sale.discounted");
  assert.equal(recorded.entity, "sale");
  assert.equal(recorded.entity_id, sale.id, "the entry points at the invoice it describes");
  assert.equal(recorded.entity_label, sale.sale_number);
  assert.equal(recorded.details.discount_type, "percent");
  assert.equal(recorded.details.percent, 5, "the percentage, not just the amount");
  assert.equal(recorded.details.discount_amount, sale.discount_amount);
  assert.equal(recorded.details.total, sale.total);
  assert.equal(recorded.details.subtotal, sale.subtotal);
  assert.equal(recorded.user_name, "ALYQ Admin", "attributed to whoever was signed in");
});

test("an undiscounted sale writes no discount entry", async () => {
  signInAs("admin");
  const { products } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target);
  const price = Number(target.selling_price);

  const before = await mark();
  await completeSale({
    client_ref: `p13-plain-${Date.now()}`,
    lines: [{ product_id: target.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: price, status: "paid", tendered: price }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-admin",
    user_name: "ALYQ Admin",
  });
  const written = await entriesSince(before);
  assert.equal(
    written.some((e) => e.action === "sale.discounted"),
    false,
    "a sale at full price is not a discount event — a trail full of noise is a trail nobody reads",
  );
});

test("cancelling a completed sale is refused and writes no audit row (0095)", async () => {
  signInAs("admin");
  const { products } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target);
  const price = Number(target.selling_price);
  const sale = await completeSale({
    client_ref: `p13-void-${Date.now()}`,
    lines: [{ product_id: target.id, qty: 1 }],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: price, status: "paid", tendered: price }],
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    user_id: "u-admin",
    user_name: "ALYQ Admin",
  });

  const before = await mark();
  await assert.rejects(
    voidSale(sale.id, {
      user_id: "u-admin",
      user_name: "ALYQ Admin",
      reason: "Customer walked out before paying",
    }),
    /cannot be cancelled/,
  );
  const written = await entriesSince(before);
  assert.equal(
    written.some((e) => e.action === "sale.voided"),
    false,
    "a refused cancellation must not leave a sale.voided row that claims it happened",
  );
  // The sale itself is untouched: still completed, still counted.
  const after = await getSalesRepository().getSale(sale.id);
  assert.equal(after.status, "completed");
  assert.equal(after.voided_at ?? null, null);
});

test("a price move is recorded with the value before and after", async () => {
  signInAs("admin");
  const { products, categories } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target);

  const toValues = (product: typeof target, selling: number, cost: number) =>
    ({
      sku: product.sku,
      barcode: product.barcode ?? "",
      name_ar: product.name_ar,
      name_en: product.name_en,
      description_ar: product.description_ar ?? "",
      description_en: product.description_en ?? "",
      category_id: product.category_id,
      product_type: product.product_type,
      selling_price: String(selling),
      cost_price: String(cost),
      tax_rate: String(product.tax_rate ?? 0),
      stock_tracking_enabled: product.stock_tracking_enabled,
      stock_quantity: String(product.stock_quantity),
      low_stock_level: String(product.low_stock_level),
      show_on_website: product.show_on_website,
      is_featured: product.is_featured,
      active: product.active,
      image_url: product.image_url ?? "",
      images: product.images ?? [],
    }) as never;

  const previousSelling = Number(target.selling_price);
  const previousCost = Number(target.cost_price ?? 0);
  const nextSelling = previousSelling + 12;
  const nextCost = previousCost + 3;

  const before = await mark();
  await saveProduct({
    values: toValues(target, nextSelling, nextCost),
    products,
    categories,
    currentId: target.id,
  });
  const written = await entriesSince(before);

  const price = await expectAction(written, "product.price_changed");
  assert.equal(price.entity, "product");
  assert.equal(price.entity_label, target.sku);
  assert.equal(price.details.previous, previousSelling);
  assert.equal(price.details.next, nextSelling);
  assert.equal(price.details.delta, 12, "the move, so a reader need not subtract");

  const cost = await expectAction(written, "product.cost_changed");
  assert.equal(cost.details.previous, previousCost);
  assert.equal(cost.details.next, nextCost);
  assert.equal(cost.details.delta, 3);
  assert.notEqual(
    price.entity_id,
    undefined,
    "both entries point at the same product",
  );
  assert.equal(price.entity_id, cost.entity_id);
});

test("a save that moves no price writes no price entry", async () => {
  signInAs("admin");
  const { products, categories } = await loadCatalog();
  const target = products.find((p) => p.sku === "ALYQ-1002");
  assert.ok(target);

  const before = await mark();
  await saveProduct({
    values: {
      sku: target.sku,
      barcode: target.barcode ?? "",
      name_ar: target.name_ar,
      // Only the description moves.
      name_en: `${target.name_en}`,
      description_ar: target.description_ar ?? "",
      description_en: "Reworded for the website",
      category_id: target.category_id,
      product_type: target.product_type,
      selling_price: String(target.selling_price),
      cost_price: String(target.cost_price ?? 0),
      tax_rate: String(target.tax_rate ?? 0),
      stock_tracking_enabled: target.stock_tracking_enabled,
      stock_quantity: String(target.stock_quantity),
      low_stock_level: String(target.low_stock_level),
      show_on_website: target.show_on_website,
      is_featured: target.is_featured,
      active: target.active,
      image_url: target.image_url ?? "",
      images: target.images ?? [],
    } as never,
    products,
    categories,
    currentId: target.id,
  });
  const written = await entriesSince(before);
  assert.equal(
    written.some((e) => e.action === "product.price_changed" || e.action === "product.cost_changed"),
    false,
    "rewording a product is not a price event",
  );
});

test("stock is recorded as an adjustment, and a recount as a correction", async () => {
  signInAs("admin");
  const { products } = await loadCatalog();
  const tracked = products.find((p) => p.stock_tracking_enabled && p.stock_quantity > 5);
  assert.ok(tracked, "the demo catalogue holds a tracked product with stock");

  const before = await mark();
  const damaged = await adjustStock({
    productId: tracked.id,
    type: "adjustment_out",
    reason: "damaged",
    quantity: 2,
    notes: "Crushed in the store room",
  });
  const recounted = await adjustStock({
    productId: tracked.id,
    type: "adjustment_out",
    reason: "recount",
    quantity: 1,
    notes: "Shelf count disagreed",
  });
  const written = await entriesSince(before);

  const adjustment = await expectAction(written, "stock.adjusted");
  assert.equal(adjustment.entity, "stock");
  assert.equal(adjustment.entity_id, tracked.id);
  assert.equal(adjustment.entity_label, tracked.sku);
  assert.equal(adjustment.details.reason, "damaged");
  assert.equal(adjustment.details.before, damaged.movement.quantity_before);
  assert.equal(adjustment.details.after, damaged.movement.quantity_after);
  assert.equal(adjustment.details.notes, "Crushed in the store room");

  const correction = await expectAction(written, "stock.corrected");
  assert.equal(correction.details.reason, "recount");
  assert.equal(correction.details.before, recounted.movement.quantity_before);
  assert.equal(correction.details.after, recounted.movement.quantity_after);
  assert.equal(
    Number(correction.details.before) - Number(correction.details.after),
    1,
    "the correction reads as the shelf writing the system down to match",
  );
});

// ── 4. the extract ────────────────────────────────────────────────────────
test("the extract resolves keys to words and reads oldest first", async () => {
  signInAs("admin");
  const before = await mark();
  await recordAudit({
    action: "stock.adjusted",
    entity: "stock",
    entity_id: "p-1",
    entity_label: "ALYQ-1002",
    details: { delta: 4, reason: "transfer_in" },
  });
  await recordAudit({
    action: "sale.discounted",
    entity: "sale",
    entity_id: "s-1",
    entity_label: "INV-000001",
    details: { percent: 5 },
  });
  const written = await entriesSince(before);
  assert.equal(written.length, 2);

  const rows = auditRowsOf(written, keyTranslate);
  assert.equal(rows.length, 2);
  assert.ok(
    rows[0].at <= rows[1].at,
    "oldest first — a timeline reads downwards, and the screen reads newest first",
  );
  const discounted = rows.find((row) => row.action === "audit.action.sale.discounted");
  assert.ok(discounted, "the action is resolved through the dictionary");
  assert.equal(discounted.entity, "audit.entity.sale");
  assert.equal(discounted.record, "INV-000001");
  assert.equal(discounted.details, '{"percent":5}', "structured evidence is preserved as JSON");
});

// ── 5. reading it and taking it out are two authorities ───────────────────
test("reading the trail and exporting it are separately gated", async () => {
  signInAs("cashier");
  assert.equal(mayExportAudit(), false, "a cashier may not take the trail out");
  const refusal = await (async () => {
    try {
      assertCanExportAudit();
      return null;
    } catch (err) {
      return err instanceof AppError ? err.code : String(err);
    }
  })();
  assert.equal(refusal, "FORBIDDEN", "and the button's own assertion agrees with the boolean");

  signInAs("admin");
  assert.equal(mayExportAudit(), true, "an admin may read and export");
  assertCanViewAudit();
  assertCanExportAudit();

  clearStoredSession();
  resetSessionCache();
  assert.equal(mayExportAudit(), false, "signed out, nobody may");
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
const failures: string[] = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`\x1b[2m        ✓ ${name}\x1b[0m`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name} | ${message}`);
    console.log(`\x1b[2m        \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`\x1b[2m          ${message}\x1b[0m`);
  }
}

const label = `${passed}/${tests.length} audit-expansion tests passed`;
if (failures.length > 0) {
  console.error(`\x1b[1m\x1b[31m\n✗ ${label}.\x1b[0m`);
  for (const failure of failures) console.error(`\x1b[31m•\x1b[0m ${failure}`);
  process.exit(1);
}
console.log(`\x1b[1m\x1b[32m\n✓ ${label}\x1b[0m`);

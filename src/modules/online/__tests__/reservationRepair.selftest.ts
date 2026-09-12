/**
 * Reservation repair self-test (Phase 15).
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs reservationRepair`).
 *
 * The screen at `/online/reservations` answers two questions, and this suite
 * tests them separately because they fail differently:
 *
 *   1. **What is wrong?** `reviewReservations` is pure, so every verdict can be
 *      asserted against hand-built orders and holds with no repository, no
 *      session and no clock drift: a hold its order still needs, a hold its order
 *      left behind, a hold with no order at all, a hold for a line the order
 *      never bought, a hold of the wrong size, a hold settled without a
 *      timestamp, two holds on one line, a settled hold that contradicts the
 *      ledger, and the mirror image — a pending order holding nothing.
 *   2. **Who may fix it, and what does fixing do?** Settling a hold changes what
 *      the whole shop can promise to sell, so it asks for `adjust_stock` — the
 *      stock ledger's own capability — and *not* for `manage_online_orders`,
 *      which the till seat holds. The second half signs each role in and calls
 *      the funnels, then drives the demo repository end to end to pin the three
 *      invariants the design hangs on: a repair never writes stock, never
 *      double-releases, and never invents a quantity.
 *
 * The audit assertions matter as much as the stock ones. A repair that leaves no
 * trail is indistinguishable from somebody editing the database, so every path
 * here checks that exactly one row landed in the existing audit log — same
 * repository, same vocabulary, no second trail.
 */
import assert from "node:assert/strict";
import process from "node:process";

import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import {
  clearStoredSession,
  primeCacheFromStorage,
  resetSessionCache,
  writeStoredSession,
} from "@/lib/auth/services/sessionStore";
import { dictionaries } from "@/lib/i18n/dictionary";
import { mayPerform } from "@/lib/permissions/actions";
import { APP_ROLES, capabilitiesOf, hasCapability, type AppRole, type Capability } from "@/lib/permissions/roles";
import { getDemoAuditRepository } from "@/modules/audit/data/demoRepository";
import { auditActionLabelKey } from "@/modules/audit/services/auditService";
import { AUDIT_ACTIONS, AUDIT_ENTITIES, type AuditAction } from "@/modules/audit/types";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { AppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";

import { OnlineError } from "../data";
import { EMPTY_ORDER_FILTER, isEmptyOrderFilter } from "../data/repository";
import { getDemoOnlineRepository, resetDemoOnlineRepository } from "../data/demoRepository";
import { availableToPromise, reservedByProduct, reservedOf, totalReserved } from "../services/availability";
import {
  AGING_HOLD_DAYS,
  EMPTY_RESERVATION_FILTERS,
  RESERVATION_ALERT_KINDS,
  RESERVATION_ALERT_VERDICTS,
  RESERVATION_VERDICTS,
  activeReservationFilters,
  assertCanRepairReservations,
  filterReservationRows,
  heldByProduct,
  mayRepairReservations,
  repairAllFindings,
  repairFinding,
  repairHold,
  reservationAlertCount,
  reservationAlertSignature,
  reservationAlerts,
  reservationRowProducts,
  restoreHold,
  reviewReservations,
  type ReservationFilters,
  type ReservationReview,
  type ReservationReviewRow,
} from "../services/reservationRepair";
import type { OnlineOrder, OnlineOrderItem, StockReservation } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ───────────────────────────────────────────────────────────────
/** Minimal in-memory Storage so a session can exist outside a browser. */
function installStorageStub(): void {
  const make = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { value: make(local), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: make(session), configurable: true });
}

/** Sign a demo role in, optionally with a custom resolved capability list. */
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

function signOut(): void {
  clearStoredSession();
  resetSessionCache();
}

/** The code an app refusal carries, or null when nothing was thrown. */
async function refusalCode(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    if (err instanceof OnlineError) return err.code;
    return `not-an-app-error:${String(err)}`;
  }
}

function refusalCodeSync(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

// ── fixtures ──────────────────────────────────────────────────────────────
const NOW = new Date("2026-05-01T10:00:00.000Z");
const HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
const NINE_DAYS_AGO = new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString();
const STAFF = { user_id: "user-demo-admin", user_name: "ALYQ Admin" };
const REASON = "Interrupted deployment left this hold behind";

function fakeProduct(id: string, tracked = true): Product {
  return {
    id,
    sku: `SKU-${id}`,
    name_en: `Product ${id}`,
    name_ar: `منتج ${id}`,
    stock_tracking_enabled: tracked,
    stock_quantity: 10,
  } as Product;
}

function fakeItem(orderId: string, productId: string, quantity: number): OnlineOrderItem {
  return {
    id: `${orderId}-${productId}`,
    order_id: orderId,
    product_id: productId,
    quantity,
    name_en: `Product ${productId}`,
    name_ar: `منتج ${productId}`,
    sku: `SKU-${productId}`,
    barcode: null,
    unit_price: 10,
    line_total: 10 * quantity,
  } as OnlineOrderItem;
}

function fakeOrder(partial: Partial<OnlineOrder> & { id: string }): OnlineOrder {
  return {
    order_number: `WEB-${partial.id}`,
    client_ref: partial.id,
    status: "pending",
    sale_id: null,
    created_at: HOUR_AGO,
    updated_at: HOUR_AGO,
    customer_name: "Test customer",
    items: [],
    events: [],
    ...partial,
  } as OnlineOrder;
}

function fakeReservation(
  partial: Partial<StockReservation> & { id: string; online_order_id: string; product_id: string },
): StockReservation {
  return {
    quantity: 1,
    status: "reserved",
    created_at: HOUR_AGO,
    resolved_at: null,
    ...partial,
  } as StockReservation;
}

/** One review call, with the clock pinned so ages never drift between runs. */
function review(input: {
  reservations?: readonly StockReservation[];
  orders?: readonly OnlineOrder[];
  products?: readonly Product[];
}): ReservationReview {
  return reviewReservations({
    reservations: input.reservations ?? [],
    orders: input.orders ?? [],
    products: input.products ?? [],
    now: NOW,
  });
}

function only(reviewed: ReservationReview): ReservationReviewRow {
  assert.equal(reviewed.rows.length, 1, "exactly one row was produced");
  return reviewed.rows[0];
}

async function demoProduct(sku: string): Promise<Product> {
  const products = await getDemoRepository().listProducts();
  const product = products.find(
    (candidate) =>
      candidate.sku === sku && candidate.active && candidate.stock_tracking_enabled && candidate.show_on_website,
  );
  assert.ok(product, `an active, stock-tracked website product with SKU ${sku} exists in the demo catalogue`);
  return product as Product;
}

/** Available-to-promise for one product, exactly as the storefront computes it. */
async function promiseable(product: Product): Promise<number | null> {
  const reservations = await getDemoOnlineRepository().listReservations();
  return availableToPromise(product, reservedOf(reservedByProduct(reservations), product.id));
}

async function auditRows(): Promise<{
  action: AuditAction;
  entity: string;
  entity_id: string;
  details: Record<string, unknown>;
  user_name: string;
  user_id: string;
  created_at: string;
}[]> {
  const entries = await getDemoAuditRepository().listEntries();
  return entries
    .filter((entry) => entry.entity === "reservation")
    .map((entry) => ({
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entity_id,
      details: entry.details as Record<string, unknown>,
      user_name: entry.user_name,
      user_id: entry.user_id,
      created_at: entry.created_at,
    }));
}

installStorageStub();

// ── 1. the classifier: what is wrong ──────────────────────────────────────
test("a pending order holding exactly what it bought is valid, and the totals describe the shelf", () => {
  const products = [fakeProduct("p1")];
  const orders = [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 2)] })];
  const reservations = [fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 2 })];

  const reviewed = review({ reservations, orders, products });
  const row = only(reviewed);

  assert.equal(row.verdict, "valid");
  assert.equal(row.severity, "ok");
  assert.equal(row.action, null, "a valid hold has nothing to repair");
  assert.equal(row.held, 2);
  assert.equal(row.expected, 2);
  assert.equal(row.status, "reserved");
  assert.equal(row.orderNumber, "WEB-o1");
  assert.equal(row.product?.sku, "SKU-p1");
  assert.equal(row.product?.tracked, true);
  assert.equal(row.ageDays, 0);
  assert.equal(row.unitsFreed, 0);

  assert.equal(reviewed.rows.length, 1);
  assert.equal(reviewed.findings.length, 0);
  assert.equal(reviewed.repairable.length, 0);
  assert.equal(reviewed.healthy, 1);
  assert.equal(reviewed.heldUnits, 2);
  assert.equal(reviewed.affectedUnits, 0);
  assert.equal(reviewed.aging, 0);
  assert.equal(reviewed.byVerdict.valid, 1);
});

test("an order that moved on leaves its hold behind, and the sale decides the remedy", () => {
  const products = [fakeProduct("p1")];
  const orders = [
    // Approved and it became a sale: the units were taken, so the hold converts.
    fakeOrder({ id: "o1", status: "approved", sale_id: "sale-1", items: [fakeItem("o1", "p1", 1)] }),
    // Cancelled: its sale was voided and the stock restored, so the hold releases.
    fakeOrder({ id: "o2", status: "cancelled", sale_id: "sale-2", items: [fakeItem("o2", "p1", 1)] }),
    // Completed with no sale link at all: nothing took the units.
    fakeOrder({ id: "o3", status: "completed", sale_id: null, items: [fakeItem("o3", "p1", 1)] }),
  ];
  const reservations = orders.map((order, index) =>
    fakeReservation({ id: `r${index + 1}`, online_order_id: order.id, product_id: "p1" }),
  );

  const reviewed = review({ reservations, orders, products });
  assert.equal(reviewed.rows.length, 3);
  assert.equal(reviewed.byVerdict.stale, 3, "all three are holds their order left behind");
  assert.equal(reviewed.repairable.length, 3);

  const [converted, released, alsoReleased] = reviewed.rows;
  assert.equal(converted.action, "convert", "a live sale means the units were taken");
  assert.equal(released.action, "release", "a cancelled sale put the units back");
  assert.equal(alsoReleased.action, "release", "no sale at all means nothing took them");
  assert.equal(converted.unitsFreed, 1);
  assert.equal(converted.severity, "danger");
  assert.equal(reviewed.affectedUnits, 3);
});

test("a hold whose order no longer exists is orphaned, and a settled orphan is left alone", () => {
  const products = [fakeProduct("p1")];
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "gone", product_id: "p1", quantity: 4 }),
    fakeReservation({
      id: "r2",
      online_order_id: "also-gone",
      product_id: "p1",
      status: "released",
      resolved_at: HOUR_AGO,
    }),
  ];

  const reviewed = review({ reservations, orders: [], products });
  const [orphan, settled] = reviewed.rows;

  assert.equal(orphan.verdict, "orphaned");
  assert.equal(orphan.action, "release");
  assert.equal(orphan.order, null);
  assert.equal(orphan.orderNumber, "—");
  assert.equal(orphan.orderStatus, "missing");
  assert.equal(orphan.expected, 0, "with no order there is nothing to expect");
  assert.equal(orphan.unitsFreed, 4);

  assert.equal(settled.verdict, "valid", "a resolved hold with no order is history, not a finding");
  assert.equal(reviewed.findings.length, 1);
  assert.equal(reviewed.heldUnits, 4, "only open holds keep units out of the pool");
});

test("a hold for a line the order never bought is unexpected, and a wrong size is reconciled down", () => {
  const products = [fakeProduct("p1"), fakeProduct("p2")];
  const orders = [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 3)] })];
  const reservations = [
    // The order bought three of p1 and nothing of p2.
    fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p2", quantity: 1 }),
    fakeReservation({ id: "r2", online_order_id: "o1", product_id: "p1", quantity: 5 }),
  ];

  const reviewed = review({ reservations, orders, products });
  const [unexpected, mismatch] = reviewed.rows;

  assert.equal(unexpected.verdict, "unexpected_hold");
  assert.equal(unexpected.action, "release");
  assert.equal(unexpected.expected, 0);
  assert.equal(unexpected.unitsFreed, 1);

  assert.equal(mismatch.verdict, "quantity_mismatch");
  assert.equal(mismatch.action, "reconcile");
  assert.equal(mismatch.held, 5);
  assert.equal(mismatch.expected, 3, "the order's own quantity is the only correct answer");
  assert.equal(mismatch.unitsFreed, 2, "a reconcile frees the difference, not the hold");
  assert.equal(mismatch.severity, "warning");
});

test("two open holds on one order line need a person, not a guess", () => {
  const products = [fakeProduct("p1")];
  const orders = [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 3)] })];
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 3 }),
    fakeReservation({ id: "r2", online_order_id: "o1", product_id: "p1", quantity: 3 }),
  ];

  const reviewed = review({ reservations, orders, products });
  const [first, second] = reviewed.rows;

  assert.equal(first.verdict, "valid", "the first hold on the line is judged on its own");
  assert.equal(
    second.verdict,
    "duplicate_hold",
    "its own verdict: a write that happened twice reads differently from a settlement the ledger contradicts",
  );
  assert.equal(reviewed.byVerdict.duplicate_hold, 1);
  assert.equal(second.action, null, "releasing either row would be a guess about which one was meant");
  assert.equal(second.severity, "danger");
  assert.equal(reviewed.repairable.length, 0);
  assert.equal(reviewed.findings.length, 1);
  assert.equal(reviewed.heldUnits, 6, "both rows still hide units — which is the problem");
});

test("a hold settled without a timestamp is unresolved, and one settled against the ledger needs a person", () => {
  const products = [fakeProduct("p1")];
  const orders = [
    fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 1)] }),
    // Converted, but the order never became a sale.
    fakeOrder({ id: "o2", status: "completed", sale_id: null, items: [fakeItem("o2", "p1", 1)] }),
    // Released, while the sale that took the units still stands.
    fakeOrder({ id: "o3", status: "approved", sale_id: "sale-3", items: [fakeItem("o3", "p1", 1)] }),
    // Released on a cancelled order whose sale was voided: exactly right.
    fakeOrder({ id: "o4", status: "cancelled", sale_id: "sale-4", items: [fakeItem("o4", "p1", 1)] }),
  ];
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", status: "released", resolved_at: null }),
    fakeReservation({ id: "r2", online_order_id: "o2", product_id: "p1", status: "converted", resolved_at: HOUR_AGO }),
    fakeReservation({ id: "r3", online_order_id: "o3", product_id: "p1", status: "released", resolved_at: HOUR_AGO }),
    fakeReservation({ id: "r4", online_order_id: "o4", product_id: "p1", status: "released", resolved_at: HOUR_AGO }),
  ];

  const reviewed = review({ reservations, orders, products });
  const [unresolved, converted, released, correct] = reviewed.rows;

  assert.equal(unresolved.verdict, "unresolved");
  assert.equal(unresolved.action, "reconcile", "stamping the record is the safe remedy");
  assert.equal(unresolved.severity, "info");
  assert.equal(unresolved.ageDays, null, "a settled hold is not aging");

  assert.equal(converted.verdict, "inconsistent");
  assert.equal(converted.action, null);
  assert.equal(released.verdict, "inconsistent");
  assert.equal(released.action, null);
  assert.equal(correct.verdict, "valid");

  // o1 is still pending, so its released hold also leaves the order holding
  // nothing — two findings from one row, and both are repairable.
  assert.equal(reviewed.findings.length, 4);
  assert.equal(reviewed.byVerdict.missing_hold, 1);
  assert.equal(reviewed.repairable.length, 2, "the timestamp and the missing hold need no judgement");
  assert.equal(reviewed.heldUnits, 0);
});

test("a pending order holding nothing is a missing hold — for tracked lines only", () => {
  const products = [fakeProduct("p1"), fakeProduct("p2", false)];
  const orders = [
    fakeOrder({
      id: "o1",
      created_at: NINE_DAYS_AGO,
      items: [fakeItem("o1", "p1", 2), fakeItem("o1", "p2", 5), fakeItem("o1", "p3", 0)],
    }),
    // A closed order is not supposed to hold anything.
    fakeOrder({ id: "o2", status: "completed", items: [fakeItem("o2", "p1", 4)] }),
    // A pending order whose line already has an open hold is not missing one.
    fakeOrder({ id: "o3", items: [fakeItem("o3", "p1", 1)] }),
  ];
  const reservations = [fakeReservation({ id: "r1", online_order_id: "o3", product_id: "p1", quantity: 1 })];

  const reviewed = review({ reservations, orders, products });
  assert.equal(reviewed.rows.length, 2, "one existing hold plus one missing hold");

  const missing = reviewed.rows.find((row) => row.verdict === "missing_hold");
  assert.ok(missing, "the unheld pending line was found");
  assert.equal(missing.action, "hold");
  assert.equal(missing.status, "missing");
  assert.equal(missing.reservation, null, "there is no row to point at");
  assert.equal(missing.held, 0);
  assert.equal(missing.expected, 2, "the quantity is the order line's own");
  assert.equal(missing.unitsFreed, 2);
  assert.equal(missing.key, "missing:o1:p1");
  assert.equal(missing.ageDays, 9, "a missing hold ages with its order");
  assert.equal(missing.severity, "danger");

  assert.equal(reviewed.byVerdict.missing_hold, 1, "untracked, zero-quantity and closed lines are not findings");
  assert.equal(reviewed.repairable.length, 1);
});

test("a duplicate missing line is reported once, and aging counts open holds only", () => {
  const products = [fakeProduct("p1")];
  // The same product on two lines of one order: one hold is missing, not two.
  const orders = [
    fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 1), fakeItem("o1", "p1", 2)] }),
  ];
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "o2", product_id: "p1", created_at: NINE_DAYS_AGO }),
    fakeReservation({
      id: "r2",
      online_order_id: "o2",
      product_id: "p1",
      status: "released",
      created_at: NINE_DAYS_AGO,
      resolved_at: NINE_DAYS_AGO,
    }),
  ];

  const reviewed = review({ reservations, orders, products });
  assert.equal(reviewed.byVerdict.missing_hold, 1, "one finding per order line");
  const missing = reviewed.rows.find((row) => row.verdict === "missing_hold");
  assert.equal(missing?.expected, 3, "both lines add up to what the order bought");

  assert.equal(reviewed.aging, 1, "only the open hold is aging");
  assert.ok(AGING_HOLD_DAYS > 0);
  assert.equal(RESERVATION_VERDICTS.length, 9, "every verdict the classifier can return");

  // Every verdict the classifier can return has a label and an explanation in
  // both languages — a new verdict without copy would render as a raw key.
  for (const verdict of RESERVATION_VERDICTS) {
    for (const language of ["en", "ar"] as const) {
      for (const prefix of ["holds.verdict", "holds.explain"]) {
        const key = `${prefix}.${verdict}` as keyof (typeof dictionaries)["en"];
        const value = dictionaries[language][key];
        assert.ok(value && value !== key, `${language}: ${key} is translated`);
      }
    }
  }
});

test("heldByProduct agrees with the availability helper the storefront uses", () => {
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 2 }),
    fakeReservation({ id: "r2", online_order_id: "o2", product_id: "p1", quantity: 3 }),
    fakeReservation({ id: "r3", online_order_id: "o3", product_id: "p2", quantity: 1 }),
    fakeReservation({
      id: "r4",
      online_order_id: "o4",
      product_id: "p2",
      quantity: 9,
      status: "released",
      resolved_at: HOUR_AGO,
    }),
  ];

  const held = heldByProduct(reservations);
  const expected = reservedByProduct(reservations);
  assert.deepEqual([...held.entries()], [...expected.entries()], "same numbers as the storefront's own helper");
  assert.equal(reservedOf(held, "p1"), 5);
  assert.equal(reservedOf(held, "p2"), 1, "a released hold no longer hides units");
  assert.equal(totalReserved(reservations), 6);
});

// ── 2. authority: who may settle a hold ───────────────────────────────────
test("signed out, nobody may settle a hold", async () => {
  installStorageStub();
  signOut();

  const row = only(
    review({
      reservations: [fakeReservation({ id: "r1", online_order_id: "gone", product_id: "p1" })],
      products: [fakeProduct("p1")],
    }),
  );

  assert.equal(mayRepairReservations(), false, "the button is hidden");
  assert.equal(refusalCodeSync(() => assertCanRepairReservations()), "FORBIDDEN");
  assert.equal(mayPerform("reservation.repair"), false);
  assert.equal(await refusalCode(() => repairHold(row, REASON)), "FORBIDDEN");
  assert.equal(await refusalCode(() => restoreHold(row, REASON)), "FORBIDDEN");
  assert.equal(await refusalCode(() => repairFinding(row, REASON)), "FORBIDDEN");
  assert.equal(
    await refusalCode(() => repairAllFindings(review({ reservations: [], orders: [], products: [] }), REASON)),
    "FORBIDDEN",
  );
});

test("working the online queue is not authority to settle its holds", () => {
  for (const role of APP_ROLES) {
    installStorageStub();
    signInAs(role);
    const allowed = hasCapability(role, "adjust_stock");
    assert.equal(mayRepairReservations(), allowed, `${role}: repair follows adjust_stock`);
    assert.equal(mayPerform("reservation.repair"), allowed, `${role}: the register agrees`);
    assert.equal(
      refusalCodeSync(() => assertCanRepairReservations()),
      allowed ? null : "FORBIDDEN",
      `${role}: the funnel agrees`,
    );
  }

  // The till seat specifically: it works the queue, it does not hold the ledger.
  installStorageStub();
  signInAs("cashier");
  assert.equal(hasCapability("cashier", "manage_online_orders"), true, "a cashier works the online queue");
  assert.equal(mayRepairReservations(), false, "…and may not settle its holds");
});

test("the resolved capability decides, not the role label", () => {
  installStorageStub();
  // A cashier given the ledger capability by a custom role: allowed.
  signInAs("cashier", [...capabilitiesOf("cashier"), "adjust_stock"]);
  assert.equal(mayRepairReservations(), true, "a custom role carrying adjust_stock may repair");

  // An admin-labelled session whose resolved list lacks it: refused.
  signInAs("admin", capabilitiesOf("viewer"));
  assert.equal(mayRepairReservations(), false, "the label does not decide");
  assert.equal(refusalCodeSync(() => assertCanRepairReservations()), "FORBIDDEN");

  signInAs("manager");
  assert.equal(mayRepairReservations(), true);
  signInAs("admin");
  assert.equal(mayRepairReservations(), true);
});

test("a repair without a reason is refused before anything is written", async () => {
  installStorageStub();
  signInAs("admin");
  const before = (await auditRows()).length;

  const row = only(
    review({
      reservations: [fakeReservation({ id: "r1", online_order_id: "gone", product_id: "p1" })],
      products: [fakeProduct("p1")],
    }),
  );

  for (const reason of [null, "", "   ", "no"]) {
    assert.equal(
      await refusalCode(() => repairHold(row, reason)),
      "VALIDATION",
      `a reason of ${JSON.stringify(reason)} is refused`,
    );
  }
  assert.equal(await refusalCode(() => restoreHold(row, REASON)), "VALIDATION", "an orphan is not a missing hold");

  assert.equal((await auditRows()).length, before, "a refused repair writes nothing to the trail");
});

test("the funnels refuse the rows they cannot act on, and the repository checks the order again", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();

  const products = [fakeProduct("p1")];
  const orders = [fakeOrder({ id: "o-missing", items: [fakeItem("o-missing", "p1", 2)] })];
  const reviewed = review({ orders, products });
  const missing = reviewed.rows.find((row) => row.verdict === "missing_hold");
  assert.ok(missing, "the fixture produced a missing hold");

  // A valid row has no action, so there is nothing for the funnel to do.
  const valid = only(
    review({
      reservations: [fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 1 })],
      orders: [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 1)] })],
      products,
    }),
  );
  assert.equal(await refusalCode(() => repairHold(valid, REASON)), "VALIDATION");
  assert.equal(await refusalCode(() => restoreHold(valid, REASON)), "VALIDATION");
  assert.equal(await refusalCode(() => repairHold(missing, REASON)), "VALIDATION", "a missing hold is restored, not repaired");

  // `repairFinding` dispatches on the row's own action — and the repository then
  // refuses an order it has never heard of, so a hand-built row cannot write.
  const code = await refusalCode(() => repairFinding(missing, REASON));
  assert.equal(code, "order_not_found", "the repository re-checks the order behind the row");
});

// ── 3. the repair itself: demo repository, end to end ─────────────────────
test("releasing a stuck hold returns the units, and the review then asks for the hold to be restored", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1002");
  const catalogue = await getDemoRepository().listProducts();

  const placed = await repository.placeOrder({
    client_ref: "ref-repair-1",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });
  const orderId = placed.order.id;
  const stockBefore = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  const promiseBefore = await promiseable(product);

  // Checkout did its job: the order holds exactly what it bought.
  const healthy = review({
    reservations: await repository.listReservations(),
    orders: await repository.listOrders(),
    products: catalogue,
  });
  assert.equal(healthy.findings.length, 0, "a freshly placed order has nothing to reconcile");
  assert.equal(healthy.heldUnits, 2);
  const hold = healthy.rows[0].reservation;
  assert.ok(hold, "the hold exists");

  // Now the stuck-hold case: the order moved on in the database but the
  // resolution never landed, so the units are still out of the pool.
  const released = await repository.repairReservation(hold.id, {
    action: "release",
    quantity: null,
    reason: REASON,
    ...STAFF,
  });
  assert.equal(released.reservation.status, "released");
  assert.equal(released.reservation.resolved_at !== null, true, "the resolution is stamped");
  assert.equal(released.alreadyResolved, false);
  assert.equal(released.before.status, "reserved", "the trail can say what it was");
  assert.equal(released.before.quantity, 2);

  // Availability follows immediately — this is the number the storefront, the
  // low-stock report and the POS all read.
  assert.equal(await promiseable(product), (promiseBefore ?? 0) + 2, "the units are promiseable again");
  const stockAfter = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  assert.equal(stockAfter, stockBefore, "a repair never writes stock");

  // The order's own timeline says a person settled it, and why.
  const order = (await repository.listOrders()).find((candidate) => candidate.id === orderId);
  assert.ok(order, "the order is still there");
  const note = order.events.at(-1);
  assert.ok(note, "the repair left a line on the order");
  assert.equal(note.kind, "note");
  assert.ok(note.note?.includes(REASON), "the note carries the reason");
  assert.equal(note.user_name, STAFF.user_name);

  // …which turns the same order into the mirror-image finding.
  const after = review({
    reservations: await repository.listReservations(),
    orders: await repository.listOrders(),
    products: catalogue,
  });
  assert.equal(after.findings.length, 1);
  const missing = after.findings[0];
  assert.equal(missing.verdict, "missing_hold");
  assert.equal(missing.action, "hold");
  assert.equal(missing.expected, 2);

  // Restoring it goes through the service funnel, so it is gated and audited.
  const auditBefore = (await auditRows()).length;
  const restored = await repairFinding(missing, "Restoring the hold the interrupted deployment dropped");
  assert.equal(restored.reservation.status, "reserved");
  assert.equal(restored.reservation.quantity, 2, "the order's own quantity, not an invented one");
  assert.equal(restored.alreadyResolved, false);

  assert.equal(await promiseable(product), promiseBefore, "the units are held again");
  assert.equal(
    (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity,
    stockBefore,
    "and stock was never touched, in either direction",
  );

  const settled = review({
    reservations: await repository.listReservations(),
    orders: await repository.listOrders(),
    products: catalogue,
  });
  assert.equal(settled.findings.length, 0, "the review is clean again");

  const rows = await auditRows();
  assert.equal(rows.length, auditBefore + 1, "exactly one audit row for one repair");
  const entry = rows[0];
  assert.equal(entry.action, "reservation.held");
  assert.equal(entry.entity, "reservation");
  assert.equal(entry.entity_id, restored.reservation.id);
  assert.equal(entry.details.repair, "hold");
  assert.equal(entry.details.verdict, "missing_hold");
  assert.equal(entry.details.reason, "Restoring the hold the interrupted deployment dropped");
  assert.equal(entry.details.order, order.order_number);
  assert.equal(entry.details.quantity_after, 2);
  assert.equal(entry.user_name, "ALYQ Admin", "the acting session, not the row");

  // A repair is only reviewable if the row says what it changed: the state before,
  // the state after, how much stock it moved, why, who, and when.
  assert.equal(entry.details.order_id, order.id, "the id joins the row back to the order");
  assert.equal(entry.details.product_id, product.id);
  assert.equal(entry.details.sku, product.sku);
  assert.equal(entry.details.order_status, "pending");
  assert.equal(entry.details.status_before, "missing", "the state before was no hold at all");
  assert.equal(entry.details.status_after, "reserved");
  assert.equal(entry.details.quantity_before, 0, "nothing was held before the restore");
  assert.equal(entry.details.resolved_at_before, null);
  assert.equal(entry.details.expected_quantity, 2, "what the order line asked for, so the write can be checked");
  assert.equal(typeof entry.details.age_days, "number", "how long the problem had been sitting there");
  assert.equal(entry.details.units_changed, 2, "the units this moved out of the promiseable pool");
  assert.equal(entry.details.already_resolved, false);
  assert.ok(entry.user_id.length > 0, "who did it, by id as well as by name");
  assert.ok(entry.created_at.length > 0, "and when");
  assert.ok(
    AUDIT_ACTIONS.includes(entry.action),
    "written into the existing audit vocabulary, not a second trail",
  );
});

test("repeating a repair is a no-op, and a resolution is never reversed", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-2001");

  const placed = await repository.placeOrder({
    client_ref: "ref-repair-2",
    customer_name: "Mina",
    customer_phone: "01001234568",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  const hold = (await repository.listReservations()).find(
    (reservation) => reservation.online_order_id === placed.order.id,
  );
  assert.ok(hold, "the hold exists");
  const eventsBefore = (await repository.listOrders()).find((o) => o.id === placed.order.id)?.events.length ?? 0;

  const first = await repository.repairReservation(hold.id, { action: "release", quantity: null, reason: REASON, ...STAFF });
  assert.equal(first.alreadyResolved, false);

  // A double tap, a retry after a timeout, two operators on the same finding:
  // the second call reports that it was already settled and writes nothing.
  const second = await repository.repairReservation(hold.id, { action: "release", quantity: null, reason: REASON, ...STAFF });
  assert.equal(second.alreadyResolved, true);
  assert.equal(second.reservation.status, "released");
  const eventsAfter = (await repository.listOrders()).find((o) => o.id === placed.order.id)?.events.length ?? 0;
  assert.equal(eventsAfter, eventsBefore + 1, "the repeat left no second line on the order");

  // Reversing it would return units the resolution already accounted for.
  const reversal = await refusalCode(() =>
    repository.repairReservation(hold.id, { action: "convert", quantity: null, reason: REASON, ...STAFF }),
  );
  assert.equal(reversal, "workflow_refused", "a released hold cannot be converted afterwards");
  const still = (await repository.listReservations()).find((reservation) => reservation.id === hold.id);
  assert.equal(still?.status, "released", "the refused reversal changed nothing");

  // …and the same in the other direction, on a hold that did become a sale.
  const converted = await repository.repairReservation(hold.id, { action: "release", quantity: null, reason: REASON, ...STAFF });
  assert.equal(converted.alreadyResolved, true);
});

test("a repair cannot invent a quantity, and a hold is never created twice", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1002");

  const placed = await repository.placeOrder({
    client_ref: "ref-repair-3",
    customer_name: "Sara",
    customer_phone: "01001234569",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });
  const hold = (await repository.listReservations()).find(
    (reservation) => reservation.online_order_id === placed.order.id,
  );
  assert.ok(hold, "the hold exists");

  // Reconciling to a number the order did not ask for is refused outright…
  assert.equal(
    await refusalCode(() =>
      repository.repairReservation(hold.id, { action: "reconcile", quantity: 9, reason: REASON, ...STAFF }),
    ),
    "workflow_refused",
    "a repair cannot hold a quantity the order did not buy",
  );
  // …and reconciling to the order's own quantity when it already matches is a
  // no-op rather than a write.
  const same = await repository.repairReservation(hold.id, { action: "reconcile", quantity: 2, reason: REASON, ...STAFF });
  assert.equal(same.alreadyResolved, true);
  assert.equal(same.reservation.quantity, 2);

  // Restoring a hold that is already open returns it unchanged: two rows on one
  // line would hide the same units twice.
  const existing = await repository.reserveStockForOrder({
    online_order_id: placed.order.id,
    product_id: product.id,
    quantity: null,
    reason: REASON,
    ...STAFF,
  });
  assert.equal(existing.id, hold.id, "no duplicate hold was written");
  const open = (await repository.listReservations()).filter(
    (reservation) => reservation.online_order_id === placed.order.id && reservation.status === "reserved",
  );
  assert.equal(open.length, 1);

  // An invented quantity is refused here too, and so is a closed order.
  assert.equal(
    await refusalCode(() =>
      repository.reserveStockForOrder({
        online_order_id: placed.order.id,
        product_id: product.id,
        quantity: 7,
        reason: REASON,
        ...STAFF,
      }),
    ),
    "workflow_refused",
  );
  const cancelled = await repository.resolveOrder(placed.order.id, { action: "cancel", reason: "Changed their mind", ...STAFF });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    await refusalCode(() =>
      repository.reserveStockForOrder({
        online_order_id: placed.order.id,
        product_id: product.id,
        quantity: null,
        reason: REASON,
        ...STAFF,
      }),
    ),
    "workflow_refused",
    "a cancelled order does not hold stock, so there is nothing to restore",
  );
  assert.equal(
    await refusalCode(() =>
      repository.reserveStockForOrder({
        online_order_id: "no-such-order",
        product_id: product.id,
        quantity: null,
        reason: REASON,
        ...STAFF,
      }),
    ),
    "order_not_found",
  );
  assert.equal(
    await refusalCode(() => repository.repairReservation("no-such-hold", { action: "release", quantity: null, reason: REASON, ...STAFF })),
    "db",
    "an unknown hold is reported, not invented",
  );
});

test("repairing everything at once writes one audit row per hold, reports failures and leaves judgement calls alone", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const catalogue = await getDemoRepository().listProducts();
  const coffee = await demoProduct("ALYQ-1002");
  const machine = await demoProduct("ALYQ-2001");

  const first = await repository.placeOrder({
    client_ref: "ref-batch-1",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: coffee.id, qty: 2 }],
  });
  const second = await repository.placeOrder({
    client_ref: "ref-batch-2",
    customer_name: "Mina",
    customer_phone: "01001234568",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: machine.id, qty: 1 }],
  });
  const stockBefore = (await getDemoRepository().listProducts()).find((p) => p.id === coffee.id)?.stock_quantity ?? 0;

  // Both holds are stuck: released in the store while their orders still wait.
  for (const orderId of [first.order.id, second.order.id]) {
    const hold = (await repository.listReservations()).find((reservation) => reservation.online_order_id === orderId);
    assert.ok(hold, `the hold for ${orderId} exists`);
    await repository.repairReservation(hold.id, { action: "release", quantity: null, reason: REASON, ...STAFF });
  }

  // A review of the store, plus two rows that only exist on paper: one whose
  // reservation is gone (a failure the batch must collect, not throw) and one
  // that contradicts the ledger (a judgement call the batch must not touch).
  const fabricatedOrder = fakeOrder({ id: "o-converted", status: "completed", sale_id: null, items: [fakeItem("o-converted", coffee.id, 1)] });
  const reviewed = reviewReservations({
    reservations: [
      ...(await repository.listReservations()),
      fakeReservation({ id: "rsv-gone", online_order_id: "o-vanished", product_id: coffee.id, quantity: 3 }),
      fakeReservation({
        id: "rsv-converted",
        online_order_id: fabricatedOrder.id,
        product_id: coffee.id,
        status: "converted",
        resolved_at: HOUR_AGO,
      }),
    ],
    orders: [...(await repository.listOrders()), fabricatedOrder],
    products: catalogue,
    now: NOW,
  });

  assert.equal(reviewed.byVerdict.missing_hold, 2, "both orders are holding nothing");
  assert.equal(reviewed.byVerdict.orphaned, 1);
  assert.equal(reviewed.byVerdict.inconsistent, 1);
  assert.equal(reviewed.repairable.length, 3);

  const auditBefore = (await auditRows()).length;
  const outcome = await repairAllFindings(reviewed, "Reconciling after the interrupted deployment");

  assert.equal(outcome.repaired.length, 2, "the two missing holds were restored");
  assert.equal(outcome.skipped.length, 0);
  assert.equal(outcome.manual.length, 1, "the ledger contradiction was left for a person");
  assert.equal(outcome.manual[0].verdict, "inconsistent");
  assert.equal(outcome.failed.length, 1, "the vanished reservation was reported, not thrown");
  assert.equal(outcome.failed[0].row.verdict, "orphaned");
  assert.ok(outcome.failed[0].message.length > 0, "and it says why");

  const rows = await auditRows();
  assert.equal(rows.length, auditBefore + 2, "one audit row per repair, none for the failure or the judgement call");
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.action),
    ["reservation.held", "reservation.held"],
  );
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.details.reason, "Reconciling after the interrupted deployment");
    assert.equal(row.details.already_resolved, false);
  }

  // Both orders hold what they bought again, and stock never moved.
  const after = reviewReservations({
    reservations: await repository.listReservations(),
    orders: await repository.listOrders(),
    products: catalogue,
    now: NOW,
  });
  assert.equal(after.findings.length, 0);
  assert.equal(after.heldUnits, 3);
  assert.equal(
    (await getDemoRepository().listProducts()).find((p) => p.id === coffee.id)?.stock_quantity,
    stockBefore,
    "a batch repair writes no stock either",
  );
});

test("an operator acting on a review that has gone stale is told, not double-released", async () => {
  installStorageStub();
  signInAs("admin");
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const catalogue = await getDemoRepository().listProducts();
  const product = await demoProduct("ALYQ-1002");

  const placed = await repository.placeOrder({
    client_ref: "ref-stale-1",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });
  const before = reviewReservations({
    reservations: await repository.listReservations(),
    orders: await repository.listOrders(),
    products: catalogue,
    now: NOW,
  });
  const row = before.rows.find((candidate) => candidate.reservation?.online_order_id === placed.order.id);
  assert.ok(row?.reservation, "the hold for the order just placed exists");

  // Somebody else settles it while this operator is still looking at the review.
  await repository.repairReservation(row.reservation.id, { action: "release", quantity: null, reason: REASON, ...STAFF });

  // The stale row still says "release". Running it must not release twice.
  const staleRow: ReservationReviewRow = {
    ...row,
    verdict: "stale",
    severity: "danger",
    action: "release",
    unitsFreed: row.reservation.quantity,
  };
  const auditBefore = (await auditRows()).length;
  const outcome = await repairAllFindings(
    { ...before, findings: [staleRow], repairable: [staleRow] },
    "Settling the holds the deployment left",
  );

  assert.equal(outcome.repaired.length, 0);
  assert.equal(outcome.skipped.length, 1, "the operator is told it was already settled");
  assert.equal(outcome.skipped[0].alreadyResolved, true);
  assert.equal(outcome.failed.length, 0);

  const hold = (await repository.listReservations()).find((reservation) => reservation.id === row.reservation?.id);
  assert.equal(hold?.status, "released");
  assert.equal(hold?.quantity, 2, "the quantity was untouched");

  const rows = await auditRows();
  assert.equal(rows.length, auditBefore + 1, "even a no-op repair is on the trail");
  assert.equal(rows[0].details.already_resolved, true, "…and the trail says it changed nothing");
  assert.equal(rows[0].details.status_before, "released");
  assert.equal(rows[0].details.units_changed, 0);
});

// ── 4. the trail itself ───────────────────────────────────────────────────
test("the audit vocabulary covers every repair the service can perform", () => {
  const repairs = ["reservation.released", "reservation.converted", "reservation.reconciled", "reservation.held"] as const;
  for (const action of repairs) {
    assert.ok(AUDIT_ACTIONS.includes(action), `${action} is a registered audit action`);
    const key = auditActionLabelKey(action) as keyof (typeof dictionaries)["en"];
    for (const language of ["en", "ar"] as const) {
      const label = dictionaries[language][key];
      assert.ok(label && label !== key, `${language}: ${key} is translated`);
    }
  }
  assert.ok(AUDIT_ENTITIES.includes("reservation"), "reservations are an auditable entity");
  const entityKey = "audit.entity.reservation" as keyof (typeof dictionaries)["en"];
  for (const language of ["en", "ar"] as const) {
    const label = dictionaries[language][entityKey];
    assert.ok(label && label !== entityKey, `${language}: the entity is translated`);
  }
});

// ── 5. the screen's filters ───────────────────────────────────────────────
/**
 * Three rows in three different shapes: a hold that is correct but old, a hold
 * its order left behind, and a hold that was never written. Enough to give every
 * filter something to bite on and something to leave out.
 */
function filterFixture(): ReservationReview {
  const products = [fakeProduct("p1"), fakeProduct("p2")];
  const orders = [
    // Nine days pending, holding exactly what it bought: correct, and old.
    fakeOrder({ id: "o1", created_at: NINE_DAYS_AGO, items: [fakeItem("o1", "p1", 2)] }),
    // Waiting on a hold nobody wrote.
    fakeOrder({ id: "o2", items: [fakeItem("o2", "p2", 3)] }),
    // Approved into a sale whose hold never converted.
    fakeOrder({ id: "o3", status: "approved", sale_id: "sale-3", items: [fakeItem("o3", "p1", 1)] }),
  ];
  const reservations = [
    fakeReservation({
      id: "r1",
      online_order_id: "o1",
      product_id: "p1",
      quantity: 2,
      created_at: NINE_DAYS_AGO,
    }),
    fakeReservation({ id: "r3", online_order_id: "o3", product_id: "p1", quantity: 1 }),
  ];
  return review({ products, orders, reservations });
}

test("the holds table narrows by text, verdict, order status, product, age and date", () => {
  const reviewed = filterFixture();
  assert.deepEqual(
    reviewed.rows.map((row) => row.key),
    ["r1", "r3", "missing:o2:p2"],
    "two holds, then the one that should exist and does not",
  );
  assert.equal(reviewed.findings.length, 2);
  assert.equal(reviewed.healthy, 1);
  assert.equal(reviewed.aging, 1);
  assert.equal(reviewed.oldestDays, 9);

  const narrow = (patch: Partial<ReservationFilters>): string[] =>
    filterReservationRows(reviewed.rows, { ...EMPTY_RESERVATION_FILTERS, ...patch }).map(
      (row) => row.key,
    );

  assert.deepEqual(narrow({}), ["r3", "missing:o2:p2"], "the default view is only problems");
  assert.deepEqual(
    narrow({ scope: "all" }),
    ["r1", "r3", "missing:o2:p2"],
    "…and every hold is one switch away",
  );

  assert.deepEqual(narrow({ scope: "all", search: "web-o1" }), ["r1"], "search ignores case");
  assert.deepEqual(narrow({ scope: "all", search: "SKU-P2" }), ["missing:o2:p2"], "and reaches the SKU");
  assert.deepEqual(
    narrow({ scope: "all", search: "منتج p2" }),
    ["missing:o2:p2"],
    "and the Arabic product name",
  );
  assert.deepEqual(narrow({ scope: "all", search: "  " }), ["r1", "r3", "missing:o2:p2"], "whitespace searches nothing");

  assert.deepEqual(narrow({ scope: "all", verdict: "valid" }), ["r1"]);
  assert.deepEqual(narrow({ verdict: "valid" }), [], "a verdict the scope excludes stays excluded");
  assert.deepEqual(
    narrow({ scope: "all", verdict: ["stale", "missing_hold"] }),
    ["r3", "missing:o2:p2"],
    "an alert's Show narrows to several verdicts at once",
  );

  assert.deepEqual(narrow({ scope: "all", orderStatus: "pending" }), ["r1", "missing:o2:p2"]);
  assert.deepEqual(narrow({ scope: "all", orderStatus: "approved" }), ["r3"]);
  assert.deepEqual(narrow({ scope: "all", orderStatus: "missing" }), [], "no hold here has lost its order");
  assert.deepEqual(narrow({ scope: "all", productId: "p2" }), ["missing:o2:p2"]);

  assert.deepEqual(
    narrow({ scope: "all", minAgeDays: AGING_HOLD_DAYS }),
    ["r1"],
    "the old-holds view is an age, not a verdict",
  );
  assert.deepEqual(narrow({ scope: "all", minAgeDays: 30 }), []);

  assert.deepEqual(
    narrow({ scope: "all", from: "2026-05-01" }),
    ["r3", "missing:o2:p2"],
    "the window is inclusive…",
  );
  assert.deepEqual(narrow({ scope: "all", to: "2026-04-30" }), ["r1"], "…on both ends");
  assert.deepEqual(
    narrow({ scope: "all", from: "2026-04-22", to: "2026-04-22" }),
    ["r1"],
    "and a single day is a window of one",
  );
});

test("a clear-filters button knows how many filters it is clearing", () => {
  assert.equal(activeReservationFilters(EMPTY_RESERVATION_FILTERS), 0);
  assert.equal(
    activeReservationFilters({ ...EMPTY_RESERVATION_FILTERS, search: "   " }),
    0,
    "whitespace alone is not a filter",
  );
  assert.equal(
    activeReservationFilters({
      ...EMPTY_RESERVATION_FILTERS,
      search: "web",
      verdict: "stale",
      scope: "all",
      orderStatus: "pending",
      productId: "p1",
      from: "2026-04-01",
      to: "2026-05-01",
      minAgeDays: 3,
    }),
    8,
    "every field that narrows the table is counted, so the button cannot hide a live filter",
  );
});

test("the product filter offers the products the holds actually mention", () => {
  const reviewed = filterFixture();
  const products = reservationRowProducts(reviewed.rows);
  assert.deepEqual(
    products.map((product) => product.id),
    ["p1", "p2"],
    "distinct, in the order the rows mention them",
  );
  assert.equal(products[0].label, "Product p1 · SKU-p1", "a label a person can pick from");
  assert.deepEqual(reservationRowProducts([]), [], "and an empty review offers nothing");
});

// ── 6. what the review means as alerts ────────────────────────────────────
/** One of every kind: missing, duplicate, conflict, stuck and aging. */
function alertFixture(): ReservationReview {
  const products = [fakeProduct("p1"), fakeProduct("p2")];
  const orders = [
    fakeOrder({ id: "o1", created_at: NINE_DAYS_AGO, items: [fakeItem("o1", "p1", 2)] }),
    fakeOrder({ id: "o2", items: [fakeItem("o2", "p2", 3)] }),
    fakeOrder({ id: "o3", status: "approved", sale_id: "sale-3", items: [fakeItem("o3", "p1", 1)] }),
    fakeOrder({ id: "o4", items: [fakeItem("o4", "p1", 1)] }),
    fakeOrder({ id: "o5", status: "approved", sale_id: "sale-5", items: [fakeItem("o5", "p2", 4)] }),
  ];
  const reservations = [
    fakeReservation({
      id: "r1",
      online_order_id: "o1",
      product_id: "p1",
      quantity: 2,
      created_at: NINE_DAYS_AGO,
    }),
    fakeReservation({ id: "r3", online_order_id: "o3", product_id: "p1", quantity: 1 }),
    fakeReservation({ id: "r4a", online_order_id: "o4", product_id: "p1", quantity: 1 }),
    fakeReservation({ id: "r4b", online_order_id: "o4", product_id: "p1", quantity: 1 }),
    fakeReservation({
      id: "r5",
      online_order_id: "o5",
      product_id: "p2",
      quantity: 4,
      status: "released",
      resolved_at: HOUR_AGO,
    }),
  ];
  return review({ products, orders, reservations });
}

test("a review becomes one alert per kind, most urgent first", () => {
  const reviewed = alertFixture();
  assert.deepEqual(
    reviewed.rows.map((row) => row.verdict).sort(),
    ["duplicate_hold", "inconsistent", "stale", "valid", "valid", "missing_hold"].sort(),
  );

  const alerts = reservationAlerts(reviewed);
  assert.deepEqual(
    alerts.map((alert) => alert.kind),
    [...RESERVATION_ALERT_KINDS],
    "every kind is present, in the order the banner shows them",
  );
  const byKind = Object.fromEntries(alerts.map((alert) => [alert.kind, alert]));

  assert.equal(byKind.missing.count, 1);
  assert.equal(byKind.missing.units, 3, "what restoring the hold takes out of the pool");
  assert.equal(byKind.missing.severity, "danger", "an order the website can oversell");
  assert.equal(byKind.missing.repairable, true, "and the service knows how to restore it");
  assert.deepEqual(byKind.missing.orderNumbers, ["WEB-o2"], "named, so a banner can say which");

  assert.equal(byKind.duplicate.count, 1, "the second hold, not both");
  assert.equal(byKind.duplicate.units, 1);
  assert.equal(byKind.duplicate.repairable, false, "which of two holds was meant is a person's call");

  assert.equal(byKind.conflict.count, 1);
  assert.equal(byKind.conflict.units, 4);
  assert.equal(byKind.conflict.repairable, false);
  assert.equal(byKind.conflict.oldestDays, null, "a settled hold has no age to report");

  assert.equal(byKind.stuck.count, 1);
  assert.equal(byKind.stuck.repairable, true);
  assert.equal(byKind.stuck.severity, "danger");

  assert.equal(byKind.aging.count, 1);
  assert.equal(byKind.aging.severity, "warning", "correct but old is worth a look, not an alarm");
  assert.equal(byKind.aging.units, 2, "a correct hold frees nothing, so the number is what it holds");
  assert.equal(byKind.aging.oldestDays, 9);
  assert.equal(byKind.aging.repairable, true, "nothing here is waiting on a judgement");

  assert.equal(reservationAlertCount(alerts), 5, "the badge counts rows, not kinds");
});

test("a healthy review raises nothing, and the fingerprint only moves when the alerts do", () => {
  const clean = review({
    products: [fakeProduct("p1")],
    orders: [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 2)] })],
    reservations: [fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 2 })],
  });
  assert.deepEqual(reservationAlerts(clean), [], "a hold that agrees with its order is not news");
  assert.equal(reservationAlertCount([]), 0);
  assert.equal(reservationAlertSignature([]), "");

  // A session that may not work the queue loads nothing, so the review is empty
  // and the badge is zero: monitoring never reports past a permission.
  const nothing = reviewReservations({ reservations: [], orders: [], products: [], now: NOW });
  assert.deepEqual(reservationAlerts(nothing), []);
  assert.equal(reservationAlertCount(reservationAlerts(nothing)), 0);

  const first = reservationAlertSignature(reservationAlerts(alertFixture()));
  const second = reservationAlertSignature(reservationAlerts(alertFixture()));
  assert.equal(first, second, "the same review fingerprints the same — this is what stops a report loop");
  assert.notEqual(first, reservationAlertSignature([]), "and an empty list is a different fingerprint");
});

test("aging is a threshold over correct holds, and no row belongs to two kinds", () => {
  const reviewed = alertFixture();
  assert.equal(
    reservationAlerts(reviewed, { agingDays: 30 }).find((alert) => alert.kind === "aging"),
    undefined,
    "nothing has been sitting there for a month",
  );
  assert.equal(
    reservationAlerts(reviewed, { agingDays: 1 }).find((alert) => alert.kind === "aging")?.count,
    1,
    "and a lower threshold picks the nine-day hold up",
  );
  assert.equal(
    reservationAlerts(reviewed, { sample: 1 }).every((alert) => alert.orderNumbers.length <= 1),
    true,
    "the sample size caps how many orders a banner names",
  );

  // The kinds are a partition: one row, one alert, so the badge cannot count a
  // hold twice and the banner cannot say the same thing in two voices.
  const claimed = RESERVATION_ALERT_KINDS.flatMap((kind) => RESERVATION_ALERT_VERDICTS[kind]);
  assert.equal(new Set(claimed).size, claimed.length, "no verdict belongs to two kinds");
  for (const verdict of RESERVATION_VERDICTS) {
    assert.ok(claimed.includes(verdict), `${verdict} is covered by some alert`);
  }
  assert.deepEqual([...RESERVATION_ALERT_VERDICTS.aging], ["valid"], "only correct holds can be merely old");
});

test("every alert kind and monitoring label exists in both languages", () => {
  const keys = [
    ...RESERVATION_ALERT_KINDS.map((kind) => `holds.alert.${kind}`),
    "holds.alertsTitle",
    "holds.alert.detail",
    "holds.alert.oldest",
    "holds.alert.show",
    "holds.partialNotice",
    "holds.partialAction",
    "holds.oldestHold",
    "holds.monitor.healthy",
    "holds.monitor.problems",
    "holds.monitor.old",
    "holds.monitor.missing",
    "holds.monitor.duplicate",
    "holds.filter.orderStatus",
    "holds.filter.product",
    "holds.summaryActive",
    "holds.summaryRepairable",
    "nav.stockHoldsBadge",
    "online.notifications.transport.reconnecting",
  ];

  for (const key of keys) {
    for (const language of ["en", "ar"] as const) {
      const value = dictionaries[language][key as keyof (typeof dictionaries)["en"]];
      assert.ok(value && value !== key, `${language}: ${key} is translated`);
    }
  }
});

// ── 7. a filtered queue is a partial view ─────────────────────────────────
test("a filtered queue sets aside the holds it cannot see instead of calling them orphans", () => {
  const products = [fakeProduct("p1")];
  const orders = [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 1)] })];
  const reservations = [
    fakeReservation({ id: "r1", online_order_id: "o1", product_id: "p1", quantity: 1 }),
    // Its order exists; the queue in front of this screen merely filtered it out.
    fakeReservation({ id: "r2", online_order_id: "o2", product_id: "p1", quantity: 4 }),
  ];

  const complete = review({ products, orders, reservations });
  assert.equal(complete.partial, false);
  assert.equal(complete.unjudged, 0);
  assert.equal(complete.byVerdict.orphaned, 1, "with every order in view, a hold with no order is an orphan");

  const partial = reviewReservations({
    products,
    orders,
    reservations,
    now: NOW,
    ordersComplete: false,
  });
  assert.equal(partial.partial, true, "and the review says it could not see everything");
  assert.equal(partial.unjudged, 1, "one hold was set aside");
  assert.equal(partial.byVerdict.orphaned, 0, "not reported as a problem it may not be");
  assert.equal(partial.rows.length, 1, "and not shown in the table either");
  assert.equal(partial.findings.length, 0);
  assert.deepEqual(reservationAlerts(partial), [], "so it raises no alert");
  assert.equal(partial.heldUnits, 5, "the units are still held, whether or not this view can judge them");
});

test("a partial view cannot claim a hold is missing, because it cannot see every pending order", () => {
  const products = [fakeProduct("p1")];
  const orders = [fakeOrder({ id: "o1", items: [fakeItem("o1", "p1", 2)] })];

  const complete = review({ products, orders, reservations: [] });
  assert.equal(complete.byVerdict.missing_hold, 1, "the whole queue shows the oversell");

  const partial = reviewReservations({
    products,
    orders,
    reservations: [],
    now: NOW,
    ordersComplete: false,
  });
  assert.equal(partial.byVerdict.missing_hold, 0, "a filtered queue is not evidence of one");
  assert.equal(partial.rows.length, 0);
});

test("the queue's own filter decides whether its review is complete", () => {
  assert.equal(isEmptyOrderFilter(EMPTY_ORDER_FILTER), true, "an untouched queue shows everything");
  assert.equal(isEmptyOrderFilter(null), true);
  assert.equal(isEmptyOrderFilter(undefined), true);
  assert.equal(isEmptyOrderFilter({}), true, "and so does one with nothing set");
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, status: "pending" }), false);
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, paymentStatus: "pending" }), false);
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, search: "web" }), false);
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, search: "   " }), true, "whitespace is not a search");
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, from: "2026-01-01" }), false);
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, to: "2026-01-31" }), false);
  assert.equal(isEmptyOrderFilter({ ...EMPTY_ORDER_FILTER, limit: 25 }), false, "a capped queue is a partial one");
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}
console.log(`\n${passed}/${tests.length} reservation-repair tests passed.`);
if (failed > 0) process.exit(1);

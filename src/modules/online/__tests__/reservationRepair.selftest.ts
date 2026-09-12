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
import { getDemoOnlineRepository, resetDemoOnlineRepository } from "../data/demoRepository";
import { availableToPromise, reservedByProduct, reservedOf, totalReserved } from "../services/availability";
import {
  AGING_HOLD_DAYS,
  RESERVATION_VERDICTS,
  assertCanRepairReservations,
  heldByProduct,
  mayRepairReservations,
  repairAllFindings,
  repairFinding,
  repairHold,
  restoreHold,
  reviewReservations,
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

async function auditRows(): Promise<{ action: AuditAction; entity: string; entity_id: string; details: Record<string, unknown>; user_name: string }[]> {
  const entries = await getDemoAuditRepository().listEntries();
  return entries
    .filter((entry) => entry.entity === "reservation")
    .map((entry) => ({
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entity_id,
      details: entry.details as Record<string, unknown>,
      user_name: entry.user_name,
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
  assert.equal(second.verdict, "inconsistent");
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
  assert.equal(RESERVATION_VERDICTS.length, 8);

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

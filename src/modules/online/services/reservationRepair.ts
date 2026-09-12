/**
 * Stock-hold reconciliation (Phase 15).
 *
 * A website order holds stock while it is pending: `place_online_order` writes a
 * `reserved` row per tracked line, approving converts it (the POS sale takes the
 * units), cancelling releases it. Availability is then
 * `stock_quantity − Σ reserved`, which is what stops the shop overselling between
 * checkout and approval.
 *
 * That model has one weakness, and it is not hypothetical: the resolution is a
 * second statement after the transition, so anything that interrupts between the
 * two — a dropped connection, a closed tab, a hand-edited row, a product whose
 * stock tracking was switched on *after* the order was placed — leaves a hold
 * behind. The units stay out of the pool forever, the website understates what it
 * can sell, and nobody can see why. The mirror case is just as bad: a pending
 * order holding *nothing*, which promises units the shop does not have.
 *
 * This module is the repair pass. Two halves:
 *
 *   · `reviewReservations()` — pure. Reads the holds, the orders and the
 *     catalogue that are already in memory and says, for each one, whether it is
 *     valid, stale, orphaned, mismatched or missing, and what the single safe
 *     repair is. It reuses `availability.ts` (`staleReservations`,
 *     `holdsReservation`, `reservedByProduct`, `totalReserved`) rather than
 *     restating its rules, so the review and the checkout cannot disagree about
 *     what a hold means.
 *   · `repairHold()` / `restoreHold()` — the funnels. They assert the capability,
 *     demand a reason, call the repository (demo: in place; live:
 *     `public.repair_stock_reservation`, migration 0025), and write one row to the
 *     existing audit trail.
 *
 * Three invariants, enforced here *and* in both repositories, because a repair
 * tool that can damage stock is worse than the bug it fixes:
 *
 *   1. **It never writes stock.** By the time a hold is wrong, the order's
 *      transition has already had its stock effect. A repair settles the hold's
 *      own row; moving `stock_quantity` again would be the double-count the
 *      reservation model exists to prevent.
 *   2. **It never double-releases.** Repeating a repair is a no-op that reports
 *      `alreadyResolved`; reversing one (releasing a converted hold, which would
 *      return units the sale already took) is refused outright.
 *   3. **It never invents a quantity.** A corrected quantity is the order line's
 *      own, checked against the order in both repositories.
 *
 * A finding this module will *not* repair automatically is reported with
 * `action: null` — a hold converted against an order that never became a sale,
 * or two open holds on one order line, for instance. Settling either way changes
 * what the shop can promise, and the right answer depends on the stock ledger,
 * so the screen says "needs a person" instead of guessing.
 */
import { assertSensitiveAction, mayPerform } from "@/lib/permissions/actions";
import { recordAudit } from "@/modules/audit/services/auditService";
import { AppError } from "@/modules/products/data/repository";
import type { Product } from "@/modules/products/types";
import { getCurrentUser } from "@/modules/inventory/permissions";
import { getOnlineOrdersRepository } from "../data";
import {
  holdsReservation,
  reservedByProduct,
  staleReservations,
  totalReserved,
} from "./availability";
import type {
  OnlineOrder,
  OnlineOrderStatus,
  ReservationRepairAction,
  ReservationStatus,
  StockReservation,
} from "../types";

/** What the review concluded about one hold (or one hold that should exist). */
export const RESERVATION_VERDICTS = [
  /** Status, quantity and order all agree. Nothing to do. */
  "valid",
  /** Still holding, but the order moved on — the units are counted twice or hidden. */
  "stale",
  /** Still holding, and the order behind it no longer exists. */
  "orphaned",
  /** Holding a different number of units than the order line asks for. */
  "quantity_mismatch",
  /** Holding a product the order does not contain. */
  "unexpected_hold",
  /** Settled, but missing the timestamp the schema requires. */
  "unresolved",
  /** Settled in a direction its order contradicts — needs a person, not a button. */
  "inconsistent",
  /** A pending order line with no hold at all: an oversell waiting to happen. */
  "missing_hold",
] as const;
export type ReservationVerdict = (typeof RESERVATION_VERDICTS)[number];

/** How loudly the screen should say it. */
export type ReservationSeverity = "ok" | "info" | "warning" | "danger";

const SEVERITY: Record<ReservationVerdict, ReservationSeverity> = {
  valid: "ok",
  stale: "danger",
  orphaned: "danger",
  missing_hold: "danger",
  inconsistent: "danger",
  quantity_mismatch: "warning",
  unexpected_hold: "warning",
  unresolved: "info",
};

/** Days after which an open hold is worth mentioning even when it is correct. */
export const AGING_HOLD_DAYS = 3;

export interface ReservationReviewRow {
  /** Reservation id, or `missing:<order>:<product>` for a hold that does not exist. */
  key: string;
  reservation: StockReservation | null;
  order: OnlineOrder | null;
  orderNumber: string;
  orderStatus: OnlineOrderStatus | "missing";
  product: { id: string; sku: string; nameEn: string; nameAr: string; tracked: boolean } | null;
  /** Units the hold keeps out of the pool right now (0 for a missing hold). */
  held: number;
  /** Units the order line asks for — what the hold should say. */
  expected: number;
  status: ReservationStatus | "missing";
  createdAt: string | null;
  resolvedAt: string | null;
  /** Already applied (converted) or given back (released). */
  resolved: boolean;
  /** Whole days the hold has been open; `null` once resolved or when undated. */
  ageDays: number | null;
  verdict: ReservationVerdict;
  severity: ReservationSeverity;
  /** The one safe repair, or `null` when a person has to decide. */
  action: ReservationRepairAction | null;
  /** What the repair would change, in units — for the confirmation copy. */
  unitsFreed: number;
}

export interface ReservationReview {
  /** Every hold, plus every hold that should exist but does not. */
  rows: ReservationReviewRow[];
  /** `rows` without the healthy ones — what the repair button works on. */
  findings: ReservationReviewRow[];
  /** Findings this module will repair; the rest need a person. */
  repairable: ReservationReviewRow[];
  healthy: number;
  /** Units held across the shop right now. */
  heldUnits: number;
  /** Units held by findings — what a full repair would give back or re-hold. */
  affectedUnits: number;
  byVerdict: Record<ReservationVerdict, number>;
  /** Open holds older than {@link AGING_HOLD_DAYS}, correct or not. */
  aging: number;
}

const DAY_MS = 86_400_000;

function emptyVerdictCounts(): Record<ReservationVerdict, number> {
  return Object.fromEntries(RESERVATION_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    ReservationVerdict,
    number
  >;
}

/** Units of one product an order's lines ask for, or `null` when it is not in the order. */
function orderedQuantity(order: OnlineOrder, productId: string): number | null {
  let total = 0;
  let found = false;
  for (const item of order.items ?? []) {
    if (item.product_id !== productId) continue;
    found = true;
    total += Math.max(0, Math.trunc(item.quantity ?? 0));
  }
  return found ? total : null;
}

function productOf(
  products: readonly Product[],
  productId: string,
): ReservationReviewRow["product"] {
  const product = products.find((candidate) => candidate.id === productId);
  if (!product) {
    return { id: productId, sku: "—", nameEn: "Unknown product", nameAr: "منتج غير معروف", tracked: false };
  }
  return {
    id: product.id,
    sku: product.sku,
    nameEn: product.name_en,
    nameAr: product.name_ar,
    tracked: product.stock_tracking_enabled !== false,
  };
}

/**
 * Read every hold against its order and the catalogue, and say what is wrong.
 *
 * Pure on purpose: the screen, the tests and the bulk repair all call the same
 * function, so what the operator sees is exactly what the repair will act on.
 */
export function reviewReservations(input: {
  reservations: readonly StockReservation[];
  orders: readonly OnlineOrder[];
  products: readonly Product[];
  now?: Date;
}): ReservationReview {
  const now = input.now ?? new Date();
  const ordersById = new Map(input.orders.map((order) => [order.id, order]));
  const rows: ReservationReviewRow[] = [];
  const byVerdict = emptyVerdictCounts();

  // `staleReservations` is the existing definition of "an order that can no
  // longer hold stock is still holding it" — reused, not restated.
  const staleIds = new Set(
    staleReservations(input.reservations, input.orders).map((reservation) => reservation.id),
  );

  // Order lines that already carry an open hold, in input order: the first hold
  // on a line is judged on its own merits and any later one is the anomaly.
  const openLines = new Set<string>();

  for (const reservation of input.reservations) {
    const order = ordersById.get(reservation.online_order_id) ?? null;
    const expected = order ? orderedQuantity(order, reservation.product_id) : null;
    const resolved = reservation.status !== "reserved";
    const created = reservation.created_at ? new Date(reservation.created_at) : null;
    const ageDays =
      !resolved && created && !Number.isNaN(created.getTime())
        ? Math.max(0, Math.floor((now.getTime() - created.getTime()) / DAY_MS))
        : null;

    let verdict: ReservationVerdict = "valid";
    // Typed as the full union even though this loop never picks "hold": the
    // missing-hold pass below does, and both feed the same row shape.
    let action: ReservationRepairAction | null = null;

    if (!order) {
      // Nothing to compare it with, and nothing that can ever resolve it.
      verdict = reservation.status === "reserved" ? "orphaned" : "valid";
      action = verdict === "orphaned" ? "release" : null;
    } else if (reservation.status === "reserved") {
      const line = `${reservation.online_order_id}:${reservation.product_id}`;
      if (staleIds.has(reservation.id) || !holdsReservation(order.status)) {
        // The order moved on. Whether the units were taken is decided by whether
        // it became a sale and was not then cancelled: a cancelled order's sale is
        // voided and its stock restored, so its hold belongs back in the pool.
        verdict = "stale";
        action = order.sale_id && order.status !== "cancelled" ? "convert" : "release";
      } else if (openLines.has(line)) {
        // A second open hold on one order line hides the same units twice, so the
        // website understates what it can sell by more than the order deserves.
        // Releasing either row would be a guess about which one the workflow
        // meant, and a reconcile cannot express "these two are really one" — so
        // this is the one finding the pass refuses to settle for anybody.
        verdict = "inconsistent";
        action = null;
      } else {
        openLines.add(line);
        if (expected === null) {
          verdict = "unexpected_hold";
          action = "release";
        } else if (expected !== reservation.quantity) {
          verdict = "quantity_mismatch";
          action = "reconcile";
        }
      }
    } else if (reservation.resolved_at === null) {
      verdict = "unresolved";
      action = "reconcile";
    } else if (
      // Settled the wrong way round: a converted hold on an order that never
      // became a sale, or a released hold on one that did. Either way the pool and
      // the ledger disagree, and which side is wrong is a stock question — so this
      // is reported, never guessed at.
      (reservation.status === "converted" && !order.sale_id) ||
      (reservation.status === "released" && Boolean(order.sale_id) && order.status !== "cancelled")
    ) {
      verdict = "inconsistent";
      action = null;
    }

    // What the repair would move in the promiseable pool: the whole hold for a
    // release or a conversion, the difference for a reconcile. ("hold" never
    // reaches this branch — a missing hold is added by the pass below.)
    const unitsFreed =
      verdict === "valid"
        ? 0
        : action === "reconcile"
          ? Math.abs((expected ?? reservation.quantity) - reservation.quantity)
          : reservation.quantity;

    rows.push({
      key: reservation.id,
      reservation,
      order,
      orderNumber: order?.order_number ?? "—",
      orderStatus: order?.status ?? "missing",
      product: productOf(input.products, reservation.product_id),
      held: reservation.status === "reserved" ? reservation.quantity : 0,
      expected: expected ?? 0,
      status: reservation.status,
      createdAt: reservation.created_at ?? null,
      resolvedAt: reservation.resolved_at ?? null,
      resolved,
      ageDays,
      verdict,
      severity: SEVERITY[verdict],
      action,
      unitsFreed,
    });
    byVerdict[verdict] += 1;
  }

  // The other half of the review: a pending order line with no open hold is an
  // oversell waiting to happen, and it has no row of its own to appear above.
  const openHolds = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "reserved")
      .map((reservation) => `${reservation.online_order_id}:${reservation.product_id}`),
  );
  const tracked = new Set(
    input.products
      .filter((product) => product.stock_tracking_enabled !== false)
      .map((product) => product.id),
  );

  for (const order of input.orders) {
    if (!holdsReservation(order.status)) continue;
    // Per product, not per line. An order can carry the same product twice, and
    // `orderedQuantity` — which both repositories restore against — sums those
    // lines. A review that reported only the first would ask for fewer units than
    // the repair then holds, and the operator would see a number the store never
    // writes.
    const wanted = new Map<string, number>();
    for (const item of order.items ?? []) {
      if (!tracked.has(item.product_id)) continue;
      const quantity = Math.max(0, Math.trunc(item.quantity ?? 0));
      if (quantity <= 0) continue;
      wanted.set(item.product_id, (wanted.get(item.product_id) ?? 0) + quantity);
    }
    for (const [productId, quantity] of wanted) {
      // One finding per order line: an existing open hold already covers it, and
      // two identical rows would repair the same thing twice.
      if (openHolds.has(`${order.id}:${productId}`)) continue;
      rows.push({
        key: `missing:${order.id}:${productId}`,
        reservation: null,
        order,
        orderNumber: order.order_number,
        orderStatus: order.status,
        product: productOf(input.products, productId),
        held: 0,
        expected: quantity,
        status: "missing",
        createdAt: order.created_at ?? null,
        resolvedAt: null,
        resolved: false,
        ageDays: order.created_at
          ? Math.max(0, Math.floor((now.getTime() - new Date(order.created_at).getTime()) / DAY_MS))
          : null,
        verdict: "missing_hold",
        severity: SEVERITY.missing_hold,
        action: "hold",
        unitsFreed: quantity,
      });
      byVerdict.missing_hold += 1;
    }
  }

  const findings = rows.filter((row) => row.verdict !== "valid");
  return {
    rows,
    findings,
    repairable: findings.filter((row) => row.action !== null),
    healthy: rows.length - findings.length,
    heldUnits: totalReserved(input.reservations),
    affectedUnits: findings.reduce((sum, row) => sum + row.unitsFreed, 0),
    byVerdict,
    aging: rows.filter((row) => (row.ageDays ?? 0) >= AGING_HOLD_DAYS && !row.resolved).length,
  };
}

/** Units of each product the reviewed holds keep out of the pool. */
export function heldByProduct(reservations: readonly StockReservation[]): Map<string, number> {
  return reservedByProduct(reservations);
}

/* ── authority ─────────────────────────────────────────────────────────────── */

/**
 * Repairing a hold needs `adjust_stock`.
 *
 * Not `manage_online_orders`: working the queue is till work, and a cashier holds
 * it. Settling a hold changes what the whole shop can promise to sell — the same
 * consequence as writing the stock ledger — so it asks for the same authority the
 * ledger asks for, which the till seat does not have. Live mode checks it again in
 * `public.repair_stock_reservation`, so the refusal does not depend on this file.
 */
export function assertCanRepairReservations(): void {
  assertSensitiveAction("reservation.repair");
}

/** The same question as a boolean, for a button that should be hidden. */
export function mayRepairReservations(): boolean {
  return mayPerform("reservation.repair");
}

/* ── the funnels ───────────────────────────────────────────────────────────── */

export interface RepairOutcome {
  row: ReservationReviewRow;
  reservation: StockReservation;
  /** True when the row was already settled this way and nothing was written. */
  alreadyResolved: boolean;
}

export interface RepairBatchOutcome {
  repaired: RepairOutcome[];
  /** Already settled — nothing written, nothing to worry about. */
  skipped: RepairOutcome[];
  /** Refused or failed, with the message the operator needs. */
  failed: { row: ReservationReviewRow; message: string }[];
  /** Findings that need a person; the batch leaves them alone. */
  manual: ReservationReviewRow[];
}

function requireReason(reason: string | null | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 3) {
    // The same insistence the refund settlement makes, and for the same reason:
    // this changes what the shop can sell, so the trail has to say why.
    throw new AppError("VALIDATION", "A reason is required to repair a stock hold");
  }
  return trimmed;
}

function auditActionFor(action: ReservationRepairAction):
  | "reservation.released"
  | "reservation.converted"
  | "reservation.reconciled"
  | "reservation.held" {
  switch (action) {
    case "release":
      return "reservation.released";
    case "convert":
      return "reservation.converted";
    case "hold":
      return "reservation.held";
    default:
      return "reservation.reconciled";
  }
}

/** One audit row per repair — the existing trail, the existing repository. */
async function auditRepair(args: {
  action: ReservationRepairAction;
  row: ReservationReviewRow;
  reservation: StockReservation;
  alreadyResolved: boolean;
  reason: string;
  before: { status: ReservationStatus; quantity: number };
}): Promise<void> {
  await recordAudit({
    action: auditActionFor(args.action),
    entity: "reservation",
    entity_id: args.reservation.id,
    entity_label: args.row.orderNumber !== "—" ? args.row.orderNumber : args.reservation.product_id,
    details: {
      repair: args.action,
      order: args.row.orderNumber,
      order_status: args.row.orderStatus,
      product: args.row.product?.nameEn ?? null,
      sku: args.row.product?.sku ?? null,
      verdict: args.row.verdict,
      status_before: args.before.status,
      status_after: args.reservation.status,
      quantity_before: args.before.quantity,
      quantity_after: args.reservation.quantity,
      // A repair moves availability, never stock: the number worth recording is
      // how many units it put back in (or took out of) the promiseable pool.
      units_changed: args.reservation.quantity - args.before.quantity,
      already_resolved: args.alreadyResolved,
      reason: args.reason,
    },
  });
}

/**
 * Settle one hold: release it, convert it, or reconcile its quantity.
 *
 * The screen passes the row its own review produced, so the action is the one the
 * review concluded was safe — but the repositories check it again, because a
 * hand-built request must not be able to reverse a resolution.
 */
export async function repairHold(
  row: ReservationReviewRow,
  reason: string | null,
): Promise<RepairOutcome> {
  assertCanRepairReservations();
  const trimmed = requireReason(reason);
  if (!row.reservation) {
    throw new AppError("VALIDATION", "There is no hold to repair — restore it instead");
  }
  const action = row.action;
  if (action === null || action === "hold") {
    throw new AppError(
      "VALIDATION",
      action === "hold"
        ? "This finding needs a restored hold, not a repair"
        : "This hold needs a person: settling it either way would change what the shop can promise",
    );
  }

  const repository = getOnlineOrdersRepository();
  const result = await repository.repairReservation(row.reservation.id, {
    action,
    quantity: action === "reconcile" ? row.expected : null,
    reason: trimmed,
    user_id: getCurrentUser().id,
    user_name: getCurrentUser().name,
  });

  await auditRepair({
    action,
    row,
    reservation: result.reservation,
    alreadyResolved: result.alreadyResolved,
    reason: trimmed,
    before: { status: result.before.status, quantity: result.before.quantity },
  });

  return { row, reservation: result.reservation, alreadyResolved: result.alreadyResolved };
}

/** Restore the hold a pending order line lost. */
export async function restoreHold(
  row: ReservationReviewRow,
  reason: string | null,
): Promise<RepairOutcome> {
  assertCanRepairReservations();
  const trimmed = requireReason(reason);
  if (row.action !== "hold" || !row.order || !row.product) {
    throw new AppError("VALIDATION", "Only a missing hold can be restored");
  }

  const repository = getOnlineOrdersRepository();
  const reservation = await repository.reserveStockForOrder({
    online_order_id: row.order.id,
    product_id: row.product.id,
    quantity: row.expected,
    reason: trimmed,
    user_id: getCurrentUser().id,
    user_name: getCurrentUser().name,
  });

  await auditRepair({
    action: "hold",
    row,
    reservation,
    // An existing open hold comes back unchanged rather than being duplicated.
    alreadyResolved: reservation.quantity === row.held && row.held > 0,
    reason: trimmed,
    before: { status: "reserved", quantity: row.held },
  });

  return { row, reservation, alreadyResolved: false };
}

/** Repair one finding, whichever kind it is. */
export async function repairFinding(
  row: ReservationReviewRow,
  reason: string | null,
): Promise<RepairOutcome> {
  return row.action === "hold" ? restoreHold(row, reason) : repairHold(row, reason);
}

/**
 * Repair everything the review can repair, in one pass.
 *
 * One row at a time, each with its own audit entry, and a failure is collected
 * rather than thrown — halfway through a batch is exactly when an operator needs
 * to see which hold refused and why, not a dialog that says "error". Findings
 * marked `action: null` are returned untouched for a person to judge.
 */
export async function repairAllFindings(
  review: ReservationReview,
  reason: string | null,
): Promise<RepairBatchOutcome> {
  assertCanRepairReservations();
  const trimmed = requireReason(reason);
  const outcome: RepairBatchOutcome = { repaired: [], skipped: [], failed: [], manual: [] };

  for (const row of review.findings) {
    if (row.action === null) {
      outcome.manual.push(row);
      continue;
    }
    try {
      const result = await repairFinding(row, trimmed);
      if (result.alreadyResolved) outcome.skipped.push(result);
      else outcome.repaired.push(result);
    } catch (error) {
      outcome.failed.push({
        row,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

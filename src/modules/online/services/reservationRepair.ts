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
  /**
   * A second open hold on one order line, so the same units are hidden twice and
   * the website understates what it can sell by more than the order deserves.
   * Its own verdict rather than a flavour of `inconsistent` because the two read
   * differently at a glance: this one is a write that happened twice, that one is
   * a settlement the ledger contradicts. Neither is safe to settle automatically.
   */
  "duplicate_hold",
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
  duplicate_hold: "danger",
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
  /**
   * Phase 43: the exact combination held, frozen from the order line — null for
   * a product-level hold. Two holds on one product can be perfectly healthy
   * when they hold different shelves; the screen must say which is which.
   */
  variant: {
    colorEn: string | null;
    colorAr: string | null;
    size: number | null;
    sizeLabel: string | null;
  } | null;
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
  /** Findings no automated remedy is safe for — the "needs a person" pile. */
  needsPerson: number;
  /**
   * The age of the oldest open hold in days, or `null` when nothing is held.
   * The one number that says how far behind the queue is: a shop with forty
   * correct holds from this morning and one from last Tuesday needs to see the
   * Tuesday one.
   */
  oldestDays: number | null;
  /** True when the order list was filtered, so some holds could not be judged. */
  partial: boolean;
  /** Holds set aside because their order was not in view. */
  unjudged: number;
}

const DAY_MS = 86_400_000;

function emptyVerdictCounts(): Record<ReservationVerdict, number> {
  return Object.fromEntries(RESERVATION_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    ReservationVerdict,
    number
  >;
}

/**
 * Units of one shelf — one (product, variant) pair — an order's lines ask for,
 * or `null` when no line matches. Since variants, a product line names a
 * combination: Gold / 17 and Silver / 17 on one order are two different pools,
 * and summing them would report an expected quantity no hold can match.
 */
function orderedQuantity(
  order: OnlineOrder,
  productId: string,
  variantId: string | null,
): number | null {
  let total = 0;
  let found = false;
  for (const item of order.items ?? []) {
    if (item.product_id !== productId) continue;
    if ((item.variant_id ?? null) !== variantId) continue;
    found = true;
    total += Math.max(0, Math.trunc(item.quantity ?? 0));
  }
  return found ? total : null;
}

/** The frozen combination of the first matching order line, or null. */
function orderedVariant(
  order: OnlineOrder,
  productId: string,
  variantId: string | null,
): ReservationReviewRow["variant"] {
  for (const item of order.items ?? []) {
    if (item.product_id !== productId) continue;
    if ((item.variant_id ?? null) !== variantId) continue;
    return {
      colorEn: item.variant_color_en,
      colorAr: item.variant_color_ar,
      size: item.variant_size,
      sizeLabel: item.variant_size_label,
    };
  }
  return null;
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
export interface ReservationReviewInput {
  reservations: readonly StockReservation[];
  orders: readonly OnlineOrder[];
  products: readonly Product[];
  now?: Date;
  /**
   * Whether `orders` is the whole queue, which is the default.
   *
   * The queue provider applies the screen's filter, and a hold whose order is
   * merely out of view is not an orphan — reporting it would send somebody to
   * repair a hold that is perfectly fine. With a partial list those rows are set
   * aside as `unjudged`, and the missing-hold pass is skipped because the pending
   * orders cannot be enumerated from a filtered list.
   */
  ordersComplete?: boolean;
}

export function reviewReservations(input: ReservationReviewInput): ReservationReview {
  const now = input.now ?? new Date();
  const ordersComplete = input.ordersComplete !== false;
  let unjudged = 0;
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
  // The key names the shelf, not just the product — Gold / 17 and Silver / 17
  // held by one order are two healthy holds, not a duplicate.
  const openLines = new Set<string>();

  for (const reservation of input.reservations) {
    const order = ordersById.get(reservation.online_order_id) ?? null;
    const variantId = reservation.variant_id ?? null;
    const expected = order ? orderedQuantity(order, reservation.product_id, variantId) : null;
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

    if (!order && !ordersComplete) {
      // Out of view is not the same as gone. Set the row aside rather than guess.
      unjudged += 1;
      continue;
    }

    if (!order) {
      // Nothing to compare it with, and nothing that can ever resolve it.
      verdict = reservation.status === "reserved" ? "orphaned" : "valid";
      action = verdict === "orphaned" ? "release" : null;
    } else if (reservation.status === "reserved") {
      const line = `${reservation.online_order_id}:${reservation.product_id}:${variantId ?? ""}`;
      if (staleIds.has(reservation.id) || !holdsReservation(order.status)) {
        // The order moved on. Whether the units were taken is decided by whether
        // it became a sale and was not then cancelled: a cancelled order's sale is
        // voided and its stock restored, so its hold belongs back in the pool.
        verdict = "stale";
        action = order.sale_id && order.status !== "cancelled" ? "convert" : "release";
      } else if (openLines.has(line)) {
        // A second open hold on one order line hides the same units twice.
        // Releasing either row would be a guess about which one the workflow
        // meant, and a reconcile cannot express "these two are really one" — so
        // this is reported for a person rather than settled.
        verdict = "duplicate_hold";
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
      variant: order ? orderedVariant(order, reservation.product_id, variantId) : null,
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
  // Only possible over the whole queue — a filtered list cannot say which pending
  // orders exist, so it cannot say which of them are holding nothing.
  const openHolds = new Set(
    input.reservations
      .filter((reservation) => reservation.status === "reserved")
      .map(
        (reservation) =>
          `${reservation.online_order_id}:${reservation.product_id}:${reservation.variant_id ?? ""}`,
      ),
  );
  const tracked = new Set(
    input.products
      .filter((product) => product.stock_tracking_enabled !== false)
      .map((product) => product.id),
  );

  for (const order of ordersComplete ? input.orders : []) {
    if (!holdsReservation(order.status)) continue;
    // Per product, not per line. An order can carry the same product twice, and
    // `orderedQuantity` — which both repositories restore against — sums those
    // lines. A review that reported only the first would ask for fewer units than
    // the repair then holds, and the operator would see a number the store never
    // writes.
    // Per shelf, not per line: lines for the same product but different
    // variants draw on different pools, so each (product, variant) pair gets its
    // own wanted total and its own missing-hold finding.
    const wanted = new Map<
      string,
      {
        productId: string;
        variantId: string | null;
        quantity: number;
        variant: ReservationReviewRow["variant"];
      }
    >();
    for (const item of order.items ?? []) {
      if (!tracked.has(item.product_id)) continue;
      const quantity = Math.max(0, Math.trunc(item.quantity ?? 0));
      if (quantity <= 0) continue;
      const shelfKey = `${item.product_id}:${item.variant_id ?? ""}`;
      const entry = wanted.get(shelfKey) ?? {
        productId: item.product_id,
        variantId: item.variant_id ?? null,
        quantity: 0,
        variant: null,
      };
      entry.quantity += quantity;
      if (!entry.variant) {
        entry.variant = {
          colorEn: item.variant_color_en,
          colorAr: item.variant_color_ar,
          size: item.variant_size,
          sizeLabel: item.variant_size_label,
        };
      }
      wanted.set(shelfKey, entry);
    }
    for (const [shelfKey, entry] of wanted) {
      // One finding per order shelf: an existing open hold already covers it, and
      // two identical rows would repair the same thing twice.
      if (openHolds.has(`${order.id}:${shelfKey}`)) continue;
      rows.push({
        key: `missing:${order.id}:${shelfKey}`,
        reservation: null,
        order,
        orderNumber: order.order_number,
        orderStatus: order.status,
        product: productOf(input.products, entry.productId),
        variant: entry.variant,
        held: 0,
        expected: entry.quantity,
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
        unitsFreed: entry.quantity,
      });
      byVerdict.missing_hold += 1;
    }
  }

  const findings = rows.filter((row) => row.verdict !== "valid");
  const openAges = rows
    .filter((row) => !row.resolved && row.ageDays !== null)
    .map((row) => row.ageDays as number);
  return {
    rows,
    findings,
    repairable: findings.filter((row) => row.action !== null),
    healthy: rows.length - findings.length,
    heldUnits: totalReserved(input.reservations),
    affectedUnits: findings.reduce((sum, row) => sum + row.unitsFreed, 0),
    byVerdict,
    aging: openAges.filter((days) => days >= AGING_HOLD_DAYS).length,
    needsPerson: findings.filter((row) => row.action === null).length,
    oldestDays: openAges.length > 0 ? Math.max(...openAges) : null,
    partial: !ordersComplete,
    unjudged,
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
  /**
   * The state the hold was in before the repair.
   *
   * `missing` is a legitimate previous state: restoring a hold a pending order
   * lost writes a row that did not exist, and an audit entry claiming it was
   * "reserved" beforehand would describe a change that never happened.
   */
  before: { status: ReservationStatus | "missing"; quantity: number; resolvedAt: string | null };
}): Promise<void> {
  await recordAudit({
    action: auditActionFor(args.action),
    entity: "reservation",
    entity_id: args.reservation.id,
    entity_label: args.row.orderNumber !== "—" ? args.row.orderNumber : args.reservation.product_id,
    details: {
      repair: args.action,
      order: args.row.orderNumber,
      // Ids beside the labels: the label is what a person reads in the log, the
      // id is what joins this row back to the order and the catalogue later.
      order_id: args.row.order?.id ?? null,
      order_status: args.row.orderStatus,
      product: args.row.product?.nameEn ?? null,
      product_id: args.row.product?.id ?? null,
      sku: args.row.product?.sku ?? null,
      verdict: args.row.verdict,
      // Previous state in full, then the new one, then what the move was worth.
      status_before: args.before.status,
      status_after: args.reservation.status,
      quantity_before: args.before.quantity,
      quantity_after: args.reservation.quantity,
      resolved_at_before: args.before.resolvedAt,
      // What the order actually asked for, so a corrected quantity can be checked
      // against the line it came from rather than taken on trust.
      expected_quantity: args.row.expected,
      // How long the hold had been sitting there: the same action after nine days
      // and after nine minutes is a different level of urgent.
      age_days: args.row.ageDays,
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
    before: {
      status: result.before.status,
      quantity: result.before.quantity,
      resolvedAt: result.before.resolved_at ?? null,
    },
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
    // The state before a hold that did not exist is "no hold", not "reserved":
    // an audit row claiming it was reserved before it was written describes a
    // change that never happened, and the whole point of the row is that a reader
    // can trust it. `row.status` is `missing` here by construction.
    before: { status: row.status, quantity: row.held, resolvedAt: null },
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

/* ── filters ─────────────────────────────────────────────────────────────────
 * Pure, and separate from the review, because the two answer different
 * questions: the review says what is wrong with the shop's holds, the filters say
 * which of them the operator is looking at right now. Keeping them apart is what
 * lets a filter change re-render a table without re-reading anything, and what
 * lets the filtering be tested without a repository.
 */

export interface ReservationFilters {
  /** Order number, SKU or either product name. */
  search: string;
  /**
   * Problem type: one verdict, a list of them (an alert covers several), or all.
   */
  verdict: ReservationVerdict | readonly ReservationVerdict[] | "all";
  /** Only the findings, or every hold including the healthy ones. */
  scope: "findings" | "all";
  /** The order's own status, or `missing` for a hold whose order is gone. */
  orderStatus: OnlineOrderStatus | "missing" | "all";
  productId: string | "all";
  /** Inclusive ISO dates (`yyyy-mm-dd`) against the day the hold was created. */
  from: string | null;
  to: string | null;
  /** Only holds at least this old, in days — the "old reservations" view. */
  minAgeDays: number | null;
}

export const EMPTY_RESERVATION_FILTERS: ReservationFilters = {
  search: "",
  verdict: "all",
  scope: "findings",
  orderStatus: "all",
  productId: "all",
  from: null,
  to: null,
  minAgeDays: null,
};

/**
 * How many filters are doing something.
 *
 * A "clear filters" button that appears when nothing is filtered is noise, and
 * one that hides while a date window is silently narrowing the table is worse.
 */
export function activeReservationFilters(filters: ReservationFilters): number {
  let active = 0;
  if (filters.search.trim()) active += 1;
  if (filters.verdict !== EMPTY_RESERVATION_FILTERS.verdict) active += 1;
  if (filters.scope !== EMPTY_RESERVATION_FILTERS.scope) active += 1;
  if (filters.orderStatus !== EMPTY_RESERVATION_FILTERS.orderStatus) active += 1;
  if (filters.productId !== EMPTY_RESERVATION_FILTERS.productId) active += 1;
  if (filters.from) active += 1;
  if (filters.to) active += 1;
  if (filters.minAgeDays !== null) active += 1;
  return active;
}

/**
 * The rows a set of filters leaves.
 *
 * Search matches either language without being told which one is on screen: an
 * operator in Arabic typing a Latin SKU and an operator in English typing an
 * Arabic name are both doing the same thing.
 */
export function filterReservationRows(
  rows: readonly ReservationReviewRow[],
  filters: ReservationFilters,
): ReservationReviewRow[] {
  const term = filters.search.trim().toLowerCase();
  const from = filters.from?.trim() || null;
  const to = filters.to?.trim() || null;

  return rows.filter((row) => {
    if (filters.scope === "findings" && row.verdict === "valid") return false;
    if (filters.verdict !== "all") {
      const wanted = Array.isArray(filters.verdict) ? filters.verdict : [filters.verdict];
      if (!wanted.includes(row.verdict)) return false;
    }
    if (filters.orderStatus !== "all" && row.orderStatus !== filters.orderStatus) return false;
    if (filters.productId !== "all" && (row.product?.id ?? "") !== filters.productId) return false;

    if (filters.minAgeDays !== null && (row.ageDays ?? -1) < filters.minAgeDays) return false;

    if (from || to) {
      const day = row.createdAt ? row.createdAt.slice(0, 10) : null;
      // A row with no creation date cannot be placed in a window. Leaving it out
      // is the honest answer — and it is a row that needs a person regardless.
      if (!day) return false;
      // ISO dates compare correctly as strings, which is the point of ISO dates.
      if (from && day < from) return false;
      if (to && day > to) return false;
    }

    if (term) {
      const haystack = [row.orderNumber, row.product?.sku, row.product?.nameEn, row.product?.nameAr]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }

    return true;
  });
}

/** The products a set of rows mentions, for a filter that only offers real choices. */
export function reservationRowProducts(
  rows: readonly ReservationReviewRow[],
): { id: string; label: string }[] {
  const seen = new Map<string, { id: string; label: string }>();
  for (const row of rows) {
    const product = row.product;
    if (!product || seen.has(product.id)) continue;
    seen.set(product.id, {
      id: product.id,
      label: product.sku === "—" ? product.nameEn : `${product.nameEn} · ${product.sku}`,
    });
  }
  return [...seen.values()];
}

/* ── alerts ──────────────────────────────────────────────────────────────────
 * An alert is a *reading*, not an event: it is derived from the same review the
 * screen shows, so the badge, the banner and the table can never disagree about
 * how many holds need attention. That is also why nothing here chimes or toasts
 * on its own — a stale hold is a state, and announcing a state every twenty
 * seconds teaches staff to ignore the announcement. The orders' own arrival keeps
 * the chime; holds get a number and a banner.
 *
 * The kinds do not overlap. Every unhealthy row is claimed by exactly one alert,
 * and `aging` covers only the rows that are otherwise correct — a hold that is
 * right but old is the abandoned-basket signal, and it would otherwise be
 * reported twice: once for its problem and once for its age.
 */

export const RESERVATION_ALERT_KINDS = [
  /** A pending order holding nothing: the website can oversell it. */
  "missing",
  /** Two open holds on one order line: the same units hidden twice. */
  "duplicate",
  /** A settlement the ledger contradicts. Needs a person. */
  "conflict",
  /** A hold its order left behind, or one that disagrees with its line. */
  "stuck",
  /** Correct, but sitting there: the order may have been abandoned. */
  "aging",
] as const;

export type ReservationAlertKind = (typeof RESERVATION_ALERT_KINDS)[number];

export interface ReservationAlert {
  kind: ReservationAlertKind;
  severity: "warning" | "danger";
  /** Rows this alert covers. */
  count: number;
  /** Units those rows keep out of the pool, or fail to keep in it. */
  units: number;
  /** The oldest row in the alert, in days — `null` when none of them is open. */
  oldestDays: number | null;
  /** Up to three order numbers, so a banner can name the problem. */
  orderNumbers: string[];
  /** True when every row has a remedy this module will apply. */
  repairable: boolean;
}

/**
 * Which verdicts each alert kind reports.
 *
 * Exported because the holds screen turns an alert's "show me" into exactly this
 * verdict filter. One mapping, or the alert and the table it opens would drift.
 */
export const RESERVATION_ALERT_VERDICTS: Record<ReservationAlertKind, readonly ReservationVerdict[]> = {
  missing: ["missing_hold"],
  duplicate: ["duplicate_hold"],
  conflict: ["inconsistent"],
  stuck: ["stale", "orphaned", "unexpected_hold", "quantity_mismatch", "unresolved"],
  /** Correct holds only, further narrowed by age in {@link reservationAlerts}. */
  aging: ["valid"],
};

export interface ReservationAlertOptions {
  /** Days after which a correct hold is worth mentioning. Defaults to {@link AGING_HOLD_DAYS}. */
  agingDays?: number;
  /** How many order numbers an alert carries for display. */
  sample?: number;
}

/**
 * The alerts a review implies, most urgent kind first.
 *
 * Pure and total: the same review always produces the same alerts, which is what
 * lets a child provider compute them once and hand them to the shell without the
 * two ever showing different numbers.
 */
export function reservationAlerts(
  reviewed: ReservationReview,
  options: ReservationAlertOptions = {},
): ReservationAlert[] {
  const agingDays = options.agingDays ?? AGING_HOLD_DAYS;
  const sample = options.sample ?? 3;
  const alerts: ReservationAlert[] = [];

  for (const kind of RESERVATION_ALERT_KINDS) {
    const verdicts = RESERVATION_ALERT_VERDICTS[kind];
    let rows = reviewed.rows.filter((row) => verdicts.includes(row.verdict));
    if (kind === "aging") {
      // Correct holds only, and only the ones that have been sitting there.
      rows = rows.filter(
        (row) => !row.resolved && (row.ageDays ?? 0) >= agingDays,
      );
    }
    if (rows.length === 0) continue;

    const ages = rows
      .filter((row) => row.ageDays !== null)
      .map((row) => row.ageDays as number);
    alerts.push({
      kind,
      severity: rows.some((row) => row.severity === "danger") ? "danger" : "warning",
      count: rows.length,
      // What a repair would move where one applies. A correct hold frees nothing,
      // so for those the number that matters is what it is sitting on — reporting
      // "0 units" for a week-old hold would hide the stock it keeps out of the pool.
      units: rows.reduce(
        (sum, row) => sum + (row.verdict === "valid" ? row.held : row.unitsFreed),
        0,
      ),
      oldestDays: ages.length > 0 ? Math.max(...ages) : null,
      orderNumbers: [...new Set(rows.map((row) => row.orderNumber))].slice(0, sample),
      // "Nothing here needs a human judgement." A valid row has no action because
      // it needs no repair at all, which is not the same as being stuck.
      repairable: rows.every((row) => row.verdict === "valid" || row.action !== null),
    });
  }

  return alerts;
}

/** How many rows every alert on a review covers — the number a badge carries. */
export function reservationAlertCount(alerts: readonly ReservationAlert[]): number {
  return alerts.reduce((sum, alert) => sum + alert.count, 0);
}

/**
 * A cheap fingerprint of an alert list.
 *
 * The queue provider reports its alerts up to the shell, and a report that fires
 * on every render would be a render loop. Comparing this string is what makes the
 * report happen only when an alert actually changed.
 */
export function reservationAlertSignature(alerts: readonly ReservationAlert[]): string {
  return alerts
    .map((alert) => `${alert.kind}:${alert.count}:${alert.units}:${alert.oldestDays ?? "-"}`)
    .join("|");
}

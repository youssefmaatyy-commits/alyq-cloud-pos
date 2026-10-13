/**
 * The online-order state machine.
 *
 * One table of legal moves, read by the POS screen (to decide which buttons to
 * enable), by the repositories (to refuse an illegal one) and by the tests. An
 * order may move forward through fulfilment, may be cancelled with a reason from
 * any unfinished state, and may never move backwards — because a customer
 * watching "ready" turn back into "processing" has no way to know whether their
 * order is coming.
 *
 * Money is a separate axis on purpose. `payment_status` moves on its own:
 *   pending → verification_required   the customer submitted an InstaPay proof
 *   verification_required → paid      an employee accepted it
 *   verification_required → failed    an employee rejected it (with a reason)
 *   failed → verification_required    the customer submitted a new proof
 * Nothing ever sets `paid` automatically. That rule is the whole point of the
 * InstaPay flow: a screenshot is a claim, not a transfer.
 */
import type {
  DeliveryType,
  OnlineOrder,
  OnlineOrderStatus,
  OnlinePaymentStatus,
  OrderAction,
} from "../types";
import { ORDER_ACTION_TO_STATUS } from "../types";

/** Why an action was refused. Keys, so the UI translates them. */
export type WorkflowRejection =
  | "not_pending"
  | "already_cancelled"
  | "already_completed"
  | "payment_unverified"
  | "payment_already_paid"
  | "sale_cancellation_disabled"
  | "backwards"
  | "not_approved"
  | "unknown";

export type WorkflowCheck =
  | { ok: true; next: OnlineOrderStatus }
  | { ok: false; reason: WorkflowRejection };

/** Forward moves for each status. Cancellation is handled separately. */
const FLOW: Record<OnlineOrderStatus, readonly OnlineOrderStatus[]> = {
  pending: ["approved"],
  approved: ["processing", "ready", "completed"],
  processing: ["ready", "completed"],
  ready: ["completed"],
  completed: [],
  cancelled: [],
};

/** What the fulfilment statuses are, in the order a customer expects them. */
export const FULFILMENT_ORDER: readonly OnlineOrderStatus[] = [
  "pending",
  "approved",
  "processing",
  "ready",
  "completed",
];

/** True while an order can still be cancelled. */
export function isOrderOpen(status: OnlineOrderStatus): boolean {
  return status !== "completed" && status !== "cancelled";
}

/** True when the order is finished either way. */
export function isOrderClosed(status: OnlineOrderStatus): boolean {
  return status === "completed" || status === "cancelled";
}

/** 0…4 for the stepper, or null for a cancelled order (no progress to show). */
export function orderProgress(status: OnlineOrderStatus): number | null {
  if (status === "cancelled") return null;
  return FULFILMENT_ORDER.indexOf(status);
}

/**
 * Which actions the POS may offer for this order, given what the user may do.
 *
 * Everything offered here is an action `checkAction` would accept, so a button on
 * the screen is never a button that fails.
 */
export function availableActions(
  order: OnlineOrder,
  abilities: { canConfirmPayment: boolean },
): OrderAction[] {
  const actions: OrderAction[] = [];

  if (order.status === "pending" && checkAction(order, "approve").ok) {
    // An InstaPay order whose money nobody has confirmed cannot be approved — the
    // button would only ever fail. The employee is offered "Approve payment"
    // instead, and approval follows verification. `checkAction` stays the
    // authority; this just stops the UI advertising a refused action.
    actions.push("approve");
  }
  if (isOrderOpen(order.status)) {
    actions.push("cancel");
    if (order.status === "approved") actions.push("processing");
    if (order.status === "approved" || order.status === "processing") actions.push("ready");
    if (order.status !== "completed") actions.push("complete");
  }
  if (
    abilities.canConfirmPayment &&
    order.status !== "cancelled" &&
    order.payment_status !== "paid"
  ) {
    actions.push("payment_approve", "payment_reject");
  }
  // An order that already became a sale cannot be cancelled: completed-sale
  // cancellation is disabled (migration 0095). Its correction is a sales return.
  if (order.sale_id !== null) {
    const index = actions.indexOf("cancel");
    if (index >= 0) actions.splice(index, 1);
  }
  return actions;
}

/**
 * May this action be performed on this order?
 *
 * Cancelling an order that already became a sale is refused for everybody:
 * completed-sale cancellation is disabled (migration 0095). A pending order can
 * still be cancelled, which releases its holds.
 */
export function checkAction(
  order: OnlineOrder,
  action: OrderAction,
): WorkflowCheck {
  if (order.status === "cancelled" && action !== "cancel") {
    return { ok: false, reason: "already_cancelled" };
  }

  switch (action) {
    case "approve": {
      if (order.status !== "pending") return { ok: false, reason: "not_pending" };
      // Unverified money never becomes a sale: approving would deduct stock and
      // book revenue against a transfer nobody has confirmed.
      if (order.payment_method === "instapay" && order.payment_status !== "paid") {
        return { ok: false, reason: "payment_unverified" };
      }
      return { ok: true, next: "approved" };
    }

    case "cancel": {
      if (order.status === "cancelled") return { ok: false, reason: "already_cancelled" };
      if (order.status === "completed") return { ok: false, reason: "already_completed" };
      // Completed-sale cancellation is disabled for everybody (migration 0095).
      // The order keeps its sale; a sales return is the correction.
      if (order.sale_id !== null) {
        return { ok: false, reason: "sale_cancellation_disabled" };
      }
      return { ok: true, next: "cancelled" };
    }

    case "processing":
    case "ready":
    case "complete": {
      // The stored status comes from the canonical action→status table, never
      // from the action word itself: `"complete"` is not an enum label.
      const mapped = ORDER_ACTION_TO_STATUS[action];
      if (mapped === null) return { ok: false, reason: "unknown" };
      const next: OnlineOrderStatus = mapped;
      if (order.status === "pending") return { ok: false, reason: "not_approved" };
      if (order.status === "completed") return { ok: false, reason: "already_completed" };
      if (!FLOW[order.status].includes(next)) return { ok: false, reason: "backwards" };
      // Skipping straight to "ready" from "approved" is allowed (a small order
      // needs no processing step); going back is not.
      return { ok: true, next };
    }

    case "payment_approve": {
      if (order.payment_status === "paid") return { ok: false, reason: "payment_already_paid" };
      return { ok: true, next: order.status };
    }

    case "payment_reject": {
      if (order.payment_status === "paid") return { ok: false, reason: "payment_already_paid" };
      return { ok: true, next: order.status };
    }

    default:
      return { ok: false, reason: "unknown" };
  }
}

/** Actions that must carry a written reason. */
export function requiresReason(action: OrderAction): boolean {
  return action === "cancel" || action === "payment_reject";
}

/** The status an action produces, for optimistic UI. `null` = refused. */
export function nextStatusOf(order: OnlineOrder, action: OrderAction): OnlineOrderStatus | null {
  const check = checkAction(order, action);
  return check.ok ? check.next : null;
}

// ── payment ─────────────────────────────────────────────────────────────────

/** True while an employee owes this order a decision about its money. */
export function needsPaymentVerification(order: OnlineOrder): boolean {
  return (
    order.status !== "cancelled" &&
    order.payment_status === "verification_required"
  );
}

/**
 * What the customer may do about payment right now.
 *
 * Cash on delivery has nothing to submit. An InstaPay order may submit a proof
 * until it is paid; once rejected it may submit again, because a wrong reference
 * is a mistake and not a verdict.
 */
export function canSubmitProof(order: OnlineOrder): boolean {
  if (order.payment_method !== "instapay") return false;
  if (order.status === "cancelled") return false;
  return order.payment_status !== "paid";
}

/** The payment status a fresh order starts in. */
export function initialPaymentStatus(
  paymentMethod: OnlineOrder["payment_method"],
): OnlinePaymentStatus {
  // InstaPay needs a human; cash on delivery is simply unpaid until collected.
  return paymentMethod === "instapay" ? "verification_required" : "pending";
}

// ── delivery, as the customer understands it ────────────────────────────────

export type DeliveryStatus =
  | "not_started"
  | "preparing"
  | "ready_for_pickup"
  | "out_for_delivery"
  | "delivered"
  | "collected"
  | "cancelled";

/**
 * Delivery status, derived — never stored.
 *
 * There is no courier system to read from, so this is a projection of the order
 * status onto what the customer is waiting for, and it differs by channel: a
 * pickup order becomes "ready for pickup", a delivery order becomes "out for
 * delivery". Deriving it means the two can never contradict each other.
 */
export function deliveryStatusOf(order: {
  status: OnlineOrderStatus;
  delivery_type: DeliveryType;
}): DeliveryStatus {
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "completed") {
    return order.delivery_type === "pickup" ? "collected" : "delivered";
  }
  if (order.status === "pending") return "not_started";
  if (order.status === "approved" || order.status === "processing") return "preparing";
  return order.delivery_type === "pickup" ? "ready_for_pickup" : "out_for_delivery";
}

/**
 * What to tell a customer who is waiting, as a dictionary key.
 *
 * Separate from the status itself so the copy can be warm without the state
 * machine having to know about it — and typed as the literal keys, so a rename
 * in the dictionary breaks the build rather than showing a raw key to a customer
 * who is waiting for their order.
 */
export type DeliveryHintKey =
  | "store.track.hint.pending"
  | "store.track.hint.preparing"
  | "store.track.hint.readyPickup"
  | "store.track.hint.outForDelivery"
  | "store.track.hint.delivered"
  | "store.track.hint.collected"
  | "store.track.hint.cancelled";

export function deliveryHintKey(order: {
  status: OnlineOrderStatus;
  delivery_type: DeliveryType;
}): DeliveryHintKey {
  switch (deliveryStatusOf(order)) {
    case "not_started":
      return "store.track.hint.pending";
    case "preparing":
      return "store.track.hint.preparing";
    case "ready_for_pickup":
      return "store.track.hint.readyPickup";
    case "out_for_delivery":
      return "store.track.hint.outForDelivery";
    case "delivered":
      return "store.track.hint.delivered";
    case "collected":
      return "store.track.hint.collected";
    default:
      return "store.track.hint.cancelled";
  }
}

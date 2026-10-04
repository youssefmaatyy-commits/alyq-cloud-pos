/**
 * Operational projections for the staff queue.
 *
 * The database deliberately stores a compact, authoritative order lifecycle.
 * This file gives that lifecycle the words an operator uses without introducing
 * a second delivery state or a client-side transition. In particular, `ready`
 * remains the one stored value: it means ready for collection on pickup orders
 * and out for delivery on delivery orders.
 */
import type { DeliveryType, OnlineOrderStatus } from "../types";

export type OperationalOrderStage =
  | "new"
  | "approved"
  | "preparing"
  | "ready_for_pickup"
  | "out_for_delivery"
  | "collected"
  | "delivered"
  | "rejected"
  | "cancelled";

/**
 * The staff-facing meaning of an immutable status + fulfilment snapshot.
 *
 * A cancellation before approval is presented as a rejection because no sale
 * was ever created; a cancellation after approval remains a cancellation. Both
 * are still the authoritative stored `cancelled` state and retain the required
 * historical reason and append-only event trail.
 */
export function operationalStageOf(order: {
  status: OnlineOrderStatus;
  delivery_type: DeliveryType;
  approved_at?: string | null;
}): OperationalOrderStage {
  switch (order.status) {
    case "pending":
      return "new";
    case "approved":
      return "approved";
    case "processing":
      return "preparing";
    case "ready":
      return order.delivery_type === "pickup" ? "ready_for_pickup" : "out_for_delivery";
    case "completed":
      return order.delivery_type === "pickup" ? "collected" : "delivered";
    case "cancelled":
      return order.approved_at ? "cancelled" : "rejected";
  }
}

/** A dictionary key rather than UI copy, so Arabic and English stay symmetric. */
export function operationalStageLabelKey(stage: OperationalOrderStage):
  | "online.operations.new"
  | "online.operations.approved"
  | "online.operations.preparing"
  | "online.operations.readyForPickup"
  | "online.operations.outForDelivery"
  | "online.operations.collected"
  | "online.operations.delivered"
  | "online.operations.rejected"
  | "online.operations.cancelled" {
  switch (stage) {
    case "new":
      return "online.operations.new";
    case "approved":
      return "online.operations.approved";
    case "preparing":
      return "online.operations.preparing";
    case "ready_for_pickup":
      return "online.operations.readyForPickup";
    case "out_for_delivery":
      return "online.operations.outForDelivery";
    case "collected":
      return "online.operations.collected";
    case "delivered":
      return "online.operations.delivered";
    case "rejected":
      return "online.operations.rejected";
    default:
      return "online.operations.cancelled";
  }
}

export interface QueueAge {
  value: number;
  unit: "minutes" | "hours" | "days";
}

/**
 * An elapsed age for the active queue. No SLA colour is inferred here — stores
 * have different promises — but every worker sees the same compact age.
 */
export function queueAgeOf(createdAt: string, now = Date.now()): QueueAge | null {
  const placedAt = Date.parse(createdAt);
  if (!Number.isFinite(placedAt) || !Number.isFinite(now)) return null;
  const minutes = Math.max(0, Math.floor((now - placedAt) / 60_000));
  if (minutes < 60) return { value: minutes, unit: "minutes" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "hours" };
  return { value: Math.floor(hours / 24), unit: "days" };
}

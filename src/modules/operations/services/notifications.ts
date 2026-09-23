/**
 * Operational notifications (Phase 56).
 *
 * Built from a snapshot, not from a render clock, so the same facts always
 * produce the same ids. A viewer only receives a row when they hold that
 * row's existing capability.
 */
import type { NotificationKind, OperationalNotification } from "../types";

export interface StockSignal {
  id: string;
  quantity: number;
  lowLevel: number;
  tracked: boolean;
  active: boolean;
  updatedAt: string;
  label: string;
}

export interface OrderSignal {
  id: string;
  number: string;
  status: string;
  createdAt: string;
}

export interface ReturnSignal {
  id: string;
  number: string;
  refundStatus: string;
  createdAt: string;
}

export interface ShiftSignal {
  id: string;
  number: string;
  status: string;
  difference: number | null;
  adjustmentApprovedAt: string | null;
  closedAt: string | null;
}

export interface PromotionSignal {
  id: string;
  name: string;
  enabled: boolean;
  endsAt: string | null;
}

export interface StocktakeSignal {
  id: string;
  status: string;
  createdAt: string;
}

export interface NotificationSnapshot {
  stock: readonly StockSignal[];
  orders: readonly OrderSignal[];
  returns: readonly ReturnSignal[];
  shifts: readonly ShiftSignal[];
  promotions: readonly PromotionSignal[];
  stocktakes: readonly StocktakeSignal[];
  backupStatus: "protected" | "due" | "overdue" | "never" | "disabled" | null;
  backupAt: string | null;
  storageUsedBytes: number | null;
  storageWarningBytes: number | null;
  /** `pending` is an in-flight probe. It is not connected and not a warning yet. */
  supabase: "ok" | "unavailable" | "not_configured" | "pending";
}

const PROMOTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const CAPABILITY: Record<NotificationKind, string> = {
  low_stock: "view_inventory",
  out_of_stock: "view_inventory",
  online_order: "manage_online_orders",
  return_pending: "process_return",
  shift_discrepancy: "approve_shift_adjustment",
  promotion_expiring: "manage_website",
  stocktake_open: "view_inventory",
  backup_warning: "view_backups",
  storage_warning: "run_health_check",
  system_warning: "run_health_check",
};

function row(
  kind: NotificationKind,
  entityId: string,
  at: string,
  href: string,
  label: string,
): OperationalNotification {
  return {
    id: `${kind}:${entityId}`,
    kind,
    capability: CAPABILITY[kind],
    at,
    href,
    entityId,
    label,
    read: false,
  };
}

/**
 * One notification per fact. Calling this twice with the same snapshot returns
 * the same ids — it does not append.
 */
export function buildOperationalNotifications(
  snapshot: NotificationSnapshot,
  capabilities: ReadonlySet<string>,
  nowIso: string,
  readIds: ReadonlySet<string> = new Set(),
): OperationalNotification[] {
  const now = Date.parse(nowIso);
  const out: OperationalNotification[] = [];

  for (const stock of snapshot.stock) {
    if (!stock.active || !stock.tracked) continue;
    if (stock.quantity <= 0) {
      out.push(row("out_of_stock", stock.id, stock.updatedAt, "/inventory", stock.label));
    } else if (stock.lowLevel > 0 && stock.quantity <= stock.lowLevel) {
      out.push(row("low_stock", stock.id, stock.updatedAt, "/inventory", stock.label));
    }
  }

  for (const order of snapshot.orders) {
    if (order.status !== "pending") continue;
    out.push(row("online_order", order.id, order.createdAt, "/online/orders", order.number));
  }

  for (const entry of snapshot.returns) {
    if (entry.refundStatus !== "pending") continue;
    out.push(row("return_pending", entry.id, entry.createdAt, "/returns", entry.number));
  }

  for (const shift of snapshot.shifts) {
    if (shift.status !== "closed") continue;
    if (shift.difference === null || shift.difference === 0) continue;
    if (shift.adjustmentApprovedAt) continue;
    out.push(
      row("shift_discrepancy", shift.id, shift.closedAt ?? nowIso, "/shifts", shift.number),
    );
  }

  for (const promotion of snapshot.promotions) {
    if (!promotion.enabled || !promotion.endsAt) continue;
    const ends = Date.parse(promotion.endsAt);
    if (!Number.isFinite(ends) || !Number.isFinite(now)) continue;
    if (ends < now || ends - now > PROMOTION_WINDOW_MS) continue;
    out.push(row("promotion_expiring", promotion.id, promotion.endsAt, "/online/discounts", promotion.name));
  }

  for (const session of snapshot.stocktakes) {
    if (session.status === "finalized") continue;
    out.push(row("stocktake_open", session.id, session.createdAt, "/inventory/stocktake", session.id));
  }

  if (snapshot.backupStatus === "overdue" || snapshot.backupStatus === "never") {
    out.push(row("backup_warning", snapshot.backupStatus, snapshot.backupAt ?? nowIso, "/settings/backup", snapshot.backupStatus));
  }

  if (
    snapshot.storageUsedBytes !== null &&
    snapshot.storageWarningBytes !== null &&
    snapshot.storageWarningBytes > 0 &&
    snapshot.storageUsedBytes >= snapshot.storageWarningBytes
  ) {
    out.push(row("storage_warning", "threshold", nowIso, "/settings/operations", String(snapshot.storageUsedBytes)));
  }

  if (snapshot.supabase === "unavailable") {
    out.push(row("system_warning", "supabase", nowIso, "/settings/operations", "supabase"));
  }

  const byId = new Map<string, OperationalNotification>();
  for (const note of out) {
    if (!capabilities.has(note.capability)) continue;
    if (!byId.has(note.id)) byId.set(note.id, { ...note, read: readIds.has(note.id) });
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
}

export function markNotificationRead(readIds: readonly string[], id: string): string[] {
  return readIds.includes(id) ? [...readIds] : [...readIds, id];
}

export function markAllNotificationsRead(
  readIds: readonly string[],
  notifications: readonly { id: string }[],
): string[] {
  const next = new Set(readIds);
  for (const note of notifications) next.add(note.id);
  return [...next];
}

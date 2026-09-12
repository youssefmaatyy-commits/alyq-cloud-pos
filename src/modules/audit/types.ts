/**
 * Audit log module (Phase 8).
 *
 * Append-only, human-readable trail of the operations that touch money:
 * opening/closing a cashier shift and creating/editing/deleting an expense.
 *
 * Entries are never updated or deleted — the module exposes no mutators other
 * than `append`.
 */

export const AUDIT_ACTIONS = [
  "shift.opened",
  "shift.closed",
  "expense.created",
  "expense.updated",
  "expense.deleted",
  "shift.adjustment.approved",
  // Refund lifecycle (WS4). `refund.created` is written by WS6 when a return is
  // recorded; `refund.settled` / `refund.rejected` are written by the
  // settlement RPC in migration 0016, which is why the vocabulary is extended
  // here and in `public.audit_actions` together — the parity check fails if
  // either side moves alone.
  "refund.created",
  "refund.settled",
  "refund.rejected",
  // Online storefront (Phase 9). Approving a website order creates a POS sale
  // and converts its stock reservation; cancelling releases the reservation and
  // keeps the record with a reason. The two payment actions are the human half
  // of InstaPay verification — money is never marked paid automatically.
  "online_order.approved",
  "online_order.cancelled",
  "online_order.payment_approved",
  "online_order.payment_rejected",
  "website_settings.updated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What kind of record the action happened to. */
export const AUDIT_ENTITIES = [
  "shift",
  "expense",
  "refund",
  "online_order",
  "website_settings",
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  entity: AuditEntity;
  /** Id of the affected record (shift id / expense id). */
  entity_id: string;
  /** Short human-readable label (e.g. "SHF-000004", "Transport"). */
  entity_label: string;
  /** Structured, JSON-safe detail for the expanded row. */
  details: Record<string, string | number | boolean | null>;
  user_id: string;
  user_name: string;
  /** ISO timestamp of the action. */
  created_at: string;
}

/** Entry as supplied by a caller (id + timestamp are assigned by the repo). */
export interface NewAuditLogEntry {
  action: AuditAction;
  entity: AuditEntity;
  entity_id: string;
  entity_label: string;
  details?: Record<string, string | number | boolean | null>;
  user_id: string;
  user_name: string;
}

export interface AuditFiltersValue {
  search: string;
  action: AuditAction | "all";
}

export const EMPTY_AUDIT_FILTERS: AuditFiltersValue = {
  search: "",
  action: "all",
};

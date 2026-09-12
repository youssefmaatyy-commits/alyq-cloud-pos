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
  // Phase 13: the return itself, written by the returns service in both modes
  // (no database function writes it), while the settlement rows above are
  // written by `pos_settle_refund` live and by the service in demo mode.
  "return.created",
  // Online storefront (Phase 9). Approving a website order creates a POS sale
  // and converts its stock reservation; cancelling releases the reservation and
  // keeps the record with a reason. The two payment actions are the human half
  // of InstaPay verification — money is never marked paid automatically.
  "online_order.approved",
  "online_order.cancelled",
  "online_order.payment_approved",
  "online_order.payment_rejected",
  "website_settings.updated",
  // Identity (Phase 10). A session event is written by the app because there is
  // no table behind it; the user and role events are written by the settings
  // service in demo mode and by the RPCs in live mode. Password events record
  // that a reset happened and who asked for it — never the password, never a
  // reset token, never the address a reset mail was sent to.
  "session.login",
  "session.logout",
  "session.login_failed",
  "session.refreshed",
  "user.created",
  "user.updated",
  "user.activated",
  "user.deactivated",
  "user.role_changed",
  "user.password_reset_requested",
  "user.password_reset",
  "user.password_changed",
  "role.created",
  "role.updated",
  "role.activated",
  "role.deactivated",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What kind of record the action happened to. */
export const AUDIT_ENTITIES = [
  "shift",
  "expense",
  "refund",
  /** A sales return (`sales_returns`) — the goods side of a refund. */
  "return",
  "online_order",
  "website_settings",
  /** A sign-in, a sign-out or a refresh: an event with no table behind it. */
  "session",
  /** A staff profile (`profiles` in live mode, the demo directory offline). */
  "user",
  /** An admin-defined role and its permission set. */
  "custom_role",
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

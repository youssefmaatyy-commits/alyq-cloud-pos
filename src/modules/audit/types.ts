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
  // Phase 47: the Danger Zone. Written by the 0047 RPCs live (and by the demo
  // system service in demo mode): a reset announces it started, and either
  // succeeds with its counts or is reported failed by the follow-up call. The
  // trail itself is append-only, so the reset's own record always survives.
  "system.reset.started",
  "system.reset.succeeded",
  "system.reset.failed",
  // Phase 13: the return itself, written by the returns service in both modes
  // (no database function writes it), while the settlement rows above are
  // written by `pos_settle_refund` live and by the service in demo mode.
  "return.created",
  // Business events (Phase 13, requirement 6). Each is written by the service
  // funnel that performs the act — the same place the capability is asserted —
  // so the trail records what the register refused to let somebody do silently.
  // No database function writes these, exactly like `return.created`: they are
  // the app's own acts, in demo mode and live mode alike.
  //
  //   `sale.discounted`      a discount was given, with the percentage and the
  //                          amount taken off — the two numbers a discount
  //                          report and an approval rule both care about.
  //   `sale.voided`          a completed invoice was reversed, with the reason.
  //   `product.price_changed`/`product.cost_changed`  the retail price or the
  //                          purchase cost moved, previous value and new value,
  //                          which is what makes a margin move traceable.
  //   `stock.adjusted`       a manual stock movement (damage, gift, transfer…).
  //   `stock.corrected`      the same funnel with reason `recount` — the shelf
  //                          and the system disagreed and the system was fixed.
  "sale.discounted",
  "sale.voided",
  "product.price_changed",
  "product.cost_changed",
  // Phase 25 (0037): the safe delete/archive lifecycle. Written by the RPCs
  // `public.set_product_active` / `public.delete_product` in live mode — so the
  // event exists however the call was made — and by the catalog service in
  // demo mode, exactly like `return.created`. A permanent delete is recorded
  // BEFORE the row is removed: an entry written afterwards could never exist.
  "product.deleted",
  "product.archived",
  "product.reactivated",
  // Phase 43 (0043): the variant lifecycle. The variant itself is named in the
  // row's `details` (variant_id, colour, size), so the trail answers who added
  // that size, who archived it and who put the opening stock there — over the
  // same `product` entity the catalogue already audits.
  "product.variant_created",
  "product.variant_updated",
  "product.variant_archived",
  "product.variant_reactivated",
  "product.variant_deleted",
  "product.variants_enabled",
  "product.variants_disabled",
  // Phase 44 (0044): the category lifecycle. Archiving is not deleting — the
  // trail must show both — and the move-and-delete is one transaction that
  // leaves two rows: what moved, and what stopped existing. Live mode writes
  // them from the `categories_audit` trigger and the move RPC, so the event
  // exists however the change was made; demo mode writes the same from the
  // catalog service.
  "category.archived",
  "category.reactivated",
  "category.deleted",
  "category.products_moved",
  "stock.adjusted",
  "stock.corrected",
  // Approval limits (Phase 12, requirement 2). Live mode writes these from
  // `submit_approval_request` / `decide_approval_request` / `mark_approval_applied`
  // / `set_approval_rules` (migration 0023); demo mode writes the same five from
  // the approvals service, so the trail reads identically in both.
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.cancelled",
  "approval.applied",
  "approval_rules.updated",
  // Online storefront (Phase 9). Approving a website order creates a POS sale
  // and converts its stock reservation; cancelling releases the reservation and
  // keeps the record with a reason. The two payment actions are the human half
  // of InstaPay verification — money is never marked paid automatically.
  "online_order.approved",
  "online_order.cancelled",
  "online_order.payment_approved",
  "online_order.payment_rejected",
  // Phase 55: a staff member opened a WhatsApp deep link for an order update.
  // `initiated` is the outcome — the link opening is not delivery, and the order
  // status is not moved by it. Live mode needs the vocabulary row (0056).
  "whatsapp.initiated",
  // Phase 56: a confirmed cleanup or retention pass. Preview is not audited.
  // The trail says what was removed and how many — never a secret, never a sale.
  "operations.cleanup_executed",
  "operations.retention_applied",
  // Phase 57: a reviewed import was applied or rolled back. Preview is not
  // audited. The row counts the outcome; it does not store the file.
  "import.applied",
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
  // Phase 17: one person's exceptions replaced — what they gained, what they lost.
  "user.permissions_changed",
  "user.password_reset_requested",
  "user.password_reset",
  "user.password_changed",
  "role.created",
  "role.updated",
  "role.activated",
  "role.deactivated",
  // Stock-hold reconciliation (Phase 15). A website order holds stock while it is
  // pending; the workflow releases or converts that hold when the order moves on.
  // When a transition misses its resolution the units stay out of the pool, and
  // somebody has to settle the row by hand — which is an act worth recording,
  // because it changes what the shop can promise to sell.
  //
  //   `reservation.released`    the hold was given back (order cancelled, or the
  //                             order behind it no longer exists).
  //   `reservation.converted`   the hold was marked as the deduction the order's
  //                             sale already made.
  //   `reservation.reconciled`  the held quantity (or the row's own resolved
  //                             timestamp) was corrected to match the order line.
  //   `reservation.held`        a hold a pending order had lost was restored.
  //
  // Written by `reservationRepair` in demo and live mode alike — no database
  // function writes them, exactly like `return.created`. Migration 0025 adds the
  // vocabulary rows and the repair function; the parity check fails if either
  // side moves alone.
  "reservation.released",
  "reservation.converted",
  "reservation.reconciled",
  "reservation.held",
  // Backup & recovery (Phase 18). Seven verbs, and the split matters: a snapshot
  // being taken and a snapshot being *downloaded* are different exposures, and a
  // restore is recorded twice — once before anything is deleted, because an entry
  // written afterwards does not exist if the restore ends the session writing it.
  "backup.created",
  "backup.downloaded",
  "backup.settings_changed",
  "restore.started",
  "restore.completed",
  "restore.failed",
  "health.check_run",
  // Delivery zones (0049). Creating a zone and changing one (fee, minimum,
  // threshold, deactivation) decide what customers pay, so both are trail
  // events — written by the website service in demo mode, and by the admin's
  // own writes through the manage_website RLS gate in live mode.
  "delivery_zone.created",
  "delivery_zone.changed",
  // Promotions (0050). Creating a discount or a code, changing one, and
  // switching one on or off decide what customers pay — each lands on the
  // trail with the values in `details`, from the website service in both modes
  // (admin writes go through the manage_website RLS gate live).
  "promotion.created",
  "promotion.changed",
  "promotion.activated",
  "promotion.deactivated",
  "promo_code.created",
  "promo_code.changed",
  "promo_code.disabled",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What kind of record the action happened to. */
export const AUDIT_ENTITIES = [
  "shift",
  "expense",
  "refund",
  /** A sales return (`sales_returns`) — the goods side of a refund. */
  "return",
  /** An invoice (`sales`) — a discount given against it, or its voiding. */
  "sale",
  /** A catalogue product (`products`) — its price or cost moving. */
  "product",
  /** A catalogue category (`categories`) — archived, reactivated, emptied or deleted. */
  "category",
  /** A stock level and the movement that changed it (`stock_movements`). */
  "stock",
  /** An over-limit act waiting for a decision (`approval_requests`). */
  "approval_request",
  /** The threshold document itself (`approval_rules`, one row). */
  "approval_rules",
  "online_order",
  "website_settings",
  /** A sign-in, a sign-out or a refresh: an event with no table behind it. */
  "session",
  /** A staff profile (`profiles` in live mode, the demo directory offline). */
  "user",
  /** An admin-defined role and its permission set. */
  "custom_role",
  /** A website order's hold on stock (`stock_reservations`). */
  "reservation",
  /**
   * A snapshot of the installation (`backups` in live mode, the offline backup
   * store otherwise) — and the restore, schedule change or health check performed
   * against it.
   */
  "backup",
  /** Phase 47: the Danger Zone — the installation itself (a reset event). */
  "system",
  /** A delivery zone (`delivery_zones`) — what a governorate pays for shipping. */
  "delivery_zone",
  /** An automatic discount (`promotions`) — the storewide sale and its kin. */
  "promotion",
  /** A promo code (`coupons`) — created, changed or switched off. */
  "promo_code",
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

/**
 * What the trail can be narrowed to.
 *
 * Search and action were the Phase 8 filters. Requirement 6 asks the same
 * question four ways — who, what, to which kind of record, and when — so the
 * other three are filters of their own rather than something an operator has to
 * type into a search box and hope: a user picked from the users actually in the
 * trail, an entity picked from the vocabulary, and an inclusive date range that
 * uses the same `withinDateRange` the reports use, so "the audit for March" and
 * "the sales for March" cannot disagree about what March means.
 */
export interface AuditFiltersValue {
  search: string;
  action: AuditAction | "all";
  entity: AuditEntity | "all";
  /** Matched on `user_id`, so a renamed employee stays one person. */
  user: string | "all";
  /** Inclusive `yyyy-mm-dd` bounds; `null`/`""` means open-ended. */
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFiltersValue = {
  search: "",
  action: "all",
  entity: "all",
  user: "all",
  from: "",
  to: "",
};

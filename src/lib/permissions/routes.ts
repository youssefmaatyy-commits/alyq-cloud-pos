import type { Capability } from "./roles";

/**
 * Which capability a screen needs.
 *
 * One table, read by two places — the route guard and the sidebar — so the
 * navigation can never offer a screen that the guard would refuse, and the
 * guard can never be bypassed by typing a URL.
 *
 * Screens that are absent from this table need a session but no particular
 * capability: every signed-in role may read the dashboard, the catalogue and
 * sales history. Capabilities are only listed where the matrix actually
 * distinguishes roles.
 *
 * Phase 17 moved the customer book out of that "anybody signed in" group and
 * onto `view_customers`. It was the one screen holding records about named
 * people — phone numbers, addresses, what they bought — that no capability
 * described, so no role could be built without it. Every shipped role holds it,
 * including the viewer; a custom role may now decline it, and the till's customer
 * picker declines with it.
 *
 * Longest prefix wins, so `/pos/sales` is matched before `/pos`.
 */
export const ROUTE_CAPABILITIES: ReadonlyArray<readonly [string, Capability]> = [
  // The customer book (Phase 17). Reading it is `view_customers`; adding,
  // editing and deleting are gated per action in the customers service and the
  // screens, because the till adds a customer mid-sale and that act belongs to
  // the sale, not to the book.
  ["/customers", "view_customers"],
  ["/inventory/movements", "view_inventory"],
  ["/inventory", "view_inventory"],
  ["/pos/sales", "sell"],
  ["/pos", "sell"],
  ["/returns", "process_return"],
  ["/refunds", "process_refund"],
  ["/shifts/history", "view_shifts"],
  ["/shifts", "view_shifts"],
  ["/expenses", "view_shifts"],
  // Reports is read-only, but it is not the same read as the shift book. Phase 23
  // found this entry pointing at `view_shifts` while the screen itself asserts
  // `report.view` — which is `view_reports` (`actions.ts:307`) — and while all
  // five report RPCs in migration 0032 are guarded by `public.can('view_reports')`.
  // Three gates over one screen, two different capabilities.
  //
  // Every shipped role holds both, so nothing was visibly broken. The mismatch
  // only appeared for a CUSTOM role, and it misbehaved in both directions:
  // granting `view_reports` without `view_shifts` produced a capability that
  // could never be exercised, because the guard refused the path and the sidebar
  // hid the link; granting `view_shifts` without `view_reports` showed the link,
  // admitted the user, and then landed them on the page's own denial screen. The
  // route table now says what the page and the database already enforced.
  //
  // The objection recorded here previously — that a dedicated capability would
  // desynchronise `roles.ts` from `public.role_capabilities`, which `npm run
  // db:check` asserts row-for-row — does not apply to `view_reports`. It is
  // already declared in both, granted to all five system roles, and covered by
  // that same parity check, so this changes no capability, no role and no grant:
  // only which of two existing capabilities this path asks for. `/expenses` and
  // `/shifts` keep `view_shifts`, which is what their own tables' RLS uses
  // (0012).
  ["/reports", "view_reports"],
  // Advanced reports (Phase 14) is the same screen family and the same read, so
  // it carries the same capability. Listed explicitly even though `/reports`
  // would match it by prefix, because somebody grepping this table for the path
  // should find it.
  ["/reports/advanced", "view_reports"],
  // The website is two screens' worth of authority. Working an order —
  // approving, cancelling, verifying an InstaPay proof — is a till-side job, so
  // it uses `manage_online_orders`, which cashiers hold. Editing the shop itself
  // (appearance, sections, campaigns, coupons, product content) can repaint the
  // storefront for every customer and change what they pay, so it uses
  // `manage_website`, which only managers and admins hold.
  ["/online/orders", "manage_online_orders"],
  // Stock holds (Phase 15). Reading what the website has reserved is part of
  // working the queue, so it opens with the same capability. *Settling* a hold
  // changes what the whole shop can promise, so the screen's repair buttons are
  // gated separately on `adjust_stock` — in the UI, in the service funnel and in
  // `public.repair_stock_reservation` for live mode. One path, two capabilities,
  // deliberately: the route table says who may look, not who may act.
  ["/online/reservations", "manage_online_orders"],
  ["/online/reports", "manage_online_orders"],
  ["/online/website", "manage_website"],
  ["/online/marketing", "manage_website"],
  ["/online/content", "manage_website"],
  ["/audit", "view_audit_log"],
  // Settings (Phase 10). Three capabilities rather than one, so a role can be
  // given the area without being given the directory inside it: `manage_settings`
  // opens the hub, `manage_users` the accounts, `manage_roles` the permission
  // model itself. Longest prefix wins, so an admin (who holds all three) reaches
  // every screen and a hypothetical "HR only" role could be given users but not
  // roles. Each is also asserted again in `modules/settings/services`.
  // Backup & recovery (Phase 18). Opening the panel is `view_backups`; the acts
  // on it — snapshot, download, restore, health check — are asserted again in
  // `modules/backup/services` and, in live mode, inside the SQL functions that do
  // the work. The route says who may look at the recovery story, not who may
  // change it.
  ["/settings/backup", "view_backups"],
  ["/settings/users", "manage_users"],
  ["/settings/roles", "manage_roles"],
  ["/settings", "manage_settings"],
];

/**
 * The capability a path requires, or `null` when a session is enough.
 * Unmatched paths are the catch-all redirect back to the dashboard.
 */
export function capabilityForPath(pathname: string): Capability | null {
  const path = normalizePath(pathname);
  let best: { path: string; capability: Capability } | null = null;
  for (const [prefix, capability] of ROUTE_CAPABILITIES) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best.path.length) best = { path: prefix, capability };
  }
  return best?.capability ?? null;
}

/** Trailing slash and query-free comparison form. */
function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split("?")[0].split("#")[0];
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Screens that carry their own element-level guard with more specific denial
 * copy (`/audit` — "Only managers and admins can read the audit trail").
 * `RouteGuard` steps aside for these so the specific message wins; the sidebar
 * still reads the capability from the table above, so navigation cannot drift.
 */
export const SELF_GUARDED_PATHS = ["/audit"] as const;

export function isSelfGuardedPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return SELF_GUARDED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

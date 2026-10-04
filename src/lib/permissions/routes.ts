import { capabilityForPermission, type Permission } from "./catalog";
import type { Capability } from "./roles";

/**
 * Which capability a screen needs.
 *
 * One table, read by two places — the route guard and the sidebar — so the
 * navigation can never offer a screen that the guard would refuse, and the
 * guard can never be bypassed by typing a URL.
 *
 * Screens absent from this table need a session but no particular permission.
 * Dashboard, catalogue and sales-history reads are declared explicitly so a
 * custom role can omit each module; the shipped role matrix preserves every
 * role's former access.
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
export const ROUTE_PERMISSIONS: ReadonlyArray<readonly [string, Permission]> = [
  ["/", "dashboard.view"],
  ["/management", "sales.view"],
  ["/products/new", "products.create"],
  ["/products/:id/edit", "products.edit"],
  ["/products", "products.view"],
  ["/categories", "products.view"],
  ["/catalog", "products.view"],
  // The customer book (Phase 17). Reading it is `view_customers`; adding,
  // editing and deleting are gated per action in the customers service and the
  // screens, because the till adds a customer mid-sale and that act belongs to
  // the sale, not to the book.
  ["/customers", "customers.view"],
  ["/inventory/movements", "inventory.view"],
  ["/inventory", "inventory.view"],
  ["/pos/sales", "sales.view"],
  ["/pos", "pos.sell"],
  // Local queue inspection is part of safely operating the till; system health
  // is an operational/reporting view and never grants repair authority.
  ["/sync", "pos.sell"],
  ["/system-health", "reports.view"],
  // Phase 49: the Sales module landing opens with the same capability as the
  // invoice list it fronts — a module door must never be wider than its rooms.
  ["/sales", "sales.view"],
  ["/returns", "returns.process"],
  ["/refunds", "refunds.process"],
  ["/shifts/history", "shifts.view"],
  ["/shifts/eod", "shifts.view"],
  ["/shifts", "shifts.view"],
  ["/expenses", "shifts.view"],
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
  ["/reports", "reports.view"],
  // Advanced reports (Phase 14) is the same screen family and the same read, so
  // it carries the same capability. Listed explicitly even though `/reports`
  // would match it by prefix, because somebody grepping this table for the path
  // should find it.
  ["/reports/advanced", "reports.view"],
  // The website is two screens' worth of authority. Working an order —
  // approving, cancelling, verifying an InstaPay proof — is a till-side job, so
  // it uses `manage_online_orders`, which cashiers hold. Editing the shop itself
  // (appearance, sections, campaigns, coupons, product content) can repaint the
  // storefront for every customer and change what they pay, so it uses
  // `manage_website`, which only managers and admins hold.
  // Phase 49: the Online module landing. Working the queue (orders, holds,
  // reports) is `manage_online_orders`; the shop-window cards beneath it are
  // `manage_website` and hide per-card on the landing itself.
  ["/online", "orders.view"],
  ["/online/orders", "orders.view"],
  // Stock holds (Phase 15). Reading what the website has reserved is part of
  // working the queue, so it opens with the same capability. *Settling* a hold
  // changes what the whole shop can promise, so the screen's repair buttons are
  // gated separately on `adjust_stock` — in the UI, in the service funnel and in
  // `public.repair_stock_reservation` for live mode. One path, two capabilities,
  // deliberately: the route table says who may look, not who may act.
  ["/online/reservations", "orders.view"],
  ["/online/reports", "orders.view"],
  ["/online/website", "website.manage"],
  ["/online/marketing", "website.manage"],
  ["/online/content", "website.manage"],
  // Delivery zones and automatic discounts price what customers pay, so like
  // campaigns and coupons they sit behind `manage_website` — same capability
  // the tables' RLS enforces. Listed explicitly so the route table (and the
  // admin audit that scans it) names every room.
  ["/online/zones", "website.manage"],
  ["/online/discounts", "website.manage"],
  ["/audit", "audit.view"],
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
  ["/settings/backup", "backups.view"],
  ["/settings/users", "users.manage"],
  ["/settings/roles", "roles.manage"],
  // Branding (Phase 46) writes the shared website settings document, so the
  // route asks for the same capability the write enforces through RLS —
  // `manage_website`, not a new one. The screen re-checks it itself.
  ["/settings/branding", "website.manage"],
  ["/settings/branches", "users.manage"],
  ["/settings/registers", "registers.manage"],
  ["/settings/hardware", "hardware.configure"],
  // Phase 47: the Danger Zone — the strongest gate in the table, and the only
  // one an ordinary oversight role is deliberately denied.
  ["/settings/system", "system.preview_cleanup"],
  // Approval thresholds: changing them is `manage_settings` work (the same
  // capability that has always owned system-wide configuration), so the child
  // names its own gate explicitly.
  ["/settings/approvals", "settings.manage"],
  // Phase 58: viewing health, usage and notifications is `run_health_check`.
  // Cleanup, retention and the storage threshold stay `manage_settings`.
  // The primary stays a single capability so the route table and the preview
  // agree; `manage_settings` is an alternate in ROUTE_ALTERNATES, not a second
  // name for the same act. A seat that can only clean up can still open the
  // screen; a seat that can only look cannot delete.
  ["/settings/operations", "system.health_check"],
  // Phase 57: viewing products is not importing them. The center re-checks
  // the write for each kind; stock also requires adjust_stock.
  ["/products/import", "data.import"],
  // Phase 49: the settings INDEX is the grouped directory, and a directory
  // gate must never be wider than its widest room — the manager who may read
  // the audit trail and the backups could not previously open the very page
  // listing them. Every room keeps (and states) its own capability; the home
  // hides what the role may not open and shows a locked empty state when
  // nothing remains, so the index itself carries no capability of its own.
];

/** The normalized permission a path requires, or `null` when a session is enough. */
export function permissionForPath(pathname: string): Permission | null {
  const path = normalizePath(pathname);
  let best: { path: string; permission: Permission } | null = null;
  for (const [prefix, permission] of ROUTE_PERMISSIONS) {
    if (!routePatternMatches(path, prefix)) continue;
    if (!best || prefix.length > best.path.length) best = { path: prefix, permission };
  }
  return best?.permission ?? null;
}

/** Compatibility projection for legacy capability callers and schema audits. */
export const ROUTE_CAPABILITIES: ReadonlyArray<readonly [string, Capability]> =
  ROUTE_PERMISSIONS.map(([path, permission]) => {
    const capability = capabilityForPermission(permission);
    if (!capability) throw new Error(`Unknown route permission: ${permission}`);
    return [path, capability] as const;
  });

/** Existing API, derived from the normalized route permission. */
export function capabilityForPath(pathname: string): Capability | null {
  const permission = permissionForPath(pathname);
  return permission ? capabilityForPermission(permission) : null;
}

/** Alternate permissions that can also open a shared module door. */
export const ROUTE_PERMISSION_ALTERNATES: ReadonlyArray<readonly [string, Permission]> = [
  ["/settings/system", "system.reset"],
  ["/settings/operations", "settings.manage"],
  ["/sync", "reports.view"],
  ["/sync", "settings.manage"],
  ["/system-health", "settings.manage"],
  ["/system-health", "audit.view"],
  ["/system-health", "backups.view"],
  ["/online", "website.manage"],
  ["/sales", "returns.process"],
  ["/sales", "refunds.process"],
  ["/sales", "shifts.view"],
  ["/pos/sales", "pos.sell"],
  ["/management", "products.view"],
  ["/management", "inventory.view"],
  ["/management", "orders.view"],
  ["/management", "reports.view"],
];

/** Compatibility projection for capability-based previews and older helpers. */
export const ROUTE_ALTERNATES: ReadonlyArray<readonly [string, Capability]> =
  ROUTE_PERMISSION_ALTERNATES.map(([path, permission]) => {
    const capability = capabilityForPermission(permission);
    if (!capability) throw new Error(`Unknown route alternate: ${permission}`);
    return [path, capability] as const;
  });

/** The route/sidebar decision using the normalized `can("module.action")` API. */
export function pathPermits(pathname: string, held: (permission: Permission) => boolean): boolean {
  const primary = permissionForPath(pathname);
  if (!primary) return true;
  if (held(primary)) return true;
  const path = normalizePath(pathname);
  for (const [prefix, permission] of ROUTE_PERMISSION_ALTERNATES) {
    if (!routePatternMatches(path, prefix)) continue;
    if (held(permission)) return true;
  }
  return false;
}

/** Legacy capability form, derived from the same normalized route declarations. */
export function pathAdmits(pathname: string, held: (capability: Capability) => boolean): boolean {
  return pathPermits(pathname, (permission) => {
    const capability = capabilityForPermission(permission);
    return capability ? held(capability) : false;
  });
}

/** Prefix matching with React Router-style `:segment` placeholders. */
function routePatternMatches(path: string, pattern: string): boolean {
  if (!pattern.includes(":")) {
    return path === pattern || path.startsWith(`${pattern}/`);
  }
  const actual = path.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length < expected.length) return false;
  return expected.every((segment, index) => segment.startsWith(":") || segment === actual[index]);
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

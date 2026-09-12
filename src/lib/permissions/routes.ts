import type { Capability } from "./roles";

/**
 * Which capability a screen needs.
 *
 * One table, read by two places — the route guard and the sidebar — so the
 * navigation can never offer a screen that the guard would refuse, and the
 * guard can never be bypassed by typing a URL.
 *
 * Screens that are absent from this table need a session but no particular
 * capability: every signed-in role may read the dashboard, the catalogue, the
 * customer book and sales history. Capabilities are only listed where the
 * matrix actually distinguishes roles.
 *
 * Longest prefix wins, so `/pos/sales` is matched before `/pos`.
 */
export const ROUTE_CAPABILITIES: ReadonlyArray<readonly [string, Capability]> = [
  ["/inventory/movements", "view_inventory"],
  ["/inventory", "view_inventory"],
  ["/pos/sales", "sell"],
  ["/pos", "sell"],
  ["/returns", "process_return"],
  ["/refunds", "process_refund"],
  ["/shifts/history", "view_shifts"],
  ["/shifts", "view_shifts"],
  ["/expenses", "view_shifts"],
  // Reports is read-only: it re-reads data the other screens already expose and
  // never writes, so it reuses the existing `view_shifts` read capability that
  // gates `/expenses` and `/shifts/history`. Adding a dedicated capability here
  // would desynchronise `roles.ts` from `public.role_capabilities`, which
  // `npm run db:check` asserts row-for-row.
  ["/reports", "view_shifts"],
  ["/audit", "view_audit_log"],
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

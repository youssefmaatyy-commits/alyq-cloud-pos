import type { PermissionSubject } from "@/lib/permissions/enforce";
import { can } from "@/lib/permissions/enforce";

export type MobileDeepLink =
  | { kind: "order"; entityId: string; route: string; permission: "orders.view" }
  | { kind: "invoice"; entityId: string; route: string; permission: "sales.view" }
  | { kind: "approval"; entityId: string; route: string; permission: "approvals.approve" }
  | { kind: "product"; entityId: string; route: string; permission: "inventory.view" };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const DEFINITIONS = [
  { expression: /^\/mobile\/orders\/([^/]+)$/, kind: "order", permission: "orders.view" },
  { expression: /^\/mobile\/invoices\/([^/]+)$/, kind: "invoice", permission: "sales.view" },
  { expression: /^\/mobile\/approvals\/([^/]+)$/, kind: "approval", permission: "approvals.approve" },
  { expression: /^\/mobile\/inventory\/([^/]+)$/, kind: "product", permission: "inventory.view" },
] as const;

function pathOf(raw: string): string | null {
  try {
    const url = new URL(raw, "https://mobile.alyq.eg");
    if (url.protocol === "alyq:") {
      const path = `/${url.host}${url.pathname}`.replace(/^\/mobile\/mobile\//, "/mobile/");
      return path.startsWith("/mobile/") ? path : `/mobile${path}`;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const hashPath = url.hash.startsWith("#/") ? url.hash.slice(1) : null;
    return hashPath ?? url.pathname;
  } catch {
    return null;
  }
}

/** Parsing provides navigation intent only. Entity RLS/RPC remains authoritative. */
export function parseMobileDeepLink(raw: string): MobileDeepLink | null {
  const path = pathOf(raw);
  if (!path || path.length > 180) return null;
  for (const definition of DEFINITIONS) {
    const match = definition.expression.exec(path);
    if (!match || !SAFE_ID.test(match[1])) continue;
    return {
      kind: definition.kind,
      entityId: match[1],
      route: `/mobile/${definition.kind === "product" ? "inventory" : `${definition.kind}s`}/${match[1]}`,
      permission: definition.permission,
    } as MobileDeepLink;
  }
  return null;
}

/** UI preflight only; the destination's branch-scoped backend read is the final gate. */
export function authorizeMobileDeepLink(
  link: MobileDeepLink | null,
  subject: PermissionSubject | null,
): MobileDeepLink | null {
  return link && can(link.permission, subject) ? link : null;
}

/**
 * Shape-only parser for tests and non-notification URL adapters. Native push
 * actions do not call this: they resolve `notification_id` through the server
 * so current branch/capability/entity authority is re-checked at open time.
 */
export function safePushDeepLink(data: Record<string, unknown>): MobileDeepLink | null {
  const routeKey = typeof data.route_key === "string" ? data.route_key : "";
  const id = typeof data.entity_id === "string" ? data.entity_id : "";
  if (!SAFE_ID.test(id)) return null;
  const path = routeKey === "order" ? `/mobile/orders/${id}`
    : routeKey === "invoice" ? `/mobile/invoices/${id}`
      : routeKey === "approval" ? `/mobile/approvals/${id}`
        : routeKey === "product" ? `/mobile/inventory/${id}`
          : "";
  return path ? parseMobileDeepLink(path) : null;
}

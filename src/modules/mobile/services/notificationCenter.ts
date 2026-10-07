import { getSupabaseClient } from "@/lib/supabase/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MobileNotification {
  id: string;
  kind: string;
  branchId: string;
  entityType: string;
  entityId: string;
  routeKey: string;
  routeEntityId: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationRow {
  id?: unknown;
  kind?: unknown;
  branch_id?: unknown;
  entity_type?: unknown;
  entity_id?: unknown;
  route_key?: unknown;
  route_entity_id?: unknown;
  title_en?: unknown;
  title_ar?: unknown;
  body_en?: unknown;
  body_ar?: unknown;
  read_at?: unknown;
  created_at?: unknown;
}

export interface ResolvedNotificationRoute {
  ok: boolean;
  route: string | null;
  reason: "unauthorized_or_stale" | "entity_unavailable" | "unavailable" | "invalid_response" | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapRow(value: unknown): MobileNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as NotificationRow;
  const id = text(row.id);
  const branchId = text(row.branch_id);
  const createdAt = text(row.created_at);
  if (!UUID.test(id) || !UUID.test(branchId) || !createdAt) return null;
  return {
    id,
    kind: text(row.kind),
    branchId,
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    routeKey: text(row.route_key),
    routeEntityId: text(row.route_entity_id),
    titleEn: text(row.title_en),
    titleAr: text(row.title_ar),
    bodyEn: text(row.body_en),
    bodyAr: text(row.body_ar),
    readAt: typeof row.read_at === "string" ? row.read_at : null,
    createdAt,
  };
}

function routeFor(routeKey: string, entityId: string): string | null {
  if (routeKey === "health") return "/mobile/health";
  if (!UUID.test(entityId)) return null;
  if (routeKey === "order") return `/mobile/orders/${entityId}`;
  if (routeKey === "invoice") return `/mobile/invoices/${entityId}`;
  if (routeKey === "approval") return `/mobile/approvals/${entityId}`;
  if (routeKey === "product") return `/mobile/inventory/${entityId}`;
  return null;
}

export function safeNotificationId(data: Record<string, unknown>): string | null {
  const id = text(data.notification_id);
  return UUID.test(id) ? id : null;
}

export async function listMobileNotifications(limit = 100, before: string | null = null): Promise<MobileNotification[]> {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error } = await client.rpc("notification_center_list", {
    p_limit: Math.min(100, Math.max(1, Math.trunc(limit))),
    p_before: before,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(mapRow).filter((row): row is MobileNotification => row !== null);
}

export async function mobileNotificationUnreadCount(): Promise<number> {
  const client = getSupabaseClient();
  if (!client) return 0;
  const { data, error } = await client.rpc("notification_center_unread_count");
  if (error) throw error;
  const count = typeof data === "number" ? data : Number(data ?? 0);
  return Number.isFinite(count) ? Math.min(999, Math.max(0, Math.trunc(count))) : 0;
}

export async function markMobileNotificationRead(notificationId: string): Promise<boolean> {
  if (!UUID.test(notificationId)) return false;
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.rpc("notification_center_mark_read", { p_notification_id: notificationId });
  if (error) throw error;
  return data === true;
}

export async function markAllMobileNotificationsRead(): Promise<number> {
  const client = getSupabaseClient();
  if (!client) return 0;
  const { data, error } = await client.rpc("notification_center_mark_all_read");
  if (error) throw error;
  const count = typeof data === "number" ? data : Number(data ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/** Server authorization and entity existence are re-evaluated at open time. */
export async function resolveMobileNotificationRoute(notificationId: string): Promise<ResolvedNotificationRoute> {
  if (!UUID.test(notificationId)) return { ok: false, route: null, reason: "invalid_response" };
  const client = getSupabaseClient();
  if (!client) return { ok: false, route: null, reason: "unavailable" };
  const { data, error } = await client.rpc("notification_center_resolve_route", { p_notification_id: notificationId });
  if (error) return { ok: false, route: null, reason: "unavailable" };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, route: null, reason: "invalid_response" };
  }
  const result = data as Record<string, unknown>;
  if (result.ok !== true) {
    const reason = result.reason === "entity_unavailable" || result.reason === "unauthorized_or_stale"
      ? result.reason
      : "unavailable";
    return { ok: false, route: null, reason };
  }
  const route = routeFor(text(result.route_key), text(result.entity_id));
  return route
    ? { ok: true, route, reason: null }
    : { ok: false, route: null, reason: "invalid_response" };
}

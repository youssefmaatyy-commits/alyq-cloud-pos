import { getSupabaseClient } from "@/lib/supabase/client";

/** Server-side device-Push choices; the internal Inbox is not filtered. */
export interface NotificationKindPreferences {
  onlineOrders: boolean;
  criticalStock: boolean;
  syncFailures: boolean;
}

export const DEFAULT_NOTIFICATION_KIND_PREFERENCES: NotificationKindPreferences = {
  onlineOrders: true,
  criticalStock: true,
  syncFailures: true,
};

export function parseNotificationKindPreferences(value: unknown): NotificationKindPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid notification preferences");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.online_orders !== "boolean"
      || typeof row.critical_stock !== "boolean"
      || typeof row.sync_failures !== "boolean") {
    throw new Error("Invalid notification preferences");
  }
  return {
    onlineOrders: row.online_orders,
    criticalStock: row.critical_stock,
    syncFailures: row.sync_failures,
  };
}

export function notificationPreferencesBackendAvailable(): boolean {
  return getSupabaseClient() !== null;
}

export async function loadNotificationKindPreferences(): Promise<NotificationKindPreferences> {
  const client = getSupabaseClient();
  if (!client) return DEFAULT_NOTIFICATION_KIND_PREFERENCES;
  const { data, error } = await client.rpc("notification_preferences_get");
  if (error) throw error;
  return parseNotificationKindPreferences(data);
}

export async function saveNotificationKindPreferences(
  preferences: NotificationKindPreferences,
): Promise<NotificationKindPreferences> {
  const client = getSupabaseClient();
  if (!client) throw new Error("Backend is unavailable");
  const { data, error } = await client.rpc("notification_preferences_set", {
    p_online_orders: preferences.onlineOrders,
    p_critical_stock: preferences.criticalStock,
    p_sync_failures: preferences.syncFailures,
  });
  if (error) throw error;
  return parseNotificationKindPreferences(data);
}

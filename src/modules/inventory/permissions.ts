/**
 * Inventory permission checks and the app-wide "acting user" accessor.
 *
 * Phase 3 originally simulated a signed-in user from `localStorage` and shipped
 * a demo role switcher. The Authentication phase replaced that with a real
 * session: `getCurrentUser()` now returns the user from the validated auth
 * session (see `src/lib/auth/services/sessionStore.ts`) and the switcher is
 * gone. Every call site kept its name and signature, so no module had to change.
 *
 * The canonical role + capability model lives in `src/lib/permissions/roles.ts`;
 * the checks below delegate to it.
 */
import { getCurrentAuthUser } from "@/lib/auth/services/sessionStore";
import { canActAs } from "@/lib/permissions/enforce";
import { type AppRole } from "@/lib/permissions/roles";

/** The canonical role type (kept under the historic name for call sites). */
export type InventoryRole = AppRole;

/** The acting user, as everything in the app expects it. */
export interface InventoryUser {
  id: string;
  name: string;
  /** Empty string while signed out → every capability is denied. */
  role: InventoryRole | "";
  /** Login handle (Authentication phase). */
  username?: string;
}

const LEGACY_STORAGE_KEY = "alyq.inventory.currentUser.v1";

/** Roles the Phase 3 UI offered. The canonical list is `APP_ROLES`. */
export const INVENTORY_ROLES = ["admin", "manager", "inventory_clerk", "viewer"] as const;

/**
 * The acting user.
 *
 * Returns the session user while signed in, or an anonymous user (empty role →
 * every capability denied) when there is no session. The pre-authentication
 * demo identity record is removed on first read so a stale demo role cannot
 * influence anything.
 */
export function getCurrentUser(): InventoryUser {
  clearLegacyDemoUser();
  const user = getCurrentAuthUser();
  return {
    id: user.id,
    name: user.name,
    role: user.role ?? "",
    username: user.username,
  };
}

/**
 * The Phase 3 role switcher was replaced by authentication. This throws rather
 * than silently changing who the app thinks is acting.
 */
export function setCurrentUser(): never {
  throw new Error("setCurrentUser was removed in the Authentication phase — sign in instead");
}

/** True when the current user is allowed to create stock movements. */
export function canAdjustStock(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "adjust_stock");
}

/** True when the current user is allowed to read stock + movement history. */
export function canViewInventory(user: InventoryUser = getCurrentUser()): boolean {
  return canActAs(user, "view_inventory");
}

/** All roles, ordered (labels come from the canonical model). */
export const ALL_ROLES: InventoryRole[] = [...INVENTORY_ROLES];

/** Human label for a role. */
export const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  inventory_clerk: "Inventory Clerk",
  viewer: "Viewer",
};

/** Remove the pre-authentication demo identity record, once per call. */
function clearLegacyDemoUser(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

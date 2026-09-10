/**
 * Inventory permission check.
 *
 * Phase 1 doesn't have a real auth provider yet, so this layer simulates a
 * signed-in internal user from `localStorage`. Future POS / website modules
 * should drop in a Supabase `auth.getUser()` replacement that fills the same
 * shape (`{ id, name, role }`) and keep this file as the single permission
 * gate for stock-changing actions.
 *
 * Stock adjustments are restricted to internal staff (admin, manager,
 * inventory_clerk). Cashier-only roles can read stock but not mutate it.
 *
 * Phase 3 owns `INVENTORY_ROLES` / `ROLE_LABEL` and they are intentionally
 * unchanged. The canonical role + capability model (including the future
 * `cashier` role) lives in `src/lib/permissions/roles.ts`.
 */

export const INVENTORY_ROLES = [
  "admin",
  "manager",
  "inventory_clerk",
  "viewer",
] as const;

export type InventoryRole = (typeof INVENTORY_ROLES)[number];

export interface InventoryUser {
  id: string;
  name: string;
  role: InventoryRole;
}

const STORAGE_KEY = "alyq.inventory.currentUser.v1";
const FALLBACK_USER: InventoryUser = {
  id: "user-demo-admin",
  name: "ALYQ Admin",
  role: "admin",
};

function safeRead(): InventoryUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InventoryUser>;
    if (!parsed.id || !parsed.name || !parsed.role) return null;
    if (!INVENTORY_ROLES.includes(parsed.role as InventoryRole)) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      role: parsed.role as InventoryRole,
    };
  } catch {
    return null;
  }
}

function safeWrite(user: InventoryUser): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    /* ignore quota / private mode */
  }
}

let cachedUser: InventoryUser | null = null;
let cachedLoaded = false;

/**
 * Resolves the active internal user. The user is persisted across reloads so
 * the auditor on the movement ledger has a stable name.
 */
export function getCurrentUser(): InventoryUser {
  if (cachedLoaded) return cachedUser ?? FALLBACK_USER;
  const stored = safeRead();
  cachedUser = stored ?? FALLBACK_USER;
  if (!stored) safeWrite(cachedUser);
  cachedLoaded = true;
  return cachedUser;
}

export function setCurrentUser(user: InventoryUser): void {
  if (!INVENTORY_ROLES.includes(user.role)) {
    throw new Error(`Unknown inventory role: ${user.role}`);
  }
  cachedUser = user;
  cachedLoaded = true;
  safeWrite(user);
}

/** True when the current user is allowed to create stock movements. */
export function canAdjustStock(user: InventoryUser = getCurrentUser()): boolean {
  return user.role === "admin" || user.role === "manager" || user.role === "inventory_clerk";
}

/** True when the current user is allowed to read stock + movement history. */
export function canViewInventory(user: InventoryUser = getCurrentUser()): boolean {
  return INVENTORY_ROLES.includes(user.role);
}

/** All roles, ordered for the role switcher in the UI. */
export const ALL_ROLES: InventoryRole[] = [...INVENTORY_ROLES];

/** Human label for a role. */
export const ROLE_LABEL: Record<InventoryRole, string> = {
  admin: "Admin",
  manager: "Manager",
  inventory_clerk: "Inventory Clerk",
  viewer: "Viewer",
};

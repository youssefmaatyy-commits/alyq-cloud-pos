/**
 * Last effective `manage_users` holder (Phase 58).
 *
 * Self-lockout still refuses the caller's own demotion first, with the same
 * sentences migration 0021 uses. This is the other direction: a write that
 * would leave the directory with nobody who can manage users, including a
 * custom-role edit that strips the grant from every wearer. It is not a
 * backdoor — a holder who remains can still undo the change.
 *
 * Resolution matches `resolveCapabilities` / `public.can()`: inactive profiles
 * hold nothing, deny wins, an extra grant wins, an active custom role is
 * absolute, otherwise the shipped matrix.
 */
import { AppError } from "@/modules/products/data/repository";
import { resolveCapabilities } from "@/lib/permissions/customRoles";
import type { Capability } from "@/lib/permissions/roles";

export const LAST_MANAGE_USERS_KEY = "settings.roles.lockout";

export interface HolderSource {
  id: string;
  active: boolean;
  role: string;
  custom_role_id: string | null;
  extra_capabilities: readonly Capability[];
  denied_capabilities: readonly Capability[];
}

export interface RoleSource {
  id: string;
  active: boolean;
  capabilities: readonly string[];
  base_role?: string;
}

export function holderCapabilities(user: HolderSource, roles: readonly RoleSource[]): Capability[] {
  if (!user.active) return [];
  const overlay = user.custom_role_id
    ? roles.find((role) => role.id === user.custom_role_id) ?? null
    : null;
  return resolveCapabilities(
    user.role,
    overlay ? { capabilities: overlay.capabilities, active: overlay.active } : null,
    { extra: user.extra_capabilities, denied: user.denied_capabilities },
  );
}

export function countCapabilityHolders(
  users: readonly HolderSource[],
  roles: readonly RoleSource[],
  capability: Capability,
): number {
  return users.filter((user) => holderCapabilities(user, roles).includes(capability)).length;
}

/**
 * Refuse only a real reduction to zero. An empty directory is not evidence —
 * the caller may not have been allowed to load it, and the SQL trigger is the
 * wall in that case.
 */
export function assertManageUsersRemains(
  beforeUsers: readonly HolderSource[],
  beforeRoles: readonly RoleSource[],
  afterUsers: readonly HolderSource[],
  afterRoles: readonly RoleSource[],
): void {
  if (beforeUsers.length === 0) return;
  if (countCapabilityHolders(beforeUsers, beforeRoles, "manage_users") < 1) return;
  if (countCapabilityHolders(afterUsers, afterRoles, "manage_users") < 1) {
    throw new AppError("FORBIDDEN", LAST_MANAGE_USERS_KEY, "capabilities");
  }
}

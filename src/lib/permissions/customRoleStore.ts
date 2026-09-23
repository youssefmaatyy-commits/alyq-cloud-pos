/**
 * Custom-role persistence for demo mode.
 *
 * Live mode reads `public.custom_roles` through the settings repository; offline
 * there is no table, so the same records live in one browser key. Both readers
 * return `CustomRole`, which is why nothing above this line knows which mode it
 * is in.
 *
 * Roles are *not* seeded: an installation starts with the five system roles and
 * no overlays, and the Roles screen offers the four presets in
 * `CUSTOM_ROLE_PRESETS` as one-click starting points instead of writing rows the
 * admin never asked for.
 */
import { safeStorage } from "@/modules/products/data/demoSeed";
import { normalizeRole, type AppRole } from "./roles";
import { sanitizeCapabilities, type CustomRole } from "./customRoles";

export const CUSTOM_ROLES_STORAGE_KEY = "alyq.identity.custom_roles.v1";

function isRole(value: unknown): value is CustomRole {
  if (!value || typeof value !== "object") return false;
  const role = value as Partial<CustomRole>;
  return typeof role.id === "string" && typeof role.key === "string" && Array.isArray(role.capabilities);
}

/** Normalise one record: unknown capabilities dropped, base role made valid. */
export function normalizeCustomRole(role: CustomRole): CustomRole {
  return {
    ...role,
    key: role.key.trim().toLowerCase(),
    name_en: role.name_en.trim(),
    name_ar: role.name_ar.trim(),
    base_role: (normalizeRole(role.base_role) ?? "viewer") as AppRole,
    capabilities: sanitizeCapabilities(role.capabilities),
    active: role.active !== false,
    is_system: role.is_system === true,
  };
}

export function readCustomRoles(): CustomRole[] {
  const raw = safeStorage.get(CUSTOM_ROLES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRole).map(normalizeCustomRole);
  } catch {
    return [];
  }
}

export function writeCustomRoles(roles: readonly CustomRole[]): void {
  safeStorage.set(CUSTOM_ROLES_STORAGE_KEY, JSON.stringify(roles.map(normalizeCustomRole)));
}

export function findCustomRole(id: string | null | undefined): CustomRole | null {
  if (!id) return null;
  return readCustomRoles().find((role) => role.id === id) ?? null;
}

/** The role a person is actually wearing: assigned *and* active. */
export function activeCustomRole(id: string | null | undefined): CustomRole | null {
  const role = findCustomRole(id);
  return role && role.active ? role : null;
}

export function upsertCustomRole(role: CustomRole): CustomRole[] {
  const roles = readCustomRoles();
  const index = roles.findIndex((existing) => existing.id === role.id);
  if (index >= 0) roles[index] = normalizeCustomRole(role);
  else roles.push(normalizeCustomRole(role));
  writeCustomRoles(roles);
  return readCustomRoles();
}

/** Test seam. */
export function resetCustomRoles(): void {
  safeStorage.set(CUSTOM_ROLES_STORAGE_KEY, "");
}

/**
 * Demo settings repository — the offline directory and role store.
 *
 * Reads and writes the same two stores the authentication layer reads
 * (`lib/auth/data/staffDirectory`, `lib/permissions/customRoleStore`), which is
 * what makes the offline path a real one: an account created here can sign in, a
 * role defined here changes what that person can do, and deactivating either
 * takes effect immediately.
 *
 * Two behaviours deliberately mirror the SQL RPCs instead of doing the easy
 * thing, so demo and live agree:
 *   · assigning a custom role also moves the system role to that role's base
 *     (`admin_set_custom_role`), so switching the overlay off later degrades the
 *     account to a known, safe role rather than to nothing;
 *   · changing the system role by hand clears the overlay
 *     (`admin_upsert_staff_profile`), because "cashier wearing the Sales Manager
 *     overlay" is a contradiction an admin would otherwise have to debug.
 */
import { AppError } from "@/modules/products/data/repository";
import { normalizeRole, type AppRole } from "@/lib/permissions/roles";
import { findCustomRole, readCustomRoles, upsertCustomRole } from "@/lib/permissions/customRoleStore";
import { sanitizeCapabilities, type CustomRole, type CustomRoleDraft } from "@/lib/permissions/customRoles";
import { createVerifier } from "@/lib/auth/services/password";
import {
  findStaffById,
  findStaffByUsername,
  readStaffDirectory,
  upsertStaffEntry,
  type StaffDirectoryEntry,
} from "@/lib/auth/data/staffDirectory";
import type { CustomRoleInput, SettingsRepository } from "./repository";
import type { ManagedUser, NewUserInput, UserPatch } from "../types";

function newId(prefix: string, seed: string): string {
  const slug = seed.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "user";
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}-${slug}-${random}`;
}

function roleLabel(entry: StaffDirectoryEntry): string | null {
  const role = findCustomRole(entry.custom_role_id);
  return role ? role.name_en : null;
}

function toManagedUser(entry: StaffDirectoryEntry): ManagedUser {
  return {
    id: entry.id,
    username: entry.username,
    name: entry.name,
    email: entry.email,
    phone: entry.phone,
    role: normalizeRole(entry.role) ?? "viewer",
    active: entry.active,
    custom_role_id: entry.custom_role_id,
    custom_role_name: roleLabel(entry),
    created_at: entry.created_at,
    last_login_at: entry.last_login_at,
  };
}

/** A stored entry, or a NOT_FOUND the UI can render as "this row is stale". */
function requireEntry(id: string): StaffDirectoryEntry {
  const entry = findStaffById(id);
  if (!entry) throw new AppError("NOT_FOUND", `No such user: ${id}`);
  return entry;
}

function requireRole(id: string): CustomRole {
  const role = findCustomRole(id);
  if (!role) throw new AppError("NOT_FOUND", `No such custom role: ${id}`);
  return role;
}

export class DemoSettingsRepository implements SettingsRepository {
  readonly kind = "demo" as const;

  async listUsers(): Promise<ManagedUser[]> {
    return readStaffDirectory().map(toManagedUser);
  }

  async createUser(input: NewUserInput): Promise<ManagedUser> {
    const username = input.username.trim().toLowerCase();
    if (findStaffByUsername(username)) {
      throw new AppError("VALIDATION", `Username already in use: ${username}`, "username");
    }
    if (!input.password) {
      throw new AppError("VALIDATION", "A password is required to create an account", "password");
    }

    // A custom role must exist and be active; assigning a dead overlay would
    // silently fall back to the base matrix and read as a bug.
    const overlay = input.custom_role_id ? findCustomRole(input.custom_role_id) : null;
    if (input.custom_role_id && (!overlay || !overlay.active)) {
      throw new AppError("VALIDATION", "Unknown or deactivated custom role", "custom_role_id");
    }

    const now = new Date().toISOString();
    const entry: StaffDirectoryEntry = {
      id: newId("user", username),
      username,
      name: input.name.trim(),
      email: input.email.trim() ? input.email.trim().toLowerCase() : null,
      phone: input.phone.trim() || null,
      // The overlay's base wins, exactly as `admin_set_custom_role` sets it.
      role: overlay ? overlay.base_role : (normalizeRole(input.role) ?? "viewer"),
      custom_role_id: overlay ? overlay.id : null,
      active: input.active !== false,
      created_at: now,
      last_login_at: null,
      password_updated_at: now,
      verifier: await createVerifier(input.password),
      system: false,
    };

    upsertStaffEntry(entry);
    return toManagedUser(entry);
  }

  async updateUser(id: string, patch: UserPatch): Promise<ManagedUser> {
    const entry = requireEntry(id);

    if (patch.username !== undefined) {
      const username = patch.username.trim().toLowerCase();
      const clash = findStaffByUsername(username);
      if (clash && clash.id !== id) {
        throw new AppError("VALIDATION", `Username already in use: ${username}`, "username");
      }
      entry.username = username;
    }
    if (patch.name !== undefined) entry.name = patch.name.trim();
    if (patch.email !== undefined) {
      entry.email = patch.email.trim() ? patch.email.trim().toLowerCase() : null;
    }
    if (patch.phone !== undefined) entry.phone = patch.phone.trim() || null;

    if (patch.role !== undefined) {
      const role = normalizeRole(patch.role);
      if (!role) throw new AppError("VALIDATION", "Unknown role", "role");
      if (role !== entry.role) {
        entry.role = role;
        // Mirror of the RPC: a hand-edited role clears the overlay.
        entry.custom_role_id = null;
      }
    }
    if (patch.active !== undefined) entry.active = patch.active;

    if (patch.custom_role_id !== undefined) {
      const overlay = patch.custom_role_id ? findCustomRole(patch.custom_role_id) : null;
      if (patch.custom_role_id && (!overlay || !overlay.active)) {
        throw new AppError("VALIDATION", "Unknown or deactivated custom role", "custom_role_id");
      }
      entry.custom_role_id = overlay ? overlay.id : null;
      if (overlay) entry.role = overlay.base_role;
    }

    upsertStaffEntry(entry);
    return toManagedUser(entry);
  }

  async setUserActive(id: string, active: boolean): Promise<ManagedUser> {
    const entry = requireEntry(id);
    entry.active = active;
    upsertStaffEntry(entry);
    return toManagedUser(entry);
  }

  async assignCustomRole(id: string, customRoleId: string | null): Promise<ManagedUser> {
    const entry = requireEntry(id);
    const overlay = customRoleId ? findCustomRole(customRoleId) : null;
    if (customRoleId && (!overlay || !overlay.active)) {
      throw new AppError("VALIDATION", "Unknown or deactivated custom role", "custom_role_id");
    }
    entry.custom_role_id = overlay ? overlay.id : null;
    if (overlay) entry.role = overlay.base_role;
    upsertStaffEntry(entry);
    return toManagedUser(entry);
  }

  async resetUserPassword(id: string, password: string): Promise<void> {
    const entry = requireEntry(id);
    if (!password) throw new AppError("VALIDATION", "A new password is required", "password");
    entry.verifier = await createVerifier(password);
    entry.password_updated_at = new Date().toISOString();
    upsertStaffEntry(entry);
  }

  // ── custom roles ────────────────────────────────────────────────────────

  async listCustomRoles(): Promise<CustomRole[]> {
    return readCustomRoles();
  }

  async createCustomRole(input: CustomRoleInput): Promise<CustomRole> {
    const key = input.key.trim().toLowerCase();
    if (readCustomRoles().some((role) => role.key === key)) {
      throw new AppError("VALIDATION", `Role key already in use: ${key}`, "key");
    }
    const capabilities = sanitizeCapabilities(input.capabilities);
    if (capabilities.length === 0) {
      throw new AppError("VALIDATION", "A custom role needs at least one permission", "capabilities");
    }

    const now = new Date().toISOString();
    const role: CustomRole = {
      id: newId("role", key),
      key,
      name_en: input.name_en.trim(),
      name_ar: input.name_ar.trim() || input.name_en.trim(),
      description_en: input.description_en.trim() || null,
      description_ar: input.description_ar.trim() || null,
      base_role: (normalizeRole(input.base_role) ?? "viewer") as AppRole,
      capabilities,
      active: input.active !== false,
      // Nothing offline is a shipped system role: every row here was typed by
      // an admin, so every row here may be edited.
      is_system: false,
      created_by: null,
      created_by_name: null,
      created_at: now,
      updated_at: now,
    };

    upsertCustomRole(role);
    return role;
  }

  async updateCustomRole(id: string, input: CustomRoleInput): Promise<CustomRole> {
    const existing = requireRole(id);
    const key = input.key.trim().toLowerCase();
    if (readCustomRoles().some((role) => role.key === key && role.id !== id)) {
      throw new AppError("VALIDATION", `Role key already in use: ${key}`, "key");
    }
    const capabilities = sanitizeCapabilities(input.capabilities);
    if (capabilities.length === 0) {
      throw new AppError("VALIDATION", "A custom role needs at least one permission", "capabilities");
    }

    const next: CustomRole = {
      ...existing,
      key,
      name_en: input.name_en.trim(),
      name_ar: input.name_ar.trim() || input.name_en.trim(),
      description_en: input.description_en.trim() || null,
      description_ar: input.description_ar.trim() || null,
      base_role: (normalizeRole(input.base_role) ?? existing.base_role) as AppRole,
      capabilities,
      active: input.active !== false,
      updated_at: new Date().toISOString(),
    };

    upsertCustomRole(next);
    return next;
  }

  async setCustomRoleActive(id: string, active: boolean): Promise<CustomRole> {
    const existing = requireRole(id);
    const next = { ...existing, active, updated_at: new Date().toISOString() };
    upsertCustomRole(next);
    return next;
  }
}

let singleton: DemoSettingsRepository | null = null;
export function getDemoSettingsRepository(): DemoSettingsRepository {
  if (!singleton) singleton = new DemoSettingsRepository();
  return singleton;
}

/** Test seam. */
export function resetDemoSettingsRepository(): void {
  singleton = null;
}

export type { CustomRoleDraft };

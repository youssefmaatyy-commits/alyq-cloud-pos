/**
 * Settings repository contract — accounts and custom roles.
 *
 * Two implementations, one interface, chosen by `data/index.ts` exactly like
 * every other module:
 *
 *   demo     `staffDirectory.ts` + `customRoleStore.ts` (browser storage)
 *   supabase `profiles` / `custom_roles` through the `admin_*` RPCs, and the
 *            `alyq-admin` edge function for the two things a browser must never
 *            be able to do alone: mint credentials and overwrite them.
 *
 * The split is not cosmetic. Creating an auth user needs the service role, so it
 * cannot be an RPC the anon key can call — which is why `createUser` and
 * `resetUserPassword` are the two methods that reach the edge function in live
 * mode, and why every other method goes through a `security definer` RPC that
 * re-checks `public.can(...)` server-side. A caller that forges the UI still
 * meets the database.
 */
import type { CustomRole, CustomRoleDraft } from "@/lib/permissions/customRoles";
import type { CapabilityExceptions } from "@/lib/permissions/exceptions";
import type { ManagedUser, NewUserInput, UserPatch } from "../types";

/** A draft plus the on/off switch the role list exposes. */
export type CustomRoleInput = CustomRoleDraft & { active: boolean };

export interface SettingsRepository {
  readonly kind: "supabase" | "demo";

  // ── accounts ────────────────────────────────────────────────────────────
  listUsers(): Promise<ManagedUser[]>;
  createUser(input: NewUserInput): Promise<ManagedUser>;
  updateUser(id: string, patch: UserPatch): Promise<ManagedUser>;
  /** Activate or deactivate. A deactivated account cannot sign in. */
  setUserActive(id: string, active: boolean): Promise<ManagedUser>;
  /** Assign or clear the custom-role overlay. */
  assignCustomRole(id: string, customRoleId: string | null): Promise<ManagedUser>;
  /**
   * Phase 17: replace one person's permission exceptions. Replaces rather than
   * patches, so what the admin sees in the picker is exactly what is stored.
   * Live mode goes through `admin_set_user_exceptions`, which re-checks
   * `public.can('manage_users')` server-side and refuses to strip the caller's
   * own oversight; demo mode writes the directory.
   */
  setUserExceptions(id: string, exceptions: CapabilityExceptions): Promise<ManagedUser>;
  /**
   * Admin reset: replace the password outright.
   * Live mode goes through the edge function (service role); demo mode writes a
   * fresh salt and digests into the directory.
   */
  resetUserPassword(id: string, password: string): Promise<void>;

  // ── custom roles ────────────────────────────────────────────────────────
  listCustomRoles(): Promise<CustomRole[]>;
  createCustomRole(input: CustomRoleInput): Promise<CustomRole>;
  updateCustomRole(id: string, input: CustomRoleInput): Promise<CustomRole>;
  setCustomRoleActive(id: string, active: boolean): Promise<CustomRole>;
}

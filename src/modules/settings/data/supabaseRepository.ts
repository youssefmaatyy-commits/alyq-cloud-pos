/**
 * Supabase settings repository — the live administration path.
 *
 * Every write goes through a `security definer` function that re-checks
 * `public.can(...)` before touching a row (`admin_upsert_staff_profile`,
 * `admin_set_custom_role`, `admin_create_custom_role`, …). That is the server
 * half of permission enforcement: hiding a button in the UI is a courtesy, and
 * these functions are the reason a forged request still fails.
 *
 * Two operations cannot be RPCs, because they need the service role:
 *
 *   · creating an account — that means creating an `auth.users` row, which no
 *     anon-key function may do;
 *   · resetting someone else's password — same reason.
 *
 * Both therefore call the `alyq-admin` edge function, which verifies the
 * caller's JWT, asks the database whether that caller may `manage_users`, and
 * only then uses the service key. The browser never holds a secret that could do
 * this on its own.
 *
 * Reads are plain selects: `profiles` and `custom_roles` are both RLS-guarded
 * for staff, so the list an admin sees is the list the database allows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import { normalizeRole, type AppRole } from "@/lib/permissions/roles";
import { usernameToEmail } from "@/lib/auth/services/identity";
import type { CustomRole, CustomRoleDraft } from "@/lib/permissions/customRoles";
import type { CustomRoleInput, SettingsRepository } from "./repository";
import type { ManagedUser, NewUserInput, UserPatch } from "../types";

interface ProfileRow {
  id: string;
  username: string | null;
  name: string | null;
  role: string | null;
  active: boolean | null;
  email: string | null;
  phone: string | null;
  custom_role_id: string | null;
  last_login_at: string | null;
  created_at: string | null;
}

interface CustomRoleRow {
  id: string;
  key: string;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  base_role: string | null;
  capabilities: string[] | null;
  active: boolean | null;
  is_system: boolean | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const PROFILE_COLUMNS =
  "id, username, name, role, active, email, phone, custom_role_id, last_login_at, created_at";
const ROLE_COLUMNS =
  "id, key, name_en, name_ar, description_en, description_ar, base_role, capabilities, active, is_system, created_by, created_by_name, created_at, updated_at";

/** The edge function that holds the service role. */
const ADMIN_FUNCTION = "alyq-admin";

function toCustomRole(row: CustomRoleRow): CustomRole {
  return {
    id: row.id,
    key: row.key,
    name_en: row.name_en ?? row.key,
    name_ar: row.name_ar ?? row.name_en ?? row.key,
    description_en: row.description_en,
    description_ar: row.description_ar,
    base_role: (normalizeRole(row.base_role) ?? "viewer") as AppRole,
    capabilities: (row.capabilities ?? []) as CustomRole["capabilities"],
    active: row.active !== false,
    is_system: row.is_system === true,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at ?? "",
    updated_at: row.updated_at ?? row.created_at ?? "",
  };
}

/**
 * Postgres' unique-violation code. Translated into a field error so the form can
 * highlight the offending input instead of showing a database message — the
 * constraint is the last line of defence against a race between two admins, and
 * its error should still read like a form validation.
 */
function translate(error: { code?: string; message?: string } | null, field?: string): never {
  const message = error?.message ?? "unknown error";
  if (error?.code === "23505" || /duplicate key/i.test(message)) {
    throw new AppError("VALIDATION", message, field ?? "form", error?.code);
  }
  if (error?.code === "42501" || /insufficient_privilege|Only an admin/i.test(message)) {
    throw new AppError("FORBIDDEN", message);
  }
  if (error?.code === "PGRST116" || /no_data_found|not found/i.test(message)) {
    throw new AppError("NOT_FOUND", message);
  }
  throw toAppError(error instanceof Error ? error : new Error(message));
}

export class SupabaseSettingsRepository implements SettingsRepository {
  readonly kind = "supabase" as const;

  /** Injectable so the contract test can drive this class against a stub. */
  constructor(private readonly injected: SupabaseClient | null = null) {}

  private client(): SupabaseClient {
    const client = this.injected ?? getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED", "SUPABASE_NOT_CONFIGURED");
    return client;
  }

  // ── accounts ────────────────────────────────────────────────────────────

  async listUsers(): Promise<ManagedUser[]> {
    const client = this.client();
    const [profiles, roles] = await Promise.all([
      client.from("profiles").select(PROFILE_COLUMNS).order("created_at", { ascending: true }),
      client.from("custom_roles").select("id, name_en, name_ar, active"),
    ]);
    if (profiles.error) translate(profiles.error);

    const names = new Map<string, string>();
    for (const row of ((roles.data ?? []) as Array<{ id: string; name_en: string | null }>)) {
      names.set(row.id, row.name_en ?? "");
    }

    return ((profiles.data ?? []) as ProfileRow[]).map((row) => ({
      id: row.id,
      username: row.username ?? row.email ?? row.id,
      name: row.name ?? row.username ?? row.id,
      email: row.email,
      phone: row.phone,
      role: (normalizeRole(row.role) ?? "viewer") as AppRole,
      active: row.active !== false,
      custom_role_id: row.custom_role_id,
      custom_role_name: row.custom_role_id ? names.get(row.custom_role_id) ?? null : null,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    }));
  }

  async createUser(input: NewUserInput): Promise<ManagedUser> {
    const client = this.client();
    // The auth user's address is the real email when one was given, and the
    // synthetic `username@alyq.local` otherwise — the same convention
    // `SupabaseUserRepository.authenticate` signs in with, so an account created
    // without an email is still reachable by username.
    const email = input.email.trim() ? input.email.trim().toLowerCase() : usernameToEmail(input.username);

    const { data, error } = await client.functions.invoke(ADMIN_FUNCTION, {
      body: {
        action: "create_user",
        payload: {
          email,
          password: input.password,
          username: input.username.trim().toLowerCase(),
          name: input.name.trim(),
          phone: input.phone.trim() || null,
          role: input.role,
          active: input.active !== false,
          custom_role_id: input.custom_role_id,
        },
      },
    });
    if (error) translate({ message: String(error) });

    const userId = (data as { user_id?: string } | null)?.user_id;
    if (!userId) translate({ message: "The admin function returned no user id" });

    // The overlay is a second call: `admin_set_custom_role` also moves the system
    // role to the overlay's base, and keeping that rule in one place (the RPC)
    // beats restating it in the edge function.
    if (input.custom_role_id) {
      const { error: roleError } = await client.rpc("admin_set_custom_role", {
        p_user_id: userId,
        p_custom_role_id: input.custom_role_id,
      });
      if (roleError) translate(roleError, "custom_role_id");
    }

    return this.readUser(userId);
  }

  async updateUser(id: string, patch: UserPatch): Promise<ManagedUser> {
    const client = this.client();
    const current = await this.readUser(id);

    const role = patch.role ?? current.role;
    const { data, error } = await client.rpc("admin_upsert_staff_profile", {
      p_user_id: id,
      p_username: patch.username ?? current.username,
      p_name: patch.name ?? current.name,
      p_email: patch.email ?? current.email ?? null,
      p_phone: patch.phone ?? current.phone ?? null,
      p_role: role,
      p_active: patch.active ?? current.active,
    });
    if (error) translate(error, "username");
    void data;

    if (patch.custom_role_id !== undefined && patch.custom_role_id !== current.custom_role_id) {
      const { error: roleError } = await client.rpc("admin_set_custom_role", {
        p_user_id: id,
        p_custom_role_id: patch.custom_role_id,
      });
      if (roleError) translate(roleError, "custom_role_id");
    }

    return this.readUser(id);
  }

  /**
   * Activate or deactivate.
   *
   * The RPC takes the whole profile (it is an upsert), so the current row is read
   * first and written back with one field changed. That costs a select and buys
   * the RPC's own guardrails — including its refusal to let an admin deactivate
   * themselves, which is the check that keeps an installation from locking
   * itself out.
   */
  async setUserActive(id: string, active: boolean): Promise<ManagedUser> {
    return this.updateUser(id, { active });
  }

  async assignCustomRole(id: string, customRoleId: string | null): Promise<ManagedUser> {
    const { error } = await this.client().rpc("admin_set_custom_role", {
      p_user_id: id,
      p_custom_role_id: customRoleId,
    });
    if (error) translate(error, "custom_role_id");
    return this.readUser(id);
  }

  async resetUserPassword(id: string, password: string): Promise<void> {
    if (!password) throw new AppError("VALIDATION", "A new password is required", "password");
    const { error } = await this.client().functions.invoke(ADMIN_FUNCTION, {
      body: { action: "reset_password", payload: { user_id: id, password } },
    });
    if (error) translate({ message: String(error) }, "password");
  }

  /** One profile, as the UI sees it. */
  private async readUser(id: string): Promise<ManagedUser> {
    const { data, error } = await this.client()
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) translate(error);
    const row = data as ProfileRow | null;
    if (!row) throw new AppError("NOT_FOUND", `No such user: ${id}`);

    let customRoleName: string | null = null;
    if (row.custom_role_id) {
      const { data: role } = await this.client()
        .from("custom_roles")
        .select("id, name_en")
        .eq("id", row.custom_role_id)
        .maybeSingle();
      customRoleName = (role as { name_en: string | null } | null)?.name_en ?? null;
    }

    return {
      id: row.id,
      username: row.username ?? row.email ?? row.id,
      name: row.name ?? row.username ?? row.id,
      email: row.email,
      phone: row.phone,
      role: (normalizeRole(row.role) ?? "viewer") as AppRole,
      active: row.active !== false,
      custom_role_id: row.custom_role_id,
      custom_role_name: customRoleName,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    };
  }

  // ── custom roles ────────────────────────────────────────────────────────

  async listCustomRoles(): Promise<CustomRole[]> {
    const { data, error } = await this.client()
      .from("custom_roles")
      .select(ROLE_COLUMNS)
      .order("created_at", { ascending: true });
    if (error) translate(error);
    return ((data ?? []) as CustomRoleRow[]).map(toCustomRole);
  }

  async createCustomRole(input: CustomRoleInput): Promise<CustomRole> {
    const { data, error } = await this.client().rpc("admin_create_custom_role", {
      p_key: input.key,
      p_name_en: input.name_en,
      p_name_ar: input.name_ar,
      p_description_en: input.description_en || null,
      p_description_ar: input.description_ar || null,
      p_base_role: input.base_role,
      p_capabilities: input.capabilities,
    });
    if (error) translate(error, "key");
    return toCustomRole(data as CustomRoleRow);
  }

  /**
   * Update a role. The key is not sent: `admin_update_custom_role` has no key
   * parameter, because a key is what stored `profiles.custom_role_id` rows and
   * audit entries refer to by name — changing it would rewrite history.
   */
  async updateCustomRole(id: string, input: CustomRoleInput): Promise<CustomRole> {
    const { data, error } = await this.client().rpc("admin_update_custom_role", {
      p_id: id,
      p_name_en: input.name_en,
      p_name_ar: input.name_ar,
      p_description_en: input.description_en || null,
      p_description_ar: input.description_ar || null,
      p_base_role: input.base_role,
      p_capabilities: input.capabilities,
    });
    if (error) translate(error, "capabilities");
    const updated = toCustomRole(data as CustomRoleRow);

    // Activation is its own RPC, so a role edited while deactivated stays
    // deactivated instead of being switched on as a side effect of a rename.
    if (updated.active !== input.active) return this.setCustomRoleActive(id, input.active);
    return updated;
  }

  async setCustomRoleActive(id: string, active: boolean): Promise<CustomRole> {
    const { data, error } = await this.client().rpc("admin_set_custom_role_active", {
      p_id: id,
      p_active: active,
    });
    if (error) translate(error);
    return toCustomRole(data as CustomRoleRow);
  }
}

let singleton: SupabaseSettingsRepository | null = null;
export function getSupabaseSettingsRepository(): SupabaseSettingsRepository {
  if (!singleton) singleton = new SupabaseSettingsRepository();
  return singleton;
}

/** Test seam. */
export function resetSupabaseSettingsRepository(): void {
  singleton = null;
}

export type { CustomRoleDraft };

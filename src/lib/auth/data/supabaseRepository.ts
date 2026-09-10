/**
 * Supabase user repository — the live path.
 *
 * Implemented against the Supabase JS client already used by every other
 * module: `auth.signInWithPassword()` for verification, then a `profiles` row
 * (`id`, `name`, `role`) for the display name and the role that
 * `normalizeRole()` maps onto the canonical model.
 *
 * Not exercised in this environment (Supabase is not configured — see
 * docs/AUTHORIZATION.md §3.4); it exists so the migration is a config change
 * rather than a rewrite, and so the shape of the live session is fixed.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import { normalizeRole } from "@/lib/permissions/roles";
import type { AuthenticateResult, UserRepository, AuthUserSummary } from "./repository";

interface ProfileRow {
  id: string;
  name: string | null;
  username: string | null;
  role: string | null;
}

export class SupabaseUserRepository implements UserRepository {
  readonly kind = "supabase" as const;

  private client() {
    const client = getSupabaseClient();
    if (!client) throw new Error("Supabase is not configured");
    return client;
  }

  async listUsers(): Promise<AuthUserSummary[]> {
    const { data, error } = await this.client().from("profiles").select("id, name, username, role");
    if (error) throw error;
    return ((data as ProfileRow[]) ?? []).flatMap((row) => {
      const role = normalizeRole(row.role);
      if (!role) return [];
      return [
        {
          id: row.id,
          username: row.username ?? row.id,
          name: row.name ?? row.username ?? row.id,
          role,
        },
      ];
    });
  }

  async authenticate(username: string, password: string): Promise<AuthenticateResult> {
    const client = this.client();
    // Supabase identifies users by email; the username is mapped to the
    // project's synthetic email convention here.
    const email = username.includes("@") ? username.trim() : `${username.trim().toLowerCase()}@alyq.local`;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false, code: "invalid_credentials" };

    const { data: profile } = await client
      .from("profiles")
      .select("id, name, username, role")
      .eq("id", data.user.id)
      .maybeSingle();

    const row = (profile as ProfileRow | null) ?? null;
    const role = normalizeRole(row?.role);
    if (!role) {
      // A signed-in user without a valid role must not inherit anything.
      await client.auth.signOut();
      return { ok: false, code: "invalid_credentials" };
    }

    return {
      ok: true,
      user: {
        id: row?.id ?? data.user.id,
        username: row?.username ?? username.trim().toLowerCase(),
        name: row?.name ?? data.user.email ?? username,
        role,
        auth_id: data.user.id,
      },
    };
  }

  async signOut(): Promise<void> {
    await this.client().auth.signOut();
  }
}

let singleton: SupabaseUserRepository | null = null;
export function getSupabaseUserRepository(): SupabaseUserRepository {
  if (!singleton) singleton = new SupabaseUserRepository();
  return singleton;
}

/**
 * Supabase user repository — the live identity path.
 *
 * Supabase Auth owns the credentials and the session; `profiles` owns the name,
 * the contact details, the system role and the custom-role overlay; `custom_roles`
 * owns what that overlay permits. This file is the only place those three are
 * joined into the `AuthUser` the rest of the application reasons about.
 *
 * What that division buys:
 *   · no password, hash or reset token is ever read, written or stored here —
 *     `signInWithPassword`, `resetPasswordForEmail` and `updateUser` are the
 *     whole of the app's involvement with secrets;
 *   · the session's expiry is the provider's. `expires_at` comes from
 *     `session.expires_at`, and `autoRefreshToken` (set in `lib/supabase/client`)
 *     plus `refreshSession()` below keep a long-running tab alive without a
 *     re-login;
 *   · `signOut({ scope: "global" })` is what "log out of every device" means,
 *     and it is the provider revoking its own refresh tokens, not this app
 *     clearing a key.
 *
 * Not exercised in this environment (no Supabase project is reachable), which is
 * why the shape is pinned by `src/lib/auth/__tests__/contract.selftest.ts`
 * against a stub client rather than left to a manual pass.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { buildAuthUser, usernameToEmail } from "../services/identity";
import { getCachedSession, readStoredSession } from "../services/sessionStore";
import type { AuthUser, PasswordResetOutcome } from "../types";
import type {
  AuthChangeEvent,
  AuthenticateResult,
  AuthUserSummary,
  LiveSessionInfo,
  PasswordUpdateResult,
  UserRepository,
} from "./repository";

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
  base_role: string | null;
  capabilities: string[] | null;
  active: boolean | null;
}

const PROFILE_COLUMNS =
  "id, username, name, role, active, email, phone, custom_role_id, last_login_at, created_at";

export class SupabaseUserRepository implements UserRepository {
  readonly kind = "supabase" as const;

  /**
   * Injectable so the contract test can drive this class against a stub client.
   * Production code never passes one: it takes the shared singleton.
   */
  constructor(private readonly injected: SupabaseClient | null = null) {}

  private client(): SupabaseClient {
    const client = this.injected ?? getSupabaseClient();
    if (!client) throw new Error("Supabase is not configured");
    return client;
  }

  // ── reading identities ────────────────────────────────────────────────────

  private async loadProfile(id: string): Promise<ProfileRow | null> {
    const { data } = await this.client()
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    return (data as ProfileRow | null) ?? null;
  }

  private async loadCustomRole(id: string | null): Promise<CustomRoleRow | null> {
    if (!id) return null;
    const { data } = await this.client()
      .from("custom_roles")
      .select("id, key, name_en, name_ar, base_role, capabilities, active")
      .eq("id", id)
      .maybeSingle();
    return (data as CustomRoleRow | null) ?? null;
  }

  /** Profile + overlay → `AuthUser`. Null when there is no usable profile. */
  private async identityFor(profile: ProfileRow | null, authId: string, fallbackName: string): Promise<AuthUser | null> {
    if (!profile) return null;
    const custom = await this.loadCustomRole(profile.custom_role_id);
    return buildAuthUser({
      id: profile.id,
      username: profile.username ?? profile.email ?? authId,
      name: profile.name ?? fallbackName,
      email: profile.email,
      phone: profile.phone,
      role: profile.role,
      active: profile.active !== false,
      custom_role_id: profile.custom_role_id,
      custom_role: custom
        ? {
            name_en: custom.name_en ?? custom.key,
            name_ar: custom.name_ar ?? custom.key,
            capabilities: custom.capabilities ?? [],
            active: custom.active !== false,
          }
        : null,
      last_login_at: profile.last_login_at,
      auth_id: authId,
    });
  }

  async listUsers(): Promise<AuthUserSummary[]> {
    const { data, error } = await this.client().from("profiles").select(PROFILE_COLUMNS);
    if (error) throw error;
    return ((data as ProfileRow[]) ?? []).map((row) => ({
      id: row.id,
      username: row.username ?? row.email ?? row.id,
      name: row.name ?? row.username ?? row.id,
      // An unmappable role is reported as the least privileged one rather than
      // dropped from the list: an admin has to be able to see the account in
      // order to fix it.
      role: (row.role ?? "viewer") as AuthUserSummary["role"],
      email: row.email,
      phone: row.phone,
      active: row.active !== false,
      custom_role_id: row.custom_role_id,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    }));
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async authenticate(username: string, password: string): Promise<AuthenticateResult> {
    const client = this.client();
    const handle = username.trim();
    if (!handle) return { ok: false, code: "missing_username" };
    if (!password) return { ok: false, code: "missing_password" };

    const email = usernameToEmail(handle);
    // The provider is asked once; everything below is our own bookkeeping. A
    // thrown network error becomes a coded failure so no caller has to catch on
    // our behalf to render a login form.
    let authId = "";
    try {
      const response = await client.auth.signInWithPassword({ email, password });
      const user = response.error ? null : response.data?.user ?? null;
      const session = response.error ? null : response.data?.session ?? null;
      if (!user || !session) {
        // One code for every credential refusal the provider can make, so the
        // form cannot be used to tell "no such account" from "wrong password".
        return { ok: false, code: "invalid_credentials" };
      }
      authId = user.id;
    } catch {
      return { ok: false, code: "network" };
    }

    const profile = await this.loadProfile(authId);
    if (profile && profile.active === false) {
      // Deactivated: end the session the provider just created, then say why.
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return { ok: false, code: "user_inactive" };
    }

    const user = await this.identityFor(profile, authId, email);
    if (!user || !user.role) {
      // Signed in but with no usable role: that must not inherit anything.
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return { ok: false, code: "invalid_credentials" };
    }

    void this.touchLogin(user.id);
    return { ok: true, user };
  }

  async currentSession(): Promise<LiveSessionInfo | null> {
    const client = this.client();
    const { data, error } = await client.auth.getSession();
    const session = data?.session ?? null;
    if (error || !session?.user) return null;

    const profile = await this.loadProfile(session.user.id);
    if (profile && profile.active === false) {
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return null;
    }
    const user = await this.identityFor(profile, session.user.id, session.user.email ?? session.user.id);
    if (!user || !user.role) return null;

    return {
      token: session.access_token,
      // The absolute cap is measured from when *this app* first saw the session,
      // so an already-running record is reused rather than reset on every read.
      issued_at: this.observedIssuedAt(user.id),
      expires_at: new Date(session.expires_at ? session.expires_at * 1000 : Date.now()).toISOString(),
      refreshable: true,
      user,
    };
  }

  async refreshSession(): Promise<LiveSessionInfo | null> {
    const client = this.client();
    const { data, error } = await client.auth.refreshSession();
    const session = data?.session ?? null;
    if (error || !session?.user) return null;

    const profile = await this.loadProfile(session.user.id);
    if (profile && profile.active === false) {
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return null;
    }
    const user = await this.identityFor(profile, session.user.id, session.user.email ?? session.user.id);
    if (!user || !user.role) return null;

    return {
      token: session.access_token,
      issued_at: this.observedIssuedAt(user.id),
      expires_at: new Date(session.expires_at ? session.expires_at * 1000 : Date.now()).toISOString(),
      refreshable: true,
      user,
    };
  }

  /** When this app first saw the current user's session (for the absolute cap). */
  private observedIssuedAt(userId: string): string {
    const stored = getCachedSession() ?? readStoredSession()?.session ?? null;
    if (stored && stored.user.id === userId && stored.issued_at) return stored.issued_at;
    return new Date().toISOString();
  }

  onAuthChange(listener: (event: AuthChangeEvent) => void): () => void {
    const client = this.client();
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session?.user) {
        listener({ type: "signed_out" });
        return;
      }
      // Resolving the profile is async, so the listener fires a tick later than
      // the provider's own callback. That is deliberate: an event carrying a
      // half-built user would let a screen render with no capabilities.
      void (async () => {
        const profile = await this.loadProfile(session.user.id);
        const user = await this.identityFor(profile, session.user.id, session.user.email ?? session.user.id);
        if (!user || !user.role || user.active === false) {
          listener({ type: "signed_out" });
          return;
        }
        const type: AuthChangeEvent["type"] =
          event === "TOKEN_REFRESHED"
            ? "token_refreshed"
            : event === "USER_UPDATED"
              ? "user_updated"
              : "signed_in";
        listener({ type, user });
      })();
    });
    return () => data.subscription.unsubscribe();
  }

  async signOut(options?: { everywhere?: boolean }): Promise<void> {
    // `global` revokes every session the provider holds for this user, which is
    // what "log out of all devices" has to mean; `local` only ends this browser's.
    await this.client().auth.signOut({ scope: options?.everywhere ? "global" : "local" });
  }

  // ── password recovery ─────────────────────────────────────────────────────

  async requestPasswordReset(identifier: string, redirectTo?: string): Promise<PasswordResetOutcome> {
    const handle = identifier.trim();
    if (!handle) return { ok: false, code: "missing_identifier" };
    if (!handle.includes("@") && !/^[a-z0-9._-]{2,64}$/i.test(handle)) {
      return { ok: false, code: "invalid_email" };
    }

    try {
      const { error } = await this.client().auth.resetPasswordForEmail(usernameToEmail(handle), {
        redirectTo,
      });
      if (error) return { ok: false, code: "network" };
    } catch {
      return { ok: false, code: "network" };
    }
    // Supabase answers the same way whether or not the address exists, and so
    // does this: the screen says "if that account exists, a link is on its way".
    return { ok: true, channel: "email" };
  }

  async updatePassword(newPassword: string): Promise<PasswordUpdateResult> {
    if (newPassword.length < 8) return { ok: false, code: "weak_password" };
    try {
      const { error } = await this.client().auth.updateUser({ password: newPassword });
      if (!error) return { ok: true };
      const message = `${error.message ?? ""}`.toLowerCase();
      if (message.includes("weak") || message.includes("short") || message.includes("pws0001")) {
        return { ok: false, code: "weak_password" };
      }
      if (message.includes("not authenticated") || message.includes("session")) {
        return { ok: false, code: "not_authenticated" };
      }
      return { ok: false, code: "unknown" };
    } catch {
      return { ok: false, code: "network" };
    }
  }

  async touchLogin(_userId: string): Promise<void> {
    // Self-only and best effort: a failed timestamp must never fail a sign-in.
    void _userId;
    try {
      await this.client().rpc("admin_touch_login");
    } catch {
      /* ignore */
    }
  }
}

let singleton: SupabaseUserRepository | null = null;
export function getSupabaseUserRepository(): SupabaseUserRepository {
  if (!singleton) singleton = new SupabaseUserRepository();
  return singleton;
}

/** Test seam. */
export function resetSupabaseUserRepository(): void {
  singleton = null;
}

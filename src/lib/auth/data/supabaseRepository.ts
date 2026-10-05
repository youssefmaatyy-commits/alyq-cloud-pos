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
import { buildAuthUser } from "../services/identity";
import { recoveryMaterialConsumed, markRecoveryMaterialConsumed } from "../services/recoveryOnce";
import { recoveryParams } from "../services/recoveryUrl";
import { getCachedSession, readStoredSession } from "../services/sessionStore";
import type { AuthUser, PasswordResetOutcome } from "../types";
import { CAPABILITIES, type Capability } from "@/lib/permissions/roles";
import type {
  AuthChangeEvent,
  AuthenticateResult,
  AuthUserSummary,
  LiveSessionInfo,
  PasswordUpdateResult,
  RecoveryLinkParts,
  RecoveryLinkResult,
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
  extra_capabilities: string[] | null;
  denied_capabilities: string[] | null;
  last_login_at: string | null;
  created_at: string | null;
}

interface ActiveBranchContextRow {
  branch_id: string;
  branch_code: string;
  branch_name_en: string;
  branch_name_ar: string;
  role: string;
  custom_role_id: string | null;
  custom_role_name: string | null;
  capabilities: string[];
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
  "id, username, name, role, active, email, phone, custom_role_id, extra_capabilities, denied_capabilities, last_login_at, created_at";

/**
 * The edge function that turns a bare username into an authenticated session
 * without ever telling the browser which email sits behind it. It verifies the
 * password through Supabase Auth's own password grant and returns tokens only;
 * `authenticate()` and `requestPasswordReset()` below are its sole callers.
 */
const AUTH_FUNCTION = "alyq-auth";

interface AuthFunctionSession {
  access_token: string;
  refresh_token: string;
}

type AuthFunctionOutcome =
  | { ok: true; session?: AuthFunctionSession | null }
  | { ok: false; code?: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

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

  /**
   * In-flight de-duplication for the two reads every identity-refresh path
   * (boot, resume-from-background, the provider's own `onAuthStateChange`,
   * cross-tab sync, explicit `refreshIdentity`) ultimately funnels through.
   *
   * Each of those triggers can legitimately fire within the same tick — a tab
   * resuming at the same moment the provider fires `TOKEN_REFRESHED`, say —
   * and without this, each would open its own `profiles` + `get_active_branch_context`
   * (+ `custom_roles`) round trip for the exact same answer. Concurrent callers
   * instead share the one request already in flight; the slot is cleared the
   * moment it settles, so the NEXT call (a genuinely later refresh) is never
   * starved of a fresh read.
   */
  private pendingCurrentSession: Promise<LiveSessionInfo | null> | null = null;
  private pendingRefreshSession: Promise<LiveSessionInfo | null> | null = null;

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
    // Branch membership is the live authority. Profile-global fields remain a
    // safe compatibility fallback only for installations in the middle of the
    // forward migration; after 0071 this RPC always supplies the active branch.
    const { data: branchData } = await this.client().rpc("get_active_branch_context");
    const branch = (branchData as ActiveBranchContextRow | null) ?? null;
    const customId = branch?.custom_role_id ?? profile.custom_role_id;
    const custom = await this.loadCustomRole(customId);
    const built = buildAuthUser({
      id: profile.id,
      username: profile.username ?? profile.email ?? authId,
      name: profile.name ?? fallbackName,
      email: profile.email,
      phone: profile.phone,
      role: branch?.role ?? profile.role,
      active: profile.active !== false,
      custom_role_id: customId,
      custom_role: custom
        ? {
            name_en: custom.name_en ?? custom.key,
            name_ar: custom.name_ar ?? custom.key,
            capabilities: custom.capabilities ?? [],
            active: custom.active !== false,
          }
        : null,
      // The RPC has already resolved membership grants and denials.
      exceptions: branch ? { extra: null, denied: null } : {
        extra: profile.extra_capabilities,
        denied: profile.denied_capabilities,
      },
      last_login_at: profile.last_login_at,
      auth_id: authId,
    });
    if (!built) return null;
    return {
      ...built,
      capabilities: branch
        ? branch.capabilities.filter((capability): capability is Capability =>
            CAPABILITIES.includes(capability as Capability),
          )
        : built.capabilities,
      custom_role_name: branch?.custom_role_name ?? built.custom_role_name,
      active_branch_id: branch?.branch_id ?? null,
      active_branch_code: branch?.branch_code ?? null,
      active_branch_name_en: branch?.branch_name_en ?? null,
      active_branch_name_ar: branch?.branch_name_ar ?? null,
    };
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

  /**
   * Call `alyq-auth` and reduce every shape it can answer with — 200 body,
   * coded non-2xx body, relay failure — onto one discriminated result. The
   * browser neither sends nor receives a real email on this path: the request
   * carries the username as typed, and a successful answer carries tokens.
   */
  private async invokeAuthFunction(
    action: "login" | "recover",
    payload: Record<string, unknown>,
  ): Promise<AuthFunctionOutcome> {
    const { data, error } = await this.client().functions.invoke(AUTH_FUNCTION, {
      body: { action, payload },
    });
    let body = asRecord(data);
    if (!body && error) {
      // supabase-js wraps a non-2xx response in a FunctionsHttpError whose
      // `context` is the Response itself; the coded body is in it.
      const context = (error as { context?: { json?: () => Promise<unknown> } }).context;
      try {
        body = asRecord(await context?.json?.());
      } catch {
        body = null;
      }
    }
    if (!body) return { ok: false, code: "network" };
    if (body.ok === true) {
      const session = asRecord(body.session);
      return {
        ok: true,
        session:
          session && typeof session.access_token === "string" && typeof session.refresh_token === "string"
            ? { access_token: session.access_token, refresh_token: session.refresh_token }
            : action === "login"
              ? null
              : undefined,
      };
    }
    const nested = asRecord(body.error);
    const code =
      typeof body.code === "string" ? body.code : typeof nested?.code === "string" ? nested.code : undefined;
    return { ok: false, code };
  }

  async authenticate(username: string, password: string): Promise<AuthenticateResult> {
    const client = this.client();
    const handle = username.trim();
    if (!handle) return { ok: false, code: "missing_username" };
    if (!password) return { ok: false, code: "missing_password" };

    // Two roads to the same provider verdict.
    //
    // An email address goes to `signInWithPassword` directly — the pre-existing
    // path, unchanged, so email login keeps working exactly as before.
    //
    // A bare username goes through the `alyq-auth` function, because the
    // address behind it lives in `auth.users`, is shielded by the profiles RLS,
    // and must never be revealed to an unauthenticated browser just to resolve
    // a username. The function verifies the password with the provider itself
    // and answers with session tokens — no email — which are adopted here with
    // `setSession`. Accounts whose Auth email is the synthetic
    // `<username>@alyq.local` resolve through the same door: the function reads
    // whatever address the provider actually holds.
    let authId: string;
    let fallbackName: string;
    try {
      if (handle.includes("@")) {
        const email = handle.toLowerCase();
        fallbackName = email;
        const response = await client.auth.signInWithPassword({ email, password });
        const user = response.error ? null : response.data?.user ?? null;
        const session = response.error ? null : response.data?.session ?? null;
        if (!user || !session) {
          // One code for every credential refusal the provider can make, so the
          // form cannot be used to tell "no such account" from "wrong password".
          return { ok: false, code: "invalid_credentials" };
        }
        authId = user.id;
      } else {
        fallbackName = handle;
        const outcome = await this.invokeAuthFunction("login", { identifier: handle, password });
        if (!outcome.ok) {
          // The function's refusals are already generic; they are mapped onto
          // the same vocabulary the direct path uses, and anything unrecognized
          // (undeployed function, relay failure) is a network problem, never a
          // credential verdict.
          if (outcome.code === "invalid_credentials") return { ok: false, code: "invalid_credentials" };
          if (outcome.code === "user_inactive") return { ok: false, code: "user_inactive" };
          if (outcome.code === "rate_limited") return { ok: false, code: "rate_limited" };
          return { ok: false, code: "network" };
        }
        const tokens = outcome.session;
        if (!tokens?.access_token || !tokens?.refresh_token) return { ok: false, code: "network" };
        const { data: adopted, error: adoptError } = await client.auth.setSession({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        });
        const adoptedId = adopted?.user?.id ?? null;
        if (adoptError || !adoptedId) {
          // The provider refused to adopt its own tokens: a sign-in that did
          // not happen, reported like any other failure.
          return { ok: false, code: "network" };
        }
        authId = adoptedId;
      }
    } catch {
      return { ok: false, code: "network" };
    }

    // The shared tail, identical for both roads: a token is not an identity.
    // The profile still has to exist, be active and carry a mappable role —
    // defense in depth over the function's own gate, and the whole of the gate
    // on the direct email path.
    const profile = await this.loadProfile(authId);
    if (profile && profile.active === false) {
      // Deactivated: end the session the provider just created, then say why.
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return { ok: false, code: "user_inactive" };
    }

    const user = await this.identityFor(profile, authId, fallbackName);
    if (!user || !user.role) {
      // Signed in but with no usable role: that must not inherit anything.
      await client.auth.signOut({ scope: "local" }).catch(() => undefined);
      return { ok: false, code: "invalid_credentials" };
    }

    void this.touchLogin(user.id);
    return { ok: true, user };
  }

  async currentSession(): Promise<LiveSessionInfo | null> {
    if (!this.pendingCurrentSession) {
      this.pendingCurrentSession = this.doCurrentSession().finally(() => {
        this.pendingCurrentSession = null;
      });
    }
    return this.pendingCurrentSession;
  }

  private async doCurrentSession(): Promise<LiveSessionInfo | null> {
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
    if (!this.pendingRefreshSession) {
      this.pendingRefreshSession = this.doRefreshSession().finally(() => {
        this.pendingRefreshSession = null;
      });
    }
    return this.pendingRefreshSession;
  }

  private async doRefreshSession(): Promise<LiveSessionInfo | null> {
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
      if (!handle.includes("@")) {
        // A bare username: the address recovery must go to is the REAL Auth
        // email, which no unauthenticated browser may learn. The `alyq-auth`
        // function resolves it server-side and hands it to Supabase's own
        // recovery mailer; the public answer is the same generic one either
        // way, so this endpoint is no directory of who works here.
        const outcome = await this.invokeAuthFunction("recover", {
          identifier: handle,
          redirect_to: redirectTo ?? "",
        });
        if (outcome.ok) return { ok: true, channel: "email" };
        if (outcome.code === "rate_limited") return { ok: false, code: "rate_limited" };
        return { ok: false, code: "network" };
      }
      const { error } = await this.client().auth.resetPasswordForEmail(handle.toLowerCase(), {
        redirectTo,
      });
      if (error) {
        // Throttling is worth naming: "try again in a minute" is a different
        // instruction from "we cannot reach the server".
        const message = `${error.message ?? ""}`.toLowerCase();
        if (message.includes("rate limit") || message.includes("too many") || message.includes("60 seconds")) {
          return { ok: false, code: "rate_limited" };
        }
        return { ok: false, code: "network" };
      }
    } catch {
      return { ok: false, code: "network" };
    }
    // Supabase answers the same way whether or not the address exists, and so
    // does this: the screen says "if that account exists, a link is on its way".
    return { ok: true, channel: "email" };
  }

  /**
   * Consume a recovery link.
   *
   * Both of Supabase's flows are handled, because which one arrives depends on
   * the project's auth configuration rather than on this app: PKCE gives a
   * `?code=` to exchange, the implicit flow gives an access and refresh token in
   * the fragment. Either way the result is the same — a session the provider
   * recognises as "this person proved control of their inbox" — and only then may
   * `updatePassword` be called.
   *
   * Everything that can go wrong (expired, already used, tampered with) is
   * reported as `expired`, because that is the only useful thing to tell someone
   * standing on a reset page: ask for a new link.
   */
  async consumeRecoveryLink(parts: RecoveryLinkParts): Promise<RecoveryLinkResult> {
    const client = this.client();
    const params = recoveryParams(parts);

    const code = params.get("code");
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (!code && !(accessToken && refreshToken)) {
      // No recovery material in the URL, no authority — and that is the whole
      // of it. A normal, already-signed-in provider session is explicitly NOT
      // recovery authority, so this route refuses instead of borrowing it and
      // quietly granting whoever holds the browser a password change.
      return { ok: false, code: "not_authenticated" };
    }

    if (!code) {
      // The implicit flow delivers a token pair. That pair is only trusted as
      // RECOVERY material when the URL says so (`type=recovery` is what the
      // provider appends to recovery emails); otherwise any session tokens
      // pasted into this URL shape would unlock the change form.
      if (params.get("type") !== "recovery") return { ok: false, code: "expired" };
    }

    // And only once per browser: a LINK is an email effect. Reusing consumed
    // material — from the back button, a refresh after a successful change, or
    // a logout that leaves the URL behind — must fail, not re-authorise.
    const material = code ?? `${accessToken}:${refreshToken}`;
    if (recoveryMaterialConsumed(material)) return { ok: false, code: "expired" };

    try {
      if (code) {
        const { error } = await client.auth.exchangeCodeForSession(code);
        if (error) return { ok: false, code: "expired" };
      } else {
        const { error } = await client.auth.setSession({
          access_token: accessToken as string,
          refresh_token: refreshToken as string,
        });
        if (error) return { ok: false, code: "expired" };
      }
    } catch {
      return { ok: false, code: "network" };
    }

    // A token is not an identity: the profile still has to exist and be active,
    // or a deactivated account could reset its way back in.
    const session = await this.currentSession().catch(() => null);
    if (!session?.user) return { ok: false, code: "expired" };

    // The authority is real — burn it locally so this link cannot be spent
    // twice from this browser (the provider enforces single-use server-side
    // for PKCE codes and rotation for refresh tokens; this is the client-side
    // belt to those suspenders).
    markRecoveryMaterialConsumed(material);
    return { ok: true };
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

  /**
   * Signed-in self-service change. The current password is re-proven by a
   * fresh sign-in round-trip THROUGH `authenticate` — the same door an ordinary
   * login walks through, so a username account re-verifies against the
   * `alyq-auth` function and an email account against the provider directly —
   * and only when that succeeds is the new password written. A wrong current
   * password never touches the session or the credential.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<PasswordUpdateResult> {
    if (newPassword.length < 8) return { ok: false, code: "weak_password" };

    const live = await this.currentSession().catch(() => null);
    if (!live?.user) return { ok: false, code: "not_authenticated" };

    // The login handle for this session: a bare username goes via the edge
    // function, a full email address straight to the provider — exactly the
    // routing `authenticate` already implements.
    const identifier = (live.user.username || live.user.email || "").trim();
    if (!identifier) return { ok: false, code: "not_authenticated" };

    const reauth = await this.authenticate(identifier, currentPassword);
    if (!reauth.ok) {
      if (reauth.code === "invalid_credentials") return { ok: false, code: "invalid_credentials" };
      if (reauth.code === "rate_limited") return { ok: false, code: "rate_limited" };
      // A deactivated account's current-session check above already clears the
      // provider session; by the time authenticate reports it, "signed out" is
      // the state this page is actually in.
      if (reauth.code === "user_inactive") return { ok: false, code: "not_authenticated" };
      return { ok: false, code: reauth.code === "network" ? "network" : "unknown" };
    }

    return this.updatePassword(newPassword);
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

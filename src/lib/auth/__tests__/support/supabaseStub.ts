/**
 * Shared fake Supabase client for the auth test suites.
 *
 * Extracted from `supabaseAuth.contract.selftest.ts` (Task 10) so the same,
 * already-proven stub can also drive an `AuthProvider`-level harness --
 * exercising navigation, resume, sign-in/out and cross-tab wiring against a
 * real `SupabaseUserRepository` without a reachable Supabase project.
 */
import { usernameToEmail } from "../../services/identity";

// ── stub client ──────────────────────────────────────────────────────────────

export interface StubOptions {
  profiles?: Record<string, unknown>[];
  customRoles?: Record<string, unknown>[];
  signInError?: { message: string } | null;
  session?: Record<string, unknown> | null;
  refreshError?: { message: string } | null;
  exchangeError?: { message: string } | null;
  resetError?: { message: string } | null;
  updateError?: { message: string } | null;
  rpcError?: { message: string } | null;
  throwOn?: string[];
  /** The edge function answers this coded body with a non-2xx (context.json). */
  functionError?: { status: number; body: unknown } | null;
  /** The edge function call itself fails (undeployed, relay error): no body. */
  functionThrows?: boolean;
  /**
   * Emulate a BUGGY function that skips the active-account gate, to prove the
   * repository's own tail still refuses a deactivated profile (defense in
   * depth: a direct call cannot bypass the active-user check).
   */
  functionIgnoresActive?: boolean;
}

export function makeStub(options: StubOptions = {}) {
  const calls: string[] = [];
  const signOutScopes: string[] = [];
  const resetCalls: Array<{ email: string; redirectTo?: string }> = [];
  const updateCalls: Array<{ password: string }> = [];
  const rpcCalls: string[] = [];
  const functionCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const recoverCalls: Array<{ identifier: string; redirectTo?: string }> = [];
  let authListener: ((event: string, session: unknown) => void) | null = null;
  // The session the edge-function login emulator "issued"; the setSession stub
  // adopts it so the repository's tail resolves the RIGHT user, not a fixed one.
  let functionSession: Record<string, unknown> | null = null;

  const profileRows = options.profiles ?? [
    {
      id: "u-admin",
      username: "admin",
      name: "Store Admin",
      role: "admin",
      active: true,
      // Production truth: the Auth identity is a REAL email, and the username
      // is how staff sign in. The old synthetic `admin@alyq.local` convention
      // is exactly what broke username login for accounts like this one.
      email: "admin@alyq.example",
      phone: "+201000000001",
      custom_role_id: null,
      last_login_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "u-sales",
      username: "sales.lead",
      name: "Sales Lead",
      role: "manager",
      active: true,
      email: "sales@alyq.example",
      phone: null,
      custom_role_id: "cr-sales-manager",
      last_login_at: null,
      created_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "u-off",
      username: "gone",
      name: "Deactivated",
      role: "cashier",
      active: false,
      email: "gone@alyq.example",
      phone: null,
      custom_role_id: null,
      last_login_at: null,
      created_at: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "u-view",
      username: "vera",
      name: "Vera Viewer",
      role: "viewer",
      active: true,
      email: "vera@alyq.example",
      phone: null,
      custom_role_id: null,
      last_login_at: null,
      created_at: "2026-01-04T00:00:00.000Z",
    },
  ];
  const customRoleRows = options.customRoles ?? [
    {
      id: "cr-sales-manager",
      key: "sales_manager",
      name_en: "Sales Manager",
      name_ar: "مدير مبيعات",
      base_role: "manager",
      capabilities: ["sell", "edit_sale", "apply_discount", "void_sale", "view_reports"],
      active: true,
    },
  ];

  const genericTables: Record<string, Record<string, unknown>[]> = {};

  const maybeThrow = (what: string) => {
    if (options.throwOn?.includes(what)) throw new Error(`stub failure: ${what}`);
  };

  const table = (name: string, rows: Record<string, unknown>[]) => ({
    select(_columns: string) {
      return {
        eq(column: string, value: unknown) {
          return {
            maybeSingle: async () => {
              calls.push(`from.${name}.eq.${column}`);
              maybeThrow(`from.${name}`);
              return { data: rows.find((r) => r[column] === value) ?? null, error: null };
            },
            single: async () => {
              calls.push(`from.${name}.eq.${column}`);
              return { data: rows.find((r) => r[column] === value) ?? null, error: null };
            },
          };
        },
        order() {
          return this;
        },
        limit: async () => {
          calls.push(`from.${name}.select`);
          return { data: rows, error: null };
        },
        then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
          calls.push(`from.${name}.select`);
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
    },
    // A generic insert, accepted for any table (most relevantly `audit_log`):
    // callers outside this module's own concern (sign-in/out, role changes)
    // still write audit entries, and a stub that cannot accept them would
    // make every such action spuriously log a console error.
    insert(row: Record<string, unknown>) {
      calls.push(`from.${name}.insert`);
      maybeThrow(`from.${name}.insert`);
      const inserted = { id: `${name}-${rows.length + 1}`, created_at: new Date().toISOString(), ...row };
      rows.push(inserted);
      return {
        select: (_columns?: string) => ({
          single: async () => ({ data: inserted, error: null }),
        }),
      };
    },
  });

  const session = options.session === undefined
    ? {
        access_token: "provider-access-token",
        expires_at: Math.floor((Date.now() + 3600_000) / 1000),
        user: { id: "u-admin", email: "admin@alyq.example" },
      }
    : options.session;

  const client = {
    auth: {
      signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
        calls.push(`signInWithPassword:${email}`);
        maybeThrow("signInWithPassword");
        if (options.signInError) return { data: null, error: options.signInError };
        if (password !== "CorrectHorse1") return { data: null, error: { message: "Invalid login credentials" } };
        // Match the way the live schema does: `profiles.email` is the auth
        // email, and a bare username maps to the synthetic `@alyq.local` address.
        const row = profileRows.find(
          (p) => p.email === email || usernameToEmail(String(p.username ?? "")) === email,
        );
        const id = row ? String(row.id) : email.startsWith("gone") ? "u-off" : "u-unknown";
        return {
          data: {
            user: { id, email },
            session: {
              access_token: "provider-access-token",
              expires_at: Math.floor((Date.now() + 3600_000) / 1000),
              user: { id, email },
            },
          },
          error: null,
        };
      },
      getSession: async () => {
        calls.push("getSession");
        maybeThrow("getSession");
        return { data: { session }, error: null };
      },
      refreshSession: async () => {
        calls.push("refreshSession");
        maybeThrow("refreshSession");
        if (options.refreshError) return { data: null, error: options.refreshError };
        return {
          data: {
            session: {
              ...session,
              access_token: "refreshed-token",
              expires_at: Math.floor((Date.now() + 7200_000) / 1000),
            },
          },
          error: null,
        };
      },
      signOut: async ({ scope }: { scope?: string } = {}) => {
        calls.push(`signOut:${scope ?? "local"}`);
        signOutScopes.push(scope ?? "local");
        return { error: null };
      },
      exchangeCodeForSession: async (code: string) => {
        calls.push(`exchangeCodeForSession:${code}`);
        maybeThrow("exchangeCodeForSession");
        if (options.exchangeError) return { data: null, error: options.exchangeError };
        return { data: { session }, error: null };
      },
      setSession: async ({ access_token }: { access_token: string; refresh_token: string }) => {
        calls.push(`setSession:${access_token}`);
        maybeThrow("setSession");
        if (options.exchangeError) return { data: null, error: options.exchangeError };
        // The real provider answers `{ data: { user, session } }`; a session the
        // edge-function login "issued" is adopted here so the repository's tail
        // resolves the right identity.
        const adopted = (functionSession ?? session) as Record<string, unknown> | null;
        return {
          data: adopted ? { session: adopted, user: adopted.user ?? null } : null,
          error: null,
        };
      },
      resetPasswordForEmail: async (email: string, opts?: { redirectTo?: string }) => {
        resetCalls.push({ email, redirectTo: opts?.redirectTo });
        calls.push("resetPasswordForEmail");
        maybeThrow("resetPasswordForEmail");
        return { error: options.resetError ?? null };
      },
      updateUser: async ({ password }: { password: string }) => {
        updateCalls.push({ password });
        calls.push("updateUser");
        maybeThrow("updateUser");
        return { error: options.updateError ?? null };
      },
      onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
        authListener = listener;
        calls.push("onAuthStateChange");
        return { data: { subscription: { unsubscribe: () => calls.push("unsubscribe") } } };
      },
    },
    from: (name: string) => {
      if (name === "profiles") return table("profiles", profileRows);
      if (name === "custom_roles") return table("custom_roles", customRoleRows);
      // Any other table (e.g. `audit_log`) the app writes to in passing:
      // a fresh, independent row set per table name, insert-capable, so a
      // write from this generic path never throws for lack of a shape.
      genericTables[name] ??= [];
      return table(name, genericTables[name]);
    },
    /**
     * The `alyq-auth` edge function, emulated against the same stub rows:
     * a bare username resolves to its profile, the password rule is the stub's
     * ("CorrectHorse1"), and — exactly like the real function — an unknown
     * username and a wrong password produce the SAME generic coded refusal,
     * while a known-but-deactivated account produces `user_inactive` only
     * after the password proved correct. Success carries tokens, never an
     * email.
     */
    functions: {
      invoke: async (name: string, opts?: { body?: unknown }) => {
        const body = (opts?.body ?? {}) as Record<string, unknown>;
        calls.push(`functions:${name}:${String(body.action ?? "?")}`);
        functionCalls.push({ name, body });
        maybeThrow("functions.invoke");

        const codedRefusal = (status: number, codedBody: unknown) => {
          const httpError = new Error(`edge function returned ${status}`) as Error & {
            context?: { json?: () => Promise<unknown> };
          };
          httpError.context = { json: async () => codedBody };
          return { data: null, error: httpError };
        };

        if (options.functionThrows) {
          // Relay failure / undeployed function: an error with no parseable body.
          return { data: null, error: new Error("FunctionsHttpError") };
        }
        if (options.functionError) {
          return codedRefusal(options.functionError.status, options.functionError.body);
        }
        if (name !== "alyq-auth") {
          return { data: null, error: new Error("Function not found") };
        }

        const payload = (body.payload ?? {}) as Record<string, unknown>;
        if (body.action === "login") {
          const identifier = String(payload.identifier ?? "").trim().toLowerCase();
          const password = String(payload.password ?? "");
          const row = profileRows.find(
            (p) => String(p.username ?? "").toLowerCase() === identifier,
          );
          if (!row || password !== "CorrectHorse1") {
            return codedRefusal(400, { ok: false, code: "invalid_credentials" });
          }
          if (row.active === false && !options.functionIgnoresActive) {
            return codedRefusal(403, { ok: false, code: "user_inactive" });
          }
          const accessToken = `function-token-${String(row.id)}`;
          functionSession = {
            access_token: accessToken,
            expires_at: Math.floor((Date.now() + 3600_000) / 1000),
            user: { id: row.id, email: row.email },
          };
          return {
            data: {
              ok: true,
              session: {
                access_token: accessToken,
                refresh_token: "function-refresh-token",
                expires_in: 3600,
                token_type: "bearer",
              },
            },
            error: null,
          };
        }
        if (body.action === "recover") {
          recoverCalls.push({
            identifier: String(payload.identifier ?? ""),
            redirectTo: typeof payload.redirect_to === "string" ? payload.redirect_to : undefined,
          });
          // Enumeration-resistant: the same answer whether or not anybody owns
          // the identifier.
          return { data: { ok: true, channel: "email" }, error: null };
        }
        return codedRefusal(400, { ok: false, code: "unknown_action" });
      },
    },
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      maybeThrow(`rpc:${fn}`);
      return { data: null, error: options.rpcError ?? null };
    },
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    calls,
    signOutScopes,
    resetCalls,
    updateCalls,
    rpcCalls,
    functionCalls,
    recoverCalls,
    emit: (event: string, payload: unknown) => authListener?.(event, payload),
  };
}

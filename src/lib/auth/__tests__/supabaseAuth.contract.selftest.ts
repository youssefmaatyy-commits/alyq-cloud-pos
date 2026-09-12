/**
 * Supabase identity contract (headless, no DOM).
 *
 * Run with:
 *   npx esbuild src/lib/auth/__tests__/supabaseAuth.contract.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-auth-contract.mjs && node /tmp/alyq-auth-contract.mjs
 *
 * This environment has no Supabase project to talk to, so the live path would
 * otherwise be unverified code — the riskiest kind. These tests drive
 * `SupabaseUserRepository` against a stub client that records every call, and
 * pin the contract the phase depends on:
 *
 *   · credentials go to the provider and nothing else; no password, hash or
 *     reset token is ever returned to the app,
 *   · identity is profile + custom role, and a custom role *replaces* the system
 *     capability list (the same rule `public.can()` applies),
 *   · a deactivated profile ends the provider session instead of inheriting it,
 *   · session expiry is the provider's, while the absolute cap stays ours,
 *   · `signOut({ everywhere })` asks for `scope: "global"`,
 *   · recovery and password changes map provider errors onto our codes, and
 *   · `onAuthStateChange` events become app events with a fully built user.
 */
import assert from "node:assert/strict";
import { SupabaseUserRepository } from "../data/supabaseRepository";
import { usernameToEmail } from "../services/identity";
import { capabilitiesOf } from "@/lib/permissions/roles";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── stub client ──────────────────────────────────────────────────────────────

interface StubOptions {
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
}

function makeStub(options: StubOptions = {}) {
  const calls: string[] = [];
  const signOutScopes: string[] = [];
  const resetCalls: Array<{ email: string; redirectTo?: string }> = [];
  const updateCalls: Array<{ password: string }> = [];
  const rpcCalls: string[] = [];
  let authListener: ((event: string, session: unknown) => void) | null = null;

  const profileRows = options.profiles ?? [
    {
      id: "u-admin",
      username: "admin",
      name: "Store Admin",
      role: "admin",
      active: true,
      email: "admin@alyq.local",
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
      email: "sales@alyq.local",
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
      email: "gone@alyq.local",
      phone: null,
      custom_role_id: null,
      last_login_at: null,
      created_at: "2026-01-03T00:00:00.000Z",
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
        then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
          calls.push(`from.${name}.select`);
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
    },
  });

  const session = options.session === undefined
    ? {
        access_token: "provider-access-token",
        expires_at: Math.floor(Date.parse("2026-09-09T12:00:00.000Z") / 1000),
        user: { id: "u-admin", email: "admin@alyq.local" },
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
              expires_at: Math.floor(Date.parse("2026-09-09T12:00:00.000Z") / 1000),
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
              expires_at: Math.floor(Date.parse("2026-09-09T13:00:00.000Z") / 1000),
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
        return { data: { session }, error: null };
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
    from: (name: string) =>
      name === "profiles" ? table("profiles", profileRows) : table("custom_roles", customRoleRows),
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
    emit: (event: string, payload: unknown) => authListener?.(event, payload),
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

test("a correct password authenticates through the provider, and the identity comes from profiles", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("admin", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.user.id, "u-admin");
  assert.equal(result.user.role, "admin");
  assert.equal(result.user.email, "admin@alyq.local");
  assert.equal(result.user.auth_id, "u-admin");
  // No system role: the full matrix.
  assert.deepEqual(result.user.capabilities, capabilitiesOf("admin"));
  assert.ok(stub.calls.some((call) => call.startsWith("signInWithPassword:")));
});

test("a username is mapped to the provider's email convention", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.equal(usernameToEmail("Sales.Lead"), "sales.lead@alyq.local");

  await repository.authenticate("sales.lead", "CorrectHorse1");
  assert.ok(stub.calls.includes("signInWithPassword:sales.lead@alyq.local"));
});

test("an assigned custom role REPLACES the system capability list", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("sales.lead", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.user.custom_role_id, "cr-sales-manager");
  assert.equal(result.user.custom_role_name, "Sales Manager");
  // `manager` would grant 30 capabilities; the custom role grants 5.
  assert.equal(result.user.capabilities.length, 5);
  assert.ok(result.user.capabilities.includes("edit_sale"));
  assert.ok(!result.user.capabilities.includes("manage_users"));
});

test("a wrong password and an unknown account fail with the same code", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const wrong = await repository.authenticate("admin", "nope");
  assert.deepEqual(wrong, { ok: false, code: "invalid_credentials" });

  const unknown = await repository.authenticate("who@alyq.local", "CorrectHorse1");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "invalid_credentials");
});

test("an empty username or password is refused before the provider is called", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.authenticate("  ", "x"), { ok: false, code: "missing_username" });
  assert.deepEqual(await repository.authenticate("admin", ""), { ok: false, code: "missing_password" });
  assert.equal(stub.calls.some((call) => call.startsWith("signInWithPassword:")), false);
});

test("a deactivated profile ends the provider session instead of inheriting it", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("gone@alyq.local", "CorrectHorse1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "user_inactive");
  assert.ok(stub.signOutScopes.includes("local"), "the just-created session must be revoked");
});

test("a signed-in user with no profile row is refused", async () => {
  const stub = makeStub({ profiles: [] });
  const repository = new SupabaseUserRepository(stub.client);
  const result = await repository.authenticate("admin@alyq.local", "CorrectHorse1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_credentials");
});

test("a network failure during sign-in surfaces as a coded failure, not an exception", async () => {
  const stub = makeStub({ throwOn: ["signInWithPassword"] });
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.authenticate("admin", "CorrectHorse1"), { ok: false, code: "network" });
});

test("the session's expiry is the provider's", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const live = await repository.currentSession();
  assert.ok(live);
  assert.equal(live.token, "provider-access-token");
  assert.equal(live.expires_at, "2026-09-09T12:00:00.000Z");
  assert.equal(live.refreshable, true);
  assert.equal(live.user?.id, "u-admin");
});

test("refreshing returns the provider's new token and expiry", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const live = await repository.refreshSession();
  assert.ok(live);
  assert.equal(live.token, "refreshed-token");
  assert.equal(live.expires_at, "2026-09-09T13:00:00.000Z");
});

test("a provider that refuses to refresh yields no session", async () => {
  const stub = makeStub({ refreshError: { message: "Invalid Refresh Token: Expired" } });
  const repository = new SupabaseUserRepository(stub.client);
  assert.equal(await repository.refreshSession(), null);
});

test("there is no session when the provider has none", async () => {
  const stub = makeStub({ session: null });
  const repository = new SupabaseUserRepository(stub.client);
  assert.equal(await repository.currentSession(), null);
});

test("signing out everywhere asks the provider for a global scope", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  await repository.signOut();
  await repository.signOut({ everywhere: true });
  assert.deepEqual(stub.signOutScopes, ["local", "global"]);
});

test("a reset request hands the address to the provider with a redirect back to this app", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const outcome = await repository.requestPasswordReset("sales.lead", "https://till.example/#/reset-password");
  assert.deepEqual(outcome, { ok: true, channel: "email" });
  assert.deepEqual(stub.resetCalls, [
    { email: "sales.lead@alyq.local", redirectTo: "https://till.example/#/reset-password" },
  ]);
});

test("an unknown address answers exactly like a known one (no enumeration oracle)", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.requestPasswordReset("nobody@alyq.local"), { ok: true, channel: "email" });
  assert.deepEqual(await repository.requestPasswordReset(""), { ok: false, code: "missing_identifier" });
  assert.deepEqual(await repository.requestPasswordReset("not an address!"), { ok: false, code: "invalid_email" });
});

test("throttling is named, and anything else is a network failure", async () => {
  // "Try again in a minute" and "we cannot reach the server" are different
  // instructions, so they are different codes.
  const throttled = makeStub({ resetError: { message: "For security purposes, you can only request this after 60 seconds." } });
  assert.deepEqual(await new SupabaseUserRepository(throttled.client).requestPasswordReset("admin"), {
    ok: false,
    code: "rate_limited",
  });

  const errored = makeStub({ resetError: { message: "unexpected failure" } });
  assert.deepEqual(await new SupabaseUserRepository(errored.client).requestPasswordReset("admin"), {
    ok: false,
    code: "network",
  });

  const thrown = makeStub({ throwOn: ["resetPasswordForEmail"] });
  assert.deepEqual(await new SupabaseUserRepository(thrown.client).requestPasswordReset("admin"), {
    ok: false,
    code: "network",
  });
});

test("a PKCE recovery link is exchanged for a session", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.consumeRecoveryLink({ search: "?code=abc123", hash: "#/reset-password" });
  assert.deepEqual(result, { ok: true });
  assert.ok(stub.calls.includes("exchangeCodeForSession:abc123"));
});

test("an implicit-flow recovery link is turned into a session", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.consumeRecoveryLink({
    search: "",
    hash: "#/reset-password?access_token=tok&refresh_token=ref&type=recovery",
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(stub.calls.includes("setSession:tok"));
});

test("a link the provider rejects is reported as expired, whatever the reason", async () => {
  const rejected = makeStub({ exchangeError: { message: "Invalid code" } });
  assert.deepEqual(
    await new SupabaseUserRepository(rejected.client).consumeRecoveryLink({ search: "?code=old", hash: "" }),
    { ok: false, code: "expired" },
  );

  const thrown = makeStub({ throwOn: ["exchangeCodeForSession"] });
  assert.deepEqual(
    await new SupabaseUserRepository(thrown.client).consumeRecoveryLink({ search: "?code=x", hash: "" }),
    { ok: false, code: "network" },
  );
});

test("a reset page with no recovery material is unauthenticated, not expired", async () => {
  const stub = makeStub({ session: null });
  assert.deepEqual(
    await new SupabaseUserRepository(stub.client).consumeRecoveryLink({ search: "", hash: "#/reset-password" }),
    { ok: false, code: "not_authenticated" },
  );
});

test("a recovery token does not resurrect a deactivated account", async () => {
  const stub = makeStub({ profiles: [] });
  // A valid-looking implicit link, but no profile behind it: the token is not an
  // identity, and an account an admin switched off must not reset its way back in.
  assert.deepEqual(
    await new SupabaseUserRepository(stub.client).consumeRecoveryLink({
      search: "",
      hash: "#access_token=tok&refresh_token=ref&type=recovery",
    }),
    { ok: false, code: "expired" },
  );
});

test("a weak new password is refused locally, without a provider round trip", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.updatePassword("short"), { ok: false, code: "weak_password" });
  assert.equal(stub.updateCalls.length, 0);
});

test("the provider's strength verdict is mapped onto our codes", async () => {
  const weak = makeStub({ updateError: { message: "Password should be at least 6 characters (PWS0001)." } });
  assert.deepEqual(await new SupabaseUserRepository(weak.client).updatePassword("Str0ngPass"), {
    ok: false,
    code: "weak_password",
  });

  const unauthenticated = makeStub({ updateError: { message: "Not authenticated" } });
  assert.deepEqual(await new SupabaseUserRepository(unauthenticated.client).updatePassword("Str0ngPass"), {
    ok: false,
    code: "not_authenticated",
  });

  const ok = makeStub();
  assert.deepEqual(await new SupabaseUserRepository(ok.client).updatePassword("Str0ngPass"), { ok: true });
  assert.deepEqual(ok.updateCalls, [{ password: "Str0ngPass" }]);
});

test("provider auth events become app events carrying a fully built user", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  const seen: string[] = [];
  const users: Array<{ id: string; capabilities: readonly string[] }> = [];

  const unsubscribe = repository.onAuthChange((event) => {
    seen.push(event.type);
    if (event.type !== "signed_out") users.push(event.user);
  });

  stub.emit("SIGNED_IN", { user: { id: "u-admin", email: "admin@alyq.local" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stub.emit("TOKEN_REFRESHED", { user: { id: "u-admin", email: "admin@alyq.local" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stub.emit("SIGNED_OUT", null);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seen, ["signed_in", "token_refreshed", "signed_out"]);
  assert.equal(users.at(-1)?.id, "u-admin");
  assert.ok((users.at(-1)?.capabilities.length ?? 0) > 0, "the event must carry resolved capabilities");

  unsubscribe();
  assert.ok(stub.calls.includes("unsubscribe"));
});

test("an event for an account that became inactive is reported as signed out", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  const seen: string[] = [];
  repository.onAuthChange((event) => seen.push(event.type));

  stub.emit("SIGNED_IN", { user: { id: "u-off", email: "gone@alyq.local" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ["signed_out"]);
});

test("the user list exposes no credential material", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  const users = await repository.listUsers();

  assert.equal(users.length, 3);
  for (const user of users) {
    assert.deepEqual(
      Object.keys(user).sort(),
      ["active", "created_at", "custom_role_id", "email", "id", "last_login_at", "name", "phone", "role", "username"],
    );
    assert.equal(JSON.stringify(user).includes("password"), false);
  }
  assert.equal(users.find((u) => u.id === "u-off")?.active, false);
});

test("stamping last login is best effort and never fails a sign-in", async () => {
  const stub = makeStub({ throwOn: ["rpc:admin_touch_login"] });
  const repository = new SupabaseUserRepository(stub.client);
  await repository.touchLogin("u-admin");
  assert.deepEqual(stub.rpcCalls, ["admin_touch_login"]);
});

// ── runner ───────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${(error as Error).message}`);
    }
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${tests.length} Supabase identity contract tests FAILED.`);
    process.exit(1);
  }
  console.log(`${tests.length}/${tests.length} Supabase identity contract tests passed.`);
})();

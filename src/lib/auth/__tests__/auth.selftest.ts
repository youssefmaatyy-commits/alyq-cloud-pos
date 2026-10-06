/**
 * Authentication self-test (headless, no DOM).
 *
 * Run with:
 *   npx esbuild src/lib/auth/__tests__/auth.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-auth.mjs && node /tmp/alyq-auth.mjs
 *
 * Covers the parts that must not regress silently:
 *   - credential verification (correct, wrong, unknown user, both digests)
 *   - session creation, idle/remember lifetimes and the absolute cap
 *   - persistence round-trip, storage selection and clearing
 *   - the fail-closed signed-out identity
 *   - the route capability table that drives the guard and the sidebar
 *
 * The interactive half of authentication (the login screen, redirects, logout,
 * expiry in a live app) is covered by the DOM suites:
 *   scripts/auth.flow.mjs (9 steps) and scripts/smoke.dom.mjs.
 */
import assert from "node:assert/strict";
import { DEMO_PASSWORD, DEMO_USERS } from "../demoUsers";
import { fallbackDigest, hashStrategy, sha256Digest, verifyPassword } from "../services/password";
import {
  ANONYMOUS_USER,
  SESSION_STORAGE_KEY,
  clearStoredSession,
  getCurrentAuthUser,
  getCachedSession,
  primeCacheFromStorage,
  readStoredSession,
  resetSessionCache,
  writeStoredSession,
} from "../services/sessionStore";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_REMEMBER_IDLE_MS,
  changePassword,
  createSession,
  idleTtlFor,
  isSessionExpired,
  restoreSession,
  shouldAdoptFoundProviderSession,
  signIn,
  touchSession,
} from "../services/authService";
import { getDemoUserRepository } from "../data/demoRepository";
import { findStaffByUsername, upsertStaffEntry } from "../data/staffDirectory";
import { carriesRecoveryMaterial } from "../services/recoveryUrl";
import { resetRecoveryMarksForTests } from "../services/recoveryOnce";
import { getAuditRepository } from "@/modules/audit/data";
import { APP_ROLES, hasCapability, normalizeRole } from "@/lib/permissions/roles";
import { capabilityForPath } from "@/lib/permissions/routes";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

/** Minimal in-memory Storage so the store can be exercised outside a browser. */
function installStorageStub(): { local: Map<string, string>; session: Map<string, string> } {
  const make = (map: Map<string, string>) => ({
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const localStorageStub = make(local);
  const sessionStorageStub = make(session);
  Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: sessionStorageStub, configurable: true });
  // Modules under `modules/` reach storage through `window.localStorage`
  // (their "never throw" wrapper) — without this, their writes are swallowed
  // in Node and a password change would be verified against nothing.
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: localStorageStub,
      sessionStorage: sessionStorageStub,
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
    writable: true,
  });
  return { local, session };
}

/** Every test runs against fresh storage and an empty in-memory session cache. */
function resetStores() {
  installStorageStub();
  resetSessionCache();
}

console.log("\nAuthentication · credential, session and route-guard model");

// ── credentials ───────────────────────────────────────────────────────────
test("the demo directory holds exactly one account per app role", () => {
  const roles = DEMO_USERS.map((u) => u.role).sort();
  assert.deepEqual(roles, [...APP_ROLES].sort(), "one demo account per role");
  assert.equal(new Set(DEMO_USERS.map((u) => u.username)).size, DEMO_USERS.length, "usernames unique");
  for (const user of DEMO_USERS) {
    assert.ok(user.name.trim(), `${user.username} has a display name`);
    assert.equal(normalizeRole(user.role), user.role, `${user.role} is a valid app role`);
  }
});

test("a correct password authenticates through the repository", async () => {
  resetStores();
  for (const user of DEMO_USERS) {
    const result = await getDemoUserRepository().authenticate(user.username, DEMO_PASSWORD);
    assert.equal(result.ok, true, `${user.username} authenticates`);
    assert.equal(result.ok && result.user.role, user.role);
    assert.equal(result.ok && result.user.name, user.name);
  }
});

test("a wrong password and an unknown user fail with the same code", async () => {
  resetStores();
  const repository = getDemoUserRepository();
  const wrong = await repository.authenticate("admin", "not-the-password");
  const missing = await repository.authenticate("nobody", DEMO_PASSWORD);
  const empty = await repository.authenticate("admin", "");
  assert.equal(wrong.ok, false);
  assert.equal(missing.ok, false);
  assert.equal(empty.ok, false);
  const codes = [wrong, missing, empty].map((r) => (r.ok ? "ok" : r.code));
  assert.equal(new Set(codes).size, 1, "every failure reports one generic code (no enumeration)");
  assert.equal(codes[0], "invalid_credentials");
});

test("usernames are matched case-insensitively and trimmed", async () => {
  resetStores();
  const result = await getDemoUserRepository().authenticate("  ADMIN ", DEMO_PASSWORD);
  assert.equal(result.ok, true, "case/space-insensitive login");
});

test("verification picks the digest the runtime can compute", async () => {
  const strategy = hashStrategy();
  assert.ok(["sha256", "fallback"].includes(strategy), `unexpected strategy: ${strategy}`);
  const record = {
    salt: "s1",
    sha256: await sha256Digest(DEMO_PASSWORD, "s1"),
    fallback: fallbackDigest(DEMO_PASSWORD, "s1"),
  };
  assert.equal(await verifyPassword(DEMO_PASSWORD, record), true, "correct password verifies");
  assert.equal(await verifyPassword("alyq1235", record), false, "a near miss is rejected");
  assert.equal(await verifyPassword("", record), false, "an empty password is rejected");
  assert.equal(await verifyPassword(DEMO_PASSWORD.toLowerCase() + " ", record), false, "no implicit trimming");
});

test("both stored digests describe the same password for every account", async () => {
  // The two digests exist because a non-secure origin has no Web Crypto. Both
  // must describe the same password, whichever one the runtime ends up using.
  for (const user of DEMO_USERS) {
    const { verifier } = user;
    assert.equal(await verifyPassword(DEMO_PASSWORD, verifier), true, `${user.username} verifies`);
    assert.equal(
      await sha256Digest(DEMO_PASSWORD, verifier.salt),
      verifier.sha256,
      `${user.username} sha256 digest is correct`,
    );
    assert.equal(
      fallbackDigest(DEMO_PASSWORD, verifier.salt),
      verifier.fallback,
      `${user.username} fallback digest is correct`,
    );
    assert.notEqual(verifier.sha256, verifier.fallback, "the two digests are independent, not copies");
    assert.equal(
      await verifyPassword(DEMO_PASSWORD + "x", verifier),
      false,
      `${user.username} rejects a wrong password`,
    );
  }
});

// ── session lifetime ──────────────────────────────────────────────────────
test("legacy remember true and false create the same persistent lifetime", () => {
  resetStores();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const unchecked = createSession(DEMO_USERS[0] as never, false, now);
  const checked = createSession(DEMO_USERS[0] as never, true, now);
  assert.equal(idleTtlFor(false), SESSION_IDLE_MS);
  assert.equal(idleTtlFor(true), SESSION_REMEMBER_IDLE_MS);
  assert.equal(SESSION_IDLE_MS, SESSION_REMEMBER_IDLE_MS);
  assert.equal(new Date(unchecked.expires_at).getTime() - now.getTime(), SESSION_IDLE_MS);
  assert.equal(checked.expires_at, unchecked.expires_at, "checkbox value cannot change lifetime");
  assert.equal(unchecked.remember, true, "legacy unchecked input is normalized to persistent");
  assert.equal(checked.remember, true, "legacy checked input is persistent too");
  assert.ok(unchecked.token.startsWith("sess-") && unchecked.token.length > 10, "opaque token issued");
});

test("expiry is decided by idle time and by the absolute cap", () => {
  resetStores();
  const issued = new Date("2026-01-01T00:00:00.000Z");
  const session = createSession(DEMO_USERS[0] as never, true, issued);
  assert.equal(isSessionExpired(session, new Date(issued.getTime() + 1000)), false, "fresh session is valid");
  assert.equal(
    isSessionExpired(session, new Date(issued.getTime() + SESSION_REMEMBER_IDLE_MS + 1)),
    true,
    "idle timeout expires the session",
  );
  // A session touched constantly still dies at the hard cap.
  const ancient = { ...session, issued_at: new Date(Date.now() - SESSION_ABSOLUTE_MS - 1000).toISOString() };
  assert.equal(isSessionExpired(ancient, new Date()), true, "absolute cap ends the session");
  assert.equal(isSessionExpired({ ...session, expires_at: "not-a-date" } as never), true, "garbage fails closed");
});

test("touching a live session extends it, never beyond the cap", () => {
  resetStores();
  const issued = new Date("2026-01-01T00:00:00.000Z");
  const session = createSession(DEMO_USERS[0] as never, false, issued);
  const touched = touchSession(session, new Date(issued.getTime() + 60_000));
  assert.ok(touched.expires_at > session.expires_at, "activity slides the expiry forward");
  assert.ok(
    new Date(touched.expires_at).getTime() <= issued.getTime() + SESSION_ABSOLUTE_MS,
    "the sliding expiry never passes the absolute cap",
  );
  const idle = touchSession(session, new Date(issued.getTime() - 5000));
  assert.equal(idle, session, "no needless rewrite when nothing changed");
});

// ── persistence ───────────────────────────────────────────────────────────
test("the session round-trips through storage and clears completely", () => {
  const { local, session: sessionMap } = installStorageStub();
  resetSessionCache();
  const record = createSession(DEMO_USERS[0] as never, false, new Date());
  writeStoredSession(record, "session");
  assert.equal(local.has(SESSION_STORAGE_KEY), false, "tab-scoped session is not in localStorage");
  assert.equal(sessionMap.has(SESSION_STORAGE_KEY), true, "tab-scoped session is in sessionStorage");
  assert.deepEqual(readStoredSession(), { session: record, persistence: "session" });
  assert.equal(getCurrentAuthUser().username, DEMO_USERS[0].username, "cache follows the write");

  writeStoredSession(record, "local");
  assert.equal(local.has(SESSION_STORAGE_KEY), true, "remembered session is in localStorage");
  assert.equal(sessionMap.has(SESSION_STORAGE_KEY), false, "and never in both stores");

  clearStoredSession();
  assert.equal(readStoredSession(), null);
  assert.equal(local.size + sessionMap.size, 0, "clearing removes every copy");
  assert.equal(getCurrentAuthUser(), ANONYMOUS_USER, "the cache falls back to anonymous");
});

test("unchecked and checked login both survive reload and device restart", async () => {
  for (const remember of [false, true]) {
    const { local, session: sessionMap } = installStorageStub();
    resetSessionCache();
    const outcome = await signIn({ username: "admin", password: DEMO_PASSWORD, remember });
    assert.ok(outcome.ok && outcome.session, `login works with legacy remember=${remember}`);
    assert.equal(local.has(SESSION_STORAGE_KEY), true, "session is always in persistent storage");
    assert.equal(sessionMap.has(SESSION_STORAGE_KEY), false, "session is never tab-only");
    assert.equal(readStoredSession()?.persistence, "local");
    assert.equal(readStoredSession()?.session.remember, true);

    // Reload drops only module memory; restart additionally loses sessionStorage.
    resetSessionCache();
    assert.ok(restoreSession().session, "browser reload restores the session");
    sessionMap.clear();
    resetSessionCache();
    assert.ok(restoreSession().session, "Web/Desktop/Mobile restart restores it from persistent storage");
  }
});

test("a legacy tab-only record is migrated to persistent storage on restore", () => {
  const { local, session: sessionMap } = installStorageStub();
  resetSessionCache();
  const record = {
    ...createSession(DEMO_USERS[0] as never, false, new Date()),
    token: "legacy-provider-access-token",
  };
  writeStoredSession(record, "session");
  resetSessionCache();
  const restored = restoreSession();
  assert.ok(restored.session);
  assert.ok(restored.session.token.startsWith("sess-"), "legacy provider token is replaced by an opaque app id");
  assert.equal(local.has(SESSION_STORAGE_KEY), true);
  assert.equal(sessionMap.has(SESSION_STORAGE_KEY), false);
  assert.equal(readStoredSession()?.persistence, "local");
});

test("corrupt or incomplete session records are ignored", () => {
  const { local } = installStorageStub();
  resetSessionCache();
  for (const bad of ["{not json", JSON.stringify({ session: {} }), JSON.stringify({ session: { token: "t" } })]) {
    local.set(SESSION_STORAGE_KEY, bad);
    assert.equal(readStoredSession(), null, `rejected: ${bad.slice(0, 24)}`);
  }
  resetSessionCache();
  assert.equal(primeCacheFromStorage(), null);
  assert.equal(getCurrentAuthUser(), ANONYMOUS_USER);
  assert.equal(getCachedSession(), null, "no phantom session is cached");
});

test("restoreSession rejects an expired record and reports why", () => {
  installStorageStub();
  resetSessionCache();
  const record = createSession(DEMO_USERS[0] as never, false, new Date("2026-01-01T00:00:00.000Z"));
  writeStoredSession(record, "session");
  resetSessionCache();
  const restored = restoreSession(new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(restored.session, null, "an expired session is not restored");
  assert.equal(restored.reason, "expired", "and the reason is reported to the login screen");
  assert.equal(readStoredSession(), null, "the dead record is evicted");

  resetSessionCache();
  const live = restoreSession(new Date());
  assert.equal(live.session, null, "nothing left to restore");
  assert.equal(live.reason, null, "a plain signed-out boot carries no reason");
});

// ── fail-closed identity ──────────────────────────────────────────────────
test("signed out, the acting user denies every capability", () => {
  resetStores();
  assert.equal(getCurrentAuthUser(), ANONYMOUS_USER);
  assert.equal(ANONYMOUS_USER.role, "", "anonymous has no role at all");
  assert.equal(ANONYMOUS_USER.id, "", "and no id to attribute audit rows to");
  assert.equal(normalizeRole(ANONYMOUS_USER.role), null, "an empty role is not a model role");
  for (const capability of ["sell", "view_inventory", "view_shifts", "view_audit_log"] as const) {
    assert.equal(hasCapability(ANONYMOUS_USER.role, capability), false, `${capability} denied when signed out`);
  }
});

// ── route table (the guard and the sidebar share it) ──────────────────────
test("each screen maps to the capability it needs", () => {
  assert.equal(capabilityForPath("/inventory"), "view_inventory");
  assert.equal(capabilityForPath("/pos"), "sell");
  assert.equal(capabilityForPath("/returns"), "process_return");
  assert.equal(capabilityForPath("/refunds"), "process_refund");
  assert.equal(capabilityForPath("/shifts"), "view_shifts");
  assert.equal(capabilityForPath("/expenses"), "view_shifts");
  assert.equal(capabilityForPath("/audit"), "view_audit_log");
  // Phase 17: the customer book left the "anybody signed in" group. It is the one
  // screen holding records about named people — phone numbers, addresses, what
  // they bought — so it now has a capability of its own. Every shipped role holds
  // it; a custom role may decline it, and the till's picker declines with it.
  assert.equal(capabilityForPath("/customers"), "view_customers");
  assert.equal(capabilityForPath("/customers/C-1"), "view_customers", "a customer's page inherits the book");
  // Formerly implicit read-only screens are now assignable to custom roles.
  assert.equal(capabilityForPath("/"), "view_dashboard");
  assert.equal(capabilityForPath("/products"), "view_products");
  assert.equal(capabilityForPath("/categories"), "view_products");
  assert.equal(capabilityForPath("/pos/sales"), "view_sales");
});

test("the longest matching prefix wins, including detail routes", () => {
  assert.equal(capabilityForPath("/pos/sales"), "view_sales", "/pos/sales uses the dedicated history read");
  assert.equal(capabilityForPath("/inventory/movements"), "view_inventory");
  assert.equal(capabilityForPath("/shifts/history"), "view_shifts");
  assert.equal(capabilityForPath("/returns/RET-000001"), "process_return", "detail routes inherit the list");
  assert.equal(capabilityForPath("/refunds/r-1"), "process_refund");
  assert.equal(capabilityForPath("/inventory/"), "view_inventory", "trailing slash is tolerated");
  assert.equal(capabilityForPath("/unknown"), null, "unknown paths need only a session (catch-all redirect)");
});

test("route capabilities line up with the roles that may use them", () => {
  const expectations: Array<[string, string[]]> = [
    ["/pos", ["admin", "manager", "cashier", "inventory_clerk"]],
    ["/returns", ["admin", "manager", "cashier", "inventory_clerk"]],
    ["/audit", ["admin", "manager"]],
    ["/inventory", ["admin", "manager", "cashier", "inventory_clerk", "viewer"]],
  ];
  for (const [path, allowed] of expectations) {
    const required = capabilityForPath(path);
    assert.ok(required, `${path} is a guarded screen`);
    const actual = APP_ROLES.filter((role) => hasCapability(role, required));
    assert.deepEqual(actual, allowed, `${path} allows exactly: ${allowed.join(", ")}`);
  }
});

// ── cashier definitions the POS screen depends on ─────────────────────────
test("the cashier role can sell and take returns, but not oversee", () => {
  assert.equal(hasCapability("cashier", "sell"), true, "cashier sells (the POS gate now agrees)");
  assert.equal(hasCapability("cashier", "confirm_payment"), true);
  assert.equal(hasCapability("cashier", "process_return"), true);
  assert.equal(hasCapability("cashier", "process_refund"), true);
  assert.equal(hasCapability("cashier", "apply_discount"), false);
  assert.equal(hasCapability("cashier", "void_sale"), false);
  assert.equal(hasCapability("cashier", "adjust_stock"), false);
  assert.equal(hasCapability("cashier", "view_audit_log"), false);
});

// ── recovery & password-change security boundaries ─────────────────────────
test("a reset page without recovery material refuses — signed in or not", async () => {
  resetStores();
  resetRecoveryMarksForTests();
  const repository = getDemoUserRepository();

  // A clean stranger is denied.
  assert.deepEqual(await repository.consumeRecoveryLink({ search: "", hash: "#/reset-password" }), {
    ok: false,
    code: "not_authenticated",
  });

  // And so is somebody holding a valid, PERSISTED session — one that has even
  // been refreshed: a session is not recovery authority and can never unlock a
  // "choose new password" form that re-proves nothing. (Regression pin for the
  // session fallback removed from consumeRecoveryLink.)
  const signedIn = await signIn({ username: "admin", password: DEMO_PASSWORD, remember: false });
  assert.equal(signedIn.ok, true, "an ordinary login works");
  assert.deepEqual(await repository.consumeRecoveryLink({ search: "", hash: "#/reset-password" }), {
    ok: false,
    code: "not_authenticated",
  });
  assert.equal(
    isSessionExpired(readStoredSession()!.session, new Date()),
    false,
    "the ordinary session itself is untouched by the probe",
  );

  // Link-shaped material offline is simply expired: demo has no mail server,
  // so nothing it says can be genuine.
  assert.deepEqual(await repository.consumeRecoveryLink({ search: "?code=anything", hash: "" }), {
    ok: false,
    code: "expired",
  });
});

test("an account's normal password change re-proves the current password, end to end", async () => {
  resetStores();
  const repository = getDemoUserRepository();
  const NEW_PASSWORD = "BrandNew1Password";

  // Not signed in: there is nobody to re-prove.
  assert.deepEqual(await repository.changePassword(DEMO_PASSWORD, NEW_PASSWORD), {
    ok: false,
    code: "not_authenticated",
  });

  const entry = await signIn({ username: "admin", password: DEMO_PASSWORD, remember: false });
  assert.ok(entry.ok && entry.session, "an ordinary login works");

  // A weak proposal is refused locally.
  assert.deepEqual(await repository.changePassword(DEMO_PASSWORD, "short"), {
    ok: false,
    code: "weak_password",
  });

  // A wrong current password: refused, nothing changed at the login door.
  assert.deepEqual(await repository.changePassword("not-the-password", NEW_PASSWORD), {
    ok: false,
    code: "invalid_credentials",
  });
  assert.equal((await repository.authenticate("admin", DEMO_PASSWORD)).ok, true, "the old password still works");
  assert.equal(
    (await repository.authenticate("admin", NEW_PASSWORD)).ok,
    false,
    "and a refused change never set the new one",
  );

  // The right one — on a USERNAME account, which is what the demo handles are:
  // it works, the old credential dies, the new one signs in.
  assert.deepEqual(await changePassword(DEMO_PASSWORD, NEW_PASSWORD), { ok: true });
  assert.equal((await repository.authenticate("admin", DEMO_PASSWORD)).ok, false, "the old password died");
  assert.equal((await repository.authenticate("admin", NEW_PASSWORD)).ok, true, "the new one signs in");

  // And the change was audited, marked as re-authenticated rather than
  // recovery-authorised. `recordAudit` returns the stored row even when a
  // caller ignores it; give the fire-and-forget write a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entries = await getAuditRepository().listEntries();
  const changed = entries.filter((e) => e.action === "user.password_changed");
  assert.ok(changed.length >= 1, "the change produced an audit entry");
  assert.equal(changed.at(-1)?.details?.via, "current_password");
  assert.equal(changed.at(-1)?.entity_id, entry.ok && entry.session ? entry.session.user.id : "");
});

test("a deactivated account cannot change its password from a moment-old session", async () => {
  resetStores();
  const repository = getDemoUserRepository();
  const entry = await signIn({ username: "cashier", password: DEMO_PASSWORD, remember: false });
  assert.equal(entry.ok, true);
  const staff = findStaffByUsername("cashier");
  assert.ok(staff, "the cashier demo account exists");
  upsertStaffEntry({ ...staff, active: false });

  assert.deepEqual(await repository.changePassword(DEMO_PASSWORD, "BrandNew1Password"), {
    ok: false,
    code: "not_authenticated",
  });
});

test("a persisted provider session is adopted unless recovery URL authority must be consumed", () => {
  // Normal boot adopts Supabase's provider-owned persisted session even when an
  // old app identity record is absent. Recovery material remains isolated.
  assert.equal(shouldAdoptFoundProviderSession(false), true);
  assert.equal(shouldAdoptFoundProviderSession(true), false);

  // The companion rule: boot must not touch a URL a recovery page consumes.
  assert.equal(carriesRecoveryMaterial({ search: "?code=xyz", hash: "" }), true);
  assert.equal(carriesRecoveryMaterial({ search: "", hash: "#access_token=t&refresh_token=r&type=recovery" }), true);
  assert.equal(carriesRecoveryMaterial({ search: "", hash: "#/pos" }), false);
  assert.equal(carriesRecoveryMaterial({ search: "", hash: "" }), false);
});

// ── runner ────────────────────────────────────────────────────────────────
let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed}/${tests.length} authentication tests passed.\n`);

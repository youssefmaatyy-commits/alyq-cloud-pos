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
 *   · a bare username is resolved by the `alyq-auth` edge function — the
 *     browser neither sends nor receives the real Auth email — while an email
 *     address still goes to the provider directly, and both roads end in the
 *     same profile-checked identity,
 *   · identity is profile + custom role, and a custom role *replaces* the system
 *     capability list (the same rule `public.can()` applies),
 *   · a deactivated profile ends the provider session instead of inheriting it,
 *   · session expiry is the provider's, while the absolute cap stays ours,
 *   · `signOut({ everywhere })` asks for `scope: "global"`,
 *   · recovery and password changes map provider errors onto our codes, and
 *   · `onAuthStateChange` events become app events with a fully built user.
 */
import assert from "node:assert/strict";
import { isConfirmedAuthInvalidation, SupabaseUserRepository } from "../data/supabaseRepository";
import { usernameToEmail } from "../services/identity";
import { capabilitiesOf } from "@/lib/permissions/roles";
import { makeStub } from "./support/supabaseStub";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── tests ────────────────────────────────────────────────────────────────────

test("a username and a correct password authenticate through the provider, and the identity comes from profiles", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("admin", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.user.id, "u-admin");
  assert.equal(result.user.role, "admin");
  assert.equal(result.user.email, "admin@alyq.example");
  assert.equal(result.user.auth_id, "u-admin");
  // No system role: the full matrix — unchanged by the server-side resolution.
  assert.deepEqual(result.user.capabilities, capabilitiesOf("admin"));
  // The username path goes through the edge function and adopts its session;
  // the browser never calls the provider's password grant with a guessed email.
  assert.ok(stub.calls.includes("functions:alyq-auth:login"));
  assert.ok(stub.calls.includes("setSession:function-token-u-admin"));
  assert.equal(stub.calls.some((call) => call.startsWith("signInWithPassword:")), false);
});

test("a bare username is resolved server-side: the browser neither sends nor learns the real email", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("sales.lead", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.user.id, "u-sales");

  const loginCall = stub.functionCalls.find((call) => call.body.action === "login");
  assert.ok(loginCall, "the resolver was called");
  // The request carries the username exactly as typed — no email was resolved
  // in the browser first.
  assert.deepEqual(loginCall.body.payload, { identifier: "sales.lead", password: "CorrectHorse1" });
  // And the success the repository builds carries no credential material.
  assert.equal(JSON.stringify(result).includes("CorrectHorse1"), false);
  assert.equal(JSON.stringify(result).includes("refresh_token"), false);

  // The synthetic convention still exists for ONE purpose: creating an account
  // with no email of its own (settings → Users fallback). It is not a login rule.
  assert.equal(usernameToEmail("Sales.Lead"), "sales.lead@alyq.local");
});

test("an email address still signs in directly through the provider, unchanged", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("admin@alyq.example", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.user.id, "u-admin");
  assert.ok(stub.calls.includes("signInWithPassword:admin@alyq.example"));
  assert.equal(stub.calls.some((call) => call.startsWith("functions:")), false);
});

test("a viewer signing in by username keeps exactly the viewer's permissions", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("vera", "CorrectHorse1");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.user.role, "viewer");
  assert.deepEqual(result.user.capabilities, capabilitiesOf("viewer"));
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

  // Unknown on both roads — a username nobody owns and an address nobody owns —
  // and the wrong-password refusal above: one code, one message, no oracle.
  const unknownUsername = await repository.authenticate("nosuch", "CorrectHorse1");
  assert.deepEqual(unknownUsername, { ok: false, code: "invalid_credentials" });

  const unknown = await repository.authenticate("who@alyq.example", "CorrectHorse1");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "invalid_credentials");
});

test("an empty username or password is refused before the provider is called", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.authenticate("  ", "x"), { ok: false, code: "missing_username" });
  assert.deepEqual(await repository.authenticate("admin", ""), { ok: false, code: "missing_password" });
  assert.equal(stub.calls.some((call) => call.startsWith("signInWithPassword:")), false);
  assert.equal(stub.functionCalls.length, 0, "and before the resolver function is called");
});

test("a deactivated profile ends the provider session instead of inheriting it", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("gone@alyq.example", "CorrectHorse1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "user_inactive");
  assert.ok(stub.signOutScopes.includes("local"), "the just-created session must be revoked");
});

test("a deactivated account is refused by username too — the function enforces the gate itself", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("gone", "CorrectHorse1");
  assert.deepEqual(result, { ok: false, code: "user_inactive" });
  // The function refused BEFORE issuing tokens, so there was nothing to adopt.
  assert.equal(stub.calls.some((call) => call.startsWith("setSession:")), false);
});

test("even a function that skips the active gate cannot sign a deactivated account in", async () => {
  // Defense in depth: the repository re-checks `profiles.active` after adopting
  // ANY session, so a buggy or bypassed server-side gate still ends here — with
  // the just-adopted session revoked locally.
  const stub = makeStub({ functionIgnoresActive: true });
  const repository = new SupabaseUserRepository(stub.client);

  const result = await repository.authenticate("gone", "CorrectHorse1");
  assert.deepEqual(result, { ok: false, code: "user_inactive" });
  assert.ok(stub.calls.includes("setSession:function-token-u-off"), "the tokens were adopted first");
  assert.ok(stub.signOutScopes.includes("local"), "and revoked the moment the profile said inactive");
});

test("a signed-in user with no profile row is refused", async () => {
  const stub = makeStub({ profiles: [] });
  const repository = new SupabaseUserRepository(stub.client);
  const result = await repository.authenticate("admin@alyq.example", "CorrectHorse1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_credentials");
});

test("a network failure during sign-in surfaces as a coded failure, not an exception", async () => {
  const thrown = makeStub({ throwOn: ["signInWithPassword"] });
  assert.deepEqual(await new SupabaseUserRepository(thrown.client).authenticate("admin@alyq.example", "CorrectHorse1"), {
    ok: false,
    code: "network",
  });

  // The username road: a relay failure (function undeployed, network down) is a
  // network problem — never a credential verdict.
  const functionDown = makeStub({ functionThrows: true });
  assert.deepEqual(await new SupabaseUserRepository(functionDown.client).authenticate("admin", "CorrectHorse1"), {
    ok: false,
    code: "network",
  });
});

test("the server-side rate limit is named, and it is not a credential verdict", async () => {
  const throttled = makeStub({ functionError: { status: 429, body: { ok: false, code: "rate_limited" } } });
  assert.deepEqual(await new SupabaseUserRepository(throttled.client).authenticate("admin", "CorrectHorse1"), {
    ok: false,
    code: "rate_limited",
  });

  // The function's generic refusal is passed through with the same code the
  // direct path has always used.
  const refused = makeStub({ functionError: { status: 400, body: { ok: false, code: "invalid_credentials" } } });
  assert.deepEqual(await new SupabaseUserRepository(refused.client).authenticate("admin", "CorrectHorse1"), {
    ok: false,
    code: "invalid_credentials",
  });

  // An unexpected body shape degrades to a network failure, not a verdict.
  const garbage = makeStub({ functionError: { status: 500, body: { weird: true } } });
  assert.deepEqual(await new SupabaseUserRepository(garbage.client).authenticate("admin", "CorrectHorse1"), {
    ok: false,
    code: "network",
  });
});

test("the session's expiry is the provider's", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const before = Date.now();
  const live = await repository.currentSession();
  assert.ok(live);
  assert.equal(live.token, "provider-access-token");
  // The stub issues a token good for 1 hour from the moment it is asked,
  // the same way a real provider's `expires_at` is relative to issuance —
  // not a fixed calendar instant a long-running suite would outlive.
  const expiresInMs = new Date(live.expires_at).getTime() - before;
  assert.ok(expiresInMs > 3_500_000 && expiresInMs <= 3_600_000, `expected ~1h expiry, got ${expiresInMs}ms`);
  assert.equal(live.refreshable, true);
  assert.equal(live.user?.id, "u-admin");
});

test("refreshing returns the provider's new token and expiry", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const before = Date.now();
  const live = await repository.refreshSession();
  assert.ok(live);
  assert.equal(live.token, "refreshed-token");
  // The stub's refresh issues a token good for 2 hours from the moment it
  // is asked, for the same reason the initial session's is 1 hour above.
  const expiresInMs = new Date(live.expires_at).getTime() - before;
  assert.ok(expiresInMs > 7_100_000 && expiresInMs <= 7_200_000, `expected ~2h expiry, got ${expiresInMs}ms`);
});

test("a provider that confirms refresh-token invalidation yields no session", async () => {
  const stub = makeStub({ refreshError: { message: "Invalid Refresh Token: Expired", code: "refresh_token_not_found", status: 400 } });
  const repository = new SupabaseUserRepository(stub.client);
  assert.equal(await repository.refreshSession(), null);
});

test("temporary refresh/getSession failures throw instead of impersonating logout", async () => {
  const refreshDown = makeStub({ refreshError: { message: "Failed to fetch", status: 503 } });
  await assert.rejects(
    () => new SupabaseUserRepository(refreshDown.client).refreshSession(),
    (error: unknown) => (error as { message?: string }).message === "Failed to fetch",
  );

  const restoreDown = makeStub({ sessionError: { message: "Gateway timeout", status: 504 } });
  await assert.rejects(
    () => new SupabaseUserRepository(restoreDown.client).currentSession(),
    (error: unknown) => (error as { message?: string }).message === "Gateway timeout",
  );
  assert.equal(isConfirmedAuthInvalidation({ message: "Failed to fetch", status: 503 }), false);
  assert.equal(isConfirmedAuthInvalidation({ code: "invalid_grant", message: "refresh rejected", status: 400 }), true);
});

test("a confirmed revoked provider session returns null for controlled login", async () => {
  const revoked = makeStub({
    sessionError: { message: "Refresh token has been revoked", code: "refresh_token_not_found", status: 400 },
  });
  assert.equal(await new SupabaseUserRepository(revoked.client).currentSession(), null);
});

test("there is no session when the provider has none", async () => {
  const stub = makeStub({ session: null });
  const repository = new SupabaseUserRepository(stub.client);
  assert.equal(await repository.currentSession(), null);
});

test("signing out everywhere deactivates native installations before provider-global revocation", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  await repository.signOut();
  await repository.signOut({ everywhere: true });
  assert.deepEqual(stub.signOutScopes, ["local", "global"]);
  assert.deepEqual(stub.rpcCalls, ["mobile_installations_deactivate_all"]);
  assert.ok(
    stub.calls.indexOf("rpc:mobile_installations_deactivate_all") < stub.calls.indexOf("signOut:global"),
    "provider token custody must be cleared while the caller access token is still valid",
  );
});

test("installation deactivation failure cannot block an intentional global logout", async () => {
  const stub = makeStub({ rpcError: { message: "push subsystem unavailable" } });
  const repository = new SupabaseUserRepository(stub.client);
  await repository.signOut({ everywhere: true });
  assert.deepEqual(stub.signOutScopes, ["global"]);
});

test("a username recovery goes through the resolver; the browser never hands over an email", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const outcome = await repository.requestPasswordReset("sales.lead", "https://till.example/#/reset-password");
  assert.deepEqual(outcome, { ok: true, channel: "email" });
  // The function was asked with the username as typed, and the provider's
  // public recovery endpoint was NOT called from the browser with a synthetic
  // address — the real email stays server-side.
  assert.deepEqual(stub.recoverCalls, [
    { identifier: "sales.lead", redirectTo: "https://till.example/#/reset-password" },
  ]);
  assert.deepEqual(stub.resetCalls, []);
});

test("an email recovery still goes straight to the provider, unchanged", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const outcome = await repository.requestPasswordReset("sales@alyq.example", "https://till.example/#/reset-password");
  assert.deepEqual(outcome, { ok: true, channel: "email" });
  assert.deepEqual(stub.resetCalls, [
    { email: "sales@alyq.example", redirectTo: "https://till.example/#/reset-password" },
  ]);
  assert.deepEqual(stub.recoverCalls, []);
});

test("an unknown address answers exactly like a known one (no enumeration oracle)", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  assert.deepEqual(await repository.requestPasswordReset("nobody@alyq.example"), { ok: true, channel: "email" });
  assert.deepEqual(await repository.requestPasswordReset(""), { ok: false, code: "missing_identifier" });
  assert.deepEqual(await repository.requestPasswordReset("not an address!"), { ok: false, code: "invalid_email" });
});

test("an unknown username answers exactly like a known one (no enumeration oracle)", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);
  const known = await repository.requestPasswordReset("sales.lead");
  const unknown = await repository.requestPasswordReset("nosuch");
  assert.deepEqual(known, { ok: true, channel: "email" });
  assert.deepEqual(unknown, known, "the public response must not distinguish the two");
  assert.deepEqual(
    stub.recoverCalls.map((call) => call.identifier),
    ["sales.lead", "nosuch"],
    "both were handed to the resolver, which answers generically for both",
  );
});

test("throttling is named, and anything else is a network failure", async () => {
  // "Try again in a minute" and "we cannot reach the server" are different
  // instructions, so they are different codes.
  const throttled = makeStub({ resetError: { message: "For security purposes, you can only request this after 60 seconds." } });
  assert.deepEqual(await new SupabaseUserRepository(throttled.client).requestPasswordReset("admin@alyq.example"), {
    ok: false,
    code: "rate_limited",
  });

  const errored = makeStub({ resetError: { message: "unexpected failure" } });
  assert.deepEqual(await new SupabaseUserRepository(errored.client).requestPasswordReset("admin@alyq.example"), {
    ok: false,
    code: "network",
  });

  const thrown = makeStub({ throwOn: ["resetPasswordForEmail"] });
  assert.deepEqual(await new SupabaseUserRepository(thrown.client).requestPasswordReset("admin@alyq.example"), {
    ok: false,
    code: "network",
  });

  // The username road carries the same two instructions from the function.
  const functionThrottled = makeStub({ functionError: { status: 429, body: { ok: false, code: "rate_limited" } } });
  assert.deepEqual(await new SupabaseUserRepository(functionThrottled.client).requestPasswordReset("admin"), {
    ok: false,
    code: "rate_limited",
  });

  const functionDown = makeStub({ functionThrows: true });
  assert.deepEqual(await new SupabaseUserRepository(functionDown.client).requestPasswordReset("admin"), {
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

test("a reset page with no recovery material is unauthenticated — even while signed in", async () => {
  // A clean stranger …
  const stranger = makeStub({ session: null });
  assert.deepEqual(
    await new SupabaseUserRepository(stranger.client).consumeRecoveryLink({ search: "", hash: "#/reset-password" }),
    { ok: false, code: "not_authenticated" },
  );

  // … and somebody holding a perfectly valid NORMAL session get the same
  // answer. A session is not recovery authority — it cannot unlock a page
  // that sets passwords without re-proving anything. (Regression pin: this
  // used to succeed via a session fallback in consumeRecoveryLink.)
  const signedIn = makeStub();
  const repository = new SupabaseUserRepository(signedIn.client);
  assert.deepEqual(await repository.consumeRecoveryLink({ search: "", hash: "#/reset-password" }), {
    ok: false,
    code: "not_authenticated",
  });
  assert.deepEqual(await repository.consumeRecoveryLink({ search: "", hash: "" }), {
    ok: false,
    code: "not_authenticated",
  });
  // Nothing was exchanged or adopted along the way.
  assert.ok(
    !signedIn.calls.some((c) => c.startsWith("exchangeCodeForSession") || c.startsWith("setSession")),
    "no authority was conjured from the existing session",
  );
});

test("a valid PKCE link works once, and only once, per browser", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const parts = { search: "?code=pkce-once-only", hash: "#/reset-password" };
  assert.deepEqual(await repository.consumeRecoveryLink(parts), { ok: true });
  // Refresh / back-button / re-paste of the SAME link: refused localy, before
  // the provider is even asked. (Logout → retry must not re-create authority;
  // the provider also makes PKCE codes single-use server-side.)
  assert.deepEqual(await repository.consumeRecoveryLink(parts), { ok: false, code: "expired" });
  assert.equal(
    stub.calls.filter((c) => c === "exchangeCodeForSession:pkce-once-only").length,
    1,
    "the provider was asked exactly once",
  );
});

test("implicit-flow tokens are recovery authority only when the URL says type=recovery", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  // A bare token pair — e.g. a copied NORMAL session pasted into this shape —
  // is not a recovery link and is refused without being adopted.
  const masquerade = { search: "", hash: "#/reset-password?access_token=pasted-session&refresh_token=ref" };
  assert.deepEqual(await repository.consumeRecoveryLink(masquerade), { ok: false, code: "expired" });
  assert.ok(!stub.calls.includes("setSession:pasted-session"), "pasted session tokens were never adopted");

  // The same pair carrying the marker the provider appends to recovery emails
  // works — once.
  const genuine = makeStub();
  const genuineRepo = new SupabaseUserRepository(genuine.client);
  const parts = { search: "", hash: "#/reset-password?access_token=implicit-once&refresh_token=ref&type=recovery" };
  assert.deepEqual(await genuineRepo.consumeRecoveryLink(parts), { ok: true });
  assert.deepEqual(await genuineRepo.consumeRecoveryLink(parts), { ok: false, code: "expired" });
  assert.equal(
    genuine.calls.filter((c) => c === "setSession:implicit-once").length,
    1,
    "the implicit pair was spent exactly once",
  );
});

test("a signed-in change needs the CURRENT password — and a wrong one changes nothing", async () => {
  // No session at all: there is nobody to re-prove.
  const anonymous = makeStub({ session: null });
  assert.deepEqual(await new SupabaseUserRepository(anonymous.client).changePassword("CorrectHorse1", "NewPassword1"), {
    ok: false,
    code: "not_authenticated",
  });
  assert.equal(anonymous.updateCalls.length, 0, "no credential write without a session");

  // A real session, but the current password is wrong: refused, and the
  // session/credential stay exactly as they were.
  const wrong = makeStub();
  const wrongRepo = new SupabaseUserRepository(wrong.client);
  assert.deepEqual(await wrongRepo.changePassword("WrongHorse1", "NewPassword1"), {
    ok: false,
    code: "invalid_credentials",
  });
  assert.equal(wrong.updateCalls.length, 0, "the new password never reached the provider");
  assert.deepEqual(wrong.signOutScopes, [], "and the session was not disturbed");

  // Weak proposals are refused before any verification travel.
  const weak = makeStub();
  assert.deepEqual(await new SupabaseUserRepository(weak.client).changePassword("CorrectHorse1", "short"), {
    ok: false,
    code: "weak_password",
  });
  assert.equal(weak.updateCalls.length, 0);
});

test("a username account changes its password: re-proof goes through the same door login uses", async () => {
  const stub = makeStub(); // u-admin session; profile username "admin" (no @)
  const repository = new SupabaseUserRepository(stub.client);

  const outcome = await repository.changePassword("CorrectHorse1", "NewPassword1");
  assert.deepEqual(outcome, { ok: true });
  assert.ok(
    stub.calls.includes("functions:alyq-auth:login"),
    "the current password was re-verified via the alyq-auth function, exactly like a username login",
  );
  assert.deepEqual(stub.updateCalls, [{ password: "NewPassword1" }]);
});

test("an email-address account re-proves directly with the provider", async () => {
  const stub = makeStub({
    profiles: [
      {
        id: "u-mail",
        username: "mail@alyq.example",
        name: "Mail Login",
        role: "admin",
        active: true,
        email: "mail@alyq.example",
        phone: null,
        custom_role_id: null,
        last_login_at: null,
        created_at: "2026-01-05T00:00:00.000Z",
      },
    ],
    session: { access_token: "t", expires_at: 1900000000, user: { id: "u-mail", email: "mail@alyq.example" } },
  });
  const repository = new SupabaseUserRepository(stub.client);

  const outcome = await repository.changePassword("CorrectHorse1", "NewPassword1");
  assert.deepEqual(outcome, { ok: true });
  assert.ok(stub.calls.includes("signInWithPassword:mail@alyq.example"), "email accounts verify with the provider");
  assert.ok(!stub.calls.includes("functions:alyq-auth:login"), "and do not detour through the edge function");
  assert.deepEqual(stub.updateCalls, [{ password: "NewPassword1" }]);
});

test("a throttled re-proof is named, and a deactivated account cannot change its password", async () => {
  const throttled = makeStub({ functionError: { status: 429, body: { ok: false, code: "rate_limited" } } });
  assert.deepEqual(await new SupabaseUserRepository(throttled.client).changePassword("CorrectHorse1", "NewPassword1"), {
    ok: false,
    code: "rate_limited",
  });
  assert.equal(throttled.updateCalls.length, 0);

  const inactive = makeStub({
    session: { access_token: "t", expires_at: 1900000000, user: { id: "u-off", email: "gone@alyq.example" } },
  });
  assert.deepEqual(await new SupabaseUserRepository(inactive.client).changePassword("CorrectHorse1", "NewPassword1"), {
    ok: false,
    code: "not_authenticated",
  });
  assert.equal(inactive.updateCalls.length, 0, "no credential write for a deactivated account");
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

test("INITIAL_SESSION and transient event-profile failures are not signed-out verdicts", async () => {
  const throwOn: string[] = [];
  const stub = makeStub({ throwOn });
  const repository = new SupabaseUserRepository(stub.client);
  const seen: string[] = [];
  repository.onAuthChange((event) => seen.push(event.type));

  stub.emit("INITIAL_SESSION", null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [], "boot owns INITIAL_SESSION classification");

  throwOn.push("from.profiles");
  stub.emit("TOKEN_REFRESHED", { user: { id: "u-admin", email: "admin@alyq.local" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [], "one profile transport failure preserves the existing login");
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

  assert.equal(users.length, 4);
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

// ── in-flight request de-duplication (Task 10, item 4) ────────────────────────
//
// `currentSession()` and `refreshSession()` each hold their own pending-promise
// slot so that every caller funnelled through them — boot, the merged
// focus/visibility resume, the provider's own `onAuthStateChange`, cross-tab
// sync, and an explicit `refreshIdentity()` — shares one round trip when two or
// more of them land in the same tick, instead of opening one each for the
// identical answer.

test("concurrent currentSession() calls share exactly one provider round trip", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const [a, b, c] = await Promise.all([
    repository.currentSession(),
    repository.currentSession(),
    repository.currentSession(),
  ]);

  assert.equal(stub.calls.filter((call) => call === "getSession").length, 1);
  // The supporting reads (profile, branch RPC) are part of the same shared
  // answer, so they are deduplicated too — not just the top-level call.
  assert.equal(stub.calls.filter((call) => call === "from.profiles.eq.id").length, 1);
  assert.equal(stub.rpcCalls.filter((call) => call === "get_active_branch_context").length, 1);
  // All three callers get the SAME result, not three separately-fetched copies.
  assert.ok(a && b && c);
  assert.equal(a?.token, b?.token);
  assert.equal(b?.token, c?.token);
});

test("concurrent refreshSession() calls share exactly one provider round trip", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  const [a, b] = await Promise.all([repository.refreshSession(), repository.refreshSession()]);

  assert.equal(stub.calls.filter((call) => call === "refreshSession").length, 1);
  assert.equal(stub.calls.filter((call) => call === "from.profiles.eq.id").length, 1);
  assert.ok(a && b);
  assert.equal(a?.token, "refreshed-token");
  assert.equal(a?.token, b?.token);
});

test("currentSession() and refreshSession() de-duplicate independently of each other", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  // A read and a forced refresh in flight at once are semantically different
  // requests (one of Task 10's explicit decisions: two separate pending slots,
  // not one shared one) — both must still go to the provider exactly once each.
  const [read, refreshed] = await Promise.all([repository.currentSession(), repository.refreshSession()]);

  assert.equal(stub.calls.filter((call) => call === "getSession").length, 1);
  assert.equal(stub.calls.filter((call) => call === "refreshSession").length, 1);
  assert.equal(read?.token, "provider-access-token");
  assert.equal(refreshed?.token, "refreshed-token");
});

test("sequential currentSession() calls are NOT permanently merged — a later, non-overlapping call refreshes", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  await repository.currentSession();
  await repository.currentSession();

  // De-duplication only covers calls that are genuinely in flight together;
  // once the first has settled, the slot is cleared and a later, deliberate
  // call (a resume, an explicit refresh) still reaches the provider — the
  // reduction comes from calling this far less often, not from an unbounded
  // cache.
  assert.equal(stub.calls.filter((call) => call === "getSession").length, 2);
});

test("a pending currentSession() does not swallow a request made after it settles (five concurrent + one later)", async () => {
  const stub = makeStub();
  const repository = new SupabaseUserRepository(stub.client);

  // Five legitimate concurrent triggers (test E's "rapid duplicate refresh
  // triggers") collapse to one request …
  await Promise.all([
    repository.currentSession(),
    repository.currentSession(),
    repository.currentSession(),
    repository.currentSession(),
    repository.currentSession(),
  ]);
  assert.equal(stub.calls.filter((call) => call === "getSession").length, 1);

  // … and a later, separate call (not overlapping with the batch above) is a
  // second, fresh request — proving this is in-flight dedup, not a cache.
  await repository.currentSession();
  assert.equal(stub.calls.filter((call) => call === "getSession").length, 2);
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

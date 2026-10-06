/**
 * AuthProvider live-mode request-lifecycle regression suite (Task 10).
 *
 * The other auth suite (`scripts/auth.flow.mjs`) only ever runs in demo mode —
 * this environment has no reachable Supabase project — so it cannot count
 * Supabase requests. This suite mounts the REAL `AuthProvider` with the REAL
 * `SupabaseUserRepository`, but swaps `@/lib/supabase/client` (an esbuild
 * `alias`, for this bundle only) for a fake module whose `getSupabaseClient()`
 * returns the same proven stub client the contract tests use
 * (`src/lib/auth/__tests__/support/supabaseStub.ts`). Every "Supabase request"
 * below is a call recorded by that stub — a real number, not an estimate.
 *
 * Covers the regression scenarios from the optimization task:
 *   A. initial authenticated load
 *   B. one navigation triggers no extra refresh
 *   C. ten navigations still trigger no extra refresh
 *   D. resuming from the background refreshes exactly once (no focus+visibility double-fire;
 *      a brief background period does not refresh at all)
 *   E. rapid concurrent refresh triggers collapse to one in-flight request
 *   F. sign-in and sign-out refresh/clear identity correctly
 *   G. a stale in-flight refresh cannot resurrect a session sign-out already ended
 *   H. an explicit refresh (`refreshIdentity`, what a branch switch calls) picks up a changed role immediately
 *   I. a cross-tab authority-change signal still triggers exactly one refresh
 *   + the zero-network local safety check (the heartbeat's replacement)
 *
 * Run directly: node scripts/authProvider.live.flow.mjs
 * (bundles itself; no `npm run test:bundle` step needed first.)
 */
import { JSDOM } from "jsdom";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testBuildOptions } from "./lib/app-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "src", "lib", "auth", "__tests__", "support", "authProviderHarness.tsx");
const FAKE_CLIENT = path.join(ROOT, "src", "lib", "auth", "__tests__", "support", "fakeSupabaseClientModule.ts");
const BUNDLE = path.join(os.tmpdir(), "alyq-auth-provider-harness.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── build (self-contained: its own entry + alias, not the shared app bundle) ─
const esbuild = await import("esbuild");
await esbuild.build(
  testBuildOptions({
    entryPoints: [ENTRY],
    outfile: BUNDLE,
    alias: { "@/lib/supabase/client": FAKE_CLIENT },
  }),
);

// ── jsdom, bootstrapped the way every other flow bootstraps it ─────────────
const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

const consoleErrors = [];
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch {
  /* node owns navigator */
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
// In a real browser `globalThis === window`, so `globalThis.addEventListener`
// and `window.addEventListener` are the same call. In this Node+jsdom
// harness they are two different objects unless bridged — without this,
// code that listens via the bare `globalThis` (cross-tab auth events do, to
// work the same way in a worker as in a window) would attach to a
// `EventTarget` nothing ever dispatches on, and silently never fire.
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.dispatchEvent = dom.window.dispatchEvent.bind(dom.window);
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.BroadcastChannel = dom.window.BroadcastChannel;
const captureConsoleError = (...args) => {
  consoleErrors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
  process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
};
dom.window.console.error = captureConsoleError;
// The bundled app code calls the bare `console.error`, which inside a Node
// module is Node's OWN console — `dom.window.console.error` never sees it
// (see `scripts/crash.flow.mjs`'s note on the same gotcha). Both are
// stubbed so the "console errors: N" line is not blind to real app logging;
// Node's is restored before the summary so this driver's own output still
// prints normally.
const realConsoleError = console.error.bind(console);
console.error = captureConsoleError;
dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));

// Every real network attempt. The stub answers everything the app needs, so
// this must stay empty for the whole run.
const networkCalls = [];
const blockedFetch = (input) => {
  const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
  networkCalls.push(`fetch ${url}`);
  return Promise.reject(new Error(`blocked network call: ${url}`));
};
dom.window.fetch = blockedFetch;
globalThis.fetch = blockedFetch;

// `document.visibilityState` is a read-only getter in a real browser (and in
// jsdom); the resume effect reads it, so it is overridden here with a value
// the test can drive, and `setVisibility` fires the real event afterwards —
// exactly what a tab switch does.
let visibility = "visible";
Object.defineProperty(dom.window.document, "visibilityState", {
  get: () => visibility,
  configurable: true,
});
function setVisibility(next) {
  visibility = next;
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

// The resume dedup window (60 s) and the local safety check (5 min) are real
// wall-clock thresholds; advancing `Date.now()` is how this suite proves them
// without the run actually taking minutes. `setTimeout`-based sleeps are
// unaffected: Node schedules those off the event loop, not `Date.now()`.
const RealDate = Date;
const realDateNow = RealDate.now.bind(RealDate);
let dateOffsetMs = 0;
// A `Date.now` override alone does not affect `new Date()` (no args) — V8's
// no-arg constructor reads the engine clock directly, bypassing the static
// `now()` method entirely. The app's session-expiry helpers default to
// `new Date()`, so the override has to be a full `Date` subclass to be
// visible to every clock read the bundled code performs.
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(realDateNow() + dateOffsetMs);
    else super(...args);
  }
  static now() {
    return realDateNow() + dateOffsetMs;
  }
}
globalThis.Date = FakeDate;
dom.window.Date = FakeDate;

const harness = await import(pathToFileURL(BUNDLE).href);
const {
  mountAuthHarness,
  unmountAuthHarness,
  resetAuthRepositories,
  resetSessionCache,
  SESSION_STORAGE_KEY,
  AUTH_SIGNAL_KEY,
  checkLocalSessionHealth,
  SESSION_ABSOLUTE_MS,
} = harness;

// ── the stub client (shared with the contract tests) ────────────────────────
// Plain TypeScript, so it is bundled the same way the logic suites bundle
// `*.selftest.ts` — this script runs standalone, not only through the runner.
const stubOutfile = path.join(os.tmpdir(), "alyq-auth-stub.mjs");
await esbuild.build(
  testBuildOptions({
    entryPoints: [path.join(ROOT, "src", "lib", "auth", "__tests__", "support", "supabaseStub.ts")],
    outfile: stubOutfile,
  }),
);
const { makeStub } = await import(pathToFileURL(stubOutfile).href);

/** A session record this browser already holds, matching the stub's default admin row. */
function seededAppSession({ issuedMsAgo = 60_000, expiresInMs = 3_600_000 } = {}) {
  const now = Date.now();
  return {
    session: {
      token: "sess-seed-admin",
      user: { id: "u-admin", username: "admin", name: "Store Admin", role: "admin", capabilities: [] },
      issued_at: new Date(now - issuedMsAgo).toISOString(),
      expires_at: new Date(now + expiresInMs).toISOString(),
      remember: true,
    },
    persistence: "local",
  };
}

function seedStorage(seed) {
  const store = seed.persistence === "local" ? dom.window.localStorage : dom.window.sessionStorage;
  store.setItem(SESSION_STORAGE_KEY, JSON.stringify(seed));
}

/** Fresh stub + fresh repositories/session cache + fresh React mount. */
async function freshMount({ seeded = true, seed = null, stubOptions = {} } = {}) {
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  resetSessionCache();
  resetAuthRepositories();
  dateOffsetMs = 0;
  visibility = "visible";

  const stub = makeStub(stubOptions);
  globalThis.__ALYQ_TEST_SUPABASE_CLIENT__ = stub.client;

  if (seeded) seedStorage(seed ?? seededAppSession());

  mountAuthHarness();
  // Let the boot effect's async `currentSession()` resolve.
  for (let i = 0; i < 30 && globalThis.__auth?.syncing; i += 1) await sleep(50);
  await sleep(50);
  return stub;
}

function teardown() {
  unmountAuthHarness();
}

const callsOf = (stub, name) => stub.calls.filter((c) => c === name).length;

// ── step runner ──────────────────────────────────────────────────────────
const results = [];
async function step(id, title, run) {
  let status = "PASS";
  let detail;
  try {
    detail = (await run()) ?? [];
  } catch (err) {
    status = "FAIL";
    detail = [`${err?.stack ?? err}`];
  }
  results.push({ id, title, status });
  console.log(`\n${status === "PASS" ? "✓" : "✗"} ${id} · ${title} — ${status}`);
  for (const line of detail) console.log(`    ${line}`);
}

console.log("\nAuthProvider live-mode request-lifecycle suite — ALYQ Cloud POS (Task 10)");

// ── A. initial authenticated load ──────────────────────────────────────────
let baselineStub;
await step("A", "Initial authenticated load works normally", async () => {
  baselineStub = await freshMount();
  if (globalThis.__auth?.status !== "authenticated") {
    throw new Error(`expected authenticated, got ${globalThis.__auth?.status}`);
  }
  if (globalThis.__auth?.user?.role !== "admin") throw new Error("identity not resolved from the provider");
  const getSession = callsOf(baselineStub, "getSession");
  const profile = callsOf(baselineStub, "from.profiles.eq.id");
  const rpc = baselineStub.rpcCalls.filter((c) => c === "get_active_branch_context").length;
  if (getSession !== 1) throw new Error(`expected exactly 1 getSession on boot, saw ${getSession}`);
  return [
    `status: ${globalThis.__auth.status}, role: ${globalThis.__auth.user.role}`,
    `initial load (test-derived): getSession=${getSession}, profiles=${profile}, get_active_branch_context=${rpc}`,
  ];
});

// ── B/C. navigation does not refresh ───────────────────────────────────────
await step("B", "One normal route navigation triggers no extra identity/profile/branch refresh", async () => {
  const before = baselineStub.calls.length;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(100);
  const after = baselineStub.calls.length;
  if (after !== before) throw new Error(`navigation added ${after - before} call(s): ${baselineStub.calls.slice(before)}`);
  return [`calls before: ${before}, after one hashchange: ${after}`];
});

await step("C", "Ten navigations still trigger no extra refresh", async () => {
  const before = baselineStub.calls.length;
  for (let i = 0; i < 10; i += 1) {
    dom.window.location.hash = `#/route-${i}`;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  }
  await sleep(150);
  const after = baselineStub.calls.length;
  if (after !== before) throw new Error(`10 navigations added ${after - before} call(s): ${baselineStub.calls.slice(before)}`);
  return [`calls before: ${before}, after 10 navigations: ${after} (0 added, test-derived)`];
});

// ── D. resume: merged focus/visibility, deduped, thresholded ───────────────
await step("D", "Resuming after a meaningful background period refreshes exactly once", async () => {
  const before = baselineStub.calls.length;
  setVisibility("hidden");
  dateOffsetMs += 70_000; // past RESUME_MIN_BACKGROUND_MS (60s)
  setVisibility("visible");
  dom.window.dispatchEvent(new dom.window.Event("focus")); // fires alongside visibilitychange on a real tab switch
  await sleep(150);
  const afterOne = baselineStub.calls.length - before;
  const getSessionAdded = callsOf(baselineStub, "getSession") - 1; // minus boot's own
  if (getSessionAdded !== 1) {
    throw new Error(`expected exactly 1 additional getSession on resume, saw ${getSessionAdded}`);
  }
  return [`calls added by one resume (visibility + focus together): ${afterOne}, getSession added: ${getSessionAdded}`];
});

await step("D2", "A brief background period (below the dedup threshold) does not refresh", async () => {
  const before = baselineStub.calls.length;
  setVisibility("hidden");
  dateOffsetMs += 5_000; // well under the 60s threshold
  setVisibility("visible");
  await sleep(100);
  const after = baselineStub.calls.length;
  if (after !== before) throw new Error(`a brief background period added ${after - before} call(s)`);
  return [`calls added by a 5s background blip: ${after - before} (0 expected)`];
});

await step("D3", "Window blur/focus without the tab becoming hidden also resumes exactly once", async () => {
  const before = callsOf(baselineStub, "getSession");
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  dateOffsetMs += 70_000;
  dom.window.dispatchEvent(new dom.window.Event("focus"));
  await sleep(100);
  const added = callsOf(baselineStub, "getSession") - before;
  if (added !== 1) throw new Error(`expected exactly 1 additional getSession, saw ${added}`);
  return [`getSession added by an OS-focus-only resume: ${added}`];
});

teardown();

// ── E. rapid concurrent triggers de-duplicate at the component level too ──
await step("E", "Rapid concurrent refreshIdentity() calls collapse to one in-flight request", async () => {
  const stub = await freshMount();
  const before = callsOf(stub, "getSession");
  await Promise.all([
    globalThis.__auth.refreshIdentity(),
    globalThis.__auth.refreshIdentity(),
    globalThis.__auth.refreshIdentity(),
    globalThis.__auth.refreshIdentity(),
    globalThis.__auth.refreshIdentity(),
  ]);
  const added = callsOf(stub, "getSession") - before;
  if (added !== 1) throw new Error(`5 concurrent refreshIdentity() calls made ${added} provider request(s), expected 1`);
  teardown();
  return [`provider requests for 5 concurrent refreshIdentity() calls: ${added}`];
});

// ── F. sign-in / sign-out ──────────────────────────────────────────────────
await step("F", "Sign-in and sign-out refresh/clear identity correctly", async () => {
  const stub = await freshMount({ seeded: false, stubOptions: { session: null } });
  if (globalThis.__auth.status !== "anonymous") throw new Error("expected anonymous with neither app nor provider session");

  const ok = await globalThis.__auth.signIn({ username: "admin", password: "CorrectHorse1" });
  if (!ok) throw new Error(`sign-in failed: error=${globalThis.__auth.error}, calls=${JSON.stringify(stub.calls)}`);
  // `signIn()`'s promise resolving means the *state update* has been
  // scheduled, not necessarily committed and re-rendered yet (React batches
  // and flushes on its own schedule) — a tick lets `Probe` republish it.
  await sleep(20);
  if (globalThis.__auth.status !== "authenticated" || globalThis.__auth.user?.role !== "admin") {
    throw new Error(`sign-in did not establish an authenticated admin session: status=${globalThis.__auth.status}, user=${JSON.stringify(globalThis.__auth.user)}, calls=${JSON.stringify(stub.calls)}`);
  }
  const loggedIn = stub.calls.some((c) => c.startsWith("functions:alyq-auth:login") || c.startsWith("signInWithPassword"));
  if (!loggedIn) throw new Error("sign-in did not reach the provider");

  await globalThis.__auth.signOut();
  await sleep(20);
  if (globalThis.__auth.status !== "anonymous" || globalThis.__auth.user !== null) {
    throw new Error("sign-out did not clear the session");
  }
  if (stub.signOutScopes.at(-1) !== "local") throw new Error("sign-out did not ask for a local scope");
  teardown();
  return ["sign-in reaches the provider and establishes the session", "sign-out clears state and asks the provider to end it"];
});

// ── G. sign-out race: a stale in-flight refresh cannot resurrect a session ──
await step("G", "A stale in-flight refresh cannot overwrite a sign-out that started after it", async () => {
  await freshMount();
  // Trigger a resume refresh (an in-flight, authority-asking read) …
  setVisibility("hidden");
  dateOffsetMs += 70_000;
  setVisibility("visible"); // starts resyncCurrentIdentity() -> currentSession(), not yet awaited by this script
  // … and, in the SAME tick, sign out. `signOut()` bumps the epoch
  // synchronously before its own await, so the resume above is already stale
  // by the time it resolves, however the two interleave afterwards.
  const signedOut = globalThis.__auth.signOut();
  await signedOut;
  await sleep(200); // let the resume's chain (still in flight) fully settle too
  if (globalThis.__auth.status !== "anonymous" || globalThis.__auth.user !== null) {
    throw new Error(
      `the stale resume resurrected the session: status=${globalThis.__auth.status}, user=${JSON.stringify(globalThis.__auth.user)}`,
    );
  }
  teardown();
  return ["sign-out initiated while a resume refresh was in flight", "final state: anonymous, user: null — the stale answer was discarded"];
});

// ── H. an explicit refresh picks up a changed role immediately ────────────
await step("H", "refreshIdentity() (what a branch switch calls) is authoritative immediately", async () => {
  const profiles = [
    { id: "u-admin", username: "admin", name: "Store Admin", role: "admin", active: true, email: "admin@alyq.example", phone: null, custom_role_id: null, last_login_at: null, created_at: "2026-01-01T00:00:00.000Z" },
  ];
  await freshMount({ stubOptions: { profiles } });
  if (globalThis.__auth.user.role !== "admin") throw new Error("expected the initial admin role");

  // An administrator changes this account's role while it is signed in —
  // exactly the case `resyncCurrentIdentity()`'s own doc comment describes.
  profiles[0].role = "cashier";
  const ok = await globalThis.__auth.refreshIdentity();
  if (!ok) throw new Error("refreshIdentity() reported failure");
  await sleep(20);
  if (globalThis.__auth.user?.role !== "cashier") {
    throw new Error(`role change was not authoritative: still ${globalThis.__auth.user?.role}`);
  }
  teardown();
  return ["role changed server-side while signed in", "refreshIdentity() picked it up immediately: role is now cashier"];
});

// ── I. cross-tab authority-change signal still works ───────────────────────
await step("I", "A cross-tab session_changed signal still triggers exactly one refresh", async () => {
  const profiles = [
    { id: "u-admin", username: "admin", name: "Store Admin", role: "admin", active: true, email: "admin@alyq.example", phone: null, custom_role_id: null, last_login_at: null, created_at: "2026-01-01T00:00:00.000Z" },
  ];
  const stub = await freshMount({ stubOptions: { profiles } });
  const before = callsOf(stub, "getSession");

  profiles[0].role = "manager";
  const payload = JSON.stringify({ kind: "session_changed", at: new Date().toISOString(), nonce: "n1" });
  dom.window.localStorage.setItem(AUTH_SIGNAL_KEY, payload);
  dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: AUTH_SIGNAL_KEY, newValue: payload }));
  await sleep(150);

  const added = callsOf(stub, "getSession") - before;
  if (added !== 1) throw new Error(`expected exactly 1 refresh from the cross-tab signal, saw ${added}`);
  if (globalThis.__auth.user?.role !== "manager") throw new Error("the cross-tab signal did not pick up the role change");
  teardown();
  return [`provider requests from one cross-tab session_changed signal: ${added}`, "role change applied: manager"];
});

// ── persistent boot: provider-only session, no login flash, restart ─────────
await step("PERSIST", "A provider-persisted session restores without an app record or login flash", async () => {
  const stub = await freshMount({ seeded: false });
  if (globalThis.__auth.status !== "authenticated") throw new Error("provider-only session was not adopted");
  if (globalThis.__authStatuses.includes("anonymous")) {
    throw new Error(`protected bootstrap flashed anonymous: ${globalThis.__authStatuses.join(" -> ")}`);
  }
  const stored = JSON.parse(dom.window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "null");
  if (stored?.persistence !== "local" || stored?.session?.remember !== true) {
    throw new Error("adopted provider session was not persisted canonically");
  }
  if (!String(stored.session.token).startsWith("sess-")) {
    throw new Error("the app identity cache copied a provider access token");
  }

  // Simulate Web reload, Electron restart or Capacitor cold restart: React and
  // module memory disappear, while provider/app persistent storage remains.
  teardown();
  resetSessionCache();
  resetAuthRepositories();
  mountAuthHarness();
  for (let n = 0; n < 30 && globalThis.__auth?.syncing; n += 1) await sleep(50);
  await sleep(50);
  if (globalThis.__auth.status !== "authenticated") throw new Error("cold restart lost the session");
  if (globalThis.__authStatuses.includes("anonymous")) throw new Error("restart flashed the login state");
  teardown();
  return [
    "provider-only persisted session adopted and cached persistently",
    "Web refresh / Desktop restart / Mobile cold restart: authenticated, no anonymous frame",
    `provider getSession calls across first boot + restart: ${callsOf(stub, "getSession")}`,
  ];
});

// ── access expiry rotates silently ─────────────────────────────────────────
await step("ROTATE", "Expired access token plus valid refresh session rotates silently", async () => {
  const stub = await freshMount({ seed: seededAppSession({ expiresInMs: -60_000 }) });
  if (globalThis.__auth.status !== "authenticated") throw new Error("access expiry signed the user out");
  if (callsOf(stub, "refreshSession") !== 1) {
    throw new Error(`expected one refreshSession, saw ${callsOf(stub, "refreshSession")}`);
  }
  if (globalThis.__auth.endReason !== null) throw new Error("normal token rotation showed a session-ended reason");
  if (globalThis.__authStatuses.includes("anonymous")) throw new Error("silent refresh flashed login");
  teardown();
  return ["refreshSession=1", "status remained authenticated; no session-expired reason or login flash"];
});

// ── transient offline startup + bounded reconnect recovery ─────────────────
await step("OFFLINE", "Temporary offline startup preserves identity and reconnect recovers once", async () => {
  const throwOn = ["getSession"];
  const stub = await freshMount({ stubOptions: { throwOn } });
  if (globalThis.__auth.status !== "authenticated") throw new Error("temporary offline startup forced logout");
  if (globalThis.__auth.endReason !== null) throw new Error("offline startup showed session expired");

  throwOn.length = 0;
  const before = callsOf(stub, "getSession");
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await sleep(150);
  const added = callsOf(stub, "getSession") - before;
  if (added !== 1) throw new Error(`reconnect made ${added} provider reads, expected one`);
  if (globalThis.__auth.status !== "authenticated") throw new Error("reconnect did not preserve/recover authentication");
  teardown();
  return ["offline boot kept cached identity", `online event recovery reads: ${added}`, "no retry loop"];
});

// ── confirmed invalidation ends the session ────────────────────────────────
await step("REVOKED", "Confirmed invalid/revoked refresh token returns controlled login", async () => {
  const stub = await freshMount({
    seed: seededAppSession({ expiresInMs: -60_000 }),
    stubOptions: {
      refreshError: { message: "Invalid Refresh Token: token has been revoked", code: "refresh_token_not_found", status: 400 },
    },
  });
  if (callsOf(stub, "refreshSession") !== 1) throw new Error("revocation was not confirmed through refresh");
  if (globalThis.__auth.status !== "anonymous") throw new Error("revoked refresh session remained authenticated");
  if (globalThis.__auth.endReason !== "expired") throw new Error("confirmed invalidation lacked controlled end reason");
  if (dom.window.localStorage.getItem(SESSION_STORAGE_KEY)) throw new Error("revoked app identity cache was not cleared");
  teardown();
  return ["provider invalidation confirmed", "local identity cleared; controlled anonymous state with expired reason"];
});

// ── global logout revocation survives restart ──────────────────────────────
await step("GLOBAL", "Logout All Devices revokes globally and cannot silently restart", async () => {
  const stub = await freshMount();
  await globalThis.__auth.signOutEverywhere();
  await sleep(30);
  if (globalThis.__auth.status !== "anonymous") throw new Error("global logout did not end the local session");
  if (stub.signOutScopes.at(-1) !== "global") throw new Error("global logout did not use provider global scope");
  if (dom.window.localStorage.getItem(SESSION_STORAGE_KEY)) throw new Error("global logout left app storage");

  teardown();
  resetSessionCache();
  resetAuthRepositories();
  mountAuthHarness();
  for (let n = 0; n < 30 && globalThis.__auth?.syncing; n += 1) await sleep(50);
  await sleep(50);
  if (globalThis.__auth.status !== "anonymous") throw new Error("globally revoked session silently continued after restart");
  teardown();
  return ["provider scope=global", "restart remains anonymous"];
});

// ── local safety: access-token age is never local logout authority ─────────
await step("SAFETY", "The local safety check never logs out a live refresh session", async () => {
  const stub = await freshMount();
  const before = stub.calls.length;
  const withinWindow = await checkLocalSessionHealth();
  if (stub.calls.length !== before) throw new Error("the local safety check made a provider request");
  if (withinWindow.changed || !withinWindow.session) throw new Error("a valid live identity was changed");

  // Even an old local issued_at/access expiry is only a cached shell in live
  // mode. Refresh-token authority belongs to Supabase and is checked on wake.
  dom.window.localStorage.clear();
  seedStorage(seededAppSession({ issuedMsAgo: SESSION_ABSOLUTE_MS + 60_000, expiresInMs: -60_000 }));
  resetSessionCache();
  const oldCache = await checkLocalSessionHealth();
  if (oldCache.changed || !oldCache.session) throw new Error("local token age impersonated provider revocation");
  if (stub.signOutScopes.length !== 0) throw new Error("local age triggered provider sign-out");
  teardown();
  return [
    "common check: 0 provider requests",
    "old access-token cache: retained until authoritative refresh; 0 signOut calls",
  ];
});

globalThis.Date = RealDate;
dom.window.Date = RealDate;
console.error = realConsoleError;

// ── summary ─────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
console.log("\n──────── summary ────────");
for (const r of results) console.log(`${r.status === "PASS" ? "✓" : "✗"} ${r.id}. ${r.title}: ${r.status}`);
console.log(`\n${count("PASS")} passed · ${count("FAIL")} failed · console errors: ${consoleErrors.length} · blocked real network calls: ${networkCalls.length}`);
if (networkCalls.length > 0) {
  console.error(`\n✗ ${networkCalls.length} call(s) tried to leave the stub for a real network:`);
  for (const call of networkCalls) console.error("  " + call);
  process.exit(1);
}
if (consoleErrors.length > 0) {
  console.error(`\n✗ ${consoleErrors.length} console error(s) during the run`);
  process.exit(1);
}
if (count("FAIL") > 0) process.exit(1);
console.log("\nAuthProvider live-mode request lifecycle verified.\n");
process.exit(0);

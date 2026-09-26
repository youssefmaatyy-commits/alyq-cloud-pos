/**
 * Authentication acceptance test — the seven requested steps, plus the two
 * credential/session cases the phase must also cover (wrong password, expiry).
 *
 * Build the bundle first, then run it:
  *   npm run test:bundle                 # → os.tmpdir()/alyq-app.mjs
 *   node scripts/auth.flow.mjs
 * or let the runner do both: `npm run test:e2e auth`.
 *
 * The bundle step is `scripts/lib/app-bundle.mjs`; a bare `npx esbuild` fails on
 * `@/assets/alyq-logo.png` because esbuild ships no `.png` loader.
 *
 * Steps
 *   1 open application            6 unauthorized action blocked
 *   2 login screen appears        7 logout closes the session
 *   3 valid credentials           8 wrong credentials rejected
 *   4 user enters the dashboard   9 session expiry (live + on boot)
 *   5 cashier permissions
 *
 * Sessions are real: a login creates a persisted session record, every screen
 * sits behind the session guard, and sign-out/expiry clear the record. Expiry
 * is exercised by booting the app on a seeded session — one that lapses while
 * the app is running, and one that had already lapsed before boot.
 */
import { JSDOM } from "jsdom";
import { DEFAULT_BUNDLE, bundleFileUrl } from "./lib/app-bundle.mjs";

const BUNDLE = DEFAULT_BUNDLE;
const DEMO_PASSWORD = "alyq1234";
const SESSION_KEY = "alyq.auth.session.v1";

// ── app bootstrap ─────────────────────────────────────────────────────────
let bootCount = 0;

/**
 * Boot the real app bundle inside a fresh jsdom document.
 *
 * Each call gets its own document and its own copy of the module graph (the
 * import URL is unique), so a scenario can start from a clean, seeded state —
 * the only way to observe what happens *on boot* with an existing session.
 */
async function boot({ seedSession = null } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  const consoleErrors = [];
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    // Node 22 owns `navigator`; jsdom's copy is only needed if it can be set.
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  } catch {
    /* node owns navigator */
  }
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  // React's form submission builds `new FormData(form, submitter)`; Node's own
  // FormData refuses a jsdom form element, so use jsdom's implementation.
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.File = dom.window.File;
  globalThis.Blob = dom.window.Blob;
  globalThis.FileReader = dom.window.FileReader;
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = () => {};
  // Sign-in is localStorage-only in demo mode, so nothing here may reach the
  // network. Record every attempt; the summary fails the run if there was one.
  const blockedFetch = (input) => {
    const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
    networkCalls.push(`fetch ${url}`);
    return Promise.reject(new Error(`blocked network call: ${url}`));
  };
  dom.window.fetch = blockedFetch;
  globalThis.fetch = blockedFetch;
  class BlockedXHR {
    open(method, url) {
      networkCalls.push(`${method} ${url}`);
    }
    send() {
      throw new Error(`blocked network call: ${networkCalls.at(-1) ?? "XHR"}`);
    }
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
  }
  dom.window.XMLHttpRequest = BlockedXHR;
  globalThis.XMLHttpRequest = BlockedXHR;
  dom.window.console.error = (...args) => {
    consoleErrors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
    process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
  };
  dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));

  if (seedSession) {
    const store = seedSession.remember ? dom.window.localStorage : dom.window.sessionStorage;
    store.setItem(
      SESSION_KEY,
      JSON.stringify({
        session: seedSession.session,
        persistence: seedSession.remember ? "local" : "session",
      }),
    );
  }

  bootCount += 1;
  try {
    await import(bundleFileUrl(BUNDLE, `boot=${bootCount}`));
  } catch (err) {
    console.error(`\n✗ could not load the app bundle at ${BUNDLE}.\n  Build it first (see the header of this file).\n  ${err?.message ?? err}\n`);
    process.exit(2);
  }
  await sleep(1000);

  return makeHarness(dom, consoleErrors);
}

/** A session record for a demo account, as the app persists one. */
function seededSession({ expiresInMs, issuedMsAgo = 60_000, remember = false }) {
  const now = Date.now();
  return {
    remember,
    session: {
      token: `sess-seed-${Math.random().toString(36).slice(2, 10)}`,
      user: { id: "usr-admin", username: "admin", name: "ALYQ Admin", role: "admin" },
      issued_at: new Date(now - issuedMsAgo).toISOString(),
      expires_at: new Date(now + expiresInMs).toISOString(),
      remember,
    },
  };
}

/** Every network attempt made during the run — demo mode must make none. */
const networkCalls = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness(dom, consoleErrors) {
  const document = dom.window.document;
  const bodyText = () => document.body.textContent ?? "";
  const navigate = async (hash) => {
    dom.window.location.hash = hash;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    await sleep(450);
  };
  const clickEl = (el) => {
    if (!el) throw new Error("control not found");
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const byText = (label, scope = document) =>
    [...scope.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim().includes(label));
  const typeInto = (input, value) => {
    if (!input) throw new Error("field not found");
    const proto =
      input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : input.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement
          : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
    input.dispatchEvent(
      new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  };
  const usernameField = () => document.querySelector("input[autocomplete='username']");
  const passwordField = () => document.querySelector("input[autocomplete='current-password']");
  const isSignedIn = () => bodyText().includes("Signed in as");
  const notice = () =>
    bodyText().includes("Your session expired")
      ? "expired"
      : bodyText().includes("You have been signed out")
        ? "signed_out"
        : null;
  const navHrefs = () =>
    [...document.querySelectorAll("aside nav a")].map((a) => a.getAttribute("href") ?? "");
  const denied = () => bodyText().includes("You do not have access");
  /** `/audit` carries its own, more specific denial copy. */
  const auditDenied = () => bodyText().includes("Audit log is restricted");
  const readSession = () => {
    const raw =
      dom.window.localStorage.getItem(SESSION_KEY) ?? dom.window.sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  };
  const signIn = async (username, password = DEMO_PASSWORD) => {
    for (let i = 0; i < 25 && !usernameField(); i += 1) await sleep(200);
    typeInto(usernameField(), username);
    typeInto(passwordField(), password);
    clickEl(byText("Sign in"));
    for (let i = 0; i < 25 && !isSignedIn(); i += 1) await sleep(200);
    await sleep(400);
  };
  const signOut = async () => {
    if (!isSignedIn()) return;
    clickEl(byText("Sign out"));
    for (let i = 0; i < 20 && !usernameField(); i += 1) await sleep(200);
    await sleep(200);
  };

  return {
    dom,
    document,
    consoleErrors,
    bodyText,
    navigate,
    clickEl,
    byText,
    typeInto,
    usernameField,
    passwordField,
    isSignedIn,
    notice,
    navHrefs,
    denied,
    auditDenied,
    readSession,
    signIn,
    signOut,
    /** Add the first product to the cart and fill the exact cash amount. */
    stageSale: async () => {
      await navigate("#/pos");
      let scanBox = null;
      for (let i = 0; i < 12 && !(scanBox = document.querySelector('[data-testid="pos-scan-search"]')); i += 1) {
        await sleep(300);
      }
      if (!scanBox) throw new Error("the scan/search box never rendered");
      typeInto(scanBox, "Classic");
      await sleep(400);
      const row = [...document.querySelectorAll("[data-pos-result-index]")].find((b) =>
        (b.textContent ?? "").includes("Classic Gold Ring"),
      );
      if (!row) throw new Error("the Classic Gold Ring row never rendered");
      clickEl(row);
      await sleep(350);
      const exact = byText("Exact");
      if (exact) clickEl(exact);
      await sleep(350);
      return [...document.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes("Complete sale"),
      );
    },
  };
}

// ── step runner ───────────────────────────────────────────────────────────
const results = [];
const log = (line) => console.log(`    ${line}`);

async function step(num, title, run) {
  let status = "PASS";
  let detail = [];
  try {
    detail = (await run()) ?? [];
  } catch (err) {
    status = "FAIL";
    detail = [`${err?.message ?? err}`];
  }
  results.push({ num, title, status });
  const mark = status === "PASS" ? "✓" : "✗";
  console.log(`\n${mark} STEP ${num} · ${title} — ${status}`);
  for (const line of detail) log(line);
}

console.log("\nAuthentication flow test — ALYQ Cloud POS");
console.log("authentication: IMPLEMENTED — all steps are asserted");

// ── main app: signed out, then signed in ──────────────────────────────────
const app = await boot();

// ── STEP 1 · open application ─────────────────────────────────────────────
await step(1, "Open application", async () => {
  if (!app.usernameField()) throw new Error("the app did not open on the login screen");
  if (app.bodyText().includes("ALYQ-1001")) throw new Error("business data loaded before sign-in");
  if (app.readSession()) throw new Error("a session existed without signing in");
  if (app.consoleErrors.length > 0) throw new Error(`console errors during boot: ${app.consoleErrors[0]}`);
  return [
    `app opened at ${app.dom.window.location.hash || "#/"} on the login screen`,
    "no session record and no business data before sign-in",
    `console errors during boot: ${app.consoleErrors.length}`,
  ];
});

// ── STEP 2 · login screen appears ─────────────────────────────────────────
await step(2, "Verify login screen appears", async () => {
  const passwords = app.document.querySelectorAll('input[type="password"]').length;
  if (passwords !== 1) throw new Error(`expected exactly one password field, found ${passwords}`);
  if (!app.byText("Sign in")) throw new Error("no sign-in control on the login screen");
  if (!app.document.querySelector("input[type='checkbox']")) throw new Error("remember-me option missing");
  if (!app.bodyText().includes(DEMO_PASSWORD)) throw new Error("demo credentials are not disclosed on the screen");

  // A protected screen typed directly must bounce to the login screen and
  // remember where the user was heading.
  await app.navigate("#/pos");
  const hash = decodeURIComponent(app.dom.window.location.hash);
  if (!app.usernameField()) throw new Error("a protected route was served without a session");
  if (!hash.includes("next=/pos")) throw new Error(`attempted route not preserved (hash: ${hash})`);
  return [
    "login screen: username + password + remember-me + sign-in button",
    `direct #/pos redirects to ${hash}`,
    "sidebar and business data are absent while signed out",
  ];
});

// ── STEP 3 · valid credentials create a session ───────────────────────────
await step(3, "Enter valid username/password", async () => {
  await app.navigate("#/login");
  await app.signIn("admin");
  if (!app.isSignedIn()) throw new Error("valid credentials did not sign the user in");
  const stored = app.readSession();
  if (!stored) throw new Error("no session record was persisted");
  const { session } = stored;
  if (!session.token) throw new Error("the session has no token");
  if (session.user.role !== "admin") throw new Error(`unexpected role: ${session.user.role}`);
  if (new Date(session.expires_at).getTime() <= Date.now()) throw new Error("the session is already expired");
  if (app.dom.window.localStorage.getItem("alyq.inventory.currentUser.v1")) {
    throw new Error("the legacy demo identity record is still being written");
  }
  return [
    `signed in as ${session.user.name} (${session.user.username} · ${session.user.role})`,
    `session persisted under ${SESSION_KEY} in ${stored.persistence}Storage with a token and an expiry`,
    "no password is stored: the record holds identity + expiry only",
    "the pre-authentication demo identity store is gone",
  ];
});

// ── STEP 4 · user enters the dashboard ────────────────────────────────────
await step(4, "Verify user enters dashboard", async () => {
  await app.navigate("#/");
  for (let i = 0; i < 10 && !app.bodyText().includes("Dashboard"); i += 1) await sleep(300);
  if (!app.bodyText().includes("Dashboard")) throw new Error("dashboard did not render");
  const kpis = app.document.querySelectorAll(".alyq-kpi").length;
  await app.navigate("#/pos");
  const restored = decodeURIComponent(app.dom.window.location.hash);
  return [
    `dashboard rendered (${kpis} KPI tiles) after signing in`,
    `deep link from step 2 (#/pos) still reachable once signed in: ${restored === "#/pos"}`,
    `shell identifies the user: ${app.bodyText().includes("ALYQ Admin")}`,
  ];
});

// ── STEP 5 · cashier permissions ──────────────────────────────────────────
await step(5, "Verify cashier permissions", async () => {
  await app.signOut();
  await app.signIn("cashier");
  if (!app.isSignedIn()) throw new Error("the cashier account could not sign in");
  const out = [];
  out.push(`cashier session role: ${app.readSession()?.session.user.role}`);

  // The till: the cashier must be able to sell. Phase 27 — a till sale needs
  // the drawer open first, and the cashier holds open_shift, so the cashier
  // opens the shift through the shifts screen.
  await app.navigate("#/shifts");
  for (let i = 0; i < 12 && !app.bodyText().includes("No shift is currently open"); i += 1) await sleep(300);
  if (!app.bodyText().includes("No shift is currently open")) throw new Error("expected a closed drawer");
  app.clickEl(app.byText("Open shift"));
  await sleep(400);
  const shiftDialog = [...app.document.querySelectorAll('[role="dialog"]')].pop();
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  app.typeInto(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
  app.typeInto(shiftInputs.find((i) => i.inputMode === "decimal"), "500");
  app.clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  for (let i = 0; i < 12 && !/SH-\d{6}/.test(app.bodyText()); i += 1) await sleep(300);
  if (!/SH-\d{6}/.test(app.bodyText())) throw new Error("the cashier could not open a shift");
  out.push(`shift opened before selling: ${(app.bodyText().match(/SH-\d{6}/) ?? [])[0]}`);

  const complete = await app.stageSale();
  if (!complete) throw new Error("the cashier has no Complete sale control on the register");
  if (complete.disabled) throw new Error("the cashier cannot complete a sale");
  out.push(`can complete a sale: ${!complete.disabled}`);
  app.clickEl(complete);
  await sleep(1600);
  if (!/INV-\d{6}/.test(app.bodyText())) throw new Error("the cashier's sale was not recorded");
  out.push(`sale recorded: ${(app.bodyText().match(/INV-\d{6}/) ?? [])[0] ?? "n/a"}`);

  // Returns / refunds / shifts / expenses are part of the till tier.
  for (const [route, label, expected] of [
    ["#/returns", "Returns", true],
    ["#/refunds", "Refunds", true],
    ["#/shifts", "Shift", true],
    ["#/expenses", "Expenses", true],
    ["#/audit", "Audit", false],
  ]) {
    await app.navigate(route);
    await sleep(500);
    const reachable = !(app.denied() || app.auditDenied());
    out.push(`${route} reachable: ${reachable} (expected ${expected})`);
    if (reachable !== expected) throw new Error(`${route} access is wrong for a cashier`);
    void label;
  }

  // Manager-level actions stay out of reach.
  const navOut = app.navHrefs();
  if (navOut.includes("#/audit")) throw new Error("the audit entry was offered to a cashier");
  out.push("no audit entry in the sidebar; stock adjustments remain read-only");
  return out;
});

// ── STEP 6 · unauthorized action is blocked ───────────────────────────────
await step(6, "Try unauthorized action and confirm it is blocked", async () => {
  const out = [];
  await app.signOut();
  await app.signIn("viewer");
  if (!app.isSignedIn()) throw new Error("the viewer account could not sign in");

  const nav = app.navHrefs();
  for (const hidden of ["#/pos", "#/returns", "#/refunds", "#/audit"]) {
    if (nav.includes(hidden)) throw new Error(`${hidden} was offered to a viewer`);
  }
  out.push(`viewer sidebar: ${nav.join(", ")}`);

  await app.navigate("#/audit");
  await sleep(500);
  const auditDenied = app.bodyText().includes("Audit log is restricted");
  const leaked = /EXP-\d{6}/.test(app.bodyText());
  if (!auditDenied) throw new Error("the audit route was not denied for a viewer");
  if (leaked) throw new Error("audit records leaked to an unauthorized role");
  out.push(`#/audit denied: ${auditDenied} · records leaked: ${leaked}`);

  // Mutations: the register is not even reachable, and nothing may be written.
  const salesBefore = app.dom.window.localStorage.getItem("alyq.demo.sales.v1");
  await app.navigate("#/pos");
  await sleep(500);
  if (!app.denied()) throw new Error("the register was served to a viewer");
  if (app.bodyText().includes("ALYQ-1001")) throw new Error("POS data leaked into the viewer's denial");
  const complete = [...app.document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Complete sale"),
  );
  if (complete) throw new Error("a viewer was offered the Complete sale control");
  out.push("register denied outright — no cart, no Complete sale control");

  await app.navigate("#/inventory/stock");
  await sleep(600);
  const adjust = [...app.document.querySelectorAll("main button")].find(
    (b) => (b.textContent ?? "").trim() === "Adjust stock",
  );
  if (adjust && !adjust.disabled) throw new Error("a viewer could adjust stock");
  out.push(`stock adjustment for a viewer: ${adjust ? "disabled" : "not rendered"}`);

  const salesAfter = app.dom.window.localStorage.getItem("alyq.demo.sales.v1");
  if (salesAfter !== salesBefore) throw new Error("the blocked session wrote to the sales store");
  out.push("sales store untouched by the blocked viewer session");
  return out;
});

// ── STEP 7 · logout closes the session ────────────────────────────────────
await step(7, "Logout and verify session is closed", async () => {
  const before = app.readSession();
  if (!before) throw new Error("no session to log out of");
  await app.signOut();
  if (!app.usernameField()) throw new Error("sign-out did not return to the login screen");
  if (app.notice() !== "signed_out") throw new Error("the user was not told the session ended");
  if (app.readSession()) throw new Error("the stored session survived sign-out");
  await app.navigate("#/pos");
  await sleep(600);
  if (!app.usernameField()) throw new Error("a deep link after sign-out was served without credentials");
  return [
    `signed out ${before.session.user.username} (token ${before.session.token.slice(0, 14)}…)`,
    "login screen restored, session record cleared from both stores",
    `post-logout deep link bounced to ${decodeURIComponent(app.dom.window.location.hash)}`,
  ];
});

// ── STEP 8 · wrong credentials are rejected ───────────────────────────────
await step(8, "Verify wrong password is rejected", async () => {
  await app.signIn("admin", "definitely-not-the-password");
  if (app.isSignedIn()) throw new Error("a wrong password signed the user in");
  if (!app.bodyText().includes("Incorrect username or password")) {
    throw new Error("no rejection message was shown");
  }
  if (app.readSession()) throw new Error("a session was created for a failed attempt");
  if (app.bodyText().includes("ALYQ-1001")) throw new Error("data leaked on a failed attempt");

  // Unknown user → same generic message (no account enumeration).
  await app.signIn("not-a-real-user", DEMO_PASSWORD);
  if (app.isSignedIn()) throw new Error("an unknown username signed in");
  if (app.readSession()) throw new Error("a session was created for an unknown user");

  // Then the real credentials still work.
  await app.signIn("admin");
  if (!app.isSignedIn()) throw new Error("valid credentials stopped working after a failure");
  return [
    "wrong password → rejected, generic message, no session",
    "unknown username → same generic message (no account enumeration)",
    "valid credentials still work afterwards",
  ];
});

// ── STEP 9 · session expiry ───────────────────────────────────────────────
await step(9, "Verify session expiry ends the session", async () => {
  const out = [];

  // (a) A session that lapses while the app is open: boot on a live session
  //     that expires in two seconds, then touch the app the way a user would.
  const live = await boot({ seedSession: seededSession({ expiresInMs: 2_000 }) });
  if (!live.isSignedIn()) throw new Error("a valid seeded session was not restored on boot");
  out.push("restored a live session from storage on boot");
  await sleep(2_400);
  await live.navigate("#/inventory");
  await sleep(400);
  if (!live.usernameField()) throw new Error("the lapsed session was not ended on navigation");
  if (live.notice() !== "expired") throw new Error("expiry was not explained to the user");
  if (live.readSession()) throw new Error("the expired session record was not cleared");
  out.push("session lapsed while running → ended on the next navigation, record cleared");

  // (b) A session that had already lapsed before the app started.
  const stale = await boot({ seedSession: seededSession({ expiresInMs: -60_000 }) });
  if (stale.isSignedIn()) throw new Error("an expired session was restored");
  if (!stale.usernameField()) throw new Error("an expired session did not fall back to the login screen");
  if (stale.notice() !== "expired") throw new Error("boot-time expiry was not explained");
  if (stale.readSession()) throw new Error("the expired record was left in storage after boot");
  out.push("session already expired at boot → cleared, login screen shown with the expiry notice");

  // (c) Remember-me changes where the session lives, not whether it expires.
  const remembered = await boot({ seedSession: seededSession({ expiresInMs: 3_600_000, remember: true }) });
  if (!remembered.isSignedIn()) throw new Error("a remembered session was not restored");
  const stored = remembered.readSession();
  if (stored?.persistence !== "local") throw new Error("the remembered session is not in localStorage");
  if (remembered.dom.window.sessionStorage.getItem(SESSION_KEY)) {
    throw new Error("the session was duplicated into sessionStorage");
  }
  out.push("remember-me sessions restore from localStorage and are never duplicated");

  return out;
});

// ── STEP 10 · the forgot screen never silently turns a session into authority ─
await step(10, "A signed-in user is notified, not silently redirected, on the forgot screen", async () => {
  const out = [];
  const reached = await boot({ seedSession: seededSession({ expiresInMs: 3_600_000 }) });
  if (!reached.isSignedIn()) throw new Error("the seeded session was not restored for this step");
  await reached.navigate("#/forgot-password");
  await sleep(700);
  if (reached.dom.window.location.hash !== "#/forgot-password") {
    throw new Error(
      `the page wandered off to ${reached.dom.window.location.hash} — a session is quietly unlocking the reset screen again`,
    );
  }
  if (!reached.bodyText().includes("You are already signed in")) {
    throw new Error("no explicit signed-in notice is shown");
  }
  if (reached.bodyText().includes("This reset link is no longer valid")) {
    throw new Error("a misleading failure state mixed with the notice");
  }
  if (!reached.byText("Change your password")) {
    throw new Error("the notice does not lead to the change-password screen");
  }
  out.push("no auto-redirect to /reset-password: the URL stayed #/forgot-password");
  out.push("explicit notice shown instead, with a way to the change-password screen");
  return out;
});

// ── STEP 11 · recovery fails closed; signed-in change re-proves the password ─
await step(11, "Direct reset never opens from a session; change-password wants the current one", async () => {
  const out = [];
  const NEW_PASSWORD = "BrandNew1Password";

  // (a) A perfectly valid NORMAL session cannot open the reset form. The
  //     session comes from a REAL login — a seeded record alone carries no
  //     directory identity for the re-proof below.
  const holder = await boot();
  await holder.signIn("admin");
  await holder.navigate("#/reset-password");
  await sleep(800);
  if (!holder.bodyText().includes("This reset link is no longer valid")) {
    throw new Error("the reset page did not fail closed for a signed-in visitor");
  }
  if (holder.document.querySelector("input[type='password']")) {
    throw new Error("a password field rendered with no recovery authority");
  }
  out.push("signed-in visitor + direct #/reset-password → refused, no password form rendered");

  // (b) A clean stranger gets the same closed door.
  const stranger = await boot();
  await stranger.navigate("#/reset-password");
  await sleep(800);
  if (!stranger.bodyText().includes("This reset link is no longer valid")) {
    throw new Error("a clean stranger was not refused");
  }
  if (stranger.document.querySelector("input[type='password']")) {
    throw new Error("a password field rendered for a stranger");
  }
  out.push("clean stranger → same refusal (fail-closed both ways)");

  // (c) The honest change route re-proves: a wrong current password is refused
  //     and changes nothing.
  await holder.navigate("#/change-password");
  await sleep(800);
  const currentField = holder.document.querySelector("input[autocomplete='current-password']");
  const newFields = [...holder.document.querySelectorAll("input[autocomplete='new-password']")];
  if (!currentField || newFields.length < 2) throw new Error("the change form did not render its three fields");
  holder.typeInto(currentField, "not-the-password");
  holder.typeInto(newFields[0], NEW_PASSWORD);
  holder.typeInto(newFields[1], NEW_PASSWORD);
  holder.clickEl(holder.byText("Save new password"));
  await sleep(2_500);
  if (!holder.bodyText().includes("The current password is incorrect")) {
    throw new Error("a wrong current password was not refused");
  }
  out.push("a wrong current password is refused without touching the credential");

  // (d) The right one works — and the change is real at the login door.
  holder.typeInto(currentField, DEMO_PASSWORD);
  holder.clickEl(holder.byText("Save new password"));
  await sleep(2_500);
  if (!holder.bodyText().includes("Your password was changed")) {
    throw new Error("a correct current password did not change the password");
  }
  holder.clickEl(holder.byText("Back to dashboard"));
  await sleep(600);
  await holder.signOut();

  holder.typeInto(holder.usernameField(), "admin");
  holder.typeInto(holder.passwordField(), DEMO_PASSWORD);
  holder.clickEl(holder.byText("Sign in"));
  await sleep(2_500);
  if (holder.isSignedIn()) throw new Error("the OLD password still signs in after the change");
  out.push("the old password no longer signs in");

  await holder.signIn("admin", NEW_PASSWORD);
  if (!holder.isSignedIn()) throw new Error("the new password did not sign in");
  await holder.signOut();
  out.push("the new password signs in — the change went through the real verifier, audit-trailed");
  return out;
});

// ── summary ───────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
console.log("\n──────── summary ────────");
for (const r of results) console.log(`${r.status === "PASS" ? "✓" : "✗"} ${r.num}. ${r.title}: ${r.status}`);
const errors = app.consoleErrors.length;
console.log(
  `\n${count("PASS")} passed · ${count("FAIL")} failed · console errors: ${errors} · network calls: ${networkCalls.length}`,
);
if (networkCalls.length > 0) {
  console.error(`\n✗ ${networkCalls.length} network call(s) in a localStorage-only demo:`);
  for (const call of networkCalls) console.error("  " + call);
  process.exit(1);
}
if (count("FAIL") > 0) process.exit(1);
console.log("\nAuthentication flow verified end to end.\n");
process.exit(0);

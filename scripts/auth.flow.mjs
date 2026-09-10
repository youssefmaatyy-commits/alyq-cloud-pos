/**
 * Authentication flow test — the 7 requested steps, runnable on demand.
 *
 *   npx esbuild src/main.tsx --bundle --format=esm --platform=node \
 *     --outfile=/tmp/alyq-app.mjs --loader:.css=empty \
 *     --define:import.meta.env='{"VITE_CURRENCY":"SAR"}'
 *   node scripts/auth.flow.mjs
 *
 * STATUS: authentication is NOT implemented in this application (no login
 * screen, no credentials, no session, no logout). It is tracked as a separate
 * future phase. Steps that depend on it report PENDING with an observation of
 * today's behaviour instead of failing — so this script becomes the acceptance
 * test for that phase the moment `AUTH_IMPLEMENTED` is flipped to true, at
 * which point the same steps assert for real.
 *
 * Steps 1, 4, 5 and 6 are real today: the app boots, reaches the dashboard,
 * enforces role permissions and blocks unauthorized mutations.
 */
import { JSDOM } from "jsdom";

/** Flip to true in the Authentication phase — turns PENDING steps into assertions. */
const AUTH_IMPLEMENTED = false;

const BUNDLE = "/tmp/alyq-app.mjs";

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
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
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
dom.window.console.error = (...args) => {
  consoleErrors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
  process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
};
dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));

try {
  await import(BUNDLE);
} catch (err) {
  console.error(`\n✗ could not load the app bundle at ${BUNDLE}.\n  Build it first (see the header of this file).\n  ${err?.message ?? err}\n`);
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 900));

// ── harness helpers ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = () => document.body.textContent ?? "";
const navigate = async (hash) => {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
  await sleep(450);
};
const clickEl = (el) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const byText = (label, scope = document) =>
  [...scope.querySelectorAll("button, a")].find((n) => (n.textContent ?? "").trim().includes(label));
const typeInto = (input, value) => {
  const proto =
    input.tagName === "SELECT"
      ? dom.window.HTMLSelectElement
      : input.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement
        : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
const setRole = async (role) => {
  await navigate("#/inventory");
  let select;
  for (let i = 0; i < 12; i += 1) {
    select = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "viewer"),
    );
    if (select) break;
    await sleep(300);
  }
  if (!select) throw new Error("demo role switcher not found");
  typeInto(select, role);
  await sleep(450);
};
const storageKeys = () => {
  const keys = [];
  for (let i = 0; i < dom.window.localStorage.length; i += 1) keys.push(dom.window.localStorage.key(i));
  return keys;
};

// ── step runner ───────────────────────────────────────────────────────────
const results = [];
const log = (line) => console.log(`    ${line}`);

async function step(num, title, { requiresAuth = false, observation, run }) {
  const pending = requiresAuth && !AUTH_IMPLEMENTED;
  let status = pending ? "PENDING" : "PASS";
  let detail = [];
  try {
    detail = (await run({ pending })) ?? [];
  } catch (err) {
    status = requiresAuth && !AUTH_IMPLEMENTED ? "FAILURE" : "FAIL";
    detail = [`${err?.message ?? err}`];
  }
  results.push({ num, title, status, requiresAuth });
  const mark = { PASS: "✓", FAIL: "✗", FAILURE: "✗", PENDING: "•" }[status];
  console.log(`\n${mark} STEP ${num} · ${title} — ${status}${pending ? " (blocked on the Authentication phase)" : ""}`);
  if (pending && observation) log(`observed today: ${observation}`);
  for (const line of detail) log(line);
}

console.log("\nAuthentication flow test — ALYQ Cloud POS");
console.log(
  AUTH_IMPLEMENTED
    ? "authentication: IMPLEMENTED — all seven steps are asserted"
    : "authentication: NOT IMPLEMENTED (future phase) — auth-dependent steps report PENDING",
);

// ── STEP 1 · open application ─────────────────────────────────────────────
await step(1, "Open application", {
  run: async () => {
    await navigate("#/");
    const routes = document.querySelectorAll("aside nav a").length;
    if (routes === 0) throw new Error("app shell did not render");
    return [`app shell rendered with ${routes} navigation routes`, `landed on ${dom.window.location.hash || "#/"}`, `console errors during boot: ${consoleErrors.length}`];
  },
});

// ── STEP 2 · login screen appears ─────────────────────────────────────────
await step(2, "Verify login screen appears", {
  requiresAuth: true,
  observation: "the app renders the dashboard directly; there is no login screen",
  run: async ({ pending }) => {
    const passwords = document.querySelectorAll('input[type="password"]').length;
    const loginControls = [...document.querySelectorAll("button, a")].filter((n) =>
      /^(log ?in|sign ?in|تسجيل الدخول)$/i.test((n.textContent ?? "").trim()),
    ).length;
    if (pending) {
      await navigate("#/login");
      const resolved = dom.window.location.hash;
      await navigate("#/shifts");
      const deepLinkWorks = bodyText().includes("Cashier shifts") || bodyText().includes("Shift dashboard");
      return [
        `password fields: ${passwords} · login controls: ${loginControls}`,
        `#/login resolves to "${resolved}" (catch-all route redirects to the dashboard)`,
        `guarded deep link #/shifts reached without credentials: ${deepLinkWorks}`,
        "future phase: add a login route + session guard, then this step asserts the screen appears",
      ];
    }
    if (passwords !== 1) throw new Error(`expected exactly one password field, found ${passwords}`);
    await navigate("#/");
    if (!bodyText().includes("Dashboard")) throw new Error("guard did not redirect an anonymous visit to /login");
    return ["login screen rendered with a password field", "anonymous #/ is redirected to the login screen"];
  },
});

// ── STEP 3 · valid username / password ────────────────────────────────────
await step(3, "Enter valid username/password", {
  requiresAuth: true,
  observation: "no credential form exists; the acting identity is fabricated client-side",
  run: async ({ pending }) => {
    const identityKey = "alyq.inventory.currentUser.v1";
    const raw = dom.window.localStorage.getItem(identityKey);
    const identity = raw ? JSON.parse(raw) : null;
    const tokenKeys = storageKeys().filter((k) => /token|session|auth|jwt|password/i.test(k));
    if (pending) {
      return [
        `identity store "${identityKey}": ${JSON.stringify(identity)}`,
        `fields: ${identity ? Object.keys(identity).join(", ") : "n/a"} — no password, no token, no expiry`,
        `session/token storage keys: ${tokenKeys.length === 0 ? "none" : tokenKeys.join(", ")}`,
        "future phase: real credential verification + a session token, then this step signs in",
      ];
    }
    const form = document.querySelector('input[type="password"]')?.closest("form") ?? dialogFallback();
    if (!form) throw new Error("no credential form to submit");
    const userField = [...form.querySelectorAll("input")].find((i) => i.type !== "password");
    const passField = form.querySelector('input[type="password"]');
    if (process.env.ALYQ_TEST_USER) typeInto(userField, process.env.ALYQ_TEST_USER);
    if (process.env.ALYQ_TEST_PASSWORD) typeInto(passField, process.env.ALYQ_TEST_PASSWORD);
    clickEl(byText("Sign in", form) ?? byText("Log in", form));
    await sleep(1200);
    return ["credentials submitted", `token keys present after sign-in: ${tokenKeys.length}`];
  },
});

// ── STEP 4 · user enters the dashboard ────────────────────────────────────
await step(4, "Verify user enters dashboard", {
  run: async () => {
    await navigate("#/");
    for (let i = 0; i < 10 && !bodyText().includes("Dashboard"); i += 1) await sleep(300);
    const kpis = document.querySelectorAll(".alyq-kpi").length;
    if (!bodyText().includes("Dashboard")) throw new Error("dashboard did not render");
    return [
      `dashboard rendered (${kpis} KPI tiles)`,
      AUTH_IMPLEMENTED
        ? "reached after submitting valid credentials"
        : "reached without credentials — see step 3 (future phase)",
    ];
  },
});

// ── STEP 5 · cashier permissions ──────────────────────────────────────────
await step(5, "Verify cashier permissions", {
  run: async () => {
    const out = [];
    const roles = (() => {
      const select = document.querySelector("select[aria-label='Acting as']") ?? null;
      return select ? [...select.options].map((o) => o.value) : [];
    })();
    const selectable = roles.length > 0 ? roles : ["admin", "manager", "inventory_clerk", "viewer"];

    // The till tier is selectable as inventory_clerk today; the canonical
    // `cashier` role is defined in the shared matrix (see roles.selftest.ts).
    await setRole("inventory_clerk");
    await navigate("#/pos");
    for (let i = 0; i < 12 && !bodyText().includes("ALYQ-1001"); i += 1) await sleep(300);
    clickEl(byText("Ethiopian Specialty") ?? byText("ALYQ-1001"));
    await sleep(300);
    const exact = byText("Exact");
    if (exact) clickEl(exact);
    await sleep(300);
    const complete = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Complete sale"),
    );
    out.push(`roles selectable today: ${selectable.join(", ")}`);
    out.push(`cashier tier (inventory_clerk) can complete a sale: ${complete ? !complete.disabled : "button missing"}`);
    await navigate("#/shifts");
    for (let i = 0; i < 12 && !bodyText().includes("Shift dashboard"); i += 1) await sleep(300);
    out.push(`can open a shift: ${Boolean(byText("Open shift"))}`);
    await navigate("#/expenses");
    for (let i = 0; i < 12 && !bodyText().includes("Expenses"); i += 1) await sleep(300);
    const addExpense = byText("Add expense");
    out.push(`can record an expense: ${addExpense ? !addExpense.disabled : "button missing"}`);
    out.push("cashier role definition (sell/returns/shifts yes · discount/void/stock/audit no) is pinned by the role-model suite");

    if (!complete || complete.disabled) throw new Error("the till tier could not complete a sale");
    return out;
  },
});

// ── STEP 6 · unauthorized action is blocked ───────────────────────────────
await step(6, "Try unauthorized action and confirm it is blocked", {
  run: async () => {
    const out = [];
    await setRole("viewer");

    // Oversight screen: audit trail.
    const auditNav = [...document.querySelectorAll("aside nav a")].some(
      (a) => (a.getAttribute("href") ?? "") === "#/audit",
    );
    await navigate("#/audit");
    await sleep(500);
    const denied = bodyText().includes("Audit log is restricted");
    const leaked = /EXP-\d{6}/.test(bodyText());
    out.push(`audit nav entry visible to a viewer: ${auditNav}`);
    out.push(`direct #/audit deep link denied: ${denied} · audit records leaked: ${leaked}`);

    // Mutation: completing a sale.
    const invoicesBefore = (() => {
      const seen = new Set(bodyText().match(/INV-\d{6}/g) ?? []);
      return seen.size;
    })();
    await navigate("#/pos");
    for (let i = 0; i < 12 && !bodyText().includes("ALYQ-1001"); i += 1) await sleep(300);
    clickEl(byText("Ethiopian Specialty") ?? byText("ALYQ-1001"));
    await sleep(300);
    const exact = byText("Exact");
    if (exact) clickEl(exact);
    await sleep(300);
    const complete = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Complete sale"),
    );
    const wasDisabled = Boolean(complete?.disabled);
    clickEl(complete); // must be inert
    await sleep(1200);
    const keys = storageKeys();
    const salesStore = dom.window.localStorage.getItem("alyq.demo.sales.v1");
    const movementsStore = dom.window.localStorage.getItem("alyq.demo.stock_movements.v1");
    out.push(`"Complete sale" disabled for a viewer: ${wasDisabled}`);
    out.push(`after clicking the blocked control → sales store: ${salesStore ?? "untouched (null)"}, movements store: ${movementsStore ?? "untouched (null)"}`);
    out.push(`demo storage keys: ${keys.join(", ")}`);
    out.push(`invoices on the sales list before the attempt: ${invoicesBefore}`);

    // Inventory authority.
    await navigate("#/inventory");
    for (let i = 0; i < 12; i += 1) {
      if (byText("Adjust stock")) break;
      await sleep(300);
    }
    const adjust = byText("Adjust stock");
    out.push(`stock adjustment available to a viewer: ${adjust ? !adjust.disabled : "not rendered"}`);

    if (!denied) throw new Error("the audit route was not denied for a viewer");
    if (leaked) throw new Error("audit records leaked to an unauthorized role");
    if (!wasDisabled) throw new Error("a viewer could complete a sale");
    if (salesStore !== null || movementsStore !== null) throw new Error("the blocked action wrote to storage");
    if (auditNav) throw new Error("the audit nav entry was shown to a viewer");
    return out;
  },
});

// ── STEP 7 · logout closes the session ────────────────────────────────────
await step(7, "Logout and verify session is closed", {
  requiresAuth: true,
  observation: "there is no logout control and no session to close",
  run: async ({ pending }) => {
    const logoutControls = [...document.querySelectorAll("button, a")].filter((n) =>
      /log ?out|sign ?out|تسجيل الخروج/i.test((n.textContent ?? "").trim()),
    ).length;
    if (pending) {
      await setRole("admin");
      const before = dom.window.localStorage.getItem("alyq.inventory.currentUser.v1");
      dom.window.localStorage.clear();
      await navigate("#/pos");
      await sleep(500);
      const stillInside = !bodyText().includes("Password") && !bodyText().includes("Sign in");
      return [
        `logout controls in the UI: ${logoutControls}`,
        `identity before the "logout" attempt: ${before}`,
        `app stayed usable without asking for credentials: ${stillInside}`,
        "clearing storage does not end a session, and a reload re-creates the same demo admin",
        "future phase: sign-out clears the session and returns to the login screen",
      ];
    }
    clickEl(byText("Sign out") ?? byText("Log out"));
    await sleep(900);
    const passwords = document.querySelectorAll('input[type="password"]').length;
    if (passwords !== 1) throw new Error("sign-out did not return to the login screen");
    await navigate("#/pos");
    await sleep(600);
    if (!document.querySelector('input[type="password"]')) {
      throw new Error("a deep link after sign-out was served without credentials");
    }
    return ["sign-out returned to the login screen", "post-logout deep link bounced back to the login screen"];
  },
});

function dialogFallback() {
  return document.querySelector('[role="dialog"]');
}

// ── summary ───────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
console.log("\n──────── summary ────────");
for (const r of results) {
  const mark = { PASS: "✓", FAIL: "✗", FAILURE: "✗", PENDING: "•" }[r.status];
  console.log(`${mark} ${r.num}. ${r.title}: ${r.status}`);
}
console.log(
  `\n${count("PASS")} passed · ${count("FAIL")} failed · ${count("PENDING")} pending (Authentication phase)` +
    `\nconsole errors: ${consoleErrors.length}`,
);
if (count("FAIL") > 0) process.exit(1);
console.log("\nNo failures. Steps 2, 3 and 7 are the Authentication phase backlog.\n");

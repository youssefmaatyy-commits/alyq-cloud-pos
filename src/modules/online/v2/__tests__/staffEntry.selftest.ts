/**
 * The hidden staff entrance — logic and structure.
 *
 * The behavioural half pins the matcher: the exact word `logpos`, trimmed and
 * case-insensitive, arms the entrance, and nothing else does. A near-miss, a
 * longer query that merely contains the word, or any ordinary product search
 * must leave the shop's search — and its results — completely alone.
 *
 * The structural half is what fails if someone re-advertises the door: the
 * option must stay rendered only while the keyword is typed, it must open the
 * app's real `/login` route rather than a screen of its own, and it must not
 * reach into authentication at all. The last one matters most: an entrance that
 * called `signIn`, wrote a session or skipped `RequireAuth` would be an
 * authentication bypass, and this suite refuses that in source.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { isStaffEntryQuery, STAFF_ENTRY_KEYWORD, STAFF_ENTRY_ROUTE } from "../staffEntry";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/App.tsx"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}
const ROOT = repoRoot();
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

// ── the constants are what the shop and the router agree on ────────────────
test("the activation word is exactly logpos", () => {
  assert.equal(STAFF_ENTRY_KEYWORD, "logpos");
});

test("the entrance opens the public staff login route, not a protected screen", () => {
  assert.equal(STAFF_ENTRY_ROUTE, "/login");
  const app = read("src/App.tsx");
  // /login is routed to LoginRoute — the real sign-in screen, public by design
  // (a person who has no session yet is exactly who needs it).
  assert.ok(app.includes('<Route path="/login" element={<LoginRoute />} />'),
    "src/App.tsx no longer routes /login — the entrance would land on a 404");
  // …and every protected screen still sits behind RequireAuth, so reaching the
  // door grants nothing on its own.
  assert.ok(app.includes('<Route path="/dashboard/*" element={<AuthenticatedApp />} />'),
    "/dashboard must stay behind AuthenticatedApp (RequireAuth)");
  assert.ok(/function AuthenticatedApp\(\)[\s\S]{0,80}?<RequireAuth>/.test(app),
    "RequireAuth no longer wraps the authenticated app — the entrance would be a bypass");
});

// ── the matcher ───────────────────────────────────────────────────────────
test("only the whole, exact query arms the entrance", () => {
  for (const query of ["logpos", " logpos", "logpos ", "  logpos  ", "\tlogpos\n",
    "Logpos", "LOGPOS", "LoGpOs"]) {
    assert.equal(isStaffEntryQuery(query), true, JSON.stringify(query));
  }
});

test("anything else leaves the shop's search alone", () => {
  for (const query of ["", "   ", "logpo", "logposx", "logpos1", "xlogpos", "log pos",
    "logpos ring", "logpos ring 18", "ring", "search logpos", "logpos&admin",
    "logpos#/dashboard", "log", "pos", "l0gpos", "logposss"]) {
    assert.equal(isStaffEntryQuery(query), false, JSON.stringify(query));
  }
});

test("a missing or non-string query is survived, not thrown", () => {
  for (const query of [null, undefined, 42, {}, [], true]) {
    assert.equal(isStaffEntryQuery(query as unknown as string), false, String(query));
  }
});

// ── structure: still hidden, still the real login, still no bypass ────────
test("both V2 search surfaces render the entrance only while armed", () => {
  for (const file of ["src/modules/online/v2/StorefrontV2Shell.tsx",
    "src/modules/online/v2/StorefrontV2Catalog.tsx"]) {
    const source = read(file);
    assert.ok(source.includes('from "./staffEntry"'),
      `${file} no longer reads the keyword module`);
    assert.ok(source.includes('from "./StaffEntryOption"'),
      `${file} no longer renders the staff entrance`);
    assert.ok(source.includes("const staffEntryArmed = isStaffEntryQuery(search);"),
      `${file} no longer derives the armed state from the query`);
    // The gate: the option must be conditional on the armed state, never on a
    // permanent flag. `appearance.showSearch && searchOpen && staffEntryArmed`
    // in the shell and `{staffEntryArmed ? …}` in the catalogue.
    assert.ok(/staffEntryArmed\s*\?/.test(source) || /&&\s*staffEntryArmed/.test(source),
      `${file} renders the entrance without testing whether it is armed`);
  }
});

test("Enter on the keyword goes to the login route, not to a product search", () => {
  const shell = read("src/modules/online/v2/StorefrontV2Shell.tsx");
  assert.ok(/if \(staffEntryArmed\) \{ navigate\(STAFF_ENTRY_ROUTE\); return; \}/.test(shell),
    "the header search no longer sends Enter on the keyword to the staff login");
  assert.ok(shell.indexOf("navigate(STAFF_ENTRY_ROUTE)") < shell.indexOf("navigate(`/store/products"),
    "the staff login must win over the product search when the keyword is typed");
  const catalog = read("src/modules/online/v2/StorefrontV2Catalog.tsx");
  assert.ok(/if \(staffEntryArmed\) \{ navigate\(STAFF_ENTRY_ROUTE\); return; \}/.test(catalog),
    "the catalogue search no longer sends Enter on the keyword to the staff login");
});

test("the revealed option navigates internally, with no new tab and no reload", () => {
  const component = read("src/modules/online/v2/StaffEntryOption.tsx");
  assert.ok(component.includes("useNavigate()"), "the option no longer uses the router");
  assert.ok(component.includes("navigate(STAFF_ENTRY_ROUTE)"), "the option no longer opens /login");
  assert.ok(!/window\.open/.test(component), "a popup can be swallowed on a floor phone — navigate in-app");
  assert.ok(!/location\.assign|location\.href|location\.replace/.test(component),
    "the option must not reload the frame; the hash router owns navigation");
  assert.ok(!/target=/.test(component), "the option must not be an anchor to a new tab");
  // A real <button> is what makes tap, click and keyboard agree on every device.
  assert.ok(/<button type="button"/.test(component), "the option must be a button element");
});

test("the entrance never touches authentication, sessions or permissions", () => {
  const component = read("src/modules/online/v2/StaffEntryOption.tsx");
  const logic = read("src/modules/online/v2/staffEntry.ts");
  for (const source of [component, logic]) {
    for (const forbidden of ["signIn", "signOut", "authService", "AuthProvider", "useAuth",
      "sessionStore", "password", "access_token", "refresh_token", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden),
        `the staff entrance must not reference ${forbidden} — it is a link, not a login path`);
    }
  }
  // And it grants no capability of its own: no route in the app's capability
  // table is added or widened for it.
  const routes = read("src/lib/permissions/routes.ts");
  assert.ok(!routes.includes("staffEntry"), "no permission entry may be added for the entrance");
});

test("the shop advertises nothing: no permanent control, no link, no testid leak", () => {
  for (const file of ["src/modules/online/v2/StorefrontV2Shell.tsx",
    "src/modules/online/v2/StorefrontV2Catalog.tsx"]) {
    const source = read(file);
    // The keyword itself must never appear as visible copy or a URL a crawler
    // or a shopper could find.
    assert.ok(!source.includes("logpos"), `${file} hardcodes the keyword instead of reading the module`);
    assert.ok(!/href="#\/login"|to="\/login"/.test(source),
      `${file} carries a permanent link to the staff sign-in`);
  }
  const css = read("src/modules/online/v2/storefront-v2.css");
  assert.ok(!css.includes("logpos"), "the stylesheet must not advertise the keyword");
});

test("the shop's own palette carries the option — gold accent, ivory surface", () => {
  const css = read("src/modules/online/v2/storefront-v2.css");
  // Only this feature's own rules — the rest of the sheet legitimately carries
  // the shop's configured colours.
  const from = css.indexOf(".store-v2 .v2-staff-entry");
  assert.ok(from >= 0, "the staff entrance has no styles of its own");
  const nextSection = css.indexOf("\n\n/*", from);
  const rules = css.slice(from, nextSection < 0 ? css.length : nextSection);
  assert.ok(rules.includes("--v2-header-accent-text"),
    "the option must use the shop's configured gold accent, not a new colour");
  assert.ok(rules.includes("--v2-accent-text"), "the catalogue variant must use the shop's gold accent");
  assert.ok(rules.includes("--v2-card-radius"), "the option must keep the shop's own corner radius");
  assert.ok(rules.includes("--v2-surface") || rules.includes("transparent"),
    "the option must sit on the shop's own surface rather than a new one");
  // No second design language: no hardcoded hex of its own.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(rules), "the option introduces a hardcoded colour of its own");
  // Touch targets on a phone are not optional.
  assert.ok(/min-height:\s*48px/.test(rules), "the option must keep a 48px touch target");
});

test("both languages carry the option's label and its hint", () => {
  const dict = read("src/lib/i18n/dictionary.ts");
  for (const key of ["store.v2.staffEntry", "store.v2.staffEntryHint"]) {
    const hits = dict.split(`"${key}":`).length - 1;
    assert.equal(hits, 2, `"${key}" must exist exactly once per language, found ${hits}`);
  }
  assert.ok(dict.includes('"store.v2.staffEntry": "Enter ALYQ POS"'), "the English label is missing");
  assert.ok(dict.includes('"store.v2.staffEntry": "دخول نظام ALYQ POS"'), "the Arabic label is missing");
});

test("the search fields keep the keyword typeable on a phone keyboard", () => {
  // iPhone and Android autocorrect/autocapitalise by default; without these the
  // word arrives as "Logpos" or "log pos" and the cashier sees nothing.
  for (const file of ["src/modules/online/v2/StorefrontV2Shell.tsx",
    "src/modules/online/v2/StorefrontV2Catalog.tsx"]) {
    const source = read(file);
    assert.ok(source.includes('autoCapitalize="none"'), `${file} lets a phone capitalise the word`);
    assert.ok(source.includes('autoCorrect="off"'), `${file} lets a phone rewrite the word`);
  }
});

// ── runner ─────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}
console.log("");
if (failed > 0) {
  console.error(`${failed}/${tests.length} hidden staff entrance tests FAILED.`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} hidden staff entrance checks hold.`);

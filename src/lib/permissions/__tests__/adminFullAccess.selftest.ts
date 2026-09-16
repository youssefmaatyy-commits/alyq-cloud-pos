/**
 * Admin full-permission audit — the standing answer to one question:
 *
 *   **Does the `admin` role pass every permission decision point in the app?**
 *
 * "The admin can do everything" is a promise an installation buys the role for,
 * so it is proven here at every layer that can say no, not assumed from the
 * matrix:
 *
 *   1. **The matrix** — admin holds every capability, is a strict superset of
 *      every other role, and the admin-only set is exactly the four oversight
 *      acts plus the two backup acts (nothing more, nothing less).
 *   2. **The routes** — admin passes every entry of the route table and every
 *      screen path the app registers, so no URL lands an admin on a denial.
 *   3. **Every gate call site** — the suite scans `src/` for the capability
 *      literal each gate asks about (`assertCapability`, `canAct`, `canActAs`,
 *      `userCan`, `hasCapability`, `canActAny`, the route table) and asserts the
 *      union is real capabilities admin holds. A future gate on a capability
 *      admin could lack — or a typo of a capability id — fails this suite.
 *   4. **The role lists** — the few gates still phrased as role lists all
 *      include admin.
 *   5. **The action register** — every sensitive action's capability is held by
 *      admin, and nothing in the register names an unknown capability.
 *   6. **The demo installation** — the offline admin account exists and
 *      resolves to every capability; the aliases that map onto admin (`owner`,
 *      `superadmin`, …) resolve to the same full set, so an account that reads
 *      as "admin" from any source is answered identically.
 *
 * What this suite deliberately does not claim:
 *
 *   · **A person's own denials still bind admin.** Exceptions belong to the
 *     person, not the role (Phase 17): an admin who has been denied `sell`
 *     cannot sell. The promise is about the *role*, and the database says the
 *     same thing (`public.can()`, deny first).
 *   · **An overlay is absolute.** A system admin wearing an active custom role
 *     is governed by that role's list, by design. The audit pins what a *bare*
 *     admin holds; the overlay arithmetic is the access-control suite's.
 *
 * The database half of the same audit — `public.can()` answering true for
 * every capability as the admin profile, and the admin RPCs accepting the
 * admin caller — lives in `supabase/tests/scenarios.sql` (the administrator's
 * authority block), run by `npm run db:check`.
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs adminFullAccess`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  APP_ROLES,
  CAPABILITIES,
  capabilitiesOf,
  hasCapability,
  normalizeRole,
  rolesWithCapability,
  type AppRole,
  type Capability,
} from "../roles";
import { ROUTE_CAPABILITIES, capabilityForPath } from "../routes";
import { capabilitiesOfUser, userCan } from "../enforce";
import { SENSITIVE_ACTIONS } from "../actions";
import { resolveCapabilities } from "../customRoles";
import { NO_EXCEPTIONS } from "../exceptions";
import { DEMO_USERS } from "@/lib/auth/demoUsers";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── scanning src/ for the gate call sites ────────────────────────────────────

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "src/lib/permissions/actions.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cannot locate the repository root");
}

const SOURCE_CACHE = new Map<string, string>();
/**
 * The application's own source: test files are excluded because fixtures
 * legitimately hand the gates names like `not_a_capability` to prove they
 * refuse — a fixture is a test of a gate, not a gate itself.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(repoRoot(), "src"));
  return out;
}

function sourceBody(file: string): string {
  let body = SOURCE_CACHE.get(file);
  if (body === undefined) {
    body = fs.readFileSync(file, "utf8");
    SOURCE_CACHE.set(file, body);
  }
  return body;
}

/**
 * Every capability id a gate in the app asks about, with where it is asked.
 * The patterns are the five gate helpers plus the route-table row shape; the
 * route table's `["/path", "capability"]` rows are picked up separately so a
 * path that exists only in the table is still covered.
 */
function gateCapabilitySites(): { capability: string; file: string; kind: string }[] {
  const sites: { capability: string; file: string; kind: string }[] = [];
  const helpers: Array<[RegExp, string]> = [
    [/\bassertCapability\(\s*["'`]([a-z_]+)["'`]/g, "assertCapability"],
    [/\bcanAct\(\s*["'`]([a-z_]+)["'`]/g, "canAct"],
    [/\bcanActAs\([^)]*?,\s*["'`]([a-z_]+)["'`]/g, "canActAs"],
    [/\buserCan\([^)]*?,\s*["'`]([a-z_]+)["'`]/g, "userCan"],
    [/\bhasCapability\(\s*[^,]+,\s*["'`]([a-z_]+)["'`]/g, "hasCapability"],
  ];
  for (const file of sourceFiles()) {
    // This file defines the helpers; its signature lines mention capability
    // names in comments and types, so scan the bodies it actually ships.
    if (file.endsWith("lib/permissions/enforce.ts")) continue;
    const body = sourceBody(file);
    const rel = path.relative(repoRoot(), file);
    for (const [re, kind] of helpers) {
      for (const m of body.matchAll(re)) sites.push({ capability: m[1], file: rel, kind });
    }
    for (const m of body.matchAll(/\bcanActAny\(\s*\[([^\]]*)\]/g)) {
      for (const c of m[1].matchAll(/["'`]([a-z_]+)["'`]/g)) {
        sites.push({ capability: c[1], file: rel, kind: "canActAny" });
      }
    }
    // The `["/path", "capability"]` row shape only means a capability in the
    // route table itself — the same shape elsewhere is a fixture, a table name
    // or a status pair.
    if (rel.endsWith("lib/permissions/routes.ts")) {
      for (const m of body.matchAll(/\[\s*"[^"]+"\s*,\s*"([a-z_]+)"\s*\]/g)) {
        sites.push({ capability: m[1], file: rel, kind: "routeTable" });
      }
    }
  }
  return sites;
}

/** Exported `…ROLES` constants — the gates still phrased as role lists. */
function exportedRoleLists(): { name: string; file: string; roles: string[] }[] {
  const lists: { name: string; file: string; roles: string[] }[] = [];
  for (const file of sourceFiles()) {
    const body = sourceBody(file);
    for (const m of body.matchAll(/export const ([A-Z][A-Z0-9_]*ROLES[A-Z0-9_]*)\s*=\s*\[([^\]]*)\]/g)) {
      const roles = [...m[2].matchAll(/["'`]([a-z_]+)["'`]/g)].map((x) => x[1]);
      if (roles.length > 0) lists.push({ name: m[1], file: path.relative(repoRoot(), file), roles });
    }
  }
  return lists;
}

// ── the audit ────────────────────────────────────────────────────────────────

const ALL_PATHS = [
  "/",
  "/products",
  "/products/new",
  "/categories",
  "/inventory",
  "/inventory/movements",
  "/pos",
  "/pos/sales",
  "/customers",
  "/returns",
  "/refunds",
  "/shifts",
  "/shifts/history",
  "/expenses",
  "/approvals",
  "/reports",
  "/reports/advanced",
  "/online/orders",
  "/online/reservations",
  "/online/website",
  "/online/marketing",
  "/online/content",
  "/online/reports",
  "/audit",
  "/settings",
  "/settings/users",
  "/settings/roles",
  "/settings/approvals",
  "/settings/backup",
] as const;

test("the matrix is total for admin: every capability, no duplicates, none orphaned", () => {
  const admin = capabilitiesOf("admin");
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length, "capability ids are unique");
  for (const capability of CAPABILITIES) {
    assert.ok(admin.includes(capability), `admin must hold ${capability}`);
  }
  for (const capability of CAPABILITIES) {
    assert.ok(rolesWithCapability(capability).length > 0, `${capability} is held by no role`);
  }
});

test("admin is a superset of every other role, and the admin-only set is exact", () => {
  const admin = new Set(capabilitiesOf("admin"));
  for (const role of APP_ROLES) {
    for (const capability of capabilitiesOf(role)) {
      assert.ok(admin.has(capability), `admin must hold everything ${role} holds (${capability})`);
    }
  }
  // The four oversight acts that decide who holds capabilities, plus the two
  // backup acts that hold the whole installation. Anything else appearing here
  // means a role lost a capability nobody noticed.
  const onlyAdmin = CAPABILITIES.filter((capability) => rolesWithCapability(capability).join() === "admin").sort();
  assert.deepEqual(
    onlyAdmin,
    ["export_backup", "manage_roles", "manage_settings", "manage_users", "restore_backup"],
  );
});

test("admin passes every entry of the route table and every screen path", () => {
  const adminUser = { role: "admin" as AppRole, capabilities: [...CAPABILITIES] };
  for (const [prefix, capability] of ROUTE_CAPABILITIES) {
    assert.ok(userCan(adminUser, capability), `the route ${prefix} is refused to an admin`);
  }
  for (const pathname of ALL_PATHS) {
    const capability = capabilityForPath(pathname);
    if (capability === null) continue;
    assert.ok(userCan(adminUser, capability), `the path ${pathname} is refused to an admin (${capability})`);
  }
});

test("every capability a gate in src asks about is real, and admin holds it", () => {
  const sites = gateCapabilitySites();
  assert.ok(sites.length >= 40, `the scan found only ${sites.length} gate sites — the patterns have drifted`);
  const unknown = sites.filter((site) => !(CAPABILITIES as readonly string[]).includes(site.capability));
  assert.deepEqual(
    [...new Set(unknown.map((s) => s.capability))],
    [],
    `gates ask about unknown capabilities: ${unknown.map((s) => `${s.capability} @ ${s.file}`).join(" | ")}`,
  );
  const missing = sites.filter((site) => !hasCapability("admin", site.capability as Capability));
  assert.deepEqual(
    [...new Set(missing.map((s) => s.capability))],
    [],
    `an admin is refused by gates on: ${missing.map((s) => `${s.capability} @ ${s.file} [${s.kind}]`).join(" | ")}`,
  );
});

test("the role-list gates all include admin", () => {
  const lists = exportedRoleLists();
  assert.ok(lists.length >= 3, `expected the app's role lists, found: ${lists.map((l) => l.name).join(", ")}`);
  for (const list of lists) {
    assert.ok(list.roles.includes("admin"), `${list.name} @ ${list.file} excludes admin`);
  }
});

test("every sensitive action is performable by admin, on a real capability", () => {
  for (const action of SENSITIVE_ACTIONS) {
    assert.ok(
      (CAPABILITIES as readonly string[]).includes(action.capability),
      `${action.key} names an unknown capability: ${action.capability}`,
    );
    assert.ok(hasCapability("admin", action.capability), `admin cannot perform ${action.key}`);
  }
});

test("the offline admin account resolves to every capability", () => {
  const admin = DEMO_USERS.find((user) => user.username === "admin");
  assert.ok(admin, "the demo installation ships an admin account");
  assert.equal(admin.role, "admin");
  const resolved = capabilitiesOfUser(admin);
  for (const capability of CAPABILITIES) {
    assert.ok(resolved.includes(capability), `the demo admin does not resolve ${capability}`);
  }
});

test("every alias that maps onto admin resolves to the same full set", () => {
  const admin = capabilitiesOf("admin");
  for (const alias of ["admin", "owner", "super_admin", "superadmin"]) {
    assert.equal(normalizeRole(alias), "admin", `${alias} must normalise to admin`);
    assert.deepEqual(capabilitiesOf(alias), admin, `${alias} must resolve to the admin set`);
  }
});

test("a bare admin session holds everything, and a signed-out one holds nothing", () => {
  // A bare admin's session carries the matrix itself as its resolved list —
  // exactly what identity.ts produces when no overlay and no exception apply.
  assert.deepEqual(
    [...capabilitiesOfUser({ role: "admin", capabilities: capabilitiesOf("admin") })].sort(),
    [...CAPABILITIES].sort(),
  );
  assert.deepEqual(resolveCapabilities("admin", null, NO_EXCEPTIONS).sort(), [...CAPABILITIES].sort());
  assert.equal(capabilitiesOfUser(null).length, 0, "signed out holds nothing");
  assert.equal(capabilitiesOf("").length, 0, "an empty role holds nothing");
  assert.equal(capabilitiesOf("galactus").length, 0, "an unknown role holds nothing");
});

test("a person's own denials bind even the admin role — by design, matching the database", () => {
  // Exceptions belong to the person, not the role: an admin denied `sell`
  // cannot sell, and the same arithmetic lives in `public.can()` (deny first).
  // The promise audited here is about the *role*; the person's own list is a
  // deliberate overlay on top of it.
  const denied = resolveCapabilities("admin", null, { extra: [], denied: ["sell"] });
  assert.equal(denied.includes("sell" as Capability), false, "the denial of sell binds the admin role");
  assert.equal(denied.length, CAPABILITIES.length - 1, "and nothing else changes");
});

// ── run ──────────────────────────────────────────────────────────────────────

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed > 0) {
  console.log(`\n✗ ${failed}/${tests.length} admin full-permission audit tests failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} admin full-permission audit tests passed`);

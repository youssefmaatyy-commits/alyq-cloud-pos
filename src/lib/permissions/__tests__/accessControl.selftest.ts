/**
 * Dynamic access control self-test — Phase 17.
 *
 * Run with the shared runner: `npm test` (or `node scripts/test.logic.mjs accessControl`).
 *
 * Three claims, in the order the phase depends on them:
 *
 *   1. **Per-user exceptions are real.** A grant adds what a role lacks, a denial
 *      removes what a role holds, and a denial wins over a grant of the same act.
 *      Empty, absent or corrupt exception data changes nothing. The point is not
 *      the arithmetic — it is that the *resolved* list is what the service layer
 *      reads, so an exception is enforced by the same guards a role is.
 *   2. **The access preview is a mirror, not a lever.** What it reports for a
 *      role, a custom role, or a person is exactly what a session built from the
 *      same inputs resolves to — and calling it changes nothing about the caller.
 *      A panel that could be used to gain access would be a hole, not a feature.
 *   3. **The catalogue is complete and closed.** Every capability has a verb, a
 *      group, an action, translations in both languages, a role that holds it and
 *      a gate somewhere in the code. An act missing any of those is invisible: it
 *      cannot be granted, cannot be explained, and cannot be enforced — which is
 *      how permissions quietly stop meaning anything.
 *
 * Sessions here are built with `writeStoredSession`, which also primes the
 * in-memory cache the permission helpers read. `resetSessionCache()` followed by
 * `primeCacheFromStorage()` is *not* used: with no `localStorage` in node that
 * pair signs the caller out again, and every refusal below would pass for the
 * wrong reason.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { SENSITIVE_ACTIONS } from "../actions";
import {
  CAPABILITY_ACTIONS,
  CAPABILITY_GROUPS,
  PERMISSION_ACTIONS,
  actionLabelKey,
  actionsInGroup,
  capabilityGroupLabelKey,
  capabilityHintKey,
  capabilityLabelKey,
  capabilityMatrix,
  catalogProblems,
  groupOfCapability,
} from "../catalog";
import { resolveCapabilities } from "../customRoles";
import {
  NO_EXCEPTIONS,
  applyExceptions,
  exceptionDiff,
  hasExceptions,
  parseCapabilityExceptions,
  sanitizeCapabilityExceptions,
  type CapabilityExceptions,
} from "../exceptions";
import {
  PREVIEW_SCREENS,
  actionTally,
  previewAccess,
  previewScreens,
  previewSystemRole,
} from "../preview";
import {
  APP_ROLES,
  CAPABILITIES,
  capabilitiesOf,
  type AppRole,
  type Capability,
} from "../roles";
import { ROUTE_CAPABILITIES, capabilityForPath } from "../routes";

import { resetDemoUserRepository } from "@/lib/auth/data/demoRepository";
import { readStaffDirectory, resetStaffDirectory } from "@/lib/auth/data/staffDirectory";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { createSession } from "@/lib/auth/services/authService";
import { buildAuthUser, capabilitiesForIdentity } from "@/lib/auth/services/identity";
import { clearStoredSession, writeStoredSession } from "@/lib/auth/services/sessionStore";
import { ar, en } from "@/lib/i18n/dictionary";
import { actingUser, assertCapability, canAct, deniedMessageKey } from "@/lib/permissions/enforce";
import { getDemoAuditRepository } from "@/modules/audit/data/demoRepository";
import * as customerService from "@/modules/customers/services/customerService";
import * as inventoryService from "@/modules/inventory/services/inventoryService";
import { AppError } from "@/modules/products/data/repository";
import { resetSettingsRepositories } from "@/modules/settings/data";
import {
  loadManagedUsers,
  setUserExceptions,
} from "@/modules/settings/services/settingsService";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** Sign a seat in with an explicit resolved list (how a custom role arrives). */
function signInAs(role: AppRole, capabilities?: readonly Capability[]): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(
    createSession({ ...record, capabilities: capabilities ?? capabilitiesOf(role) }, false),
    "session",
  );
}

function signOut(): void {
  clearStoredSession();
}

async function refusalCode(fn: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

function refusalCodeSync(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `not-an-AppError:${String(err)}`;
  }
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/lib/permissions/actions.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repository root from ${process.cwd()}`);
}

/** Every source file that is not a definition site or a test. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(repoRoot(), "src"));
  return out;
}

/** An in-memory `window.localStorage`, for the one test that checks persistence. */
function installStorageShim(): () => void {
  const make = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
    } as Storage;
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: make(),
    sessionStorage: make(),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  return () => {
    (globalThis as { window?: unknown }).window = previous;
  };
}

/** Flat dictionary lookup — the dictionary is one level of dotted keys. */
function translated(dict: Record<string, string>, key: string): string | undefined {
  return dict[key];
}

// ══════════════════════════════════════════════════════════════════════════
// 1. PER-USER EXCEPTIONS
// ══════════════════════════════════════════════════════════════════════════

test("exceptions: a grant adds what the role lacks", () => {
  const resolved = resolveCapabilities("viewer", null, { extra: ["sell"], denied: [] });
  assert.ok(resolved.includes("sell"), "viewer + sell grant resolves to sell");
  assert.ok(capabilitiesOf("viewer").indexOf("sell") === -1, "the base role did not have it");
});

test("exceptions: a denial removes what the role holds", () => {
  const resolved = resolveCapabilities("cashier", null, { extra: [], denied: ["sell"] });
  assert.ok(resolved.indexOf("sell") === -1, "cashier − sell resolves without sell");
  assert.ok(capabilitiesOf("cashier").includes("sell"), "the base role did have it");
});

test("exceptions: deny wins over a grant of the same act", () => {
  const clean = sanitizeCapabilityExceptions({ extra: ["sell"], denied: ["sell"] });
  assert.deepEqual([...clean.extra], [], "the grant is dropped at the boundary");
  assert.deepEqual([...clean.denied], ["sell"], "the denial is kept");
  assert.ok(!resolveCapabilities("viewer", null, clean).includes("sell"));
});

test("exceptions: empty, absent and corrupt data change nothing", () => {
  for (const role of APP_ROLES) {
    assert.deepEqual(
      applyExceptions(capabilitiesOf(role), NO_EXCEPTIONS),
      capabilitiesOf(role),
      `${role} is unchanged by the empty exceptions`,
    );
  }
  for (const raw of [null, undefined, "", {}, "not-an-object", 7, [], { extra: "sell", denied: 3 }]) {
    assert.equal(
      parseCapabilityExceptions(raw),
      NO_EXCEPTIONS,
      `${JSON.stringify(raw) ?? String(raw)} parses to none`,
    );
  }
  assert.equal(hasExceptions(NO_EXCEPTIONS), false);
  assert.equal(hasExceptions({ extra: ["sell"], denied: [] }), true, "a real grant counts");
  assert.deepEqual(
    [...parseCapabilityExceptions({ extra: ["sell", "not_a_capability", "sell"] }).extra],
    ["sell"],
    "unknown ids are dropped and the list is deduplicated",
  );
});

test("exceptions: they sit on top of a custom role, not underneath", () => {
  const resolved = resolveCapabilities(
    "viewer",
    { capabilities: ["view_reports"], active: true },
    { extra: ["sell"], denied: [] },
  );
  assert.deepEqual(resolved, ["sell", "view_reports"], "both sources survive, in declaration order");
});

test("exceptions: the identity seam resolves them exactly like the model", () => {
  const exceptions: CapabilityExceptions = { extra: ["adjust_stock"], denied: ["sell"] };
  const viaIdentity = capabilitiesForIdentity({
    id: "u-1",
    username: "teller",
    name: "Teller",
    role: "cashier",
    exceptions,
  });
  const viaModel = applyExceptions(capabilitiesOf("cashier"), exceptions);
  assert.deepEqual(viaIdentity, viaModel, "one arithmetic, two entry points");

  const user = buildAuthUser({ id: "u-1", username: "teller", name: "Teller", role: "cashier", exceptions });
  assert.deepEqual(user.capabilities, viaModel, "the session user carries the resolved list");
  assert.ok(user.capabilities.includes("adjust_stock"));
  assert.ok(!user.capabilities.includes("sell"));

  const corrupt = buildAuthUser({
    id: "u-2",
    username: "ghost",
    name: "Ghost",
    role: "cashier",
    exceptions: { extra: ["not_a_capability"], denied: null },
  });
  assert.deepEqual(corrupt.capabilities, capabilitiesOf("cashier"), "garbage grants nothing");
});

test("exceptions: the diff names what changed, for the audit trail and the UI", () => {
  const diff = exceptionDiff(capabilitiesOf("cashier"), { extra: ["adjust_stock"], denied: ["sell"] });
  assert.deepEqual(diff.added, ["adjust_stock"]);
  assert.deepEqual(diff.removed, ["sell"]);
});

test("exceptions: a denial is refused by the service layer, not just hidden", () => {
  signInAs(
    "inventory_clerk",
    applyExceptions(capabilitiesOf("inventory_clerk"), { extra: [], denied: ["adjust_stock"] }),
  );
  try {
    assert.equal(canAct("adjust_stock"), false, "the resolved list lost it");
    assert.equal(refusalCodeSync(() => inventoryService.assertCanAdjustStock()), "FORBIDDEN");
  } finally {
    signOut();
  }
});

test("exceptions: a grant is accepted by the same service layer", () => {
  signInAs("viewer", applyExceptions(capabilitiesOf("viewer"), { extra: ["adjust_stock"], denied: [] }));
  try {
    assert.equal(canAct("adjust_stock"), true, "the grant is in the resolved list");
    assert.equal(refusalCodeSync(() => inventoryService.assertCanAdjustStock()), null, "no refusal");
    assert.equal(canAct("manage_users"), false, "the grant did not bring anything with it");
  } finally {
    signOut();
  }
});

test("exceptions: the customer book obeys them too", async () => {
  signInAs("inventory_clerk", applyExceptions(capabilitiesOf("inventory_clerk"), { extra: [], denied: ["view_customers"] }));
  try {
    assert.equal(await refusalCode(() => customerService.loadCustomers()), "FORBIDDEN");
  } finally {
    signOut();
  }

  signInAs("manager", applyExceptions(capabilitiesOf("manager"), { extra: [], denied: ["delete_customer"] }));
  try {
    assert.equal(await refusalCode(() => customerService.deleteCustomer("c-1")), "FORBIDDEN");
    assert.equal(refusalCodeSync(() => assertCapability("view_customers")), null, "reading survives");
  } finally {
    signOut();
  }

  signInAs("viewer", applyExceptions(capabilitiesOf("viewer"), { extra: ["add_customer"], denied: [] }));
  try {
    assert.equal(refusalCodeSync(() => assertCapability("add_customer")), null, "the grant reaches the gate");
    assert.equal(refusalCodeSync(() => assertCapability("delete_customer")), "FORBIDDEN", "and no further");
  } finally {
    signOut();
  }
});

test("exceptions: the service persists them, writes the audit trail, and refuses self-lockout", async () => {
  // The demo directory stores through `window.localStorage`. Node has none, so a
  // write would silently vanish and the re-read below would prove nothing; the
  // shim supplies the browser API the store already expects, and is removed
  // again in the `finally`. No application code is aware of it.
  const restoreWindow = installStorageShim();
  resetDemoUserRepository();
  resetStaffDirectory();
  resetSettingsRepositories();
  assert.ok(readStaffDirectory().length > 0, "the directory is seeded");

  signInAs("admin");
  try {
    const listed = await loadManagedUsers();
    const actor = actingUser();
    assert.ok(actor.capabilities.includes("manage_users"), "the administrator is signed in");
    const target = listed.find((user) => user.id !== actor.id);
    assert.ok(target, "there is a second seat to edit");

    const updated = await setUserExceptions(
      target.id,
      { extra: ["sell"], denied: ["adjust_stock"] },
      { existing: listed, roles: [] },
    );
    assert.deepEqual([...updated.extra_capabilities], ["sell"], "the grant is stored");
    assert.deepEqual([...updated.denied_capabilities], ["adjust_stock"], "the denial is stored");

    const reloaded = await loadManagedUsers();
    const again = reloaded.find((user) => user.id === target.id);
    assert.deepEqual([...(again?.extra_capabilities ?? [])], ["sell"], "and it survives a re-read");
    assert.deepEqual([...(again?.denied_capabilities ?? [])], ["adjust_stock"]);

    const entry = (await getDemoAuditRepository().listEntries()).find(
      (log) => log.action === "user.permissions_changed" && log.entity_id === target.id,
    );
    assert.ok(entry, "an audit entry was written");
    assert.equal(entry?.details.granted, "sell");
    assert.equal(entry?.details.withheld, "adjust_stock");
    assert.equal(entry?.details.extra, "sell");
    assert.equal(entry?.details.denied, "adjust_stock");
    assert.equal(entry?.user_name, actor.name, "the actor is named");

    await assert.rejects(
      () => setUserExceptions(actor.id, { extra: [], denied: ["manage_users"] }, { existing: reloaded, roles: [] }),
      (err: AppError) => err.code === "FORBIDDEN",
      "an administrator cannot deny themselves the console",
    );

    const cleared = await setUserExceptions(target.id, NO_EXCEPTIONS, { existing: reloaded, roles: [] });
    assert.deepEqual([...cleared.extra_capabilities], [], "empty exceptions are a valid decision");
    assert.deepEqual([...cleared.denied_capabilities], []);
    const restore = (await getDemoAuditRepository().listEntries()).filter(
      (log) => log.action === "user.permissions_changed" && log.entity_id === target.id,
    );
    assert.equal(restore.length, 2, "clearing them is itself an audited change");
    assert.equal(restore[0]?.details.ungranted, "sell");
    assert.equal(restore[0]?.details.restored, "adjust_stock");
  } finally {
    signOut();
    resetStaffDirectory();
    resetSettingsRepositories();
    restoreWindow();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. ACCESS PREVIEW
// ══════════════════════════════════════════════════════════════════════════

test("preview: a system role preview is that role's resolved list", () => {
  for (const role of APP_ROLES) {
    assert.deepEqual(previewSystemRole(role).capabilities, capabilitiesOf(role), `${role} previews as itself`);
    assert.deepEqual(previewSystemRole(role).addedByException, []);
    assert.deepEqual(previewSystemRole(role).removedByException, []);
  }
});

test("preview: a person preview matches what a session for that person resolves to", () => {
  type Case = {
    role: AppRole;
    overlay?: { capabilities: readonly string[]; active: boolean };
    exceptions?: CapabilityExceptions;
  };
  const cases: Case[] = [
    { role: "cashier" },
    { role: "viewer", exceptions: { extra: ["sell"], denied: [] } },
    { role: "cashier", exceptions: { extra: [], denied: ["sell", "apply_discount"] } },
    { role: "manager", overlay: { capabilities: ["view_reports"], active: true } },
    { role: "viewer", overlay: { capabilities: ["view_reports", "sell"], active: false } },
    {
      role: "viewer",
      overlay: { capabilities: ["view_reports", "sell"], active: true },
      exceptions: { extra: ["adjust_stock"], denied: ["sell"] },
    },
  ];

  for (const input of cases) {
    const label = `${input.role}${input.overlay ? "+overlay" : ""}${input.exceptions ? "+exceptions" : ""}`;
    const previewed = previewAccess({ role: input.role, customRole: input.overlay ?? null, exceptions: input.exceptions ?? null });
    const resolved = capabilitiesForIdentity({
      id: "u-9",
      username: "previewed",
      name: "Previewed",
      role: input.role,
      custom_role: input.overlay
        ? { name_en: "Floor lead", name_ar: "مسؤول الصالة", capabilities: input.overlay.capabilities, active: input.overlay.active }
        : null,
      exceptions: input.exceptions ?? null,
    });
    assert.deepEqual(previewed.capabilities, resolved, `the preview matches the session for ${label}`);

    const roleOnly = previewed.roleCapabilities;
    assert.deepEqual(
      previewed.addedByException,
      resolved.filter((capability) => !roleOnly.includes(capability)),
      `${label}: the added delta is the difference against the role`,
    );
    assert.deepEqual(
      previewed.removedByException,
      roleOnly.filter((capability) => !resolved.includes(capability)),
      `${label}: the removed delta is what the exceptions took away`,
    );

    // The same person, signed in, resolves to the same list — and every gate
    // agrees with the preview, capability by capability.
    signInAs(input.role, resolved);
    try {
      assert.deepEqual(actingUser().capabilities, previewed.capabilities, `${label}: the session carries it`);
      for (const capability of CAPABILITIES) {
        assert.equal(
          canAct(capability),
          previewed.capabilities.includes(capability),
          `${label}: canAct(${capability}) matches the preview`,
        );
      }
    } finally {
      signOut();
    }
  }
});

test("preview: screens follow the route table, and the partition is total", () => {
  const universe = previewScreens();
  assert.equal(universe.length, PREVIEW_SCREENS.length, "every screen carries a verdict");
  for (const screen of universe) {
    assert.equal(screen.capability, capabilityForPath(screen.path), `${screen.path} is decided by the route table`);
  }

  for (const role of APP_ROLES) {
    const { visible, hidden } = previewAccess({ role }).screens;
    assert.equal(visible.length + hidden.length, PREVIEW_SCREENS.length, `${role}: nothing is dropped`);
    const ids = [...visible, ...hidden].map((screen) => screen.path).sort();
    assert.deepEqual(ids, PREVIEW_SCREENS.map((screen) => screen.path).sort(), "same screens, partitioned");
    const held = capabilitiesOf(role);
    for (const screen of visible) {
      assert.ok(!screen.capability || held.includes(screen.capability), `${role} may see ${screen.path}`);
    }
    for (const screen of hidden) {
      assert.ok(screen.capability && !held.includes(screen.capability), `${role} may not see ${screen.path}`);
    }
  }

  assert.equal(previewAccess({ role: "admin" }).screens.hidden.length, 0, "admin sees everything");
  assert.ok(
    previewAccess({ role: "viewer" }).screens.hidden.some((screen) => screen.path === "/settings/users"),
    "viewer does not see the users console",
  );
  assert.ok(
    previewAccess({ role: "cashier" }).screens.visible.some((screen) => screen.path === "/pos"),
    "cashier sees the register",
  );
  assert.ok(
    previewAccess({ role: "cashier", exceptions: { extra: [], denied: ["sell"] } }).screens.hidden.some(
      (screen) => screen.path === "/pos",
    ),
    "denying the till hides the till — the preview follows the exceptions too",
  );
});

test("preview: every previewed screen is a real route", () => {
  const app = fs.readFileSync(path.join(repoRoot(), "src/App.tsx"), "utf8");
  const declared = new Set<string>();
  for (const match of app.matchAll(/<Route\s+[^>]*path="([^"]+)"/g)) {
    declared.add(match[1]);
    // A parent that hosts its own descendant <Routes> has to declare a splat
    // (`path="/settings/*"`), or React Router never hands it the deeper path. The
    // screens under it are still reached through the parent, so record both.
    if (match[1].endsWith("/*")) declared.add(match[1].slice(0, -2));
  }
  for (const screen of PREVIEW_SCREENS) {
    // Nested routes are declared relative to their parent (`/settings` + `users`),
    // so accept either the full path or the parent/leaf pair.
    const segments = screen.path.split("/").filter(Boolean);
    const leaf = segments[segments.length - 1];
    const parent = `/${segments.slice(0, -1).join("/")}`;
    const reachable =
      declared.has(screen.path) ||
      (segments.length > 1 && declared.has(parent) && (declared.has(leaf) || declared.has(`/${leaf}`)));
    assert.ok(reachable, `${screen.path} is declared in App.tsx (directly or nested)`);
  }
  assert.ok(
    ROUTE_CAPABILITIES.length >= PREVIEW_SCREENS.length - 4,
    "the route table gates essentially every screen",
  );
});

test("preview: calling it changes nothing about the caller", () => {
  signInAs("viewer");
  try {
    const before = [...(actingUser().capabilities ?? [])];
    assert.equal(canAct("manage_users"), false);
    assert.equal(canAct("sell"), false);

    const adminView = previewAccess({ role: "admin" });
    const widened = previewAccess({ role: "cashier", exceptions: { extra: ["manage_users"], denied: [] } });
    assert.ok(adminView.capabilities.includes("manage_users"), "the preview reports the wider list");
    assert.ok(widened.capabilities.includes("manage_users"));
    assert.equal(adminView.screens.hidden.length, 0);

    assert.deepEqual([...(actingUser().capabilities ?? [])], before, "the session user is untouched");
    assert.equal(canAct("manage_users"), false, "still refused");
    assert.equal(canAct("sell"), false, "still refused");
    assert.equal(refusalCodeSync(() => assertCapability("manage_users")), "FORBIDDEN", "the guard reads the session");
    assert.equal(refusalCodeSync(() => assertCapability("view_customers")), null, "what the viewer holds, still holds");
  } finally {
    signOut();
  }
});

test("preview: the action tally counts every permission exactly once", () => {
  for (const role of APP_ROLES) {
    const caps = capabilitiesOf(role);
    const tally = actionTally(caps);
    assert.equal(
      tally.reduce((sum, row) => sum + row.count, 0),
      caps.length,
      `${role}: the verbs partition the held permissions`,
    );
    for (const row of tally) {
      const expected = caps.filter((cap) => CAPABILITY_ACTIONS[cap] === row.action).length;
      assert.equal(row.count, expected, `${role}: ${row.action} is counted from the catalogue`);
      assert.ok(row.count > 0, "an empty verb is not listed");
    }
    assert.ok(tally.length <= PERMISSION_ACTIONS.length);
    assert.deepEqual(
      tally.map((row) => row.action),
      PERMISSION_ACTIONS.filter((action) => tally.some((row) => row.action === action)),
      "verbs are listed in declaration order, so two roles read the same way",
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. THE PERMISSION CATALOGUE
// ══════════════════════════════════════════════════════════════════════════

test("catalogue: it reports no problems of its own", () => {
  assert.deepEqual(catalogProblems(), []);
});

test("catalogue: every capability has one action, and it is one of the seven verbs", () => {
  for (const cap of CAPABILITIES) {
    const action = CAPABILITY_ACTIONS[cap];
    assert.ok(action, `${cap} names an action`);
    assert.ok(PERMISSION_ACTIONS.includes(action), `${cap}'s action is a declared verb`);
  }
  assert.deepEqual(
    [...PERMISSION_ACTIONS],
    ["view", "create", "edit", "delete", "approve", "export", "manage"],
    "seven verbs, and no eighth",
  );
  assert.equal(Object.keys(CAPABILITY_ACTIONS).length, CAPABILITIES.length, "the map is exhaustive");
});

test("catalogue: every capability belongs to exactly one group", () => {
  const seen = new Map<string, number>();
  for (const group of CAPABILITY_GROUPS) {
    for (const cap of group.capabilities) seen.set(cap, (seen.get(cap) ?? 0) + 1);
  }
  for (const cap of CAPABILITIES) {
    assert.equal(seen.get(cap), 1, `${cap} is in exactly one group`);
    assert.ok(groupOfCapability(cap), `${cap} resolves to a group`);
  }
  assert.equal(seen.size, CAPABILITIES.length, "no group invents a capability");
});

test("catalogue: the matrix is the catalogue turned sideways", () => {
  const rows = capabilityMatrix();
  assert.equal(rows.length, CAPABILITIES.length, "one row per permission");
  assert.deepEqual(actionsInGroup("customers"), ["view", "create", "edit", "delete"]);
  assert.deepEqual(actionsInGroup("reports"), ["view", "export"]);
  assert.deepEqual(
    rows.filter((row) => row.group === "customers").map((row) => row.action).sort(),
    ["create", "delete", "edit", "view"],
    "the customer area reads as a verb row",
  );
  for (const row of rows) {
    assert.equal(row.action, CAPABILITY_ACTIONS[row.capability], "a cell agrees with the verb map");
    assert.equal(groupOfCapability(row.capability)?.key, row.group, "a cell agrees with its group");
  }
});

test("catalogue: no missing translations, in either language", () => {
  const dictionaries: Record<string, Record<string, string>> = { en: en as Record<string, string>, ar: ar as Record<string, string> };
  const missing: string[] = [];
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const cap of CAPABILITIES) {
      for (const key of [capabilityLabelKey(cap), capabilityHintKey(cap), deniedMessageKey(cap)]) {
        const value = translated(dict, key);
        if (typeof value !== "string" || value.trim().length === 0) missing.push(`${lang}:${key}`);
      }
    }
    for (const group of CAPABILITY_GROUPS) {
      const key = capabilityGroupLabelKey(group.key);
      if (typeof translated(dict, key) !== "string") missing.push(`${lang}:${key}`);
    }
    for (const action of PERMISSION_ACTIONS) {
      const key = actionLabelKey(action);
      if (typeof translated(dict, key) !== "string") missing.push(`${lang}:${key}`);
    }
    for (const key of ["audit.action.user.permissions_changed"]) {
      if (typeof translated(dict, key) !== "string") missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, [], "every permission, hint, denial, group, verb and audit action is translated");
});

test("catalogue: every string the Phase 17 screens ask for exists in both languages", () => {
  const surfaces = [
    "src/modules/settings/components/PermissionPicker.tsx",
    "src/modules/settings/components/PermissionSummary.tsx",
    "src/modules/settings/components/AccessPreviewModal.tsx",
    "src/modules/settings/components/UserExceptionsModal.tsx",
    "src/modules/settings/components/RoleFormModal.tsx",
    "src/modules/settings/pages/RolesPage.tsx",
    "src/modules/settings/pages/UsersPage.tsx",
  ];
  const root = repoRoot();
  const keys = new Set<string>();
  for (const surface of surfaces) {
    const full = path.join(root, surface);
    assert.ok(fs.existsSync(full), `${surface} exists`);
    const body = fs.readFileSync(full, "utf8");
    for (const match of body.matchAll(/(?:^|[^A-Za-z0-9_$.])t\(\s*"([^"]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size >= 40, `the Phase 17 surfaces ask for copy (${keys.size} keys found)`);

  const missing: string[] = [];
  for (const key of [...keys].sort()) {
    for (const [lang, dict] of Object.entries({ en: en as Record<string, string>, ar: ar as Record<string, string> })) {
      const value = translated(dict, key);
      if (typeof value !== "string" || value.trim().length === 0) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, [], "no screen renders a bare key");
});

test("catalogue: no unused permissions — each is held by a role and read by a gate", () => {
  const routeGates = new Set(ROUTE_CAPABILITIES.map(([, capability]) => capability));
  const actionGates = new Set(Object.values(SENSITIVE_ACTIONS).map((action) => action.capability));
  const sources = sourceFiles().map((file) => ({ file, body: fs.readFileSync(file, "utf8") }));
  const unheld: string[] = [];
  const ungated: string[] = [];

  for (const cap of CAPABILITIES) {
    if (!APP_ROLES.some((role) => capabilitiesOf(role).includes(cap))) unheld.push(cap);
    if (routeGates.has(cap) || actionGates.has(cap)) continue;
    const quoted = `"${cap}"`;
    if (!sources.some(({ body }) => body.includes(quoted))) ungated.push(cap);
  }

  assert.deepEqual(unheld, [], "every capability is held by at least one role, or it cannot be granted at all");
  assert.deepEqual(ungated, [], "every capability is read by a gate somewhere in src/");
});

// ── runner ────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  console.log("\n── Phase 17 dynamic access control ──");
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${tests.length} access-control tests FAILED.`);
    process.exit(1);
  }
  console.log(`${passed}/${tests.length} Phase 17 access-control tests passed.`);
})();

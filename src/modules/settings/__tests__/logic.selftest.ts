/**
 * Settings logic self-test (headless, no DOM).
 *
 * Run with:
 *   npx esbuild src/modules/settings/__tests__/logic.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-settings.mjs && node /tmp/alyq-settings.mjs
 *
 * What is pinned here, and why each of these specifically:
 *
 *   · the capability catalogue is a partition of the real capability list. This
 *     is the test that catches a capability added to `roles.ts` and forgotten in
 *     `catalog.ts` — which would make it ungrantable from the UI, silently.
 *   · form validation: the rules an admin meets, including the ones that exist to
 *     stop an installation locking itself out.
 *   · the demo path end to end: create an account → it can sign in; deactivate it
 *     → it cannot; give it a custom role → its capabilities become exactly that
 *     role's list; reset its password → the old one stops working.
 *   · the service layer refuses what the UI hides: a cashier calling
 *     `loadManagedUsers()` is refused, not shown an empty list.
 *   · every mutation leaves an audit entry, because "who changed this?" is the
 *     question the whole phase exists to answer.
 */
import assert from "node:assert/strict";
import { CAPABILITIES, capabilitiesOf, type AppRole } from "@/lib/permissions/roles";
import { CAPABILITY_GROUPS, catalogProblems, groupOfCapability } from "@/lib/permissions/catalog";
import {
  CUSTOM_ROLE_PRESETS,
  resolveCapabilities,
  sanitizeCapabilities,
  validateCustomRoleDraft,
} from "@/lib/permissions/customRoles";
import { resetCustomRoles, readCustomRoles } from "@/lib/permissions/customRoleStore";
import { createVerifier, verifyPassword } from "@/lib/auth/services/password";
import { evaluatePassword } from "@/lib/auth/services/passwordPolicy";
import { createSession, signOut } from "@/lib/auth/services/authService";
import { primeCacheFromStorage, resetSessionCache, writeStoredSession } from "@/lib/auth/services/sessionStore";
import { DEMO_USERS } from "@/lib/auth/demoUsers";
import { getDemoUserRepository, resetDemoUserRepository } from "@/lib/auth/data/demoRepository";
import { resetStaffDirectory, readStaffDirectory, findStaffByUsername } from "@/lib/auth/data/staffDirectory";
import { getDemoAuditRepository } from "@/modules/audit/data/demoRepository";
import { AppError } from "@/modules/products/data/repository";
import { resetSettingsRepositories } from "../data";
import { getDemoSettingsRepository } from "../data/demoRepository";
import {
  assignCustomRole,
  countRoleAssignments,
  createRole,
  createUser,
  loadManagedRoles,
  loadManagedUsers,
  resetUserPassword,
  setRoleActive,
  setUserActive,
  updateRole,
  updateUser,
} from "../services/settingsService";
import { queryUsers, sortUsers, summarizeUsers } from "../services/userQuery";
import { roleFormToDraft, validateRoleForm, validateUserForm } from "../validation";
import {
  DEFAULT_USER_SORT,
  EMPTY_USER_FILTERS,
  EMPTY_USER_FORM,
  type ManagedUser,
  type RoleFormState,
  type UserFormState,
} from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

// ── harness ──────────────────────────────────────────────────────────────────

/**
 * Storage for a headless run.
 *
 * `window` is stubbed as well as `globalThis.localStorage`, because the stores
 * this module writes go through `safeStorage`, which reads `window.localStorage`.
 * Without it every write would be silently dropped and the tests would pass while
 * asserting nothing — the worst kind of green.
 */
function installStorageStub(): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage, sessionStorage: storage, addEventListener() {}, removeEventListener() {} },
    configurable: true,
    writable: true,
  });
  return map;
}

let store = new Map<string, string>();

/** Fresh storage, fresh directory, fresh roles, and an admin holding the session. */
function resetAll(actor: AppRole = "admin"): void {
  store = installStorageStub();
  resetSessionCache();
  resetStaffDirectory();
  resetCustomRoles();
  resetSettingsRepositories();
  resetDemoUserRepository();
  signInAs(actor);
}

function signInAs(role: AppRole): void {
  const record = DEMO_USERS.find((user) => user.role === role);
  assert.ok(record, `a demo account exists for ${role}`);
  writeStoredSession(createSession({ ...record, capabilities: capabilitiesOf(role) }, false), "local");
  // `getCurrentAuthUser()` reads the in-memory cache and never reaches into
  // storage on its own — deliberately, so an unprimed caller is anonymous rather
  // than accidentally privileged. The app primes it at boot (`restoreSession`);
  // a headless test has to do the same.
  resetSessionCache();
  primeCacheFromStorage();
}

const repository = () => getDemoSettingsRepository();

function userForm(overrides: Partial<UserFormState> = {}): UserFormState {
  return { ...EMPTY_USER_FORM, ...overrides };
}

function roleForm(overrides: Partial<RoleFormState> = {}): RoleFormState {
  return {
    id: null,
    key: "",
    name_en: "",
    name_ar: "",
    description_en: "",
    description_ar: "",
    base_role: null,
    capabilities: [],
    active: true,
    ...overrides,
  };
}

const ACCOUNTANT_FORM = roleForm({
  name_en: "Accountant",
  name_ar: "محاسب",
  base_role: "viewer",
  capabilities: ["view_reports", "export_reports", "view_shifts", "add_expense", "approve_expense"],
});

console.log("\nSettings · users, custom roles and permission enforcement");

// ── catalogue integrity ──────────────────────────────────────────────────────

test("the capability catalogue partitions the real capability list", () => {
  const problems = catalogProblems();
  assert.deepEqual(problems, [], problems.join("; "));

  const grouped = CAPABILITY_GROUPS.flatMap((group) => [...group.capabilities]);
  assert.equal(grouped.length, CAPABILITIES.length, "every capability is grouped exactly once");
  assert.equal(new Set(grouped).size, grouped.length, "no capability appears in two groups");
  for (const capability of CAPABILITIES) {
    assert.ok(groupOfCapability(capability), `${capability} belongs to a group`);
  }
});

test("every preset is a valid draft, stays inside the catalogue, and keeps administration out", () => {
  const administration = ["manage_users", "manage_roles", "manage_settings"] as const;

  for (const preset of CUSTOM_ROLE_PRESETS) {
    const verdict = validateCustomRoleDraft({
      key: preset.presetKey,
      name_en: preset.name_en,
      name_ar: preset.name_ar,
      description_en: "",
      description_ar: "",
      base_role: preset.base_role,
      capabilities: preset.capabilities,
    });
    assert.equal(verdict.ok, true, `${preset.presetKey} is a valid draft`);

    // A custom role *replaces* the matrix, so it may legitimately grant something
    // its base role lacks — an accountant needs expenses, and `viewer` has none.
    // What it may not do is invent a capability, or hand out administration.
    const invented = preset.capabilities.filter((capability) => !CAPABILITIES.includes(capability));
    assert.deepEqual(invented, [], `${preset.presetKey} invents ${invented.join(", ")}`);

    const adminRights = preset.capabilities.filter((capability) =>
      (administration as readonly string[]).includes(capability),
    );
    assert.deepEqual(
      adminRights,
      [],
      `${preset.presetKey} must not carry ${adminRights.join(", ")} — those stay with the admin role`,
    );

    assert.ok(
      preset.capabilities.length < capabilitiesOf("admin").length,
      `${preset.presetKey} is narrower than admin`,
    );
    assert.deepEqual(
      preset.capabilities,
      sanitizeCapabilities(preset.capabilities),
      `${preset.presetKey} is stored in canonical order with no duplicates`,
    );
  }

  // The four presets the specification names, by name.
  const keys = CUSTOM_ROLE_PRESETS.map((preset) => preset.presetKey).sort();
  assert.deepEqual(keys, ["accountant", "inventory_manager", "sales_manager", "warehouse_employee"]);
});

test("a custom role replaces the system matrix, in both directions", () => {
  const narrowed = resolveCapabilities("admin", { capabilities: ["view_reports"], active: true });
  assert.deepEqual(narrowed, ["view_reports"], "an admin can be reduced to one permission");

  const widened = resolveCapabilities("viewer", { capabilities: ["sell", "apply_discount"], active: true });
  assert.deepEqual(widened, ["sell", "apply_discount"], "a viewer can be given the register");

  assert.deepEqual(resolveCapabilities("cashier", null), capabilitiesOf("cashier"), "no overlay → the matrix");
  assert.deepEqual(
    resolveCapabilities("cashier", { capabilities: ["sell"], active: false }),
    capabilitiesOf("cashier"),
    "a deactivated overlay falls back to the matrix",
  );
  assert.deepEqual(resolveCapabilities("", null), [], "signed out resolves to nothing");
});

test("unknown capabilities are dropped by sanitising and refused by validation", () => {
  assert.deepEqual(sanitizeCapabilities(["sell", "not_a_capability", "sell"]), ["sell"]);
  const verdict = validateCustomRoleDraft({
    key: "bad_role",
    name_en: "Bad",
    name_ar: "سيء",
    description_en: "",
    description_ar: "",
    base_role: "viewer",
    capabilities: ["sell", "not_a_capability"] as never,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "unknown_capability");
});

// ── password policy ──────────────────────────────────────────────────────────

test("the password policy refuses the obvious and accepts the adequate", () => {
  assert.equal(evaluatePassword("alyq1234").ok, false, "the app's own demo password is on the denylist");
  assert.equal(evaluatePassword("short1").ok, false, "too short");
  assert.equal(evaluatePassword("allletters").ok, false, "no digit");
  assert.equal(evaluatePassword("12345678").ok, false, "no letter (and common)");
  assert.equal(evaluatePassword("cashier123", "cashier").ok, false, "contains the username");
  assert.equal(evaluatePassword("Till@2026x").ok, true, "a reasonable password passes");
  assert.equal(evaluatePassword("Till@2026x").score, 5, "every rule passed");
});

// ── user form validation ─────────────────────────────────────────────────────

test("the user form refuses what the database would refuse", () => {
  const context = { mode: "demo" as const, existing: [] as ManagedUser[], roles: [], requirePassword: true };

  const blank = validateUserForm(userForm(), context);
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.name && blank.errors.username && blank.errors.role && blank.errors.password);

  const badUsername = validateUserForm(
    userForm({ name: "Sara Nour", username: "Sara Nour!", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    context,
  );
  assert.equal(badUsername.ok, false);
  assert.equal(badUsername.errors.username, "settings.user.error.username_pattern");

  const normalized = validateUserForm(
    userForm({ name: "Sara Nour", username: " Sara.Nour ", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    context,
  );
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value?.username, "sara.nour", "a username is normalised, not rejected, when it can be");

  const mismatch = validateUserForm(
    userForm({ name: "Sara Nour", username: "sara", role: "cashier", password: "Till@2026x", confirmPassword: "other" }),
    context,
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.errors.confirmPassword, "settings.user.error.password_mismatch");

  // Live mode needs an address: it is the provider's identity, and without it
  // there is no account to sign into and no way to send a reset link.
  const liveNoEmail = validateUserForm(
    userForm({ name: "Sara Nour", username: "sara", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { ...context, mode: "supabase" },
  );
  assert.equal(liveNoEmail.ok, false);
  assert.equal(liveNoEmail.errors.email, "settings.user.error.email_required");

  const taken = validateUserForm(
    userForm({ name: "Sara Nour", username: "admin", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    {
      ...context,
      existing: [{ id: "user-admin", username: "admin", name: "A", email: null, phone: null, role: "admin", active: true, custom_role_id: null, custom_role_name: null, created_at: null, last_login_at: null }],
    },
  );
  assert.equal(taken.ok, false);
  assert.equal(taken.errors.username, "settings.user.error.username_taken");
});

test("an editing form does not demand a password, and a dead overlay is refused", () => {
  const editing = validateUserForm(
    userForm({ id: "u1", name: "Sara Nour", username: "sara", role: "cashier" }),
    { mode: "demo", existing: [], roles: [], requirePassword: false },
  );
  assert.equal(editing.ok, true, "editing contact details needs no password");

  const deadOverlay = validateUserForm(
    userForm({ id: "u1", name: "Sara Nour", username: "sara", role: "cashier", custom_role_id: "gone" }),
    {
      mode: "demo",
      existing: [],
      roles: [{ id: "gone", key: "gone", name_en: "Gone", name_ar: " gone", description_en: null, description_ar: null, base_role: "viewer", capabilities: ["view_reports"], active: false, is_system: false, created_by: null, created_by_name: null, created_at: "", updated_at: "" }],
      requirePassword: false,
    },
  );
  assert.equal(deadOverlay.ok, false);
  assert.equal(deadOverlay.errors.custom_role_id, "settings.user.error.custom_role");
});

// ── role form validation ─────────────────────────────────────────────────────

test("the role form delegates to the one rule set, and fills the gaps it should", () => {
  const draft = roleFormToDraft(roleForm({ name_en: "Sales Manager", base_role: null, capabilities: ["sell"] }));
  assert.equal(draft.key, "sales_manager", "a key is generated from the name");
  assert.equal(draft.name_ar, "Sales Manager", "an empty Arabic name falls back rather than failing NOT NULL");
  assert.equal(draft.base_role, "viewer", "an unchosen base is the least privileged role, never admin");

  const empty = validateRoleForm(roleForm(), { existing: [] });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.name_en, "a blank name is reported against its field");

  const noCaps = validateRoleForm(roleForm({ name_en: "Ghost", base_role: "cashier" }), { existing: [] });
  assert.equal(noCaps.ok, false);
  assert.equal(noCaps.errors.capabilities, "settings.role.error.no_capabilities");

  const good = validateRoleForm(ACCOUNTANT_FORM, { existing: [] });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.equal(good.value?.key, "accountant");

  const clash = validateRoleForm(ACCOUNTANT_FORM, {
    existing: [{ id: "role-1", key: "accountant" } as never],
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.errors.key, "settings.role.error.duplicate_key");
});

// ── the offline path, end to end ─────────────────────────────────────────────

test("a created account appears in the directory and can sign in", async () => {
  resetAll();
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );

  assert.equal(created.username, "sara.nour");
  assert.equal(created.role, "cashier");
  assert.equal(created.active, true);
  assert.ok(created.id, "the account has an id");

  const listed = await loadManagedUsers();
  assert.ok(listed.some((user) => user.id === created.id), "the new account is in the list");
  assert.ok(findStaffByUsername("sara.nour"), "and in the directory the login screen reads");

  const signIn = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(signIn.ok, true, "the new account can sign in");
  if (signIn.ok) assert.deepEqual(signIn.user.capabilities, capabilitiesOf("cashier"));

  const wrong = await getDemoUserRepository().authenticate("sara.nour", "alyq1234");
  assert.equal(wrong.ok, false, "and not with somebody else's password");
});

test("a password is stored as a salt and digests, never in clear text", async () => {
  resetAll();
  await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );

  const raw = JSON.stringify([...store.values()]);
  assert.equal(raw.includes("Till@2026x"), false, "the password appears nowhere in storage");

  const entry = findStaffByUsername("sara.nour");
  assert.ok(entry?.verifier, "a verifier was written");
  assert.ok(entry.verifier.salt && entry.verifier.fallback, "salted and digested");
  assert.equal(await verifyPassword("Till@2026x", entry.verifier), true);
});

test("a deactivated account cannot sign in, and says why", async () => {
  resetAll();
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );

  const listed = await loadManagedUsers();
  const off = await setUserActive(created.id, false, { existing: listed, roles: [] });
  assert.equal(off.active, false);

  const attempt = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(attempt.ok, false);
  if (!attempt.ok) {
    // Not "invalid credentials": the password was right, and telling the person
    // to try again would send them round in circles.
    assert.equal(attempt.code, "user_inactive");
  }

  const back = await setUserActive(created.id, true, { existing: await loadManagedUsers(), roles: [] });
  assert.equal(back.active, true);
  assert.equal((await getDemoUserRepository().authenticate("sara.nour", "Till@2026x")).ok, true);
});

test("an admin reset replaces the password and the old one stops working", async () => {
  resetAll();
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "cashier", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );
  const listed = await loadManagedUsers();

  await resetUserPassword(created.id, "Fresh@2027x", "Fresh@2027x", { existing: listed, roles: [] });

  const auth = getDemoUserRepository();
  assert.equal((await auth.authenticate("sara.nour", "Till@2026x")).ok, false, "the old password is dead");
  assert.equal((await auth.authenticate("sara.nour", "Fresh@2027x")).ok, true, "the new one works");

  await assert.rejects(
    () => resetUserPassword(created.id, "alyq1234", "alyq1234", { existing: listed, roles: [] }),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION",
    "the policy applies to an admin reset too",
  );
  await assert.rejects(
    () => resetUserPassword(created.id, "Fresh@2027x", "different1", { existing: listed, roles: [] }),
    (error: unknown) => error instanceof AppError && error.field === "confirmPassword",
    "and so does the confirmation",
  );
});

test("a custom role changes exactly what its wearer may do", async () => {
  resetAll();
  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  assert.equal(role.capabilities.length, 5);
  assert.equal(role.base_role, "viewer");

  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );

  const assigned = await assignCustomRole(created.id, role.id, {
    existing: await loadManagedUsers(),
    roles: await loadManagedRoles(),
  });
  assert.equal(assigned.custom_role_id, role.id);
  assert.equal(assigned.custom_role_name, "Accountant");

  const signIn = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(signIn.ok, true);
  if (signIn.ok) {
    assert.deepEqual(
      [...signIn.user.capabilities].sort(),
      [...role.capabilities].sort(),
      "the overlay replaces the matrix",
    );
    assert.ok(signIn.user.capabilities.includes("export_reports"), "a viewer may now export reports");
    assert.ok(!signIn.user.capabilities.includes("manage_users"), "and still cannot manage users");
  }

  // Switching the overlay off degrades the account to its base matrix — never to
  // nothing, and never to the overlay it just lost.
  await setRoleActive(role.id, false, { existing: await loadManagedRoles() });
  const after = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.deepEqual(after.user.capabilities, capabilitiesOf("viewer"));
    assert.ok(!after.user.capabilities.includes("export_reports") || capabilitiesOf("viewer").includes("export_reports"));
  }
});

test("editing a role changes what its wearers may do at their next session", async () => {
  resetAll();
  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x", custom_role_id: role.id }),
    // The context has to contain the role being assigned: validation refuses an
    // overlay it cannot see, which is the same refusal the database makes.
    { existing: [], roles: [role] },
  );
  assert.equal(created.custom_role_id, role.id);

  const before = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(before.ok, true);
  if (before.ok) assert.ok(before.user.capabilities.includes("approve_expense"));

  await updateRoleForTest(role.id, ["view_reports"]);

  const after = await getDemoUserRepository().authenticate("sara.nour", "Till@2026x");
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.deepEqual(after.user.capabilities, ["view_reports"], "the wearer follows the edit");
    assert.ok(!after.user.capabilities.includes("approve_expense"), "a removed permission is really gone");
  }
});

/** Update through the service, the way the screen does. */
async function updateRoleForTest(id: string, capabilities: string[]): Promise<void> {
  const existing = await loadManagedRoles();
  const role = existing.find((entry) => entry.id === id);
  assert.ok(role, "the role exists");
  await updateRole(
    {
      id: role.id,
      key: role.key,
      name_en: role.name_en,
      name_ar: role.name_ar,
      description_en: role.description_en ?? "",
      description_ar: role.description_ar ?? "",
      base_role: role.base_role,
      capabilities: capabilities as never,
      active: true,
    },
    { existing },
  );
}

test("a hand-edited system role clears the overlay, and an overlay sets the base", async () => {
  resetAll();
  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x", custom_role_id: role.id }),
    { existing: [], roles: [role] },
  );
  assert.equal(created.role, role.base_role, "assigning an overlay moves the system role to its base");

  // The form still carries the overlay id, but the admin changed the *system*
  // role: the two would contradict each other, so the overlay goes. This is what
  // `admin_upsert_staff_profile` does in SQL, and the demo repository does the
  // same, so the two modes cannot drift apart on a question this consequential.
  const updated = await updateUser(
    userForm({ id: created.id, name: "Sara Nour", username: "sara.nour", role: "cashier", custom_role_id: role.id }),
    { existing: await loadManagedUsers(), roles: await loadManagedRoles() },
  );
  assert.equal(updated.custom_role_id, null, "the overlay is cleared");
  assert.equal(updated.role, "cashier", "and the chosen system role stands");

  // Re-assigning puts the base back to what the overlay says.
  const reassigned = await assignCustomRole(created.id, role.id, {
    existing: await loadManagedUsers(),
    roles: await loadManagedRoles(),
  });
  assert.equal(reassigned.custom_role_id, role.id);
  assert.equal(reassigned.role, role.base_role);

  // Clearing the overlay leaves the system role untouched: the person keeps a
  // known, safe set of permissions rather than falling to nothing.
  const cleared = await updateUser(
    userForm({ id: created.id, name: "Sara Nour", username: "sara.nour", role: "manager", custom_role_id: null }),
    { existing: await loadManagedUsers(), roles: await loadManagedRoles() },
  );
  assert.equal(cleared.custom_role_id, null);
  assert.equal(cleared.role, "manager");
});

// ── enforcement ──────────────────────────────────────────────────────────────

test("a cashier is refused by the service, not merely hidden from", async () => {
  resetAll("cashier");
  await assert.rejects(
    () => loadManagedUsers(),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    () => loadManagedRoles(),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    () =>
      createUser(
        userForm({ name: "Back Door", username: "back.door", role: "admin", password: "Till@2026x", confirmPassword: "Till@2026x" }),
        { existing: [], roles: [] },
      ),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    "creating an admin account is the most dangerous thing a cashier could try",
  );
  assert.equal(readStaffDirectory().some((entry) => entry.username === "back.door"), false, "nothing was written");
});

test("an admin cannot lock themselves out", async () => {
  resetAll();
  const admin = DEMO_USERS.find((user) => user.role === "admin");
  assert.ok(admin);
  const listed = await loadManagedUsers();
  const self = listed.find((user) => user.id === admin.id);
  assert.ok(self, "the signed-in admin is in the directory");

  await assert.rejects(
    () => setUserActive(self.id, false, { existing: listed, roles: [] }),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    "deactivating yourself is refused",
  );

  await assert.rejects(
    () =>
      updateUser(
        userForm({ id: self.id, name: self.name, username: self.username, role: "cashier" }),
        { existing: listed, roles: [] },
      ),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    "demoting yourself is refused",
  );

  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  await assert.rejects(
    () => assignCustomRole(self.id, role.id, { existing: listed, roles: [role] }),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    "changing your own authority mid-session is refused",
  );

  const stillAdmin = await loadManagedUsers();
  assert.equal(stillAdmin.find((user) => user.id === self.id)?.role, "admin", "and the account is untouched");
});

test("a duplicate username is refused by the repository, not only by the form", async () => {
  resetAll();
  await assert.rejects(
    () =>
      repository().createUser({
        name: "Impostor",
        username: "admin",
        email: "",
        phone: "",
        role: "cashier",
        password: "Till@2026x",
        active: true,
        custom_role_id: null,
      }),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION" && error.field === "username",
  );
});

test("a role with no permissions cannot be stored", async () => {
  resetAll();
  await assert.rejects(
    () => repository().createCustomRole({ key: "empty_role", name_en: "Empty", name_ar: "فارغ", description_en: "", description_ar: "", base_role: "viewer", capabilities: [], active: true }),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION",
  );
  assert.equal(readCustomRoles().length, 0);
});

// ── auditing ─────────────────────────────────────────────────────────────────

test("every administration action leaves an audit entry", async () => {
  resetAll();
  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  const created = await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x" }),
    { existing: [], roles: [] },
  );
  await assignCustomRole(created.id, role.id, { existing: await loadManagedUsers(), roles: [role] });
  await resetUserPassword(created.id, "Fresh@2027x", "Fresh@2027x", { existing: await loadManagedUsers(), roles: [] });
  await setUserActive(created.id, false, { existing: await loadManagedUsers(), roles: [] });
  await setRoleActive(role.id, false, { existing: await loadManagedRoles() });

  // Auditing is fire-and-forget by design (it must never block the action it
  // describes), so give the writes a moment to land before reading them back.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const entries = await getDemoAuditRepository().listEntries();
  const actions = entries.map((entry) => entry.action);

  for (const expected of [
    "role.created",
    "user.created",
    "user.role_changed",
    "user.password_reset",
    "user.deactivated",
    "role.deactivated",
  ]) {
    assert.ok(actions.includes(expected as never), `${expected} was recorded (saw: ${actions.join(", ")})`);
  }

  const reset = entries.find((entry) => entry.action === "user.password_reset");
  assert.ok(reset, "the reset entry exists");
  assert.equal(JSON.stringify(reset.details).includes("Fresh@2027x"), false, "and carries no password");
  assert.equal(reset.user_name, "ALYQ Admin", "attributed to the admin who did it");
});

// ── querying ─────────────────────────────────────────────────────────────────

test("the user list filters, sorts and summarises without a round trip", async () => {
  resetAll();
  const users = await loadManagedUsers();
  assert.equal(users.length, 5, "the five shipped accounts");

  assert.equal(queryUsers(users, { ...EMPTY_USER_FILTERS, role: "cashier" }).length, 1);
  assert.equal(queryUsers(users, { ...EMPTY_USER_FILTERS, status: "active" }).length, 5);
  assert.equal(queryUsers(users, { ...EMPTY_USER_FILTERS, custom_role_id: "none" }).length, 5);
  assert.equal(queryUsers(users, { ...EMPTY_USER_FILTERS, search: "admin" }).length, 1);
  assert.equal(queryUsers(users, { ...EMPTY_USER_FILTERS, search: "nothing matches this" }).length, 0);

  const byName = sortUsers(users, DEFAULT_USER_SORT).map((user) => user.name);
  assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)), "ascending by name");
  const reversed = sortUsers(users, { key: "name", direction: "desc" }).map((user) => user.name);
  assert.deepEqual(reversed, [...byName].reverse());

  const summary = summarizeUsers(users);
  assert.equal(summary.total, 5);
  assert.equal(summary.active, 5);
  assert.equal(summary.inactive, 0);
  assert.equal(summary.neverSignedIn, 5, "nobody has signed in yet in a fresh directory");
  assert.equal(summary.byRole.admin, 1);

  // Sorting must not mutate the caller's array: the table re-renders from it.
  const snapshot = [...users];
  sortUsers(users, { key: "username", direction: "desc" });
  assert.deepEqual(users, snapshot);
});

test("assignments are counted per role, for the deactivation warning", async () => {
  resetAll();
  const role = await createRole(ACCOUNTANT_FORM, { existing: [] });
  await createUser(
    userForm({ name: "Sara Nour", username: "sara.nour", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x", custom_role_id: role.id }),
    { existing: [], roles: [role] },
  );
  await createUser(
    userForm({ name: "Mohamed Ali", username: "mohamed.ali", role: "viewer", password: "Till@2026x", confirmPassword: "Till@2026x", custom_role_id: role.id }),
    { existing: await loadManagedUsers(), roles: [role] },
  );

  const users = await loadManagedUsers();
  assert.equal(countRoleAssignments(users, role.id), 2);
  assert.equal(countRoleAssignments(users, "no-such-role"), 0);
});

test("signing out clears the session the checks depend on", async () => {
  resetAll();
  assert.equal((await loadManagedUsers()).length, 5);
  await signOut();
  await assert.rejects(
    () => loadManagedUsers(),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    "a signed-out caller is refused, not served an empty list",
  );
});

test("a verifier built offline verifies in either digest mode", async () => {
  const verifier = await createVerifier("Till@2026x");
  assert.equal(await verifyPassword("Till@2026x", verifier), true);
  assert.equal(await verifyPassword("till@2026x", verifier), false, "case-sensitive");
  assert.notEqual(verifier.salt, (await createVerifier("Till@2026x")).salt, "each password gets its own salt");
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
    console.error(`${failed}/${tests.length} settings tests FAILED.`);
    process.exit(1);
  }
  console.log(`${tests.length}/${tests.length} Phase 10 settings tests passed.`);
})();

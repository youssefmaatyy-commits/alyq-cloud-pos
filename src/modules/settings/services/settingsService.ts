/**
 * Settings service — every administration action, gated and recorded.
 *
 * This is the layer the specification means by "permissions must be enforced in
 * the services, not only in the UI". A button hidden by `hasCapability` is a
 * courtesy; these functions are the wall. Each one, in order:
 *
 *   1. asserts the capability the acting user needs (`assertCapability`, which
 *      reads the resolved list on the session — custom roles included);
 *   2. validates the submitted form with the same rules the form itself used;
 *   3. applies the self-protection guardrails, so an admin cannot lock
 *      themselves out of their own installation;
 *   4. calls the repository — which in live mode is an RPC that checks
 *      `public.can(...)` a fourth time, server-side;
 *   5. writes an audit entry describing what changed.
 *
 * The guardrails in (3) are restated in SQL (`admin_upsert_staff_profile` refuses
 * to drop the caller's own admin role or deactivate the caller's own account,
 * `admin_set_custom_role` refuses to touch the caller's row). Restating them here
 * is not distrust of the database: it is what makes the *demo* installation
 * behave the same way, and it turns a database exception into a sentence in the
 * admin's own language.
 *
 * Auditing lives here rather than in the repository so that one action produces
 * one entry, whichever mode is running.
 */
import { AppError } from "@/modules/products/data/repository";
import { recordAudit } from "@/modules/audit/services/auditService";
import { actingUser, assertCapability } from "@/lib/permissions/enforce";
import { broadcastAuth } from "@/lib/auth/services/authEvents";
import type { CustomRole } from "@/lib/permissions/customRoles";
import type { AuthUser } from "@/lib/auth/types";
import { getSettingsMode, getSettingsRepository } from "../data";
import type { CustomRoleInput } from "../data/repository";
import { validateRoleForm, validateUserForm, type RoleFormContext, type UserFormContext } from "../validation";
import { evaluatePassword } from "@/lib/auth/services/passwordPolicy";
import type { ManagedUser, RoleFormState, UserFormState, UserPatch } from "../types";

// ── reads ────────────────────────────────────────────────────────────────────

/** The user list. Gated: an account directory is not a public read. */
export async function loadManagedUsers(): Promise<ManagedUser[]> {
  assertCapability("manage_users");
  return getSettingsRepository().listUsers();
}

/** The custom-role list. Gated separately: roles are the authority model itself. */
export async function loadManagedRoles(): Promise<CustomRole[]> {
  assertCapability("manage_roles");
  return getSettingsRepository().listCustomRoles();
}

// ── contexts ─────────────────────────────────────────────────────────────────

export interface UserMutationContext {
  /** Everyone, so uniqueness can be checked without another read. */
  existing: ManagedUser[];
  /** Roles that may be assigned. */
  roles: CustomRole[];
}

function userContext(context: UserMutationContext, requirePassword: boolean): UserFormContext {
  return { mode: getSettingsMode(), existing: context.existing, roles: context.roles, requirePassword };
}

export interface RoleMutationContext {
  existing: CustomRole[];
}

// ── guardrails ───────────────────────────────────────────────────────────────

/**
 * The three ways an admin can lock themselves out, refused before any write.
 *
 * Each maps to a SQL guard in migration 0021; the messages are the reason the
 * check is repeated here, because "You cannot deactivate your own account" is a
 * sentence an admin can act on and `insufficient_privilege` is not.
 */
function assertNotSelfLockout(targetId: string, change: { active?: boolean; role?: string; custom_role_id?: string | null }, actor: AuthUser): void {
  if (!actor.id || targetId !== actor.id) return;

  if (change.active === false) {
    throw new AppError("FORBIDDEN", "You cannot deactivate your own account", "active");
  }
  if (change.role && change.role !== "admin" && actor.role === "admin") {
    throw new AppError("FORBIDDEN", "You cannot remove your own admin role", "role");
  }
  if (change.custom_role_id !== undefined && change.custom_role_id !== null) {
    // Changing your own authority mid-session is how an installation ends up
    // with nobody who can administer it.
    throw new AppError("FORBIDDEN", "You cannot change your own role", "custom_role_id");
  }
}

/** A shipped role is not editable: it is the model the matrix is documented against. */
function assertEditableRole(role: CustomRole | undefined, id: string): void {
  if (!role) throw new AppError("NOT_FOUND", `No such custom role: ${id}`);
  if (role.is_system) {
    throw new AppError("FORBIDDEN", "A system role cannot be edited", "key");
  }
}

// ── accounts ─────────────────────────────────────────────────────────────────

export async function createUser(form: UserFormState, context: UserMutationContext): Promise<ManagedUser> {
  assertCapability("manage_users");

  const verdict = validateUserForm({ ...form, id: null }, userContext(context, true));
  if (!verdict.ok || !verdict.value) {
    const [field, key] = Object.entries(verdict.errors)[0] ?? ["form", "settings.user.error.name"];
    throw new AppError("VALIDATION", String(key), field);
  }

  const created = await getSettingsRepository().createUser(verdict.value);
  const actor = actingUser();

  void recordAudit({
    action: "user.created",
    entity: "user",
    entity_id: created.id,
    entity_label: `${created.name} (${created.username})`,
    details: {
      username: created.username,
      email: created.email,
      role: created.role,
      custom_role_id: created.custom_role_id,
      active: created.active,
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  return created;
}

export async function updateUser(form: UserFormState, context: UserMutationContext): Promise<ManagedUser> {
  assertCapability("manage_users");
  if (!form.id) throw new AppError("VALIDATION", "No user selected", "form");

  const before = context.existing.find((user) => user.id === form.id);
  if (!before) throw new AppError("NOT_FOUND", `No such user: ${form.id}`);

  const verdict = validateUserForm(form, userContext(context, false));
  if (!verdict.ok || !verdict.value) {
    const [field, key] = Object.entries(verdict.errors)[0] ?? ["form", "settings.user.error.name"];
    throw new AppError("VALIDATION", String(key), field);
  }

  const actor = actingUser();
  const value = verdict.value;
  const patch: UserPatch = {};
  if (value.name !== before.name) patch.name = value.name;
  if (value.username !== before.username) patch.username = value.username;
  if (value.email !== (before.email ?? "")) patch.email = value.email;
  if (value.phone !== (before.phone ?? "")) patch.phone = value.phone;
  if (value.active !== before.active) patch.active = value.active;

  // A custom role is assigned under `manage_roles`: it changes what the person
  // can do, which is a different authority from changing their contact details.
  const roleChanged = value.custom_role_id !== before.custom_role_id || value.role !== before.role;
  if (value.custom_role_id !== before.custom_role_id) {
    assertCapability("manage_roles");
    patch.custom_role_id = value.custom_role_id;
  }
  if (value.role !== before.role) patch.role = value.role;

  assertNotSelfLockout(before.id, patch, actor);

  if (Object.keys(patch).length === 0) return before;

  const updated = await getSettingsRepository().updateUser(before.id, patch);
  void auditUserChange(before, updated, roleChanged, actor);
  if (roleChanged || patch.active !== undefined) announceIdentityChange();

  return updated;
}

export async function setUserActive(
  id: string,
  active: boolean,
  context: UserMutationContext,
): Promise<ManagedUser> {
  assertCapability("manage_users");
  const before = context.existing.find((user) => user.id === id);
  if (!before) throw new AppError("NOT_FOUND", `No such user: ${id}`);

  const actor = actingUser();
  assertNotSelfLockout(id, { active }, actor);
  if (before.active === active) return before;

  const updated = await getSettingsRepository().setUserActive(id, active);
  void auditUserChange(before, updated, false, actor);
  // Someone else's tab may be signed in as this person; tell it to re-check.
  announceIdentityChange();
  return updated;
}

export async function assignCustomRole(
  id: string,
  customRoleId: string | null,
  context: UserMutationContext,
): Promise<ManagedUser> {
  assertCapability("manage_users");
  assertCapability("manage_roles");

  const before = context.existing.find((user) => user.id === id);
  if (!before) throw new AppError("NOT_FOUND", `No such user: ${id}`);
  if (customRoleId && !context.roles.some((role) => role.id === customRoleId && role.active)) {
    throw new AppError("VALIDATION", "Unknown or deactivated custom role", "custom_role_id");
  }

  const actor = actingUser();
  assertNotSelfLockout(id, { custom_role_id: customRoleId }, actor);
  if (before.custom_role_id === customRoleId) return before;

  const updated = await getSettingsRepository().assignCustomRole(id, customRoleId);
  void auditUserChange(before, updated, true, actor);
  announceIdentityChange();
  return updated;
}

/**
 * Admin password reset.
 *
 * The policy is applied here as well as in the form, because this is the path
 * that decides what a person's next password will be. Live mode hands the value
 * to the edge function, which hands it to `auth.admin.updateUserById`; demo mode
 * writes a fresh salt and digests into the directory. Neither stores the
 * password itself.
 */
export async function resetUserPassword(
  id: string,
  password: string,
  confirmPassword: string,
  context: UserMutationContext,
): Promise<void> {
  assertCapability("manage_users");

  const target = context.existing.find((user) => user.id === id);
  if (!target) throw new AppError("NOT_FOUND", `No such user: ${id}`);
  if (password !== confirmPassword) {
    throw new AppError("VALIDATION", "settings.user.error.password_mismatch", "confirmPassword");
  }

  const verdict = evaluatePassword(password, target.username);
  if (!verdict.ok) {
    const failed = verdict.rules.find((rule) => !rule.ok);
    throw new AppError(
      "VALIDATION",
      `settings.password.rule.${failed?.key ?? "length"}`,
      "password",
    );
  }

  await getSettingsRepository().resetUserPassword(id, password);
  const actor = actingUser();

  void recordAudit({
    action: "user.password_reset",
    entity: "user",
    entity_id: target.id,
    entity_label: `${target.name} (${target.username})`,
    // The new password is never part of an audit entry — only the fact that an
    // admin set one, and who they are.
    details: { by_admin: true, username: target.username },
    user_id: actor.id,
    user_name: actor.name,
  });
  announceIdentityChange();
}

// ── custom roles ─────────────────────────────────────────────────────────────

export async function createRole(form: RoleFormState, context: RoleMutationContext): Promise<CustomRole> {
  assertCapability("manage_roles");

  const verdict = validateRoleForm({ ...form, id: null }, context as RoleFormContext);
  if (!verdict.ok || !verdict.value) {
    const [field, key] = Object.entries(verdict.errors)[0] ?? ["form", "settings.role.error.blank_name_en"];
    throw new AppError("VALIDATION", String(key), field);
  }

  const input: CustomRoleInput = verdict.value;
  const created = await getSettingsRepository().createCustomRole(input);
  const actor = actingUser();

  void recordAudit({
    action: "role.created",
    entity: "custom_role",
    entity_id: created.id,
    entity_label: created.name_en,
    details: {
      key: created.key,
      base_role: created.base_role,
      capabilities: created.capabilities.join(","),
      capability_count: created.capabilities.length,
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  return created;
}

export async function updateRole(form: RoleFormState, context: RoleMutationContext): Promise<CustomRole> {
  assertCapability("manage_roles");
  if (!form.id) throw new AppError("VALIDATION", "No role selected", "form");

  assertEditableRole(context.existing.find((role) => role.id === form.id), form.id);

  const verdict = validateRoleForm(form, context as RoleFormContext);
  if (!verdict.ok || !verdict.value) {
    const [field, key] = Object.entries(verdict.errors)[0] ?? ["form", "settings.role.error.blank_name_en"];
    throw new AppError("VALIDATION", String(key), field);
  }

  const before = context.existing.find((role) => role.id === form.id) as CustomRole;
  const updated = await getSettingsRepository().updateCustomRole(form.id, verdict.value);
  const actor = actingUser();

  void recordAudit({
    action: "role.updated",
    entity: "custom_role",
    entity_id: updated.id,
    entity_label: updated.name_en,
    details: {
      key: updated.key,
      name_before: before.name_en,
      base_role: updated.base_role,
      capabilities: updated.capabilities.join(","),
      capability_count: updated.capabilities.length,
      // What was taken away matters more than what was added when someone is
      // debugging "why can the accountant no longer export?"
      capabilities_removed: before.capabilities.filter((c) => !updated.capabilities.includes(c)).join(","),
      capabilities_added: updated.capabilities.filter((c) => !before.capabilities.includes(c)).join(","),
    },
    user_id: actor.id,
    user_name: actor.name,
  });

  // People wearing this role have a stale capability list until their session is
  // re-resolved; other tabs hear this and re-read.
  announceIdentityChange();
  return updated;
}

export async function setRoleActive(
  id: string,
  active: boolean,
  context: RoleMutationContext,
): Promise<CustomRole> {
  assertCapability("manage_roles");

  const role = context.existing.find((entry) => entry.id === id);
  assertEditableRole(role, id);
  if (!role || role.active === active) return role as CustomRole;

  const updated = await getSettingsRepository().setCustomRoleActive(id, active);
  const actor = actingUser();

  void recordAudit({
    action: active ? "role.activated" : "role.deactivated",
    entity: "custom_role",
    entity_id: updated.id,
    entity_label: updated.name_en,
    details: { key: updated.key, active: updated.active },
    user_id: actor.id,
    user_name: actor.name,
  });

  announceIdentityChange();
  return updated;
}

/**
 * How many accounts wear a role. Used by the confirm dialog, because
 * deactivating a role silently degrades everyone wearing it to its base matrix —
 * an admin should see the number before agreeing.
 */
export function countRoleAssignments(users: ManagedUser[], roleId: string): number {
  return users.filter((user) => user.custom_role_id === roleId).length;
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * One entry per meaningful change. A role change is recorded twice — once as an
 * update and once as `user.role_changed` — because the audit log is filtered by
 * action, and "who changed this person's authority?" is a question an auditor
 * asks directly.
 */
function auditUserChange(
  before: ManagedUser,
  after: ManagedUser,
  roleChanged: boolean,
  actor: AuthUser,
): void {
  const changed: Record<string, string> = {};
  if (before.name !== after.name) changed.name = `${before.name} → ${after.name}`;
  if (before.username !== after.username) changed.username = `${before.username} → ${after.username}`;
  if (before.email !== after.email) changed.email = `${before.email ?? "—"} → ${after.email ?? "—"}`;
  if (before.phone !== after.phone) changed.phone = `${before.phone ?? "—"} → ${after.phone ?? "—"}`;
  if (before.role !== after.role) changed.role = `${before.role} → ${after.role}`;
  if (before.custom_role_id !== after.custom_role_id) {
    changed.custom_role = `${before.custom_role_name ?? "—"} → ${after.custom_role_name ?? "—"}`;
  }

  const label = `${after.name} (${after.username})`;

  if (before.active !== after.active) {
    void recordAudit({
      action: after.active ? "user.activated" : "user.deactivated",
      entity: "user",
      entity_id: after.id,
      entity_label: label,
      details: { username: after.username, role: after.role },
      user_id: actor.id,
      user_name: actor.name,
    });
    return;
  }

  if (roleChanged) {
    void recordAudit({
      action: "user.role_changed",
      entity: "user",
      entity_id: after.id,
      entity_label: label,
      details: {
        username: after.username,
        role_before: before.role,
        role_after: after.role,
        custom_role_before: before.custom_role_id,
        custom_role_after: after.custom_role_id,
      },
      user_id: actor.id,
      user_name: actor.name,
    });
  }

  if (Object.keys(changed).length === 0) return;
  void recordAudit({
    action: "user.updated",
    entity: "user",
    entity_id: after.id,
    entity_label: label,
    details: { username: after.username, ...changed },
    user_id: actor.id,
    user_name: actor.name,
  });
}

/**
 * Tell every other tab that identity data changed, so a session that is now
 * wrong (deactivated account, edited role) is re-resolved instead of being
 * trusted until the next reload.
 */
function announceIdentityChange(): void {
  broadcastAuth({ kind: "session_changed", at: new Date().toISOString() });
}

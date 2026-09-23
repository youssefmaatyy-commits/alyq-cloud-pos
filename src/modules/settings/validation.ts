/**
 * Settings validation — the rules an account or a role must satisfy.
 *
 * These run twice on purpose: in the form (so the admin sees the problem before
 * submitting) and again in `services/settingsService.ts` (so a caller that
 * skips the form — a script, a future API, a stale tab — meets the same wall).
 * The database repeats them a third time: `admin_upsert_staff_profile` refuses an
 * empty username, `admin_create_custom_role` refuses an unknown capability.
 * Three layers agreeing is the point; three layers *differing* is how an
 * installation ends up with an account nobody can sign into.
 *
 * Nothing here talks to a repository. Uniqueness is checked against the list the
 * caller passes in, which keeps the rules testable without storage.
 */
import { APP_ROLES, normalizeRole, type AppRole } from "@/lib/permissions/roles";
import {
  normalizeRoleKey,
  validateCustomRoleDraft,
  type CustomRole,
  type CustomRoleDraft,
  type CustomRoleErrorCode,
} from "@/lib/permissions/customRoles";
import type {
  FieldErrors,
  ManagedUser,
  NewUserInput,
  RoleFormState,
  UserFormState,
  ValidationResult,
} from "./types";
import { evaluatePassword } from "@/lib/auth/services/passwordPolicy";

/**
 * Usernames are the sign-in handle, and in live mode they are also the local
 * part of the synthetic auth email (`sales.lead@alyq.local`). That is why the
 * character set is this narrow: anything else would produce an address Supabase
 * rejects, and the failure would arrive as "invalid credentials" — the worst
 * possible place to discover a typo made three screens ago.
 */
const USERNAME_PATTERN = /^[a-z0-9._-]{2,64}$/;
/** Loose on purpose: the provider is the authority on deliverability, not us. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Egyptian numbers arrive as +20…, 01…, and with spaces or dashes. */
const PHONE_PATTERN = /^\+?[0-9 ()-]{7,20}$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ".");
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string): string {
  return value.trim().replace(/[^\d+]/g, "");
}

export interface UserFormContext {
  /** Live mode needs an email because that is the provider's identity. */
  mode: "demo" | "supabase";
  /** Everyone else, for uniqueness. Pass the list the screen already has. */
  existing: ManagedUser[];
  /** Custom roles that may be assigned. */
  roles: CustomRole[];
  /** False when editing and the password is not being changed. */
  requirePassword: boolean;
}

export function validateUserForm(
  form: UserFormState,
  context: UserFormContext,
): ValidationResult<NewUserInput> {
  const errors: FieldErrors = {};

  const name = form.name.trim();
  if (name.length < 2) errors.name = "settings.user.error.name";

  const username = normalizeUsername(form.username);
  if (!username) {
    errors.username = "settings.user.error.username_required";
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.username = "settings.user.error.username_pattern";
  } else if (username.includes("@")) {
    errors.username = "settings.user.error.username_pattern";
  } else if (
    context.existing.some((user) => user.id !== form.id && user.username.toLowerCase() === username)
  ) {
    errors.username = "settings.user.error.username_taken";
  }

  const email = normalizeEmail(form.email);
  if (!email && context.mode === "supabase") {
    // Without an address there is no auth user to create, and no way to send a
    // reset link later — so the field is required, not merely suggested.
    errors.email = "settings.user.error.email_required";
  } else if (email && !EMAIL_PATTERN.test(email)) {
    errors.email = "settings.user.error.email_pattern";
  } else if (email && context.existing.some((user) => user.id !== form.id && user.email === email)) {
    errors.email = "settings.user.error.email_taken";
  }

  const phone = normalizePhone(form.phone);
  if (phone && !PHONE_PATTERN.test(phone)) errors.phone = "settings.user.error.phone_pattern";

  const role = normalizeRole(form.role);
  if (!role) {
    errors.role = "settings.user.error.role";
  } else if (!APP_ROLES.includes(role)) {
    errors.role = "settings.user.error.role";
  }

  // A custom role must exist and be active: assigning a deactivated overlay
  // would silently fall back to the base matrix, which reads as a bug.
  if (form.custom_role_id) {
    const assigned = context.roles.find((entry) => entry.id === form.custom_role_id);
    if (!assigned || !assigned.active) errors.custom_role_id = "settings.user.error.custom_role";
  }

  const password = form.password;
  if (context.requirePassword) {
    const verdict = evaluatePassword(password, username);
    if (!verdict.ok) {
      const failed = verdict.rules.find((rule) => !rule.ok);
      errors.password = failed ? `settings.password.rule.${failed.key}` : "settings.password.rule.length";
    }
    if (form.confirmPassword !== password) errors.confirmPassword = "settings.user.error.password_mismatch";
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok || !role) return { ok: false, errors };

  return {
    ok: true,
    errors,
    value: {
      name,
      username,
      email,
      phone,
      role: role as AppRole,
      password,
      active: form.active,
      custom_role_id: form.custom_role_id ?? null,
    },
  };
}

export interface RoleFormContext {
  /** Roles already stored, so a key can be checked for uniqueness. */
  existing: CustomRole[];
}

/** Which field a role error code belongs to, and the message key it shows. */
const ROLE_ERROR_FIELDS: Record<CustomRoleErrorCode, keyof RoleFormState> = {
  blank_name_en: "name_en",
  blank_name_ar: "name_ar",
  blank_key: "key",
  invalid_key: "key",
  duplicate_key: "key",
  invalid_base_role: "base_role",
  no_capabilities: "capabilities",
  unknown_capability: "capabilities",
};

/**
 * Turn the role form into the draft the permission layer validates.
 *
 * Two deliberate conversions happen here rather than in the picker:
 *   · an empty Arabic name falls back to the English one, because
 *     `custom_roles.name_ar` is `not null` and a blank cell in an Arabic UI is
 *     worse than a repeated label;
 *   · an unchosen base role becomes `viewer`, the least privileged system role,
 *     because the column is `not null` and the base is what an account degrades
 *     to if the custom role is later switched off. Guessing "admin" there would
 *     be the one truly dangerous default in this module.
 */
export function roleFormToDraft(form: RoleFormState): CustomRoleDraft {
  const name_en = form.name_en.trim();
  return {
    key: normalizeRoleKey(form.key || name_en),
    name_en,
    name_ar: form.name_ar.trim() || name_en,
    description_en: form.description_en.trim(),
    description_ar: form.description_ar.trim(),
    base_role: normalizeRole(form.base_role ?? "") ?? "viewer",
    capabilities: form.capabilities,
  };
}

/**
 * Validate the role form.
 *
 * The rules themselves live in `lib/permissions/customRoles.validateCustomRoleDraft`
 * — the same function the demo store and the `admin_create_custom_role` RPC's
 * `assert_known_capabilities` guard agree with. This wrapper only translates a
 * code into a field and a message key, so there is one rule set, not three.
 */
export function validateRoleForm(
  form: RoleFormState,
  context: RoleFormContext,
): ValidationResult<CustomRoleDraft & { active: boolean }> {
  const draft = roleFormToDraft(form);
  const verdict = validateCustomRoleDraft(draft, context.existing, form.id);

  if (!verdict.ok) {
    const field = ROLE_ERROR_FIELDS[verdict.code] ?? verdict.field ?? "form";
    return { ok: false, errors: { [field]: `settings.role.error.${verdict.code}` } as FieldErrors };
  }

  return { ok: true, errors: {}, value: { ...verdict.value, active: form.active } };
}

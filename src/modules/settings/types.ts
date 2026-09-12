/**
 * Settings module — the vocabulary of user and role administration.
 *
 * Two things live here and nowhere else:
 *
 *   1. The shape an *administrator* works with (`ManagedUser`). It is deliberately
 *      not `AuthUser`: it carries `created_at` and a resolved role label for the
 *      table, and it can never carry a credential. `AuthUser` is what a session
 *      holds; `ManagedUser` is what the Users screen lists.
 *   2. The form states and their validation, so a draft can be checked before a
 *      repository call — and so the same rules run in the browser and in the
 *      service layer, which is the only way "the UI hid it" and "the API refused
 *      it" stay the same decision.
 */
import type { AppRole, Capability } from "@/lib/permissions/roles";

/** A row of Settings → Users. */
export interface ManagedUser {
  id: string;
  username: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: AppRole;
  active: boolean;
  /** Admin-defined overlay, when one is assigned. */
  custom_role_id: string | null;
  /** Resolved for display; never authoritative (the store is). */
  custom_role_name: string | null;
  /**
   * Phase 17: personal grants and denials on top of the role. Empty for nearly
   * everybody; when they are not, the Users screen says so, because a permission
   * nobody can see is a permission nobody will remember to remove.
   */
  extra_capabilities: readonly Capability[];
  denied_capabilities: readonly Capability[];
  created_at: string | null;
  last_login_at: string | null;
}

/** What an admin submits to create an account. */
export interface NewUserInput {
  name: string;
  username: string;
  email: string;
  phone: string;
  role: AppRole;
  /** Required in demo mode; in live mode the edge function sets it on the auth user. */
  password: string;
  active: boolean;
  custom_role_id: string | null;
}

/** What an admin may change on an existing account. */
export interface UserPatch {
  name?: string;
  username?: string;
  email?: string;
  phone?: string;
  role?: AppRole;
  active?: boolean;
  custom_role_id?: string | null;
}

/** The user form, as edited. Empty strings mean "not filled in yet". */
export interface UserFormState {
  id: string | null;
  name: string;
  username: string;
  email: string;
  phone: string;
  role: AppRole | "";
  custom_role_id: string | null;
  active: boolean;
  /** Only meaningful when creating, or when an admin resets a password. */
  password: string;
  confirmPassword: string;
}

export const EMPTY_USER_FORM: UserFormState = {
  id: null,
  name: "",
  username: "",
  email: "",
  phone: "",
  role: "",
  custom_role_id: null,
  active: true,
  password: "",
  confirmPassword: "",
};

/** The role form. `base_role` is the system matrix a custom role starts from. */
export interface RoleFormState {
  id: string | null;
  key: string;
  name_en: string;
  name_ar: string;
  description_en: string;
  description_ar: string;
  base_role: AppRole | null;
  /**
   * Typed as real capabilities rather than strings: the picker is built from
   * `CAPABILITY_GROUPS`, so a value that is not a capability can only arrive from
   * a stored row that predates the catalogue — and `validateCustomRoleDraft`
   * refuses that instead of silently dropping it.
   */
  capabilities: Capability[];
  active: boolean;
}

export const EMPTY_ROLE_FORM: RoleFormState = {
  id: null,
  key: "",
  name_en: "",
  name_ar: "",
  description_en: "",
  description_ar: "",
  base_role: null,
  capabilities: [],
  active: true,
};

/** Field errors, keyed by form field. Values are i18n keys. */
export type FieldErrors = Partial<Record<keyof UserFormState | keyof RoleFormState | "form", string>>;

export interface ValidationResult<T> {
  ok: boolean;
  errors: FieldErrors;
  /** The cleaned value, present only when `ok`. */
  value?: T;
}

/** Filter state for the users table. */
export interface UserFiltersValue {
  search: string;
  role: AppRole | "all";
  status: "all" | "active" | "inactive";
  custom_role_id: string | "all";
}

export const EMPTY_USER_FILTERS: UserFiltersValue = {
  search: "",
  role: "all",
  status: "all",
  custom_role_id: "all",
};

export type UserSortKey = "name" | "username" | "role" | "created_at" | "last_login_at" | "active";

export interface UserSortValue {
  key: UserSortKey;
  direction: "asc" | "desc";
}

export const DEFAULT_USER_SORT: UserSortValue = { key: "name", direction: "asc" };

/**
 * The password-policy vocabulary is re-exported rather than restated: the rules
 * live in `lib/auth` because the reset-link flow uses them too, and two
 * definitions of "strong enough" would eventually disagree.
 */
export type { PasswordRuleKey, PasswordRuleResult, PasswordVerdict } from "@/lib/auth/types";

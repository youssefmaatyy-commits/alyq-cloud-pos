/**
 * Custom roles — the model, and every rule about them that can be decided
 * without a database.
 *
 * Why custom roles sit *beside* the five system roles instead of replacing them:
 *
 *   · `public.app_role` is an enum, and every RLS policy written since
 *     migration 0011 compares against its labels. Adding a sixth label would
 *     mean revisiting all of them; adding a row to a new table means touching
 *     none.
 *   · `src/lib/permissions/__tests__/roles.selftest.ts` pins the canonical model
 *     at exactly five roles, which is the guarantee that a system role's
 *     meaning cannot drift under a release.
 *   · a custom role is an *overlay*: it carries a `base_role` (the system role it
 *     is modelled on) and an explicit capability list. Assigning one sets
 *     `profiles.custom_role_id` and moves `profiles.role` to the base, so the
 *     enum column stays valid and deactivating the custom role degrades the
 *     account to a known-safe system role instead of to nothing.
 *
 * Resolution is absolute, not additive: when a profile wears an active custom
 * role, that role's capability list decides — which is what lets an admin
 * *narrow* a role (a cashier who may not apply a discount). `public.can()` in
 * migration 0021 implements the same rule server-side, so the UI hiding a
 * button and the database refusing the write agree.
 */
import { APP_ROLES, CAPABILITIES, capabilitiesOf, normalizeRole, type AppRole, type Capability } from "./roles";

/** A role an admin defined. Mirrors `public.custom_roles`. */
export interface CustomRole {
  id: string;
  /** Lowercase slug: `sales_manager`. Unique. */
  key: string;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  /** The system role this one is modelled on, and the fallback if it is turned off. */
  base_role: AppRole;
  capabilities: Capability[];
  active: boolean;
  /** Seeded roles are protected from edits. */
  is_system: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** What the role form edits. */
export interface CustomRoleDraft {
  key: string;
  name_en: string;
  name_ar: string;
  description_en: string;
  description_ar: string;
  base_role: AppRole;
  capabilities: Capability[];
}

export const EMPTY_CUSTOM_ROLE_DRAFT: CustomRoleDraft = {
  key: "",
  name_en: "",
  name_ar: "",
  description_en: "",
  description_ar: "",
  base_role: "viewer",
  capabilities: [],
};

/** Why a draft was refused. Each maps to a dictionary key. */
export const CUSTOM_ROLE_ERROR_CODES = [
  "blank_name_en",
  "blank_name_ar",
  "blank_key",
  "invalid_key",
  "duplicate_key",
  "no_capabilities",
  "unknown_capability",
  "invalid_base_role",
] as const;
export type CustomRoleErrorCode = (typeof CUSTOM_ROLE_ERROR_CODES)[number];

export type CustomRoleValidation =
  | { ok: true; value: CustomRoleDraft }
  | { ok: false; code: CustomRoleErrorCode; field?: string };

/** `Sales Manager` → `sales_manager`; Arabic names produce nothing usable. */
export function normalizeRoleKey(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/** The shape `public.custom_roles_key_shape` accepts. */
export function isValidRoleKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{1,48}$/.test(key);
}

/**
 * Turn whatever arrived (a picker, an import, a stored row) into a list of real
 * capabilities: unknown keys dropped, duplicates collapsed, and the result in
 * `CAPABILITIES` order so two roles with the same permissions compare equal.
 */
export function sanitizeCapabilities(raw: readonly string[] | null | undefined): Capability[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (key) wanted.add(key);
  }
  return CAPABILITIES.filter((capability) => wanted.has(capability));
}

/** Names that cannot be a role key, whatever the admin typed. */
const RESERVED_ROLE_KEYS = new Set<string>([...APP_ROLES, "system", "custom", "role", "admin_role"]);

export function isReservedRoleKey(key: string): boolean {
  return RESERVED_ROLE_KEYS.has(key);
}

/**
 * Validate a draft. Pure and total: it never throws, and it reports the first
 * problem in field order so the form can highlight one thing at a time.
 *
 * `existing` is the list of roles already stored, so a key can be checked for
 * uniqueness; pass the edited role's own id in `ignoreId` when updating.
 */
export function validateCustomRoleDraft(
  draft: CustomRoleDraft,
  existing: readonly { id: string; key: string }[] = [],
  ignoreId?: string | null,
): CustomRoleValidation {
  // Every field is read defensively: a half-filled form (or a preset that omits
  // the optional descriptions) must produce a readable verdict, not a TypeError.
  const nameEn = String(draft.name_en ?? "").trim();
  const nameAr = String(draft.name_ar ?? "").trim();
  if (!nameEn) return { ok: false, code: "blank_name_en", field: "name_en" };
  if (nameEn.length > 80) return { ok: false, code: "blank_name_en", field: "name_en" };
  if (!nameAr) return { ok: false, code: "blank_name_ar", field: "name_ar" };
  if (nameAr.length > 80) return { ok: false, code: "blank_name_ar", field: "name_ar" };

  const key = normalizeRoleKey(draft.key || nameEn);
  if (!key) return { ok: false, code: "blank_key", field: "key" };
  if (!isValidRoleKey(key) || isReservedRoleKey(key)) {
    return { ok: false, code: "invalid_key", field: "key" };
  }
  const clash = existing.some(
    (role) => role.key === key && role.id !== (ignoreId ?? ""),
  );
  if (clash) return { ok: false, code: "duplicate_key", field: "key" };

  if (!APP_ROLES.includes(draft.base_role)) {
    return { ok: false, code: "invalid_base_role", field: "base_role" };
  }

  const capabilities = sanitizeCapabilities(draft.capabilities);
  if (capabilities.length !== draft.capabilities.length) {
    return { ok: false, code: "unknown_capability", field: "capabilities" };
  }
  if (capabilities.length === 0) {
    // A role that can do nothing is not a role, it is a locked account — and an
    // admin creating one by accident would spend an afternoon finding out why
    // nobody can see anything.
    return { ok: false, code: "no_capabilities", field: "capabilities" };
  }

  return {
    ok: true,
    value: {
      ...draft,
      key,
      name_en: nameEn,
      name_ar: nameAr,
      description_en: String(draft.description_en ?? "").trim(),
      description_ar: String(draft.description_ar ?? "").trim(),
      base_role: draft.base_role,
      capabilities,
    },
  };
}

/**
 * The capabilities that actually apply to a signed-in person.
 *
 * A custom role replaces the system matrix when it is present and active;
 * otherwise the base system role decides. Signed out (empty/unknown role, no
 * custom role) resolves to nothing at all — fail closed, exactly like
 * `hasCapability`.
 */
export function resolveCapabilities(
  role: string | null | undefined,
  custom: { capabilities: readonly string[]; active: boolean } | null | undefined,
): Capability[] {
  if (custom && custom.active) {
    const list = sanitizeCapabilities(custom.capabilities);
    // An active custom role with no usable capabilities grants nothing: the
    // overlay decides absolutely, it never silently falls back to the base role.
    return list;
  }
  return capabilitiesOf(role);
}

/** One question, asked the way the database asks it. */
export function canWithCustomRole(
  role: string | null | undefined,
  custom: { capabilities: readonly string[]; active: boolean } | null | undefined,
  capability: Capability,
): boolean {
  return resolveCapabilities(role, custom).includes(capability);
}

/** A role's name in the language on screen. */
export function customRoleName(role: CustomRole, lang: "en" | "ar"): string {
  const name = lang === "ar" ? role.name_ar : role.name_en;
  return name.trim() || (lang === "ar" ? role.name_en : role.name_ar);
}

/** What a profile's role is called: the custom role's name, or the system label. */
export function effectiveRoleLabel(
  custom: Pick<CustomRole, "name_en" | "name_ar" | "active"> | null | undefined,
  systemLabel: string,
  lang: "en" | "ar",
): string {
  if (!custom || !custom.active) return systemLabel;
  const name = lang === "ar" ? custom.name_ar : custom.name_en;
  return name.trim() || systemLabel;
}

/** A role draft from a system role, as the "start from…" shortcut in the form. */
export function draftFromSystemRole(role: AppRole, keyHint?: string): CustomRoleDraft {
  return {
    ...EMPTY_CUSTOM_ROLE_DRAFT,
    key: normalizeRoleKey(keyHint ?? role),
    base_role: normalizeRole(role) ?? "viewer",
    capabilities: [...capabilitiesOf(role)],
  };
}

/**
 * Starting points, because "build a role from a blank list" is not a task
 * anyone wants on a Tuesday. Each is a draft, never a seeded row: an admin
 * creates the ones they want, edits them, and owns them.
 */
export const CUSTOM_ROLE_PRESETS: readonly {
  presetKey: string;
  name_en: string;
  name_ar: string;
  base_role: AppRole;
  capabilities: Capability[];
}[] = [
  {
    presetKey: "sales_manager",
    name_en: "Sales Manager",
    name_ar: "مدير مبيعات",
    base_role: "manager",
    capabilities: [
      "view_inventory",
      "sell",
      "edit_sale",
      "apply_discount",
      "void_sale",
      "confirm_payment",
      "process_return",
      "approve_return",
      "process_refund",
      "approve_refund",
      "open_shift",
      "close_shift",
      "approve_shift_adjustment",
      "view_shifts",
      "view_reports",
      "export_reports",
      "export_data",
      "manage_online_orders",
    ],
  },
  {
    presetKey: "inventory_manager",
    name_en: "Inventory Manager",
    name_ar: "مدير مخازن",
    base_role: "manager",
    capabilities: [
      "view_inventory",
      "adjust_stock",
      "add_product",
      "edit_product",
      "change_price",
      "delete_product",
      "import_data",
      "export_data",
      "view_reports",
      "export_reports",
    ],
  },
  {
    presetKey: "accountant",
    name_en: "Accountant",
    name_ar: "محاسب",
    base_role: "viewer",
    capabilities: [
      "view_inventory",
      "view_shifts",
      "view_reports",
      "export_reports",
      "export_data",
      "add_expense",
      "edit_expense",
      "approve_expense",
      "process_refund",
      "approve_refund",
      "view_audit_log",
    ],
  },
  {
    presetKey: "warehouse_employee",
    name_en: "Warehouse Employee",
    name_ar: "موظف مخزن",
    base_role: "inventory_clerk",
    capabilities: ["view_inventory", "adjust_stock", "import_data", "export_data"],
  },
];

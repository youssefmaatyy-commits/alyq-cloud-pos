/**
 * Application permission catalog.
 *
 * `roles.ts` remains the database-compatible capability model: its snake-case
 * values are persisted in custom roles and are understood by `public.can()`.
 * This file gives every one of those existing capabilities one stable,
 * module.action application permission (for example `pos.sell`) without
 * changing any grant. New application code can use the readable permission
 * names while old helpers, stored custom roles and RLS continue to use the
 * capability behind each catalog entry.
 *
 * The remainder of this file groups the same capabilities for the existing
 * permission picker. That grouping is presentation only; `PERMISSION_CATALOG`
 * is the single compatibility boundary between application permission names
 * and persisted capabilities.
 */
import {
  APP_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  normalizeRole,
  type AppRole,
  type Capability,
} from "./roles";

/** One application permission and the persisted capability that enforces it. */
export interface PermissionDefinition {
  module: string;
  action: string;
  capability: Capability;
}

/**
 * The canonical application permission catalog.
 *
 * There is intentionally one entry per existing capability. A permission may
 * rename a historical capability but may not split or combine authority in this
 * foundation phase. In particular, `orders.view` preserves the existing
 * `manage_online_orders` bundle: it opens the operational order workspace, whose
 * actions continue to use their current checks. Separating order actions would
 * be a later permissions phase and is deliberately not done here.
 */
export const PERMISSION_CATALOG = {
  "dashboard.view": { module: "dashboard", action: "view", capability: "view_dashboard" },
  "products.view": { module: "products", action: "view", capability: "view_products" },
  "sales.view": { module: "sales", action: "view", capability: "view_sales" },
  "inventory.view": { module: "inventory", action: "view", capability: "view_inventory" },
  "inventory.adjust": { module: "inventory", action: "adjust", capability: "adjust_stock" },
  "pos.sell": { module: "pos", action: "sell", capability: "sell" },
  "pos.apply_discount": { module: "pos", action: "apply_discount", capability: "apply_discount" },
  "sales.void": { module: "sales", action: "void", capability: "void_sale" },
  "payments.confirm": { module: "payments", action: "confirm", capability: "confirm_payment" },
  "returns.process": { module: "returns", action: "process", capability: "process_return" },
  "refunds.process": { module: "refunds", action: "process", capability: "process_refund" },
  "refunds.approve": { module: "refunds", action: "approve", capability: "approve_refund" },
  "shifts.open": { module: "shifts", action: "open", capability: "open_shift" },
  "shifts.close": { module: "shifts", action: "close", capability: "close_shift" },
  "shifts.cash_in": { module: "shifts", action: "cash_in", capability: "cash_in" },
  "shifts.cash_out": { module: "shifts", action: "cash_out", capability: "cash_out" },
  "expenses.create": { module: "expenses", action: "create", capability: "add_expense" },
  "expenses.edit": { module: "expenses", action: "edit", capability: "edit_expense" },
  "expenses.delete": { module: "expenses", action: "delete", capability: "delete_expense" },
  "shifts.view": { module: "shifts", action: "view", capability: "view_shifts" },
  "shifts.approve_adjustment": {
    module: "shifts",
    action: "approve_adjustment",
    capability: "approve_shift_adjustment",
  },
  "audit.view": { module: "audit", action: "view", capability: "view_audit_log" },
  "orders.view": { module: "orders", action: "view", capability: "manage_online_orders" },
  "website.manage": { module: "website", action: "manage", capability: "manage_website" },
  "system.reset": { module: "system", action: "reset", capability: "manage_system_reset" },
  "sales.edit": { module: "sales", action: "edit", capability: "edit_sale" },
  "products.create": { module: "products", action: "create", capability: "add_product" },
  "products.edit": { module: "products", action: "edit", capability: "edit_product" },
  "products.change_price": { module: "products", action: "change_price", capability: "change_price" },
  "products.delete": { module: "products", action: "delete", capability: "delete_product" },
  "data.import": { module: "data", action: "import", capability: "import_data" },
  "data.export": { module: "data", action: "export", capability: "export_data" },
  "returns.approve": { module: "returns", action: "approve", capability: "approve_return" },
  "reports.view": { module: "reports", action: "view", capability: "view_reports" },
  "reports.export": { module: "reports", action: "export", capability: "export_reports" },
  "expenses.approve": { module: "expenses", action: "approve", capability: "approve_expense" },
  "users.manage": { module: "users", action: "manage", capability: "manage_users" },
  "roles.manage": { module: "roles", action: "manage", capability: "manage_roles" },
  "settings.manage": { module: "settings", action: "manage", capability: "manage_settings" },
  "approvals.approve": {
    module: "approvals",
    action: "approve",
    capability: "approve_limit_request",
  },
  "customers.view": { module: "customers", action: "view", capability: "view_customers" },
  "customers.create": { module: "customers", action: "create", capability: "add_customer" },
  "customers.edit": { module: "customers", action: "edit", capability: "edit_customer" },
  "customers.delete": { module: "customers", action: "delete", capability: "delete_customer" },
  "products.view_cost": { module: "products", action: "view_cost", capability: "view_cost" },
  "products.change_cost": { module: "products", action: "change_cost", capability: "change_cost" },
  "backups.view": { module: "backups", action: "view", capability: "view_backups" },
  "backups.create": { module: "backups", action: "create", capability: "create_backup" },
  "backups.restore": { module: "backups", action: "restore", capability: "restore_backup" },
  "backups.export": { module: "backups", action: "export", capability: "export_backup" },
  "system.health_check": { module: "system", action: "health_check", capability: "run_health_check" },
  "system.preview_cleanup": { module: "system", action: "preview_cleanup", capability: "preview_data_cleanup" },
  "system.execute_cleanup": { module: "system", action: "execute_cleanup", capability: "execute_data_cleanup" },
} as const satisfies Readonly<Record<string, PermissionDefinition>>;

/** A known module.action identifier. */
export type Permission = keyof typeof PERMISSION_CATALOG;

/** Stable declaration order for pickers, docs, tests and role projections. */
export const PERMISSIONS: readonly Permission[] = Object.freeze(
  Object.keys(PERMISSION_CATALOG) as Permission[],
);

const permissionByCapability = new Map<Capability, Permission>(
  PERMISSIONS.map((permission) => [PERMISSION_CATALOG[permission].capability, permission]),
);

/** Runtime boundary for strings from routes, configuration or future APIs. */
export function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PERMISSION_CATALOG, value)
  );
}

/** Unknown permission names return `null`; callers must deny them. */
export function capabilityForPermission(permission: unknown): Capability | null {
  return isPermission(permission) ? PERMISSION_CATALOG[permission].capability : null;
}

/** The application name for an existing persisted capability. */
export function permissionForCapability(capability: Capability): Permission | null {
  return permissionByCapability.get(capability) ?? null;
}

/** Convert a resolved legacy/custom-role list into application permissions. */
export function permissionsForCapabilities(capabilities: readonly string[]): Permission[] {
  const held = new Set(capabilities);
  return PERMISSIONS.filter((permission) => held.has(PERMISSION_CATALOG[permission].capability));
}

/**
 * Existing default roles projected onto the catalog. These are derived from the
 * current matrix rather than copied, so this foundation cannot alter access.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<AppRole, readonly Permission[]>> =
  Object.freeze({
    admin: Object.freeze(permissionsForCapabilities(ROLE_CAPABILITIES.admin)),
    manager: Object.freeze(permissionsForCapabilities(ROLE_CAPABILITIES.manager)),
    cashier: Object.freeze(permissionsForCapabilities(ROLE_CAPABILITIES.cashier)),
    inventory_clerk: Object.freeze(permissionsForCapabilities(ROLE_CAPABILITIES.inventory_clerk)),
    viewer: Object.freeze(permissionsForCapabilities(ROLE_CAPABILITIES.viewer)),
  });

/** Every application permission a default role holds; unknown roles hold none. */
export function permissionsOfRole(role: string | null | undefined): Permission[] {
  const normalized = normalizeRole(role);
  return normalized ? [...DEFAULT_ROLE_PERMISSIONS[normalized]] : [];
}

/** Roles that hold an application permission, preserving canonical role order. */
export function rolesWithPermission(permission: unknown): AppRole[] {
  if (!isPermission(permission)) return [];
  return APP_ROLES.filter((role) => DEFAULT_ROLE_PERMISSIONS[role].includes(permission));
}

export interface CapabilityGroup {
  /** Stable key, and the tail of the label's dictionary key. */
  key:
    | "dashboard"
    | "sales"
    | "products"
    | "customers"
    | "inventory"
    | "returns"
    | "reports"
    | "expenses"
    | "shifts"
    | "online"
    | "approvals"
    | "settings"
    /** Backup, restore and data health (Phase 18). */
    | "data_safety";
  capabilities: Capability[];
}

/**
 * Every capability, in exactly one group.
 *
 * The grouping follows the business question rather than the module layout:
 * "who may touch money at the till", "who may touch the catalogue", "who may
 * see the numbers". `view_shifts` sits with reports because that is what it
 * gates in practice (shift *history* and the expenses screen are both reads).
 */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    key: "dashboard",
    capabilities: ["view_dashboard"],
  },
  {
    key: "sales",
    capabilities: ["view_sales", "sell", "edit_sale", "apply_discount", "void_sale", "confirm_payment"],
  },
  {
    // Cost sits with the catalogue rather than with reports: it is a field on a
    // product, written from the product form and read on the product page. The
    // two capabilities are separate because they are separate acts — seeing what
    // the shop paid and changing it (Phase 17).
    key: "products",
    capabilities: [
      "view_products",
      "add_product",
      "edit_product",
      "change_price",
      "delete_product",
      "view_cost",
      "change_cost",
    ],
  },
  {
    // Phase 17. The customer book existed for eight releases with no capability
    // describing it, which is why no role could be built without it. History is
    // part of `view_customers`, not a fourth capability: same screen, same
    // person, same reason for looking.
    key: "customers",
    capabilities: ["view_customers", "add_customer", "edit_customer", "delete_customer"],
  },
  {
    key: "inventory",
    capabilities: ["view_inventory", "adjust_stock", "import_data", "export_data"],
  },
  {
    key: "returns",
    capabilities: ["process_return", "approve_return", "process_refund", "approve_refund"],
  },
  {
    key: "reports",
    capabilities: ["view_reports", "export_reports", "view_shifts"],
  },
  {
    key: "expenses",
    capabilities: ["add_expense", "edit_expense", "delete_expense", "approve_expense"],
  },
  {
    key: "shifts",
    capabilities: ["open_shift", "close_shift", "cash_in", "cash_out", "approve_shift_adjustment"],
  },
  {
    key: "online",
    capabilities: ["manage_online_orders", "manage_website"],
  },
  {
    // Cross-cutting on purpose: one capability decides every over-limit request,
    // whichever module raised it (Phase 12).
    key: "approvals",
    capabilities: ["approve_limit_request"],
  },
  {
    key: "settings",
    capabilities: ["manage_users", "manage_roles", "manage_settings", "view_audit_log"],
  },
  {
    // Backup & recovery (Phase 18). Its own group rather than a corner of
    // "settings", because the acts are not administration of the app's
    // configuration — they are custody of its data. Four of the five are held by
    // the shipped admin role alone, and the grouping is what makes that visible
    // in the picker: an admin building a role sees one area called Data safety
    // and has to decide, deliberately, whether to tick any of it.
    key: "data_safety",
    capabilities: [
      "view_backups",
      "create_backup",
      "restore_backup",
      "export_backup",
      "run_health_check",
      // Phase 47: the Danger Zone sits beside the backups because both are
      // custody of the whole installation — but this one is the act the backups
      // exist to protect against, admin-only by construction.
      "manage_system_reset",
      "preview_data_cleanup",
      "execute_data_cleanup",
    ],
  },
] as const;

/** `permissions.group.sales` — the picker's section headings. */
export function capabilityGroupLabelKey(group: CapabilityGroup["key"]): string {
  return `permissions.group.${group}`;
}

/** `permissions.cap.apply_discount` — one line per permission, EN and AR. */
export function capabilityLabelKey(capability: Capability): string {
  return `permissions.cap.${capability}`;
}

/** `permissions.cap.apply_discount.hint` — optional, may be absent. */
export function capabilityHintKey(capability: Capability): string {
  return `permissions.cap.${capability}.hint`;
}

/** Which group a capability belongs to (every one belongs to exactly one). */
export function groupOfCapability(capability: Capability): CapabilityGroup | null {
  return CAPABILITY_GROUPS.find((group) => group.capabilities.includes(capability)) ?? null;
}

/**
 * Integrity check used by the self-test: the groups are a partition of
 * `CAPABILITIES` — nothing missing, nothing invented, nothing listed twice.
 * Returns the problems so a test can print all of them at once.
 */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const seen = new Map<Capability, string>();

  for (const group of CAPABILITY_GROUPS) {
    for (const capability of group.capabilities) {
      if (!CAPABILITIES.includes(capability)) {
        problems.push(`${group.key} lists '${capability}', which is not a capability`);
        continue;
      }
      const previous = seen.get(capability);
      if (previous) {
        problems.push(`'${capability}' appears in both ${previous} and ${group.key}`);
        continue;
      }
      seen.set(capability, group.key);
    }
  }

  for (const capability of CAPABILITIES) {
    if (!seen.has(capability)) problems.push(`'${capability}' is in no group`);
  }

  // The module.action catalog is a one-to-one compatibility layer over the
  // persisted capability catalog. Missing or duplicate mappings would either
  // make an existing action unreachable through `can()` or give it two names.
  const catalogCapabilities = new Map<Capability, Permission>();
  for (const permission of PERMISSIONS) {
    const definition = PERMISSION_CATALOG[permission];
    if (permission !== `${definition.module}.${definition.action}`) {
      problems.push(`'${permission}' does not match ${definition.module}.${definition.action}`);
    }
    const previous = catalogCapabilities.get(definition.capability);
    if (previous) {
      problems.push(`'${definition.capability}' is mapped by both ${previous} and ${permission}`);
    } else {
      catalogCapabilities.set(definition.capability, permission);
    }
  }
  for (const capability of CAPABILITIES) {
    if (!catalogCapabilities.has(capability)) {
      problems.push(`'${capability}' has no module.action permission`);
    }
  }

  // Phase 17: every capability must also declare the verb it is. The map below
  // is typed `Record<Capability, PermissionAction>`, so a capability added to
  // `roles.ts` without a verb does not compile — this loop is the belt to that
  // brace, and it catches a verb that is not one of the seven.
  for (const capability of CAPABILITIES) {
    const action = CAPABILITY_ACTIONS[capability];
    if (!PERMISSION_ACTIONS.includes(action)) {
      problems.push(`'${capability}' has the action '${String(action)}', which is not a permission action`);
    }
  }

  return problems;
}

// ── the action layer (Phase 17) ──────────────────────────────────────────────
/**
 * The verbs a permission can be.
 *
 * Seven, and deliberately not one per module: a shop does not think "may
 * `customer_history_view`", it thinks "who may *see* customers". Naming the verb
 * separately from the area is what lets the picker show a matrix (area × verb)
 * instead of a flat list of forty identifiers, and what lets a future capability
 * say what kind of act it is without anybody re-reading this file.
 *
 * `manage` is the escape hatch for acts that are genuinely all of the above —
 * `manage_users`, `manage_online_orders` — and it is used sparingly, because a
 * verb that means everything tells an admin nothing.
 */
export const PERMISSION_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "approve",
  "export",
  "manage",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * Which verb each capability is — exhaustive by construction.
 *
 * This is a `Record<Capability, PermissionAction>`, not a partial map: add a
 * capability to `roles.ts` and the compiler refuses to build until somebody says
 * what kind of act it is. That is the whole mechanism by which the permission
 * builder "auto-supports future permissions" — the new capability arrives with a
 * group and a verb, and appears in the picker, the summary and the preview
 * without a line of UI code changing.
 */
export const CAPABILITY_ACTIONS: Record<Capability, PermissionAction> = {
  // Module doors
  view_dashboard: "view",
  view_products: "view",
  view_sales: "view",
  // Sales floor
  sell: "create",
  edit_sale: "edit",
  apply_discount: "edit",
  void_sale: "delete",
  confirm_payment: "approve",
  // Catalogue
  add_product: "create",
  edit_product: "edit",
  change_price: "edit",
  delete_product: "delete",
  view_cost: "view",
  change_cost: "edit",
  // Customers
  view_customers: "view",
  add_customer: "create",
  edit_customer: "edit",
  delete_customer: "delete",
  // Stock
  view_inventory: "view",
  adjust_stock: "edit",
  import_data: "create",
  export_data: "export",
  // Returns and refunds
  process_return: "create",
  approve_return: "approve",
  process_refund: "create",
  approve_refund: "approve",
  // Numbers
  view_reports: "view",
  export_reports: "export",
  view_shifts: "view",
  // Expenses
  add_expense: "create",
  edit_expense: "edit",
  delete_expense: "delete",
  approve_expense: "approve",
  // Shifts
  open_shift: "create",
  close_shift: "edit",
  cash_in: "create",
  cash_out: "create",
  approve_shift_adjustment: "approve",
  // Online
  manage_online_orders: "manage",
  manage_website: "manage",
  // Oversight
  approve_limit_request: "approve",
  manage_users: "manage",
  manage_roles: "manage",
  manage_settings: "manage",
  // Danger Zone: preview is a read; execution is the destructive authority.
  manage_system_reset: "manage",
  preview_data_cleanup: "view",
  execute_data_cleanup: "delete",
  view_audit_log: "view",
  // Data safety (Phase 18). Restore is `manage` rather than `delete` because it
  // does both: every table is emptied and filled again from a snapshot. The verb
  // means "full authority over this area", which is precisely what it is.
  view_backups: "view",
  create_backup: "create",
  restore_backup: "manage",
  export_backup: "export",
  run_health_check: "view",
};

/** `permissions.action.approve` — the verb's own label, EN and AR. */
export function actionLabelKey(action: PermissionAction): string {
  return `permissions.action.${action}`;
}

/** The verb a capability is. Total: every capability has one. */
export function actionOfCapability(capability: Capability): PermissionAction {
  return CAPABILITY_ACTIONS[capability];
}

/** One cell of the area × verb matrix. */
export interface MatrixCell {
  group: CapabilityGroup["key"];
  action: PermissionAction;
  capability: Capability;
}

/**
 * The permission matrix, as cells: every capability with its area and its verb.
 *
 * Empty crossings are simply absent — Customers has no `approve`, Reports has no
 * `delete` — which is how the builder "only shows the actions that make sense per
 * module" without anybody maintaining a list of which actions those are. The
 * matrix is derived from the catalogue, so it cannot disagree with it.
 */
export function capabilityMatrix(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const group of CAPABILITY_GROUPS) {
    for (const capability of group.capabilities) {
      cells.push({ group: group.key, action: CAPABILITY_ACTIONS[capability], capability });
    }
  }
  return cells;
}

/** The verbs an area actually uses — its columns in the matrix. */
export function actionsInGroup(group: CapabilityGroup["key"]): PermissionAction[] {
  const entry = CAPABILITY_GROUPS.find((candidate) => candidate.key === group);
  if (!entry) return [];
  return PERMISSION_ACTIONS.filter((action) =>
    entry.capabilities.some((capability) => CAPABILITY_ACTIONS[capability] === action),
  );
}

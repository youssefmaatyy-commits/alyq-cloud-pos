/**
 * Capability catalog — the same capabilities `roles.ts` defines, grouped the
 * way a shop thinks about them, for the permission picker on the Roles screen.
 *
 * This file adds no authority of its own: it is a *presentation* of
 * `CAPABILITIES`, and `assertCatalogCoversEveryCapability()` (called from the
 * settings self-test) fails if the two ever drift. Grouping lives here rather
 * than in `roles.ts` because `scripts/lib/schema-parity.mjs` parses that file's
 * `CAPABILITIES` and `ROLE_CAPABILITIES` literals with a regular expression and
 * compares them row for row against `public.role_capabilities` — keeping the
 * matrix file free of UI structure keeps that check simple and exact.
 */
import { CAPABILITIES, type Capability } from "./roles";

export interface CapabilityGroup {
  /** Stable key, and the tail of the label's dictionary key. */
  key:
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
    key: "sales",
    capabilities: ["sell", "edit_sale", "apply_discount", "void_sale", "confirm_payment"],
  },
  {
    // Cost sits with the catalogue rather than with reports: it is a field on a
    // product, written from the product form and read on the product page. The
    // two capabilities are separate because they are separate acts — seeing what
    // the shop paid and changing it (Phase 17).
    key: "products",
    capabilities: ["add_product", "edit_product", "change_price", "delete_product", "view_cost", "change_cost"],
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
    capabilities: ["open_shift", "close_shift", "approve_shift_adjustment"],
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
  approve_shift_adjustment: "approve",
  // Online
  manage_online_orders: "manage",
  manage_website: "manage",
  // Oversight
  approve_limit_request: "approve",
  manage_users: "manage",
  manage_roles: "manage",
  manage_settings: "manage",
  // Phase 47: the Danger Zone
  manage_system_reset: "manage",
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

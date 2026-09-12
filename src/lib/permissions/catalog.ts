/**
 * Capability catalog — the same 33 capabilities `roles.ts` defines, grouped the
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
    | "inventory"
    | "returns"
    | "reports"
    | "expenses"
    | "shifts"
    | "online"
    | "settings";
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
    key: "products",
    capabilities: ["add_product", "edit_product", "change_price", "delete_product"],
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
    key: "settings",
    capabilities: ["manage_users", "manage_roles", "manage_settings", "view_audit_log"],
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

  return problems;
}

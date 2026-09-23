/**
 * Role workspaces (Phase 58).
 *
 * A workspace is not a new permission system. It is the set of screens and acts
 * a granted capability list already opens, computed from the same catalogue the
 * route guard, the sidebar and `public.can()` read. Admin full access stays
 * `admin: CAPABILITIES` in the matrix — capability resolution, not a role-name
 * comparison.
 *
 * Names that already exist are reused on purpose:
 *   · health, usage and operational notifications → `run_health_check`
 *   · cleanup, retention and storage-threshold writes → `manage_settings`
 *   · import kinds → `import_data` plus the write each kind already asserts
 *   · WhatsApp initiation → `manage_online_orders`
 *   · cost, COGS, profit and margin → `view_cost`
 *     (there is no separate `view_profit`; adding one would desync
 *     `public.role_capabilities`)
 */
import type { Capability } from "./roles";

export const SENSITIVE_MONEY_CAPABILITY = "view_cost" satisfies Capability;
export const COMMUNICATION_CAPABILITY = "manage_online_orders" satisfies Capability;
export const OPERATIONS_VIEW_CAPABILITY = "run_health_check" satisfies Capability;
export const OPERATIONS_CLEANUP_CAPABILITY = "manage_settings" satisfies Capability;

/** Cost, COGS, gross/net profit and margin are one existing read. */
export function maySeeSensitiveMoney(can: (capability: Capability) => boolean): boolean {
  return can(SENSITIVE_MONEY_CAPABILITY);
}

export function operationsAccess(can: (capability: Capability) => boolean): {
  view: boolean;
  cleanup: boolean;
} {
  const cleanup = can(OPERATIONS_CLEANUP_CAPABILITY);
  return { view: can(OPERATIONS_VIEW_CAPABILITY) || cleanup, cleanup };
}

export interface WorkspaceDoor {
  key: "cashier" | "inventory" | "online" | "oversight";
  labelKey: string;
  /** The door opens when any one of these is held. Children still have their own gates. */
  anyOf: readonly Capability[];
}

export const WORKSPACES: readonly WorkspaceDoor[] = [
  {
    key: "cashier",
    labelKey: "settings.preview.workspace.cashier",
    anyOf: ["sell", "open_shift", "close_shift", "view_shifts", "view_customers", "process_return", "process_refund"],
  },
  {
    key: "inventory",
    labelKey: "settings.preview.workspace.inventory",
    anyOf: ["view_inventory", "adjust_stock"],
  },
  {
    key: "online",
    labelKey: "settings.preview.workspace.online",
    anyOf: ["manage_online_orders", "manage_website"],
  },
  {
    key: "oversight",
    labelKey: "settings.preview.workspace.oversight",
    anyOf: [
      "manage_users",
      "manage_roles",
      "manage_settings",
      "run_health_check",
      "view_audit_log",
      "view_backups",
      "manage_system_reset",
    ],
  },
];

export function workspaceDoors(held: ReadonlySet<string>): Array<WorkspaceDoor & { open: boolean }> {
  return WORKSPACES.map((workspace) => ({
    ...workspace,
    open: workspace.anyOf.some((capability) => held.has(capability)),
  }));
}

/**
 * A floor seat: the till, the open drawer, customer lookup, and the sales or
 * returns that seat was given. Not a shipped role — the shipped cashier keeps
 * the grants it already had. This is the list an admin ticks to build the
 * narrow workspace the acceptance describes.
 */
export const CASHIER_FLOOR_CAPABILITIES = [
  "sell",
  "open_shift",
  "close_shift",
  "view_shifts",
  "view_customers",
  "process_return",
  "process_refund",
] as const satisfies readonly Capability[];

/** Inventory without profit, till discounts, CRM communication, or cleanup. */
export const INVENTORY_SEAT_CAPABILITIES = ["view_inventory", "adjust_stock"] as const satisfies readonly Capability[];

/** Online queue and WhatsApp updates, without cost, shifts, or cleanup. */
export const ONLINE_SEAT_CAPABILITIES = ["manage_online_orders", "view_customers"] as const satisfies readonly Capability[];

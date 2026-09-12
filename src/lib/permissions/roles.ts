/**
 * Canonical role + capability model (prepared for the Authentication phase).
 *
 * This file is the single source of truth for *what a role may do*. The
 * per-module helpers (`inventory/permissions`, `pos/permissions`,
 * `returns/permissions`, `shifts/permissions`) stay exactly as they are for
 * callers — they are thin, behaviour-preserving wrappers over the matrix below
 * (see `src/lib/permissions/__tests__/roles.selftest.ts`, which asserts that
 * parity for the four roles the app ships today).
 *
 * Why it exists now, without authentication:
 *   - the fifth role (`cashier`) becomes a first-class member of the model, so
 *     the future login phase only has to *select* a role, not invent one;
 *   - a session user from any provider maps in through `normalizeRole`, and an
 *     unknown/legacy role resolves to `null` → every capability denied, i.e.
 *     fail-closed rather than default-allow;
 *   - the matrix is data, so it can be reviewed, tested and later driven from
 *     Supabase `profiles.role` without touching a single call site.
 *
 * Deliberately NOT here: credentials, sessions, tokens, login UI. Those belong
 * to the Authentication phase.
 */

/** The five roles of the target model, most privileged first. */
export const APP_ROLES = ["admin", "manager", "cashier", "inventory_clerk", "viewer"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Ordered role list for pickers / the future account screens. */
export const APP_ROLE_ORDER: AppRole[] = [...APP_ROLES];

/** English labels, matching the labels the app already shows. */
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  inventory_clerk: "Inventory Clerk",
  viewer: "Viewer",
};

/**
 * Aliases accepted when a role arrives from outside this app (a Supabase
 * `profiles.role` value, a legacy record, an imported user). Anything not in
 * this table and not an app role is rejected — never silently upgraded.
 */
const ROLE_ALIASES: Record<string, AppRole> = {
  admin: "admin",
  owner: "admin",
  super_admin: "admin",
  superadmin: "admin",
  manager: "manager",
  cashier: "cashier",
  inventory_clerk: "inventory_clerk",
  clerk: "inventory_clerk",
  stock_clerk: "inventory_clerk",
  viewer: "viewer",
  auditor: "viewer",
};

/**
 * Normalise an arbitrary role string into the app model.
 * Returns `null` for empty / unknown values so callers fail closed.
 */
export function normalizeRole(raw: string | null | undefined): AppRole | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return ROLE_ALIASES[key] ?? null;
}

export function isAppRole(raw: string | null | undefined): raw is AppRole {
  return normalizeRole(raw) !== null;
}

/** Every action the app gates on a role. */
export const CAPABILITIES = [
  /** Read stock levels + the movement ledger. */
  "view_inventory",
  /** Create stock movements (manual adjustments). */
  "adjust_stock",
  /** Run the register and complete a sale. */
  "sell",
  /** Apply a discount to a sale. */
  "apply_discount",
  /** Void a completed sale. */
  "void_sale",
  /** Confirm a pending InstaPay payment. */
  "confirm_payment",
  /** Process a customer return. */
  "process_return",
  /** Issue a refund against a return. */
  "process_refund",
  /**
   * Settle a refund that is waiting for approval (WS4): move it to `completed`
   * or `rejected`. Deliberately separate from `process_refund` — a cashier
   * records the return and the money is owed, but releasing it is a manager's
   * decision (plan decision D1).
   */
  "approve_refund",
  /** Open a cashier shift (count the opening float). */
  "open_shift",
  /** Close a cashier shift (count the drawer). */
  "close_shift",
  /** Record an expense against the open shift. */
  "add_expense",
  /** Edit an existing expense. */
  "edit_expense",
  /** Delete an expense. */
  "delete_expense",
  /** Read shift history for every cashier. */
  "view_shifts",
  /** Sign off a cash difference / adjustment. */
  "approve_shift_adjustment",
  /** Read the audit trail. */
  "view_audit_log",
  /**
   * Work the online queue (Phase 9): read website orders, approve them (which
   * creates the POS sale and converts the stock reservation), move them through
   * processing/ready/completed, and cancel a pending one with a reason.
   * Granted to every role that may already `sell`, because approving an order is
   * a sale. Cancelling an *approved* order additionally needs `void_sale`, since
   * it unwinds one.
   */
  "manage_online_orders",
  /**
   * Edit the customer-facing website (Phase 9): appearance and theme, homepage
   * sections, social and contact links, SEO defaults, InstaPay details, coupons,
   * campaigns, FAQs and reviews. Admin and manager only — this is the shop's
   * public face, not a till operation.
   *
   * Verifying an InstaPay payment proof deliberately reuses `confirm_payment`:
   * it is the same judgement as confirming a transfer at the till, and a second
   * capability would let the two drift apart.
   */
  "manage_website",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Role → capability matrix.
 *
 * Rules of thumb encoded here:
 *   - `admin` and `manager` are full-access oversight roles (attention:
 *     `manager` intentionally differs from `admin` nowhere today — the split
 *     exists so the Authentication phase can narrow one without touching code);
 *   - `cashier` runs the till: sell, confirm payments, take returns/refunds,
 *     work a shift and record expenses — but may not discount, void, adjust
 *     stock, edit/delete expenses, approve adjustments or read the audit log;
 *   - `inventory_clerk` adds stock authority on top of the till;
 *   - `viewer` is read-only (inventory + shift history).
 */
export const ROLE_CAPABILITIES: Record<AppRole, readonly Capability[]> = {
  admin: CAPABILITIES,
  manager: CAPABILITIES,
  cashier: [
    "view_inventory",
    "sell",
    "confirm_payment",
    "process_return",
    "process_refund",
    "open_shift",
    "close_shift",
    "add_expense",
    "view_shifts",
    // Works the online queue like the till; may not restyle the website.
    "manage_online_orders",
  ],
  inventory_clerk: [
    "view_inventory",
    "adjust_stock",
    "sell",
    "confirm_payment",
    "process_return",
    "process_refund",
    "open_shift",
    "close_shift",
    "add_expense",
    "view_shifts",
    "manage_online_orders",
  ],
  viewer: ["view_inventory", "view_shifts"],
};

/**
 * The one question every gate should ask. Accepts a raw role string (or an
 * unknown value) and fails closed.
 */
export function hasCapability(
  role: string | null | undefined,
  capability: Capability,
): boolean {
  const normalized = normalizeRole(role);
  if (!normalized) return false;
  return ROLE_CAPABILITIES[normalized].includes(capability);
}

/** Everything a role may do — handy for tests, docs and future admin screens. */
export function capabilitiesOf(role: string | null | undefined): Capability[] {
  const normalized = normalizeRole(role);
  return normalized ? [...ROLE_CAPABILITIES[normalized]] : [];
}

/** Roles that hold a given capability, most privileged first. */
export function rolesWithCapability(capability: Capability): AppRole[] {
  return APP_ROLE_ORDER.filter((role) => ROLE_CAPABILITIES[role].includes(capability));
}

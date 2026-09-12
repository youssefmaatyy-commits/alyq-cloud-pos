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

  // ── Phase 10: the granular permissions a custom role can be built from ──
  //
  // Every one of these existed as *behaviour* before it existed as a
  // capability: the catalogue was editable by anyone signed in, every list
  // screen had an export button, and approving a return or an expense was not
  // a separate act from creating one. Naming them is what makes them
  // assignable — and the grants below keep each system role's effective access
  // exactly as it was, so tightening is a choice an admin makes per custom
  // role rather than a regression shipped by default.
  /** Amend a recorded sale (the till itself is frozen; this is the back office). */
  "edit_sale",
  /** Add a product to the catalogue. */
  "add_product",
  /** Edit a product's details. */
  "edit_product",
  /** Change a selling price. */
  "change_price",
  /** Delete or archive a product. */
  "delete_product",
  /** Run an Excel import. */
  "import_data",
  /** Run an Excel/CSV export of any list. */
  "export_data",
  /** Approve a return that is waiting for a decision. */
  "approve_return",
  /** Open the reports screen. */
  "view_reports",
  /** Export a report. */
  "export_reports",
  /** Approve an expense that is waiting for a decision. */
  "approve_expense",
  /**
   * Manage staff: view users, add employees, edit their details, activate or
   * deactivate them, reset a password and assign a role. Admin only — this is
   * the capability that decides who holds every other capability, so it is the
   * one place `manager` deliberately differs from `admin`.
   */
  "manage_users",
  /** Create and edit custom roles and their permission sets. Admin only. */
  "manage_roles",
  /** Change system-wide settings. Admin only. */
  "manage_settings",

  // ── Phase 12: approval limits ──────────────────────────────────────────
  /**
   * Decide an approval request raised by a limit rule (Phase 12, requirement 2):
   * a discount above the cap, a refund above the cap, an expense above the cap,
   * or a price change when the rule says price changes need sign-off.
   *
   * This is deliberately *not* the same capability as the act being approved.
   * `approve_expense` answers "is this expense legitimate?", `change_price`
   * answers "may this person set prices?" — and a cashier holds `change_price`,
   * so reusing it would let the person who wants the price rise also sign it
   * off. One capability, held by the oversight seats and assignable to a custom
   * role (an accountant, a branch owner), decides every over-limit request.
   */
  "approve_limit_request",
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
  // Manager holds everything except the three capabilities that decide who
  // holds capabilities. That is the first real difference between the two
  // oversight roles, and it is what `manage_users` exists to express.
  manager: [
    "view_inventory",
    "adjust_stock",
    "sell",
    "apply_discount",
    "void_sale",
    "confirm_payment",
    "process_return",
    "process_refund",
    "approve_refund",
    "open_shift",
    "close_shift",
    "add_expense",
    "edit_expense",
    "delete_expense",
    "view_shifts",
    "approve_shift_adjustment",
    "view_audit_log",
    "manage_online_orders",
    "manage_website",
    "edit_sale",
    "add_product",
    "edit_product",
    "change_price",
    "delete_product",
    "import_data",
    "export_data",
    "approve_return",
    "view_reports",
    "export_reports",
    "approve_expense",
    "approve_limit_request",
  ],
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
    // The catalogue tier: exactly what the till tier could already do when the
    // products screen had no capability gate at all, now named so a custom role
    // can take it away.
    "add_product",
    "edit_product",
    "change_price",
    "delete_product",
    "import_data",
    "export_data",
    "view_reports",
    "export_reports",
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
    // Identical to the cashier's set: the two roles differ by `adjust_stock`
    // and nothing else, which the role-model self-test pins.
    "add_product",
    "edit_product",
    "change_price",
    "delete_product",
    "import_data",
    "export_data",
    "view_reports",
    "export_reports",
  ],
  // Read-only, and still read-only: the three additions are all reads or
  // exports of data the viewer could already open. No write capability is
  // granted here, and the role-model self-test asserts exactly this list.
  viewer: ["view_inventory", "view_shifts", "export_data", "view_reports", "export_reports"],
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

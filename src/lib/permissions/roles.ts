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
  /** Open the operational dashboard and its permission-filtered widgets. */
  "view_dashboard",
  /** Browse products, categories and product details without editing them. */
  "view_products",
  /** Browse completed sales and invoice details without running the register. */
  "view_sales",
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

  // ── Phase 47: the Danger Zone. Clearing operational data or factory-
  // resetting the installation is the single most destructive act the system
  // can perform, so it gets the narrowest capability in the model: admin only,
  // never assignable to a working seat, checked server-side by the 0047 RPCs.
  // It is deliberately NOT part of the Phase 10 granular set below — a custom
  // role cannot be handed the reset switch.
  "manage_system_reset",

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

  // ── Phase 17: the customer book, and what the shop pays ─────────────────
  /**
   * Open the customer book: the list, the search, and a customer's own page.
   *
   * Purchase history is folded into this capability rather than getting one of
   * its own, because it is the same screen, the same person and the same reason
   * for looking — a seat that may see a customer may see what they bought, and a
   * seat that may not see them sees neither. Splitting it would only create a
   * role that can open a customer and then stare at an empty page.
   *
   * Before this existed nothing gated the book at all: any signed-in seat could
   * read every phone number and address in it.
   */
  "view_customers",
  /**
   * Create a customer record — including from the till, mid-sale.
   *
   * Separate from `edit_customer` on purpose: adding a customer is an ordinary
   * act for anybody who sells, while correcting a record somebody else created
   * is a different judgement, and a shop may want one without the other.
   */
  "add_customer",
  /** Change a customer's name, contact details or notes. */
  "edit_customer",
  /**
   * Delete a customer record.
   *
   * Oversight only: deleting a customer erases the anchor their purchase history
   * hangs from, so it is not a till operation. Sales already recorded keep their
   * own copy of the name and total, which is why this is destructive but not
   * catastrophic — and why it is still not something a cashier should hold.
   */
  "delete_customer",
  /**
   * See what a product cost the shop.
   *
   * Scoped to the catalogue: the product form, the product page, the margin in
   * the table, and the cost columns of the products and inventory exports. It
   * deliberately does not reach the dashboard's or the reports' valuation
   * figures, which are management totals rather than a supplier's price list.
   */
  "view_cost",
  /**
   * Write a product's cost price.
   *
   * Separate from `change_price` because the two are different kinds of fact:
   * the selling price is a decision about what the shop charges, the cost price
   * is a record of what the shop paid. A buyer who enters supplier invoices
   * needs this and not the price list; a supervisor who sets prices may need the
   * price list and not this.
   */
  "change_cost",
  /**
   * Open Backup & recovery: the snapshot list, its metadata, the schedule and the
   * monitoring panel.
   *
   * Seeing that a backup exists is not holding one. This capability answers "are
   * we protected?" without handing over a copy of the database, which is what
   * `export_backup` is for.
   */
  "view_backups",
  /**
   * Take a snapshot — by hand, or by the schedule while an admin session is open.
   *
   * Writing a backup changes nothing except adding a way back, so it is the one
   * recovery act a manager holds: the person who runs the shop should be able to
   * protect it without being able to replace it.
   */
  "create_backup",
  /**
   * Replace the installation's data with a snapshot.
   *
   * The most destructive act in the system: every row is deleted and rewritten,
   * including sales that happened after the snapshot was taken. Held by the
   * shipped admin role only, and deliberately a capability rather than a role
   * check — an installation that wants a second person able to do it grants this,
   * instead of making them an admin.
   */
  "restore_backup",
  /**
   * Download a snapshot file.
   *
   * Separate from `view_backups` because the file *is* the database: customers,
   * sales, the staff directory and (offline) the credential digests that let those
   * accounts sign in. Separate from `export_data` for the same reason — no report
   * contains the whole installation.
   */
  "export_backup",
  /**
   * Run the data health check and read its report.
   *
   * It examines relationships across every table, so it is a read of the whole
   * installation, but it writes nothing and repairs nothing: a finding names a
   * problem and points at the tool that already fixes it.
   */
  "run_health_check",
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
  // Manager holds everything except the capabilities that decide who holds
  // capabilities — the three oversight grants — and, since Phase 47, the
  // Danger Zone: clearing operational data or factory-resetting the
  // installation is the one act reserved to the admin role alone.
  manager: [
    "view_dashboard",
    "view_products",
    "view_sales",
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
    // Phase 17: the customer book and cost price, named. A manager may delete a
    // customer — that is oversight, not a till act.
    "view_customers",
    "add_customer",
    "edit_customer",
    "delete_customer",
    "view_cost",
    "change_cost",
    // Phase 18: a manager may protect the installation and look at its health,
    // but not replace it and not walk out with it. Restoring deletes every row
    // written since the snapshot, and a backup file is the whole database — both
    // stay with the role that owns the installation.
    "view_backups",
    "create_backup",
    "run_health_check",
  ],
  cashier: [
    "view_dashboard",
    "view_products",
    "view_sales",
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
    // Phase 17: the till adds and edits customers (a sale needs one) and already
    // saw and wrote cost price from the product form it could already open — so
    // these grants preserve what a cashier could do, now named so a custom role
    // can narrow it. Deleting a customer is not granted: see `delete_customer`.
    "view_customers",
    "add_customer",
    "edit_customer",
    "view_cost",
    "change_cost",
  ],
  inventory_clerk: [
    "view_dashboard",
    "view_products",
    "view_sales",
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
    // Identical to the cashier's Phase 17 set, so the two roles still differ by
    // `adjust_stock` and nothing else.
    "view_customers",
    "add_customer",
    "edit_customer",
    "view_cost",
    "change_cost",
  ],
  // Read-only, and still read-only: the three additions are all reads or
  // exports of data the viewer could already open. No write capability is
  // granted here, and the role-model self-test asserts exactly this list.
  // Phase 17 adds two reads and takes away three writes the viewer only ever
  // had by accident: nothing gated the customer book, so a read-only seat could
  // add, edit and delete a customer. That is the one deliberate tightening in
  // this release, and the role-model self-test pins both halves of it.
  viewer: [
    "view_dashboard",
    "view_products",
    "view_inventory",
    "view_shifts",
    "export_data",
    "view_reports",
    "export_reports",
    "view_customers",
    "view_cost",
  ],
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

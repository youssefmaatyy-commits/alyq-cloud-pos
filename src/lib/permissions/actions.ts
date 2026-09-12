/**
 * The sensitive-action register.
 *
 * One list of every action in this app that moves money, stock or authority, and
 * for each: the capability it needs, the function that refuses it, the file that
 * function lives in, and what backs the same decision in the database.
 *
 * Why a register instead of a `canX()` call sprinkled where somebody remembered:
 *
 *   · **It is the answer to "is this action protected?"** A capability in
 *     `roles.ts` that nothing asserts is a dead gate — it reads as enforced in
 *     the role picker and enforces nothing. Before this file existed, most of the
 *     matrix was in that state: `edit_sale`, `change_price`, `delete_product`,
 *     `approve_return`, `import_data`, `view_reports` and `export_reports` were
 *     granted, denied and displayed, but never checked by any code path.
 *   · **It is checked, not just written.** `__tests__/enforcement.selftest.ts`
 *     reads each `file` and asserts the `guard` is really called there, then
 *     signs in as a role that lacks the capability and asserts the service
 *     refuses. Deleting a guard to make a screen convenient fails the suite.
 *   · **It states the second layer.** Hiding a button and throwing in a service
 *     are both client-side; the `db` column names the policy or RPC that makes
 *     the refusal authoritative in live mode. Where the schema simply has no
 *     write path — a completed sale cannot be edited or deleted by anyone, at
 *     any privilege level — that is recorded here rather than left as a rumour.
 *
 * Services call `assertSensitiveAction("expense.create")`, never
 * `assertCapability("add_expense")` directly, so the register and the code
 * cannot drift: an action that is not in the register cannot be asserted, and an
 * action in the register that nothing asserts fails the suite.
 */
import { assertCapability, canAct } from "./enforce";
import type { Capability } from "./roles";

export interface SensitiveAction {
  /** Stable identifier used at the call site and in tests. */
  key: string;
  /** The capability the acting user must hold. */
  capability: Capability;
  /** The function that performs the check — asserted to exist by the suite. */
  guard: string;
  /** Where the guard is called from, relative to the repository root. */
  file: string;
  /**
   * What makes the same refusal authoritative server-side, in live mode.
   * "no write path" means the schema forbids the action outright.
   */
  db: string;
}

export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = [
  // ── sales ────────────────────────────────────────────────────────────────
  {
    key: "sale.complete",
    capability: "sell",
    guard: "assertCanCompleteSale",
    file: "src/modules/pos/services/saleService.ts",
    db: "public.pos_complete_sale — reprices server-side; sales has no direct-write policy",
  },
  {
    key: "sale.discount",
    capability: "apply_discount",
    guard: "assertCanDiscountSale",
    file: "src/modules/pos/services/saleService.ts",
    db: "pos_complete_sale accepts a discount only from a caller public.can('apply_discount') allows",
  },
  {
    key: "sale.void",
    capability: "void_sale",
    guard: "assertCanVoidSale",
    file: "src/modules/pos/services/saleService.ts",
    db: "public.pos_void_sale — restocks once, refuses an already-voided sale",
  },
  {
    key: "sale.confirm_payment",
    capability: "confirm_payment",
    guard: "assertCanConfirmPayment",
    file: "src/modules/pos/services/saleService.ts",
    db: "public.pos_confirm_payment — idempotent, never changes totals",
  },
  {
    key: "sale.edit",
    capability: "edit_sale",
    guard: "assertCanEditSale",
    file: "src/modules/pos/services/saleService.ts",
    db: "no write path — a completed sale is immutable; corrections go through returns or a void",
  },
  {
    key: "sale.delete",
    capability: "void_sale",
    guard: "assertCanDeleteSale",
    file: "src/modules/pos/services/saleService.ts",
    db: "no write path — sales/sale_items/sale_payments are insert-refused for authenticated; void is the sanctioned reversal",
  },

  // ── returns & refunds ────────────────────────────────────────────────────
  {
    key: "return.create",
    capability: "process_return",
    guard: "assertCanCreateReturn",
    file: "src/modules/returns/services/returnService.ts",
    db: "public.pos_process_return — restocks, caps at the sale's refundable amount",
  },
  {
    key: "return.approve",
    capability: "approve_return",
    guard: "assertCanApproveReturn",
    file: "src/modules/returns/services/returnService.ts",
    db: "public.pos_settle_refund(completed) — requires approve_refund, decides once",
  },
  {
    key: "return.reject",
    capability: "approve_return",
    guard: "assertCanRejectReturn",
    file: "src/modules/returns/services/returnService.ts",
    db: "public.pos_settle_refund(rejected) — reason required, frees the reserved amount",
  },
  {
    key: "refund.settle",
    capability: "approve_refund",
    guard: "assertCanSettleRefund",
    file: "src/modules/returns/services/returnService.ts",
    db: "public.pos_settle_refund — pending → completed/rejected exactly once, one audit row",
  },
  {
    key: "refund.record",
    capability: "process_refund",
    guard: "assertCanRecordRefund",
    file: "src/modules/returns/services/returnService.ts",
    db: "public.pos_process_return writes the refund row; refund_records has no direct write",
  },

  // ── expenses ─────────────────────────────────────────────────────────────
  {
    key: "expense.create",
    capability: "add_expense",
    guard: "assertCanCreateExpense",
    file: "src/modules/expenses/services/expenseService.ts",
    db: "RLS insert on expenses — attribution stamped to the caller, immutable",
  },
  {
    key: "expense.edit",
    capability: "edit_expense",
    guard: "assertCanEditExpense",
    file: "src/modules/expenses/services/expenseService.ts",
    db: "RLS update on expenses — manager rights only",
  },
  {
    key: "expense.delete",
    capability: "delete_expense",
    guard: "assertCanDeleteExpense",
    file: "src/modules/expenses/services/expenseService.ts",
    db: "RLS delete on expenses — manager rights only",
  },
  {
    key: "expense.approve",
    capability: "approve_expense",
    guard: "assertCanApproveExpense",
    file: "src/modules/expenses/services/expenseService.ts",
    db: "public.expense_decide — requires approve_expense, decides once, writes audit",
  },

  // ── inventory ────────────────────────────────────────────────────────────
  {
    key: "stock.adjust",
    capability: "adjust_stock",
    guard: "assertCanAdjustStock",
    file: "src/modules/inventory/services/inventoryService.ts",
    db: "public.inventory_adjust_stock — writes the movement and the product in one call",
  },
  {
    key: "stock.correct",
    capability: "adjust_stock",
    guard: "assertCanCorrectStock",
    file: "src/modules/inventory/services/inventoryService.ts",
    db: "public.inventory_adjust_stock with reason 'correction' — same path, same refusal",
  },
  {
    key: "stock.import",
    capability: "import_data",
    guard: "assertCanImportStock",
    file: "src/modules/inventory/services/inventoryService.ts",
    db: "each imported row is an inventory_adjust_stock call, so the RLS check applies per row",
  },

  // A website order's hold on stock (Phase 15). Settling a hold changes what the
  // shop can promise to sell, which is the same consequence as writing the stock
  // ledger, so it asks for the same capability — and the till seat, which works
  // the online queue with `manage_online_orders`, does not hold it.
  {
    key: "reservation.repair",
    capability: "adjust_stock",
    guard: "assertCanRepairReservations",
    file: "src/modules/online/services/reservationRepair.ts",
    db: "public.repair_stock_reservation — requires adjust_stock, repeats a resolution as a no-op, refuses to reverse one, and never writes products.stock_quantity",
  },

  // ── products & catalog ───────────────────────────────────────────────────
  {
    key: "product.create",
    capability: "add_product",
    guard: "assertCanCreateProduct",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS insert on products — add_product",
  },
  {
    key: "product.edit",
    capability: "edit_product",
    guard: "assertCanEditProduct",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS update on products — edit_product",
  },
  {
    key: "product.price_change",
    capability: "change_price",
    guard: "assertCanChangePrice",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS update on products — change_price is checked separately from edit_product",
  },
  {
    key: "product.cost_change",
    // Phase 17 gave cost its own capability. It used to ride on `change_price`,
    // which meant a shop could not hand somebody the retail price without also
    // handing them what the shop pays — and cost is a supplier fact, not a
    // pricing decision. The two are now separately assignable, and the approval
    // rule for a cost move still fires exactly as before.
    capability: "change_cost",
    guard: "assertCanChangeCost",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS update on products — a purchase cost is a price, and it drives every profit figure",
  },
  {
    key: "product.delete",
    capability: "delete_product",
    guard: "assertCanDeleteProduct",
    file: "src/modules/products/services/catalogService.ts",
    db: "no write path — a product that has been sold is referenced by sale_items and movements; deactivation is the supported answer",
  },
  {
    key: "product.import",
    capability: "import_data",
    guard: "assertCanImportProducts",
    file: "src/modules/products/services/catalogService.ts",
    db: "imported rows are ordinary product inserts/updates, so the same RLS applies",
  },
  {
    key: "category.create",
    capability: "add_product",
    guard: "assertCanCreateCategory",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS insert on categories — add_product",
  },
  {
    key: "category.edit",
    capability: "edit_product",
    guard: "assertCanEditCategory",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS update on categories — edit_product; a trigger refuses a category moved under itself",
  },
  {
    key: "product.activate",
    capability: "edit_product",
    guard: "assertCanToggleProduct",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS update on products — edit_product",
  },
  {
    key: "category.delete",
    capability: "delete_product",
    guard: "assertCanDeleteCategory",
    file: "src/modules/products/services/catalogService.ts",
    db: "RLS delete on categories, plus a trigger that refuses a category still in use",
  },

  // ── shifts & cash ────────────────────────────────────────────────────────
  {
    key: "shift.open",
    capability: "open_shift",
    guard: "assertCanOpenShift",
    file: "src/modules/shifts/services/shiftService.ts",
    db: "public.open_shift — one open shift installation-wide",
  },
  {
    key: "shift.close",
    capability: "close_shift",
    guard: "assertCanCloseShift",
    file: "src/modules/shifts/services/shiftService.ts",
    db: "public.close_shift — freezes the shift and stamps the summary",
  },
  {
    key: "shift.approve_adjustment",
    capability: "approve_shift_adjustment",
    guard: "assertCanApproveShiftAdjustment",
    file: "src/modules/shifts/services/shiftService.ts",
    db: "public.approve_shift_adjustment — once only, manager rights",
  },
  {
    key: "shift.view_differences",
    capability: "view_shifts",
    guard: "assertCanViewShiftDifferences",
    file: "src/modules/shifts/services/shiftService.ts",
    db: "RLS select on shifts — viewer and above; the cash difference is part of the row",
  },

  // ── reports, data and oversight ──────────────────────────────────────────
  {
    key: "report.view",
    capability: "view_reports",
    guard: "assertCanViewReports",
    file: "src/modules/reports/services/reportAccess.ts",
    db: "every report reads tables whose RLS already limits what the caller sees",
  },
  {
    key: "report.export",
    capability: "export_reports",
    guard: "assertCanExportReports",
    file: "src/modules/reports/services/reportAccess.ts",
    db: "the export writes only rows the caller could already select",
  },
  {
    key: "data.export",
    capability: "export_data",
    guard: "assertCanExportData",
    file: "src/modules/reports/services/reportAccess.ts",
    db: "as report.export — a bulk extract of the same RLS-filtered rows",
  },
  // ── approval limits (Phase 12, requirement 2) ────────────────────────────
  {
    key: "approval.decide",
    capability: "approve_limit_request",
    guard: "assertCanDecideApproval",
    file: "src/modules/approvals/services/approvalService.ts",
    db: "public.decide_approval_request — requires approve_limit_request, decides once, a rejection needs a note",
  },
  {
    key: "approval.rules",
    capability: "manage_settings",
    guard: "assertCanEditApprovalRules",
    file: "src/modules/approvals/services/approvalService.ts",
    db: "public.set_approval_rules — requires manage_settings, audits the before and after",
  },
  {
    key: "audit.view",
    capability: "view_audit_log",
    guard: "assertCanViewAudit",
    file: "src/modules/audit/services/auditService.ts",
    db: "RLS select on audit_log — oversight roles only",
  },
  {
    key: "audit.export",
    capability: "export_data",
    guard: "assertCanExportAudit",
    file: "src/modules/audit/services/auditService.ts",
    db: "the audit trail is append-only and oversight-only; an export is a read",
  },
] as const;

export type SensitiveActionKey = (typeof SENSITIVE_ACTIONS)[number]["key"];

const BY_KEY = new Map<string, SensitiveAction>(SENSITIVE_ACTIONS.map((action) => [action.key, action]));

/** The register entry for an action key. Throws on a typo, which is the point. */
export function sensitiveAction(key: SensitiveActionKey | string): SensitiveAction {
  const action = BY_KEY.get(key);
  if (!action) throw new Error(`Unknown sensitive action '${key}' — add it to SENSITIVE_ACTIONS`);
  return action;
}

/** May the acting user perform this action right now? */
export function mayPerform(key: SensitiveActionKey | string): boolean {
  return canAct(sensitiveAction(key).capability);
}

/**
 * Refuse the action unless the acting user holds its capability.
 *
 * This is the call every sensitive service function makes before it touches
 * anything. It throws the app-wide `AppError("FORBIDDEN")`, naming the
 * capability, which is what screens already know how to render.
 */
export function assertSensitiveAction(key: SensitiveActionKey | string, message?: string): void {
  const action = sensitiveAction(key);
  assertCapability(action.capability, message ?? `You do not have permission to do this (${action.key}: ${action.capability})`);
}

/** Every capability the register uses, without duplicates — for tests and docs. */
export function registeredCapabilities(): Capability[] {
  return [...new Set(SENSITIVE_ACTIONS.map((action) => action.capability))];
}

/**
 * Capabilities the matrix grants but no sensitive action requires.
 *
 * Not an error on its own — `manage_users`, `manage_roles` and `manage_settings`
 * are asserted directly by the settings service, and the online-store
 * capabilities by its own providers — but a capability that appears here *and*
 * nowhere in `src/` is a dead gate, and the enforcement suite says so.
 */
export function unregisteredCapabilities(granted: readonly Capability[]): Capability[] {
  const registered = new Set(registeredCapabilities());
  return granted.filter((capability) => !registered.has(capability));
}

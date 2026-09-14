/**
 * Sale service — the funnel every sale mutation passes through.
 *
 * Before this file existed the register (`PosProvider`) and two pages called the
 * sales repository directly, and the only permission checks were the ones the UI
 * made before rendering a button: `canSell` in the provider's state, and a hidden
 * Void control on the detail page. Hiding a button is a courtesy. A keyboard
 * shortcut, a stale tab whose role changed, a provider callback invoked from a
 * test, or a hand-written call to `getSalesRepository().voidSale(…)` walked
 * straight past all of it.
 *
 * So the mutations live here, and each one asserts its capability *first*, using
 * the register in `src/lib/permissions/actions.ts`:
 *
 *   · completing a sale needs `sell`, and needs `apply_discount` as well when the
 *     cart carries a discount — checked against the input, not against what the
 *     cart setter allowed earlier, because the input is what gets written;
 *   · voiding needs `void_sale`; confirming a pending InstaPay needs
 *     `confirm_payment`.
 *
 * Two actions in the register have no implementation on purpose, and saying so
 * here is the point of them:
 *
 *   · **a completed sale cannot be edited.** `sales`, `sale_items` and
 *     `sale_payments` refuse every direct write for `authenticated` (migration
 *     0007), and no RPC updates a finished sale. A correction is a return, a
 *     refund or a void — each of which leaves a trail. `editSale()` therefore
 *     refuses for everybody, admin included, and `edit_sale` stays in the matrix
 *     as the gate for the day an amendment path is actually built.
 *   · **a sale cannot be deleted.** Same reason, and the same answer: `void_sale`
 *     is the sanctioned reversal, and it keeps the row, the number and the stock
 *     movement.
 *
 * In live mode these are the second of three layers: the RPC re-checks
 * `public.can()` and the tables have no write policy at all, so a client that
 * skips this file still cannot forge a sale. In demo mode — where the repository
 * is `localStorage` and there is no server to ask — this file is the only
 * enforcement there is, which is exactly why it is not optional.
 */
import { assertSensitiveAction } from "@/lib/permissions/actions";
import {
  assertRequestApplicable,
  assertWithinApprovalLimit,
  markRequestApplied,
  requirementForDiscount,
} from "@/modules/approvals/services/approvalService";
import { AppError } from "@/modules/products/data/repository";
import { recordAudit } from "@/modules/audit/services/auditService";
import { getSalesRepository } from "../data";
import type { CompleteSaleInput, ConfirmPaymentInput, Sale, VoidSaleInput } from "../types";

/** True when the input carries a discount that actually reduces the total. */
function hasDiscount(input: Pick<CompleteSaleInput, "discount_type" | "discount_value">): boolean {
  return input.discount_type !== "none" && Number(input.discount_value) > 0;
}

/**
 * The discount as a percentage of the pre-discount subtotal — the unit the
 * approval rule is written in.
 *
 * A percentage discount already is one. A fixed discount is converted using the
 * payments, which sum to the post-discount total, so subtotal = paid + discount.
 * Both are estimates of what the authoritative side will compute; the rule is a
 * gate on the *intent*, and the sale total itself is still calculated server-side.
 */
export function discountPercentOf(
  input: Pick<CompleteSaleInput, "discount_type" | "discount_value" | "payments">,
): number {
  if (!hasDiscount(input)) return 0;
  const value = Number(input.discount_value) || 0;
  if (input.discount_type === "percent") return value;
  const paid = (input.payments ?? []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const subtotal = paid + value;
  return subtotal > 0 ? (value / subtotal) * 100 : 0;
}

/** An approved over-limit discount being completed. See `ExpenseApproval`. */
export interface SaleApproval {
  requestId: string;
}

// ── guards ──────────────────────────────────────────────────────────────────

/**
 * May the acting user complete this sale?
 *
 * Takes the input rather than nothing, because the discount decision belongs to
 * the sale being written: a cashier who could set a discount a minute ago may not
 * be able to now, and the cart's memory of that is not authority.
 */
export function assertCanCompleteSale(input?: Pick<CompleteSaleInput, "discount_type" | "discount_value">): void {
  assertSensitiveAction("sale.complete");
  if (input && hasDiscount(input)) assertCanDiscountSale();
}

/** Discounts are a manager-level authority; the register maps them to `apply_discount`. */
export function assertCanDiscountSale(): void {
  assertSensitiveAction("sale.discount");
}

/** Voiding is the sanctioned reversal of a completed sale. */
export function assertCanVoidSale(): void {
  assertSensitiveAction("sale.void");
}

/** Marking a pending InstaPay sale as paid. */
export function assertCanConfirmPayment(): void {
  assertSensitiveAction("sale.confirm_payment");
}

/**
 * The capability exists; the write path does not. Asserted so that the register
 * entry is real, then refused by `editSale()` for everybody.
 */
export function assertCanEditSale(): void {
  assertSensitiveAction("sale.edit");
}

/** As `assertCanEditSale`: deletion is not a thing a sale can undergo. */
export function assertCanDeleteSale(): void {
  assertSensitiveAction("sale.delete");
}

// ── mutations ───────────────────────────────────────────────────────────────

/**
 * Complete a sale. Asserts `sell`, plus `apply_discount` when discounted, plus
 * the discount cap when the shop sets one (Phase 12, requirement 2).
 *
 * Over the cap, a till operator is refused with `approvalRequiredError` carrying
 * the whole draft, so the register can offer "send for approval" and an approver
 * can complete the exact same sale from the inbox. Passing `approval` is the only
 * way through: the request is re-read and must be approved, be a discount
 * request, and not have produced a sale already.
 */
export async function completeSale(
  input: CompleteSaleInput,
  approval?: SaleApproval,
): Promise<Sale> {
  assertCanCompleteSale(input);
  const discounted = hasDiscount(input);
  if (discounted) {
    if (approval) {
      await assertRequestApplicable(approval.requestId, "discount");
    } else {
      assertWithinApprovalLimit(await requirementForDiscount(discountPercentOf(input)));
    }
  }

  // The approval, when there is one, travels with the sale so the database can
  // validate and spend it. Since 0035 the check above is a UX optimisation: the
  // gate that cannot be walked around is inside pos_complete_sale.
  const sale = await getSalesRepository().completeSale(input, approval?.requestId ?? null);
  if (discounted && approval) await markRequestApplied(approval.requestId, sale.id);

  if (discounted) {
    // A discount is a price the shop chose not to charge, so it belongs in the
    // trail with its numbers: the amount taken off, and the percentage the
    // approval rule is written in (which is also the figure a discount report
    // needs, so the trail and the report cannot disagree about it). Written from
    // the funnel rather than the register, because the funnel is what every
    // discounted sale passes through — the till, an approved online order, and
    // an approver replaying an over-limit request all land here.
    // Fire-and-forget: a missing audit row must not un-sell a paid invoice.
    void recordAudit({
      action: "sale.discounted",
      entity: "sale",
      entity_id: sale.id,
      entity_label: sale.sale_number,
      details: {
        subtotal: sale.subtotal,
        discount_type: sale.discount_type,
        discount_value: sale.discount_value,
        discount_amount: sale.discount_amount,
        percent: Math.round(discountPercentOf(input) * 100) / 100,
        total: sale.total,
        customer: sale.customer_name ?? null,
        source: sale.source ?? "pos",
        approval: approval?.requestId ?? null,
      },
    });
  }
  return sale;
}

/** Void a completed sale, restocking once and keeping the record. */
export async function voidSale(id: string, input: VoidSaleInput): Promise<Sale> {
  assertCanVoidSale();
  const sale = await getSalesRepository().voidSale(id, input);
  // The reversal of a financial record, so the trail keeps the reason, the
  // amount taken out of revenue and how far the money had got (a void of a paid
  // invoice is a different event from a void of a pending one — one of them
  // still needs the cash back out of the drawer).
  void recordAudit({
    action: "sale.voided",
    entity: "sale",
    entity_id: sale.id,
    entity_label: sale.sale_number,
    details: {
      total: sale.total,
      items: sale.items.length,
      payment_status: sale.payment_status,
      source: sale.source ?? "pos",
      reason: input.reason ?? null,
    },
  });
  return sale;
}

/** Confirm a pending InstaPay payment. Totals, items and stock are untouched. */
export async function confirmPayment(id: string, input: ConfirmPaymentInput): Promise<Sale> {
  assertCanConfirmPayment();
  return getSalesRepository().confirmPayment(id, input);
}

/**
 * Refused for everybody, at every privilege level.
 *
 * A completed sale is a financial record: editing one would silently disagree
 * with the receipt already in the customer's hand, the stock already moved, and
 * the shift summary already counted. The sanctioned corrections are a return
 * (`return.create`), a refund (`refund.settle`) or a void (`sale.void`).
 */
export async function editSale(_id: string, _patch: unknown): Promise<never> {
  assertCanEditSale();
  throw new AppError(
    "VALIDATION",
    "A completed sale cannot be edited. Record a return, or void the sale.",
    "sale",
  );
}

/** Refused for everybody — see `editSale`. Voiding keeps the trail; deleting erases it. */
export async function deleteSale(_id: string): Promise<never> {
  assertCanDeleteSale();
  throw new AppError(
    "VALIDATION",
    "A sale cannot be deleted. Void it instead, which keeps the record and the stock movement.",
    "sale",
  );
}

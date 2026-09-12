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
import { AppError } from "@/modules/products/data/repository";
import { getSalesRepository } from "../data";
import type { CompleteSaleInput, ConfirmPaymentInput, Sale, VoidSaleInput } from "../types";

/** True when the input carries a discount that actually reduces the total. */
function hasDiscount(input: Pick<CompleteSaleInput, "discount_type" | "discount_value">): boolean {
  return input.discount_type !== "none" && Number(input.discount_value) > 0;
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

/** Complete a sale. Asserts `sell`, plus `apply_discount` when discounted. */
export async function completeSale(input: CompleteSaleInput): Promise<Sale> {
  assertCanCompleteSale(input);
  return getSalesRepository().completeSale(input);
}

/** Void a completed sale, restocking once and keeping the record. */
export async function voidSale(id: string, input: VoidSaleInput): Promise<Sale> {
  assertCanVoidSale();
  return getSalesRepository().voidSale(id, input);
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

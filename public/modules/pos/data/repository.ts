import type { CompleteSaleInput, ConfirmPaymentInput, Sale, VoidSaleInput } from "../types";
import { AppError } from "@/modules/products/data/repository";

/**
 * Persistence contract for the POS + Sales module.
 *
 * Implemented twice: against Supabase (live, transactional RPC) and against
 * localStorage (demo, single-browser atomic). Both share the same
 * data-safety rules:
 *
 *   1. stock is re-read fresh for every line before deduction
 *   2. totals are recalculated from product prices — cart values are ignored
 *   3. a `client_ref` idempotency key rejects duplicate submissions
 *   4. stock is never allowed to go negative
 */
export interface SalesRepository {
  readonly kind: "supabase" | "demo";

  completeSale(input: CompleteSaleInput): Promise<Sale>;
  listSales(): Promise<Sale[]>;
  getSale(id: string): Promise<Sale>;
  voidSale(id: string, input: VoidSaleInput): Promise<Sale>;
  /** Confirm a pending InstaPay payment. Idempotent; never changes totals. */
  confirmPayment(id: string, input: ConfirmPaymentInput): Promise<Sale>;
}

export { AppError };

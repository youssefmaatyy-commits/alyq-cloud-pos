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
/**
 * Bounds for a sales listing.
 *
 * Every field is optional so existing callers keep working unchanged, but
 * callers that show history or build reports should always pass at least one:
 * an unbounded select stops at the project's PostgREST row cap (1,000 by
 * default) and reports nothing about what it dropped, so the screen silently
 * presents a truncated set as complete history. Pair the listing with
 * countSales() and say out loud how much is missing.
 */
/**
 * The row ceiling a single select can return — PostgREST stops at 1,000 unless
 * the project is configured otherwise, so asking for more does not fetch more.
 *
 * Declared once, here, because three places need to agree on it: the Supabase
 * repository's default bound, the till's history window, and the reports read.
 * A cap that lives in three files is a cap that silently drifts in one of them,
 * and the drift looks like missing sales rather than a bug.
 */
export const SALES_ROW_CAP = 1000;

export interface SaleListQuery {
  /** Inclusive lower bound on the sale timestamp (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on the sale timestamp (ISO 8601). */
  to?: string;
  /** Maximum rows to return. The backend clamps anything larger anyway. */
  limit?: number;
  /** Rows to skip, for paging. */
  offset?: number;
}

export interface SalesRepository {
  readonly kind: "supabase" | "demo";

  completeSale(input: CompleteSaleInput): Promise<Sale>;
  listSales(query?: SaleListQuery): Promise<Sale[]>;
  /**
   * Exact number of sales matching the query's date bounds, ignoring
   * limit/offset. Returns null when the backend cannot supply one — unknown is
   * never reported as a total.
   */
  countSales(query?: SaleListQuery): Promise<number | null>;
  getSale(id: string): Promise<Sale>;
  voidSale(id: string, input: VoidSaleInput): Promise<Sale>;
  /** Confirm a pending InstaPay payment. Idempotent; never changes totals. */
  confirmPayment(id: string, input: ConfirmPaymentInput): Promise<Sale>;
}

export { AppError };

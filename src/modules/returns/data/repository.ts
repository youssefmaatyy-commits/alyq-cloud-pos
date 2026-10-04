import type {
  CreateReturnInput,
  RefundRecord,
  SalesReturn,
  SettleRefundInput,
  SettleRefundResult,
} from "../types";
import { AppError } from "@/modules/products/data/repository";

export interface ReturnRepository {
  readonly kind: "supabase" | "demo";

  listReturns(): Promise<SalesReturn[]>;
  getReturn(id: string): Promise<SalesReturn>;
  getReturnsForSale(saleId: string): Promise<SalesReturn[]>;
  createReturn(input: CreateReturnInput): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }>;

  listRefunds(): Promise<RefundRecord[]>;
  getRefundsForSale(saleId: string): Promise<RefundRecord[]>;

  /**
   * Settle (complete) or reject a pending refund — Phase 13, requirement 3.
   * Idempotent in the same direction, refused in the other, and it never
   * rewrites the money. Live mode delegates to `pos_settle_refund`; demo mode
   * enforces the same invariants locally.
   */
  settleRefund(refundId: string, input: SettleRefundInput): Promise<SettleRefundResult>;
}

export { AppError };

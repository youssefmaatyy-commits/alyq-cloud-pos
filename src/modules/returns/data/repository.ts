import type { CreateReturnInput, RefundRecord, SalesReturn } from "../types";
import { AppError } from "@/modules/products/data/repository";

export interface ReturnRepository {
  readonly kind: "supabase" | "demo";

  listReturns(): Promise<SalesReturn[]>;
  getReturn(id: string): Promise<SalesReturn>;
  createReturn(input: CreateReturnInput): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }>;

  listRefunds(): Promise<RefundRecord[]>;
  getRefundsForSale(saleId: string): Promise<RefundRecord[]>;
}

export { AppError };

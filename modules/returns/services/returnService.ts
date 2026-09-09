import { getReturnRepository } from "../data";
import type {
  CreateReturnInput,
  RefundRecord,
  ReturnFiltersValue,
  SalesReturn,
} from "../types";
import { normalizeText } from "@/modules/products/services/productQuery";

export async function loadReturns(): Promise<SalesReturn[]> {
  return getReturnRepository().listReturns();
}

export async function loadRefunds(): Promise<RefundRecord[]> {
  return getReturnRepository().listRefunds();
}

export async function processReturn(
  input: CreateReturnInput,
): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }> {
  return getReturnRepository().createReturn(input);
}

export function queryReturns(
  returnsList: SalesReturn[],
  filters: ReturnFiltersValue,
): SalesReturn[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return returnsList.filter((ret) => {
    if (terms.length > 0) {
      const haystack = normalizeText(
        `${ret.return_number} ${ret.sale_number} ${ret.customer_name ?? ""} ${ret.reason} ${ret.user_name}`,
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}

export function queryRefunds(
  refundsList: RefundRecord[],
  filters: ReturnFiltersValue,
): RefundRecord[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return refundsList.filter((ref) => {
    if (terms.length > 0) {
      const haystack = normalizeText(
        `${ref.refund_number} ${ref.sale_number} ${ref.payment_method} ${ref.reason ?? ""} ${ref.user_name}`,
      );
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}

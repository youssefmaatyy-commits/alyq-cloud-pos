/**
 * In-memory application of a SaleListQuery.
 *
 * The Supabase repository pushes the same bounds into SQL — that is the whole
 * point of the query object. This helper exists so the offline/demo backend
 * behaves identically (same ordering, same inclusive bounds, same paging), and
 * so the contract can be tested without a project.
 */

import type { SaleListQuery } from "./repository";
import type { Sale } from "../types";

export interface ApplySaleListOptions {
  /**
   * Ignore `limit`/`offset` and return every row matching the date bounds.
   * Used by countSales(), where paging would make the total meaningless.
   */
  ignorePaging?: boolean;
}

export function applySaleListQuery(
  sales: readonly Sale[],
  query: SaleListQuery = {},
  options: ApplySaleListOptions = {},
): Sale[] {
  const filtered = sales.filter((sale) => {
    // ISO-8601 timestamps compare correctly as strings, which keeps this in
    // step with the .gte/.lte the live query uses.
    if (query.from && sale.created_at < query.from) return false;
    if (query.to && sale.created_at > query.to) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (options.ignorePaging) return sorted;

  const offset = Math.max(0, query.offset ?? 0);
  if (query.limit === undefined && offset === 0) return sorted;
  const limit = Math.max(1, query.limit ?? sorted.length);
  return sorted.slice(offset, offset + limit);
}

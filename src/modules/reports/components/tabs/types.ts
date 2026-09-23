/** The props every advanced-report tab is handed: the raw rows and the window. */
import type { PickBilingual } from "@/lib/export";
import type { Sale } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import type { Customer } from "@/modules/customers/types";
import type { SalesReturn } from "@/modules/returns/types";
import type { OnlineOrder } from "@/modules/online/types";
import type { Expense } from "@/modules/expenses/types";
import type { Shift } from "@/modules/shifts/types";
import type { DateRange } from "../../services/financialExport";
import type { ShiftSummarizer } from "../../services/shiftAnalytics";

/**
 * One object, five tabs.
 *
 * Each tab takes the whole set and uses the part it needs, rather than five
 * different prop shapes: the reports are read together, they share one date
 * window, and a tab that only received "its" rows would tempt a caller to
 * pre-filter them differently per tab — which is how two reports on one screen
 * end up disagreeing about the same month.
 *
 * Rows are the providers' own, unfiltered and unranged. Ranging happens inside
 * the analytics (`salesInRange`, `expensesInRange`, `shiftsInRange`) so the
 * screen and the export apply the window once, in the same place.
 */
export interface ReportTabProps {
  range: DateRange;
  sales: readonly Sale[];
  products: readonly Product[];
  customers: readonly Customer[];
  expenses: readonly Expense[];
  shifts: readonly Shift[];
  summaryFor: ShiftSummarizer;
  pick: PickBilingual;
  /**
   * Phase 43: the catalogue's combinations, for the stock tiles that read the
   * shelves. Optional so a caller that has not loaded them still compiles —
   * the tiles then report a catalogue that never sells by variant.
   */
  variants?: readonly ProductVariant[];
  /**
   * Phase 43: settled returns, for the per-combination report's returned
   * columns. Optional like `variants` — a caller without them reports no
   * returns, which is exactly what it knows.
   */
  returns?: readonly SalesReturn[];
  /**
   * Phase 53: realized online orders (those with a sale_id), for promo-code
   * and delivery-fee KPIs. Optional — missing means those extras are zero.
   */
  orders?: readonly OnlineOrder[];
}

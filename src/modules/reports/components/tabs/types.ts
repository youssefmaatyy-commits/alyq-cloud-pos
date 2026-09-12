/** The props every advanced-report tab is handed: the raw rows and the window. */
import type { PickBilingual } from "@/lib/export";
import type { Sale } from "@/modules/pos/types";
import type { Product } from "@/modules/products/types";
import type { Customer } from "@/modules/customers/types";
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
}

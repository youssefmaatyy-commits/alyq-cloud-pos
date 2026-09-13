/**
 * Test entry for the report-aggregate differential suite
 * (`scripts/reports.aggregates.mjs`).
 *
 * Harness, not application code: nothing in `src/` imports it and
 * `tsconfig.app.json` includes only `src`. It exists so the suite can compute
 * the EXPECTED side of a comparison with the very functions the reports screen
 * uses today, rather than with a second implementation written for the test.
 *
 * That is the whole point of the suite. A database aggregate is only correct if
 * it agrees with the arithmetic the app already shipped and already tested —
 * `computeFinancialTotals`, `salesByPaymentMethod`, `salesByEmployee`,
 * `salesTrend`, `productPerformance`, `stockValueTotals`, `buildExpenseReport`.
 * Re-deriving those numbers inside the test would prove only that the test
 * agrees with itself.
 *
 * The range helpers are exported for the same reason: the suite must ask the
 * app what "inside this window" means (`salesInRange`, `expensesInRange`,
 * `withinDateRange`) instead of inventing its own filter, so that a disagreement
 * between the two sides is a disagreement about the aggregate and never about
 * whose idea of a day is being tested.
 */
export {
  computeFinancialTotals,
  revenueSales,
  type DateRange,
  type FinancialTotals,
} from "../../src/modules/reports/services/financialExport";

export {
  salesByPaymentMethod,
  salesByEmployee,
  salesTrend,
  productPerformance,
  stockValueTotals,
  salesInRange,
  dayKeyOf,
} from "../../src/modules/reports/services/salesAnalytics";

export {
  buildExpenseReport,
  expensesInRange,
} from "../../src/modules/reports/services/expenseAnalytics";

export { summarizeExpenses } from "../../src/modules/expenses/services/expenseService";
export { roundMoney } from "../../src/modules/expenses/validation";

/** The app's own "is this timestamp inside the window" rule. */
export { withinDateRange } from "../../src/lib/export/excelExport";

// The cap the browser-side path is limited by, and the app's own local-day bound
// conversion — the suite must send the database the same bounds the screen
// sends, not a second idea of where a day starts.
export { SALES_ROW_CAP } from "../../src/modules/pos/data/repository";
export { toTimestampBounds, isoDate } from "../../src/modules/reports/services/dateRanges";

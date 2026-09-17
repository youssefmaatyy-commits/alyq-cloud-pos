/** Reports & data export module — public surface. */

export { ReportsPage } from "./pages/ReportsPage";
export { AdvancedReportsPage } from "./pages/AdvancedReportsPage";

// Advanced report analytics (Phase 14, requirement 7). Exported so the dashboard
// and the Expenses / Shifts screens read the same numbers the reports do — the
// point of the layer is that there is one of each calculation.
export {
  UNATTRIBUTED_REGISTER,
  bestSellers,
  buildSalesAnalytics,
  customerPurchaseHistory,
  customerSpendingSummary,
  dayKeyOf,
  marginSummary,
  productPerformance,
  salesByEmployee,
  salesByPaymentMethod,
  salesByRegister,
  salesInRange,
  salesTrend,
  slowMovers,
  stockValueTotals,
  topCustomers,
} from "./services/salesAnalytics";
export type {
  CustomerReportRow,
  CustomerSpendingSummary,
  EmployeeSalesRow,
  MarginSummary,
  PaymentMethodSalesRow,
  ProductPerformanceRow,
  RegisterSalesRow,
  SalesAnalytics,
  SlowMoverRow,
  StockValueTotals,
  TrendPoint,
} from "./services/salesAnalytics";

export {
  buildExpenseReport,
  expensesByDay,
  expensesInRange,
} from "./services/expenseAnalytics";

// Phase 43: the per-combination read — the database RPC first, the browser
// arithmetic as the fallback both modes agree with.
export {
  computeVariantPerformance,
  fetchVariantPerformance,
  type ComputeVariantPerformanceInput,
  type VariantPerformanceRow,
} from "./services/variantPerformance";
export type {
  ExpenseBreakdownRow,
  ExpenseDayRow,
  ExpenseReport,
} from "./services/expenseAnalytics";

export {
  buildShiftReport,
  cashDifferenceRows,
  cashDifferenceSummary,
  dailyShiftReport,
  employeeShiftPerformance,
  shiftReportRow,
  shiftsInRange,
} from "./services/shiftAnalytics";
export type {
  CashDifferenceSummary,
  DailyShiftRow,
  EmployeeShiftRow,
  ShiftReport,
  ShiftReportRow,
  ShiftReportTotals,
  ShiftSummarizer,
} from "./services/shiftAnalytics";

export {
  buildCustomerAnalyticsSheets,
  buildExpenseAnalyticsSheets,
  buildProductAnalyticsSheets,
  buildSalesAnalyticsSheets,
  buildShiftAnalyticsSheets,
} from "./services/analyticsExport";
export {
  DateRangePicker,
  EMPTY_DATE_RANGE,
  isoDate,
  presetRange,
  toExportRange,
} from "./components/DateRangePicker";
export type { DateRangeValue, RangePreset } from "./components/DateRangePicker";

export {
  buildCashLedger,
  buildCashMovementsSheets,
  buildPaymentsSheets,
  cashLedgerSheetOf,
  computeFinancialTotals,
  costOfGoodsSold,
  buildFinancialSheets,
  OPEN_DATE_RANGE,
  paymentCountOf,
  paymentsSheetOf,
  paymentRowsOf,
  rangeLabelOf,
  revenueSales,
} from "./services/financialExport";
export type { DateRange, FinancialExportInput, FinancialTotals } from "./services/financialExport";

export {
  buildSupplierActivity,
  buildSuppliersSheets,
  summarizeSuppliers,
} from "./services/suppliersExport";
export type { SuppliersExportInput, SupplierActivityRow } from "./services/suppliersExport";

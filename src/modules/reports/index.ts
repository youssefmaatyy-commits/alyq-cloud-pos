/** Reports & data export module — public surface. */

export { ReportsPage } from "./pages/ReportsPage";
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
  computeFinancialTotals,
  costOfGoodsSold,
  buildFinancialSheets,
  OPEN_DATE_RANGE,
  revenueSales,
} from "./services/financialExport";
export type { DateRange, FinancialExportInput, FinancialTotals } from "./services/financialExport";

export {
  buildSupplierActivity,
  buildSuppliersSheets,
  summarizeSuppliers,
} from "./services/suppliersExport";
export type { SuppliersExportInput, SupplierActivityRow } from "./services/suppliersExport";

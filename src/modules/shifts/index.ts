/** Cashier Shifts module — public surface (Phase 8). */

export { ShiftProvider, useShifts } from "./hooks/ShiftProvider";
export type { ShiftContextValue } from "./hooks/ShiftProvider";
export { ShiftDashboardPage } from "./pages/ShiftDashboardPage";
export { ShiftHistoryPage } from "./pages/ShiftHistoryPage";
export { EndOfDayPage } from "./pages/EndOfDayPage";
export { OpenShiftModal } from "./components/OpenShiftModal";
export { CloseShiftModal } from "./components/CloseShiftModal";
export { ShiftSummaryGrid } from "./components/ShiftSummaryGrid";
export {
  cashDifference,
  computeShiftSummary,
  differenceLabelKey,
  differenceTone,
  expectedCashOf,
  expenseBelongsToShift,
  isWithinWindow,
  padShiftSummary,
  saleBelongsToShift,
  saleDiscountBuckets,
  shiftWindowOf,
} from "./services/shiftCalculations";
export type { ShiftSources, ShiftWindow } from "./services/shiftCalculations";
export { buildEndOfDay } from "./services/endOfDay";
export type { EndOfDayReport, EndOfDayTotals } from "./services/endOfDay";
export { buildEndOfDaySheets, buildShiftDetailSheets } from "./services/eodExport";
export { queryShifts, shiftDuration } from "./services/shiftService";
export {
  canAddExpense,
  canApproveAdjustment,
  canCloseShift,
  canDeleteExpense,
  canEditExpense,
  canOpenShift,
  canViewAllShifts,
  canViewAuditLog,
} from "./permissions";
export type {
  CloseShiftFormValues,
  CloseShiftInput,
  NewShift,
  Shift,
  ShiftFiltersValue,
  ShiftFormValues,
  ShiftStatus,
  ShiftSummary,
} from "./types";
export { EMPTY_CLOSE_SHIFT_FORM, EMPTY_SHIFT_FILTERS, EMPTY_SHIFT_FORM, SHIFT_REGISTERS } from "./types";
export { getShiftRepository, getShiftMode } from "./data";
export type { ShiftRepository } from "./data";
export { parseMoney, validateCloseDraft, validateShiftDraft } from "./validation";

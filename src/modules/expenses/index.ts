/** Expenses module — public surface (Phase 8). */

export { ExpenseProvider, useExpenses } from "./hooks/ExpenseProvider";
export type { ExpenseContextValue } from "./hooks/ExpenseProvider";
export { ExpensesPage } from "./pages/ExpensesPage";
export { ExpenseFormModal } from "./components/ExpenseFormModal";
export { queryExpenses, summarizeExpenses } from "./services/expenseService";
export type { ExpenseSummary } from "./services/expenseService";
export { getExpenseRepository, getExpenseMode } from "./data";
export type { ExpenseRepository } from "./data";
export {
  MAX_EXPENSE_AMOUNT,
  MAX_EXPENSE_NAME,
  MAX_EXPENSE_NOTES,
  roundMoney,
  toDateTimeLocal,
  toSpentAtIso,
  validateExpense,
} from "./validation";
export type { ExpenseErrors, ExpenseFieldCode, ExpenseValidationResult } from "./validation";
export {
  EMPTY_EXPENSE_FILTERS,
  EMPTY_EXPENSE_FORM,
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
} from "./types";
export type {
  Expense,
  ExpenseCategory,
  ExpenseFiltersValue,
  ExpenseFormValues,
  ExpensePatch,
  ExpensePaymentMethod,
  NewExpense,
} from "./types";

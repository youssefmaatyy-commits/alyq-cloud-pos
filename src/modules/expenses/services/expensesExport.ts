/**
 * Expenses export — the Expenses screen's own file.
 *
 * The sheet is the financial report's Expenses sheet (`expensesSheetOf`), so the
 * two cannot drift apart: same columns, same labels, same total. What differs is
 * the rows — here they are whatever the screen is showing, so the search box and
 * the category and payment-method filters all apply.
 */
import { buildSheets, type BuiltSheet, type Translate } from "@/lib/export";
import { expensesSheetOf } from "@/modules/reports/services/financialExport";

import type { Expense } from "../types";

export interface ExpensesExportInput {
  /** Already filtered by the screen. */
  expenses: readonly Expense[];
  t: Translate;
}

export function buildExpensesSheets(input: ExpensesExportInput): BuiltSheet[] {
  return buildSheets([expensesSheetOf(input.expenses, input.t)]);
}

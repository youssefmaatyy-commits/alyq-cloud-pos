import { assertSensitiveAction } from "@/lib/permissions/actions";
import { getExpenseRepository } from "../data";
import type { Expense, ExpenseFiltersValue, NewExpense } from "../types";
import { normalizeText } from "@/modules/products/services/productQuery";
import { roundMoney } from "../validation";

/** Load every expense (newest first). */
export async function loadExpenses(): Promise<Expense[]> {
  return getExpenseRepository().listExpenses();
}

/** Creating an expense needs `add_expense`. */
export function assertCanCreateExpense(): void {
  assertSensitiveAction("expense.create");
}

/** Editing one needs `edit_expense` — a cashier may record spending, not rewrite it. */
export function assertCanEditExpense(): void {
  assertSensitiveAction("expense.edit");
}

/** Deleting one needs `delete_expense`. */
export function assertCanDeleteExpense(): void {
  assertSensitiveAction("expense.delete");
}

/** Approving or rejecting one needs `approve_expense`. */
export function assertCanApproveExpense(): void {
  assertSensitiveAction("expense.approve");
}

export async function createExpense(input: NewExpense): Promise<Expense> {
  assertCanCreateExpense();
  return getExpenseRepository().createExpense(input);
}

export async function updateExpense(
  id: string,
  patch: Parameters<ReturnType<typeof getExpenseRepository>["updateExpense"]>[1],
): Promise<Expense> {
  assertCanEditExpense();
  return getExpenseRepository().updateExpense(id, patch);
}

export async function deleteExpense(id: string): Promise<void> {
  assertCanDeleteExpense();
  return getExpenseRepository().deleteExpense(id);
}

export function queryExpenses(expenses: Expense[], filters: ExpenseFiltersValue): Expense[] {
  const terms = normalizeText(filters.search).split(" ").filter(Boolean);

  return expenses.filter((expense) => {
    if (filters.category !== "all" && expense.category !== filters.category) return false;
    if (filters.method !== "all" && expense.payment_method !== filters.method) return false;
    if (terms.length === 0) return true;
    const haystack = normalizeText(
      `${expense.expense_number} ${expense.name} ${expense.notes ?? ""} ${expense.user_name} ${expense.branch ?? ""}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export interface ExpenseSummary {
  count: number;
  total: number;
  cash: number;
  instapay: number;
  visa: number;
  byCategory: Record<string, number>;
}

export function summarizeExpenses(expenses: Expense[]): ExpenseSummary {
  let total = 0;
  let cash = 0;
  let instapay = 0;
  let visa = 0;
  const byCategory: Record<string, number> = {};

  for (const expense of expenses) {
    total += expense.amount;
    if (expense.payment_method === "cash") cash += expense.amount;
    if (expense.payment_method === "instapay") instapay += expense.amount;
    if (expense.payment_method === "visa") visa += expense.amount;
    byCategory[expense.category] = roundMoney((byCategory[expense.category] ?? 0) + expense.amount);
  }

  return {
    count: expenses.length,
    total: roundMoney(total),
    cash: roundMoney(cash),
    instapay: roundMoney(instapay),
    visa: roundMoney(visa),
    byCategory,
  };
}

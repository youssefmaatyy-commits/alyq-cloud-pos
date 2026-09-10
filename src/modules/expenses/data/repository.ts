import type { Expense, ExpensePatch, NewExpense } from "../types";

/** Persistence contract for the expenses module. */
export interface ExpenseRepository {
  readonly kind: "supabase" | "demo";

  listExpenses(): Promise<Expense[]>;
  getExpense(id: string): Promise<Expense>;
  createExpense(input: NewExpense): Promise<Expense>;
  updateExpense(id: string, patch: ExpensePatch): Promise<Expense>;
  deleteExpense(id: string): Promise<void>;
}

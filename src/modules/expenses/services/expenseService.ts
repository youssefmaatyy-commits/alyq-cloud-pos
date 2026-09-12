import { assertSensitiveAction } from "@/lib/permissions/actions";
import {
  assertRequestApplicable,
  markRequestApplied,
  requirementForExpense,
  assertWithinApprovalLimit,
} from "@/modules/approvals/services/approvalService";
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

/**
 * An approved over-limit request being executed. Supplying it is the only way
 * past the expense cap: the request is re-read and re-checked here, so a flag in
 * a request body cannot invent authority.
 */
export interface ExpenseApproval {
  requestId: string;
}

/**
 * Record an expense.
 *
 * Two gates, in order: `add_expense` (may this person file spending at all?) and
 * the approval limit (is this amount theirs to file without a second signature?).
 * An expense above the cap is refused with `approvalRequiredError`, which the
 * form turns into "send for approval" — the expense is then created by whoever
 * the request is approved for, through this same function.
 */
export async function createExpense(
  input: NewExpense,
  approval?: ExpenseApproval,
): Promise<Expense> {
  assertCanCreateExpense();
  if (approval) {
    await assertRequestApplicable(approval.requestId, "expense");
  } else {
    assertWithinApprovalLimit(await requirementForExpense(input.amount));
  }

  const expense = await getExpenseRepository().createExpense(input);
  if (approval) await markRequestApplied(approval.requestId, expense.id);
  return expense;
}

export async function updateExpense(
  id: string,
  patch: Parameters<ReturnType<typeof getExpenseRepository>["updateExpense"]>[1],
  approval?: ExpenseApproval,
): Promise<Expense> {
  assertCanEditExpense();
  // Raising an expense over the cap is the same act as filing it over the cap:
  // editing the amount cannot be the way around the rule.
  if (typeof patch.amount === "number") {
    if (approval) {
      await assertRequestApplicable(approval.requestId, "expense");
    } else {
      assertWithinApprovalLimit(await requirementForExpense(patch.amount));
    }
  }

  const expense = await getExpenseRepository().updateExpense(id, patch);
  if (approval && typeof patch.amount === "number") {
    await markRequestApplied(approval.requestId, expense.id);
  }
  return expense;
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

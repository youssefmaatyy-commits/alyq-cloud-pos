import { safeStorage } from "@/modules/products/data/demoSeed";
import { AppError } from "@/modules/products/data/repository";
import { roundMoney } from "../validation";
import type { Expense, ExpensePatch, NewExpense } from "../types";
import type { ExpenseRepository } from "./repository";

const EXPENSES_KEY = "alyq.demo.expenses.v1";
const COUNTER_KEY = "alyq.demo.expense_counter.v1";
const LATENCY = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function newId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `exp-${rand}`;
}

function load(): Expense[] {
  const raw = safeStorage.get(EXPENSES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Expense[]) : [];
  } catch {
    return [];
  }
}

function persist(list: Expense[]): void {
  safeStorage.set(EXPENSES_KEY, JSON.stringify(list));
}

/** Sequential, human-readable expense numbers (EXP-000001). */
function nextExpenseNumber(): string {
  const current = Number(safeStorage.get(COUNTER_KEY)) || 0;
  const next = Math.max(1, current + 1);
  safeStorage.set(COUNTER_KEY, String(next));
  return `EXP-${String(next).padStart(6, "0")}`;
}

export class DemoExpenseRepository implements ExpenseRepository {
  readonly kind = "demo" as const;
  private expenses: Expense[];

  constructor() {
    this.expenses = load();
  }

  async listExpenses(): Promise<Expense[]> {
    return delay([...this.expenses].sort((a, b) => b.spent_at.localeCompare(a.spent_at)));
  }

  async getExpense(id: string): Promise<Expense> {
    const found = this.expenses.find((e) => e.id === id);
    if (!found) throw new AppError("NOT_FOUND", `Expense ${id} not found`);
    return delay(found);
  }

  async createExpense(input: NewExpense): Promise<Expense> {
    const now = nowIso();
    const expense: Expense = {
      ...input,
      id: newId(),
      expense_number: nextExpenseNumber(),
      amount: roundMoney(input.amount),
      created_at: now,
      updated_at: now,
    };
    this.expenses = [expense, ...this.expenses];
    persist(this.expenses);
    return delay(expense, 60);
  }

  async updateExpense(id: string, patch: ExpensePatch): Promise<Expense> {
    const index = this.expenses.findIndex((e) => e.id === id);
    if (index < 0) throw new AppError("NOT_FOUND", `Expense ${id} not found`);
    const updated: Expense = {
      ...this.expenses[index],
      ...patch,
      amount: patch.amount != null ? roundMoney(patch.amount) : this.expenses[index].amount,
      updated_at: nowIso(),
    };
    this.expenses = this.expenses.map((e) => (e.id === id ? updated : e));
    persist(this.expenses);
    return delay(updated, 60);
  }

  async deleteExpense(id: string): Promise<void> {
    const before = this.expenses.length;
    this.expenses = this.expenses.filter((e) => e.id !== id);
    if (this.expenses.length === before) {
      throw new AppError("NOT_FOUND", `Expense ${id} not found`);
    }
    persist(this.expenses);
    await delay(undefined, 60);
  }

  /** Test/dev helper. */
  reset(): void {
    this.expenses = [];
    persist(this.expenses);
    safeStorage.set(COUNTER_KEY, "0");
  }
}

let singleton: DemoExpenseRepository | null = null;
export function getDemoExpenseRepository(): DemoExpenseRepository {
  if (!singleton) singleton = new DemoExpenseRepository();
  return singleton;
}

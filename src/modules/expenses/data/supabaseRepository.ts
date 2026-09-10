import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { Expense, ExpensePatch, NewExpense } from "../types";
import type { ExpenseRepository } from "./repository";

interface ExpenseRow {
  id: string;
  expense_number: string;
  name: string;
  category: string;
  amount: number;
  payment_method: string;
  spent_at: string;
  notes: string | null;
  attachment_url: string | null;
  attachment_name: string | null;
  branch: string | null;
  shift_id: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
  updated_at: string;
}

function mapExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    expense_number: row.expense_number,
    name: row.name,
    category: row.category as Expense["category"],
    amount: Number(row.amount),
    payment_method: row.payment_method as Expense["payment_method"],
    spent_at: row.spent_at,
    notes: row.notes,
    attachment_url: row.attachment_url,
    attachment_name: row.attachment_name,
    branch: row.branch,
    shift_id: row.shift_id,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SupabaseExpenseRepository implements ExpenseRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async listExpenses(): Promise<Expense[]> {
    try {
      const { data, error } = await this.require()
        .from("expenses")
        .select("*")
        .order("spent_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as ExpenseRow[]) ?? []).map(mapExpense);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getExpense(id: string): Promise<Expense> {
    try {
      const { data, error } = await this.require()
        .from("expenses")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw toAppError(error);
      return mapExpense(data as ExpenseRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async createExpense(input: NewExpense): Promise<Expense> {
    try {
      const { data, error } = await this.require()
        .from("expenses")
        .insert({
          name: input.name,
          category: input.category,
          amount: input.amount,
          payment_method: input.payment_method,
          spent_at: input.spent_at,
          notes: input.notes,
          attachment_url: input.attachment_url,
          attachment_name: input.attachment_name,
          branch: input.branch,
          shift_id: input.shift_id,
          user_id: input.user_id,
          user_name: input.user_name,
        })
        .select("*")
        .single();
      if (error) throw toAppError(error);
      return mapExpense(data as ExpenseRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async updateExpense(id: string, patch: ExpensePatch): Promise<Expense> {
    try {
      const { data, error } = await this.require()
        .from("expenses")
        .update({
          ...patch,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw toAppError(error);
      return mapExpense(data as ExpenseRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async deleteExpense(id: string): Promise<void> {
    try {
      const { error } = await this.require().from("expenses").delete().eq("id", id);
      if (error) throw toAppError(error);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseExpenseRepository | null = null;
export function getSupabaseExpenseRepository(): SupabaseExpenseRepository {
  if (!singleton) singleton = new SupabaseExpenseRepository();
  return singleton;
}

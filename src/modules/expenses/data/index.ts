import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoExpenseRepository, getDemoExpenseRepository } from "./demoRepository";
import { SupabaseExpenseRepository, getSupabaseExpenseRepository } from "./supabaseRepository";
import type { ExpenseRepository } from "./repository";

export type ExpenseMode = "supabase" | "demo";

export function getExpenseRepository(): ExpenseRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseExpenseRepository();
  }
  return getDemoExpenseRepository();
}

export function getExpenseMode(): ExpenseMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoExpenseRepository, SupabaseExpenseRepository };
export type { ExpenseRepository } from "./repository";

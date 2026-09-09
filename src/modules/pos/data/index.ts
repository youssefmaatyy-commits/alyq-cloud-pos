import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoSalesRepository, getDemoSalesRepository } from "./demoRepository";
import { SupabaseSalesRepository, getSupabaseSalesRepository } from "./supabaseRepository";
import type { SalesRepository } from "./repository";

export type SalesMode = "supabase" | "demo";

export function getSalesRepository(): SalesRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseSalesRepository();
  }
  return getDemoSalesRepository();
}

export function getSalesMode(): SalesMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoSalesRepository, SupabaseSalesRepository };
export type { SalesRepository } from "./repository";

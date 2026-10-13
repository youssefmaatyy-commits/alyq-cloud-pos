import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoSalesRepository, getDemoSalesRepository } from "./demoRepository";
import { SupabaseSalesRepository, getSupabaseSalesRepository } from "./supabaseRepository";
import type { SalesRepository } from "./repository";

export type SalesMode = "supabase" | "demo";

export function getSalesRepository(): SalesRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseSalesRepository();
  }
  return getDemoSalesRepository();
}

export function getSalesMode(): SalesMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoSalesRepository, SupabaseSalesRepository };
export { SALES_ROW_CAP } from "./repository";
export type { SaleListQuery, SalesRepository } from "./repository";

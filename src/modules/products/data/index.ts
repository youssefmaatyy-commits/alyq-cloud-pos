import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoRepository, getDemoRepository } from "./demoRepository";
import { getSupabaseRepository, SupabaseRepository } from "./supabaseRepository";
import type { CatalogRepository } from "./repository";

export type CatalogMode = "supabase" | "demo";

/**
 * Single place where the active persistence backend is chosen.
 * Demo requires explicit application mode. Invalid Production is refused.
 */
export function getCatalogRepository(): CatalogRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseRepository();
  }
  return getDemoRepository();
}

export function getCatalogMode(): CatalogMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoRepository, SupabaseRepository };
export type { CatalogRepository };
export * from "./repository";

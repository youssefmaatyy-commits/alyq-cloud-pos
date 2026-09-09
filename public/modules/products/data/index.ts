import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoRepository, getDemoRepository } from "./demoRepository";
import { getSupabaseRepository, SupabaseRepository } from "./supabaseRepository";
import type { CatalogRepository } from "./repository";

export type CatalogMode = "supabase" | "demo";

/**
 * Single place where the active persistence backend is chosen.
 * Falls back to the demo repository whenever Supabase env vars are absent or
 * malformed, so the module never crashes at runtime.
 */
export function getCatalogRepository(): CatalogRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseRepository();
  }
  return getDemoRepository();
}

export function getCatalogMode(): CatalogMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoRepository, SupabaseRepository };
export type { CatalogRepository };
export * from "./repository";

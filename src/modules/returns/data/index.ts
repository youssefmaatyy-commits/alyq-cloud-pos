import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoReturnRepository, getDemoReturnRepository } from "./demoRepository";
import { SupabaseReturnRepository, getSupabaseReturnRepository } from "./supabaseRepository";
import type { ReturnRepository } from "./repository";

export type ReturnMode = "supabase" | "demo";

export function getReturnRepository(): ReturnRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseReturnRepository();
  }
  return getDemoReturnRepository();
}

export function getReturnMode(): ReturnMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoReturnRepository, SupabaseReturnRepository };
export type { ReturnRepository } from "./repository";

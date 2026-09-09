import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoReturnRepository, getDemoReturnRepository } from "./demoRepository";
import { SupabaseReturnRepository, getSupabaseReturnRepository } from "./supabaseRepository";
import type { ReturnRepository } from "./repository";

export type ReturnMode = "supabase" | "demo";

export function getReturnRepository(): ReturnRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseReturnRepository();
  }
  return getDemoReturnRepository();
}

export function getReturnMode(): ReturnMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoReturnRepository, SupabaseReturnRepository };
export type { ReturnRepository } from "./repository";

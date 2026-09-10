import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { getDemoUserRepository } from "./demoRepository";
import { getSupabaseUserRepository } from "./supabaseRepository";
import type { UserRepository } from "./repository";

export type AuthMode = "supabase" | "demo";

/** The repository for the current environment (same rule as every other module). */
export function getUserRepository(): UserRepository {
  if (isSupabaseConfigured && getSupabaseClient()) return getSupabaseUserRepository();
  return getDemoUserRepository();
}

export function getAuthMode(): AuthMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoUserRepository, getDemoUserRepository } from "./demoRepository";
export { SupabaseUserRepository, getSupabaseUserRepository } from "./supabaseRepository";
export type { UserRepository, AuthenticateResult, AuthUserSummary } from "./repository";

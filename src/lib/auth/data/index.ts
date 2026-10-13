import { getRepositoryMode } from "@/lib/supabase/client";
import { getDemoUserRepository, resetDemoUserRepository } from "./demoRepository";
import { getSupabaseUserRepository, resetSupabaseUserRepository } from "./supabaseRepository";
import type { UserRepository } from "./repository";

export type AuthMode = "supabase" | "demo";

/** The repository for the current environment (same rule as every other module). */
export function getUserRepository(): UserRepository {
  if (getRepositoryMode() === "supabase") return getSupabaseUserRepository();
  return getDemoUserRepository();
}

export function getAuthMode(): AuthMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoUserRepository, getDemoUserRepository, resetDemoUserRepository } from "./demoRepository";
export { SupabaseUserRepository, getSupabaseUserRepository, resetSupabaseUserRepository } from "./supabaseRepository";
export type {
  UserRepository,
  AuthenticateResult,
  AuthUserSummary,
  AuthChangeEvent,
  LiveSessionInfo,
  PasswordUpdateResult,
  RecoveryLinkParts,
  RecoveryLinkResult,
} from "./repository";

/** Test seam: drop the repository singletons so the next call re-reads state. */
export function resetAuthRepositories(): void {
  resetDemoUserRepository();
  resetSupabaseUserRepository();
}

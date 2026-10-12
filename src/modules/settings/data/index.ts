import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoSettingsRepository, getDemoSettingsRepository, resetDemoSettingsRepository } from "./demoRepository";
import {
  SupabaseSettingsRepository,
  getSupabaseSettingsRepository,
  resetSupabaseSettingsRepository,
} from "./supabaseRepository";
import type { SettingsRepository } from "./repository";

export type SettingsMode = "supabase" | "demo";

export function getSettingsRepository(): SettingsRepository {
  if (getRepositoryMode() === "supabase") return getSupabaseSettingsRepository();
  return getDemoSettingsRepository();
}

export function getSettingsMode(): SettingsMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

/** Test seam. */
export function resetSettingsRepositories(): void {
  resetDemoSettingsRepository();
  resetSupabaseSettingsRepository();
}

export { DemoSettingsRepository, SupabaseSettingsRepository };
export type { SettingsRepository, CustomRoleInput } from "./repository";

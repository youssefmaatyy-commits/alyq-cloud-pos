import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoSettingsRepository, getDemoSettingsRepository, resetDemoSettingsRepository } from "./demoRepository";
import {
  SupabaseSettingsRepository,
  getSupabaseSettingsRepository,
  resetSupabaseSettingsRepository,
} from "./supabaseRepository";
import type { SettingsRepository } from "./repository";

export type SettingsMode = "supabase" | "demo";

export function getSettingsRepository(): SettingsRepository {
  if (isSupabaseConfigured && getSupabaseClient()) return getSupabaseSettingsRepository();
  return getDemoSettingsRepository();
}

export function getSettingsMode(): SettingsMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

/** Test seam. */
export function resetSettingsRepositories(): void {
  resetDemoSettingsRepository();
  resetSupabaseSettingsRepository();
}

export { DemoSettingsRepository, SupabaseSettingsRepository };
export type { SettingsRepository, CustomRoleInput } from "./repository";

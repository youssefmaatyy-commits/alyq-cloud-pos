import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoBackupRepository, getDemoBackupRepository, resetDemoBackupRepository } from "./demoRepository";
import {
  SupabaseBackupRepository,
  getSupabaseBackupRepository,
  resetSupabaseBackupRepository,
} from "./supabaseRepository";
import type { BackupRepository } from "./repository";

export type BackupMode = "supabase" | "demo";

export function getBackupRepository(): BackupRepository {
  if (isSupabaseConfigured && getSupabaseClient()) return getSupabaseBackupRepository();
  return getDemoBackupRepository();
}

export function getBackupMode(): BackupMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

/** Test seam. */
export function resetBackupRepositories(): void {
  resetDemoBackupRepository();
  resetSupabaseBackupRepository();
}

export { DemoBackupRepository, SupabaseBackupRepository };
export type { BackupRepository } from "./repository";

import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoShiftRepository, getDemoShiftRepository } from "./demoRepository";
import { SupabaseShiftRepository, getSupabaseShiftRepository } from "./supabaseRepository";
import type { ShiftRepository } from "./repository";

export type ShiftMode = "supabase" | "demo";

export function getShiftRepository(): ShiftRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseShiftRepository();
  }
  return getDemoShiftRepository();
}

export function getShiftMode(): ShiftMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoShiftRepository, SupabaseShiftRepository };
export type { ShiftRepository } from "./repository";

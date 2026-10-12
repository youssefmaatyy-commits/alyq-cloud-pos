import { getRepositoryMode } from "@/lib/supabase/client";
import {
  DemoInventoryRepository,
  applyDemoAdjustment,
  getDemoInventoryRepository,
} from "./demoRepository";
import {
  SupabaseInventoryRepository,
  applySupabaseAdjustment,
  getSupabaseInventoryRepository,
} from "./supabaseRepository";
import type { InventoryRepository } from "./repository";

export type InventoryMode = "supabase" | "demo";

export function getInventoryRepository(): InventoryRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseInventoryRepository();
  }
  return getDemoInventoryRepository();
}

export function getInventoryMode(): InventoryMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoInventoryRepository, SupabaseInventoryRepository };
export { applyDemoAdjustment, applySupabaseAdjustment };
export type { InventoryRepository, AdjustStockArgs } from "./repository";

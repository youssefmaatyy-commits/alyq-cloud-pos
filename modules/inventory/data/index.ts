import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
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
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseInventoryRepository();
  }
  return getDemoInventoryRepository();
}

export function getInventoryMode(): InventoryMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoInventoryRepository, SupabaseInventoryRepository };
export { applyDemoAdjustment, applySupabaseAdjustment };
export type { InventoryRepository, AdjustStockArgs } from "./repository";

import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoAuditRepository, getDemoAuditRepository } from "./demoRepository";
import { SupabaseAuditRepository, getSupabaseAuditRepository } from "./supabaseRepository";
import type { AuditRepository } from "./repository";

export type AuditMode = "supabase" | "demo";

export function getAuditRepository(): AuditRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseAuditRepository();
  }
  return getDemoAuditRepository();
}

export function getAuditMode(): AuditMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoAuditRepository, SupabaseAuditRepository };
export type { AuditRepository } from "./repository";

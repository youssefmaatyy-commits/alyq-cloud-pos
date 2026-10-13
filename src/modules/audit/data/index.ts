import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoAuditRepository, getDemoAuditRepository } from "./demoRepository";
import { SupabaseAuditRepository, getSupabaseAuditRepository } from "./supabaseRepository";
import type { AuditRepository } from "./repository";

export type AuditMode = "supabase" | "demo";

export function getAuditRepository(): AuditRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseAuditRepository();
  }
  return getDemoAuditRepository();
}

export function getAuditMode(): AuditMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoAuditRepository, SupabaseAuditRepository };
export type { AuditRepository } from "./repository";

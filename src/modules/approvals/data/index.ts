import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoApprovalRepository, getDemoApprovalRepository } from "./demoRepository";
import { SupabaseApprovalRepository, getSupabaseApprovalRepository } from "./supabaseRepository";
import type { ApprovalRepository } from "./repository";

export type ApprovalMode = "supabase" | "demo";

export function getApprovalRepository(): ApprovalRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseApprovalRepository();
  }
  return getDemoApprovalRepository();
}

export function getApprovalMode(): ApprovalMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoApprovalRepository, SupabaseApprovalRepository };
export { getDemoApprovalRepository, resetDemoApprovalRepository } from "./demoRepository";
export { getSupabaseApprovalRepository } from "./supabaseRepository";
export type { ApprovalRepository } from "./repository";

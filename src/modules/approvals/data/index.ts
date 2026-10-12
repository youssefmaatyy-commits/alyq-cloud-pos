import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoApprovalRepository, getDemoApprovalRepository } from "./demoRepository";
import { SupabaseApprovalRepository, getSupabaseApprovalRepository } from "./supabaseRepository";
import type { ApprovalRepository } from "./repository";

export type ApprovalMode = "supabase" | "demo";

export function getApprovalRepository(): ApprovalRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseApprovalRepository();
  }
  return getDemoApprovalRepository();
}

export function getApprovalMode(): ApprovalMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoApprovalRepository, SupabaseApprovalRepository };
export { getDemoApprovalRepository, resetDemoApprovalRepository } from "./demoRepository";
export { getSupabaseApprovalRepository } from "./supabaseRepository";
export type { ApprovalRepository } from "./repository";

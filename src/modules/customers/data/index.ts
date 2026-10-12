import { getRepositoryMode } from "@/lib/supabase/client";
import { DemoCustomerRepository, getDemoCustomerRepository } from "./demoRepository";
import { SupabaseCustomerRepository, getSupabaseCustomerRepository } from "./supabaseRepository";
import type { CustomerRepository } from "./repository";

export type CustomerMode = "supabase" | "demo";

export function getCustomerRepository(): CustomerRepository {
  if (getRepositoryMode() === "supabase") {
    return getSupabaseCustomerRepository();
  }
  return getDemoCustomerRepository();
}

export function getCustomerMode(): CustomerMode {
  return getRepositoryMode() === "supabase" ? "supabase" : "demo";
}

export { DemoCustomerRepository, SupabaseCustomerRepository };
export type { CustomerRepository } from "./repository";

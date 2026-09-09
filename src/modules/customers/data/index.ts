import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { DemoCustomerRepository, getDemoCustomerRepository } from "./demoRepository";
import { SupabaseCustomerRepository, getSupabaseCustomerRepository } from "./supabaseRepository";
import type { CustomerRepository } from "./repository";

export type CustomerMode = "supabase" | "demo";

export function getCustomerRepository(): CustomerRepository {
  if (isSupabaseConfigured && getSupabaseClient()) {
    return getSupabaseCustomerRepository();
  }
  return getDemoCustomerRepository();
}

export function getCustomerMode(): CustomerMode {
  return isSupabaseConfigured && getSupabaseClient() ? "supabase" : "demo";
}

export { DemoCustomerRepository, SupabaseCustomerRepository };
export type { CustomerRepository } from "./repository";

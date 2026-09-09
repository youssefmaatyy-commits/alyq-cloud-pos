import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { Customer, CustomerPatch, NewCustomer } from "../types";
import type { CustomerRepository } from "./repository";

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SupabaseCustomerRepository implements CustomerRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async listCustomers(): Promise<Customer[]> {
    try {
      const { data, error } = await this.require()
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw toAppError(error);
      return ((data as CustomerRow[]) ?? []).map(mapCustomer);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async getCustomer(id: string): Promise<Customer> {
    try {
      const { data, error } = await this.require()
        .from("customers")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw toAppError(error);
      return mapCustomer(data as CustomerRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async createCustomer(input: NewCustomer): Promise<Customer> {
    try {
      const { data, error } = await this.require()
        .from("customers")
        .insert({
          name: input.name.trim(),
          phone: input.phone.trim(),
          address: input.address?.trim() || null,
          notes: input.notes?.trim() || null,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new AppError("VALIDATION", "Phone number already exists", "phone", "23505");
        }
        throw toAppError(error);
      }
      return mapCustomer(data as CustomerRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async updateCustomer(id: string, patch: CustomerPatch): Promise<Customer> {
    try {
      const payload: Record<string, unknown> = {};
      if (patch.name !== undefined) payload.name = patch.name.trim();
      if (patch.phone !== undefined) payload.phone = patch.phone.trim();
      if (patch.address !== undefined) payload.address = patch.address?.trim() || null;
      if (patch.notes !== undefined) payload.notes = patch.notes?.trim() || null;
      payload.updated_at = new Date().toISOString();

      const { data, error } = await this.require()
        .from("customers")
        .update(payload)
        .eq("id", id)
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new AppError("VALIDATION", "Phone number already exists", "phone", "23505");
        }
        throw toAppError(error);
      }
      return mapCustomer(data as CustomerRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async deleteCustomer(id: string): Promise<void> {
    try {
      const { error } = await this.require().from("customers").delete().eq("id", id);
      if (error) throw toAppError(error);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseCustomerRepository | null = null;
export function getSupabaseCustomerRepository(): SupabaseCustomerRepository {
  if (!singleton) singleton = new SupabaseCustomerRepository();
  return singleton;
}

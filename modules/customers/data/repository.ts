import type { Customer, CustomerPatch, NewCustomer } from "../types";
import { AppError } from "@/modules/products/data/repository";

export interface CustomerRepository {
  readonly kind: "supabase" | "demo";

  listCustomers(): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer>;
  createCustomer(input: NewCustomer): Promise<Customer>;
  updateCustomer(id: string, patch: CustomerPatch): Promise<Customer>;
  deleteCustomer(id: string): Promise<void>;
}

export { AppError };

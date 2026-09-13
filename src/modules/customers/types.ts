/**
 * Customers module — domain types (Phase 7).
 */

export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type NewCustomer = Omit<Customer, "id" | "created_at" | "updated_at">;
export type CustomerPatch = Partial<NewCustomer>;

export interface CustomerFiltersValue {
  search: string;
}

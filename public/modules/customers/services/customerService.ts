import { getCustomerRepository } from "../data";
import { AppError } from "@/modules/products/data/repository";
import type { Customer, CustomerFiltersValue, NewCustomer } from "../types";
import { validateCustomerDraft, type CustomerFormValues } from "../validation";
import { normalizeText } from "@/modules/products/services/productQuery";

export async function loadCustomers(): Promise<Customer[]> {
  return getCustomerRepository().listCustomers();
}

export async function saveCustomer(
  values: CustomerFormValues,
  existingCustomers: Customer[] = [],
  currentId?: string,
): Promise<{ customer: Customer; isNew: boolean }> {
  const { errors, data } = validateCustomerDraft(values, existingCustomers, currentId);
  if (!data) {
    const firstField = Object.keys(errors)[0] as keyof CustomerFormValues;
    const err = new AppError("VALIDATION", `Invalid customer draft (${firstField})`, firstField);
    Object.assign(err, { fieldErrors: errors });
    throw err;
  }

  const repo = getCustomerRepository();
  if (currentId) {
    const customer = await repo.updateCustomer(currentId, data);
    return { customer, isNew: false };
  }

  const customer = await repo.createCustomer(data as NewCustomer);
  return { customer, isNew: true };
}

export async function deleteCustomer(id: string): Promise<void> {
  return getCustomerRepository().deleteCustomer(id);
}

export function queryCustomers(customers: Customer[], filters: CustomerFiltersValue): Customer[] {
  const needle = normalizeText(filters.search);
  const terms = needle ? needle.split(" ") : [];

  return customers.filter((customer) => {
    if (terms.length > 0) {
      const haystack = normalizeText(`${customer.name} ${customer.phone} ${customer.address ?? ""}`);
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}

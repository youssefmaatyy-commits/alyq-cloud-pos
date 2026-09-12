/**
 * Customer service — the book, gated like every other module.
 *
 * Before Phase 17 nothing here checked anything: any signed-in seat could read
 * every customer's phone number and address, and could delete a record along
 * with the purchase history it anchored. The three acts now carry the three
 * capabilities that name them, asserted here rather than only in the components,
 * so hiding a button and refusing the write are the same decision made twice —
 * and in live mode a third time, by the RLS policies migration 0028 puts on the
 * `customers` table, which read `public.can()`.
 *
 * `add_customer` and `edit_customer` are separate on purpose: the till adds a
 * customer mid-sale, which is an ordinary act for a cashier, while correcting a
 * record somebody else created is a different judgement. A role may hold one
 * without the other.
 */
import { getCustomerRepository } from "../data";
import { assertCapability } from "@/lib/permissions/enforce";
import { AppError } from "@/modules/products/data/repository";
import type { Customer, CustomerFiltersValue, NewCustomer } from "../types";
import { validateCustomerDraft, type CustomerFormValues } from "../validation";
import { normalizeText } from "@/modules/products/services/productQuery";

export async function loadCustomers(): Promise<Customer[]> {
  assertCapability("view_customers");
  return getCustomerRepository().listCustomers();
}

export async function saveCustomer(
  values: CustomerFormValues,
  existingCustomers: Customer[] = [],
  currentId?: string,
): Promise<{ customer: Customer; isNew: boolean }> {
  assertCapability(currentId ? "edit_customer" : "add_customer");

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

/**
 * Deleting a customer erases their purchase history's anchor, so this is an
 * oversight act: admin and manager hold it, the till and the stock room do not.
 */
export async function deleteCustomer(id: string): Promise<void> {
  assertCapability("delete_customer");
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

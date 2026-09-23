import type { Customer } from "../types";

/**
 * Search a customer book the way the till does: name or phone, either one,
 * case-insensitive, so typing "0501" or "ahmed" both land. Pure — the picker
 * in the register and any future screen (or test) share the same rule.
 */
export function filterCustomers(
  customers: Customer[],
  query: string,
  limit?: number,
): Customer[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? customers.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phone.toLowerCase().replace(/\s/g, "").includes(q.replace(/\s/g, "")),
      )
    : customers;
  return typeof limit === "number" ? matches.slice(0, limit) : matches;
}

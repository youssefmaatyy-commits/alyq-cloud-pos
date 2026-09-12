/**
 * Querying the user list — filtering, sorting and the counts the header shows.
 *
 * Pure functions over an array the provider already loaded, so the table stays
 * responsive without a round trip per keystroke, and so the behaviour can be
 * asserted in the logic suite. The pattern is the one the other modules use
 * (`queryExpenses`, `queryProducts`): the repository decides *what exists*, this
 * decides *what is on screen*.
 */
import { normalizeText } from "@/modules/products/services/productQuery";
import type { ManagedUser, UserFiltersValue, UserSortValue } from "../types";

export function queryUsers(users: ManagedUser[], filters: UserFiltersValue): ManagedUser[] {
  const terms = normalizeText(filters.search).split(" ").filter(Boolean);

  return users.filter((user) => {
    if (filters.role !== "all" && user.role !== filters.role) return false;
    if (filters.status === "active" && !user.active) return false;
    if (filters.status === "inactive" && user.active) return false;
    if (filters.custom_role_id !== "all") {
      // `none` is a real filter value in the UI ("no custom role"), so it is
      // matched here rather than treated as an unknown id.
      if (filters.custom_role_id === "none") {
        if (user.custom_role_id) return false;
      } else if (user.custom_role_id !== filters.custom_role_id) {
        return false;
      }
    }
    if (terms.length === 0) return true;
    const haystack = normalizeText(
      `${user.name} ${user.username} ${user.email ?? ""} ${user.phone ?? ""} ${user.role} ${user.custom_role_name ?? ""}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
}

export function sortUsers(users: ManagedUser[], sort: UserSortValue): ManagedUser[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  const value = (user: ManagedUser): string | number => {
    switch (sort.key) {
      case "username":
        return user.username.toLowerCase();
      case "role":
        return user.role;
      case "created_at":
        // Missing timestamps sort last in both directions: a directory seeded
        // before the column existed must not jump above real sign-ups.
        return user.created_at ? Date.parse(user.created_at) : Number.POSITIVE_INFINITY;
      case "last_login_at":
        return user.last_login_at ? Date.parse(user.last_login_at) : Number.POSITIVE_INFINITY;
      case "active":
        // Active first, so the people who can actually sign in lead the list.
        return user.active ? 0 : 1;
      default:
        return user.name.toLowerCase();
    }
  };

  return [...users].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === right) return a.name.localeCompare(b.name) * factor;
    return (left < right ? -1 : 1) * factor;
  });
}

export interface UserSummary {
  total: number;
  active: number;
  inactive: number;
  withCustomRole: number;
  byRole: Record<string, number>;
  neverSignedIn: number;
}

export function summarizeUsers(users: ManagedUser[]): UserSummary {
  const byRole: Record<string, number> = {};
  let active = 0;
  let withCustomRole = 0;
  let neverSignedIn = 0;

  for (const user of users) {
    if (user.active) active += 1;
    if (user.custom_role_id) withCustomRole += 1;
    if (!user.last_login_at) neverSignedIn += 1;
    const role = user.role || "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }

  return {
    total: users.length,
    active,
    inactive: users.length - active,
    withCustomRole,
    byRole,
    neverSignedIn,
  };
}

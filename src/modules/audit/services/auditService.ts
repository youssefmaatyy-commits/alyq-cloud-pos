import { getAuditRepository } from "../data";
import type {
  AuditAction,
  AuditFiltersValue,
  AuditLogEntry,
  NewAuditLogEntry,
} from "../types";
import { normalizeText } from "@/modules/products/services/productQuery";
import { getCurrentUser } from "@/modules/inventory/permissions";

/**
 * Append one audit entry.
 *
 * Auditing must never break the operation it describes: failures are logged
 * and swallowed so a missing audit table can never block closing a shift.
 */
export async function recordAudit(
  input: Omit<NewAuditLogEntry, "user_id" | "user_name"> & {
    user_id?: string;
    user_name?: string;
  },
): Promise<AuditLogEntry | null> {
  try {
    const user = getCurrentUser();
    return await getAuditRepository().append({
      ...input,
      user_id: input.user_id ?? user.id,
      user_name: input.user_name ?? user.name,
    });
  } catch (err) {
    console.error("[audit] failed to record entry", {
      action: input.action,
      entity_id: input.entity_id,
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

export async function loadAuditLog(): Promise<AuditLogEntry[]> {
  return getAuditRepository().listEntries();
}

export function queryAuditLog(
  entries: AuditLogEntry[],
  filters: AuditFiltersValue,
): AuditLogEntry[] {
  const terms = normalizeText(filters.search).split(" ").filter(Boolean);

  return entries.filter((entry) => {
    if (filters.action !== "all" && entry.action !== filters.action) return false;
    if (terms.length === 0) return true;
    const haystack = normalizeText(
      `${entry.entity_label} ${entry.action} ${entry.user_name} ${Object.values(entry.details ?? {}).join(" ")}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
}

/** Human label for an action key, resolved through the dictionary. */
export function auditActionLabelKey(action: AuditAction): string {
  return `audit.action.${action}`;
}

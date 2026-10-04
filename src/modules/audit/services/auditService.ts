import { assertSensitiveAction } from "@/lib/permissions/actions";
import { getAuditRepository } from "../data";
import type {
  AuditAction,
  AuditFiltersValue,
  AuditLogEntry,
  NewAuditLogEntry,
} from "../types";
import { withinDateRange } from "@/lib/export";
import { canAct } from "@/lib/permissions/enforce";
import { sensitiveAction } from "@/lib/permissions/actions";
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

/** Reading the trail needs `view_audit_log` — oversight roles only. */
export function assertCanViewAudit(): void {
  assertSensitiveAction("audit.view");
}

/**
 * Exporting it needs `export_data` on top of being able to read it: an extract
 * leaves the building, and the trail is append-only precisely because it is
 * evidence.
 */
export function assertCanExportAudit(): void {
  // Both, deliberately: `export_data` alone would let a till operator pull the
  // trail they are not allowed to read on screen.
  assertSensitiveAction("audit.view");
  assertSensitiveAction("audit.export");
}

/**
 * The same question as a boolean, for the export button that should not render
 * for somebody who may read the trail but not take it out.
 *
 * Both capabilities, exactly as `assertCanExportAudit` requires them.
 */
export function mayExportAudit(): boolean {
  return (
    canAct(sensitiveAction("audit.view").capability) &&
    canAct(sensitiveAction("audit.export").capability)
  );
}

/** The distinct people in the trail, for the "who" filter. Id + display name. */
export function auditActors(entries: readonly AuditLogEntry[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (entry.user_id && !seen.has(entry.user_id)) seen.set(entry.user_id, entry.user_name);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadAuditLog(): Promise<AuditLogEntry[]> {
  assertCanViewAudit();
  return getAuditRepository().listEntries();
}

export function queryAuditLog(
  entries: AuditLogEntry[],
  filters: AuditFiltersValue,
): AuditLogEntry[] {
  const terms = normalizeText(filters.search).split(" ").filter(Boolean);

  return entries.filter((entry) => {
    if (filters.action !== "all" && entry.action !== filters.action) return false;
    if (filters.entity !== "all" && entry.entity !== filters.entity) return false;
    if (filters.user !== "all" && entry.user_id !== filters.user) return false;
    if (filters.approver !== "all" && entry.approver_id !== filters.approver) return false;
    if (filters.branch !== "all" && entry.branch_id !== filters.branch) return false;
    if (filters.module !== "all" && entry.module !== filters.module) return false;
    if (!withinDateRange(entry.created_at, filters.from || null, filters.to || null)) return false;
    if (terms.length === 0) return true;
    const haystack = normalizeText(
      `${entry.entity_label} ${entry.entity_id} ${entry.action} ${entry.user_name} ${entry.approver_name ?? ""} ${entry.module ?? ""} ${entry.correlation_id ?? ""} ${entry.reason ?? ""} ${JSON.stringify(entry.details ?? {})}`,
    );
    return terms.every((term) => haystack.includes(term));
  });
}

/** Human label for an action key, resolved through the dictionary. */
export function auditActionLabelKey(action: AuditAction): string {
  return `audit.action.${action}`;
}

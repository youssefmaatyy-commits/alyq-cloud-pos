import type { AuditLogEntry, NewAuditLogEntry } from "../types";

/**
 * Persistence contract for the audit log. Append-only by design: there is no
 * update or delete operation.
 */
export interface AuditRepository {
  readonly kind: "supabase" | "demo";
  listEntries(): Promise<AuditLogEntry[]>;
  append(input: NewAuditLogEntry): Promise<AuditLogEntry>;
}

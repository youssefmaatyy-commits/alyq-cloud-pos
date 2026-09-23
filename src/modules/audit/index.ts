/**
 * Audit log module (Phase 8) public surface.
 * Append-only trail for shift + expense operations.
 */
export { AuditLogPage } from "./pages/AuditLogPage";
export { RequireAuditAccess } from "./components/RequireAuditAccess";
export {
  recordAudit,
  loadAuditLog,
  queryAuditLog,
  auditActionLabelKey,
} from "./services/auditService";
export { AUDIT_ACTIONS, AUDIT_ENTITIES, EMPTY_AUDIT_FILTERS } from "./types";
export type {
  AuditAction,
  AuditEntity,
  AuditFiltersValue,
  AuditLogEntry,
  NewAuditLogEntry,
} from "./types";
export { getAuditRepository, getAuditMode } from "./data";
export { DemoAuditRepository, SupabaseAuditRepository } from "./data";
export type { AuditRepository } from "./data/repository";

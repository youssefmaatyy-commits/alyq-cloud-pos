/**
 * The backup module's public surface.
 *
 * One door, so a screen never reaches past it into a repository or a schema
 * helper: the service is the layer that checks the capability and writes the
 * audit entry, and everything else here is a type or a pure function a test can
 * call without a session.
 */
export { BackupPage } from "./pages/BackupPage";
export { RestoreDialog } from "./components/RestoreDialog";
export type { RestoreTarget } from "./components/RestoreDialog";
export { HealthPanel } from "./components/HealthPanel";

export * as backupService from "./services/backupService";
export { RESTORE_CONFIRMATION } from "./services/backupService";
export { exportEmergencyWorkbook, assertCanRunEmergencyExport } from "./services/emergencyExport";
export type { EmergencyExportInput, EmergencyExportOutcome } from "./services/emergencyExport";

export {
  DEMO_RESTORE_EXCLUDED,
  DEMO_STORES,
  EXCLUDED_STORES,
  LIVE_RESTORE_EXCLUDED,
  LIVE_RESTORE_TABLES,
  LIVE_TABLES,
  LIVE_TABLES_DELETE_ORDER,
  backupFileName,
  buildDocument,
  describeDocument,
  parseBackupDocument,
  requiredKeys,
  serializeDocument,
  validateBackupDocument,
} from "./schema";

export {
  PERIOD_MS,
  backupStatus,
  formatBytes,
  isDue,
  nextDueAt,
  normalizeSettings,
  pruneCandidates,
} from "./services/schedule";

export {
  examinedCounts,
  healthModelFromDocument,
  runHealthChecks,
} from "./services/health";

export {
  getBackupMode,
  getBackupRepository,
  resetBackupRepositories,
} from "./data";
export type { BackupRepository } from "./data/repository";

export { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, DEFAULT_BACKUP_SETTINGS } from "./types";
export type {
  BackupDocument,
  BackupFrequency,
  BackupKind,
  BackupManifest,
  BackupMode,
  BackupPayload,
  BackupSettings,
  BackupStatus,
  BackupStatusSummary,
  HealthArea,
  HealthIssue,
  HealthReport,
  HealthSeverity,
  RestoreOutcome,
} from "./types";

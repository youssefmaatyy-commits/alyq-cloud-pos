/**
 * The only write path for cleanup. The page may preview without this.
 * Confirming goes through the capability check, the phrase, and the audit trail.
 */
import { assertCapability } from "@/lib/permissions/enforce";
import { recordAudit } from "@/modules/audit/services/auditService";
import { applyCleanupPlan } from "./cleanup";
import type { CleanupPlan, MediaReference, RegisteredFile } from "../types";

export function assertCanOpenOperations(): void {
  assertCapability("manage_settings", "Operations Center requires system settings access");
}

export function assertCanRunCleanup(): void {
  assertCapability("manage_settings", "Cleanup requires system settings access");
}

export async function commitCleanup(input: {
  files: readonly RegisteredFile[];
  references: readonly MediaReference[];
  plan: CleanupPlan;
  phrase: string;
  mode: "cleanup" | "retention";
  nowIso?: string;
}): Promise<{ files: RegisteredFile[]; deleted: number; skipped: number }> {
  assertCanRunCleanup();
  const result = applyCleanupPlan(input.files, input.references, input.plan, input.phrase, input.mode, input.nowIso);
  await recordAudit({
    action: input.mode === "retention" ? "operations.retention_applied" : "operations.cleanup_executed",
    entity: "system",
    entity_id: "operations",
    entity_label: input.mode,
    details: {
      count: result.deleted.length,
      skipped: result.skipped.length,
      operation: input.mode,
    },
  });
  return { files: result.files, deleted: result.deleted.length, skipped: result.skipped.length };
}

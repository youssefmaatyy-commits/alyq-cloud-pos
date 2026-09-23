/**
 * Cleanup and retention (Phase 56).
 *
 * Preview does not write. Confirm re-checks eligibility. Sales, returns,
 * orders, audit, shifts, and backup snapshots are never targets — backup
 * retention stays inside the backup service, which has no manual delete.
 */
import { findOrphans, isReferenced } from "./mediaAudit";
import {
  CLEANUP_PHRASE,
  DEFAULT_RETENTION_DAYS,
  RETENTION_PHRASE,
  type CleanupItem,
  type CleanupPlan,
  type CleanupRefusal,
  type MediaReference,
  type RegisteredFile,
  type RegisteredFileKind,
} from "../types";

const ELIGIBLE: readonly RegisteredFileKind[] = ["product_image", "variant_image", "website_media", "temporary"];

const PROTECTED = new Set([
  "sale",
  "sale_item",
  "online_order",
  "order_item",
  "return",
  "return_item",
  "audit",
  "shift",
  "customer_history",
  "promotion_snapshot",
  "financial_snapshot",
  "stocktake",
  "stocktake_line",
]);

const PROTECTED_NOTE =
  "Sales, sale items, online orders, returns, audit history, shift closes, financial snapshots, stocktake history, and backup snapshots are not cleanup targets.";

export interface CleanupCandidate {
  id: string;
  path: string;
  bytes: number | null;
  kind: string;
  createdAt: string;
}

export function isEligibleKind(kind: string): kind is RegisteredFileKind {
  return (ELIGIBLE as readonly string[]).includes(kind);
}

export function buildCleanupPlan(
  files: readonly CleanupCandidate[],
  references: readonly MediaReference[],
  selectedIds: readonly string[],
  nowIso: string = new Date().toISOString(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): CleanupPlan {
  const byId = new Map(files.map((file) => [file.id, file]));
  const orphans = new Set(findOrphans(files, references).map((file) => file.id));
  const items: CleanupItem[] = [];
  const refused: CleanupPlan["refused"] = [];

  for (const id of selectedIds) {
    const file = byId.get(id);
    if (!file) {
      refused.push({ id, reason: "unknown" });
      continue;
    }
    const refusal = refusalFor(file, orphans, references, nowIso, retentionDays);
    if (refusal) {
      refused.push({ id, reason: refusal });
      continue;
    }
    items.push({
      id: file.id,
      path: file.path,
      bytes: file.bytes,
      kind: file.kind as RegisteredFileKind,
      reason: file.kind === "temporary" ? "temporary_expired" : "orphan",
    });
  }

  return { items, refused, protectedNote: PROTECTED_NOTE };
}

function refusalFor(
  file: CleanupCandidate,
  orphans: ReadonlySet<string>,
  references: readonly MediaReference[],
  nowIso: string,
  retentionDays: number,
): CleanupRefusal | null {
  if (PROTECTED.has(file.kind)) return "protected";
  if (file.kind === "backup_artifact" || !isEligibleKind(file.kind)) return "not_eligible";
  if (isReferenced(file as RegisteredFile, references)) return "referenced";
  if (!orphans.has(file.id)) return "referenced";
  if (file.kind === "temporary" && !isPastRetention(file.createdAt, nowIso, retentionDays)) return "not_eligible";
  return null;
}

export function isPastRetention(createdAt: string, nowIso: string, days: number): boolean {
  const created = Date.parse(createdAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return false;
  return now - created >= days * 24 * 60 * 60 * 1000;
}

/**
 * Files retention may offer: orphan media, and temporary files past the age.
 * Backup artifacts are listed nowhere — this function cannot see them as eligible.
 */
export function retentionCandidates(
  files: readonly RegisteredFile[],
  references: readonly MediaReference[],
  nowIso: string,
  days: number = DEFAULT_RETENTION_DAYS,
): CleanupItem[] {
  const orphans = findOrphans(files, references);
  const items: CleanupItem[] = [];
  for (const file of orphans) {
    if (file.kind === "backup_artifact" || !isEligibleKind(file.kind)) continue;
    if (file.kind === "temporary" && !isPastRetention(file.createdAt, nowIso, days)) continue;
    items.push({
      id: file.id,
      path: file.path,
      bytes: file.bytes,
      kind: file.kind,
      reason: file.kind === "temporary" ? "temporary_expired" : "orphan",
    });
  }
  return items;
}

export function assertCleanupPhrase(phrase: string, expected: string): void {
  if (phrase.trim() !== expected) {
    throw new Error("CLEANUP_PHRASE_MISMATCH");
  }
}

/**
 * Apply a plan. Re-checks every id. A file that became referenced since the
 * preview is skipped. Returns the registry with only the still-eligible ids removed.
 */
export function applyCleanupPlan(
  files: readonly RegisteredFile[],
  references: readonly MediaReference[],
  plan: CleanupPlan,
  phrase: string,
  mode: "cleanup" | "retention",
  nowIso?: string,
): { files: RegisteredFile[]; deleted: CleanupItem[]; skipped: string[] } {
  assertCleanupPhrase(phrase, mode === "retention" ? RETENTION_PHRASE : CLEANUP_PHRASE);
  const fresh = buildCleanupPlan(files, references, plan.items.map((item) => item.id), nowIso);
  const allowed = new Set(fresh.items.map((item) => item.id));
  const deleted = fresh.items;
  const skipped = plan.items.filter((item) => !allowed.has(item.id)).map((item) => item.id);
  return {
    files: files.filter((file) => !allowed.has(file.id)),
    deleted,
    skipped,
  };
}

export function cancelCleanup<T>(state: T): T {
  return state;
}

/**
 * Operations Center (Phase 56).
 *
 * Facts only. A metric this installation cannot read is `unavailable` or
 * `not_configured` — never a guessed number. Cleanup never names a sales,
 * return, audit, or shift record as a target.
 */

export type HealthState = "ok" | "warning" | "unavailable" | "not_configured";

export interface HealthFact {
  key:
    | "app"
    | "supabase"
    | "database"
    | "storage"
    | "migrations"
    | "backup"
    | "errors";
  state: HealthState;
  /** Short factual detail. Null when there is nothing safe to say. */
  detail: string | null;
}

export type NotificationKind =
  | "low_stock"
  | "out_of_stock"
  | "online_order"
  | "return_pending"
  | "shift_discrepancy"
  | "promotion_expiring"
  | "stocktake_open"
  | "backup_warning"
  | "storage_warning"
  | "system_warning"
  | "approval_request"
  | "sync_conflict";

export interface OperationalNotification {
  /** Stable across renders. Kind + entity, never a timestamp of the render. */
  id: string;
  kind: NotificationKind;
  /** Existing capability. A viewer without it does not receive the row. */
  capability: string;
  at: string;
  href: string;
  entityId: string;
  label: string;
  read: boolean;
}

export type MediaLocation = "product" | "variant" | "website" | "backup";

export interface MediaReference {
  location: MediaLocation;
  ownerId: string;
  url: string;
}

/** A file this app has registered. Not a business record. */
export type RegisteredFileKind = "product_image" | "variant_image" | "website_media" | "temporary" | "backup_artifact";

export interface RegisteredFile {
  id: string;
  path: string;
  bytes: number | null;
  kind: RegisteredFileKind;
  createdAt: string;
}

export type CleanupRefusal = "protected" | "referenced" | "not_eligible" | "unknown";

export interface CleanupItem {
  id: string;
  path: string;
  bytes: number | null;
  kind: RegisteredFileKind;
  reason: "orphan" | "temporary_expired";
}

export interface CleanupRefusalItem {
  id: string;
  reason: CleanupRefusal;
}

export interface CleanupPlan {
  items: CleanupItem[];
  refused: CleanupRefusalItem[];
  /** Files the plan will not touch, named so the preview can say so. */
  protectedNote: string;
}

export const CLEANUP_PHRASE = "DELETE SELECTED FILES";
export const RETENTION_PHRASE = "APPLY RETENTION";

/** Days a temporary registry file must age before retention may offer it. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Shipped with this build. Not a claim about what a remote database has applied. */
export const SHIPPED_MIGRATION_COUNT = 86;
export const SHIPPED_LATEST_MIGRATION = "0086_variant_barcode_autogeneration.sql";

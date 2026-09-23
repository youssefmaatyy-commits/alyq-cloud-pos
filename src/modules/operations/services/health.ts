/**
 * System health (Phase 56). Every line is a fact the caller already has.
 * A missing probe is unavailable, not a green light and not a guessed count.
 */
import { SHIPPED_LATEST_MIGRATION, SHIPPED_MIGRATION_COUNT, type HealthFact } from "../types";

export interface HealthInput {
  supabaseConfigured: boolean;
  supabaseReachable: boolean | null;
  backupStatus: "protected" | "due" | "overdue" | "never" | "disabled" | null;
  backupCount: number | null;
  appliedMigrationCount: number | null;
  recentErrors: readonly { at: string; message: string }[];
  storageListing: "available" | "unavailable";
}

export function buildHealthReport(input: HealthInput): HealthFact[] {
  const supabase = !input.supabaseConfigured
    ? fact("supabase", "not_configured", null)
    : input.supabaseReachable === null
      ? fact("supabase", "unavailable", null)
      : input.supabaseReachable
        ? fact("supabase", "ok", null)
        : fact("supabase", "warning", null);

  const database = input.appliedMigrationCount === null
    ? fact("database", "unavailable", "credentials")
    : fact("database", "ok", String(input.appliedMigrationCount));

  const storage = input.storageListing === "unavailable"
    ? fact("storage", "unavailable", "credentials")
    : fact("storage", "ok", null);

  const migrations = fact(
    "migrations",
    "ok",
    `${SHIPPED_MIGRATION_COUNT} · ${SHIPPED_LATEST_MIGRATION}`,
  );

  const backup = input.backupStatus === null
    ? fact("backup", "unavailable", "Unavailable")
    : fact(
        "backup",
        input.backupStatus === "overdue" || input.backupStatus === "never" ? "warning" : "ok",
        input.backupCount === null ? input.backupStatus : `${input.backupStatus} · ${input.backupCount}`,
      );

  const errors = input.recentErrors.length === 0
    ? fact("errors", "ok", null)
    : fact("errors", "warning", String(input.recentErrors.length));

  return [
    fact("app", "ok", null),
    supabase,
    database,
    storage,
    migrations,
    backup,
    errors,
  ];
}

function fact(key: HealthFact["key"], state: HealthFact["state"], detail: string | null): HealthFact {
  return { key, state, detail };
}

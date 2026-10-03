import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { SHIPPED_LATEST_MIGRATION, SHIPPED_MIGRATION_COUNT } from "@/modules/operations/types";
import { readableErrorMessage } from "@/modules/products/data/repository";

export interface BackendHealthProbe {
  reachable: boolean;
  checkedAt: string;
  latencyMs: number | null;
  authenticated: boolean | null;
  schemaStatus: "compatible" | "mismatch" | "unknown";
  serverMigration: string | null;
  serverMigrationCount: number | null;
  activeBranchId: string | null;
  branchContextValid: boolean | null;
  safeError: string | null;
}

function safeMessage(error: unknown): string {
  return readableErrorMessage(error)
    .replace(/(bearer|token|password|cookie|service[_ -]?role|private[_ -]?key|api[_ -]?key|pin)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 180);
}

/** One explicit/lightweight health request; callers decide when to run it. */
export async function probeSystemBackend(): Promise<BackendHealthProbe> {
  const checkedAt = new Date().toISOString();
  if (!isSupabaseConfigured) {
    return {
      reachable: true,
      checkedAt,
      latencyMs: 0,
      authenticated: true,
      schemaStatus: "compatible",
      serverMigration: SHIPPED_LATEST_MIGRATION,
      serverMigrationCount: SHIPPED_MIGRATION_COUNT,
      activeBranchId: "demo-main",
      branchContextValid: true,
      safeError: null,
    };
  }
  const client = getSupabaseClient();
  if (!client) {
    return {
      reachable: false, checkedAt, latencyMs: null, authenticated: null,
      schemaStatus: "unknown", serverMigration: null, serverMigrationCount: null,
      activeBranchId: null, branchContextValid: null, safeError: "Backend is not configured",
    };
  }
  const started = performance.now();
  try {
    const { data, error } = await client.rpc("system_health_probe");
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    if (error) {
      // A missing health RPC still proves normal requests can reach Supabase;
      // schema compatibility is unknown/mismatched rather than "backend down".
      const message = safeMessage(error);
      const missing = /system_health_probe|does not exist|schema cache/i.test(message);
      if (missing) {
        const fallback = await client.from("categories").select("id").limit(1);
        return {
          reachable: !fallback.error,
          checkedAt,
          latencyMs,
          authenticated: fallback.error ? null : true,
          schemaStatus: "mismatch",
          serverMigration: null,
          serverMigrationCount: null,
          activeBranchId: null,
          branchContextValid: null,
          safeError: "Health contract is older than this application",
        };
      }
      return {
        reachable: true, checkedAt, latencyMs, authenticated: false,
        schemaStatus: "unknown", serverMigration: null, serverMigrationCount: null,
        activeBranchId: null, branchContextValid: null, safeError: message,
      };
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const migration = typeof row.migration === "string" ? row.migration : null;
    const migrationCount = typeof row.migration_count === "number" ? row.migration_count : Number(row.migration_count ?? NaN);
    const validCount = Number.isFinite(migrationCount) ? migrationCount : null;
    return {
      reachable: true,
      checkedAt,
      latencyMs,
      authenticated: row.authenticated === true,
      schemaStatus: migration === SHIPPED_LATEST_MIGRATION && validCount === SHIPPED_MIGRATION_COUNT ? "compatible" : "mismatch",
      serverMigration: migration,
      serverMigrationCount: validCount,
      activeBranchId: typeof row.active_branch_id === "string" ? row.active_branch_id : null,
      branchContextValid: typeof row.branch_context_valid === "boolean" ? row.branch_context_valid : null,
      safeError: null,
    };
  } catch (error) {
    return {
      reachable: false,
      checkedAt,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      authenticated: null,
      schemaStatus: "unknown",
      serverMigration: null,
      serverMigrationCount: null,
      activeBranchId: null,
      branchContextValid: null,
      safeError: safeMessage(error),
    };
  }
}

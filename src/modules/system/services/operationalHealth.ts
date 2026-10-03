import type { BackendHealthProbe } from "./healthService";
import type { OfflineSchemaHealth } from "@/modules/pos/offline/schema";
import type { RealtimeStatus } from "@/lib/supabase/realtime";
import type { ApplicationConnectivityState } from "@/modules/pos/offline/connectivity";
import { SHIPPED_MIGRATION_COUNT } from "@/modules/operations/types";

export type OperationalHealthState = "healthy" | "warning" | "unavailable" | "unknown";
export type OperationalHealthKey = "application" | "backend" | "authentication" | "realtime" | "offline_queue" | "storage" | "migration" | "branch";
export interface OperationalHealthFact { key: OperationalHealthKey; state: OperationalHealthState; detail: string | null }

export interface OperationalHealthInput {
  connectivity: ApplicationConnectivityState;
  backend: BackendHealthProbe | null;
  authenticated: boolean;
  realtime: RealtimeStatus;
  queue: { pending: number; failed: number; deferred: number; conflicts: number; lastSync: string | null };
  storage: OfflineSchemaHealth | null;
  branch: { id: string | null; error: string | null; backendValid: boolean | null };
}

export function buildOperationalHealth(input: OperationalHealthInput): OperationalHealthFact[] {
  const application = input.connectivity === "online"
    ? fact("application", "healthy", "Online")
    : input.connectivity === "offline"
      ? fact("application", "unavailable", "Browser/network is offline")
      : input.connectivity === "syncing"
        ? fact("application", "warning", "Synchronizing durable local operations")
        : fact("application", "warning", input.connectivity === "degraded" ? "Some services are unavailable" : "Queue synchronization needs attention");
  const backend = !input.backend
    ? fact("backend", "unknown", "Not checked")
    : !input.backend.reachable
      ? fact("backend", "unavailable", input.backend.safeError)
      : input.backend.authenticated === false
        ? fact("backend", "warning", "Session was not accepted")
        : fact("backend", "healthy", input.backend.latencyMs === null ? null : `${input.backend.latencyMs} ms`);
  const realtime = input.realtime === "live" || input.realtime === "idle"
    ? fact("realtime", "healthy", input.realtime)
    : input.realtime === "unavailable"
      ? fact("realtime", "unknown", "No realtime channel is available")
      : input.realtime === "error"
        ? fact("realtime", "warning", "Requests may still work; realtime is unavailable")
        : fact("realtime", "warning", input.realtime);
  const queueAttention = input.queue.failed + input.queue.conflicts;
  const queue = queueAttention > 0
    ? fact("offline_queue", "warning", `${queueAttention} need attention`)
    : input.queue.pending + input.queue.deferred > 0
      ? fact("offline_queue", "warning", `${input.queue.pending} pending · ${input.queue.deferred} deferred`)
      : fact("offline_queue", "healthy", input.queue.lastSync ? `Last sync ${input.queue.lastSync}` : "No pending operations");
  const storage = !input.storage
    ? fact("storage", "unknown", "Not checked")
    : !input.storage.compatible
      ? fact("storage", "unavailable", input.storage.detail)
      : input.storage.persistent
        ? fact("storage", "healthy", `Business schema ${input.storage.businessVersion}`)
        : fact("storage", "warning", "Persistent IndexedDB is unavailable");
  const migration = !input.backend
    ? fact("migration", "unknown", "Not checked")
    : input.backend.schemaStatus === "compatible"
      ? fact("migration", "healthy", input.backend.serverMigration)
      : input.backend.schemaStatus === "mismatch"
        ? fact("migration", "warning", input.backend.safeError === "Health contract is older than this application" || (input.backend.serverMigrationCount !== null && input.backend.serverMigrationCount < SHIPPED_MIGRATION_COUNT)
          ? "Application expects a newer backend schema"
          : input.backend.serverMigrationCount !== null && input.backend.serverMigrationCount > SHIPPED_MIGRATION_COUNT
            ? "Backend schema is newer than this application"
            : "Application and backend schema differ")
        : fact("migration", "unknown", "Migration state could not be verified");
  const branch = !input.branch.id
    ? fact("branch", "unavailable", input.branch.error ?? "No active branch")
    : input.branch.backendValid === false
      ? fact("branch", "warning", "Active branch membership requires refresh")
      : input.branch.backendValid === null
        ? fact("branch", "unknown", input.branch.id)
        : fact("branch", "healthy", input.branch.id);
  return [
    application,
    backend,
    fact("authentication", input.authenticated ? "healthy" : "unavailable", input.authenticated ? "Session available" : "No usable session"),
    realtime,
    queue,
    storage,
    migration,
    branch,
  ];
}

function fact(key: OperationalHealthKey, state: OperationalHealthState, detail: string | null): OperationalHealthFact {
  return { key, state, detail };
}

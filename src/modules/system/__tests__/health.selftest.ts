import assert from "node:assert/strict";
import { buildOperationalHealth } from "@/modules/operations/services/health";
import { redactDiagnosticValue, safeDiagnosticsJson } from "../services/diagnostics";
import type { BackendHealthProbe } from "../services/healthService";

const probe: BackendHealthProbe = {
  reachable: true,
  checkedAt: "2026-10-03T10:00:00.000Z",
  latencyMs: 42,
  authenticated: true,
  schemaStatus: "compatible",
  serverMigration: "0081_offline_sync_health.sql",
  serverMigrationCount: 81,
  activeBranchId: "branch-a",
  branchContextValid: true,
  safeError: null,
};

const facts = buildOperationalHealth({
  connectivity: "online",
  backend: probe,
  authenticated: true,
  realtime: "live",
  queue: { pending: 0, failed: 0, deferred: 0, conflicts: 0, lastSync: null },
  storage: { persistent: true, businessVersion: 3, expectedBusinessVersion: 3, catalogVersion: 2, expectedCatalogVersion: 2, compatible: true, migrated: false, detail: "current" },
  branch: { id: "branch-a", error: null, backendValid: true },
});
assert.ok(facts.every((fact) => fact.state === "healthy"), "verified inputs report healthy");

const unhealthy = buildOperationalHealth({
  connectivity: "offline",
  backend: { ...probe, reachable: false, authenticated: null, schemaStatus: "unknown", branchContextValid: null, safeError: "Network request failed" },
  authenticated: false,
  realtime: "error",
  queue: { pending: 1, failed: 1, deferred: 1, conflicts: 1, lastSync: null },
  storage: { persistent: true, businessVersion: 99, expectedBusinessVersion: 3, catalogVersion: 2, expectedCatalogVersion: 2, compatible: false, migrated: false, detail: "newer_than_app" },
  branch: { id: null, error: "No accessible branch", backendValid: false },
});
assert.equal(unhealthy.find((fact) => fact.key === "application")?.state, "unavailable");
assert.equal(unhealthy.find((fact) => fact.key === "backend")?.state, "unavailable");
assert.equal(unhealthy.find((fact) => fact.key === "authentication")?.state, "unavailable");
assert.equal(unhealthy.find((fact) => fact.key === "realtime")?.state, "warning");
assert.equal(unhealthy.find((fact) => fact.key === "offline_queue")?.state, "warning");
assert.equal(unhealthy.find((fact) => fact.key === "storage")?.state, "unavailable");
assert.equal(unhealthy.find((fact) => fact.key === "migration")?.state, "unknown");
assert.equal(unhealthy.find((fact) => fact.key === "branch")?.state, "unavailable");

const uncertain = buildOperationalHealth({
  connectivity: "degraded",
  backend: { ...probe, schemaStatus: "mismatch" },
  authenticated: true,
  realtime: "unavailable",
  queue: { pending: 2, failed: 0, deferred: 1, conflicts: 0, lastSync: null },
  storage: { persistent: false, businessVersion: 3, expectedBusinessVersion: 3, catalogVersion: 2, expectedCatalogVersion: 2, compatible: true, migrated: false, detail: "current" },
  branch: { id: "branch-a", error: null, backendValid: null },
});
assert.equal(uncertain.find((fact) => fact.key === "application")?.state, "warning");
assert.equal(uncertain.find((fact) => fact.key === "realtime")?.state, "unknown");
assert.equal(uncertain.find((fact) => fact.key === "offline_queue")?.state, "warning", "pending/deferred queue is visible");
assert.equal(uncertain.find((fact) => fact.key === "storage")?.state, "warning", "IndexedDB unavailability is not called healthy");
assert.equal(uncertain.find((fact) => fact.key === "migration")?.state, "warning");
assert.equal(uncertain.find((fact) => fact.key === "branch")?.state, "unknown");

const conflictQueue = buildOperationalHealth({
  connectivity: "sync_error", backend: probe, authenticated: true, realtime: "live",
  queue: { pending: 0, failed: 1, deferred: 0, conflicts: 1, lastSync: null },
  storage: { persistent: true, businessVersion: 3, expectedBusinessVersion: 3, catalogVersion: 2, expectedCatalogVersion: 2, compatible: true, migrated: false, detail: "current" },
  branch: { id: "branch-a", error: null, backendValid: true },
});
assert.equal(conflictQueue.find((fact) => fact.key === "offline_queue")?.state, "warning", "failed/conflict queue is visible");

const diagnostic = safeDiagnosticsJson({
  authorization: "Bearer top-secret",
  nested: {
    password: "never-show",
    pin_hash: "abc123",
    safe_error: "token=another-secret request failed",
    branch_id: "branch-a",
    customer_phone: "01000000000",
    customer_email: "private@example.com",
  },
  payment_payload: { card_number: "4111111111111111", tendered: 500 },
  jwt: "eyJaaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
});
assert.ok(!diagnostic.includes("top-secret"));
assert.ok(!diagnostic.includes("never-show"));
assert.ok(!diagnostic.includes("abc123"));
assert.ok(!diagnostic.includes("another-secret"));
assert.ok(!diagnostic.includes("eyJaaaaaaaaaaaa"));
assert.ok(!diagnostic.includes("01000000000"));
assert.ok(!diagnostic.includes("private@example.com"));
assert.ok(!diagnostic.includes("4111111111111111"));
assert.ok(!diagnostic.includes("tendered"));
assert.ok(diagnostic.includes("branch-a"), "operational context is retained");
assert.equal(redactDiagnosticValue("password=oops", "message"), "password=[redacted]");

console.log("27/27 system health and redaction tests passed");

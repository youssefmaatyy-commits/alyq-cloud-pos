/**
 * Release-probe policy self-test.
 *
 * The probe (`scripts/release.probe.mjs`) makes two promises, and both are
 * decided by pure functions in `src/lib/qa/releaseProbe.ts`:
 *
 *   1. a published artifact is self-describing — `release.json` must carry the
 *      version, the commit, the build time and the *right* mode, and a
 *      production deployment built from a dirty worktree is a failure;
 *   2. the probe never mutates anything — its HTTP plan is GET/HEAD only, and a
 *      business key (sale, order, return, customer, shift, stock, audit row)
 *      that appears or changes during a read-only walk is a failure.
 */
import assert from "node:assert/strict";

import {
  BUSINESS_STORAGE_PREFIXES,
  PROBE_MUTABLE_ALLOWLIST,
  PROBE_SAFE_METHODS,
  diffStorage,
  inspectConsoleErrors,
  inspectNetworkCalls,
  inspectReleaseManifest,
  inspectStorageDiff,
  isBusinessKey,
  isCommitSha,
  isMutatingMethod,
  PROBE_EMPTY_CONTAINER_RULES,
  isProbeEmptyContainer,
  isProbeMutableKey,
  remoteProbePlan,
  summarise,
} from "../releaseProbe";
import { RELEASE, releaseLine, releaseManifest } from "../../release";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

const levels = (findings: { level: string; code: string }[], code: string) =>
  findings.filter((finding) => finding.code === code).map((finding) => finding.level);

const GOOD_MANIFEST = {
  version: "6.0.0",
  sha: "c2cca7aa9863b08b5edda50a12f4c5c7a350530c",
  built_at: "2026-10-11T22:00:00.000Z",
  dirty: false,
  mode: "production",
  mode_source: "explicit",
  mode_requested: "production",
  configuration_issues: [],
};

/* ── the manifest ────────────────────────────────────────────────────────── */

check("a well-formed production manifest passes every rule", () => {
  const findings = inspectReleaseManifest(GOOD_MANIFEST, { mode: "production" });
  assert.deepEqual(findings.filter((finding) => finding.level === "fail"), []);
  assert.ok(findings.every((finding) => finding.level === "pass"));
});

check("a missing manifest fails immediately", () => {
  const findings = inspectReleaseManifest(null);
  assert.deepEqual(levels(findings, "release.missing"), ["fail"]);
});

check("a dirty worktree is a release failure, never a warning", () => {
  const findings = inspectReleaseManifest({ ...GOOD_MANIFEST, dirty: true });
  assert.deepEqual(levels(findings, "release.clean"), ["fail"]);
});

check("an unknown commit cannot be traced back, so it fails", () => {
  const findings = inspectReleaseManifest({ ...GOOD_MANIFEST, sha: "unknown" });
  assert.deepEqual(levels(findings, "release.sha"), ["fail"]);
});

check("a missing or unparseable build time fails", () => {
  assert.deepEqual(levels(inspectReleaseManifest({ ...GOOD_MANIFEST, built_at: "" }), "release.built_at"), ["fail"]);
  assert.deepEqual(levels(inspectReleaseManifest({ ...GOOD_MANIFEST, built_at: "yesterday" }), "release.built_at"), ["fail"]);
});

check("a demo bundle published as a release fails the mode rule", () => {
  const findings = inspectReleaseManifest({ ...GOOD_MANIFEST, mode: "demo" }, { mode: "production" });
  assert.deepEqual(levels(findings, "release.mode"), ["fail"]);
});

check("a release whose mode was not declared fails; an explicit one passes", () => {
  const inferred = inspectReleaseManifest({ ...GOOD_MANIFEST, mode_source: "unset", mode_requested: "" });
  assert.deepEqual(levels(inferred, "release.mode_requested"), ["fail"]);
  assert.deepEqual(levels(inferred, "release.mode_source"), ["fail"]);
  const explicit = inspectReleaseManifest(GOOD_MANIFEST);
  assert.deepEqual(levels(explicit, "release.mode_requested"), ["pass"]);
  assert.deepEqual(levels(explicit, "release.mode_source"), ["pass"]);
});

check("a release with no provenance at all is refused on both counts", () => {
  const anonymous = inspectReleaseManifest({ ...GOOD_MANIFEST, mode_source: undefined, mode_requested: undefined });
  assert.deepEqual(levels(anonymous, "release.mode_requested"), ["fail"]);
  assert.deepEqual(levels(anonymous, "release.mode_source"), ["fail"]);
});

check("the evaluation build may still be probed, and only warns", () => {
  const demo = inspectReleaseManifest({ ...GOOD_MANIFEST, mode: "demo", mode_source: "unset", mode_requested: "" }, {
    mode: "demo",
    requireExplicitMode: false,
    requireClean: false,
  });
  assert.deepEqual(levels(demo, "release.mode_requested"), []);
  assert.deepEqual(levels(demo, "release.mode_source"), ["warn"]);
});

check("the expected release SHA is matched exactly or by prefix", () => {
  const full = "c2cca7aa9863b08b5edda50a12f4c5c7a350530c";
  assert.deepEqual(levels(inspectReleaseManifest(GOOD_MANIFEST, { sha: full }), "release.sha"), ["pass"]);
  assert.deepEqual(levels(inspectReleaseManifest(GOOD_MANIFEST, { sha: full.slice(0, 12) }), "release.sha"), ["pass"]);
  assert.deepEqual(
    levels(inspectReleaseManifest(GOOD_MANIFEST, { sha: "0".repeat(40) }), "release.sha"),
    ["fail"],
  );
});

check("a recorded blocking configuration issue fails the manifest", () => {
  const findings = inspectReleaseManifest({ ...GOOD_MANIFEST, configuration_issues: ["SUPABASE_UNCONFIGURED"] });
  assert.deepEqual(levels(findings, "release.configuration"), ["fail"]);
});

check("commit SHAs are recognised with and without the -dirty suffix", () => {
  assert.equal(isCommitSha("c2cca7a"), true);
  assert.equal(isCommitSha("c2cca7aa9863b08b5edda50a12f4c5c7a350530c-dirty"), true);
  assert.equal(isCommitSha("unknown"), false);
  assert.equal(isCommitSha("test-bundle"), false);
});

/* ── the read-only plan ──────────────────────────────────────────────────── */

check("the probe's HTTP vocabulary is GET/HEAD only", () => {
  assert.deepEqual([...PROBE_SAFE_METHODS], ["GET", "HEAD"]);
  assert.equal(isMutatingMethod("GET"), false);
  assert.equal(isMutatingMethod("head"), false);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    assert.equal(isMutatingMethod(method), true, method);
  }
});

check("the remote plan is two GETs: the manifest and the shell", () => {
  const plan = remoteProbePlan("https://pos.example.com/");
  assert.deepEqual(plan.map((request) => request.method), ["GET", "GET"]);
  assert.deepEqual(plan.map((request) => request.url), [
    "https://pos.example.com/release.json",
    "https://pos.example.com/",
  ]);
  assert.ok(plan.every((request) => request.expect.status === 200));
});

/* ── storage: no business writes ─────────────────────────────────────────── */

check("business keys are the facts a read-only probe must never create", () => {
  for (const key of BUSINESS_STORAGE_PREFIXES) assert.equal(isBusinessKey(key), true, key);
  assert.equal(isBusinessKey("alyq.demo.store_customers.v1"), true);
  assert.equal(isBusinessKey("alyq.auth.session.v1"), false);
  assert.equal(isBusinessKey("alyq.demo.catalog.v1"), false, "the catalogue document is not a business fact");
});

check("seeding documents and the probe's own session are allowed to change", () => {
  for (const key of PROBE_MUTABLE_ALLOWLIST) assert.equal(isProbeMutableKey(key), true, key);
  assert.equal(isProbeMutableKey("alyq.demo.sales.v1"), false);
  assert.equal(isBusinessKey("alyq.demo.catalog.v1") && isProbeMutableKey("alyq.demo.catalog.v1"), false);
});

check("the storage diff reports created, changed and removed keys", () => {
  const diff = diffStorage(
    { a: "1", b: "2", gone: "3" },
    { a: "1", b: "changed", fresh: "4" },
  );
  assert.deepEqual(diff, { created: ["fresh"], changed: ["b"], removed: ["gone"] });
});

check("a business write during the walk fails the probe", () => {
  const findings = inspectStorageDiff({ created: ["alyq.demo.sales.v1"], changed: [], removed: [] });
  assert.deepEqual(levels(findings, "probe.no_business_writes"), ["fail"]);
});

check("seeded documents and the probe session do not fail the walk", () => {
  const findings = inspectStorageDiff({
    created: ["alyq.demo.catalog.v1", "alyq.auth.session.v1"],
    changed: ["alyq.demo.website_settings.v1"],
    removed: [],
  });
  assert.deepEqual(levels(findings, "probe.no_business_writes"), ["pass"]);
});

check("an empty basket is the shop's own artefact, a cart line is a sale waiting to happen", () => {
  const emptyCart = JSON.stringify({ lines: [], couponCode: null, deliveryType: "delivery", paymentMethod: "cod" });
  assert.equal(isProbeEmptyContainer("alyq.store.cart.v2", emptyCart), true);
  assert.equal(isProbeEmptyContainer("alyq.store.cart.v2", null), true, "a basket that is not there holds nothing");
  assert.equal(isProbeEmptyContainer("alyq.store.cart.v2", JSON.stringify({ lines: [{ sku: "X", qty: 1 }] })), false);
  assert.equal(isProbeEmptyContainer("alyq.store.cart.v2", "{not json"), false);
  assert.equal(isProbeEmptyContainer("alyq.demo.sales.v1", JSON.stringify({ lines: [] })), false,
    "no other business key gets this treatment");

  const created = { created: ["alyq.store.cart.v2"], changed: [], removed: [] };
  assert.deepEqual(levels(inspectStorageDiff(created, { "alyq.store.cart.v2": emptyCart }), "probe.no_business_writes"), ["pass"]);
  assert.deepEqual(
    levels(inspectStorageDiff(created, { "alyq.store.cart.v2": JSON.stringify({ lines: [{ sku: "X", qty: 1 }] }) }), "probe.no_business_writes"),
    ["fail"],
  );
  assert.deepEqual(levels(inspectStorageDiff(created), "probe.no_business_writes"), ["fail"],
    "without the value the probe stays strict");
});

check("the probe's own sign-in row is not a business fact, any other audit row is", () => {
  const loginRow = JSON.stringify([
    { id: "aud-1", action: "session.login", entity: "session", entity_id: "user-admin" },
  ]);
  const saleRow = JSON.stringify([
    { id: "aud-2", action: "sale.create", entity: "sale", entity_id: "INV-000001" },
  ]);
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", loginRow), true);
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", JSON.stringify([{ action: "session.logout" }])), true);
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", saleRow), false);
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", JSON.stringify([
    { action: "session.login" },
    { action: "sale.create" },
  ])), false, "one real row is enough to fail");
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", null), false, "deleting the trail is never empty");
  assert.equal(isProbeEmptyContainer("alyq.demo.audit_log.v1", "[]"), true, "an untouched empty trail is empty");

  const changed = { created: [], changed: ["alyq.demo.audit_log.v1"], removed: [] };
  assert.deepEqual(levels(inspectStorageDiff(changed, { "alyq.demo.audit_log.v1": loginRow }), "probe.no_business_writes"), ["pass"]);
  assert.deepEqual(levels(inspectStorageDiff(changed, { "alyq.demo.audit_log.v1": saleRow }), "probe.no_business_writes"), ["fail"]);
});

check("every empty-container rule names a key the diff would otherwise fail", () => {
  for (const key of Object.keys(PROBE_EMPTY_CONTAINER_RULES)) {
    assert.equal(isBusinessKey(key), true, `${key} must be business-shaped, or the rule is dead weight`);
  }
});

check("an unknown key outside both sets is reported as a warning", () => {
  const findings = inspectStorageDiff({ created: ["alyq.mystery.v9"], changed: [], removed: [] });
  assert.deepEqual(levels(findings, "probe.unexpected_storage"), ["warn"]);
  assert.deepEqual(levels(findings, "probe.no_business_writes"), ["pass"]);
});

/* ── network, console, summary ───────────────────────────────────────────── */

check("a demo-mode walk may not reach the network", () => {
  assert.deepEqual(levels(inspectNetworkCalls([]), "probe.no_network"), ["pass"]);
  assert.deepEqual(levels(inspectNetworkCalls(["fetch https://x/y"]), "probe.no_network"), ["fail"]);
});

check("the console stays quiet on an empty catalogue", () => {
  assert.deepEqual(levels(inspectConsoleErrors([]), "probe.no_console_errors"), ["pass"]);
  assert.deepEqual(levels(inspectConsoleErrors(["TypeError: boom"]), "probe.no_console_errors"), ["fail"]);
});

check("the summary fails when any finding fails, and only then", () => {
  assert.deepEqual(summarise([{ level: "pass", code: "a", message: "" }]), { failed: 0, warned: 0, passed: 1, ok: true });
  assert.deepEqual(summarise([{ level: "warn", code: "a", message: "" }]).ok, true);
  assert.deepEqual(summarise([{ level: "fail", code: "a", message: "" }]).ok, false);
});

/* ── the artifact's own identity ─────────────────────────────────────────── */

check("the build stamps a release identity the probe can read", () => {
  assert.ok(RELEASE.version.length > 0);
  assert.ok(RELEASE.shortSha.length > 0);
  assert.equal(RELEASE.dirty, false, "the test bundle is not built from a dirty tree marker");
  const line = releaseLine();
  assert.ok(line.includes(RELEASE.version), line);
  assert.ok(line.includes(RELEASE.shortSha), line);
  const manifest = releaseManifest();
  assert.deepEqual(Object.keys(manifest).sort(), ["built_at", "dirty", "mode", "sha", "version"]);
});

console.log(`\n${passed}/${passed} release-probe policy tests passed`);

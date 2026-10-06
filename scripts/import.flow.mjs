/**
 * Master Excel Import Center E2E Flow.
 *
 * Drives the real app bundle in jsdom:
 *   1. Sign in as admin.
 *   2. Navigate to #/products/import (Import Center).
 *   3. Verify header, template download buttons, and domain selector.
 *   4. Verify cashier / unauthorized role permission gating.
 *
 *   node scripts/test.e2e.mjs import
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});

const {
  assert,
  bodyText,
  sleep,
  waitFor,
  navigate,
  signInAs,
  signOut,
} = ux;

console.log("\nMaster Excel Import Center E2E Flow\n");
await sleep(600);

// 1. Sign in as admin
await signInAs("admin");
await waitFor(() => (document.querySelector("aside")?.textContent ?? "").includes("Dashboard"), {
  label: "the admin sidebar",
});
console.log("  ✓ Admin signed in");

// 2. Navigate to Import Center
await navigate("/products/import");
await waitFor(() => bodyText().includes("Import Center") || bodyText().includes("استيراد"), {
  label: "Import Center page",
});
assert.ok(bodyText().includes("Template") || bodyText().includes("قوالب"), "Template download section must be visible");
assert.ok(bodyText().includes("Unified Catalog") || bodyText().includes("Products Only"), "Import domains must be available");
console.log("  ✓ Import Center mounted with templates and configuration options");

// 3. Verify permissions: Viewer (who lacks import_data) is gated
await signOut();
await signInAs("viewer");
await navigate("/products/import");
await sleep(300);
const viewerText = bodyText();
assert.ok(
  viewerText.includes("access") || viewerText.includes("cannot open") || viewerText.includes("صلاحية") || viewerText.includes("You do not have permission"),
  "Viewer must not have access to Import Center",
);
console.log("  ✓ Viewer permission gate verified (access denied)");

console.log("\n✓ Master Excel Import Center E2E flow passed\n");
process.exit(0);

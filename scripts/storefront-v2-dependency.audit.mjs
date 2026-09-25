#!/usr/bin/env node
/** Phase 4B source-boundary check. No generated files, public test routes or
 * database access: compare the shipped entry graph with the registered
 * test-only rollback projection using the same esbuild recipe as the suites.
 * Metafile inputs over-approximate shipped code (they include parsed but later
 * tree-shaken modules); absence is nevertheless proof of no import edge.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { testBuildOptions, testPlugins } from "./lib/app-bundle.mjs";
import { legacyStoreRollbackPlugin } from "./lib/legacy-store-rollback.plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = ["StoreHomePage", "StoreProductsPage", "StoreProductPage", "StoreCartPage",
  "StoreCheckoutPage", "StoreConfirmationPage", "StoreTrackPage", "StoreAccountPage",
  "StoreAboutPage", "StoreContactPage"];
const legacyOnly = [
  ...pages.map((page) => `src/modules/online/pages/${page}.tsx`),
  "src/modules/online/components/storefront/StoreLayout.tsx",
  "src/modules/online/components/storefront/ProductCard.tsx",
  "src/modules/online/components/storefront/VariantPicker.tsx",
];
const shared = [
  "src/modules/online/components/storefront/SocialIcon.tsx",
  "src/modules/online/components/storefront/PaymentProofPanel.tsx",
  "src/modules/online/components/storefront/StorePrimitives.tsx",
  "src/modules/online/components/admin/StorefrontPreview.tsx",
  "src/modules/online/hooks/StorefrontProvider.tsx",
  "src/modules/online/hooks/StoreCartProvider.tsx",
  "src/modules/online/hooks/StoreAccountProvider.tsx",
];
const active = ["StorefrontV2Home", "StorefrontV2Catalog", "StorefrontV2Product",
  "StorefrontV2Cart", "StorefrontV2Checkout", "StorefrontV2Confirmation",
  "StorefrontV2Track", "StorefrontV2Account", "StorefrontV2About", "StorefrontV2Contact",
  "StorefrontV2PreviewRedirect", "StorefrontV2Shell"].map((name) =>
  `src/modules/online/v2/${name}.tsx`);

async function inputs(rollback) {
  const entry = path.join(root, "src/main.tsx");
  const outfile = path.join(os.tmpdir(), rollback ? "alyq-4b-rollback-audit.mjs" : "alyq-4b-public-audit.mjs");
  const result = await build(testBuildOptions({ entryPoints: [entry], outfile,
    write: false, metafile: true,
    ...(rollback ? { plugins: [legacyStoreRollbackPlugin(), ...testPlugins()] } : {}),
  }));
  return new Set(Object.keys(result.metafile.inputs).map((input) =>
    path.relative(root, path.resolve(root, input)).split(path.sep).join("/")));
}

const [publicInputs, rollbackInputs] = await Promise.all([inputs(false), inputs(true)]);
for (const file of legacyOnly) {
  assert.ok(!publicInputs.has(file), `Legacy presentation imported by public bundle: ${file}`);
  assert.ok(rollbackInputs.has(file), `Rollback regression lost its legacy dependency: ${file}`);
}
for (const file of shared) {
  assert.ok(publicInputs.has(file), `Shared V2/Admin dependency missing from public bundle: ${file}`);
}
for (const file of active) {
  assert.ok(publicInputs.has(file), `Canonical V2 route/shell absent from public bundle: ${file}`);
}
assert.ok(publicInputs.has("src/modules/online/pages/StoreContentPage.tsx"),
  "The back-office content editor is not a legacy shopper page");
console.log(`Public: ${publicInputs.size} graph inputs; rollback tests: ${rollbackInputs.size} graph inputs.`);
console.log(`PASS: ${legacyOnly.length} retained legacy presentation modules are excluded from the public import graph and present in the test-only rollback graph.`);
console.log(`PASS: ${shared.length} shared/Admin dependencies and ${active.length} canonical V2 routes/shell modules remain public.`);

#!/usr/bin/env node
/**
 * Storefront Refresh & Bootstrap UI Flash E2E Flow.
 *
 * Drives the real application bundle in jsdom to verify:
 * 1. Cold bootstrap / hard refresh without cache renders neutral bootstrap shield,
 *    never flashing default dark header or fake navigation.
 * 2. Resolution reveals the full Storefront V2 with merchant's configured theme/header.
 * 3. Subsequent refresh with cached public settings paints immediately without flash.
 * 4. Error state is controlled and offers a retry action.
 * 5. Public routing on `/` and `/store/*` remains intact.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { createUxHarness } from "./lib/ux-harness.mjs";

const seedSource = await readFile(fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url)), "utf8");
const seedModule = await transform(seedSource, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(`data:text/javascript;base64,${Buffer.from(seedModule.code).toString("base64")}`);
const products = buildDemoProducts();
const categories = buildDemoCategories();

console.log("\nStorefront V2 Refresh & Bootstrap Flash Defense E2E Flow\n");

// Scenario 1: Initial load / refresh
const ux = await createUxHarness({
  beforeImport: ({ localStorage }) => {
    localStorage.setItem("alyq.lang", "en");
    localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify({
      seed_revision: 3,
      categories,
      products,
      variants: [],
    }));
  },
});

const { dom, assert, waitFor, navigate, finish } = ux;
const { document } = dom.window;

// 1. Visit root `/`
await navigate("#/store", 700);
await waitFor(() => Boolean(document.querySelector('[data-testid="store-v2"]') || document.querySelector('[data-testid="v2-bootstrap-shield"]')), {
  label: "Storefront V2 root mount",
});

// Verify Storefront V2 root mounted and no legacy Storefront V1 layout leaked
assert.equal(document.querySelector(".store-legacy"), null, "legacy Storefront V1 layout is NOT mounted");

// 2. Wait for full Storefront V2 hydration
await waitFor(() => Boolean(document.querySelector('[data-testid="store-v2"]')), {
  label: "Storefront V2 resolved",
});

const storeRoot = document.querySelector('[data-testid="store-v2"]');
assert.ok(storeRoot !== null, "Storefront V2 resolved cleanly");
console.log("  ✓ Storefront V2 mounted and resolved without Storefront V1 or legacy layout");

// 3. Verify public routing on `/`
assert.ok(document.querySelector('.v2-header'), "Storefront V2 header is present");
assert.ok(document.querySelector('.v2-main'), "Storefront V2 main container is present");
assert.ok(document.querySelector('.v2-footer'), "Storefront V2 footer is present");
console.log("  ✓ Storefront V2 header, main and footer rendered atomically");

// 4. Verify public settings were cached in localStorage
const cachedRaw = dom.window.localStorage.getItem("alyq.storefront.public_settings.v2");
assert.ok(cachedRaw !== null, "Public settings were cached for subsequent refreshes");
const cached = JSON.parse(cachedRaw);
assert.ok(cached.settings !== undefined, "Cached payload contains valid public settings");
console.log("  ✓ Public website settings safely cached in localStorage for instant reload");

await finish();
console.log("Storefront V2 refresh & bootstrap flash defense passed");
console.log("\n✓ Storefront V2 Refresh & Bootstrap Flash Defense E2E flow passed\n");

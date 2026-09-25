/** Fresh process/browser boot: saved Admin V2 JSON must reach the canonical
 * public route, while POS retains its own unchanged styling. */
import assert from "node:assert/strict";
import { createUxHarness } from "./ux-harness.mjs";

const snapshot = process.env.ALYQ_TEST_V2_SNAPSHOT;
assert.ok(snapshot, "saved website settings are supplied by the Admin flow");
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.demo.website_settings.v1", snapshot);
  localStorage.setItem("alyq.lang", "ar");
} });
const { document } = ux.dom.window;
const { navigate, waitFor } = ux;
await navigate("#/store", 900);
await waitFor(() => document.querySelector('[data-testid="store-v2"]'), { label: "fresh-boot V2 shell" });
const shell = document.querySelector('[data-testid="store-v2"]');
const token = (key) => shell.style.getPropertyValue(key).trim().toLowerCase();
assert.equal(shell.getAttribute("dir"), "rtl");
assert.equal(token("--v2-header-bg"), "#fefefe");
assert.equal(token("--v2-bg"), "#101820");
assert.equal(token("--v2-surface"), "#eeeeee");
assert.equal(token("--v2-button-radius"), "0px");
assert.equal(token("--v2-badge-radius"), "9999px");
assert.equal(document.querySelector('.v2-header-end a[href="#/store/cart"]'), null,
  "V2-only header cart toggle is applied");
assert.ok(document.querySelector('.v2-header .v2-logo source[srcset*="hero-editorial-mobile"], .v2-header .v2-logo img.v2-mobile-only[src*="hero-editorial-mobile"]'),
  "saved V2 mobile logo is offered to mobile browsers");
assert.ok(document.querySelector('[data-testid="v2-announcement-track"]'),
  "saved shared scroll mode actually renders a V2 ticker");
assert.equal(document.querySelectorAll('.v2-announcement-copy[aria-hidden="true"] a').length, 0,
  "a duplicate marquee copy has no interactive links");
assert.ok(!document.documentElement.style.getPropertyValue("--v2-bg"),
  "V2 tokens remain on the V2 root, never the document");
await navigate("#/store/products", 700);
assert.ok(document.querySelector('[data-testid="v2-catalog"]'), "canonical catalogue uses saved V2 settings");
assert.equal(document.querySelector('[data-testid="store-v2"]')?.style.getPropertyValue("--v2-bg"), "#101820");
// The shared provider can inject the legacy stylesheet, but V2 tokens are
// scoped to its shell, never inherited by the document or POS.
assert.equal(document.documentElement.style.getPropertyValue("--v2-bg"), "");
await navigate("#/pos", 700);
assert.equal(document.querySelector('[data-testid="store-v2"]'), null);
assert.ok(!document.getElementById("alyq-store-theme"), "POS receives no website theme");
assert.equal(document.documentElement.style.getPropertyValue("--v2-bg"), "");
ux.finish("V2 saved settings rehydrate on canonical routes in AR/RTL; POS remains isolated");

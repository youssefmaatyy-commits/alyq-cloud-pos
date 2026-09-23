/** A fresh process = a fresh browser boot, not merely a route change.
 * The parent theme flow provides only the previously saved settings document;
 * the demo repository and storefront provider must rehydrate it themselves.
 */
import assert from "node:assert/strict";
import { createUxHarness } from "./ux-harness.mjs";

const stored = process.env.ALYQ_TEST_THEME_SNAPSHOT;
assert.ok(stored, "the prior admin session provided a saved settings document");
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.demo.website_settings.v1", stored);
} });
const { dom, navigate, waitFor } = ux;
const { document } = dom.window;
const token = (name) => dom.window.getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
await navigate("#/store", 850);
await waitFor(() => document.querySelector("header") && token("--store-primary") === "#0f766e", {
  label: "the newly booted public shop to load saved primary",
});
assert.equal(token("--store-background"), "#f1fbf6");
assert.equal(token("--store-surface"), "#ffffff");
assert.equal(token("--store-secondary"), "#1d3a35");
assert.equal(token("--store-accent"), "#a18857");
assert.equal(token("--store-text-primary"), "#183d31");
assert.ok(document.getElementById("alyq-store-theme"), "the public provider installed the saved theme on a fresh boot");
ux.finish("Fresh boot rehydrates the saved storefront palette");

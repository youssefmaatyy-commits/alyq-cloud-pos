#!/usr/bin/env node
/** An isolated old/forged website-settings row: the Admin rejects new bad
 * accounts, but both public storefronts must still fail closed on old JSON. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUNDLE } from "./app-bundle.mjs";
import { createUxHarness } from "./ux-harness.mjs";

const snapshot = process.env.ALYQ_TEST_UNSAFE_SOCIAL;
assert.ok(snapshot, "a fixture settings document is required");
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  localStorage.setItem("alyq.demo.website_settings.v1", snapshot);
} });
const document = ux.dom.window.document;
const { navigate, waitFor } = ux;
const hrefs = () => [...document.querySelectorAll("a[href]")].map((anchor) =>
  (anchor.getAttribute("href") ?? "").trim().toLowerCase());
const hasUnsafe = () => hrefs().some((href) => /^(?:javascript:|data:|vbscript:|#)$/.test(href));

await navigate("#/store", 850);
await waitFor(() => document.querySelector('[data-testid="product-grid"]'), { label: "fresh legacy shop" });
assert.equal(hasUnsafe(), false, "legacy storefront never renders executable schemes");
for (const platform of ["Facebook", "Instagram", "TikTok"]) {
  assert.equal(Boolean(document.querySelector(`a[aria-label="${platform}"]`)), false,
    `${platform} unsafe old settings render no icon`);
}
assert.equal(hrefs().some((href) => href.includes("maps.google")), false, "unsafe map link is absent");
assert.ok(hrefs().some((href) => href.includes("wa.me/201001234567")), "valid legacy WhatsApp still works");

await navigate("#/store/contact", 650);
await waitFor(() => document.body.textContent.includes("Contact us"), { label: "fresh contact page" });
assert.equal(hasUnsafe(), false, "legacy contact page never renders an executable or dead link");

// The parent store suite uses a test-only legacy rollback bundle. Launch a
// separate fresh boot of the *shipped* canonical app for the V2 half, rather
// than smuggling a legacy/debug route into production.
const publicBoot = spawnSync(process.execPath,
  [fileURLToPath(new URL("./unsafe-social-public-reload.mjs", import.meta.url))], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, ALYQ_TEST_BUNDLE: DEFAULT_BUNDLE, ALYQ_TEST_UNSAFE_SOCIAL: snapshot },
  });
assert.equal(publicBoot.status, 0,
  `canonical forged-row check failed: ${publicBoot.error ?? ""}\n${publicBoot.stdout}\n${publicBoot.stderr}`);
ux.finish("Fresh forged social settings fail closed in rollback legacy, contact and canonical V2");

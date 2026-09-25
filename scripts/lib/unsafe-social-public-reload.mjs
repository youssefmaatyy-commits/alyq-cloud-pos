/** Reboot the shipped (canonical V2) app with the same forged settings used by
 * the legacy rollback suite. No preview/debug route is required or exposed. */
import assert from "node:assert/strict";
import { createUxHarness } from "./ux-harness.mjs";

const snapshot = process.env.ALYQ_TEST_UNSAFE_SOCIAL;
assert.ok(snapshot, "a forged settings document is required");
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  localStorage.setItem("alyq.demo.website_settings.v1", snapshot);
} });
const { document } = ux.dom.window;
const { navigate, waitFor } = ux;
await navigate("#/store", 850);
await waitFor(() => document.querySelector('[data-testid="v2-home"]'), { label: "canonical V2 shop" });
const hrefs = [...document.querySelectorAll("a[href]")].map((anchor) =>
  (anchor.getAttribute("href") ?? "").trim().toLowerCase());
assert.equal(hrefs.some((href) => /^(?:javascript:|data:|vbscript:|#)$/.test(href)), false,
  "canonical shop never renders executable schemes");
assert.equal(document.querySelectorAll('.v2-footer-social a').length, 1,
  "canonical V2 rejects the three forged profile destinations");
assert.equal(document.querySelector('.v2-footer-social a')?.getAttribute("data-platform"), "whatsapp");
ux.finish("Forged social settings fail closed on the shipped canonical V2 shop");

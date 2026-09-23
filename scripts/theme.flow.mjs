/** Theme-settings acceptance through the real admin form and public routes.
 * jsdom checks saved values and token propagation, NOT visual layout. The
 * Chromium-only rendered suite covers actual desktop/mobile geometry when the
 * browser binary is available.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) localStorage.removeItem(key);
  }
} });
const { assert, dom, bodyText, waitFor, navigate, clickEl, setReactValue, testid, readJson, signInAs } = ux;
const { document } = dom.window;
const settings = () => readJson("alyq.demo.website_settings.v1")?.settings ?? null;
const token = (name) => dom.window.getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
const preview = () => [...document.querySelectorAll("[style]")].find((element) =>
  element.style.getPropertyValue("--store-primary"));
function setColor(field, color) {
  const input = [...document.querySelectorAll("input")].find((node) =>
    node.type === "text" && node.getAttribute("aria-label") === field);
  assert.ok(input, `${field} hex entry is present`);
  setReactValue(input, color);
}
function saveButton() {
  return [...document.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === "Save");
}
const save = () => { assert.ok(saveButton() && !saveButton().disabled, "draft can be saved"); clickEl(saveButton()); };

await signInAs("admin");
await navigate("#/online/website?tab=theme", 850);
await waitFor(() => testid("theme-presets"), { label: "website theme settings" });
assert.equal([...document.querySelectorAll('input[aria-label="Primary"]')].find((node) => node.type === "text")?.value.toLowerCase(),
  "#202427", "the admin sees the effective ivory/charcoal default, not an old persisted brown");
console.log("  ✓ the builder opens on the resolved premium palette");

setColor("Primary", "#0f766e");
setColor("Secondary", "#1d3a35");
setColor("Accent", "#a18857");
setColor("Background", "#f1fbf6");
setColor("Card surface", "#ffffff");
setColor("Text", "#183d31");
setColor("Muted text", "#3f6456");
await waitFor(() => preview()?.style.getPropertyValue("--store-primary").trim() === "#0f766e", {
  label: "live draft preview to reflect custom primary",
});
assert.equal(preview().style.getPropertyValue("--store-background").trim(), "#f1fbf6");
assert.ok(preview().querySelector('[style*="var(--store-primary)"]'), "preview buttons consume the same primary token as the shop");
assert.ok(!settings() || settings().theme.primary_color !== "#0f766e", "the unsaved draft has not leaked to the public document");
save();
await waitFor(() => settings()?.theme.primary_color === "#0f766e", { label: "custom theme to persist" });
assert.equal(settings().theme.background_color, "#f1fbf6");
await waitFor(() => saveButton() && !saveButton().querySelector(".animate-spin"), { label: "save to finish before editing again" });
console.log("  ✓ saving the builder persists the custom palette; its preview reads the same tokens");

// An invalid colour is a FORM ERROR, not a request to reset to factory brown
// or to silently save unrelated fields. The previously saved document stays.
const lastSaved = JSON.stringify(settings());
setColor("Primary", "not-a-hex-color");
await waitFor(() => testid("settings-invalid-color") && bodyText().includes("last saved settings are unchanged"), {
  label: "friendly inline invalid-colour warning",
});
await waitFor(() => saveButton() && !saveButton().disabled, { label: "invalid draft save action to unlock" });
save();
assert.equal(JSON.stringify(settings()), lastSaved, "invalid hex rejected the entire write");
setColor("Primary", "#0f766e");
await waitFor(() => !testid("settings-invalid-color"), { label: "corrected hex clears the error" });
console.log("  ✓ invalid hex explains the error and preserves the last saved palette");

for (const route of ["#/store", "#/store/products", "#/store/about", "#/store/contact", "#/store/cart"]) {
  await navigate(route, 650);
  await waitFor(() => token("--store-primary") === "#0f766e" && document.querySelector("header"), {
    label: `saved theme on ${route}`,
  });
  assert.equal(token("--store-background"), "#f1fbf6", `${route} takes saved ivory background`);
  assert.equal(token("--store-surface"), "#ffffff", `${route} takes saved white cards`);
  assert.equal(token("--store-secondary"), "#1d3a35", `${route} takes saved secondary`);
  assert.equal(token("--store-accent"), "#a18857", `${route} takes saved muted gold`);
  assert.equal(token("--store-text-primary"), "#183d31", `${route} takes saved text`);
  assert.ok(document.querySelector('[class*="store-primary"], [style*="var(--store-primary)"]'),
    `${route} renders elements consuming the saved brand tokens`);
}
console.log("  ✓ home, listing, about, contact and cart consume the saved palette");

await navigate("#/pos");
await waitFor(() => !document.getElementById("alyq-store-theme"), { label: "store theme removed outside the shop" });
assert.equal(token("--store-primary"), "", "POS cannot inherit public store tokens");

// Prove a reload, not just same-tab navigation: start a clean Node/jsdom
// process with only the saved settings document. The new repository instance
// must read localStorage and the new public provider must install its tokens.
const boot = spawnSync(process.execPath, [fileURLToPath(new URL("./lib/theme-reload.mjs", import.meta.url))], {
  cwd: process.cwd(), encoding: "utf8", timeout: 45_000,
  env: { ...process.env, ALYQ_TEST_THEME_SNAPSHOT: globalThis.localStorage.getItem("alyq.demo.website_settings.v1") ?? "" },
});
assert.equal(boot.status, 0, `fresh-boot storefront check failed: ${boot.error ?? ""}\n${boot.stdout ?? ""}\n${boot.stderr ?? ""}`);
console.log("  ✓ a fresh app boot rehydrates the saved palette (not the preview/default theme)");
ux.finish("Saved theme, invalid-colour guard, fresh boot and store/POS isolation");

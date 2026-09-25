#!/usr/bin/env node
/** Phase 2 end-to-end Admin draft → atomic save → fresh boot → public V2;
 * shared controls, scope/reset, invalid fields and legacy/POS isolation. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUxHarness } from "./lib/ux-harness.mjs";

const key = "alyq.demo.website_settings.v1";
const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  // Old partial settings document: V2 group is absent. The shared announcement
  // is a real configured two-message scroll, and the shared phone grid is one.
  localStorage.setItem(key, JSON.stringify({ settings: {
    product_card: { mobile_columns: 1 }, announcement: { enabled: true, mode: "scroll", interval_ms: 3000,
      messages: [
        { id: "first", enabled: true, text_en: "First collection", text_ar: "التشكيلة الأولى",
          href: "#/store/products", cta_en: "View", cta_ar: "عرض" },
        { id: "second", enabled: true, text_en: "Second collection", text_ar: "التشكيلة الثانية",
          href: "", cta_en: "", cta_ar: "" },
      ] },
  }, meta: null }));
} });
const { assert, dom, navigate, waitFor, clickTestid, clickEl,
  setReactValue, setField, testid, readJson, signInAs, opened } = ux;
const document = dom.window.document;
const settings = () => readJson(key)?.settings;
const saveButton = () => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Save");
const root = () => testid("v2-draft-preview")?.querySelector(".store-v2");
let passed = 0;
function check(label, condition) { assert.ok(condition, label); console.log(`  ✓ ${++passed}. ${label}`); }
function save() { check("draft is ready for a single Save", saveButton() && !saveButton().disabled); clickEl(saveButton()); }

await signInAs("admin");
await navigate("#/online/website?tab=v2", 850);
await waitFor(() => testid("v2-studio") && root(), { label: "V2 studio and draft preview" });
check("a missing V2 group resolves without a migration", Boolean(testid("v2-mobile-columns")));
check("V2-only and Legacy + V2 shared settings have separate labels",
  document.body.textContent.includes("V2 only") && document.body.textContent.includes("Legacy + V2"));
check("existing shared one-column phone grid is inherited in V2 draft",
  testid("v2-mobile-columns").value === "inherit" && root().style.getPropertyValue("--v2-bg"));
const old = JSON.stringify(settings());
setReactValue(testid("v2-hex-header_bg"), "#fefefe");
setReactValue(testid("v2-hex-header_text"), "#fefefe");
setReactValue(testid("v2-hex-page_bg"), "#101820");
setReactValue(testid("v2-hex-surface_bg"), "#eeeeee");
setReactValue(testid("v2-hex-button_bg"), "#efefef");
setReactValue(testid("v2-hex-button_text"), "#efefef");
setField('[data-testid="v2-mobile-columns"]', "2");
setField('[data-testid="v2-button-style"]', "square");
setField('[data-testid="v2-badge-style"]', "pill");
setField('[data-testid="v2-body-font"]', "classic");
setField('[data-testid="v2-display-font"]', "modern");
setField('[data-testid="v2-show_cart"]', "off");
setReactValue(testid("v2-mobile_logo_height"), "54");
const imageInput = testid("v2-studio").querySelector('input[aria-label="Image URL"]');
check("the mobile logo reuses the shared upload/URL component", Boolean(imageInput));
setReactValue(imageInput, "/brand/hero-editorial-mobile.jpg");
clickEl([...testid("v2-studio").querySelectorAll("button")].find((button) => button.textContent.trim() === "Use URL"));
await waitFor(() => root().style.getPropertyValue("--v2-header-bg") === "#fefefe", { label: "live draft V2 preview" });
check("draft adapter updates header and button while legacy settings remain unsaved",
  root().style.getPropertyValue("--v2-bg") === "#101820" && JSON.stringify(settings()) === old);
check("text with insufficient contrast is corrected for the preview",
  root().style.getPropertyValue("--v2-header-text") !== "#fefefe" &&
  root().style.getPropertyValue("--v2-button-text") !== "#efefef");

// Reject the entire draft if even one V2-only hex is mistyped; last saved JSON
// remains untouched, and the editor supplies an inline, field-specific error.
setReactValue(testid("v2-hex-button_text"), "#nothex");
await waitFor(() => testid("v2-invalid-colors") && testid("v2-hex-button_text").getAttribute("aria-invalid") === "true",
  { label: "invalid V2 hex warning" });
save();
check("invalid V2 colour refuses the whole write", JSON.stringify(settings()) === old);
setReactValue(testid("v2-hex-button_text"), "#efefef");
await waitFor(() => !testid("v2-invalid-colors"), { label: "valid V2 hex clears warning" });
save();
await waitFor(() => settings()?.storefront_v2?.header_bg === "#fefefe", { label: "V2 settings persisted" });
await waitFor(() => saveButton()?.disabled && !saveButton()?.querySelector(".animate-spin"), { label: "save completes" });
const persisted = settings();
check("one document saved V2 overrides and retained shared announcement+grid",
  persisted.storefront_v2.mobile_columns === 2 && persisted.storefront_v2.mobile_logo_height === 54 &&
  persisted.storefront_v2.mobile_logo_url === "/brand/hero-editorial-mobile.jpg" &&
  persisted.announcement.mode === "scroll" && persisted.announcement.messages.length === 2 &&
  persisted.product_card.mobile_columns === 1);
check("button/badge font+shape and visibility persist as typed V2 overrides",
  persisted.storefront_v2.button_style === "square" && persisted.storefront_v2.badge_style === "pill" &&
  persisted.storefront_v2.body_font === "classic" && persisted.storefront_v2.display_font === "modern" &&
  persisted.storefront_v2.show_cart === false);
check("legacy theme colours were not changed by V2-only customizations",
  persisted.theme.primary_color === "#202427" && persisted.theme.background_color === "#f8f9f6");

const snap = globalThis.localStorage.getItem(key);
const fresh = spawnSync(process.execPath, [fileURLToPath(new URL("./lib/v2-studio-reload.mjs", import.meta.url))], {
  cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
  env: { ...process.env, ALYQ_TEST_V2_SNAPSHOT: snap },
});
assert.equal(fresh.status, 0, `fresh-boot V2 check failed: ${fresh.error ?? ""}\n${fresh.stdout ?? ""}\n${fresh.stderr ?? ""}`);
console.log("  ✓ fresh boot rehydrates V2 from saved settings and isolates legacy/POS");

await navigate("#/store", 800);
await waitFor(() => testid("v2-announcement-track"), { label: "saved scroll announcement" });
check("scroll mode renders two actual configured messages and an inert clone",
  document.querySelectorAll('.v2-announcement-copy:not([aria-hidden]) .v2-announcement-item').length === 2 &&
  document.querySelectorAll('.v2-announcement-copy[aria-hidden="true"] a').length === 0);
check("the cart remains reachable from the menu even when its header icon is hidden",
  !document.querySelector('.v2-header-end a[href="#/store/cart"]') &&
  [...document.querySelectorAll('.v2-drawer-scroll button')].some((button) => button.textContent.includes("Bag")));
await navigate("#/online/website?tab=v2", 800);
await waitFor(() => testid("v2-studio"), { label: "admin saved draft reloaded" });
check("a saved draft reopens with V2 values and a real V2 preview label",
  testid("v2-hex-header_bg")?.value === "#fefefe" &&
  document.body.textContent.includes("V2 draft appearance preview"));
clickTestid("v2-preview-open-saved");
check("Open saved V2 targets the canonical public route (not the draft)",
  opened.some((entry) => entry.href === "#/store"));
clickTestid("v2-reset-open");
await waitFor(() => testid("v2-reset-confirm"), { label: "V2 reset confirmation" });
clickTestid("v2-reset-confirm");
await waitFor(() => testid("v2-hex-header_bg")?.value === "", { label: "V2 draft reset" });
check("V2-only reset changes the draft but not persisted shared settings",
  testid("v2-hex-header_bg")?.value === "" && settings().announcement.mode === "scroll" &&
  settings().storefront_v2.header_bg === "#fefefe");
save();
await waitFor(() => settings()?.storefront_v2?.header_bg === null, { label: "V2 reset persisted" });
check("saved V2-only reset preserves shared announcement, theme and grid",
  settings().announcement.mode === "scroll" && settings().product_card.mobile_columns === 1 &&
  settings().theme.primary_color === "#202427");
await navigate("#/online/website?tab=theme", 500);
check("shared Appearance tab is labelled and old preview is not mislabelled V2",
  Boolean(testid("shared-setting-scope")) && document.body.textContent.includes("Legacy storefront draft preview (not V2)"));
await ux.signInAs("cashier");
await navigate("#/online/website?tab=v2", 650);
check("cashier lacks permission to enter the V2 editor", !testid("v2-studio"));
console.log(`\n${passed} Phase 2 Admin/Storefront V2 checks passed.`);
ux.finish("Storefront V2 Phase 2 Admin saved/reloaded/reset/shared scope and route isolation");

/**
 * Phase 46 · Branding — ONE shared brand source, everywhere.
 *
 * Proves the required placements and the safety rails:
 *
 *  1. Settings → Branding opens (guarded by manage_website)
 *  2. names + logo (URL path — uploads become data: URLs the sanitizer drops)
 *  3. save persists into the ONE settings document
 *  4. the sidebar re-brands LIVE (no reload) via the shared source
 *  5. the dashboard surface shows the same brand
 *  6. the receipt prints the brand logo while the toggle is on
 *  7. the login screen carries the brand (logo + display name)
 *  8. removing the logos degrades to the shipped ALYQ wordmark everywhere
 *  9. a role without manage_website cannot open Branding
 *
 *   node scripts/test.e2e.mjs branding
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
  dom,
  documentWrites,
  sleep,
  bodyText,
  waitFor,
  navigate,
  clickEl,
  click,
  clickExact,
  testid,
  setField,
  setReactValue,
  setInputValue,
  signInAs,
  signOut,
  dialogs,
  toastText,
} = ux;
const { document } = dom.window;

const buttons = () => [...document.querySelectorAll("button")];
const LOGO_URL = "https://cdn.alyq.example/brand/alyq-logo-gold.png";
const MARK_URL = "https://cdn.alyq.example/brand/alyq-mark-gold.png";
const NAME_EN = "ALYQ Atelier";
const NAME_AR = "الياقوت بوتيك";

const settingsDoc = () => ux.readJson("alyq.demo.website_settings.v1") ?? { settings: null };

/** Fill a SettingsImageField (label-scoped) via the URL path. */
const setLogoUrl = (fieldLabel, url) => {
  const field = [...document.querySelectorAll(".rounded-xl.border")].find((el) =>
    [...el.querySelectorAll("p")].some((p) => p.textContent?.trim() === fieldLabel),
  );
  assert.ok(field, `the ${fieldLabel} field renders`);
  const input = field.querySelector("input[placeholder]");
  assert.ok(input, `the ${fieldLabel} URL input renders`);
  setInputValue(input, url);
  const apply = [...field.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes("Use URL"),
  );
  assert.ok(apply, `the ${fieldLabel} Use URL button renders`);
  clickEl(apply);
};

await signInAs("admin");

// ── 1 · the Branding screen opens ───────────────────────────────────────────
await navigate("#/settings/branding", 900);
await waitFor(() => testid("branding-save"), { label: "the Branding screen" });
await waitFor(() => testid("branding-preview-sidebar"), { label: "the live preview" });
console.log("  ✓ Settings → Branding opens for the admin");

// ── 2 · set the identity ────────────────────────────────────────────────────
setField('[data-testid="branding-name-ar"]', NAME_AR);
setField('[data-testid="branding-name-en"]', NAME_EN);
setLogoUrl("Primary logo", LOGO_URL);
setLogoUrl("Compact mark", MARK_URL);
await sleep(300);
assert.ok(testid("branding-save").disabled === false, "the save enables once dirty");
console.log("  ✓ names + logos set through the guarded URL path");

// ── 3 · save persists into the ONE document ────────────────────────────────
clickEl(testid("branding-save"));
await waitFor(() => toastText().length > 0, { label: "the save toast" });
await sleep(400);
const saved = settingsDoc().settings;
assert.equal(saved?.images?.logo_url, LOGO_URL, "the primary logo landed in website_settings.images");
assert.equal(saved?.brand?.mark_url, MARK_URL, "the mark landed in website_settings.brand");
assert.equal(saved?.brand?.display_name_en, NAME_EN, "the display name landed");
assert.equal(saved?.brand?.display_name_ar, NAME_AR, "the Arabic name landed");
console.log("  ✓ saved into the single website_settings document");

// ── 4 · the sidebar re-brands LIVE ─────────────────────────────────────────
await waitFor(() => testid("shell-brand")?.textContent?.includes(NAME_EN), {
  label: "the sidebar wordmark to swap without a reload",
});
const shellBrandTile = document.querySelector('[data-testid="shell-brand"]')?.closest("div")?.parentElement;
await waitFor(
  () => Boolean(document.querySelector('aside img[src*="cdn.alyq.example"], a[title] img[src*="cdn.alyq.example"]')),
  { label: "the sidebar logo image to appear" },
);
console.log("  ✓ the sidebar re-branded live: new name + logo, no reload");

// ── 5 · the dashboard shows the same brand ─────────────────────────────────
await navigate("#/", 700);
await waitFor(() => testid("dash-kpi-row"), { label: "the dashboard" });
assert.ok(document.body.textContent.includes(NAME_EN), "the dashboard surface carries the display name");
console.log("  ✓ the dashboard shows the same brand source");

// ── 6 · the receipt prints the brand logo while the toggle is on ───────────
await navigate("#/settings/branding", 800);
// ToggleSwitch renders a <button id="branding-receipt-toggle" role="switch">
const receiptToggle = () => document.querySelector('#branding-receipt-toggle');
await waitFor(() => receiptToggle(), { label: "the receipt toggle" });
if (receiptToggle().getAttribute("aria-checked") !== "true") {
  clickEl(receiptToggle());
  await sleep(200);
  clickEl(testid("branding-save"));
  await sleep(600);
}
assert.equal(settingsDoc().settings?.brand?.receipt_logo_enabled, true, "receipt printing is on");

// a sale, then its receipt
await navigate("#/shifts", 700);
await waitFor(() => bodyText().includes("No shift is currently open"), { label: "a closed drawer" });
click("Open shift");
await sleep(400);
const shiftDialog = dialogs().at(-1);
const shiftInputs = [...shiftDialog.querySelectorAll("input")];
setInputValue(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
setInputValue(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
await waitFor(() => /SH-\d{6}/.test(bodyText()), { label: "the shift to open" });

await navigate("#/pos", 700);
const plain = (ux.readJson("alyq.demo.catalog.v1")?.products ?? []).find(
  (p) => p.active && p.stock_tracking_enabled && !p.variants_enabled && p.stock_quantity > 0,
);
assert.ok(plain, "a plain product is sellable");
const searchBox = () => document.querySelector('input[aria-label="Search"]');
await waitFor(() => searchBox(), { label: "the register search" });
setField('input[aria-label="Search"]', plain.name_en.split(" ")[0]);
await sleep(450);
const tile = () => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(plain.name_en));
await waitFor(() => tile() && !tile().disabled, { label: "the plain product tile" });
clickEl(tile());
await sleep(300);
setField('[data-testid="cash-input"]', "500");
await sleep(250);
const completeBtn = buttons().find(
  (b) => (b.textContent ?? "").trim().startsWith("✓") && (b.textContent ?? "").includes("Complete sale"),
);
clickEl(completeBtn);
await waitFor(() => /INV-\d{6}/.test(bodyText()), { label: "the sale to complete" });
const printBtn = buttons().find((b) => (b.textContent ?? "").includes("Print receipt"));
clickEl(printBtn);
await sleep(800);
const receiptHtml = documentWrites.join("\n");
assert.ok(receiptHtml.includes(LOGO_URL), "the receipt HTML embeds the brand logo");
// the receipt's PRINTED NAME stays the receipt.businessName setting (the P45
// combined bilingual) — the brand display name is a screen identity, and the
// two are deliberately one document apart, not a second logo/name split.
assert.ok(receiptHtml.includes("ALYQ"), "the receipt still names the house");
console.log("  ✓ the receipt prints the brand logo (name stays the receipt setting)");

// ── 7 · the login screen carries the brand ─────────────────────────────────
await signOut();
await waitFor(() => testid("login-brand-name"), { label: "the login brand block" });
assert.equal(testid("login-brand-name").textContent?.trim(), NAME_EN, "the login shows the display name");
await waitFor(() => (testid("login-brand-logo")?.getAttribute("src") ?? "").includes("cdn.alyq.example"), {
  label: "the login logo to resolve",
});
console.log("  ✓ the login screen carries the brand (signed OUT)");

// ── 8 · removing the logos degrades to the shipped ALYQ identity ───────────
await signInAs("admin");
await navigate("#/settings/branding", 900);
await waitFor(() => testid("branding-save"), { label: "the Branding screen again" });
const removeButtons = buttons().filter((b) => (b.textContent ?? "").trim() === "Remove");
assert.ok(removeButtons.length >= 2, "both logo fields offer Remove");
clickEl(removeButtons[0]); // primary logo
await sleep(250);
const removeButtons2 = buttons().filter((b) => (b.textContent ?? "").trim() === "Remove");
if (removeButtons2.length > 0) clickEl(removeButtons2[0]); // mark
await sleep(250);
clickEl(testid("branding-save"));
await sleep(700);
const cleared = settingsDoc().settings;
assert.ok(!cleared?.images?.logo_url, "the primary logo is gone from the document");
await waitFor(() => {
  const imgs = [...document.querySelectorAll("img[src]")].filter((img) =>
    (img.getAttribute("src") ?? "").includes("cdn.alyq.example"),
  );
  return imgs.length === 0;
}, { label: "the custom logo to leave every surface" });
assert.ok(testid("shell-brand")?.textContent?.includes(NAME_EN), "the name stays (names are separate from logos)");
assert.ok(testid("branding-preview-sidebar"), "the preview still renders");
console.log("  ✓ removed logos degrade every surface to the shipped ALYQ wordmark");

// ── 9 · a role without manage_website cannot open Branding ─────────────────
await signOut();
await signInAs("cashier");
await navigate("#/settings/branding", 900);
await sleep(700);
assert.ok(!testid("branding-save"), "no Branding screen for a cashier");
assert.ok(!document.body.textContent.includes("Compact mark"), "no branding fields either");
console.log("  ✓ the cashier is refused at /settings/branding (guard, not hiding)");

await navigate("#/");
await sleep(400);
ux.finish("Branding");

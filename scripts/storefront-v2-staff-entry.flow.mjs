#!/usr/bin/env node
/** The hidden staff entrance in the V2 shop's own search, on the real app
 * bundle: the exact word `logpos` reveals one option, the option and Enter both
 * open the real staff login screen, no permanent control exists for shoppers,
 * and product search plus the shopper's own account sign-in are unchanged.
 * Run through: npm run test:e2e staff-entry
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { createUxHarness } from "./lib/ux-harness.mjs";

const source = await readFile(fileURLToPath(new URL("../src/modules/products/data/demoSeed.ts", import.meta.url)), "utf8");
const code = await transform(source, { loader: "ts", format: "esm" });
const { buildDemoProducts, buildDemoCategories } = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString("base64")}`);

const ux = await createUxHarness({ beforeImport: ({ localStorage }) => {
  localStorage.setItem("alyq.lang", "en");
  // `variants` must be present even when empty: the storefront provider reads
  // it alongside the catalogue, and a missing key leaves the shelf empty.
  localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify({
    seed_revision: 3, categories: buildDemoCategories(), products: buildDemoProducts(), variants: [],
  }));
} });
const { dom, assert, waitFor, navigate, clickEl, setField, sleep, finish } = ux;
const { document } = dom.window;
const testid = (name) => document.querySelector(`[data-testid="${name}"]`);
const entry = () => testid("v2-staff-entry");
const entryAction = () => testid("v2-staff-entry-action");
const button = (scope, name) => [...scope.querySelectorAll("button")].find((node) =>
  (node.textContent ?? "").trim().startsWith(name));
let passed = 0;
const check = (label, value) => { assert.ok(value, label); console.log(`  ✓ ${++passed}. ${label}`); };

// The keyword is deliberately not in the UI: this is the one place the suite
// writes it, the way a cashier would type it into the shop's own search field.
const KEYWORD = "logpos";
// The app's own staff sign-in screen: a top-level route, so the shop shell is
// gone when it is on screen. (The shopper account's own form also carries
// autocomplete="username", which is why the hash and the brand mark are
// checked here rather than the field alone.)
const onLoginScreen = () => dom.window.location.hash === "#/login" &&
  Boolean(document.querySelector('[data-testid="login-brand-name"]')) &&
  document.querySelector('[data-testid="store-v2"]') === null;
// Language-agnostic on purpose: the shop is bilingual, so the toggle is found
// by its aria-expanded state rather than by a label that changes with it.
const openHeaderSearch = async () => {
  // The header's first button is the menu drawer (same aria-expanded shape, and
  // its label is translated), so the search toggle is the other one.
  const toggle = [...document.querySelectorAll(".v2-header-start button")]
    .find((node) => node.getAttribute("data-testid") !== "v2-menu-open");
  assert.ok(toggle, "the shop's own search toggle exists");
  clickEl(toggle);
  await waitFor(() => Boolean(document.querySelector(".v2-search-row input")), { label: "the header search field" });
};

await navigate("#/store", 700);
await waitFor(() => Boolean(testid("v2-home")), { label: "the V2 shop" });

// ── nothing is advertised ─────────────────────────────────────────────────
check("no staff entrance exists before the keyword is typed", entry() === null);
check("the shop carries no permanent link to the staff sign-in",
  document.querySelector('a[href="#/login"]') === null &&
  document.querySelector('button[href="#/login"]') === null &&
  !(document.body.textContent ?? "").includes("Enter ALYQ POS"));

await openHeaderSearch();
check("an empty search still reveals nothing", entry() === null);
setField(".v2-search-row input", "Ring");
await sleep(120);
check("an ordinary product query reveals nothing", entry() === null);
setField(".v2-search-row input", "logpos ring");
await sleep(120);
check("a longer query that merely contains the word reveals nothing", entry() === null);
setField(".v2-search-row input", "logpo");
await sleep(120);
check("a near-miss of the word reveals nothing", entry() === null);

// ── the exact word reveals exactly one option ─────────────────────────────
setField(".v2-search-row input", KEYWORD);
await waitFor(() => Boolean(entry()), { label: "the staff entrance" });
check("the exact word reveals one option, labelled for staff", entryAction()?.textContent?.includes("Enter ALYQ POS"));
check("the option is a real button, so it works with a mouse, a finger and a keyboard",
  entryAction()?.tagName === "BUTTON" && entryAction()?.getAttribute("type") === "button");
check("the option is offered once, not duplicated per search surface",
  document.querySelectorAll('[data-testid="v2-staff-entry"]').length === 1);

// ── Enter opens the real staff login ──────────────────────────────────────
const headerForm = document.querySelector(".v2-search-row");
headerForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
await waitFor(onLoginScreen, { label: "the staff login screen" });
check("Enter on the keyword opens the real staff sign-in screen",
  dom.window.location.hash === "#/login" && Boolean(document.querySelector("input[autocomplete='current-password']")));
check("the login screen is the app's own, not a copy invented for the shop",
  (document.body.textContent ?? "").includes("Sign in"));
check("the entrance granted no session: the sign-in is still required",
  !(document.body.textContent ?? "").includes("Signed in as") && Boolean(document.querySelector("input[autocomplete='username']")));

// ── clicking the option does the same thing ───────────────────────────────
await navigate("#/store", 500);
await waitFor(() => Boolean(testid("v2-home")), { label: "back on the shop" });
await openHeaderSearch();
setField(".v2-search-row input", `  ${KEYWORD.toUpperCase()}  `);
await waitFor(() => Boolean(entry()), { label: "the staff entrance, typed with case and stray spaces" });
check("the word is matched trimmed and case-insensitively, as a phone types it",
  entryAction()?.textContent?.includes("Enter ALYQ POS"));
clickEl(entryAction());
await waitFor(onLoginScreen, { label: "the staff login screen from the click" });
check("clicking the option opens the same real staff sign-in screen", dom.window.location.hash === "#/login");

// ── product search is untouched ──────────────────────────────────────────
await navigate("#/store/products", 500);
await waitFor(() => Boolean(document.querySelector('[data-testid="v2-catalog"]')), { label: "the catalogue" });
await waitFor(() => document.querySelectorAll(".v2-product-card").length > 0, { label: "the catalogue products" });
const cardsBefore = document.querySelectorAll(".v2-product-card").length;
check("the catalogue renders its products", cardsBefore > 0);
setField("#v2-search-input", "Ring");
await sleep(150);
check("an ordinary search reveals no staff option", entry() === null);
document.querySelector(".v2-catalog-search")
  .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
await waitFor(() => {
  const cards = document.querySelectorAll(".v2-product-card").length;
  return cards > 0 && cards < cardsBefore && dom.window.location.hash.includes("q=Ring");
}, { label: "the catalogue to filter by the ordinary query" });
check("an ordinary search still filters the catalogue",
  document.querySelectorAll(".v2-product-card").length < cardsBefore);
check("an ordinary search still writes its query into the URL",
  dom.window.location.hash.includes("q=Ring"));

// ── the catalogue's own search field carries the same entrance ────────────
setField("#v2-search-input", KEYWORD);
await waitFor(() => Boolean(entry()), { label: "the catalogue staff entrance" });
check("the catalogue search reveals the same option", entryAction()?.textContent?.includes("Enter ALYQ POS"));
const catalogForm = document.querySelector(".v2-catalog-search");
catalogForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
await waitFor(onLoginScreen, { label: "the staff login screen from the catalogue" });
check("Enter in the catalogue search opens the staff sign-in, not a product search",
  dom.window.location.hash === "#/login" && !dom.window.location.hash.includes("q="));

await navigate("#/store/products", 500);
await waitFor(() => Boolean(document.querySelector("#v2-search-input")), { label: "the catalogue again" });
setField("#v2-search-input", KEYWORD);
await waitFor(() => Boolean(entry()), { label: "the catalogue staff entrance, again" });
clickEl(entryAction());
await waitFor(onLoginScreen, { label: "the staff login screen from the catalogue click" });
check("clicking the catalogue option opens the staff sign-in", dom.window.location.hash === "#/login");

// ── the shopper's own account is untouched ───────────────────────────────
await navigate("#/store/account", 400);
await waitFor(() => Boolean(document.querySelector('.v2-account-auth')), { label: "the shopper account" });
check("the shopper account screen is unchanged and still offers its own sign-in",
  Boolean(button(document.querySelector('.v2-account-auth'), "Sign in")) && entry() === null);
clickEl(button(document.querySelector(".v2-account-tabs"), "Create an"));
await waitFor(() => Boolean(document.querySelector('.v2-account-form input[autocomplete="name"]')),
  { label: "the shopper register form" });
setField('.v2-account-form input[autocomplete="name"]', "Mona Mahmoud");
setField('.v2-account-form input[autocomplete="tel"]', "01001234567");
setField('.v2-account-form input[autocomplete="new-password"]', "sample-pass-123");
clickEl(button(document.querySelector('.v2-account-auth'), "Create account"));
await waitFor(() => Boolean(document.querySelector('.v2-account-nav')), { label: "the shopper to sign in" });
check("the shopper still signs into their own account, unaffected by the staff entrance",
  Boolean(document.querySelector('.v2-account-nav')) && !(document.body.textContent ?? "").includes("Signed in as"));

// ── the Arabic shop shows the Arabic label ───────────────────────────────
await navigate("#/store", 400);
await waitFor(() => Boolean(testid("v2-home")), { label: "the shop, to switch language" });
clickEl(button(document.querySelector(".v2-header"), "عربي"));
await waitFor(() => button(document.querySelector(".v2-header"), "EN") !== undefined,
  { label: "the Arabic shop" });
await openHeaderSearch();
setField(".v2-search-row input", KEYWORD);
await waitFor(() => Boolean(entry()), { label: "the Arabic staff entrance" });
check("the Arabic shop labels the option in Arabic", entryAction()?.textContent?.includes("دخول نظام ALYQ POS"));
clickEl(entryAction());
await waitFor(onLoginScreen, { label: "the staff login screen from the Arabic shop" });
check("the Arabic shop reaches the same staff sign-in screen", dom.window.location.hash === "#/login");

console.log("\nHidden staff entrance in the V2 shop search passed.\n");
finish("V2 hidden staff entrance");

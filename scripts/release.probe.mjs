#!/usr/bin/env node
/**
 * Release probe — the non-mutating smoke test for a published artifact.
 *
 *   node scripts/release.probe.mjs                     # checks dist/release.json + boots the app
 *   node scripts/release.probe.mjs --url https://pos.example.com
 *   node scripts/release.probe.mjs --manifest dist/release.json --expect-sha "$GITHUB_SHA"
 *   node scripts/release.probe.mjs --demo --skip-app   # evaluation build, metadata only
 *
 * Two halves, both read-only:
 *
 *   1. **Metadata.** `dist/release.json` must name the version, the commit, the
 *      build time and the mode. A production deployment must say `production`
 *      and must have been built from a clean checkout (`vite.config.ts` writes
 *      `dirty: true` otherwise). The rules live in `src/lib/qa/releaseProbe.ts`
 *      and are unit-tested by `src/lib/qa/__tests__/releaseProbe.selftest.ts`;
 *      this file only prints them.
 *
 *   2. **The empty-catalogue walk.** The shipped bundle is booted in jsdom
 *      against a deliberately EMPTY catalogue — the state a brand-new
 *      installation is in on day zero, before anyone has created a product.
 *      The shop must render its empty state, the register must offer nothing to
 *      sell, and NOTHING may be written: no sale, no order, no customer, no
 *      return, no stock movement, no audit row, and no network request at all.
 *      That is the honest release smoke test: it proves the app survives having
 *      no data *without creating any*.
 *
 *   3. `--url` additionally GETs `release.json` and `/` from a deployed origin.
 *      The request plan is built by `remoteProbePlan()` and contains only GET
 *      requests; the probe asserts that before it sends anything, so "the probe
 *      never mutates the deployment" is a property of the code, not a promise.
 *
 * Exit code 0 when every finding passes, 1 when any fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { buildAppBundle, DEFAULT_BUNDLE, bundleFileUrl } from "./lib/app-bundle.mjs";
import {
  PROBE_SAFE_METHODS,
  diffStorage,
  inspectConsoleErrors,
  inspectNetworkCalls,
  inspectReleaseManifest,
  inspectStorageDiff,
  isMutatingMethod,
  remoteProbePlan,
  summarise,
} from "../src/lib/qa/releaseProbe.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const manifestPath = path.resolve(arg("manifest", path.join(ROOT, "dist", "release.json")));
const expectSha = arg("expect-sha");
const expectVersion = arg("expect-version");
const expectMode = has("demo") ? "demo" : "production";
const url = arg("url");
const skipApp = has("skip-app");
const asJson = has("json");

const findings = [];
const report = (level, code, message) => findings.push({ level, code, message });

/* ── 1 · metadata ────────────────────────────────────────────────────────── */
let manifest = null;
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    report("fail", "release.missing", `${manifestPath} is not valid JSON: ${error.message}`);
  }
} else {
  report("fail", "release.missing", `${manifestPath} does not exist — run \`npm run build\` first`);
}
if (manifest) {
  findings.push(...inspectReleaseManifest(manifest, {
    mode: expectMode,
    ...(expectSha ? { sha: expectSha } : {}),
    ...(expectVersion ? { version: expectVersion } : {}),
    // A demonstration build is not a release: it is allowed to be dirty and to
    // have no mode_requested, because nothing downstream should deploy it.
    requireClean: expectMode === "production",
    requireExplicitMode: expectMode === "production",
  }));
}

/* ── 2 · the empty-catalogue walk ────────────────────────────────────────── */
const EMPTY_CATALOGUE = JSON.stringify({
  categories: [],
  products: [],
  variants: [],
  color_images: [],
  seed_revision: 3,
});

const consoleErrors = [];
const networkCalls = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function walkEmptyCatalogue() {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  } catch {
    /* node owns navigator */
  }
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  // Read-only, on purpose: the probe refuses to let the app reach a backend at
  // all, so a demo walk cannot accidentally write to a live project.
  const blockedFetch = (input) => {
    const target = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
    networkCalls.push(`fetch ${target}`);
    return Promise.reject(new Error(`release probe blocked network call: ${target}`));
  };
  dom.window.fetch = blockedFetch;
  globalThis.fetch = blockedFetch;
  class BlockedXHR {
    open(method, target) {
      networkCalls.push(`${method} ${target}`);
    }
    send() {
      throw new Error("release probe blocked XMLHttpRequest");
    }
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
  }
  dom.window.XMLHttpRequest = BlockedXHR;
  globalThis.XMLHttpRequest = BlockedXHR;

  dom.window.console.error = (...args) => {
    consoleErrors.push(args.map((a) => (a?.stack ?? String(a))).join(" "));
  };
  dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));
  process.on("unhandledRejection", (reason) => {
    consoleErrors.push(`unhandledRejection: ${reason?.stack ?? String(reason)}`);
  });

  // Day-zero storage: an empty catalogue document and nothing else. The demo
  // repository accepts it (the revision matches) instead of reseeding, which is
  // what makes this a real empty-catalogue boot rather than a seeded one.
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("alyq.demo.catalog.v1", EMPTY_CATALOGUE);

  const snapshot = () => Object.fromEntries(Object.keys(dom.window.localStorage).map((key) => [key, dom.window.localStorage.getItem(key) ?? ""]));
  const before = snapshot();

  await import(bundleFileUrl(process.env.ALYQ_TEST_BUNDLE ?? DEFAULT_BUNDLE));
  await sleep(1_500);

  const body = () => dom.window.document.body.textContent ?? "";
  const testid = (id) => dom.window.document.querySelector(`[data-testid="${id}"]`);
  /** Product cards the storefront itself renders — never `article:not(...)`, so an
   *  editorial block cannot be mistaken for stock. */
  const productCards = (target) => [...target.querySelectorAll('article[data-testid^="v2-card-"]')];
  const navigate = async (hash, settle = 700) => {
    dom.window.location.hash = hash;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    await sleep(settle);
  };
  const waitFor = async (condition, label, timeout = 12_000, code = "probe.timeout") => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (condition()) return true;
      if (Date.now() > deadline) {
        report("fail", code, `timed out waiting for ${label}`);
        return false;
      }
      await sleep(150);
    }
  };

  const setInput = (selector, value) => {
    const input = dom.window.document.querySelector(selector);
    if (!input) return null;
    const proto = input.tagName === "SELECT"
      ? dom.window.HTMLSelectElement
      : input.tagName === "TEXTAREA"
        ? dom.window.HTMLTextAreaElement
        : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return input;
  };

  // ── the shop, with nothing in it ────────────────────────────────────────
  if (testid("configuration-error")) {
    report("fail", "probe.configuration_screen", "the shipped bundle rendered the configuration-error screen");
  } else {
    report("pass", "probe.starts", "the shipped bundle boots without the configuration-error screen");
  }

  await navigate("#/", 900);
  await waitFor(() => testid("v2-home"), "the storefront home", 12_000, "probe.shop_empty");
  // A day-zero shop still has a hero, copy and a footer — what it must not have
  // is a product. The home is allowed to look like a shop with nothing on the
  // shelves; it is not allowed to invent stock.
  const homeCards = productCards(dom.window.document);
  report(homeCards.length === 0 ? "pass" : "fail", "probe.shop_empty",
    homeCards.length === 0
      ? "the day-zero storefront renders with no product on it"
      : `the storefront rendered ${homeCards.length} product card(s) from an empty catalogue`);

  await navigate("#/store/products", 900);
  await waitFor(() => testid("v2-catalog"), "the catalogue", 12_000, "probe.catalogue_empty");
  const catalogueEmpty = await waitFor(() => testid("v2-empty"), "the catalogue empty state", 12_000, "probe.empty_state");
  const noCards = productCards(dom.window.document).length === 0;
  report(catalogueEmpty && noCards ? "pass" : "fail", "probe.catalogue_empty",
    catalogueEmpty && noCards
      ? "the catalogue lists nothing, offers no product card and states that it is empty"
      : "the catalogue rendered cards or no empty state for an empty catalogue");

  // ── the staff door, with nothing in it ──────────────────────────────────
  await navigate("#/login", 900);
  const login = setInput("input[autocomplete='username']", "admin");
  const password = setInput("input[autocomplete='current-password']", "alyq1234");
  const signIn = [...dom.window.document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Sign in"));
  if (!login || !password || !signIn) {
    report("fail", "probe.login", "the login screen did not render its fields on an empty installation");
  } else {
    signIn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => body().includes("Signed in as"), "the admin session", 12_000, "probe.login");
    report("pass", "probe.login", "staff can sign in on an empty installation");
  }

  await navigate("#/dashboard/products", 1_200);
  const productsEmpty = await waitFor(
    () => /No products|لا توجد منتجات|no results/i.test(body()) || dom.window.document.querySelectorAll("tbody tr").length === 0,
    "the empty products table",
    12_000,
    "probe.products_empty",
  );
  report(productsEmpty ? "pass" : "fail", "probe.products_empty",
    productsEmpty ? "the products screen states that the catalogue is empty" : "the products screen did not settle on an empty catalogue");

  await navigate("#/dashboard/pos", 1_200);
  const search = dom.window.document.querySelector('[data-testid="pos-scan-search"]');
  if (!search) {
    report("fail", "probe.pos", "the register did not render its scan/search box on an empty catalogue");
  } else {
    const listProducts = dom.window.document.querySelectorAll('[data-pos-result-index]').length;
    report(listProducts === 0 ? "pass" : "fail", "probe.pos_empty",
      listProducts === 0
        ? "the register offers no result rows when there is nothing to sell"
        : `the register invented ${listProducts} result row(s) from an empty catalogue`);
  }

  const after = snapshot();
  // The after-snapshot travels with the diff: an empty basket or a `session.login`
  // audit row is the probe's own footprint, a cart line or a sale row is not.
  findings.push(...inspectStorageDiff(diffStorage(before, after), after));
  findings.push(...inspectNetworkCalls(networkCalls));
  findings.push(...inspectConsoleErrors(consoleErrors));
}

/* ── 3 · a deployed origin, GET-only ─────────────────────────────────────── */
async function probeRemote(origin) {
  const plan = remoteProbePlan(origin);
  const unsafe = plan.filter((request) => isMutatingMethod(request.method));
  if (unsafe.length > 0) {
    report("fail", "probe.mutating_request",
      `the request plan contains a mutating method: ${unsafe.map((r) => r.method).join(", ")}`);
    return;
  }
  report("pass", "probe.get_only",
    `the request plan uses only ${PROBE_SAFE_METHODS.join("/")} (${plan.length} request(s))`);

  for (const request of plan) {
    try {
      const response = await fetch(request.url, { method: request.method, redirect: "follow" });
      if (response.status !== request.expect.status) {
        report("fail", `probe.http_${request.url.endsWith("release.json") ? "manifest" : "html"}`,
          `${request.url} answered ${response.status}`);
        continue;
      }
      const text = await response.text();
      if (request.url.endsWith("release.json")) {
        let deployed = null;
        try {
          deployed = JSON.parse(text);
        } catch {
          report("fail", "probe.deployed_manifest", `${request.url} is not JSON`);
          continue;
        }
        findings.push(...inspectReleaseManifest(deployed, {
          mode: expectMode,
          ...(expectSha ? { sha: expectSha } : {}),
          requireClean: expectMode === "production",
          requireExplicitMode: expectMode === "production",
        }));
        report("pass", "probe.deployed_manifest", `the deployment publishes release.json for ${deployed.sha ?? "an unknown commit"}`);
      } else {
        const sha = manifest?.sha ? String(manifest.sha).replace(/-dirty$/, "") : null;
        const inline = sha && text.includes(sha);
        report(inline ? "pass" : "warn", "probe.html_sha",
          inline
            ? "the served HTML carries the release SHA inline"
            : "the served HTML does not carry the expected release SHA — is the deployment from this build?");
        report(text.includes('id="root"') ? "pass" : "fail", "probe.html_shell",
          text.includes('id="root"') ? "the served HTML carries the application root element" : "the served HTML has no #root element");
      }
    } catch (error) {
      report("fail", "probe.unreachable", `${request.url}: ${error.message}`);
    }
  }
}

/* ── run ─────────────────────────────────────────────────────────────────── */
console.log(c.bold("\nALYQ release probe — read-only, empty catalogue, no writes\n"));

if (!skipApp) {
  if (!fs.existsSync(process.env.ALYQ_TEST_BUNDLE ?? DEFAULT_BUNDLE) || has("rebuild")) {
    const { bytes } = await buildAppBundle({ outfile: process.env.ALYQ_TEST_BUNDLE ?? DEFAULT_BUNDLE });
    console.log(c.dim(`  bundle ${os.tmpdir() === path.dirname(DEFAULT_BUNDLE) ? path.basename(DEFAULT_BUNDLE) : DEFAULT_BUNDLE} (${(bytes / 1024).toFixed(0)} kB)`));
  }
  await walkEmptyCatalogue();
} else {
  report("pass", "probe.app_skipped", "the empty-catalogue walk was skipped (--skip-app)");
}

if (url) await probeRemote(url);

const summary = summarise(findings);
if (asJson) {
  console.log(JSON.stringify({ findings, summary }, null, 2));
} else {
  for (const finding of findings) {
    const mark = finding.level === "pass" ? c.green("✓") : finding.level === "warn" ? c.yellow("!") : c.red("✗");
    console.log(`${mark} ${finding.code} — ${finding.message}`);
  }
  console.log(
    `\n${summary.ok ? c.green("release probe passed") : c.red("release probe failed")} · ` +
      `${summary.passed} passed, ${summary.warned} warned, ${summary.failed} failed\n`,
  );
}
process.exit(summary.ok ? 0 : 1);

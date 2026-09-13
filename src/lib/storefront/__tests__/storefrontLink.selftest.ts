/**
 * POS → website integration self-test.
 * Run with:
 *   npx esbuild src/lib/storefront/__tests__/storefrontLink.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-storefront.mjs && node /tmp/alyq-storefront.mjs
 *
 * Regression guard for the bug found in the final A-to-Z audit: the storefront
 * existed and worked, `#/store` was routed, the app shell and the website
 * settings screen both linked to it — but the POS register had no way to open
 * it. No button, no click handler, no URL generation anywhere in the POS module.
 *
 * Half of this suite is behavioural (the resolver's three answers) and half is
 * structural (the register screen still wires it). The structural half is what
 * fails if someone deletes the control again: the resolver can be perfectly
 * correct and the till can still be a dead end.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { STOREFRONT_ROUTE, resolveStorefrontTarget } from "../storefrontLink";

type TestCase = { name: string; fn: () => void };
const tests: TestCase[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

/** Repo root, found by walking up from cwd so the runner's location is irrelevant. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "src/modules/pos/pages/PosPage.tsx"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}
const ROOT = repoRoot();
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

const ORIGIN = "https://pos.example.com";
const resolve = (configured?: string) => resolveStorefrontTarget(configured, ORIGIN);

// ── the bundled shop is the default ──────────────────────────────────────────
test("nothing configured opens the shop bundled in this app", () => {
  for (const configured of [undefined, "", "   ", "\t\n "]) {
    const target = resolve(configured);
    assert.equal(target.href, null, `configured=${JSON.stringify(configured)}`);
    assert.equal(target.to, STOREFRONT_ROUTE);
    assert.equal(target.warning, null);
  }
});

test("the internal route is /store, the public top-level route", () => {
  // If this drifts from the router in src/App.tsx the POS control lands in the
  // authenticated catch-all — a dashboard redirect instead of the shop.
  assert.equal(STOREFRONT_ROUTE, "/store");
  const app = read("src/App.tsx");
  assert.ok(
    app.includes('<Route path="/store"'),
    "src/App.tsx no longer routes /store — the POS link would 404 into the shell",
  );
  assert.ok(
    app.indexOf('<Route path="/store"') < app.indexOf('path="*" element={<AuthenticatedApp'),
    "/store must stay a sibling of the authenticated app, not a child of it, or the shop stops being public",
  );
});

test("reading the environment is safe outside Vite", () => {
  // The logic runner bundles for node, where import.meta.env does not exist.
  // Throwing there would take the register screen down with it.
  assert.doesNotThrow(() => resolveStorefrontTarget());
});

// ── a configured origin is honoured ─────────────────────────────────────────
test("an absolute https origin is used as-is", () => {
  const target = resolve("https://shop.example.com");
  assert.equal(target.href, "https://shop.example.com/");
  assert.equal(target.warning, null);
  // Still reported, so a caller can fall back if that origin is unreachable.
  assert.equal(target.to, STOREFRONT_ROUTE);
});

test("http, a relative path and a bare segment all resolve", () => {
  assert.equal(resolve("http://shop.internal:8080").href, "http://shop.internal:8080/");
  assert.equal(resolve("/shop").href, `${ORIGIN}/shop`);
  assert.equal(resolve("shop").href, `${ORIGIN}/shop`);
  assert.equal(resolve("/shop").warning, null);
});

test("the scheme is matched case-insensitively and the path and query survive", () => {
  // WHATWG URL normalises the host to lower case and appends "/" to a bare
  // origin; the path and query are preserved exactly.
  assert.equal(
    resolve("HTTPS://Shop.Example.com/eg?lang=ar").href,
    "https://shop.example.com/eg?lang=ar",
  );
  assert.equal(resolve("HTTPS://Shop.Example.com/eg").warning, null);
  assert.equal(resolve("HTTPS://SHOP.EXAMPLE.COM").href, "https://shop.example.com/");
});

test("surrounding whitespace is trimmed before validating", () => {
  assert.equal(resolve("  https://shop.example.com  ").href, "https://shop.example.com/");
  assert.equal(resolve("  https://shop.example.com  ").warning, null);
});

// ── a hostile or broken value is refused, never rendered ────────────────────
test("a scheme that would execute from an href is refused", () => {
  // The value is rendered into an anchor, so an unvalidated string here is
  // script injection reachable by whoever can set the build environment.
  for (const hostile of [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    const target = resolve(hostile);
    assert.equal(target.href, null, hostile);
    assert.equal(target.warning, "invalid_url", hostile);
    assert.equal(target.to, STOREFRONT_ROUTE, hostile);
  }
});

test("a malformed scheme is refused rather than silently turned into a path", () => {
  // `new URL("://shop.example.com", origin)` does not throw — it resolves to a
  // relative path on THIS origin. Accepting that would produce a link that 404s
  // with no warning, which is precisely the silent failure this must not have.
  for (const broken of [
    "http://",
    "https://",
    "://shop.example.com",
    "ftp://shop.example.com",
    "ws://shop.example.com",
  ]) {
    const target = resolve(broken);
    assert.equal(target.href, null, broken);
    assert.equal(target.warning, "invalid_url", broken);
    assert.equal(target.to, STOREFRONT_ROUTE, broken);
  }
});

test("a single-slash http typo is repaired by the URL parser, not refused", () => {
  // WHATWG URL normalises `http:/host` to `http://host/`. That is spec
  // behaviour and the outcome is a valid http origin, so it is accepted —
  // pinned here so the leniency is a decision rather than an accident.
  assert.equal(resolve("HTTP:/shop.example.com").href, "http://shop.example.com/");
  assert.equal(resolve("HTTP:/shop.example.com").warning, null);
  // The same leniency does NOT extend to a non-http scheme.
  assert.equal(resolve("javascript:/alert(1)").href, null);
  assert.equal(resolve("javascript:/alert(1)").warning, "invalid_url");
});

test("a legitimate relative path is still accepted", () => {
  // Same-origin sub-path deployments are valid, and must not be caught by the
  // malformed-scheme guard above.
  for (const relative of ["/shop", "shop", "./shop", "/shop/index.html"]) {
    assert.equal(resolve(relative).warning, null, relative);
    assert.ok(resolve(relative).href?.startsWith(ORIGIN), `${relative} resolves against the app origin`);
  }
});

test("a rejection is always distinguishable from 'not configured'", () => {
  // The invariant the POS screen depends on: href is null in both cases, so the
  // warning is the only thing that separates a deliberate default from a
  // misconfigured deployment. Without it the failure is silent.
  assert.equal(resolve("javascript:alert(1)").warning, "invalid_url");
  assert.equal(resolve(undefined).warning, null);
  assert.equal(resolve("javascript:alert(1)").href, resolve(undefined).href);
});

// ── structural: the register screen still has the door ──────────────────────
test("the POS register renders an Open website control that navigates internally", () => {
  const pos = read("src/modules/pos/pages/PosPage.tsx");
  assert.ok(
    pos.includes('from "@/lib/storefront/storefrontLink"'),
    "PosPage no longer imports the storefront resolver — the POS → website entry point is gone",
  );
  assert.ok(
    pos.includes("resolveStorefrontTarget()"),
    "PosPage no longer resolves a storefront target",
  );
  assert.ok(
    pos.includes('data-testid="pos-open-website"'),
    "the POS Open website control lost its test id",
  );
  // Internal navigation is the requirement: window.open on a till browser is
  // exactly what popup blockers swallow, and it fails silently in the field.
  const linkAt = pos.indexOf("data-testid=\"pos-open-website\"");
  const before = pos.slice(Math.max(0, linkAt - 400), linkAt);
  assert.ok(/<Link\s/.test(before), "the control must be a router <Link>, not a raw anchor or window.open");
  assert.ok(
    /to=\{storefront\.to\}/.test(pos),
    "the control must navigate to the resolved storefront route",
  );
  assert.ok(
    !/window\.open/.test(pos),
    "PosPage must not open the shop with window.open — a popup blocker turns that into a dead button",
  );
});

test("the control is labelled in both languages and warns when misconfigured", () => {
  const pos = read("src/modules/pos/pages/PosPage.tsx");
  assert.ok(pos.includes('t("nav.viewStore")'), "the control has no translated label");
  assert.ok(
    pos.includes('t("pos.openWebsiteConfigInvalid")'),
    "an unusable VITE_STOREFRONT_URL is no longer reported to the operator",
  );
  assert.ok(
    pos.includes('storefront.warning === "invalid_url"'),
    "the configuration warning is no longer conditional on an actual rejection",
  );
  assert.ok(
    pos.includes("configWarningShown"),
    "the warning must fire once, not on every render of the register screen",
  );
});

test("both languages carry the label and the warning", () => {
  const dict = read("src/lib/i18n/dictionary.ts");
  for (const key of ["nav.viewStore", "pos.openWebsiteConfigInvalid"]) {
    const hits = dict.split(`"${key}":`).length - 1;
    assert.equal(hits, 2, `"${key}" must exist exactly once per language, found ${hits}`);
  }
});

test("the environment variable is declared and documented, and is not a secret", () => {
  assert.ok(
    read("src/vite-env.d.ts").includes("VITE_STOREFRONT_URL?: string"),
    "VITE_STOREFRONT_URL is not declared in ImportMetaEnv",
  );
  assert.ok(
    read(".env.example").includes("VITE_STOREFRONT_URL="),
    "VITE_STOREFRONT_URL is missing from .env.example",
  );
  assert.ok(
    read("docs/DEPLOYMENT.md").includes("VITE_STOREFRONT_URL"),
    "VITE_STOREFRONT_URL is not documented in docs/DEPLOYMENT.md",
  );
});

// ── runner ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}
console.log("");
if (failed > 0) {
  console.error(`${failed}/${tests.length} POS → website integration tests FAILED.`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} POS → website integration checks hold.`);

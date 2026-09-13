/**
 * Crash-recovery acceptance flow (Phase 22 · H3 / §5 / §12).
 *
 * Forces a real React render crash inside jsdom and asserts what a user sees
 * afterwards. `ErrorBoundary` is mounted three times in `App.tsx` — shell,
 * storefront, till — and until this suite existed nothing proved any of them
 * worked: a boundary that is never rendered past a crash is indistinguishable
 * from one that is missing.
 *
 * The crash is produced by `scripts/lib/crash-entry.ts`, which is bundled here
 * on its own (a separate outfile from the app bundle) because it needs a
 * component that throws on demand and the application has none.
 *
 * ONE DELIBERATE DEPARTURE FROM THE OTHER SUITES: they fail on any
 * `console.error`, because in a healthy run nothing should log one. This suite
 * expects errors — sending the detail to the console and nowhere else is the
 * behaviour under test. So it asserts the console output is the EXPECTED output
 * rather than that it is empty, and it asserts the same detail is absent from
 * the DOM. Both halves matter: a boundary that logged nothing would be hiding
 * the crash from developers, and one that rendered the message would be handing
 * a token or a stack to whoever is at the screen.
 *
 * Run it through the E2E runner (`npm run test:e2e crash`) or directly:
 *   node scripts/crash.flow.mjs
 */
import { JSDOM, VirtualConsole } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppBundle } from "./lib/app-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "lib", "crash-entry.ts");
const BUNDLE = "/tmp/alyq-crash.mjs";

// ── jsdom, bootstrapped the way every other flow bootstraps it ────────────
// `window.location.reload()` cannot be stubbed: jsdom defines it as an own,
// non-configurable property on the location instance ([LegacyUnforgeable]), so
// a prototype stub is shadowed and an instance redefine throws. It is observed
// instead — jsdom reports the real call as an unimplemented navigation, which
// proves the handler fired and asked the browser to reload.
const virtualConsole = new VirtualConsole();
const jsdomErrors = [];
virtualConsole.on("jsdomError", (error) => jsdomErrors.push(String(error?.message ?? error)));

const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
  virtualConsole,
});

const consoleErrors = [];
const networkCalls = [];

globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  // Node 22 owns `navigator`; jsdom's copy is only needed if it can be set.
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
} catch {
  /* node owns navigator */
}
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.FormData = dom.window.FormData;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// A crash screen must not phone home: there is no error reporter in this
// project and adding one is not the boundary's business.
const blockedFetch = (input) => {
  const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
  networkCalls.push(`fetch ${url}`);
  return Promise.reject(new Error(`blocked network call: ${url}`));
};
dom.window.fetch = blockedFetch;
globalThis.fetch = blockedFetch;

const capture = (...args) => consoleErrors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
dom.window.console.error = capture;
dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));

// ── build and load the crash harness ──────────────────────────────────────
let mod;
try {
  const { bytes } = await buildAppBundle({ outfile: BUNDLE, entryPoint: ENTRY });
  console.log(`bundled ${path.relative(ROOT, ENTRY)} → ${BUNDLE} (${(bytes / 1024).toFixed(0)} kB)`);
  mod = await import(`${BUNDLE}?run=${Date.now()}`);
} catch (error) {
  console.error(`\n✗ could not build/load the crash harness: ${String(error?.message ?? error).slice(0, 300)}`);
  for (const e of error?.errors ?? []) console.error(`  ${e.text}`);
  process.exit(1);
}

// React and `ErrorBoundary` call the bare `console.error`, which inside a Node
// bundle is NODE's console — `dom.window.console.error` never sees it. Both are
// captured here, and Node's is restored before the summary so this file's own
// failure output still prints. (The other flows stub only the window copy, so
// their "console errors: 0" line does not observe bundle logging; that is left
// alone deliberately — see PHASE-22-REPORT.md §15.)
const realConsoleError = console.error.bind(console);
console.error = capture;

// ── driving helpers ───────────────────────────────────────────────────────
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** React renders on a microtask/timeout boundary; give it several turns. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await sleep(0);
}
function mount() {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  return el;
}
function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
}
const probe = (root, name) => root.querySelector(`[data-probe="${name}"]`);
const textOf = (root) => (root.textContent ?? "").replace(/\s+/g, " ");

const results = [];
function check(num, title, ok, detail = "") {
  results.push({ num, title, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "✓" : "✗"} STEP ${num} · ${title} — ${ok ? "PASS" : "FAIL"}${detail ? `\n    ${detail}` : ""}`);
}

// ── STEP 1 · the boundary is invisible while nothing is broken ────────────
const solo = mount();
mod.mountDefault(solo, "solo");
await settle();
check(
  1,
  "A healthy tree renders straight through the boundary",
  Boolean(probe(solo, "healthy-solo")) && consoleErrors.length === 0,
  `${probe(solo, "healthy-solo") ? "subtree rendered" : "nothing rendered"} · console errors: ${consoleErrors.length}`,
);

// ── STEP 2 · a render crash shows a recovery screen, not a blank page ─────
click(probe(solo, "crash-solo"));
await settle();
const afterCrash = textOf(solo);
const crashed = mod.didThrow("solo");
check(
  2,
  "A render crash shows a recovery screen instead of a blank page",
  crashed &&
    solo.innerHTML.trim().length > 0 &&
    /Something went wrong/.test(afterCrash) &&
    /حدث خطأ غير متوقع/.test(afterCrash),
  `${crashed ? "the subtree really threw" : "⚠ nothing threw — the test proved nothing"} · ` +
    `${solo.innerHTML.trim().length} bytes of markup · EN+AR headline present`,
);

// ── STEP 3 · the reassurance and the way back are both on the screen ──────
const reloadBtn = [...solo.querySelectorAll("button")].find((b) => /reload|إعادة التحميل/i.test(b.textContent ?? ""));
check(
  3,
  "The screen says nothing was lost and offers a reload",
  /Nothing you entered was lost/.test(afterCrash) && Boolean(reloadBtn),
  `${/Nothing you entered was lost/.test(afterCrash) ? "reassurance shown" : "⚠ no reassurance"} · ` +
    `button: ${reloadBtn ? `"${(reloadBtn.textContent ?? "").trim()}"` : "missing"}`,
);

// ── STEP 4 · the crash detail never reaches the screen ────────────────────
const leaked = [
  mod.SECRET && afterCrash.includes(mod.SECRET) ? "the secret token" : null,
  mod.LOCATION && afterCrash.includes(mod.LOCATION) ? "the file:line location" : null,
  /render failed/.test(afterCrash) ? "the raw error message" : null,
  /\bat\s+\S+\.[tj]sx?:\d+/.test(afterCrash) ? "a stack frame" : null,
].filter(Boolean);
check(
  4,
  "No secret, message or stack frame reaches the screen",
  leaked.length === 0,
  leaked.length === 0 ? `${afterCrash.length} visible characters, none of them the error` : `⚠ leaked: ${leaked.join(", ")}`,
);

// ── STEP 5 · but the detail does reach the console, the only place it may go
const logged = consoleErrors.join("\n");
check(
  5,
  "The detail is logged for a developer instead",
  consoleErrors.length > 0 && logged.includes(mod.SECRET),
  `${consoleErrors.length} console.error call(s) · secret present in the log: ${logged.includes(mod.SECRET)}`,
);

// ── STEP 6 · the reload button is wired to a real reload ──────────────────
const navBefore = jsdomErrors.length;
if (reloadBtn) click(reloadBtn);
await settle();
const navigation = jsdomErrors.slice(navBefore).find((m) => /navigation/i.test(m));
check(
  6,
  "The reload button asks the browser to reload",
  Boolean(navigation),
  navigation ? `jsdom refused the navigation it was asked for: "${navigation}"` : "⚠ no reload was attempted",
);

// ── STEP 7 · the `fallback` prop replaces the shared screen ───────────────
// This is the storefront and till path: a customer and a cashier mid-sale get
// wording for their own screen rather than the generic one.
const custom = mount();
mod.mountCustomFallback(custom, "custom", "storefront fallback");
await settle();
click(probe(custom, "crash-custom"));
await settle();
const customText = textOf(custom);
check(
  7,
  "A boundary with its own fallback shows that instead of the generic screen",
  Boolean(probe(custom, "custom-fallback")) && !/Something went wrong/.test(customText),
  `${probe(custom, "custom-fallback") ? `"${customText.trim()}"` : "fallback missing"} · generic screen absent`,
);

// ── STEP 8 · one broken subtree does not blank the rest of the app ────────
// The reason App.tsx mounts three boundaries: a crash in the till should not
// take the storefront with it.
const siblings = mount();
mod.mountSiblings(siblings);
await settle();
click(probe(siblings, "crash-a"));
await settle();
check(
  8,
  "A crash in one subtree leaves its sibling still rendering",
  Boolean(probe(siblings, "fallback-a")) &&
    Boolean(probe(siblings, "healthy-b")) &&
    !probe(siblings, "fallback-b"),
  `A: ${probe(siblings, "fallback-a") ? "fell back" : "did not fall back"} · ` +
    `B: ${probe(siblings, "healthy-b") ? "still rendering" : "⚠ blanked too"}`,
);

// ── summary ───────────────────────────────────────────────────────────────
console.error = realConsoleError;
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("\n──────── summary ────────");
for (const r of results) console.log(`${r.status === "PASS" ? "✓" : "✗"} ${r.num}. ${r.title}: ${r.status}`);
console.log(`\n${passed} passed · ${failed} failed · console errors: ${consoleErrors.length} (expected here) · network calls: ${networkCalls.length}`);

if (networkCalls.length > 0) {
  console.error(`\n✗ the crash screen reached the network ${networkCalls.length} time(s):`);
  for (const call of networkCalls) console.error(`  ${call}`);
  process.exit(1);
}
// Every console.error must be the boundary or React reporting THIS crash.
const unexpected = consoleErrors.filter((line) => !/render failed|ErrorBoundary caught|The above error occurred|minified React error/i.test(line));
if (unexpected.length > 0) {
  console.error(`\n✗ ${unexpected.length} console error(s) unrelated to the crash under test:`);
  for (const line of unexpected.slice(0, 5)) console.error(`  ${line.slice(0, 300)}`);
  process.exit(1);
}
if (failed > 0) process.exit(1);
console.log("\nCrash recovery verified: the screen explains itself, keeps the detail off the DOM, and the rest of the app survives.\n");
process.exit(0);

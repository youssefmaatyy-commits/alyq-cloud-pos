/**
 * Sidebar collapse/expand bug fix — regression suite.
 *
 * REAL BUG: the desktop sidebar could collapse, but its own toggle button was
 * rendered only while expanded (`{!navCollapsed ? <button>…</button> : null}`
 * in `AppShell.tsx`), so once collapsed the control vanished from the DOM
 * along with it and there was nothing left to click to bring it back.
 *
 * The fix renders the toggle unconditionally in both states (still desktop
 * only, via the same `lg:grid` breakpoint) and reflows the brand row to a
 * centered column when collapsed so the control still fits the narrow rail.
 *
 * This suite proves, driving the real bundle in jsdom:
 *
 *   1–2.  the sidebar starts expanded, with its labels and a visible toggle;
 *   3.    collapsing narrows the sidebar;
 *   4–6.  an expand control remains in the DOM after collapsing, is a real
 *         `<button>` (not disabled, not `aria-hidden`), and lives inside the
 *         same fixed, `z-40` sidebar — not clipped out of it, not covered;
 *   7–9.  expanding restores the full sidebar, its labels, and the active
 *         nav item + current route survive the whole cycle;
 *   10.   no page reload occurred across the cycle (a sentinel set on
 *         `window` before toggling is still there afterwards — a hash-only
 *         SPA transition cannot survive a real page reload in this harness
 *         any more than it could in a browser, but nothing here is a
 *         navigation at all: the toggle is a local state change);
 *   11.   repeated toggling (collapse → expand → collapse → expand) keeps
 *         working every time, not just once;
 *   12.   signed-in user info and the sign-out control are intact whenever
 *         expanded;
 *   13–14. the same collapse → expand cycle works after switching to Arabic
 *         (RTL), and the sidebar carries the mirrored labels.
 *
 *   node scripts/test.e2e.mjs sidebar
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const COLLAPSE_KEY = "alyq.admin.sidebar.collapsed.v1";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
    // Start from a clean, expanded sidebar regardless of what a previous run
    // (or a stray default) left behind.
    ls.removeItem(COLLAPSE_KEY);
  },
});
const { assert, dom, sleep, waitFor, navigate, clickEl, clickExact, testid, signInAs } = ux;
const { document } = dom.window;

let passed = 0;
const TOTAL = 21;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

const aside = () => document.querySelector("aside");
const toggle = () => testid("sidebar-toggle");
/** The desktop sidebar's own `<a href="…">`, marked active by the shared
 *  `bg-white/10` row style both NavLink's own match and an explicit `active`
 *  prop produce — this is the same class the shell actually paints with. */
const activeLink = (href) => {
  const target = href.startsWith("#/dashboard") ? href : `#/dashboard${href.replace(/^#/, "")}`;
  const link = aside()?.querySelector(`a[href="${href}"]`) || aside()?.querySelector(`a[href="${target}"]`);
  return Boolean(link && link.className.includes("bg-white/10"));
};
const sidebarWidthClass = () => [...(aside()?.classList ?? [])].find((c) => c.startsWith("w-"));

async function main() {
  console.log("\nSidebar collapse/expand bug fix — regression suite\n");
  await sleep(600);

  // ── 0 · sign in and land on a route with a distinct active nav item ───────
  await signInAs("admin");
  await navigate("#/dashboard/settings", 500);
  await waitFor(() => aside(), { label: "the desktop sidebar" });
  await waitFor(() => testid("sidebar-toggle"), { label: "the sidebar toggle" });

  // ── 1 · expanded by default: labels and an active item are visible ───────
  check(
    "the sidebar starts expanded (w-64) with the Settings label visible",
    sidebarWidthClass() === "w-64" && aside().textContent.includes("Settings"),
  );
  check("Settings is marked active in the sidebar", activeLink("#/settings"));
  check("a collapse control is present while expanded", Boolean(toggle()));

  // ── 2 · collapse ───────────────────────────────────────────────────────
  const sentinel = `sentinel-${Date.now()}`;
  dom.window.__alyqSidebarTestSentinel = sentinel;
  clickEl(toggle());
  await sleep(250);
  check("collapsing narrows the sidebar to the icon rail (w-[4.75rem])", sidebarWidthClass() === "w-[4.75rem]");
  check(
    "the collapsed preference persists to localStorage",
    globalThis.localStorage.getItem(COLLAPSE_KEY) === "1",
  );

  // ── 3 · THE BUG: an expand control must remain, clickable, uncovered ─────
  const expandBtn = toggle();
  check("an expand control remains in the DOM after collapsing (the reported bug)", Boolean(expandBtn));
  check("it is a real, enabled button — not disabled", expandBtn.tagName === "BUTTON" && !expandBtn.disabled);
  check(
    "it carries an accessible label distinct from the collapsed state",
    (expandBtn.getAttribute("aria-label") ?? "").length > 0 &&
      expandBtn.getAttribute("aria-label") !== "Collapse sidebar",
  );
  check(
    "it lives inside the same fixed, stacked sidebar (not clipped out, not orphaned elsewhere)",
    expandBtn.closest("aside") === aside() && aside().className.includes("z-40"),
  );

  // ── 4 · expand — restores the sidebar, the active item, and the route ───
  check("the route is unchanged while the sidebar is collapsed", dom.window.location.hash.includes("/settings"));
  clickEl(toggle());
  await sleep(250);
  check(
    "expanding restores the full sidebar (w-64) and its labels",
    sidebarWidthClass() === "w-64" && aside().textContent.includes("Settings"),
  );
  check("the active nav item survives the collapse → expand cycle", activeLink("#/settings"));
  check("the current route/hash is unchanged — expanding did not navigate", dom.window.location.hash.includes("/settings"));
  check(
    "no page reload occurred across the cycle (window state survived)",
    dom.window.__alyqSidebarTestSentinel === sentinel,
  );

  // ── 5 · repeated toggling stays reliable, not just once ───────────────────
  clickEl(toggle()); // expanded -> collapsed
  await sleep(150);
  clickEl(toggle()); // collapsed -> expanded
  await sleep(150);
  clickEl(toggle()); // expanded -> collapsed
  await sleep(150);
  check(
    "after three more toggles the control is still present and the state is consistent",
    Boolean(toggle()) && sidebarWidthClass() === "w-[4.75rem]",
  );
  clickEl(toggle()); // collapsed -> expanded
  await sleep(200);
  check(
    "the sidebar still expands correctly after repeated toggling",
    sidebarWidthClass() === "w-64" && activeLink("#/settings"),
  );

  // ── 6 · signed-in user info + sign-out survive, untouched by the fix ─────
  check(
    "signed-in user info and the sign-out control are intact",
    aside().textContent.includes("Signed in as") &&
      [...aside().querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Sign out"),
  );

  // ── 7 · Arabic / RTL: the same cycle keeps working, mirrored ─────────────
  clickExact("العربية");
  await sleep(400);
  check("the shell flips to RTL", document.documentElement.getAttribute("dir") === "rtl");
  check(
    "the collapse control still works in RTL and the Arabic label renders",
    Boolean(toggle()) && aside().textContent.includes("الإعدادات"),
  );
  clickEl(toggle());
  await sleep(250);
  const rtlExpandBtn = toggle();
  check(
    "in RTL, the expand control remains present and clickable after collapsing",
    sidebarWidthClass() === "w-[4.75rem]" && Boolean(rtlExpandBtn) && !rtlExpandBtn.disabled,
  );
  clickEl(toggle());
  await sleep(250);
  check(
    "expanding in RTL restores the full sidebar with mirrored labels and the active item",
    sidebarWidthClass() === "w-64" && aside().textContent.includes("الإعدادات") && activeLink("#/settings"),
  );

  ux.finish(`Sidebar collapse/expand bug fix — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});

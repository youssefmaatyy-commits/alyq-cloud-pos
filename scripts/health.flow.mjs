/**
 * Health & Diagnostics — release identity, and who may read it (PR #23, blocker 3).
 *
 * The Health screen has to answer "which build is this?" — version, commit SHA,
 * build time and mode — in the existing authenticated Diagnostics surface, and
 * the answer has to be *safe*: four facts, no project URL, no anon key, no
 * service key, no JWT. This suite drives the real bundle in jsdom and proves
 * both halves of that sentence, plus the authorization around them:
 *
 *   1.  an anonymous visitor typing `#/dashboard/system-health` is sent to the
 *       login screen — no panel, and the build's commit SHA is nowhere in the
 *       document;
 *   2–3. the read-only `viewer` reaches the panel and its release card;
 *   4–7. the four facts render: version, commit SHA, build time, mode — the
 *       values the build inlined (never a network lookup);
 *   8.  the card is inert and clean: no link, image, iframe or input to click
 *       through to, and no URL / key / JWT shape anywhere in its markup;
 *   9–12. "Copy safe diagnostics" copies the same identity — the `release` block
 *       is exactly the four facts plus the dirty flag, and the whole copied JSON
 *       carries no credential shape;
 *   13–14. the `viewer`'s read access is not a hard-coded courtesy: an admin
 *       withholds `view_reports` through the real Settings → Users permission
 *       dialog, the live preview drops the final count, and the record is stored;
 *   15–17. the same person, next session, is refused the screen by the route
 *       guard — and the refusal shows no release identity either.
 *
 * Any console.error / window.onerror / network call fails the run.
 *
 *   node scripts/test.e2e.mjs health
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

/**
 * What `scripts/lib/app-bundle.mjs` inlines into the test bundle. Read from the
 * same environment with the same defaults, so this suite asserts the identity
 * contract rather than a copy of today's values.
 */
const EXPECTED = {
  version: process.env.VITE_APP_VERSION ?? "6.0.0",
  sha: process.env.VITE_BUILD_SHA ?? "test-bundle",
  builtAt: process.env.VITE_BUILD_TIME ?? new Date(0).toISOString(),
  mode: (process.env.VITE_APP_MODE ?? "").trim() || "demo",
};

const HEALTH = "#/dashboard/system-health";
const USERS = "#/dashboard/settings/users";
const STAFF_KEY = "alyq.identity.staff.v1";

/** Credential shapes the diagnostics surface must never carry. */
const CREDENTIAL_SHAPES = [
  [/https?:\/\//i, "a URL"],
  [/sb_(publishable|secret)_/i, "a Supabase key"],
  [/eyJ[A-Za-z0-9_-]{10,}\./, "a JWT"],
  [/service[_-]?role/i, "a service-role string"],
  [/anon[_-]?key/i, "an anon key"],
];
function credentialShape(text) {
  for (const [pattern, label] of CREDENTIAL_SHAPES) if (pattern.test(text)) return label;
  return null;
}

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
  },
});
const { assert, dom, bodyText, sleep, waitFor, navigate, routePath, clickEl, clickExact, testid, dialogs, signInAs } = ux;
const { document } = dom.window;

let passed = 0;
const TOTAL = 17;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}/${TOTAL} ${label}`);
}

const value = (id) => (testid(id)?.textContent ?? "").trim();
const releaseCard = () => testid("health-release");

async function main() {
  // ── 1 · an anonymous visitor typing the URL ───────────────────────────────
  await navigate(HEALTH, 700);
  await waitFor(() => routePath().startsWith("/login") || Boolean(testid("health-center")), {
    label: "the health route to resolve",
  });
  check(
    "an anonymous deep link to the health screen lands on the login screen, with no panel and no commit SHA",
    routePath().startsWith("/login") &&
      !testid("health-center") &&
      !testid("health-release") &&
      !bodyText().includes(EXPECTED.sha),
  );

  // ── 2–3 · the read-only seat opens the panel ──────────────────────────────
  await signInAs("viewer");
  await navigate(HEALTH, 700);
  await waitFor(() => Boolean(releaseCard()), { label: "the release card" });
  check("the viewer's session reaches the Health/Diagnostics panel", Boolean(testid("health-center")));
  check(
    "the panel carries the release card with its four facts",
    Boolean(releaseCard()) &&
      ["release-version", "release-sha", "release-built-at", "release-mode"].every((id) => Boolean(testid(id))),
  );

  // ── 4–7 · version, commit, build time, mode ───────────────────────────────
  check(`the version shown is the built version (${EXPECTED.version})`, value("release-version") === EXPECTED.version);
  check(`the commit SHA shown is the built SHA (${EXPECTED.sha})`, value("release-sha") === EXPECTED.sha);
  check(
    `the build time shown is the stamped ISO timestamp (${EXPECTED.builtAt})`,
    value("release-built-at") === EXPECTED.builtAt && !Number.isNaN(Date.parse(value("release-built-at"))),
  );
  check(
    `the mode shown is the mode the bundle was built for (${EXPECTED.mode})`,
    value("release-mode").startsWith(EXPECTED.mode),
  );

  // ── 8 · the card is inert, and carries no credential shape ────────────────
  const cardHtml = releaseCard().outerHTML;
  check(
    "the release card offers nothing to click through to and exposes no URL, key or JWT",
    releaseCard().querySelectorAll("a, img, iframe, input, form").length === 0 &&
      credentialShape(cardHtml) === null &&
      !/supabase/i.test(cardHtml),
  );

  // ── 9–12 · the copied diagnostics are the same four facts, and nothing else ─
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { copied = String(text); } },
  });
  clickExact("Copy safe diagnostics");
  await waitFor(() => copied.length > 0, { label: "the safe-diagnostics copy" });
  const diagnostics = JSON.parse(copied);
  check("copying the diagnostics produced a JSON document with a release block", Boolean(diagnostics.release));
  check(
    "the copied release block is exactly the four facts, read from the same build identity",
    JSON.stringify(diagnostics.release) ===
      JSON.stringify({
        version: EXPECTED.version,
        sha: EXPECTED.sha,
        built_at: EXPECTED.builtAt,
        mode: EXPECTED.mode,
        dirty: false,
      }),
  );
  check(
    "the copied release block has no field to put a URL or a key in",
    JSON.stringify(Object.keys(diagnostics.release).sort()) ===
      JSON.stringify(["built_at", "dirty", "mode", "sha", "version"]),
  );
  check(
    `the copied diagnostics carry no credential shape anywhere (found ${credentialShape(copied) ?? "none"})`,
    credentialShape(copied) === null,
  );

  // ── 13–14 · an admin withholds the capability the panel is gated on ───────
  await signInAs("admin");
  await navigate(USERS, 800);
  await waitFor(() => Boolean(document.querySelector("table tbody tr")), { label: "the users table" });
  const viewerRow = [...document.querySelectorAll("table tbody tr")].find((row) =>
    (row.textContent ?? "").includes("viewer"),
  );
  assert.ok(viewerRow, "the viewer account has a row in Settings → Users");
  const permissionsButton = [...viewerRow.querySelectorAll("button")].find((button) =>
    (button.getAttribute("title") ?? "").includes("Permissions"),
  );
  assert.ok(permissionsButton, "the row offers the Permissions (exceptions) dialog");
  clickEl(permissionsButton);
  await waitFor(() => dialogs().length > 0, { label: "the permission exceptions dialog" });
  const panel = dialogs().at(-1);
  const finalCount = () => {
    const match = (panel.textContent ?? "").match(/Final permissions:\s*(\d+)/);
    return match ? Number(match[1]) : NaN;
  };
  const before = finalCount();
  const denyReports = panel.querySelector("input#deny-view_reports");
  assert.ok(denyReports, "the dialog can withhold the report-view capability the health route asks for");
  clickEl(denyReports.closest("label"));
  await sleep(300);
  const after = finalCount();
  check(
    `withholding report access drops the previewed final permission count (${before} → ${after})`,
    Number.isFinite(before) && after === before - 1,
  );
  clickExact("Save", panel);
  await waitFor(() => dialogs().length === 0, { label: "the dialog to close after saving" });
  const staff = ux.readJson(STAFF_KEY) ?? [];
  const viewerEntry = staff.find((entry) => entry.username === "viewer");
  check(
    "the denial is persisted against the viewer's account, not merely toggled on screen",
    Boolean(viewerEntry) && (viewerEntry.denied_capabilities ?? []).includes("view_reports"),
  );

  // ── 15–17 · the same person, next session, is refused the screen ──────────
  await signInAs("viewer");
  await navigate(HEALTH, 800);
  await sleep(400);
  check("a session without the capability is refused the Health/Diagnostics screen", !testid("health-center"));
  check(
    "the refusal is the route guard's own copy, not a blank or broken screen",
    bodyText().includes("You do not have access to this screen"),
  );
  check(
    "the refusal exposes no release identity: no commit SHA, no version, no release card",
    !bodyText().includes(EXPECTED.sha) &&
      !bodyText().includes(EXPECTED.version) &&
      !releaseCard() &&
      !testid("release-sha"),
  );

  ux.finish(`Health/Diagnostics release identity + authorization — ${passed}/${TOTAL} checks`);
}

main().catch((error) => {
  console.error(`\n✗ ${error?.stack ?? error}`);
  process.exit(1);
});

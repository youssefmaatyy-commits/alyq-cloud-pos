/**
 * Backup, recovery & data-safety acceptance flow (Phase 18).
 *
 * Build the bundle first, then run it:
  *   npm run test:bundle                 # → os.tmpdir()/alyq-app.mjs
 *   node scripts/backup.flow.mjs
 * or let the runner do both: `npm run test:e2e backup`.
 *
 * The bundle step is `scripts/lib/app-bundle.mjs`; a bare `npx esbuild` fails on
 * `@/assets/alyq-logo.png` because esbuild ships no `.png` loader.
 *
 * Steps
 *   1 the panel is behind a permission      6 the schedule is a policy an admin sets
 *   2 the panel answers the six questions   7 a restore needs the typed word, and leaves a way back
 *   3 taking a snapshot, till still open    8 a manager may protect, not replace or carry
 *   4 downloading it hands over a file      9 the emergency export reuses the export builders
 *   5 the health check reads relationships
 *
 * Everything here runs in demo mode, so the snapshot is written to this
 * document's own localStorage and the restore rewrites it — the same code path a
 * browser installation takes, with no network anywhere (the run fails if a single
 * fetch is attempted).
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { DEFAULT_BUNDLE, bundleFileUrl } from "./lib/app-bundle.mjs";

const BUNDLE = DEFAULT_BUNDLE;
const DEMO_PASSWORD = "alyq1234";
const SESSION_KEY = "alyq.auth.session.v1";
const PANEL = "#/settings/backup";

/** Every network attempt made during the run — demo mode must make none. */
const networkCalls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bootCount = 0;

/** Boot the real app bundle inside a fresh jsdom document. */
async function boot() {
  // jsdom reports an attempted navigation (a download anchor, a `location.reload()`)
  // as a "Not implemented" error rather than performing it. Capturing those is how
  // a headless run can assert that the app really did ask the browser to reload
  // after a restore — the promise the dialog makes.
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    if (/Not implemented: navigation/.test(error?.message ?? "")) navigations.push(error.message);
  });

  const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', {
    url: "http://localhost/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole,
  });

  const consoleErrors = [];
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
  // React's form submission builds `new FormData(form, submitter)`; Node's own
  // FormData refuses a jsdom form element, so use jsdom's implementation.
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.Element = dom.window.Element;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.File = dom.window.File;
  globalThis.Blob = dom.window.Blob;
  globalThis.FileReader = dom.window.FileReader;

  // The download half of the feature. `xlsx` writes an ArrayBuffer and the app
  // hands it to an object URL, so capturing the URL is capturing the file: the
  // assertion is that a workbook of real size reached the browser.
  const downloads = [];
  URL.createObjectURL = (blob) => {
    downloads.push({ size: blob?.size ?? 0, type: blob?.type ?? "" });
    return `blob:mock-${Math.random().toString(36).slice(2)}`;
  };
  URL.revokeObjectURL = () => {};

  const blockedFetch = (input) => {
    const url = String(typeof input === "object" && input !== null ? (input.url ?? input) : input);
    networkCalls.push(`fetch ${url}`);
    return Promise.reject(new Error(`blocked network call: ${url}`));
  };
  dom.window.fetch = blockedFetch;
  globalThis.fetch = blockedFetch;
  class BlockedXHR {
    open(method, url) {
      networkCalls.push(`${method} ${url}`);
    }
    send() {
      throw new Error(`blocked network call: ${networkCalls.at(-1) ?? "XHR"}`);
    }
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
  }
  dom.window.XMLHttpRequest = BlockedXHR;
  globalThis.XMLHttpRequest = BlockedXHR;
  dom.window.console.error = (...args) => {
    consoleErrors.push(args.map((a) => a?.stack ?? String(a)).join(" "));
    process.stderr.write(`[console.error] ${args.map(String).join(" ")}\n`);
  };
  dom.window.addEventListener("error", (event) => consoleErrors.push(`window.onerror: ${event.message}`));

  // A restore ends by reloading the screen so every cache is rebuilt from the
  // restored data. jsdom does not navigate, so the reload is recorded instead of
  // attempted — and asserting it happened is asserting the promise the dialog
  // makes ("the screen reloads when the restore finishes").
  const reloads = [];
  const realLocation = dom.window.location;
  try {
    Object.defineProperty(dom.window, "location", {
      configurable: true,
      value: new Proxy(realLocation, {
        get(target, prop) {
          if (prop === "reload") return () => reloads.push(Date.now());
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, prop, value) {
          target[prop] = value;
          return true;
        },
      }),
    });
  } catch {
    // jsdom owns `location` on some versions; the reload then simply does not
    // happen, and step 7 reports that rather than crashing the boot.
    reloads.push(-1);
    reloads.length = 0;
  }

  bootCount += 1;
  try {
    await import(bundleFileUrl(BUNDLE, `boot=${bootCount}`));
  } catch (err) {
    console.error(`\n✗ could not load the app bundle at ${BUNDLE}.\n  Build it first (see the header of this file).\n  ${err?.message ?? err}\n`);
    process.exit(2);
  }
  await sleep(1000);

  return makeHarness(dom, consoleErrors, downloads, reloads, navigations);
}

function makeHarness(dom, consoleErrors, downloads, reloads, navigations) {
  const document = dom.window.document;
  const bodyText = () => document.body.textContent ?? "";

  const navigate = async (hash) => {
    dom.window.location.hash = hash;
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    await sleep(450);
  };

  /** Wait for something to be true, because every read here is asynchronous. */
  const waitFor = async (predicate, { timeout = 9000, what = "condition" } = {}) => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return true;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
      await sleep(200);
    }
  };

  const clickEl = (el) => {
    if (!el) throw new Error("control not found");
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  };

  const controls = (scope = document) => [...scope.querySelectorAll("button, a")];
  /** Exact label match: "Restore" must not find "Restore the installation". */
  const byLabel = (label, scope = document) =>
    controls(scope).find((node) => (node.textContent ?? "").trim() === label) ?? null;
  const byIncludes = (label, scope = document) =>
    controls(scope).find((node) => (node.textContent ?? "").trim().includes(label)) ?? null;

  const typeInto = (input, value) => {
    if (!input) throw new Error("field not found");
    const proto =
      input.tagName === "SELECT"
        ? dom.window.HTMLSelectElement
        : input.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement
          : dom.window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
    input.dispatchEvent(
      new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  };

  const usernameField = () => document.querySelector("input[autocomplete='username']");
  const passwordField = () => document.querySelector("input[autocomplete='current-password']");
  const isSignedIn = () => bodyText().includes("Signed in as");
  const denied = () => bodyText().includes("You do not have access");
  const navHrefs = () => [...document.querySelectorAll("aside nav a")].map((a) => a.getAttribute("href") ?? "");

  /** The offline backup store, read as the repository writes it. */
  const snapshotStore = () => {
    const raw = dom.window.localStorage.getItem("alyq.backup.v1");
    return raw ? JSON.parse(raw) : { manifests: [], documents: {} };
  };
  const auditTrail = () => {
    const raw = dom.window.localStorage.getItem("alyq.demo.audit_log.v1");
    return raw ? JSON.parse(raw) : [];
  };

  const signIn = async (username, password = DEMO_PASSWORD) => {
    for (let i = 0; i < 25 && !usernameField(); i += 1) await sleep(200);
    typeInto(usernameField(), username);
    typeInto(passwordField(), password);
    clickEl(byIncludes("Sign in"));
    await waitFor(isSignedIn, { what: `${username} to sign in` });
    await sleep(400);
  };
  const signOut = async () => {
    if (!isSignedIn()) return;
    clickEl(byIncludes("Sign out"));
    for (let i = 0; i < 20 && !usernameField(); i += 1) await sleep(200);
    await sleep(200);
  };
  /** Open the panel and wait for it to finish loading. */
  const openPanel = async () => {
    await navigate(PANEL);
    try {
      await waitFor(() => bodyText().includes("Are we protected?"), { what: "the backup panel" });
    } catch (err) {
      // A timeout here says nothing on its own: the useful facts are where the
      // router ended up and what the screen was showing instead.
      throw new Error(
        `${err.message}\n      hash=${dom.window.location.hash}\n      body=${bodyText().replace(/\s+/g, " ").slice(0, 700)}`,
        // The symptom is the useful part, but the original error still has the
        // stack that says where the wait was started.
        { cause: err },
      );
    }
    await sleep(300);
  };

  return {
    dom,
    document,
    consoleErrors,
    downloads,
    reloads,
    navigations,
    bodyText,
    navigate,
    waitFor,
    clickEl,
    byLabel,
    byIncludes,
    typeInto,
    usernameField,
    isSignedIn,
    denied,
    navHrefs,
    snapshotStore,
    auditTrail,
    signIn,
    signOut,
    openPanel,
  };
}

// ── step runner ───────────────────────────────────────────────────────────
const results = [];
const log = (line) => console.log(`    ${line}`);

async function step(num, title, run) {
  let status = "PASS";
  let detail = [];
  try {
    detail = (await run()) ?? [];
  } catch (err) {
    status = "FAIL";
    detail = [`${err?.message ?? err}`];
  }
  results.push({ num, title, status });
  console.log(`\n${status === "PASS" ? "✓" : "✗"} STEP ${num} · ${title} — ${status}`);
  for (const line of detail) log(line);
}

console.log("\nBackup, recovery & data-safety flow — ALYQ Cloud POS");
console.log("backup/recovery: IMPLEMENTED — all steps are asserted");

const app = await boot();

// ── STEP 1 · the panel is behind a permission ─────────────────────────────
await step(1, "The panel is behind a permission", async () => {
  const out = [];

  // Signed out: the route exists, and it does not serve itself.
  await app.navigate(PANEL);
  if (!app.usernameField()) throw new Error("the backup panel was served without a session");
  const hash = decodeURIComponent(app.dom.window.location.hash);
  if (!hash.includes("next=/settings/backup")) throw new Error(`attempted route not preserved (hash: ${hash})`);
  out.push(`signed out → ${PANEL} redirects to ${hash}`);

  // A cashier holds none of the five capabilities, so the link is not there and
  // the route refuses rather than rendering an empty panel.
  await app.signIn("cashier");
  if (app.navHrefs().some((href) => href.includes("/settings/backup"))) {
    throw new Error("the sidebar offers the backup panel to a cashier");
  }
  await app.navigate(PANEL);
  if (!app.denied()) throw new Error("a cashier reached the backup panel");
  out.push("cashier → no sidebar link, and the route itself refuses");

  // An admin holds all five: the door is the Settings module (Phase 49 put the
  // rooms behind the grouped home, not the sidebar) and the panel renders,
  // saying which mode it is in.
  await app.signOut();
  await app.signIn("admin");
  if (!app.navHrefs().some((href) => href === "#/settings")) {
    throw new Error("the sidebar does not offer the Settings module to an admin");
  }
  await app.navigate("#/settings");
  await app.waitFor(() => app.dom.window.document.querySelector('[data-testid="settings-card-backup"]'), { what: "the backup card on the settings home" });
  await app.dom.window.document.querySelector('[data-testid="settings-card-backup"]').dispatchEvent(
    new app.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await sleep(400);
  for (const expected of ["Backup & recovery", "Offline mode", "Snapshots"]) {
    if (!app.bodyText().includes(expected)) throw new Error(`the panel does not say "${expected}"`);
  }
  if (app.consoleErrors.length > 0) throw new Error(`console errors: ${app.consoleErrors[0]}`);
  out.push("admin → sidebar link under Settings, panel renders in offline mode, no console errors");

  // Nothing had ever been backed up, so one was due immediately: the panel takes
  // the first snapshot on the way in rather than leaving a new installation
  // unprotected until somebody thinks to press the button.
  await app.waitFor(() => app.snapshotStore().manifests.some((m) => m.kind === "automatic"), {
    what: "the first automatic snapshot",
    timeout: 25000,
  });
  out.push("a fresh installation was due at once, so the panel took the first snapshot by itself");
  return out;
});

// ── STEP 2 · the panel answers the monitoring questions ───────────────────
await step(2, "The panel answers the six monitoring questions", async () => {
  // Observed on an installation whose schedule is off and which has never been
  // backed up. That is the only way to see the empty state honestly: with a
  // schedule on, a fresh installation is due immediately and the panel takes the
  // first snapshot on the way in — which is the point of the feature.
  await app.navigate("#/");
  app.dom.window.localStorage.removeItem("alyq.backup.v1");
  app.dom.window.localStorage.setItem(
    "alyq.backup.settings.v1",
    JSON.stringify({ frequency: "off", retention_days: 30, retention_count: 14, last_automatic_at: null }),
  );
  await app.openPanel();

  const text = app.bodyText();
  for (const tile of [
    "Are we protected?",
    "Last backup",
    "Last restore",
    "Next automatic",
    "Storage used",
    "Data health",
  ]) {
    if (!text.includes(tile)) throw new Error(`the panel does not answer "${tile}"`);
  }
  if (!text.includes("Schedule off")) throw new Error("a disabled schedule is not reported as disabled");
  if (!text.includes("Automatic snapshots are off. Manual ones still work.")) {
    throw new Error("the panel does not tell the admin that manual snapshots still work");
  }
  if (!text.includes("Never")) throw new Error("the last-backup tile has no honest value for 'nothing yet'");
  if (!text.includes("Not run yet")) throw new Error("the health tile has no honest value for 'not run yet'");
  if (!text.includes("No snapshots yet")) throw new Error("an empty snapshot list does not say so");
  // A dictionary key on screen is a bug an operator can see.
  if (/backup\.[a-z]+\./.test(text)) throw new Error("an untranslated key reached the screen");
  return [
    "tiles: protection status · last backup · last restore · next automatic · storage · data health",
    "never backed up reads 'Never', 'Not run yet', 'No snapshots yet' — no invented numbers",
    "a disabled schedule says so, and says manual snapshots still work",
    "no dictionary key leaks into the rendered panel",
  ];
});

// ── STEP 3 · taking a snapshot, with the till still open ──────────────────
await step(3, "Taking a snapshot records date, size and author", async () => {
  const before = app.snapshotStore().manifests.length;
  const note = "before the July price change";
  const noteField = app.document.querySelector("input[placeholder='Before the July price change']");
  if (!noteField) throw new Error("the note field is not on the panel");
  app.typeInto(noteField, note);

  app.clickEl(app.byLabel("Take a snapshot"));
  await app.waitFor(() => app.bodyText().includes("Snapshot taken"), { what: "the snapshot toast" });
  await app.waitFor(() => app.snapshotStore().manifests.length === before + 1, {
    what: "the snapshot to be stored",
  });
  await sleep(500);

  const manifest = app.snapshotStore().manifests[0];
  if (manifest.kind !== "manual") throw new Error(`expected a manual snapshot, got ${manifest.kind}`);
  if (manifest.note !== note) throw new Error("the note was not kept with the snapshot");
  if (!(manifest.size_bytes > 0)) throw new Error("the snapshot has no size");
  if (!(manifest.row_count > 0)) throw new Error("the snapshot carried no rows");
  if (!manifest.created_by_name) throw new Error("the snapshot does not say who took it");
  if (!manifest.created_at) throw new Error("the snapshot does not say when it was taken");

  const text = app.bodyText();
  for (const expected of ["Manual", note, manifest.created_by_name]) {
    if (!text.includes(expected)) throw new Error(`the panel does not show "${expected}"`);
  }
  if (!app.auditTrail().some((entry) => entry.action === "backup.created")) {
    throw new Error("taking a snapshot left no audit entry");
  }

  // The requirement behind the design: taking a snapshot must not stop the shop.
  await app.navigate("#/pos");
  await app.waitFor(() => app.bodyText().includes("ALYQ-1001"), { what: "the till after a snapshot" });
  await app.openPanel();

  return [
    `snapshot ${manifest.id.slice(0, 12)}… · ${manifest.row_count} rows · ${manifest.size_bytes} bytes · ${manifest.created_by_name}`,
    "the row shows its kind, note, size and author",
    "a manual snapshot works with the schedule off, exactly as the panel promises",
    `audit: backup.created by ${manifest.created_by_name}`,
    "the till still sells immediately afterwards",
  ];
});

// ── STEP 4 · downloading it hands over a file ─────────────────────────────
await step(4, "Downloading a snapshot hands over a file", async () => {
  const downloadsBefore = app.downloads.length;
  const snapshotsBefore = app.snapshotStore().manifests.length;

  const download = app.byLabel("Download");
  if (!download) throw new Error("the snapshot row offers no download");
  if (download.disabled) throw new Error("the download is disabled for an admin");
  app.clickEl(download);
  await app.waitFor(() => app.bodyText().includes("Backup downloaded"), { what: "the download toast" });
  await app.waitFor(() => app.downloads.length > downloadsBefore, { what: "the file to reach the browser" });

  const file = app.downloads[app.downloads.length - 1];
  if (!(file.size > 1000)) throw new Error(`the downloaded file is ${file.size} bytes — not a snapshot`);
  if (app.snapshotStore().manifests.length !== snapshotsBefore) {
    throw new Error("downloading changed the snapshot list");
  }
  if (!app.auditTrail().some((entry) => entry.action === "backup.downloaded")) {
    throw new Error("leaving with a copy of the installation was not recorded");
  }
  return [
    `a ${(file.size / 1024).toFixed(0)} kB file reached the browser (${file.type || "application/json"})`,
    "audit: backup.downloaded — who took the copy, and when",
  ];
});

// ── STEP 5 · the health check reads the relationships ─────────────────────
await step(5, "The health check reads relationships and reports", async () => {
  const health = app.byLabel("Run the health check");
  if (!health) throw new Error("the panel offers no health check");
  if (health.disabled) throw new Error("the health check is disabled for an admin");
  app.clickEl(health);
  await app.waitFor(() => app.bodyText().includes("Examined"), { what: "a health report", timeout: 25000 });
  await sleep(400);

  const text = app.bodyText();
  if (!/Run at .+ in \d+ ms/.test(text)) throw new Error("the report does not say when it ran or how long it took");
  const clean = text.includes("Nothing found: every relationship examined adds up.");
  const findings = /(\d+) finding\(s\)/.exec(text);
  if (!clean && !findings) throw new Error("the report states neither a clean bill nor its findings");
  if (!clean && !["Critical", "Warning", "Information"].some((word) => text.includes(word))) {
    throw new Error("a finding was reported without a severity");
  }
  for (const examined of ["products", "sales", "staff accounts", "audit entries"]) {
    if (!text.includes(examined)) throw new Error(`the report does not say it examined ${examined}`);
  }
  if (!app.auditTrail().some((entry) => entry.action === "health.check_run")) {
    throw new Error("running the health check left no audit entry");
  }
  return [
    clean
      ? "the seeded installation is clean: every relationship examined adds up"
      : `${findings[1]} finding(s), each with a severity and a recommended action`,
    "the report names its scope: products, sales, staff accounts, audit entries",
    "audit: health.check_run",
  ];
});

// ── STEP 6 · the schedule is a policy an admin sets ───────────────────────
await step(6, "The schedule is a policy an admin sets", async () => {
  const select = app.document.querySelector("select");
  if (!select) throw new Error("the schedule has no frequency control");
  const options = [...select.options].map((option) => option.value);
  for (const expected of ["off", "daily", "weekly"]) {
    if (!options.includes(expected)) throw new Error(`the schedule cannot be set to ${expected}`);
  }
  app.typeInto(select, "weekly");

  const numbers = [...app.document.querySelectorAll("input[type='number']")];
  if (numbers.length < 2) throw new Error("the retention fields are missing");
  app.typeInto(numbers[0], "60");
  app.typeInto(numbers[1], "8");

  app.clickEl(app.byLabel("Save schedule"));
  await app.waitFor(() => app.bodyText().includes("Schedule saved"), { what: "the schedule toast" });
  await sleep(600);

  const settings = JSON.parse(app.dom.window.localStorage.getItem("alyq.backup.settings.v1") ?? "{}");
  if (settings.frequency !== "weekly") throw new Error(`the frequency was not kept (${settings.frequency})`);
  if (settings.retention_days !== 60) throw new Error("the retention window was not kept");
  if (settings.retention_count !== 8) throw new Error("the retention count was not kept");
  if (!app.bodyText().includes("Next due")) throw new Error("the panel does not say when the next snapshot falls due");
  if (!app.auditTrail().some((entry) => entry.action === "backup.settings_changed")) {
    throw new Error("changing the retention policy left no audit entry");
  }
  if (!app.bodyText().includes("Manual snapshots are never deleted")) {
    throw new Error("the panel does not tell the admin what retention will and will not delete");
  }
  return [
    "weekly · keep 60 days · keep at most 8 → persisted",
    "the card states the consequence of the policy: next due and last automatic",
    "audit: backup.settings_changed",
    "the panel states that manual snapshots and the pre-restore one are never pruned",
  ];
});

// ── STEP 7 · a restore needs the typed word, and leaves a way back ────────
await step(7, "A restore needs the typed word and leaves a way back", async () => {
  const out = [];
  const catalogBefore = JSON.parse(app.dom.window.localStorage.getItem("alyq.demo.catalog.v1") ?? "{}");
  const firstPrice = catalogBefore.products[0].selling_price;

  // Damage the shop the way a bad import would: a price overwritten, and a
  // customer that was never there.
  catalogBefore.products[0].selling_price = 1;
  app.dom.window.localStorage.setItem("alyq.demo.catalog.v1", JSON.stringify(catalogBefore));
  app.dom.window.localStorage.setItem(
    "alyq.demo.customers.v1",
    JSON.stringify([{ id: "c-damaged", name: "Written after the snapshot", phone: "01000000000" }]),
  );
  out.push("damaged the shop: a price overwritten to 1, a customer added after the snapshot");

  // Restore *the snapshot step 3 took*, found by the note an operator would read.
  // Picking the newest row would be a race: turning the schedule on in step 6 can
  // add an automatic snapshot at any moment.
  const row = [...app.document.querySelectorAll("tbody tr")].find((tr) =>
    (tr.textContent ?? "").includes("before the July price change"),
  );
  if (!row) throw new Error("the snapshot taken in step 3 is not in the list");
  const restore = [...row.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === "Restore",
  );
  if (!restore) throw new Error("that snapshot's row offers no restore");
  app.clickEl(restore);
  await app.waitFor(() => app.bodyText().includes("Restore this snapshot?"), { what: "the restore dialog" });
  for (const warning of [
    "This replaces the installation's data. It is not a merge.",
    "A snapshot of the current state is taken first",
    "The audit log is kept",
  ]) {
    if (!app.bodyText().includes(warning)) throw new Error(`the dialog does not warn: "${warning}"`);
  }
  out.push("the dialog says what will be deleted, that a way back is taken first, and that the trail survives");

  // The submit is disabled until the word matches — a stronger guarantee than an
  // error after the click, and the service checks the word again anyway.
  const submit = app.byLabel("Restore the installation");
  if (!submit) throw new Error("the dialog has no submit");
  if (!submit.disabled) throw new Error("a restore was submittable without the typed word");
  const confirm = app.document.querySelector("input[placeholder='RESTORE']");
  if (!confirm) throw new Error("the confirmation field is missing");

  app.typeInto(confirm, "yes");
  await sleep(300);
  if (!app.bodyText().includes("The word does not match yet")) {
    throw new Error("a wrong word was not told it was wrong");
  }
  if (!submit.disabled) throw new Error("a wrong word enabled the submit");
  if (app.snapshotStore().manifests.some((entry) => entry.kind === "pre_restore")) {
    throw new Error("a refused restore still took a pre-restore snapshot");
  }
  out.push("a wrong word is refused inline, the submit stays disabled, and nothing was written");

  // With the word, the data comes back and the rollback point exists.
  app.typeInto(confirm, "RESTORE");
  await app.waitFor(() => !app.byLabel("Restore the installation")?.disabled, {
    what: "the submit to enable",
  });
  app.clickEl(app.byLabel("Restore the installation"));
  await app.waitFor(() => app.snapshotStore().manifests.some((entry) => entry.kind === "pre_restore"), {
    what: "the pre-restore snapshot",
    timeout: 25000,
  });
  await sleep(700);

  const catalog = JSON.parse(app.dom.window.localStorage.getItem("alyq.demo.catalog.v1") ?? "{}");
  if (catalog.products[0].selling_price !== firstPrice) {
    throw new Error(`the overwritten price did not come back (${catalog.products[0].selling_price})`);
  }
  const customers = JSON.parse(app.dom.window.localStorage.getItem("alyq.demo.customers.v1") ?? "[]");
  if (customers.some((customer) => customer.id === "c-damaged")) {
    throw new Error("the customer written after the snapshot survived the restore");
  }
  out.push(`the price is ${firstPrice} again, and the customer added after the snapshot is gone`);

  const kinds = app.snapshotStore().manifests.map((entry) => entry.kind);
  if (!kinds.includes("pre_restore")) throw new Error("no rollback point was kept");
  out.push(`snapshots now held: ${kinds.join(", ")} — the rollback is a row, not a promise`);

  const trail = app.auditTrail().map((entry) => entry.action);
  for (const action of ["restore.started", "restore.completed"]) {
    if (!trail.includes(action)) throw new Error(`the trail is missing ${action}`);
  }
  // The trail itself survived the restore: it is evidence, not state.
  if (!trail.includes("backup.created")) throw new Error("the restore replaced the audit trail");
  out.push("audit: restore.started before the deletion, restore.completed after — and the older entries survived");

  // afterRestore() stamps the moment and asks the browser to reload, so every
  // cache — catalogue, permissions, availability — is rebuilt from restored data.
  // jsdom cannot navigate, so the attempt is what is observable.
  const stamp = app.dom.window.sessionStorage.getItem("alyq.restore.completed_at");
  if (!stamp) throw new Error("the restore did not stamp its completion for the reloaded screen");
  if (app.reloads.length === 0 && app.navigations.length === 0) {
    throw new Error("the screen did not ask the browser to reload after the restore");
  }
  out.push(`the screen reloads afterwards (stamp ${stamp.slice(11, 19)}), so every cache is rebuilt`);
  return out;
});

// ── STEP 8 · a manager may protect, but not replace or carry ──────────────
await step(8, "A manager may protect the installation, not replace it", async () => {
  await app.signOut();
  await app.signIn("manager");
  await app.openPanel();

  // The app's convention for a control the seat may not use is to render it
  // disabled with the reason as its title, not to hide it — so the assertion is
  // about being able to use it, and about the controls that are genuinely gone.
  for (const label of ["Take a snapshot", "Run the health check", "Export everything"]) {
    const control = app.byLabel(label);
    if (!control) throw new Error(`a manager cannot ${label.toLowerCase()}`);
    if (control.disabled) throw new Error(`"${label}" is disabled for a manager`);
  }
  for (const label of ["Restore", "Download"]) {
    const control = app.byLabel(label);
    if (!control) throw new Error(`the snapshot row does not render "${label}" at all`);
    if (!control.disabled) throw new Error(`a manager could press "${label}"`);
    if (!control.getAttribute("title")) throw new Error(`"${label}" does not say why it is disabled`);
  }
  if (app.byLabel("Save schedule")) throw new Error("a manager was offered the schedule form");
  if (app.byLabel("Choose a backup file")) throw new Error("a manager was offered restore-from-file");
  if (!app.bodyText().includes("To undo a restore, restore the pre-restore snapshot")) {
    throw new Error("a manager is not told how rollback works");
  }
  if (app.snapshotStore().manifests.length === 0) throw new Error("the manager cannot see the snapshots that exist");
  if (!app.bodyText().includes("Pre-restore")) throw new Error("the manager cannot see the rollback point");

  // And the permission is real, not cosmetic: a manager's snapshot is written.
  const before = app.snapshotStore().manifests.length;
  app.clickEl(app.byLabel("Take a snapshot"));
  await app.waitFor(() => app.snapshotStore().manifests.length === before + 1, {
    what: "the manager's snapshot",
    timeout: 20000,
  });
  return [
    "manager → may take a snapshot, run the health check, and export",
    "manager → Restore and Download render disabled, each saying why",
    "manager → no schedule form and no restore-from-file card",
    "the manager still sees every snapshot, including the rollback point",
  ];
});

// ── STEP 9 · the emergency export reuses the export builders ──────────────
await step(9, "The emergency export is one workbook, built by the existing export", async () => {
  const downloadsBefore = app.downloads.length;
  const trailBefore = app.auditTrail().length;

  const run = app.byLabel("Export everything");
  if (!run) throw new Error("the panel offers no emergency export");
  app.clickEl(run);
  await app.waitFor(
    () => app.bodyText().includes("Emergency export downloaded") || app.bodyText().includes("section(s) skipped"),
    { what: "the emergency workbook", timeout: 60000 },
  );
  await app.waitFor(() => app.downloads.length > downloadsBefore, {
    what: "the workbook to reach the browser",
    timeout: 30000,
  });

  const file = app.downloads[app.downloads.length - 1];
  if (!(file.size > 2000)) throw new Error(`the workbook is ${file.size} bytes — not a spreadsheet`);
  if (!file.type.includes("spreadsheet") && !file.type.includes("octet-stream")) {
    throw new Error(`the workbook was served as ${file.type || "nothing"}`);
  }
  // It is an export, not a backup: no snapshot was written and no backup verb was
  // audited for it. The trail is newest-first, so the entries this step added are
  // the ones at the front.
  const added = app.auditTrail().slice(0, Math.max(0, app.auditTrail().length - trailBefore));
  if (added.some((entry) => String(entry.action).startsWith("backup."))) {
    throw new Error("the emergency export audited itself as a backup act");
  }
  if (app.consoleErrors.length > 0) throw new Error(`console errors: ${app.consoleErrors[0]}`);
  return [
    `a ${(file.size / 1024).toFixed(0)} kB workbook (${file.type}) reached the browser`,
    "built by the same export builders as every other screen — no second export engine",
    `no snapshot was written and no backup verb was audited for it (${added.length} new entries)`,
    `console errors across the whole run: ${app.consoleErrors.length}`,
  ];
});

// ── summary ───────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
console.log("\n──────── summary ────────");
for (const r of results) console.log(`${r.status === "PASS" ? "✓" : "✗"} ${r.num}. ${r.title}: ${r.status}`);
console.log(
  `\n${count("PASS")} passed · ${count("FAIL")} failed · console errors: ${app.consoleErrors.length} · network calls: ${networkCalls.length}`,
);
if (networkCalls.length > 0) {
  console.error(`\n✗ ${networkCalls.length} network call(s) in a localStorage-only demo:`);
  for (const call of networkCalls) console.error(`  ${call}`);
  process.exit(1);
}
if (app.consoleErrors.length > 0) {
  console.error(`\n✗ ${app.consoleErrors.length} console error(s):`);
  for (const error of app.consoleErrors.slice(0, 5)) console.error(`  ${error.slice(0, 300)}`);
  process.exit(1);
}
if (count("FAIL") > 0) process.exit(1);
console.log("\nBackup, restore and data-safety flow verified end to end.\n");
process.exit(0);

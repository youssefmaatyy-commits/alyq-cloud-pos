#!/usr/bin/env node
/**
 * Windows-runner smoke check for an already-installed ALYQ Electron build.
 * Connects to that process over loopback-only Chromium DevTools Protocol; it
 * never signs in, creates an order, or accesses a Supabase write path.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const port = Number(args.get("port"));
const expectedVersion = args.get("version");
assert.ok(Number.isInteger(port) && port > 0, "provide --port=<local-debug-port>");
assert.ok(expectedVersion, "provide --version=<expected-app-version>");

const seedStorageSentinel = args.get("seed-storage-sentinel");
const expectedStorageSentinel = args.get("expect-storage-sentinel");
assert.ok(!(seedStorageSentinel && expectedStorageSentinel), "storage sentinel cannot be seeded and expected in one pass");
for (const value of [seedStorageSentinel, expectedStorageSentinel]) {
  if (value) assert.match(value, /^[0-9a-f-]{36}$/i, "storage sentinel must be an isolated test GUID");
}

/**
 * Writes or reads non-business sentinels in the installed app's real Chromium
 * profile. A separate database avoids manufacturing offline sales or touching
 * the POS outbox while still proving that IndexedDB survives the NSIS upgrade.
 */
async function verifyStorageSentinel(page, seedValue = null) {
  return page.evaluate(async ({ seedValue: value }) => {
    const localStorageKey = "alyq.windows-upgrade.sentinel.v1";
    const databaseName = "alyq-windows-upgrade-sentinel";
    const storeName = "records";
    const recordKey = "upgrade";
    if (value) window.localStorage.setItem(localStorageKey, value);

    const database = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName, { keyPath: "id" });
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to open the isolated storage-sentinel database"));
      request.onsuccess = () => resolve(request.result);
    });

    let indexedDBValue;
    if (value) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put({ id: recordKey, value });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to write the IndexedDB sentinel"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB sentinel transaction aborted"));
      });
      indexedDBValue = value;
    } else {
      const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(recordKey);
        request.onerror = () => reject(request.error ?? new Error("Unable to read the IndexedDB sentinel"));
        request.onsuccess = () => resolve(request.result);
      });
      indexedDBValue = record?.value;
    }
    database.close();
    return {
      localStorage: window.localStorage.getItem(localStorageKey),
      indexedDB: indexedDBValue,
    };
  }, { seedValue });
}

const deadline = Date.now() + 45_000;
let browser;
let lastError;
while (!browser && Date.now() < deadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 });
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
assert.ok(browser, `could not connect to the installed desktop app on loopback port ${port}: ${lastError}`);
try {
  let page;
  let observedUrls = [];
  const pageDeadline = Date.now() + 30_000;
  while (!page && Date.now() < pageDeadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    observedUrls = pages.map((candidate) => candidate.url());
    page = pages.find((candidate) => candidate.url().startsWith("file:"));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(page, `the installed app did not open a packaged file:// renderer; observed pages: ${observedUrls.join(", ") || "none"}`);
  const allowMissingApi = args.has("allow-missing-desktop-api");
  const legacyBaseline = allowMissingApi && expectedVersion === "6.0.0";
  let url = new URL(page.url());
  if (legacyBaseline && url.hash === "") {
    // The archived 6.0.0 build opens the renderer without a router hash; visit
    // its real login route locally rather than relying on the newer startup URL.
    await page.evaluate(() => { window.location.hash = "#/login"; });
  }
  await page.waitForFunction(() => document.readyState === "complete" && Boolean(document.body?.innerText?.trim()), null, { timeout: 20_000 });
  url = new URL(page.url());
  if (legacyBaseline) {
    assert.equal(url.hash, "#/login", "legacy 6.0.0 login route must render when opened locally");
  } else {
    assert.equal(url.hash, "#/login", "installed app must start on the employee login route");
  }
  const body = (await page.locator("body").innerText()).toLocaleLowerCase();
  assert.ok(/sign in|تسجيل الدخول|دخول/.test(body),
    `the installed screen must be the real employee login UI (title=${JSON.stringify(await page.title())}, body=${JSON.stringify(body.slice(0, 600))})`);

  const storageValue = seedStorageSentinel ?? expectedStorageSentinel;
  if (storageValue) {
    const stored = await verifyStorageSentinel(page, seedStorageSentinel ?? null);
    assert.deepEqual(stored, { localStorage: storageValue, indexedDB: storageValue },
      seedStorageSentinel
        ? "isolated localStorage/IndexedDB sentinels could not be seeded in 6.0.0"
        : "localStorage/IndexedDB sentinels did not survive the installed-app upgrade");
    console.log(seedStorageSentinel
      ? "Seeded isolated localStorage and IndexedDB sentinels in the installed 6.0.0 Chromium profile."
      : "Installed-app storage preservation passed: localStorage and IndexedDB sentinels survived the upgrade.");
  }

  let desktopApiReady = await page.evaluate(() => Boolean(window.alyqDesktop?.getContext && window.alyqDesktop?.getConfig));
  if (!desktopApiReady) {
    try {
      await page.waitForFunction(() => Boolean(window.alyqDesktop?.getContext && window.alyqDesktop?.getConfig), null, {
        timeout: allowMissingApi ? 5_000 : 20_000,
      });
      desktopApiReady = true;
    } catch (error) {
      if (!allowMissingApi) {
        const title = await page.title();
        throw new Error(`packaged desktop preload API was not exposed (title=${JSON.stringify(title)}, login UI is visible): ${error.message}`, { cause: error });
      }
    }
  }
  if (!desktopApiReady) {
    console.log(`Installed legacy-app smoke passed: version=${expectedVersion}, route=${url.hash}, packaged login UI visible; this archived build exposes no desktop preload API.`);
  } else {
    const context = await page.evaluate(() => window.alyqDesktop.getContext());
    assert.equal(context?.runtime, "electron", "renderer must be running inside Electron");
    assert.equal(context?.packaged, true, "app must be the installed/packaged executable");
    assert.equal(context?.version, expectedVersion, "installed executable version did not match");
    let config = await page.evaluate(() => window.alyqDesktop.getConfig());
    assert.ok(/^[0-9a-f-]{36}$/i.test(config?.installationId ?? ""), "desktop userData config must initialize a valid installation identity");
    assert.equal(config.installationId, context.installationId, "app context and userData must expose the same installation identity");
    assert.ok(config?.hardware && Number.isFinite(config.hardware.paperWidthMm), "desktop hardware defaults must load from userData");
    const expectedConfigPath = args.get("expect-config");
    if (expectedConfigPath) {
      const expectedConfig = JSON.parse(await readFile(expectedConfigPath, "utf8"));
      assert.equal(config.installationId, expectedConfig.installationId, "desktop installation identity changed during upgrade");
      assert.deepEqual(config.hardware, expectedConfig.hardware, "one or more printer/drawer settings changed during upgrade");
      console.log("Installed-app configuration preservation passed: installation identity and the complete hardware configuration match 6.0.0.");
    }
    if (args.has("seed-paper-width")) {
      const paperWidthMm = Number(args.get("seed-paper-width"));
      assert.ok([58, 80].includes(paperWidthMm), "seeded paper width must be a supported hardware setting");
      const hardware = { ...config.hardware, paperWidthMm };
      await page.evaluate((value) => window.alyqDesktop.saveHardwareConfig(value), hardware);
      config = await page.evaluate(() => window.alyqDesktop.getConfig());
      assert.equal(config.hardware.paperWidthMm, paperWidthMm, "isolated custom printer setting must persist before upgrade");
    }
    if (args.has("expect-paper-width")) {
      assert.equal(config.hardware.paperWidthMm, Number(args.get("expect-paper-width")), "custom hardware setting did not survive installer upgrade");
    }
    console.log(`Installed-app smoke passed: version=${context.version}, route=${url.hash}, packaged=${context.packaged}, paperWidthMm=${config.hardware.paperWidthMm}`);
  }
} finally {
  await browser.close();
}

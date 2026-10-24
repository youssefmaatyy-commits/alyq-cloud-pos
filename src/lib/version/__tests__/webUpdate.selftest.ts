import assert from "node:assert/strict";
import {
  checkForWebUpdate,
  dismissUpdate,
  isUpdateDismissed,
  clearDismissedUpdate,
} from "../webUpdate";
import { parseManifest } from "../manifest";

// Mock sessionStorage for Node environment
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  },
  dispatchEvent: () => true,
} as unknown as Window;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`✓ ${name}`);
}

// ── parseManifest ─────────────────────────────────────────────────────────
await test("parseManifest accepts a valid manifest", () => {
  const raw = {
    schemaVersion: 1,
    appName: "ALYQ POS",
    current: { version: "6.2.0", gitSha: "abc123", releasedAt: "2026-10-24T00:00:00Z", backend: { requiredMigration: "0099_foo.sql" }, channels: {} },
    history: [],
  };
  const m = parseManifest(raw);
  assert.ok(m !== null, "should parse");
  assert.equal(m!.current.version, "6.2.0");
});

await test("parseManifest rejects bad schema", () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest({ schemaVersion: 2, current: { version: "1.0.0", gitSha: "x" } }), null);
  assert.equal(parseManifest({ schemaVersion: 1 }), null);
  assert.equal(parseManifest({ schemaVersion: 1, current: "bad" }), null);
});

// ── checkForWebUpdate ──────────────────────────────────────────────────────
await test("detects a newer version via /version.json", async () => {
  store.clear();
  const fetcher = (async () => new Response(JSON.stringify({
    schemaVersion: 1,
    appName: "ALYQ POS",
    current: { version: "6.2.0", gitSha: "deadbeef", releasedAt: "2026-10-25T00:00:00Z", releaseNotes: { en: "New", ar: "جديد" }, backend: { requiredMigration: "0099_x.sql", requiredMigrationCount: 99 }, channels: {} },
    history: [],
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const info = await checkForWebUpdate(fetcher);
  assert.ok(info !== null, "should detect update");
  assert.equal(info!.latestVersion, "6.2.0");
});

await test("returns null when already on latest", async () => {
  store.clear();
  const fetcher = (async () => new Response(JSON.stringify({
    schemaVersion: 1,
    current: { version: "6.1.0", gitSha: "abc", releasedAt: "", releaseNotes: { en: "", ar: "" }, backend: { requiredMigration: "0099_x.sql" } },
  }), { status: 200 })) as unknown as typeof fetch;
  const info = await checkForWebUpdate(fetcher);
  assert.equal(info, null, "no update when on current");
});

await test("returns null on fetch failure (offline)", async () => {
  store.clear();
  const fetcher = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const info = await checkForWebUpdate(fetcher);
  assert.equal(info, null);
});

await test("returns null on 404 or invalid JSON", async () => {
  store.clear();
  let fetcher = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  assert.equal(await checkForWebUpdate(fetcher), null);
  fetcher = (async () => new Response("not json {", { status: 200 })) as unknown as typeof fetch;
  // invalid JSON → caught
  const info = await checkForWebUpdate(fetcher);
  assert.equal(info, null);
});

// ── dismiss logic ──────────────────────────────────────────────────────────
await test("dismiss / isUpdateDismissed round-trip", () => {
  store.clear();
  assert.equal(isUpdateDismissed("6.2.0"), false);
  dismissUpdate("6.2.0");
  assert.equal(isUpdateDismissed("6.2.0"), true);
  assert.equal(isUpdateDismissed("6.1.0"), false);
  clearDismissedUpdate();
  assert.equal(isUpdateDismissed("6.2.0"), false);
});

await test("checkForWebUpdate respects dismissal", async () => {
  store.clear();
  dismissUpdate("6.2.0");
  const fetcher = (async () => new Response(JSON.stringify({
    schemaVersion: 1,
    current: { version: "6.2.0", gitSha: "x", releasedAt: "", releaseNotes: { en: "", ar: "" }, backend: { requiredMigration: "0099_x.sql" } },
  }), { status: 200 })) as unknown as typeof fetch;
  const info = await checkForWebUpdate(fetcher);
  assert.equal(info, null, "dismissed version is not reported");
  store.clear();
});

console.log(`${passed}/8 web-update tests passed`);

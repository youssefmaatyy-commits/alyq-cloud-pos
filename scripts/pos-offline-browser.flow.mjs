#!/usr/bin/env node
/**
 * Focused real-browser acceptance for the POS offline queue.
 *
 * Uses Chromium's actual IndexedDB (not the logic suite's memory backend),
 * toggles the browser context truly offline, recreates the DB wrapper to model
 * a refreshed JS application, then reconnects and proves exactly-once replay.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_ANON_KEY: "" },
  },
);
const logs = [];
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));

let browser;
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(base)).ok) break;
    } catch { /* server still starting */ }
    if (server.exitCode !== null) throw new Error(`Vite exited early\n${logs.join("")}`);
    if (Date.now() > deadline) throw new Error(`Vite startup timed out\n${logs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });

  const queued = await page.evaluate(async () => {
    const outbox = await import("/src/modules/pos/offline/outbox.ts");
    const dbModule = await import("/src/modules/pos/offline/db.ts");
    const db = dbModule.getOfflineDb();
    for (const store of ["cached_products", "cached_variants", "offline_sales", "offline_sale_lines", "sync_outbox", "sync_metadata"]) {
      await db.clear(store);
    }
    window.__posOfflineAcceptance = { outbox, dbModule, calls: 0, refs: [] };
    const exactVariantUuid = "123e4567-e89b-42d3-a456-426614174000";
    const clientRef = "pos-browser-offline-idempotency-key";
    const record = await outbox.enqueueOfflineSale(
      {
        client_ref: clientRef,
        lines: [{ product_id: "prod-1", variant_id: exactVariantUuid, qty: 1, discount_type: "none", discount_value: 0 }],
        discount_type: "none",
        discount_value: 0,
        payments: [{ method: "cash", amount: 500, status: "paid", tendered: 500 }],
        customer_id: null,
        customer_name: null,
        customer_phone: null,
        user_id: "cashier-1",
        user_name: "Cashier One",
      },
      [{
        product_id: "prod-1", variant_id: exactVariantUuid, qty: 1,
        discount_type: "none", discount_value: 0,
        name_en: "Exact Variant", name_ar: "النوع المحدد", sku: "EXACT-UUID", unit_price: 500,
      }],
      { subtotal: 500, discount_amount: 0, total: 500 },
    );
    const summary = await outbox.getSyncSummary();
    const display = await outbox.getOfflineSaleDisplay(record.id);
    return { localId: record.id, clientRef, exactVariantUuid, summary, status: display?.offline_sync_status, itemCount: display?.items.length };
  });
  assert.equal(queued.summary.pendingCount, 1);
  assert.equal(queued.status, "pending");
  assert.equal(queued.itemCount, 1);

  // No network is available while the persisted records are discarded from
  // memory and re-opened through a fresh IndexedDbBackend instance.
  await context.setOffline(true);
  const afterRefresh = await page.evaluate(async ({ localId, exactVariantUuid }) => {
    const test = window.__posOfflineAcceptance;
    test.dbModule.resetOfflineDbForTests();
    const db = test.dbModule.getOfflineDb();
    const record = await db.get("offline_sales", localId);
    const lines = await db.getAll("offline_sale_lines");
    const summary = await test.outbox.getSyncSummary();
    return {
      exists: Boolean(record),
      inputVariant: record?.input.lines[0]?.variant_id,
      lineVariant: lines.find((line) => line.local_sale_id === localId)?.variant_id,
      pending: summary.pendingCount,
      expected: exactVariantUuid,
    };
  }, queued);
  assert.equal(afterRefresh.exists, true);
  assert.equal(afterRefresh.pending, 1);
  assert.equal(afterRefresh.inputVariant, afterRefresh.expected);
  assert.equal(afterRefresh.lineVariant, afterRefresh.expected);

  await context.setOffline(false);
  const synced = await page.evaluate(async ({ clientRef, localId }) => {
    const test = window.__posOfflineAcceptance;
    const complete = async (input) => {
      test.calls += 1;
      test.refs.push(input.client_ref);
      return { id: "server-sale-1", sale_number: "S-000001" };
    };
    await test.outbox.processOutbox(complete);
    await test.outbox.processOutbox(complete);
    await test.outbox.retrySyncNow(complete);
    const summary = await test.outbox.getSyncSummary();
    const audit = await test.dbModule.getOfflineDb().get("offline_sales", localId);
    return { calls: test.calls, refs: test.refs, summary, auditStatus: audit?.sync_status, serverId: audit?.server_id, clientRef };
  }, queued);
  assert.equal(synced.calls, 1);
  assert.deepEqual(synced.refs, [synced.clientRef]);
  assert.equal(synced.summary.pendingCount + synced.summary.errorCount + synced.summary.conflictCount, 0);
  assert.equal(synced.auditStatus, "synced");
  assert.equal(synced.serverId, "server-sale-1");

  console.log("✓ real IndexedDB offline cash sale persisted across DB recreation");
  console.log("✓ exact variant UUID and stable client_ref survived unchanged");
  console.log("✓ reconnect synced once; repeated automatic/manual passes created no duplicate");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

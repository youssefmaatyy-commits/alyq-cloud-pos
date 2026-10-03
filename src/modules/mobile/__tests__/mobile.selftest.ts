import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMobileDeepLink, authorizeMobileDeepLink, safePushDeepLink } from "../services/deepLinks";
import { buildOperationalNotifications, type NotificationSnapshot } from "@/modules/operations/services/notifications";
import { compareVariants, type ProductVariant } from "@/modules/products/variants";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("deep links validate shape and permission before navigation", () => {
  const order = parseMobileDeepLink("alyq://mobile/orders/order-123");
  assert.equal(order?.route, "/mobile/orders/order-123");
  assert.equal(authorizeMobileDeepLink(order, { capabilities: ["manage_online_orders"] })?.entityId, "order-123");
  assert.equal(authorizeMobileDeepLink(order, { capabilities: ["view_inventory"] }), null);
  assert.equal(parseMobileDeepLink("javascript:alert(1)"), null);
  assert.equal(parseMobileDeepLink("alyq://mobile/orders/../../branch-b"), null);
  assert.equal(safePushDeepLink({ kind: "order", entity_id: "order-123", customer_phone: "must-not-drive-routing" })?.route, "/mobile/orders/order-123");
});

test("realtime, refresh and push identities deduplicate to one notification", () => {
  const snapshot: NotificationSnapshot = {
    stock: [],
    orders: [
      { id: "order-1", number: "WEB-1", status: "pending", createdAt: "2026-01-01T00:00:00Z" },
      { id: "order-1", number: "WEB-1", status: "pending", createdAt: "2026-01-01T00:00:00Z" },
    ],
    returns: [], shifts: [], promotions: [], stocktakes: [],
    approvals: [
      { id: "approval-1", number: "APR-1", status: "pending", requestedAt: "2026-01-01T00:00:00Z" },
      { id: "approval-1", number: "APR-1", status: "pending", requestedAt: "2026-01-01T00:00:00Z" },
    ],
    backupStatus: null, backupAt: null, storageUsedBytes: null, storageWarningBytes: null, supabase: "ok",
  };
  const notes = buildOperationalNotifications(snapshot, new Set(["manage_online_orders", "approve_limit_request"]), "2026-01-02T00:00:00Z");
  assert.deepEqual(notes.map((note) => note.id).sort(), ["approval_request:approval-1", "online_order:order-1"]);
});

function variant(size: string, order: number): ProductVariant {
  return { id: size, product_id: "p", sku: `ALYQ-01-BLK-${size}`, barcode: `629${size}`, color_key: "black", color_ar: "أسود", color_en: "Black", color_hex: null, size: /^\d/.test(size) ? Number(size) : null, size_label: size, size_value: size, size_sort_order: order, image_url: null, price_override: null, cost_override: null, stock_quantity: size === "42" ? 7 : 3, low_stock_level: 1, active: true, sort_order: order, created_at: "", updated_at: "" };
}

test("mobile exact variants retain numeric, letter and One Size order", () => {
  const rows = [variant("XL", 6), variant("42", 3), variant("One Size", 7), variant("40", 1), variant("M", 5), variant("41", 2), variant("S", 4)].sort(compareVariants);
  assert.deepEqual(rows.map((row) => row.size_value), ["40", "41", "42", "S", "M", "XL", "One Size"]);
  const exact = rows.find((row) => row.sku === "ALYQ-01-BLK-42");
  assert.equal(exact?.barcode, "62942");
  assert.equal(exact?.stock_quantity, 7);
});

test("mobile management writes require online authority and never import the POS outbox", () => {
  const runtime = fs.readFileSync("src/modules/mobile/services/mobileRuntime.ts", "utf8");
  const pages = ["MobileOrdersPages.tsx", "MobileApprovalsPages.tsx"].map((name) => fs.readFileSync(`src/modules/mobile/pages/${name}`, "utf8")).join("\n");
  assert.match(runtime, /requireMobileOnline/);
  assert.match(pages, /requireMobileOnline/);
  assert.doesNotMatch(fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8") + pages, /offline\/outbox|enqueueOffline|completeOfflineSale/);
});

test("mobile source has a narrow native surface and no privileged secret material", () => {
  const files = [
    "capacitor.config.ts",
    "src/modules/mobile/services/mobilePush.ts",
    "src/modules/mobile/services/mobileRuntime.ts",
    "src/modules/mobile/services/deepLinks.ts",
  ];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /service[_-]?role.{0,30}[=:].{8,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|postgres(?:ql)?:\/\/|manager.{0,12}pin.{0,12}[=:]/i);
  assert.doesNotMatch(source, /Filesystem|exec\(|shell|eval\(/);
  assert.match(source, /PushNotifications/);
  assert.match(source, /mobile_installation_deactivate/);
});

test("phone shell is purpose-built, RTL-aware and width hardened", () => {
  const app = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  const css = fs.readFileSync("src/modules/mobile/mobile.css", "utf8");
  assert.match(app, /Home/); assert.match(app, /Orders/); assert.match(app, /Inventory/); assert.match(app, /Alerts/); assert.match(app, /More/);
  assert.match(app, /dir=\{dir\}/);
  assert.match(css, /max-width:370px/);
  assert.match(css, /overflow-x:clip/);
  assert.match(app, /data-mobile-width-safe="360-430"/);
  assert.doesNotMatch(app, /AppShell|RegisterProvider|PosProvider/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.error(`  ✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length}/${tests.length} mobile management tests passed`);

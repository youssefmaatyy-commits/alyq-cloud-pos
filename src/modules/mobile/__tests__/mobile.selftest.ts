import assert from "node:assert/strict";
import fs from "node:fs";
import { parseMobileDeepLink, authorizeMobileDeepLink, safePushDeepLink } from "../services/deepLinks";
import { safeNotificationId } from "../services/notificationCenter";
import { buildOperationalNotifications, type NotificationSnapshot } from "@/modules/operations/services/notifications";
import { compareVariants, type ProductVariant } from "@/modules/products/variants";
import {
  classifyApnsResponse,
  classifyFcmResponse,
  parseRetryAfterSeconds,
  retryDelaySeconds,
} from "../../../../supabase/functions/alyq-push/providers";
import {
  isDispatchAuthorized,
  selectDispatchBatchLimits,
} from "../../../../supabase/functions/alyq-push/request";

const tests: Array<[string, () => void | Promise<void>]> = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("deep links validate shape and permission before navigation", () => {
  const order = parseMobileDeepLink("alyq://mobile/orders/order-123");
  assert.equal(order?.route, "/mobile/orders/order-123");
  assert.equal(authorizeMobileDeepLink(order, { capabilities: ["manage_online_orders"] })?.entityId, "order-123");
  assert.equal(authorizeMobileDeepLink(order, { capabilities: ["view_inventory"] }), null);
  assert.equal(parseMobileDeepLink("javascript:alert(1)"), null);
  assert.equal(parseMobileDeepLink("alyq://mobile/orders/../../branch-b"), null);
  assert.equal(safePushDeepLink({ kind: "online_order", route_key: "order", entity_id: "order-123", customer_phone: "must-not-drive-routing" })?.route, "/mobile/orders/order-123");
  assert.equal(safeNotificationId({ notification_id: "123e4567-e89b-42d3-a456-426614174000", route_key: "order" }), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(safeNotificationId({ notification_id: "../orders/admin" }), null);
});

test("push providers classify delivery, retry, invalid-token and permanent outcomes", () => {
  assert.equal(classifyFcmResponse(200, { name: "projects/p/messages/m" }, null).outcome, "delivered");
  assert.equal(classifyFcmResponse(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, null).outcome, "invalid_token");
  assert.equal(classifyFcmResponse(400, { error: { status: "INVALID_ARGUMENT" } }, null).outcome, "invalid_token");
  assert.equal(classifyFcmResponse(503, { error: { status: "UNAVAILABLE" } }, "90").outcome, "retry");
  assert.equal(classifyFcmResponse(400, { error: { status: "QUOTA_EXCEEDED" } }, null).outcome, "retry");
  assert.equal(classifyFcmResponse(403, { error: { status: "PERMISSION_DENIED" } }, null).outcome, "permanent_failure");
  assert.equal(classifyApnsResponse(200, {}, null, "apns-id").outcome, "delivered");
  assert.equal(classifyApnsResponse(410, { reason: "Unregistered" }, null, null).outcome, "invalid_token");
  assert.equal(classifyApnsResponse(429, { reason: "TooManyRequests" }, "30", null).outcome, "retry");
  assert.equal(classifyApnsResponse(403, { reason: "InvalidProviderToken" }, null, null).outcome, "permanent_failure");
});

test("push retry helpers cap exponential jitter and provider Retry-After", () => {
  assert.equal(parseRetryAfterSeconds("90", 0), 90);
  assert.equal(parseRetryAfterSeconds("99999", 0), 3600);
  assert.equal(retryDelaySeconds(1, null, 0), 12);
  assert.equal(retryDelaySeconds(3, 120, 0.5), 120);
  assert.equal(retryDelaySeconds(10, 99999, 1), 3600);
});

test("push dispatch authentication is separate, fail-closed and body-authority-free", async () => {
  const dispatchSecret = "test-only-dispatch-secret";
  const serviceRoleKey = "test-only-service-role-key";
  assert.equal(await isDispatchAuthorized(null, dispatchSecret, serviceRoleKey), false);
  assert.equal(await isDispatchAuthorized("Bearer wrong-secret", dispatchSecret, serviceRoleKey), false);
  assert.equal(await isDispatchAuthorized(`Bearer ${dispatchSecret}`, dispatchSecret, serviceRoleKey), true);
  assert.equal(await isDispatchAuthorized(`Bearer ${serviceRoleKey}`, dispatchSecret, serviceRoleKey), false);
  assert.equal(await isDispatchAuthorized(`Bearer ${dispatchSecret}`, dispatchSecret, dispatchSecret), false);

  const selected = selectDispatchBatchLimits({
    limit: 500,
    event_limit: 500,
    user_id: "attacker-user",
    branch_id: "attacker-branch",
    push_token: "attacker-token",
    kind: "attacker-kind",
    title: "attacker-title",
    body: "attacker-body",
    payload: { arbitrary: true },
  }, 100, 25);
  assert.deepEqual(selected, { limit: 100, eventLimit: 25 });
  assert.deepEqual(Object.keys(selected).sort(), ["eventLimit", "limit"]);

  const edge = fs.readFileSync("supabase/functions/alyq-push/index.ts", "utf8");
  assert.match(edge, /env\("PUSH_DISPATCH_SECRET"\)/);
  assert.match(edge, /isDispatchAuthorized\(authorization, config\.dispatchSecret, config\.serviceRoleKey\)/);
  assert.match(edge, /createClient\(config\.supabaseUrl, config\.serviceRoleKey/);
  assert.match(edge, /selectDispatchBatchLimits\(payload, MAX_CLAIM, MAX_EVENTS\)/);
  assert.match(edge, /jsonResponse\(known\.status, \{ ok: false, code: known\.code \}\)/);
  const logStatements = edge.match(/console\.(?:info|error)\([^\n]+/g)?.join("\n") ?? "";
  assert.doesNotMatch(logStatements, /dispatchSecret|serviceRoleKey|authorization|push_token|privateKey/i);
  assert.doesNotMatch(edge, /VITE_/);
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
  assert.doesNotMatch(source, /@capacitor\/filesystem|child_process|shell\.open|\beval\(/i);
  assert.match(source, /PushNotifications/);
  assert.match(source, /mobile_installation_deactivate/);
});

test("notification center is server-backed and push opens are deferred through current authority", () => {
  const page = fs.readFileSync("src/modules/mobile/pages/MobileNotificationsPage.tsx", "utf8");
  const center = fs.readFileSync("src/modules/mobile/services/notificationCenter.ts", "utf8");
  const push = fs.readFileSync("src/modules/mobile/services/mobilePush.ts", "utf8");
  assert.match(page, /listMobileNotifications/);
  assert.match(page, /markAllMobileNotificationsRead/);
  assert.doesNotMatch(page, /Preferences|buildOperationalNotifications|READ_KEY/);
  assert.match(center, /notification_center_list/);
  assert.match(center, /notification_center_resolve_route/);
  assert.match(push, /PENDING_NOTIFICATION_KEY/);
  assert.match(push, /pushNotificationReceived/);
  assert.match(push, /pushNotificationActionPerformed/);
  assert.match(push, /consumePendingNotificationAction/);
  assert.match(push, /checkPermissions\(\)[\s\S]*deactivateMobileInstallation/);
  assert.doesNotMatch(push, /safePushDeepLink\(event\.notification/);
});

test("0092 wires every required event through failure-isolated deduplicated enqueue", () => {
  const migration = fs.readFileSync("supabase/migrations/0092_mobile_push_and_notification_center.sql", "utf8");
  for (const event of [
    "online_order:",
    "manager_approval:",
    "critical_stock:",
    "stock_transfer_attention:",
    "return_refund_attention:",
    "offline_sync_failure:",
  ]) assert.match(migration, new RegExp(event));
  assert.match(migration, /notification_enqueue_safe/);
  assert.match(migration, /exception when others then\s+return null/);
  assert.match(migration, /notification_route_accessible/);
});

test("native push configuration protects external custody and relays APNs tokens", () => {
  const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
  const androidIgnore = fs.readFileSync("android/.gitignore", "utf8");
  const iosIgnore = fs.readFileSync("ios/.gitignore", "utf8");
  const appDelegate = fs.readFileSync("ios/App/App/AppDelegate.swift", "utf8");
  assert.match(manifest, /default_notification_channel_id/);
  assert.match(manifest, /alyq_operational/);
  assert.match(androidIgnore, /^app\/google-services\.json$/m);
  assert.match(androidIgnore, /^\*\.keystore$/m);
  assert.match(iosIgnore, /^\*\.p8$/m);
  assert.match(appDelegate, /capacitorDidRegisterForRemoteNotifications/);
  assert.match(appDelegate, /capacitorDidFailToRegisterForRemoteNotifications/);
  assert.doesNotMatch(appDelegate + manifest, /BEGIN (?:RSA |EC )?PRIVATE KEY|service_role/i);
});

test("bottom-tab routes are relative to the /mobile/* mount, not absolute", () => {
  // `App.tsx` mounts this shell at `<Route path="/mobile/*">`, which strips the
  // "/mobile" prefix before this component's own descendant <Routes> ever sees
  // the pathname (the same mechanism `SettingsArea` relies on for `/settings/*`).
  // A route declared here as `path="/mobile/orders"` therefore never matches —
  // every tab but Home silently falls through to the wildcard. This guards
  // against that regression reappearing.
  const app = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  assert.doesNotMatch(app, /<Route\s+path="\/mobile/, "route paths inside MobileApp must be relative, e.g. path=\"orders\" not path=\"/mobile/orders\"");
  assert.match(app, /<Route\s+index\s+element=\{<MobileDashboardPage/);
  for (const relative of ["orders", "orders/:id", "inventory", "inventory/:id", "invoices", "invoices/:id", "approvals", "approvals/:id", "notifications", "health", "more"]) {
    assert.match(app, new RegExp(`<Route path="${relative.replace(/[/:]/g, "\\$&")}"`), `missing relative route for "${relative}"`);
  }
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

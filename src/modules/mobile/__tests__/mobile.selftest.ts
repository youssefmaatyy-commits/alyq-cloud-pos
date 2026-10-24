import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseMobileDeepLink, authorizeMobileDeepLink, safePushDeepLink } from "../services/deepLinks";
import { safeNotificationId, webRouteFor } from "../services/notificationCenter";
import { decodeVapidPublicKey, webPushCapability, webPushPlatform, webPushStateFor } from "../services/webPush";
import { permissionStatusLabel, pushStateCopy, serviceWorkerStatusLabel, subscriptionStatusLabel, webPushConfigurationStatusLabel } from "../pages/MobileNotificationsPage";
import { buildOperationalNotifications, type NotificationSnapshot } from "@/modules/operations/services/notifications";
import { compareVariants, type ProductVariant } from "@/modules/products/variants";
import {
  classifyApnsResponse,
  classifyFcmResponse,
  classifyWebPushResponse,
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
  assert.equal(classifyWebPushResponse(201, null).outcome, "delivered");
  assert.equal(classifyWebPushResponse(410, null).outcome, "invalid_token");
  assert.equal(classifyWebPushResponse(429, "45").outcome, "retry");
  assert.equal(classifyWebPushResponse(503, null).outcome, "retry");
  assert.equal(classifyWebPushResponse(403, null).outcome, "permanent_failure");
});

test("push retry helpers cap exponential jitter and provider Retry-After", () => {
  assert.equal(parseRetryAfterSeconds("90", 0), 90);
  assert.equal(parseRetryAfterSeconds("99999", 0), 3600);
  assert.equal(retryDelaySeconds(1, null, 0), 12);
  assert.equal(retryDelaySeconds(3, 120, 0.5), 120);
  assert.equal(retryDelaySeconds(10, 99999, 1), 3600);
});

test("PWA Web Push support distinguishes iOS Home Screen, browser support and permission state", () => {
  const base = {
    userAgent: "Mozilla/5.0",
    maxTouchPoints: 0,
    standalone: false,
    serviceWorker: true,
    pushManager: true,
    notifications: true,
  };
  assert.equal(webPushCapability(base), "available");
  assert.equal(webPushCapability({ ...base, pushManager: false }), "unsupported");
  assert.equal(webPushCapability({ ...base, userAgent: "Mozilla/5.0 (iPhone)", maxTouchPoints: 5 }), "install_required");
  assert.equal(webPushCapability({ ...base, userAgent: "Mozilla/5.0 (iPhone)", maxTouchPoints: 5, standalone: true }), "available");
  assert.equal(webPushCapability({ ...base, userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 5 }), "install_required");
  assert.equal(webPushStateFor("available", "default", false), "not_requested");
  assert.equal(webPushStateFor("available", "denied", false), "denied");
  assert.equal(webPushStateFor("available", "granted", false), "granted");
  assert.equal(webPushStateFor("available", "granted", true), "registered");
  assert.equal(webPushStateFor("install_required", "default", false), "install_required");
  assert.equal(webPushStateFor("unsupported", "default", false), "unsupported");
  assert.equal(webPushPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0", maxTouchPoints: 0 }), "windows");
  assert.equal(webPushPlatform({ userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/153.0", maxTouchPoints: 5 }), "android");
  assert.equal(webPushPlatform({ userAgent: "Mozilla/5.0 (iPhone) Version/26.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 }), "ios");

  const publicKey = Buffer.from(Uint8Array.from([4, ...Array.from({ length: 64 }, (_, index) => index + 1)]))
    .toString("base64url");
  assert.equal(decodeVapidPublicKey(publicKey).length, 65);
  assert.throws(() => decodeVapidPublicKey("not-a-p256-key"));
});

test("PWA assets are installable and notification clicks carry only opaque identity", () => {
  const manifest = JSON.parse(fs.readFileSync("public/mobile.webmanifest", "utf8")) as {
    name: string; short_name: string; start_url: string; display: string; icons: Array<{ sizes: string }>;
  };
  assert.equal(manifest.name, "ALYQ Mobile Management");
  assert.equal(manifest.short_name, "ALYQ");
  assert.equal(manifest.start_url, "/#/dashboard");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);
  const index = fs.readFileSync("index.html", "utf8");
  assert.match(index, /apple-mobile-web-app-capable/);
  assert.match(index, /alyq-apple-touch\.png/);
  const sw = fs.readFileSync("public/alyq-sw.js", "utf8");
  assert.match(sw, /self\.addEventListener\("push"/);
  assert.match(sw, /showNotification\("ALYQ"/);
  assert.match(sw, /self\.addEventListener\("notificationclick"/);
  assert.match(sw, /ALYQ_WEB_PUSH_OPEN/);
  assert.match(sw, /pushsubscriptionchange/);
  assert.match(sw, /ALYQ_WEB_PUSH_SUBSCRIPTION_CHANGE/);
  assert.match(sw, /alyq_notification=/);
  assert.match(sw, /client\.navigate\(target\)/);
  assert.doesNotMatch(sw, /route_key|entity_id|phone|address|payment|refund|auth_token|capabilit/i);
  assert.match(fs.readFileSync("src/main.tsx", "utf8"), /registerALYQServiceWorker\(\)\.catch/);
  const bridge = fs.readFileSync("src/modules/mobile/services/pwaBridge.ts", "utf8");
  assert.match(bridge, /alyq_notification/);
  assert.match(bridge, /localStorage\.setItem\(WEB_PUSH_PENDING_KEY, id\)/);
  assert.match(bridge, /history\.replaceState/);
  assert.match(bridge, /ALYQ_WEB_PUSH_SUBSCRIPTION_CHANGE/);
  assert.match(bridge, /WEB_PUSH_SUBSCRIPTION_EVENT/);
});

test("Web Push registration is explicit, isolated from auth and server-authorized on click", () => {
  const web = fs.readFileSync("src/modules/mobile/services/webPush.ts", "utf8");
  const beforeEnable = web.slice(0, web.indexOf("async enable()"));
  const enable = web.slice(web.indexOf("async enable()"));
  assert.doesNotMatch(beforeEnable, /requestPermission\(/);
  assert.match(enable, /Notification\.requestPermission\(\)/);
  assert.match(enable, /pushManager\.subscribe/);
  assert.match(web, /applicationServerKeyMatches/);
  assert.match(web, /navigator\.permissions\.query\(\{ name: "notifications" \}\)/);
  assert.match(web, /currentPermission\(\)/);
  assert.match(web, /get diagnostics\(\): PushDiagnostics/);
  assert.match(web, /WEB_PUSH_SUBSCRIPTION_EVENT/);
  assert.match(web, /web_push_subscription_register/);
  assert.match(web, /web_push_subscription_deactivate/);
  assert.match(web, /resolveMobileNotificationRoute\(notificationId\)/);
  assert.match(web, /route_unavailable/);
  assert.doesNotMatch(web, /signOut|forgetSession|clearSession|route_key|entity_id/);
  const mobileApp = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  assert.match(mobileApp, /if \(!auth\.user \|\| !branch\.current\) return;[\s\S]*createPushController/);

  const worker = fs.readFileSync("supabase/functions/alyq-push/index.ts", "utf8");
  assert.match(worker, /npm:web-push@3\.6\.7/);
  assert.match(worker, /env\("WEB_PUSH_VAPID_PUBLIC_KEY"\)/);
  assert.match(worker, /env\("WEB_PUSH_VAPID_PRIVATE_KEY"\)/);
  assert.match(worker, /env\("WEB_PUSH_SUBJECT"\)/);
  assert.match(worker, /JSON\.stringify\(\{ notification_id: delivery\.notification_id \}\)/);
  assert.doesNotMatch(worker, /VITE_WEB_PUSH_VAPID_PRIVATE_KEY|VITE_WEB_PUSH_SUBJECT/);
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
  assert.match(
    edge,
    /if \(env\("PUSH_CONFIG_SOURCE"\) === "vault"\) \{\s*const vault = await readVaultValues\(client\);\s*dispatchSecret = vaultText\(vault, "ALYQ_PUSH_DISPATCH_SECRET"\);/,
  );
  assert.doesNotMatch(edge, /dispatchSecret\s*\?\?=/);
  assert.match(edge, /isDispatchAuthorized\(authorization, config\.dispatchSecret, config\.serviceRoleKey\)/);
  assert.match(edge, /createClient\(supabaseUrl, serviceRoleKey/);
  assert.match(edge, /client\.rpc\("notification_dispatcher_config"\)/);
  assert.match(edge, /client\.rpc\("notification_dispatcher_install_vapid"/);
  assert.doesNotMatch(edge, /edge-runtime\.d\.ts/, "runtime type imports caused Staging BOOT_ERROR");
  assert.ok(edge.indexOf("await authorize(req, config)") < edge.indexOf("await bootstrapVapidAfterAuthorization(client, config)"),
    "VAPID bootstrap cannot run before dispatcher authentication");
  assert.match(edge, /selectDispatchBatchLimits\(payload, MAX_CLAIM, MAX_EVENTS\)/);
  assert.match(edge, /jsonResponse\(known\.status, \{ ok: false, code: known\.code \}\)/);
  const logStatements = edge.match(/console\.(?:info|error)\([^\n]+/g)?.join("\n") ?? "";
  assert.doesNotMatch(logStatements, /dispatchSecret|serviceRoleKey|authorization|push_token|privateKey/i);
  assert.doesNotMatch(edge, /VITE_/);
});

test("PUSH_CONFIG_SOURCE=vault overrides legacy PUSH_DISPATCH_SECRET and rejects oversized probes with 413 before claim", async () => {
  const localRequire = createRequire(path.join(process.cwd(), "package.json"));
  const esbuild = localRequire("esbuild") as {
    build: (options: Record<string, unknown>) => Promise<void>;
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alyq-push-vault-test-"));
  const outfile = path.join(tmpDir, "worker.mjs");

  const rpcCalls: string[] = [];
  let vaultSecrets: Record<string, string> = {};
  let envVars: Record<string, string> = {};
  let capturedHandler: ((req: Request) => Promise<Response>) | null = null;

  (globalThis as Record<string, unknown>).__alyqPushTestHarness = {
    createClient: () => ({
      rpc: async (fnName: string) => {
        rpcCalls.push(fnName);
        if (fnName === "notification_dispatcher_config") {
          return { data: { ...vaultSecrets }, error: null };
        }
        throw new Error(`Unexpected RPC call during safe auth probe: ${fnName}`);
      },
    }),
    webpush: {
      generateVAPIDKeys: () => {
        throw new Error("VAPID generation must not run during safe auth probe");
      },
      sendNotification: async () => {
        throw new Error("Provider send must not run during safe auth probe");
      },
    },
  };
  (globalThis as Record<string, unknown>).Deno = {
    env: {
      get: (name: string) => envVars[name],
    },
    serve: (fn: (req: Request) => Promise<Response>) => {
      capturedHandler = fn;
    },
  };

  try {
    await esbuild.build({
      entryPoints: [path.join(process.cwd(), "supabase/functions/alyq-push/index.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      plugins: [{
        name: "mock-edge-npm-imports",
        setup(build: {
          onResolve: (opts: { filter: RegExp }, cb: (args: { path: string }) => unknown) => void;
          onLoad: (opts: { filter: RegExp; namespace: string }, cb: (args: { path: string }) => unknown) => void;
        }) {
          build.onResolve({ filter: /^npm:/ }, (args) => ({ path: args.path, namespace: "edge-npm-mock" }));
          build.onLoad({ filter: /.*/, namespace: "edge-npm-mock" }, (args) => {
            if (args.path.startsWith("npm:@supabase/supabase-js")) {
              return { contents: "export const createClient = globalThis.__alyqPushTestHarness.createClient;", loader: "js" };
            }
            return { contents: "export default globalThis.__alyqPushTestHarness.webpush;", loader: "js" };
          });
        },
      }],
    });

    await import(pathToFileURL(outfile).href);
    assert.ok(capturedHandler, "Deno.serve handler registered");
    const invoke = capturedHandler as (req: Request) => Promise<Response>;
    const oversizedBody = JSON.stringify({ pad: "x".repeat(5000) });

    envVars = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-only-service-role-key",
      PUSH_DISPATCH_SECRET: "test-only-legacy-edge-secret",
      WEB_PUSH_VAPID_PUBLIC_KEY: "test-only-edge-vapid-public",
      WEB_PUSH_VAPID_PRIVATE_KEY: "test-only-edge-vapid-private",
      WEB_PUSH_SUBJECT: "https://alyq.example",
      PUSH_CONFIG_SOURCE: "vault",
    };
    vaultSecrets = {
      ALYQ_PUSH_DISPATCH_SECRET: "test-only-vault-dispatch-secret",
    };

    rpcCalls.length = 0;
    const legacyAttempt = await invoke(new Request("https://example.supabase.co/functions/v1/alyq-push", {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-legacy-edge-secret",
        "content-type": "application/json",
      },
      body: oversizedBody,
    }));
    assert.equal(legacyAttempt.status, 403, "legacy PUSH_DISPATCH_SECRET must be rejected when PUSH_CONFIG_SOURCE=vault");
    assert.deepEqual(await legacyAttempt.json(), { ok: false, code: "forbidden" });
    assert.deepEqual(rpcCalls, ["notification_dispatcher_config"]);

    rpcCalls.length = 0;
    const vaultAttempt = await invoke(new Request("https://example.supabase.co/functions/v1/alyq-push", {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-vault-dispatch-secret",
        "content-type": "application/json",
      },
      body: oversizedBody,
    }));
    assert.equal(vaultAttempt.status, 413, "authorized Vault bearer with oversized body must reach 413 without claiming");
    assert.deepEqual(await vaultAttempt.json(), { ok: false, code: "request_too_large" });
    assert.deepEqual(rpcCalls, ["notification_dispatcher_config"], "must never call notification_claim_push_batch");

    vaultSecrets = {};
    rpcCalls.length = 0;
    const missingVaultAttempt = await invoke(new Request("https://example.supabase.co/functions/v1/alyq-push", {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-legacy-edge-secret",
        "content-type": "application/json",
      },
      body: oversizedBody,
    }));
    assert.equal(missingVaultAttempt.status, 500, "missing Vault secret must fail closed rather than falling back to legacy secret");
    assert.deepEqual(await missingVaultAttempt.json(), { ok: false, code: "not_configured" });

    delete envVars.PUSH_CONFIG_SOURCE;
    rpcCalls.length = 0;
    const envOnlyAttempt = await invoke(new Request("https://example.supabase.co/functions/v1/alyq-push", {
      method: "POST",
      headers: {
        authorization: "Bearer test-only-legacy-edge-secret",
        "content-type": "application/json",
      },
      body: oversizedBody,
    }));
    assert.equal(envOnlyAttempt.status, 413, "legacy Edge secret remains supported when PUSH_CONFIG_SOURCE is unset");
    assert.deepEqual(rpcCalls, []);
  } finally {
    Reflect.deleteProperty(globalThis, "__alyqPushTestHarness");
    Reflect.deleteProperty(globalThis, "Deno");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("0099 dispatcher entry point uses bounded cron input and PostgreSQL-safe URL validation", () => {
  const migration = fs.readFileSync("supabase/migrations/0099_notification_reliability_and_dispatch.sql", "utf8");
  assert.ok(migration.includes("char_length(coalesce(v_url,'')) not between 9 and 2008"));
  assert.ok(migration.includes("coalesce(v_url,'')!~'^https://.'"));
  assert.ok(!migration.includes("{1,2000}"), "PostgreSQL rejects repetition bounds above 255");
  assert.ok(migration.includes("body:=jsonb_build_object('limit',50,'event_limit',20)"));
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
    "src/modules/mobile/services/webPush.ts",
    "src/modules/mobile/services/pwaBridge.ts",
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
  assert.doesNotMatch(page, /@capacitor\/preferences|buildOperationalNotifications|READ_KEY/);
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

test("0094 extends the existing delivery channel without duplicating business notifications", () => {
  const migration = fs.readFileSync("supabase/migrations/0094_web_push_subscriptions.sql", "utf8");
  assert.match(migration, /create table if not exists public\.web_push_subscriptions/);
  assert.match(migration, /web_push_subscription_register/);
  assert.match(migration, /web_push_subscription_deactivate/);
  assert.match(migration, /web_push_subscriptions_deactivate_all/);
  assert.match(migration, /provider in\('fcm','apns','web_push'\)/);
  assert.match(migration, /insert into public\.notification_push_deliveries/);
  assert.match(migration, /insert into public\.user_notification_inbox/);
  assert.doesNotMatch(migration, /create table[^;]+(?:web_push_outbox|web_push_inbox)/i);
  assert.match(migration, /revoke all on public\.web_push_subscriptions from public,anon,authenticated,service_role/);
  assert.match(migration, /grant select on public\.web_push_subscriptions to service_role/);
  assert.doesNotMatch(migration, /grant\s+(?:select|all)[^;]+web_push_subscriptions\s+to\s+(?:anon|authenticated)/i);
  assert.match(migration, /'migration','0094_web_push_subscriptions\.sql','migration_count',94/);
  assert.doesNotMatch(migration, /notification_factory_reset_cleanup|system_factory_reset/);
});

test("notification UX has explicit bilingual install, permission, enabled and failure states", () => {
  const page = fs.readFileSync("src/modules/mobile/pages/MobileNotificationsPage.tsx", "utf8");
  for (const copy of [
    "Install ALYQ on your Home Screen to enable notifications",
    "Notifications available",
    "Permission not requested",
    "Notification permission granted",
    "Notification permission denied",
    "Notifications enabled",
    "Notification subscription error",
    "Notifications are unsupported on this browser or device",
    "ثبّت ALYQ على الشاشة الرئيسية لتفعيل الإشعارات",
    "لم يتم طلب الإذن بعد",
    "تم منح إذن الإشعارات",
    "تم رفض إذن الإشعارات",
    "تم تفعيل الإشعارات",
  ]) assert.match(page, new RegExp(copy));
});

test("browser permission and device subscription stay separate with platform-correct recovery copy", () => {
  assert.equal(permissionStatusLabel("granted", "en"), "Granted");
  assert.equal(permissionStatusLabel("denied", "en"), "Denied");
  assert.equal(permissionStatusLabel("default", "en"), "Default");
  assert.equal(permissionStatusLabel("unsupported", "en"), "Unsupported");
  assert.equal(permissionStatusLabel("default", "ar"), "لم يُطلب");
  assert.equal(subscriptionStatusLabel("registered", "en"), "Registered");
  assert.equal(subscriptionStatusLabel("not_subscribed", "en"), "Not subscribed");
  assert.equal(subscriptionStatusLabel("error", "en"), "Subscription error");
  assert.equal(subscriptionStatusLabel("unsupported", "en"), "Unsupported");
  assert.equal(serviceWorkerStatusLabel("registered", "en"), "Registered");
  assert.equal(serviceWorkerStatusLabel("error", "en"), "Service Worker error");
  assert.equal(webPushConfigurationStatusLabel("configured", "en"), "Configured");
  assert.equal(webPushConfigurationStatusLabel("missing", "en"), "Public key missing");
  assert.equal(webPushConfigurationStatusLabel("invalid", "en"), "Invalid public key");

  const windows = pushStateCopy("denied", "en", { platform: "windows", native: false });
  assert.match(windows.detail, /Chrome on Windows/);
  assert.match(windows.detail, /Windows Settings/);
  assert.doesNotMatch(windows.detail, /Safari/);
  const android = pushStateCopy("denied", "en", { platform: "android", native: false });
  assert.match(android.detail, /Android: Settings → Apps → Chrome/);
  assert.doesNotMatch(android.detail, /Safari/);
  const iosInstall = pushStateCopy("install_required", "en", { platform: "ios", native: false });
  assert.match(iosInstall.detail, /In Safari, tap Share, then Add to Home Screen/);
  const iosDenied = pushStateCopy("denied", "en", { platform: "ios", native: false });
  assert.match(iosDenied.detail, /Settings → Notifications → ALYQ/);
  assert.doesNotMatch(iosDenied.detail, /Safari/);

  // A subscription/RPC failure must not rewrite the actual browser permission.
  assert.equal(permissionStatusLabel("granted", "en"), "Granted");
  assert.equal(subscriptionStatusLabel("error", "en"), "Subscription error");
  const center = fs.readFileSync("src/modules/mobile/services/notificationCenter.ts", "utf8");
  assert.doesNotMatch(center, /Notification\.permission|requestPermission|PushManager/);
  for (const file of [
    "src/modules/mobile/pages/MobileNotificationsPage.tsx",
    "src/modules/notifications/WebNotificationsPage.tsx",
  ]) {
    assert.match(fs.readFileSync(file, "utf8"), /PushDiagnosticsRows/);
  }
  assert.match(fs.readFileSync("src/modules/mobile/pages/MobileNotificationsPage.tsx", "utf8"),
    /internal Notification Center works independently|مركز الإشعارات الداخلي يعمل بشكل مستقل/);
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

test("Notification Center has explicit entries in both authenticated mobile shells", () => {
  const app = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  const shell = fs.readFileSync("src/components/layout/AppShell.tsx", "utf8");
  assert.match(app, /to: "\/mobile\/notifications", label: lang === "ar" \? "الإشعارات" : "Notifications"/);
  assert.match(shell, /to="\/mobile\/notifications"/);
  assert.match(shell, /label=\{t\("admin\.shell\.notifications"\)\}/);
  assert.match(shell, /to=\{\{ pathname: "\/dashboard\/online\/orders", search: "\?status=pending" \}\}/, "the legacy Online Orders bell destination must remain intact");
});

test("phone shell is purpose-built, RTL-aware and width hardened", () => {
  const app = fs.readFileSync("src/modules/mobile/MobileApp.tsx", "utf8");
  const css = fs.readFileSync("src/modules/mobile/mobile.css", "utf8");
  assert.match(app, /Home/); assert.match(app, /Orders/); assert.match(app, /Inventory/); assert.match(app, /Notifications/); assert.match(app, /More/);
  assert.doesNotMatch(app, /label: "Alerts"/);
  assert.match(app, /dir=\{dir\}/);
  assert.match(css, /max-width:370px/);
  assert.match(css, /overflow-x:clip/);
  assert.match(app, /data-mobile-width-safe="360-430"/);
  assert.doesNotMatch(app, /AppShell|RegisterProvider|PosProvider/);
});

test("Web /dashboard/* achieves Phase 1 & Phase 2 parity with ALYQ Mobile Management", () => {
  const sampleId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(webRouteFor("order", sampleId), `/dashboard/online/orders/${sampleId}`);
  assert.equal(webRouteFor("product", sampleId), `/dashboard/inventory/stock/${sampleId}`);
  assert.equal(webRouteFor("approval", sampleId), `/dashboard/approvals/${sampleId}`);
  assert.equal(webRouteFor("invoice", sampleId), `/dashboard/pos/sales/${sampleId}`);
  assert.equal(webRouteFor("health", ""), "/dashboard/system-health");
  assert.equal(webRouteFor("order", "not-a-uuid"), null);

  const dash = fs.readFileSync("src/modules/dashboard/DashboardPage.tsx", "utf8");
  const health = fs.readFileSync("src/modules/system/pages/HealthCenterPage.tsx", "utf8");
  const orders = fs.readFileSync("src/modules/online/pages/OnlineOrdersPage.tsx", "utf8");
  const orderDetail = fs.readFileSync("src/modules/online/components/OrderDetailModal.tsx", "utf8");
  const inventory = fs.readFileSync("src/modules/inventory/pages/InventoryPage.tsx", "utf8");
  const approvals = fs.readFileSync("src/modules/approvals/pages/ApprovalsPage.tsx", "utf8");
  const sales = fs.readFileSync("src/modules/pos/pages/SalesHistoryPage.tsx", "utf8");
  const saleDetail = fs.readFileSync("src/modules/pos/pages/SaleDetailPage.tsx", "utf8");

  assert.match(dash, /data-testid="dash-mobile-parity"/);
  assert.match(health, /data-testid="health-notifications"/);
  assert.match(orders, /data-testid="orders-view-toggle"/);
  assert.match(orderDetail, /deliveryStatusOf/);
  assert.match(orderDetail, /mobile-timeline/);
  assert.match(inventory, /listColorImages/);
  assert.match(inventory, /data-testid="inventory-exact-shelves"/);
  assert.match(inventory, /data-testid="inventory-product-detail-modal"/);
  assert.match(approvals, /data-testid="approval-detail-modal"/);
  assert.match(approvals, /mobile-safe-evidence/);
  assert.match(sales, /data-testid="sales-quick-dates"/);
  assert.match(saleDetail, /data-testid="sale-mobile-summary"/);

  const moduleHomes = fs.readFileSync("src/components/layout/moduleHomes.tsx", "utf8");
  const webNotifCtx = fs.readFileSync("src/modules/notifications/WebNotificationsContext.tsx", "utf8");
  const shell = fs.readFileSync("src/components/layout/AppShell.tsx", "utf8");
  const mobileCss = fs.readFileSync("src/modules/mobile/mobile.css", "utf8");

  assert.match(moduleHomes, /data-testid="module-more-parity"/);
  assert.match(webNotifCtx, /runtime:\s*MobileRuntimeContext\s*\|\s*null/);
  assert.match(shell, /overflow-x-clip/);
  assert.match(mobileCss, /white-space:nowrap/);
});

test("Android Full POS APK keeps its unified versionCode (61 for 6.1.0, legacy prodV21 fallback) and wires camera & print bridge", () => {
  const capConfig = fs.readFileSync("capacitor.config.ts", "utf8");
  const stringsXml = fs.readFileSync("android/app/src/main/res/values/strings.xml", "utf8");
  const buildGradle = fs.readFileSync("android/app/build.gradle", "utf8");
  const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
  const mainActivity = fs.readFileSync("android/app/src/main/java/eg/alyq/management/MainActivity.java", "utf8");
  const bottomNav = fs.readFileSync("src/components/layout/MobilePosBottomNav.tsx", "utf8");
  const cameraModal = fs.readFileSync("src/modules/pos/components/CameraBarcodeScannerModal.tsx", "utf8");

  assert.match(capConfig, /appId:\s*"eg\.alyq\.management"/);
  assert.match(capConfig, /appName:\s*"ALYQ POS"/);
  assert.match(stringsXml, /<string name="app_name">ALYQ POS<\/string>/);
  assert.match(stringsXml, /<string name="package_name">eg\.alyq\.management<\/string>/);
  assert.match(buildGradle, /applicationId\s+"eg\.alyq\.management"/);
  assert.match(buildGradle, /versionCode\s+project\.hasProperty\("prodV21"\)\s*\?\s*3\s*:\s*61/);
  assert.match(buildGradle, /versionName\s+project\.hasProperty\("prodV21"\)\s*\?\s*"2\.1\.0"\s*:\s*"6\.1\.0"/);
  assert.match(buildGradle, /System\.getenv\("ALYQ_KEYSTORE_PATH"\)/);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(mainActivity, /ALYQAndroidPrint/);
  assert.match(mainActivity, /createPrintDocumentAdapter/);
  assert.match(bottomNav, /data-testid="mobile-pos-bottom-nav"/);
  assert.match(bottomNav, /data-testid="mobile-pos-modules-sheet"/);
  assert.match(cameraModal, /data-testid="pos-camera-scanner-modal"/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.error(`  ✗ ${name}`); console.error(error); }
}
if (failed) process.exitCode = 1;
else console.log(`\n${tests.length}/${tests.length} mobile management tests passed`);

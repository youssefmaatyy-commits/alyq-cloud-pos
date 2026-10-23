import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_NOTIFICATION_KIND_PREFERENCES,
  parseNotificationKindPreferences,
} from "../services/notificationPreferences";

const tests: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test("server preferences default to opt-in without being confused with Inbox visibility", () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_KIND_PREFERENCES, {
    onlineOrders: true,
    criticalStock: true,
    syncFailures: true,
  });
  const migration = fs.readFileSync("supabase/migrations/0099_notification_reliability_and_dispatch.sql", "utf8");
  assert.match(migration, /notification_preferences_get/);
  assert.match(migration, /notification_preferences_set/);
  assert.match(migration, /Notification Center is[\s\S]*independent/i);
});

test("all three server kinds map without dropping an explicit false", () => {
  assert.deepEqual(parseNotificationKindPreferences({
    online_orders: false,
    critical_stock: false,
    sync_failures: true,
  }), { onlineOrders: false, criticalStock: false, syncFailures: true });
  assert.throws(() => parseNotificationKindPreferences({ online_orders: 0 }));
  assert.throws(() => parseNotificationKindPreferences(null));
});

test("preference controls use server RPCs and contain no credential or local-only persistence", () => {
  const service = fs.readFileSync("src/modules/mobile/services/notificationPreferences.ts", "utf8");
  assert.match(service, /notification_preferences_get/);
  assert.match(service, /notification_preferences_set/);
  assert.doesNotMatch(service, /localStorage|service_role|PRIVATE_KEY|dispatch_secret/i);
  const component = fs.readFileSync("src/modules/mobile/components/NotificationKindPreferences.tsx", "utf8");
  for (const id of [
    "notification-pref-online-orders",
    "notification-pref-critical-stock",
    "notification-pref-sync-failures",
  ]) assert.match(component, new RegExp(id));
  assert.match(component, /Notification Center always retains authorized alerts/);
});

test("Push filtering preserves the internal Inbox and terminally suppresses queued disabled kinds", () => {
  const migration = fs.readFileSync("supabase/migrations/0099_notification_reliability_and_dispatch.sql", "utf8");
  const inboxStart = migration.indexOf("insert into public.user_notification_inbox(");
  const deviceStart = migration.indexOf("insert into public.notification_push_deliveries(", inboxStart);
  const inbox = migration.slice(inboxStart, deviceStart);
  assert.doesNotMatch(inbox, /notification_push_kind_enabled/);
  assert.match(migration.slice(deviceStart), /notification_push_kind_enabled/);
  assert.match(migration, /last_error_code='preference_disabled'/);
  assert.match(migration, /Re-enabling later must never release an old notification/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`, error);
    process.exitCode = 1;
    break;
  }
}
if (passed === tests.length) console.log(`${passed}/${tests.length} notification preference tests passed`);

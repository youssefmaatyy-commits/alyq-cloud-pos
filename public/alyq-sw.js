/* global self */
/* ALYQ PWA service worker — push display and opaque notification-open handoff. */
const ALYQ_NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function notificationIdOf(value) {
  const id = value && typeof value === "object" && typeof value.notification_id === "string"
    ? value.notification_id
    : "";
  return ALYQ_NOTIFICATION_ID.test(id) ? id : null;
}

self.addEventListener("push", (event) => {
  let payload;
  try { payload = event.data ? event.data.json() : null; } catch { return; }
  const notificationId = notificationIdOf(payload);
  if (!notificationId) return;
  event.waitUntil(self.registration.showNotification("ALYQ", {
    body: "New notification available · يوجد إشعار جديد",
    icon: "/icons/alyq-192.png",
    badge: "/icons/alyq-192.png",
    tag: `alyq-notification-${notificationId}`,
    renotify: false,
    data: { notification_id: notificationId },
  }));
});

// Browser/provider rotation is not a permission change. Ask an open authorized
// ALYQ shell to re-register the replacement subscription through its narrow RPC.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then((clients) => {
      for (const client of clients) client.postMessage({ type: "ALYQ_WEB_PUSH_SUBSCRIPTION_CHANGE" });
    }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationId = notificationIdOf(event.notification.data);
  if (!notificationId) return;
  event.waitUntil((async () => {
    const target = `/?alyq_notification=${encodeURIComponent(notificationId)}#/mobile`;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: "ALYQ_WEB_PUSH_OPEN", notification_id: notificationId });
      if ("navigate" in client) await client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

/* global self, caches, URL, fetch */
/* ALYQ PWA service worker — push display, notification handoff, and cache hygiene. */

const ALYQ_NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Increment this string when the worker logic itself changes to force browser re-install.
const ALYQ_SW_VERSION = "6.1.0-1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // 1. Remove any stale ALYQ caches from older app-shell strategies so
    //    a new deployment never serves a mixed-version page.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("alyq-")).map((k) => caches.delete(k)));
    } catch { /* CacheStorage may be unavailable in some contexts */ }
    // 2. Take over all open tabs so they see the fresh worker immediately
    //    — no need to close/reopen after a Vercel deployment.
    await self.clients.claim();
    // 3. Notify open pages that the worker has activated (for update banner sync)
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      try { client.postMessage({ type: "ALYQ_SW_ACTIVATED", version: ALYQ_SW_VERSION }); } catch { /* ignore closed client */ }
    }
  })());
});

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

// Web update channel: the page detects a new version via /version.json polling.
// When the user clicks "Update now", the page reloads — no SW fetch interception
// needed. We explicitly do NOT cache /version.json or /index.html so every
// reload fetches the origin's current deployment (Vercel's cache-control handles it).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never serve a cached copy of the version manifest or the app shell HTML.
  if (url.pathname === "/version.json" || url.pathname === "/releases/latest.json" || url.pathname === "/index.html" || url.pathname === "/") {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(() => caches.match(event.request)).then((r) => r || fetch(event.request)));
    return;
  }
  // For hashed static assets or other requests, use network-first with cache fallback
  // only if we had previously cached — but ALYQ currently serves a singlefile build
  // so this is mostly a no-op safety net.
});

// Allow the page to explicitly trigger skipWaiting after it confirms an update
// is safe to apply (no pending offline sync).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "ALYQ_SKIP_WAITING") self.skipWaiting();
});

const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const WEB_PUSH_PENDING_KEY = "alyq.web-push.pending-notification.v1";
export const WEB_PUSH_PENDING_EVENT = "alyq:web-push-pending";
export const WEB_PUSH_SUBSCRIPTION_EVENT = "alyq:web-push-subscription-change";

function safeId(value: unknown): string | null {
  return typeof value === "string" && NOTIFICATION_ID.test(value) ? value : null;
}

export function queuePendingWebPushNotification(value: unknown): boolean {
  const id = safeId(value);
  if (!id || typeof window === "undefined") return false;
  try { window.localStorage.setItem(WEB_PUSH_PENDING_KEY, id); } catch { return false; }
  window.dispatchEvent(new CustomEvent(WEB_PUSH_PENDING_EVENT, { detail: id }));
  return true;
}

export function readPendingWebPushNotification(): string | null {
  if (typeof window === "undefined") return null;
  try { return safeId(window.localStorage.getItem(WEB_PUSH_PENDING_KEY)); } catch { return null; }
}

export function clearPendingWebPushNotification(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(WEB_PUSH_PENDING_KEY); } catch { /* opaque ID cleanup is best effort */ }
}

function captureLaunchQuery(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const id = safeId(url.searchParams.get("alyq_notification"));
  if (!id) return;
  if (!queuePendingWebPushNotification(id)) return;
  url.searchParams.delete("alyq_notification");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Register without blocking app startup or making any authentication decision. */
export async function registerALYQServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  captureLaunchQuery();
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const record = data as Record<string, unknown>;
    if (record.type === "ALYQ_WEB_PUSH_OPEN") queuePendingWebPushNotification(record.notification_id);
    if (record.type === "ALYQ_WEB_PUSH_SUBSCRIPTION_CHANGE") {
      window.dispatchEvent(new Event(WEB_PUSH_SUBSCRIPTION_EVENT));
    }
  });
  try {
    return await navigator.serviceWorker.register("/alyq-sw.js", { scope: "/" });
  } catch {
    // PWA support is optional. Registration failure must never block ALYQ or auth.
    return null;
  }
}

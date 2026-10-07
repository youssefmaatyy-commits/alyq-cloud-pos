import { getSupabaseClient } from "@/lib/supabase/client";
import type { PushController, PushRegistrationState } from "./mobilePush";
import {
  clearPendingWebPushNotification,
  readPendingWebPushNotification,
  WEB_PUSH_PENDING_EVENT,
} from "./pwaBridge";
import { markMobileNotificationRead, resolveMobileNotificationRoute } from "./notificationCenter";

const CLIENT_ID_KEY = "alyq.web-push.client-id.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface WebPushCapabilityInput {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
}

export type WebPushCapability = "install_required" | "available" | "unsupported";

export function webPushStateFor(
  capability: WebPushCapability,
  permission: NotificationPermission,
  hasSubscription: boolean,
): PushRegistrationState {
  if (capability === "install_required") return "install_required";
  if (capability === "unsupported") return "unsupported";
  if (permission === "denied") return "denied";
  if (permission === "granted") return hasSubscription ? "registered" : "granted";
  return "not_requested";
}

/** iPadOS may identify itself as Macintosh, so touch capability is included. */
export function webPushCapability(input: WebPushCapabilityInput): WebPushCapability {
  const ios = /iPad|iPhone|iPod/i.test(input.userAgent)
    || (/Macintosh/i.test(input.userAgent) && input.maxTouchPoints > 1);
  if (ios && !input.standalone) return "install_required";
  return input.serviceWorker && input.pushManager && input.notifications ? "available" : "unsupported";
}

export function decodeVapidPublicKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim().replace(/=+$/, "");
  if (!BASE64URL.test(normalized)) throw new Error("Invalid VAPID public key");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob((normalized + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid VAPID public key");
  return bytes;
}

function configuredVapidPublicKey(): string {
  try { return import.meta.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? ""; } catch { return ""; }
}

function applicationServerKeyMatches(subscription: PushSubscription, expected: Uint8Array<ArrayBuffer>): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}

function currentCapability(): WebPushCapability {
  const nav = navigator as Navigator & { standalone?: boolean };
  return webPushCapability({
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notifications: "Notification" in window,
  });
}

function currentLocale(): "en" | "ar" {
  return document.documentElement.lang.toLowerCase().startsWith("ar") ? "ar" : "en";
}

function clientId(): string {
  const existing = window.localStorage.getItem(CLIENT_ID_KEY);
  if (existing && UUID.test(existing)) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

function subscriptionMaterial(subscription: PushSubscription): {
  endpoint: string;
  expirationTime: string | null;
  p256dh: string;
  auth: string;
} {
  const json = subscription.toJSON();
  const endpoint = typeof json.endpoint === "string" ? json.endpoint : subscription.endpoint;
  const p256dh = json.keys?.p256dh ?? "";
  const auth = json.keys?.auth ?? "";
  if (!endpoint.startsWith("https://") || endpoint.length > 2048
      || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) {
    throw new Error("Invalid Web Push subscription");
  }
  return {
    endpoint,
    expirationTime: subscription.expirationTime === null
      ? null
      : new Date(subscription.expirationTime).toISOString(),
    p256dh,
    auth,
  };
}

async function registerSubscription(subscription: PushSubscription): Promise<void> {
  const client = getSupabaseClient();
  if (!client) throw new Error("Backend is unavailable");
  const material = subscriptionMaterial(subscription);
  const { error } = await client.rpc("web_push_subscription_register", {
    p_client_id: clientId(),
    p_endpoint: material.endpoint,
    p_p256dh: material.p256dh,
    p_auth: material.auth,
    p_locale: currentLocale(),
    p_expiration_time: material.expirationTime,
  });
  if (error) throw error;
}

async function deactivateServerSubscription(): Promise<void> {
  try {
    const id = window.localStorage.getItem(CLIENT_ID_KEY);
    const client = getSupabaseClient();
    if (!id || !UUID.test(id) || !client) return;
    await client.rpc("web_push_subscription_deactivate", { p_client_id: id });
  } catch {
    // Push cleanup is best effort and must never block logout/session isolation.
  }
}

export async function deactivateWebPushSubscription(): Promise<void> {
  await deactivateServerSubscription();
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // Local browser/provider cleanup is best effort; server state is already inactive.
  }
  clearPendingWebPushNotification();
}

/**
 * Resolve the opaque notification ID only after AuthProvider and BranchProvider
 * are mounted. Payload routes are never accepted; stale/unauthorized targets go
 * to the existing Notification Center fallback.
 */
export async function consumePendingWebPushNotification(
  navigate: (route: string) => void,
  onNotificationsChanged: () => void,
): Promise<void> {
  const notificationId = readPendingWebPushNotification();
  if (!notificationId) return;
  const resolved = await resolveMobileNotificationRoute(notificationId);
  if (resolved.ok && resolved.route) {
    await markMobileNotificationRead(notificationId).catch(() => false);
    clearPendingWebPushNotification();
    onNotificationsChanged();
    navigate(resolved.route);
    return;
  }
  if (resolved.reason === "unavailable") {
    navigate("/mobile/notifications?notice=route_unavailable");
    return;
  }
  clearPendingWebPushNotification();
  onNotificationsChanged();
  navigate(`/mobile/notifications?notice=${resolved.reason ?? "unauthorized_or_stale"}`);
}

export async function createWebPushController(
  navigate: (route: string) => void,
  onState: (state: PushRegistrationState) => void,
  onNotificationsChanged: () => void,
): Promise<PushController> {
  const capability = currentCapability();
  let state: PushRegistrationState = webPushStateFor(
    capability,
    capability === "available" ? Notification.permission : "default",
    false,
  );
  let disposed = false;
  const setState = (next: PushRegistrationState) => {
    state = next;
    if (!disposed) onState(next);
  };
  const consumePending = () => consumePendingWebPushNotification(navigate, onNotificationsChanged);

  const refresh = async () => {
    if (capability !== "available") return;
    if (Notification.permission === "denied") {
      await deactivateServerSubscription();
      setState("denied");
      return;
    }
    if (Notification.permission !== "granted") {
      setState("not_requested");
      return;
    }
    try {
      const publicKey = configuredVapidPublicKey();
      if (!publicKey) throw new Error("Web Push public key is unavailable");
      const expectedKey = decodeVapidPublicKey(publicKey);
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setState("granted");
        return;
      }
      if (!applicationServerKeyMatches(subscription, expectedKey)) {
        await deactivateServerSubscription();
        await subscription.unsubscribe().catch(() => false);
        setState("granted");
        return;
      }
      setState("registering");
      await registerSubscription(subscription);
      setState("registered");
    } catch {
      setState("error");
    }
  };

  const onPending = () => { void consumePending(); };
  const onOnline = () => { void refresh(); void consumePending(); };
  const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
  window.addEventListener(WEB_PUSH_PENDING_EVENT, onPending);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  onState(state);
  await refresh().catch(() => setState("error"));
  await consumePending().catch(() => undefined);

  return {
    get state() { return state; },
    asked: capability === "available" && Notification.permission !== "default",
    async enable() {
      if (capability === "install_required") return "install_required";
      if (capability !== "available") return "unsupported";
      const publicKey = configuredVapidPublicKey();
      if (!publicKey) {
        setState("error");
        return state;
      }
      try {
        const permission = await Notification.requestPermission();
        if (permission === "denied") {
          await deactivateServerSubscription();
          setState("denied");
          return state;
        }
        if (permission !== "granted") {
          setState("not_requested");
          return state;
        }
        setState("registering");
        const registration = await navigator.serviceWorker.ready;
        const applicationServerKey = decodeVapidPublicKey(publicKey);
        let existing = await registration.pushManager.getSubscription();
        if (existing && !applicationServerKeyMatches(existing, applicationServerKey)) {
          await deactivateServerSubscription();
          await existing.unsubscribe().catch(() => false);
          existing = null;
        }
        const subscription = existing ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        await registerSubscription(subscription);
        setState("registered");
      } catch {
        setState("error");
      }
      return state;
    },
    async deactivate() {
      await deactivateWebPushSubscription();
      setState(webPushStateFor(
        capability,
        capability === "available" ? Notification.permission : "default",
        false,
      ));
    },
    consumePending,
    async dispose() {
      disposed = true;
      window.removeEventListener(WEB_PUSH_PENDING_EVENT, onPending);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

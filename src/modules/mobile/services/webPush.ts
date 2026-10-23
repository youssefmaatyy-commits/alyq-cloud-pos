import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  PushController,
  PushConfigurationState,
  PushDiagnostics,
  PushPermissionState,
  PushRegistrationState,
  PushServiceWorkerState,
  PushSubscriptionState,
} from "./mobilePush";
import {
  clearPendingWebPushNotification,
  readPendingWebPushNotification,
  WEB_PUSH_PENDING_EVENT,
  WEB_PUSH_SUBSCRIPTION_EVENT,
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
export type WebPushPlatform = "ios" | "android" | "windows" | "macos" | "other";

/** Narrow test seam; production defaults retain the real browser/RPC adapters. */
export interface WebPushControllerDependencies {
  publicKey?: string;
  loadPublicKey?: () => Promise<string>;
  registerSubscription?: (subscription: PushSubscription) => Promise<void>;
  deactivateServerSubscription?: () => Promise<void>;
}

export function webPushPlatform(input: Pick<WebPushCapabilityInput, "userAgent" | "maxTouchPoints">): WebPushPlatform {
  if (/iPad|iPhone|iPod/i.test(input.userAgent)
      || (/Macintosh/i.test(input.userAgent) && input.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(input.userAgent)) return "android";
  if (/Windows/i.test(input.userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(input.userAgent)) return "macos";
  return "other";
}

export function currentWebPushPlatform(): WebPushPlatform {
  if (typeof navigator === "undefined") return "other";
  return webPushPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0 });
}

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
  if (webPushPlatform(input) === "ios" && !input.standalone) return "install_required";
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

/** The server fallback returns only the browser-safe public application key. */
async function serverVapidPublicKey(): Promise<string> {
  const client = getSupabaseClient();
  if (!client) return "";
  const { data, error } = await client.rpc("notification_web_push_public_config");
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid public Web Push configuration");
  const key = (data as Record<string, unknown>).public_key;
  return typeof key === "string" ? key.trim() : "";
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

function currentPermission(): PushPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  // `serviceWorker.ready` can remain pending forever after a failed worker
  // installation. Reuse the current registration or explicitly retry it so a
  // subscription failure becomes a visible, retryable error instead.
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ?? navigator.serviceWorker.register("/alyq-sw.js", { scope: "/" });
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
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
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
  dependencies: WebPushControllerDependencies = {},
): Promise<PushController> {
  const loadRemoteKey = dependencies.loadPublicKey ?? serverVapidPublicKey;
  let remoteKeyPromise: Promise<string> | null = null;
  const publicKey = async (): Promise<string> => {
    if (dependencies.publicKey !== undefined) return dependencies.publicKey;
    const embedded = configuredVapidPublicKey();
    if (embedded) return embedded;
    if (!remoteKeyPromise) {
      remoteKeyPromise = loadRemoteKey()
        .then((key) => {
          const normalized = key.trim();
          // A missing key may be repaired by an operator while ALYQ is open;
          // allow the next focus/online refresh to retry instead of caching it.
          if (!normalized) remoteKeyPromise = null;
          return normalized;
        })
        .catch((error: unknown) => {
          remoteKeyPromise = null;
          throw error;
        });
    }
    return remoteKeyPromise;
  };
  const register = dependencies.registerSubscription ?? registerSubscription;
  const deactivate = dependencies.deactivateServerSubscription ?? deactivateServerSubscription;
  const readConfiguration = async (): Promise<{
    applicationServerKey: ReturnType<typeof decodeVapidPublicKey> | null;
    state: PushConfigurationState;
  }> => {
    let key: string;
    try {
      key = await publicKey();
    } catch {
      return { applicationServerKey: null, state: "unavailable" };
    }
    if (!key) return { applicationServerKey: null, state: "missing" };
    try {
      return { applicationServerKey: decodeVapidPublicKey(key), state: "configured" };
    } catch {
      return { applicationServerKey: null, state: "invalid" };
    }
  };
  let capability = currentCapability();
  let permission = currentPermission();
  let serviceWorkerState: PushServiceWorkerState = capability === "unsupported" ? "unsupported" : "not_checked";
  let subscriptionState: PushSubscriptionState = capability === "unsupported" ? "unsupported" : "not_subscribed";
  let configurationState: PushConfigurationState = capability === "unsupported" ? "not_applicable" : "not_checked";
  let state: PushRegistrationState = webPushStateFor(
    capability,
    permission === "unsupported" ? "default" : permission,
    false,
  );
  let disposed = false;
  let permissionStatus: PermissionStatus | null = null;
  const setState = (next: PushRegistrationState) => {
    state = next;
    if (!disposed) onState(next);
  };
  const consumePending = () => consumePendingWebPushNotification(navigate, onNotificationsChanged);

  const performRefresh = async () => {
    // Permission and install capability are live browser facts, not a one-time
    // login snapshot. This also repairs a stale Denied badge after Chrome or
    // system settings change while ALYQ remains open.
    capability = currentCapability();
    permission = currentPermission();
    if (capability !== "available") {
      serviceWorkerState = capability === "unsupported" ? "unsupported" : "not_checked";
      subscriptionState = capability === "unsupported" ? "unsupported" : "not_subscribed";
      configurationState = capability === "unsupported" ? "not_applicable" : "not_checked";
      setState(capability === "install_required" ? "install_required" : "unsupported");
      return;
    }

    const configuration = await readConfiguration();
    configurationState = configuration.state;
    serviceWorkerState = "registering";
    let registration: ServiceWorkerRegistration | null = null;
    try {
      registration = await serviceWorkerRegistration();
      serviceWorkerState = "registered";
    } catch {
      serviceWorkerState = "error";
    }

    if (permission === "denied") {
      subscriptionState = "not_subscribed";
      await deactivate();
      setState("denied");
      return;
    }
    if (permission !== "granted") {
      subscriptionState = "not_subscribed";
      setState("not_requested");
      return;
    }
    const applicationServerKey = configuration.applicationServerKey;
    if (!registration || !applicationServerKey) {
      subscriptionState = "error";
      setState("error");
      return;
    }
    try {
      const currentSubscription = await registration.pushManager.getSubscription();
      if (!currentSubscription) {
        subscriptionState = "not_subscribed";
        setState("granted");
        return;
      }
      if (!applicationServerKeyMatches(currentSubscription, applicationServerKey)) {
        await deactivate();
        await currentSubscription.unsubscribe().catch(() => false);
        subscriptionState = "not_subscribed";
        setState("granted");
        return;
      }
      subscriptionState = "registering";
      setState("registering");
      await register(currentSubscription);
      subscriptionState = "registered";
      setState("registered");
    } catch {
      subscriptionState = "error";
      setState("error");
    }
  };

  // Permission, visibility, network and provider events may arrive together.
  // Serialize refreshes so an older RPC result cannot overwrite newer facts.
  let refreshQueue: Promise<void> = Promise.resolve();
  const refresh = () => {
    const next = refreshQueue.then(performRefresh);
    refreshQueue = next.catch(() => undefined);
    return next;
  };

  const onPending = () => { void consumePending(); };
  const onOnline = () => { void refresh(); void consumePending(); };
  const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
  const onPermissionChange = () => { void refresh(); };
  const onSubscriptionChange = () => { void refresh(); };
  window.addEventListener(WEB_PUSH_PENDING_EVENT, onPending);
  window.addEventListener(WEB_PUSH_SUBSCRIPTION_EVENT, onSubscriptionChange);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  try {
    permissionStatus = await navigator.permissions.query({ name: "notifications" });
    permissionStatus.addEventListener("change", onPermissionChange);
  } catch {
    // Safari and older WebKit do not expose the Notifications PermissionStatus.
    permissionStatus = null;
  }
  onState(state);
  await refresh().catch(() => {
    subscriptionState = "error";
    setState("error");
  });
  await consumePending().catch(() => undefined);

  return {
    get state() { return state; },
    get diagnostics(): PushDiagnostics {
      return {
        capability,
        permission,
        serviceWorker: serviceWorkerState,
        subscription: subscriptionState,
        configuration: configurationState,
      };
    },
    get asked() { return capability === "available" && permission !== "default" && permission !== "unsupported"; },
    async enable() {
      capability = currentCapability();
      permission = currentPermission();
      if (capability === "install_required") {
        serviceWorkerState = "not_checked";
        subscriptionState = "not_subscribed";
        configurationState = "not_checked";
        setState("install_required");
        return state;
      }
      if (capability !== "available") {
        serviceWorkerState = "unsupported";
        subscriptionState = "unsupported";
        configurationState = "not_applicable";
        setState("unsupported");
        return state;
      }
      const configuration = await readConfiguration();
      configurationState = configuration.state;
      if (permission === "denied") {
        subscriptionState = "not_subscribed";
        setState("denied");
        return state;
      }
      const applicationServerKey = configuration.applicationServerKey;
      if (!applicationServerKey) {
        subscriptionState = "error";
        setState("error");
        return state;
      }
      let serviceWorkerAttempted = false;
      try {
        permission = permission === "granted" ? "granted" : await Notification.requestPermission();
        if (permission === "denied") {
          subscriptionState = "not_subscribed";
          await deactivate();
          setState("denied");
          return state;
        }
        if (permission !== "granted") {
          subscriptionState = "not_subscribed";
          setState("not_requested");
          return state;
        }
        serviceWorkerAttempted = true;
        serviceWorkerState = "registering";
        subscriptionState = "registering";
        setState("registering");
        const registration = await serviceWorkerRegistration();
        serviceWorkerState = "registered";
        serviceWorkerAttempted = false;
        let existing = await registration.pushManager.getSubscription();
        if (existing && !applicationServerKeyMatches(existing, applicationServerKey)) {
          await deactivate();
          await existing.unsubscribe().catch(() => false);
          existing = null;
        }
        const currentSubscription = existing ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        await register(currentSubscription);
        subscriptionState = "registered";
        setState("registered");
      } catch {
        if (serviceWorkerAttempted) serviceWorkerState = "error";
        subscriptionState = "error";
        setState("error");
      }
      return state;
    },
    async deactivate() {
      await deactivateWebPushSubscription();
      capability = currentCapability();
      permission = currentPermission();
      if (capability === "unsupported") {
        serviceWorkerState = "unsupported";
        configurationState = "not_applicable";
      } else if (capability === "install_required") {
        serviceWorkerState = "not_checked";
        configurationState = "not_checked";
      }
      subscriptionState = capability === "unsupported" ? "unsupported" : "not_subscribed";
      setState(webPushStateFor(
        capability,
        permission === "unsupported" ? "default" : permission,
        false,
      ));
    },
    consumePending,
    async dispose() {
      disposed = true;
      window.removeEventListener(WEB_PUSH_PENDING_EVENT, onPending);
      window.removeEventListener(WEB_PUSH_SUBSCRIPTION_EVENT, onSubscriptionChange);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      permissionStatus?.removeEventListener("change", onPermissionChange);
    },
  };
}

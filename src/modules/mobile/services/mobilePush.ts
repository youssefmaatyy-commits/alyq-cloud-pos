import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { PushNotifications, type Token } from "@capacitor/push-notifications";
import { Preferences } from "@capacitor/preferences";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { AuthUser } from "@/lib/auth/types";
import { getMobileRuntime } from "./mobileRuntime";
import { authorizeMobileDeepLink, parseMobileDeepLink } from "./deepLinks";
import {
  markMobileNotificationRead,
  resolveMobileNotificationRoute,
  safeNotificationId,
} from "./notificationCenter";

const ASKED_KEY = "alyq.mobile.notifications.asked.v1";
const PENDING_NOTIFICATION_KEY = "alyq.mobile.notifications.pending-action.v1";
const ANDROID_CHANNEL_ID = "alyq_operational";

export type PushRegistrationState =
  | "unsupported"
  | "install_required"
  | "not_requested"
  | "granted"
  | "denied"
  | "registering"
  | "registered"
  | "error";

export interface PushController {
  state: PushRegistrationState;
  asked: boolean;
  enable: () => Promise<PushRegistrationState>;
  deactivate: () => Promise<void>;
  consumePending: () => Promise<void>;
  dispose: () => Promise<void>;
}

function currentLocale(): "en" | "ar" {
  return document.documentElement.lang.toLowerCase().startsWith("ar") ? "ar" : "en";
}

async function registerToken(token: Token): Promise<void> {
  if (!token.value || token.value.length > 4096) throw new Error("Invalid push token");
  const runtime = await getMobileRuntime();
  const client = getSupabaseClient();
  if (!client) throw new Error("Backend is unavailable");
  const { error } = await client.rpc("mobile_installation_register_v2", {
    p_installation_id: runtime.installationId,
    p_platform: runtime.platform,
    p_app_version: runtime.appVersion,
    p_push_token: token.value,
    p_locale: currentLocale(),
  });
  if (error) throw error;
}

export async function deactivateMobileInstallation(): Promise<void> {
  try {
    const runtime = await getMobileRuntime();
    const client = getSupabaseClient();
    if (!client) return;
    await client.rpc("mobile_installation_deactivate", { p_installation_id: runtime.installationId });
  } catch {
    // Logout must still end the local auth session if revocation cannot reach the server.
  }
}

/** Best-effort current-device cleanup shared by native and Home Screen PWA logout. */
export async function deactivateCurrentPushRegistration(): Promise<void> {
  if (Capacitor.isNativePlatform()) return deactivateMobileInstallation();
  try {
    const { deactivateWebPushSubscription } = await import("./webPush");
    await deactivateWebPushSubscription();
  } catch {
    // Web Push can never trap a user in an authenticated session.
  }
}

async function queueNotificationAction(data: Record<string, unknown>): Promise<boolean> {
  const notificationId = safeNotificationId(data);
  if (!notificationId) return false;
  await Preferences.set({ key: PENDING_NOTIFICATION_KEY, value: notificationId });
  return true;
}

/**
 * Resolve through the server after auth/branch restoration. A payload route is
 * never trusted. Transport failures keep the opaque ID queued for foreground or
 * reconnect; stale/unauthorized results can only open the safe inbox fallback.
 */
export async function consumePendingNotificationAction(
  navigate: (route: string) => void,
  onNotificationsChanged: () => void,
): Promise<void> {
  const pending = (await Preferences.get({ key: PENDING_NOTIFICATION_KEY })).value ?? "";
  const notificationId = safeNotificationId({ notification_id: pending });
  if (!notificationId) {
    if (pending) await Preferences.remove({ key: PENDING_NOTIFICATION_KEY });
    return;
  }
  const resolved = await resolveMobileNotificationRoute(notificationId);
  if (resolved.ok && resolved.route) {
    await markMobileNotificationRead(notificationId).catch(() => false);
    await Preferences.remove({ key: PENDING_NOTIFICATION_KEY });
    onNotificationsChanged();
    navigate(resolved.route);
    return;
  }
  if (resolved.reason === "unavailable") {
    // Preserve the ID for reconnect, but refuse payload-directed navigation.
    navigate("/mobile/notifications?notice=route_unavailable");
    return;
  }
  await Preferences.remove({ key: PENDING_NOTIFICATION_KEY });
  onNotificationsChanged();
  navigate(`/mobile/notifications?notice=${resolved.reason ?? "unauthorized_or_stale"}`);
}

async function ensureAndroidChannel(): Promise<void> {
  if (Capacitor.getPlatform() !== "android") return;
  await PushNotifications.createChannel({
    id: ANDROID_CHANNEL_ID,
    name: "ALYQ operational alerts",
    description: "Orders, approvals, inventory and synchronization attention",
    importance: 5,
    visibility: 1,
    vibration: true,
  });
}

/**
 * Native listeners expose fixed push/deep-link behavior only. No generic native
 * command, URL opener, filesystem, shell or arbitrary bridge is made available.
 */
export async function createPushController(
  user: AuthUser,
  navigate: (route: string) => void,
  onState: (state: PushRegistrationState) => void,
  onNotificationsChanged: () => void,
): Promise<PushController> {
  const native = Capacitor.isNativePlatform();
  if (!native) {
    const { createWebPushController } = await import("./webPush");
    return createWebPushController(navigate, onState, onNotificationsChanged);
  }
  const asked = (await Preferences.get({ key: ASKED_KEY })).value === "true";
  let state: PushRegistrationState = "not_requested";
  const handles: Array<{ remove: () => Promise<void> }> = [];
  const setState = (next: PushRegistrationState) => { state = next; onState(next); };
  const consumePending = () => consumePendingNotificationAction(navigate, onNotificationsChanged);

  if (native) {
    await ensureAndroidChannel().catch(() => undefined);
    const permission = await PushNotifications.checkPermissions();
    state = permission.receive === "granted" ? "registering"
      : permission.receive === "denied" ? "denied"
        : "not_requested";
    onState(state);
    if (permission.receive === "denied") await deactivateMobileInstallation();

    handles.push(await PushNotifications.addListener("registration", (token) => {
      void registerToken(token).then(() => setState("registered")).catch(() => setState("error"));
    }));
    handles.push(await PushNotifications.addListener("registrationError", () => setState("error")));
    handles.push(await PushNotifications.addListener("pushNotificationReceived", () => {
      // Foreground receipt refreshes the durable server inbox; it never routes.
      onNotificationsChanged();
    }));
    handles.push(await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
      void queueNotificationAction(event.notification.data ?? {}).then((queued) => {
        if (queued) return consumePending();
        navigate("/mobile/notifications?notice=invalid_payload");
      }).catch(() => navigate("/mobile/notifications?notice=route_unavailable"));
    }));
    handles.push(await App.addListener("appUrlOpen", (event) => {
      const link = authorizeMobileDeepLink(parseMobileDeepLink(event.url), user);
      if (link) navigate(link.route);
    }));
    handles.push(await App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) return;
      onNotificationsChanged();
      void consumePending();
      void PushNotifications.checkPermissions().then(async (current) => {
        if (current.receive === "denied") {
          await deactivateMobileInstallation();
          setState("denied");
        } else if (current.receive === "granted" && state !== "registered" && state !== "registering") {
          setState("registering");
          await PushNotifications.register();
        }
      }).catch(() => undefined);
    }));

    if (permission.receive === "granted") await PushNotifications.register();
    // A killed-state action may have been persisted during launch. This runs
    // only after AuthProvider and BranchProvider restored current authority.
    await consumePending();
  }

  return {
    get state() { return state; },
    asked,
    async enable() {
      if (!native) return "unsupported";
      await Preferences.set({ key: ASKED_KEY, value: "true" });
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== "granted") {
        await deactivateMobileInstallation();
        setState("denied");
        return state;
      }
      await ensureAndroidChannel().catch(() => undefined);
      setState("registering");
      await PushNotifications.register();
      return state;
    },
    async deactivate() {
      await deactivateMobileInstallation();
      await Preferences.remove({ key: PENDING_NOTIFICATION_KEY });
      try { await PushNotifications.unregister(); } catch { /* provider may be unavailable */ }
      setState(native ? "not_requested" : "unsupported");
    },
    consumePending,
    async dispose() {
      await Promise.all(handles.map((handle) => handle.remove()));
    },
  };
}

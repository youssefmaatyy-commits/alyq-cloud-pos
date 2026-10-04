import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { PushNotifications, type Token } from "@capacitor/push-notifications";
import { Preferences } from "@capacitor/preferences";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { AuthUser } from "@/lib/auth/types";
import { getMobileRuntime } from "./mobileRuntime";
import { authorizeMobileDeepLink, parseMobileDeepLink, safePushDeepLink } from "./deepLinks";

const ASKED_KEY = "alyq.mobile.notifications.asked.v1";

export type PushRegistrationState =
  | "unsupported"
  | "not_requested"
  | "denied"
  | "registering"
  | "registered"
  | "error";

export interface PushController {
  state: PushRegistrationState;
  asked: boolean;
  enable: () => Promise<PushRegistrationState>;
  deactivate: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function registerToken(token: Token): Promise<void> {
  if (!token.value || token.value.length > 4096) throw new Error("Invalid push token");
  const runtime = await getMobileRuntime();
  const client = getSupabaseClient();
  if (!client) throw new Error("Backend is unavailable");
  const { error } = await client.rpc("mobile_installation_register", {
    p_installation_id: runtime.installationId,
    p_platform: runtime.platform,
    p_app_version: runtime.appVersion,
    p_push_token: token.value,
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

/**
 * Native listeners expose fixed push/deep-link behavior only. No generic native
 * command, URL opener, filesystem, shell or arbitrary bridge is made available.
 */
export async function createPushController(
  user: AuthUser,
  navigate: (route: string) => void,
  onState: (state: PushRegistrationState) => void,
): Promise<PushController> {
  const native = Capacitor.isNativePlatform();
  const asked = (await Preferences.get({ key: ASKED_KEY })).value === "true";
  let state: PushRegistrationState = native ? "not_requested" : "unsupported";
  const handles: Array<{ remove: () => Promise<void> }> = [];
  const setState = (next: PushRegistrationState) => { state = next; onState(next); };

  if (native) {
    const permission = await PushNotifications.checkPermissions();
    state = permission.receive === "granted" ? "registering"
      : permission.receive === "denied" ? "denied"
        : "not_requested";
    onState(state);

    handles.push(await PushNotifications.addListener("registration", (token) => {
      void registerToken(token).then(() => setState("registered")).catch(() => setState("error"));
    }));
    handles.push(await PushNotifications.addListener("registrationError", () => setState("error")));
    handles.push(await PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
      const link = authorizeMobileDeepLink(safePushDeepLink(event.notification.data ?? {}), user);
      if (link) navigate(link.route);
    }));
    handles.push(await App.addListener("appUrlOpen", (event) => {
      const link = authorizeMobileDeepLink(parseMobileDeepLink(event.url), user);
      if (link) navigate(link.route);
    }));

    if (permission.receive === "granted") await PushNotifications.register();
  }

  return {
    get state() { return state; },
    asked,
    async enable() {
      if (!native) return "unsupported";
      await Preferences.set({ key: ASKED_KEY, value: "true" });
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== "granted") {
        setState("denied");
        return state;
      }
      setState("registering");
      await PushNotifications.register();
      return state;
    },
    async deactivate() {
      await deactivateMobileInstallation();
      try { await PushNotifications.unregister(); } catch { /* provider may be unavailable */ }
      setState(native ? "not_requested" : "unsupported");
    },
    async dispose() {
      await Promise.all(handles.map((handle) => handle.remove()));
    },
  };
}

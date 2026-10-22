import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";

const INSTALLATION_KEY = "alyq.mobile.installation.v1";

export type MobilePlatform = "android" | "ios" | "web";
export type MobileNetworkState = "online" | "offline" | "unknown";

export interface MobileRuntimeContext {
  native: boolean;
  platform: MobilePlatform;
  appVersion: string;
  build: string;
  installationId: string;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export function mobilePlatform(): MobilePlatform {
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios" ? platform : "web";
}

const NATIVE_POS_OVERRIDE_KEY = "alyq.mobile.native_pos.v1";

/**
 * True when running inside the installed Capacitor Android/iOS APK (or when
 * explicitly enabled for mobile POS runtime testing).
 */
export function isNativeMobileRuntime(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem(NATIVE_POS_OVERRIDE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * True when launched from an iPhone/iPad/Android Home Screen PWA icon
 * (`navigator.standalone === true` on iOS Safari or `display-mode: standalone`).
 */
export function isStandalonePwaRuntime(win: Window | undefined = typeof window !== "undefined" ? window : undefined): boolean {
  if (!win) return false;
  try {
    if ((win.navigator as { standalone?: boolean } | undefined)?.standalone === true) return true;
    if (typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // Ignore restricted window access in synthetic test harnesses.
  }
  return false;
}

/**
 * When the installed Capacitor APK or Home Screen PWA launches at the bare root
 * (empty or `#/` hash), route directly into the full ALYQ POS system
 * (`#/dashboard`) instead of the public customer storefront. Public browser tab
 * visits (`https://alyq-store.vercel.app`) are unaffected.
 */
export function normalizeNativeEntryUrl(win: Pick<Window, "location"> | undefined = typeof window !== "undefined" ? window : undefined): boolean {
  if (!win || (!isNativeMobileRuntime() && !isStandalonePwaRuntime(win as Window))) return false;
  const hash = win.location.hash ?? "";
  if (hash === "" || hash === "#" || hash === "#/") {
    win.location.hash = "#/dashboard";
    return true;
  }
  return false;
}

/** Stable management-device identity. It is never a cashier register. */
export async function getMobileInstallationId(): Promise<string> {
  const stored = await Preferences.get({ key: INSTALLATION_KEY });
  if (stored.value && /^[0-9a-f-]{36}$/i.test(stored.value)) return stored.value;
  const created = uuid();
  await Preferences.set({ key: INSTALLATION_KEY, value: created });
  return created;
}

export async function getMobileRuntime(): Promise<MobileRuntimeContext> {
  const native = Capacitor.isNativePlatform();
  const installationId = await getMobileInstallationId();
  const appVersion = import.meta.env.VITE_APP_VERSION || "6.0.0";
  let build = import.meta.env.VITE_BUILD_SHA || "development";
  if (native) {
    try {
      const info = await Device.getInfo();
      build = `${build} · ${info.operatingSystem} ${info.osVersion}`;
    } catch {
      // Runtime identity remains useful when a native device API is unavailable.
    }
  }
  return { native, platform: mobilePlatform(), appVersion, build, installationId };
}

export async function mobileNetworkState(): Promise<MobileNetworkState> {
  try {
    const status = await Network.getStatus();
    return status.connected ? "online" : "offline";
  } catch {
    return typeof navigator === "undefined" ? "unknown" : navigator.onLine ? "online" : "offline";
  }
}

/** Management writes are never queued. Call immediately before an authoritative write. */
export async function requireMobileOnline(): Promise<void> {
  if (await mobileNetworkState() !== "online") {
    throw Object.assign(new Error("This management action requires an online authoritative connection."), {
      code: "OFFLINE_AUTHORITY_REQUIRED",
    });
  }
}

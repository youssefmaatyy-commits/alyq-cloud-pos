import { Capacitor } from "@capacitor/core";

/** One canonical wake vocabulary, independent of the UI shell using it. */
export type SessionWakeEvent =
  | { kind: "browser_foreground"; backgroundMs: number }
  | { kind: "native_foreground"; backgroundMs: number }
  | { kind: "online"; backgroundMs: null };

export const SESSION_RESUME_MIN_BACKGROUND_MS = 60_000;
export const SESSION_WAKE_DEDUP_MS = 250;
const ACCESS_REFRESH_AHEAD_MS = 5 * 60 * 1000;

interface ListenerHandle {
  remove(): Promise<void>;
}

interface LifecycleEnvironment {
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  now?: () => number;
  native?: {
    active: boolean;
    addListener(listener: (active: boolean) => void): Promise<ListenerHandle>;
    addNetworkListener?(listener: (connected: boolean) => void): Promise<ListenerHandle>;
  };
}

/**
 * Whether a wake should ask the provider now. Native foreground and reconnect
 * are always authority boundaries. Browser focus is thresholded to avoid a
 * request for every quick alt-tab, unless the access token is already near its
 * refresh window.
 */
export function shouldRevalidateAfterWake(
  event: SessionWakeEvent,
  expiresAt: string | null,
  now = Date.now(),
): boolean {
  if (event.kind === "online" || event.kind === "native_foreground") return true;
  if (event.backgroundMs >= SESSION_RESUME_MIN_BACKGROUND_MS) return true;
  const expiry = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  return Number.isNaN(expiry) || expiry - now <= ACCESS_REFRESH_AHEAD_MS;
}

/**
 * Platform signal adapter only. Auth decisions remain in AuthProvider, while
 * Web/Desktop share focus + visibility + online signals and Capacitor adds its
 * native app-state and network signals. Duplicate focus/visibility/native
 * events emitted by one foreground transition collapse into one callback.
 */
export function subscribeSessionWakeEvents(
  listener: (event: SessionWakeEvent) => void,
  environment: LifecycleEnvironment = {},
): () => void {
  const win = environment.window ?? (typeof window !== "undefined" ? window : undefined);
  const doc = environment.document ?? (typeof document !== "undefined" ? document : undefined);
  const now = environment.now ?? Date.now;
  let backgroundedAt: number | null = null;
  let lastWakeAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  const nativeHandles: ListenerHandle[] = [];
  const native = environment.native;
  const isNative = native?.active ?? Capacitor.isNativePlatform();

  const markBackgrounded = () => {
    if (backgroundedAt === null) backgroundedAt = now();
  };
  const emitForeground = (kind: "browser_foreground" | "native_foreground") => {
    if (kind === "browser_foreground" && doc?.visibilityState === "hidden") return;
    if (backgroundedAt === null) return;
    const at = now();
    const elapsed = Math.max(0, at - backgroundedAt);
    backgroundedAt = null;
    if (at - lastWakeAt < SESSION_WAKE_DEDUP_MS) return;
    lastWakeAt = at;
    listener({ kind, backgroundMs: elapsed });
  };
  const foregroundKind = isNative ? "native_foreground" : "browser_foreground";
  const onVisibility = () => {
    if (doc?.visibilityState === "hidden") markBackgrounded();
    else emitForeground(foregroundKind);
  };
  const onBlur = () => markBackgrounded();
  const onFocus = () => emitForeground(foregroundKind);
  const onOnline = () => {
    const at = now();
    if (at - lastWakeAt < SESSION_WAKE_DEDUP_MS) return;
    lastWakeAt = at;
    listener({ kind: "online", backgroundMs: null });
  };

  doc?.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("blur", onBlur);
  win?.addEventListener("focus", onFocus);
  win?.addEventListener("online", onOnline);

  const registerNativeApp = native?.active
    ? native.addListener
    : isNative
      ? async (callback: (active: boolean) => void) => {
          const { App } = await import("@capacitor/app");
          return App.addListener("appStateChange", ({ isActive }) => callback(isActive));
        }
      : null;
  const registerNativeNetwork = native?.active
    ? native.addNetworkListener ?? null
    : isNative
      ? async (callback: (connected: boolean) => void) => {
          const { Network } = await import("@capacitor/network");
          return Network.addListener("networkStatusChange", ({ connected }) => callback(connected));
        }
      : null;

  const keepNativeHandle = (handle: ListenerHandle) => {
    if (disposed) void handle.remove();
    else nativeHandles.push(handle);
  };
  if (registerNativeApp) {
    void registerNativeApp((active) => {
      if (!active) markBackgrounded();
      else emitForeground("native_foreground");
    }).then(keepNativeHandle).catch(() => {
      // Lifecycle observation is best effort; browser signals remain active.
    });
  }
  if (registerNativeNetwork) {
    void registerNativeNetwork((connected) => {
      if (connected) onOnline();
    }).then(keepNativeHandle).catch(() => {
      // Browser online events and future foreground recovery remain available.
    });
  }

  return () => {
    disposed = true;
    doc?.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("blur", onBlur);
    win?.removeEventListener("focus", onFocus);
    win?.removeEventListener("online", onOnline);
    for (const handle of nativeHandles) void handle.remove();
  };
}

import { getStorageKind, isStorageDurable } from "./db";

/**
 * Shared application connectivity facts.
 *
 * Browser events are hints, real Supabase requests are evidence, sync activity
 * is a separate concern, and session usability is never inferred from a green
 * network icon. There is no eager polling here; the authenticated provider owns
 * one bounded recovery probe while degraded/offline.
 */
export type ConnectivityStatus = "online" | "offline";
export type ApplicationConnectivityState = "online" | "offline" | "syncing" | "degraded" | "sync_error";
export type BackendReachability = "unknown" | "reachable" | "unavailable";
export type SessionUsability = "unknown" | "usable" | "expired";

export interface ConnectivitySnapshot {
  state: ApplicationConnectivityState;
  browserOnline: boolean | null;
  backend: BackendReachability;
  session: SessionUsability;
  storage: "indexeddb" | "memory";
  storageDurable: boolean;
  syncing: boolean;
  syncError: boolean;
  pending: number;
  failed: number;
  deferred: number;
  conflicts: number;
  lastBackendSuccessAt: string | null;
  lastBackendFailureAt: string | null;
}

type Listener = (status: ConnectivityStatus) => void;
type SnapshotListener = (snapshot: ConnectivitySnapshot) => void;
const listeners = new Set<Listener>();
const snapshotListeners = new Set<SnapshotListener>();

function browserSignal(): boolean | null {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return null;
  return navigator.onLine;
}

let status: ConnectivityStatus = browserSignal() === false ? "offline" : "online";
let browserOnline: boolean | null = browserSignal();
let backend: BackendReachability = "unknown";
let session: SessionUsability = "unknown";
let syncing = false;
let syncError = false;
let pending = 0;
let failed = 0;
let deferred = 0;
let conflicts = 0;
let lastBackendSuccessAt: string | null = null;
let lastBackendFailureAt: string | null = null;
let wired = false;

function applicationState(): ApplicationConnectivityState {
  if (browserOnline === false) return "offline";
  if (syncing) return "syncing";
  if (backend === "unavailable") return "degraded";
  if (syncError || failed > 0 || conflicts > 0) return "sync_error";
  if (backend !== "reachable" || session !== "usable") return "degraded";
  return "online";
}

function snapshot(): ConnectivitySnapshot {
  return {
    state: applicationState(),
    browserOnline,
    backend,
    session,
    storage: getStorageKind(),
    storageDurable: isStorageDurable(),
    syncing,
    syncError,
    pending,
    failed,
    deferred,
    conflicts,
    lastBackendSuccessAt,
    lastBackendFailureAt,
  };
}

function emit(previousStatus?: ConnectivityStatus) {
  if (previousStatus && previousStatus !== status) {
    for (const listener of [...listeners]) listener(status);
  }
  const value = snapshot();
  for (const listener of [...snapshotListeners]) listener(value);
}

function setTransport(next: ConnectivityStatus) {
  const previous = status;
  status = next;
  emit(previous);
}

function wireBrowserEvents() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", () => {
    browserOnline = true;
    backend = "unknown";
    setTransport("online");
  });
  window.addEventListener("offline", () => {
    browserOnline = false;
    backend = "unavailable";
    lastBackendFailureAt = new Date().toISOString();
    setTransport("offline");
  });
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) {
    void import("@capacitor/network")
      .then(({ Network }) =>
        Network.addListener("networkStatusChange", (state) => {
          if (state.connected) {
            browserOnline = true;
            backend = "unknown";
            setTransport("online");
          } else {
            browserOnline = false;
            backend = "unavailable";
            lastBackendFailureAt = new Date().toISOString();
            setTransport("offline");
          }
        }),
      )
      .catch(() => undefined);
  }
}

/** Legacy transport decision used by the POS completion boundary. */
export function getConnectivityStatus(): ConnectivityStatus {
  wireBrowserEvents();
  return status;
}

export function getConnectivitySnapshot(): ConnectivitySnapshot {
  wireBrowserEvents();
  return snapshot();
}

export function subscribeConnectivity(listener: Listener): () => void {
  wireBrowserEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeConnectivitySnapshot(listener: SnapshotListener): () => void {
  wireBrowserEvents();
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

/** A real backend response, including an authoritative refusal, proves reachability. */
export function reportNetworkResult(outcome: "success" | "network-error" | "other-error"): void {
  wireBrowserEvents();
  if (outcome === "network-error") {
    backend = "unavailable";
    lastBackendFailureAt = new Date().toISOString();
    setTransport("offline");
  } else {
    backend = "reachable";
    lastBackendSuccessAt = new Date().toISOString();
    setTransport("online");
  }
}

export function reportBackendProbe(reachable: boolean): void {
  reportNetworkResult(reachable ? "success" : "network-error");
}

export function reportSessionUsability(value: SessionUsability): void {
  session = value;
  emit();
}

export function reportQueueHealth(counts: { pending: number; failed: number; deferred: number; conflicts: number }): void {
  pending = Math.max(0, counts.pending);
  failed = Math.max(0, counts.failed);
  deferred = Math.max(0, counts.deferred);
  conflicts = Math.max(0, counts.conflicts);
  syncError = failed > 0 || conflicts > 0;
  emit();
}

export function reportSyncActivity(activity: "syncing" | "idle" | "error"): void {
  syncing = activity === "syncing";
  if (activity === "error") syncError = true;
  if (activity === "idle" && failed === 0 && conflicts === 0) syncError = false;
  emit();
}

/** Test-only reset. */
export function resetConnectivityForTests(initial: ConnectivityStatus = "online"): void {
  listeners.clear();
  snapshotListeners.clear();
  status = initial;
  browserOnline = initial === "online";
  backend = initial === "online" ? "reachable" : "unavailable";
  session = "usable";
  syncing = false;
  syncError = false;
  pending = failed = deferred = conflicts = 0;
  lastBackendSuccessAt = null;
  lastBackendFailureAt = null;
  wired = false;
}

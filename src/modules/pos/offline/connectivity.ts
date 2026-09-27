/**
 * Connectivity detection for the till.
 *
 * `navigator.onLine` alone is a well-known unreliable signal — it can read
 * `true` while connected to a LAN/router with no real path to Supabase, and
 * some environments never fire `online`/`offline` reliably. So this module
 * combines two signals:
 *
 *   1. the browser's own `online`/`offline` events (a real, if imperfect,
 *      hint — going through a captive portal or airplane mode does fire
 *      these), used as the resting/default state;
 *   2. `reportNetworkResult()`, called by the code that actually talks to
 *      Supabase (catalog load, sale completion, the sync engine) every time
 *      a request truly succeeds or fails with a network-classified error
 *      (`AppError` code `NETWORK` — see `products/data/repository.ts`).
 *      A single real failure flips the status to offline immediately, even
 *      if `navigator.onLine` still claims otherwise; a single real success
 *      flips it back.
 *
 * This is intentionally not a periodic background ping: the app already
 * makes frequent real requests (catalog reloads, realtime, sales refresh),
 * and piggy-backing on those is enough signal without adding a dedicated
 * polling loop that could itself look like suspicious traffic or drain a
 * battery for no reason. The sync engine (`outbox.ts`) does add one bounded,
 * infrequent timer of its own — see its header — which is the only polling
 * in this feature.
 */

export type ConnectivityStatus = "online" | "offline";

type Listener = (status: ConnectivityStatus) => void;

const listeners = new Set<Listener>();

function initialStatus(): ConnectivityStatus {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return "online";
  return navigator.onLine ? "online" : "offline";
}

let status: ConnectivityStatus = initialStatus();
let wired = false;

function setStatus(next: ConnectivityStatus) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener(status);
}

function wireBrowserEvents() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("online", () => setStatus("online"));
  window.addEventListener("offline", () => setStatus("offline"));
}

/** Current best-known connectivity state. */
export function getConnectivityStatus(): ConnectivityStatus {
  wireBrowserEvents();
  return status;
}

/** Subscribe to status changes. Returns an unsubscribe function. */
export function subscribeConnectivity(listener: Listener): () => void {
  wireBrowserEvents();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Called by real network call sites with what actually happened. `"network"`
 * failures (no route to the server — DNS/TCP/fetch-level) flip the status to
 * offline at once; any other outcome (including a rejected/validation error,
 * which proves the request DID reach the server) flips it back online,
 * because reaching the server to be refused is still reaching the server.
 */
export function reportNetworkResult(outcome: "success" | "network-error" | "other-error"): void {
  wireBrowserEvents();
  if (outcome === "network-error") setStatus("offline");
  else setStatus("online");
}

/** Test-only: reset the module's listeners/status between selftest cases. */
export function resetConnectivityForTests(initial: ConnectivityStatus = "online"): void {
  listeners.clear();
  status = initial;
  wired = false;
}

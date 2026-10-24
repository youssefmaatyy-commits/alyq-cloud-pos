/**
 * Web/PWA update detector — polls the version manifest and notifies the shell.
 *
 * Design:
 * - Polls /version.json with cache: no-store every POLL_INTERVAL.
 * - Compares manifest.current.version against APP_VERSION (inlined at build).
 * - Dispatches a CustomEvent "alyq:update-available" when a newer version is found.
 * - Never overwrites localStorage / IndexedDB / offline queue.
 * - Handles offline gracefully: failed fetches are silently retried next interval.
 * - Exposes `checkNow()` for manual checks and `dismiss()` to hide the banner for the session.
 */

import { APP_VERSION } from "@/lib/appVersion";

export const UPDATE_CHECK_EVENT = "alyq:update-available";
export const UPDATE_DISMISS_EVENT = "alyq:update-dismissed";
export const UPDATE_APPLIED_EVENT = "alyq:update-applied";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  gitSha: string;
  releasedAt: string;
  releaseNotes: { en: string; ar: string };
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DISMISS_KEY = "alyq.update.dismissed.v1";

function manifestVersionCompare(a: string, b: string): number | null {
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  function parse(v: string) {
    const m = SEMVER.exec(v.trim().replace(/^v/i, ""));
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : null as string[] | null };
  }
  const x = parse(a); const y = parse(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"] as const) { if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1; }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  const len = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < len; i++) {
    const xv = x.pre[i]; const yv = y.pre[i];
    if (xv === undefined || yv === undefined) return xv === yv ? 0 : xv === undefined ? -1 : 1;
    if (xv === yv) continue;
    const xn = /^\d+$/.test(xv); const yn = /^\d+$/.test(yv);
    if (xn && yn) return Number(xv) > Number(yv) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return xv > yv ? 1 : -1;
  }
  return 0;
}

function parseVersionManifest(raw: unknown): { version: string; gitSha: string; releasedAt: string; releaseNotes: { en: string; ar: string } } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const current = r.current as Record<string, unknown> | undefined;
  if (!current || typeof current.version !== "string") return null;
  const releaseNotes = current.releaseNotes as { en: string; ar: string } | undefined;
  return {
    version: current.version,
    gitSha: typeof current.gitSha === "string" ? current.gitSha : "",
    releasedAt: typeof current.releasedAt === "string" ? current.releasedAt : "",
    releaseNotes: releaseNotes ?? { en: "", ar: "" },
  };
}

export function isUpdateDismissed(version: string): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage?.getItem(DISMISS_KEY) === version;
  } catch { return false; }
}

export function dismissUpdate(version: string): void {
  try { window.sessionStorage?.setItem(DISMISS_KEY, version); } catch { /* session-only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UPDATE_DISMISS_EVENT, { detail: version }));
}

export function clearDismissedUpdate(): void {
  try { window.sessionStorage?.removeItem(DISMISS_KEY); } catch { /* best effort */ }
}

/**
 * Fetch and compare the remote manifest against the running version.
 * Returns UpdateInfo when a newer version exists, null otherwise.
 * Never throws — network/parse failures return null.
 */
export async function checkForWebUpdate(fetcher: typeof fetch = fetch): Promise<UpdateInfo | null> {
  try {
    const url = `/version.json?_=${Date.now()}`;
    const response = await fetcher(url, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    const manifest = parseVersionManifest(raw);
    if (!manifest) return null;
    const cmp = manifestVersionCompare(manifest.version, APP_VERSION);
    if (cmp === null || cmp <= 0) return null;
    if (isUpdateDismissed(manifest.version)) return null;
    return {
      currentVersion: APP_VERSION,
      latestVersion: manifest.version,
      gitSha: manifest.gitSha,
      releasedAt: manifest.releasedAt,
      releaseNotes: manifest.releaseNotes,
    };
  } catch { return null; }
}

/**
 * Apply the update safely:
 * 1. Unregister any stale service worker caches are handled by the SW itself.
 * 2. Reload — browser fetches fresh index.html (no-store via Vercel cache headers).
 * 3. LocalStorage/IndexedDB/offline queue remain untouched.
 */
export function applyWebUpdate(): void {
  clearDismissedUpdate();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UPDATE_APPLIED_EVENT));
    window.location.reload();
  }
}

let pollTimer: number | null = null;
let lastNotifiedVersion: string | null = null;

function notifyUpdate(info: UpdateInfo): void {
  if (lastNotifiedVersion === info.latestVersion) return;
  lastNotifiedVersion = info.latestVersion;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UPDATE_CHECK_EVENT, { detail: info }));
  }
}

function isTestMode(): boolean {
  try { return (import.meta.env as Record<string, unknown>).MODE === "test"; } catch { return false; }
}

/**
 * Start periodic polling. Safe to call multiple times — only one poller runs.
 * No-ops in test/jsdom mode (MODE === "test") so the E2E demo harness's
 * zero-network invariant is not broken.
 * Call `stopWebUpdatePolling()` to cancel (e.g. in tests).
 */
export function startWebUpdatePolling(): void {
  if (isTestMode()) return;
  if (pollTimer !== null) return;
  const tick = async () => {
    const info = await checkForWebUpdate();
    if (info) notifyUpdate(info);
  };
  // Check once after a short delay so app boots first
  window.setTimeout(tick, 30_000);
  pollTimer = window.setInterval(tick, POLL_INTERVAL_MS);

  // Also check when tab becomes visible and when network reconnects
  const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
  const onOnline = () => void tick();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);

  // Expose manual check via event
  window.addEventListener("alyq:check-update-now", () => void tick());
}

export function stopWebUpdatePolling(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  lastNotifiedVersion = null;
}

export function triggerManualUpdateCheck(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("alyq:check-update-now"));
}

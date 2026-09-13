/**
 * Where "open the website" goes.
 *
 * The shop is a public route inside this same bundle: `#/store`, rendered by
 * `StorefrontApp` as a top-level route OUTSIDE the authenticated shell. That is
 * the default target, and it is deliberately internal navigation rather than
 * `window.open`:
 *
 *   - demo mode and live mode behave identically (no second origin to host);
 *   - there is no popup, so no popup blocker can swallow the click — the failure
 *     mode that makes the receipt print path need a hidden-iframe fallback;
 *   - a cashier on a locked-down till browser cannot lose the window.
 *
 * A deployment that serves the shop from its own origin sets
 * `VITE_STOREFRONT_URL`, and the same control becomes an anchor to it. The value
 * is validated rather than trusted: it ends up in an `href`, and an `href` taken
 * from configuration is an injection point (`javascript:` and `data:` both
 * execute in that position). Anything that is not a usable http(s) URL is
 * rejected, the built-in shop is used instead, and the caller is handed a
 * `warning` so the misconfiguration is reported on screen instead of silently
 * doing something other than what the operator configured.
 */

/** Internal hash route of the storefront shipped in this bundle. */
export const STOREFRONT_ROUTE = "/store";

/** Why a configured URL was refused. Surfaced to the user, never swallowed. */
export type StorefrontWarning = "invalid_url";

export type StorefrontTarget = {
  /** Absolute external URL, or `null` to navigate internally. */
  href: string | null;
  /** Internal route used when `href` is null. Always `/store`. */
  to: string;
  /** Set when `VITE_STOREFRONT_URL` was present but unusable. */
  warning: StorefrontWarning | null;
};

const INTERNAL: StorefrontTarget = { href: null, to: STOREFRONT_ROUTE, warning: null };

/** Only http(s) may be linked to. Everything else is refused outright. */
function toSafeHttpUrl(value: string, origin: string): string | null {
  // A value carrying a scheme separator that is not http(s) is a typo
  // (`://shop.example.com`) or a hostile scheme (`ftp://`, `ws://`). Refuse it
  // here: `new URL` would otherwise happily resolve it as a relative path and
  // hand back a link that 404s on this origin, with no warning at all.
  if (/^[^/]*:\/\//.test(value) && !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value, origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    // Not parseable even as a relative path (`http://`, `https://`, …).
    return null;
  }
}

/**
 * Resolve the storefront target.
 *
 * Both arguments default to the running app's own configuration and origin; they
 * are parameters so the three cases (unset, valid, invalid) can be tested
 * without stubbing `import.meta.env` or a DOM.
 */
export function resolveStorefrontTarget(
  configured?: string,
  origin?: string,
): StorefrontTarget {
  // Read defensively: `import.meta.env` exists under Vite but is undefined when
  // this module is bundled for node by the logic-test runner, and throwing on a
  // missing environment would take the register screen down with it.
  const fromEnvironment =
    configured !== undefined
      ? configured
      : (import.meta as unknown as { env?: { VITE_STOREFRONT_URL?: string } }).env
          ?.VITE_STOREFRONT_URL;
  const value = (fromEnvironment ?? "").trim();
  const base = origin ?? (typeof window === "undefined" ? "http://localhost" : window.location.origin);

  // Unset or blank: the built-in shop. This is the demo-mode and default
  // live-mode answer, and it needs no configuration at all.
  if (value.length === 0) return INTERNAL;

  const href = toSafeHttpUrl(value, base);
  if (href) return { href, to: STOREFRONT_ROUTE, warning: null };

  // Configured but unusable. Still openable — just not where the operator
  // asked — so the caller must say so.
  return { href: null, to: STOREFRONT_ROUTE, warning: "invalid_url" };
}

/* ── opening the shop beside the current screen ──────────────────────────────
 *
 * `target="_blank"` on an anchor reports nothing when it is refused. This app
 * runs inside an iframe in the hosted preview — `printHtmlDocument` already
 * computes `window.self !== window.top` for exactly that reason — and an
 * embedded host, like a popup blocker, swallows the new tab silently. The
 * control then looks dead: the click lands, the browser declines, and the user
 * is left staring at the register. That is the bug behind "Open website does
 * nothing".
 *
 * `window.open` is the same request in a form that reports failure, returning
 * null when refused. So the anchors keep `target="_blank"` — middle-click,
 * ctrl-click and "open in new tab" all still work — and take over the plain
 * click to fall back to this tab when a new one is not on offer.
 */

/** True only in a Vite dev build, so field diagnostics never ship to production. */
const isDev =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

function debug(detail: Record<string, unknown>): void {
  if (isDev) console.log("[storefront]", detail);
}

/**
 * Ask the browser for a new tab and report honestly whether it obliged.
 * Never throws: a refused popup is an expected condition, not an error.
 */
export function tryOpenBeside(href: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const opened = window.open(href, "_blank", "noopener,noreferrer");
    // Refused popups return null; jsdom's unimplemented stub returns undefined.
    const allowed = opened != null && !opened.closed;
    debug({ click: true, requested: href, newTab: allowed });
    return allowed;
  } catch (error) {
    debug({ click: true, requested: href, newTab: false, threw: String(error).slice(0, 120) });
    return false;
  }
}

/**
 * Open the shop bundled in this app: new tab if the browser allows one, this
 * tab if it does not. Returns which happened so a caller can say so.
 */
export function openStorefrontRoute(): "new-tab" | "same-tab" {
  const href = `#${STOREFRONT_ROUTE}`;
  if (tryOpenBeside(href)) return "new-tab";
  if (typeof window !== "undefined") {
    // Assigning the hash raises a hashchange, which HashRouter turns into an
    // in-app navigation: no reload, and the register keeps its cart.
    window.location.hash = STOREFRONT_ROUTE;
    debug({ click: true, requested: href, navigationTarget: STOREFRONT_ROUTE, fellBackTo: "same-tab" });
  }
  return "same-tab";
}

/**
 * Open an externally hosted shop the same way. When a new tab is refused the
 * only option left is to navigate this frame, so that is what happens.
 */
export function openExternalStorefront(href: string): "new-tab" | "same-tab" {
  if (tryOpenBeside(href)) return "new-tab";
  if (typeof window !== "undefined") {
    window.location.assign(href);
    debug({ click: true, requested: href, fellBackTo: "same-tab" });
  }
  return "same-tab";
}

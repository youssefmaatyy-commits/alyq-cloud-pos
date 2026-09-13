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

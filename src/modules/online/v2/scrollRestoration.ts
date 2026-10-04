/** Centralized scroll behaviour for every `/store/*` route change.
 *
 * React Router's client-side navigation never touches window scroll on its
 * own -- unlike a real page load, pushing a new history entry does not reset
 * `window.scrollY`. Without this, a shopper who scrolls down a catalogue or
 * product page and opens a *different* page (even the very same route
 * component with new params, e.g. one product to another) lands exactly
 * where the previous page left off, because the document never actually
 * reloaded.
 *
 * The fix is one hook, mounted once in `StorefrontV2Shell` (every `/store/*`
 * page renders inside it) -- not a scattering of `window.scrollTo()` calls
 * on individual links/buttons:
 *
 *   - PUSH/REPLACE (a genuinely new destination -- another product, the
 *     cart, checkout, home, catalogue, confirmation, etc.) always starts at
 *     the top, the same way a normal link/page load would.
 *   - POP (browser Back/Forward) restores the scroll position that specific
 *     history entry had when the shopper left it, keyed by React Router's
 *     own per-entry `location.key` -- not the path, so visiting the same
 *     path twice in one session (e.g. Catalogue -> Product -> Catalogue)
 *     keeps two independent saved positions instead of confusing them.
 *
 * `decideV2Scroll` is the pure decision at the centre of this, kept free of
 * `window`/React so it can be unit-tested directly.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

/** react-router's own `NavigationType` is a real TS enum (`Action`), so a
 * plain string literal like `"POP"` doesn't type-check against it even
 * though the runtime values are identical strings. Mirroring just the
 * string values here keeps this decision pure and framework-free (as the
 * module doc above promises) and trivially unit-testable without importing
 * react-router at all. */
export type V2NavigationType = "POP" | "PUSH" | "REPLACE";

/** Given how we arrived at this history entry and whatever scroll offset was
 * previously recorded for it (if any), what should the page's scroll offset
 * be now? PUSH/REPLACE are always a new destination -> 0. POP restores the
 * saved value, defaulting to the top for an entry we never visited before
 * (e.g. the very first load, or a fresh deep link). */
export function decideV2Scroll(navigationType: V2NavigationType, savedPosition: number | undefined): number {
  if (navigationType === "POP" && typeof savedPosition === "number") return Math.max(0, savedPosition);
  return 0;
}

export function useV2ScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const positions = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Let our own per-entry cache be the single source of truth for the
    // lifetime of the storefront shell; some browsers otherwise replay their
    // own guess for a POP immediately before (or after) the one below,
    // producing a visible double-jump. Restored on unmount so leaving the
    // storefront for another part of the app (admin, POS) never leaves the
    // rest of the SPA's history behaviour altered.
    if (typeof window === "undefined" || !("scrollRestoration" in window.history)) return;
    const previous = window.history.scrollRestoration;
    try { window.history.scrollRestoration = "manual"; } catch { /* unsupported browser; no-op */ }
    return () => { try { window.history.scrollRestoration = previous; } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = decideV2Scroll(navigationType as unknown as V2NavigationType, positions.current.get(location.key));
    window.scrollTo({ top: target, left: 0, behavior: "auto" });
    // Re-run only when the history entry actually changes -- not on every
    // render -- so a POP's restored position is not immediately clobbered by
    // an unrelated re-render of the same page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = location.key;
    const save = () => positions.current.set(key, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      save(); // capture the final position even if no 'scroll' event fired after the last one
      window.removeEventListener("scroll", save);
    };
  }, [location.key]);
}

/**
 * Recovery URLs — making a reset email's link land on the reset page.
 *
 * This app routes on the URL *fragment* (`HashRouter`), and Supabase Auth's
 * implicit flow also delivers its recovery material in the fragment
 * (`#access_token=…&type=recovery`). Those two collide: the browser keeps one
 * fragment, so a link built for `https://till/#/reset-password` arrives as
 * `https://till/#access_token=…` and the route is gone — the person who followed
 * the link lands on the dashboard with a token nobody read.
 *
 * `normalizeRecoveryUrl()` fixes that once, before any router looks at the
 * location, by moving the tokens into the hash route's own query string:
 *
 *   #access_token=X&type=recovery  →  #/reset-password?access_token=X&type=recovery
 *
 * PKCE needs no rewriting (`?code=…` sits in the search part, which HashRouter
 * leaves alone), but `readRecoveryParts()` collects both places so the reset page
 * does not have to know which flow the project is configured for.
 *
 * Nothing here validates a token. It only carries it to the page that will hand
 * it to the provider.
 */
import type { RecoveryLinkParts } from "../data/repository";

/** Parameters Supabase puts on a recovery, magic-link or OAuth redirect. */
const RECOVERY_PARAMS = [
  "access_token",
  "refresh_token",
  "token_type",
  "expires_in",
  "expires_at",
  "type",
  "code",
  "error",
  "error_description",
] as const;

/** Does this query/fragment carry anything a recovery would use? */
function hasRecoveryParams(value: string): boolean {
  if (!value) return false;
  const params = paramsFromChunk(value);
  return RECOVERY_PARAMS.some((key) => params.has(key));
}

export interface LocationLike {
  search: string;
  hash: string;
}

function currentLocation(): LocationLike {
  const location = globalThis.location;
  return { search: location?.search ?? "", hash: location?.hash ?? "" };
}

/** True when the current location looks like a provider redirect rather than a route. */
export function isRecoveryRedirect(location: LocationLike = currentLocation()): boolean {
  const hash = location.hash ?? "";
  // `#/reset-password?access_token=…` is already a route: leave it alone, or the
  // function would rewrite it on every call and the page would loop.
  if (hash.startsWith("#/")) return false;
  return hasRecoveryParams(hash);
}

/**
 * Rewrite a provider redirect into a route, once, without navigating.
 *
 * `history.replaceState` is used rather than assigning `location.hash`: assigning
 * pushes a history entry and fires `hashchange`, which would send the router
 * through the dashboard on the way to the reset page. Returns true when the URL
 * changed, so a caller (or a test) can tell that it did something.
 */
export function normalizeRecoveryUrl(location: LocationLike = currentLocation()): boolean {
  if (!isRecoveryRedirect(location)) return false;

  const params = location.hash.replace(/^#/, "");
  // An error the provider reported (`error=access_denied`) travels to the same
  // page, so the reset screen can say the link failed instead of showing a form.
  const next = `#/reset-password?${params}`;
  try {
    globalThis.history?.replaceState?.({}, "", `${location.search || ""}${next}`);
  } catch {
    /* no replaceState: the page still reads the raw hash and recovers the tokens */
  }
  return true;
}

/**
 * The recovery material on the current URL, from both places it can be.
 * Called by the reset page after normalisation.
 */
export function readRecoveryParts(location: LocationLike = currentLocation()): RecoveryLinkParts {
  return { search: location.search ?? "", hash: location.hash ?? "" };
}

/**
 * The URL to put in a reset email: this app, on the reset route.
 *
 * Built from `location.origin` rather than a hardcoded host so a preview
 * deployment, a LAN address and production all send people back to wherever they
 * started.
 */
export function resetPageUrl(origin?: string): string {
  const base = (origin ?? globalThis.location?.origin ?? "").replace(/\/$/, "");
  return `${base}/#/reset-password`;
}

/**
 * The parameters inside one chunk of a URL.
 *
 * The hash can be a bare parameter list (`#access_token=…`, implicit flow) *or* a
 * route with a query on the end (`#/reset-password?access_token=…`, which is what
 * `normalizeRecoveryUrl` produces and what a PKCE redirect looks like when the
 * provider appends to our own fragment). Taking everything after the first `?`
 * when there is one handles both, and is the difference between reading a token
 * and reading a key called `/reset-password?access_token`.
 */
function paramsFromChunk(chunk: string): URLSearchParams {
  const trimmed = (chunk ?? "").replace(/^#/, "");
  if (!trimmed) return new URLSearchParams();
  const queryAt = trimmed.indexOf("?");
  return new URLSearchParams(queryAt >= 0 ? trimmed.slice(queryAt + 1) : trimmed);
}

/** The recovery material as one parameter list, whatever shape it arrived in. */
export function recoveryParams(parts: RecoveryLinkParts): URLSearchParams {
  const params = new URLSearchParams();
  for (const chunk of [parts.search ?? "", parts.hash ?? ""]) {
    for (const [key, value] of paramsFromChunk(chunk)) params.append(key, value);
  }
  return params;
}

/**
 * True when the location carries provider material a reset link would carry
 * (`?code=…` or a token pair in the fragment). Used by bootstrapping code that
 * must NOT purge an orphaned provider session while the very page it landed on
 * is about to consume that material.
 */
export function carriesRecoveryMaterial(location: LocationLike = currentLocation()): boolean {
  const params = recoveryParams(readRecoveryParts(location));
  return params.has("code") || params.has("access_token");
}

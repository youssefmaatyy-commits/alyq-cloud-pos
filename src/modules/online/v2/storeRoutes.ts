/** Compatibility for links saved while V2 lived at #/store/v2. The public
 * storefront has one page tree at #/store; unknown preview paths go home rather
 * than exposing the old presentation or inventing a second routing surface. */
const PREVIEW = "/store/v2";
const PAGES = new Set(["/cart", "/checkout", "/confirmation", "/track", "/account", "/about", "/contact"]);
const CATALOG_KEYS = new Set(["q", "sort", "category", "brand", "color", "size", "size_label",
  "min", "max", "availability", "offer"]);
const ACCOUNT_TABS = new Set(["profile", "addresses", "wishlist", "orders"]);

export function isPreviewStorePath(pathname: string): boolean {
  return pathname === PREVIEW || pathname.startsWith(`${PREVIEW}/`);
}

export function canonicalStorePathname(pathname: string): string {
  if (pathname === PREVIEW) return "/store";
  if (!pathname.startsWith(`${PREVIEW}/`)) return pathname;
  const suffix = pathname.slice(PREVIEW.length);
  if (suffix === "/products" || /^\/products\/[^/]+$/.test(suffix) || PAGES.has(suffix)) {
    return `/store${suffix}`;
  }
  return "/store";
}

/** Preserve only query state that a former preview page actually consumes.
 * Never copy a phone number or arbitrary parameters from an old tracking URL
 * into a new shareable canonical URL. The normal #/store links are unchanged. */
export function canonicalPreviewSearch(pathname: string, search: string): string {
  if (!isPreviewStorePath(pathname)) return search;
  const target = canonicalStorePathname(pathname);
  const allowed = target === "/store/products" || /^\/store\/products\/[^/]+$/.test(target)
    ? CATALOG_KEYS : target === "/store/track" ? new Set(["number"])
      : target === "/store/account" ? new Set(["tab"]) : new Set<string>();
  const safe = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!allowed.has(key) || value.length > 200 || safe.has(key) || [...safe].length >= 12) continue;
    if (key === "tab" && !ACCOUNT_TABS.has(value)) continue;
    if (key === "number" && !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) continue;
    safe.set(key, value);
  }
  const result = safe.toString();
  return result ? `?${result}` : "";
}

/** Configured hash links have already passed configuredHref's scheme checks.
 * Preserve canonical links, but normalise and limit former preview URLs. */
export function canonicalConfiguredStorePath(path: string): string {
  const boundary = path.search(/[?#]/);
  const pathname = boundary < 0 ? path : path.slice(0, boundary);
  if (!isPreviewStorePath(pathname)) return path;
  const query = path.indexOf("?");
  const end = path.indexOf("#");
  const search = query < 0 || (end >= 0 && end < query) ? ""
    : path.slice(query, end < 0 ? undefined : end);
  return canonicalStorePathname(pathname) + canonicalPreviewSearch(pathname, search);
}

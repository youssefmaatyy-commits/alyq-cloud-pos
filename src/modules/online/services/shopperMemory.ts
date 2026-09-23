const WISHLIST_KEY = "alyq.store.wishlist.v1";
const RECENT_KEY = "alyq.store.recent.v1";
const MAX_RECENT = 8;

function read(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
function write(key: string, value: string[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
}
export function readGuestWishlist(): string[] { return read(WISHLIST_KEY); }
export function toggleGuestWishlist(id: string): string[] {
  const current = readGuestWishlist();
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  write(WISHLIST_KEY, next);
  return next;
}
export function readRecentlyViewed(): string[] { return read(RECENT_KEY); }
export function rememberViewed(id: string): string[] {
  const next = [id, ...readRecentlyViewed().filter((entry) => entry !== id)].slice(0, MAX_RECENT);
  write(RECENT_KEY, next);
  return next;
}

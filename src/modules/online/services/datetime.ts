/**
 * Datetime helpers for the marketing screens.
 *
 * Campaigns and coupons are stored as ISO timestamps (UTC, like everything else
 * in this app) but edited through `<input type="datetime-local">`, which speaks
 * in the operator's own wall clock. Converting at the boundary — and only at the
 * boundary — is what keeps a flash sale that starts "at 6pm" starting at 6pm for
 * the person who set it, while the database still holds one comparable instant.
 */

/** ISO → the value a `datetime-local` input accepts, in local time. */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(
    parsed.getHours(),
  )}:${pad(parsed.getMinutes())}`;
}

/** ISO → the value a `date` input accepts, in local time. */
export function toDateLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/**
 * A `datetime-local` value → ISO. An empty field falls back to `fallback`, so a
 * coupon with no start date stays "no start date" instead of becoming today.
 */
export function fromDateTimeLocal(local: string, fallback: string): string {
  const trimmed = local.trim();
  if (!trimmed) return fallback;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/** Is this window open right now? Both bounds are optional. */
export function isWindowOpen(
  startsAt: string | null,
  endsAt: string | null,
  now: Date = new Date(),
): boolean {
  const start = startsAt ? Date.parse(startsAt) : Number.NaN;
  const end = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isNaN(start) && now.getTime() < start) return false;
  if (!Number.isNaN(end) && now.getTime() > end) return false;
  return true;
}

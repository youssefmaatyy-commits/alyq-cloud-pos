/**
 * Phone identity for customer matching and WhatsApp deep links (Phase 55).
 *
 * Stored numbers are never rewritten. These functions return a copy used only
 * to compare identity or to build a `wa.me` destination.
 *
 * Egyptian mobiles are the shop's common case (`01XXXXXXXXX`, `+20…`, `0020…`).
 * A number that already names another country is left on that country — it is
 * never prefixed with `20`. A local number whose country is not indicated is
 * not guessed.
 */

/** Digits only. `+20 100-123` → `20100123`. */
export function phoneDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Drop a trunk zero that was left in after the Egypt country code.
 * `2001XXXXXXXXX` (13 digits) → `201XXXXXXXXX`.
 */
function collapseEgyptTrunk(digits: string): string {
  if (/^2001\d{9}$/.test(digits)) return `20${digits.slice(3)}`;
  return digits;
}

/**
 * Canonical digit string for "is this the same phone?".
 *
 * Egyptian mobiles collapse (`0100…` and `+20 100…` share one key). Other
 * countries keep their own country code. Empty when there are no digits — an
 * empty key is never a match.
 */
export function identityPhone(raw: string | null | undefined): string {
  let digits = phoneDigits(raw);
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  digits = collapseEgyptTrunk(digits);
  if (/^01\d{9}$/.test(digits)) return `20${digits.slice(1)}`;
  return digits;
}

/**
 * `wa.me` destination (country code, no plus), or null when the number cannot
 * be dialled without guessing a country.
 *
 * Accepted:
 *   - `01XXXXXXXXX` (Egyptian mobile) → `20` + national number
 *   - `+20…` / `0020…` / a bare `20` + national number
 *   - an explicit other country (`+966…`, `00966…`, or digits that already
 *     include a non-20 country code and do not start with a local `0`)
 *
 * Refused:
 *   - blank, too short (< 8), too long (> 15)
 *   - a local `0…` number that is not the Egyptian mobile pattern
 */
export function whatsAppDestination(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;

  const explicitIntl = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = phoneDigits(trimmed);
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  digits = collapseEgyptTrunk(digits);
  if (/^01\d{9}$/.test(digits)) digits = `20${digits.slice(1)}`;

  if (digits.length < 8 || digits.length > 15) return null;
  // A remaining leading 0 is a local number whose country was not indicated.
  if (digits.startsWith("0")) return null;

  if (digits.startsWith("20")) {
    // Explicit Egypt (or the local mobile we just rewrote). Don't invent a
    // different country, and don't accept a truncated 20-prefix.
    return digits.length >= 11 && digits.length <= 13 ? digits : null;
  }

  // Another country is already in the digits. Prefixing 20 would corrupt it.
  // Without an explicit +/00 we still refuse to *guess Egypt*; we keep the
  // digits the customer already stored.
  if (!explicitIntl && digits.length < 10) return null;
  return digits;
}

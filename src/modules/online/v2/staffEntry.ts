/**
 * The shop's hidden staff entrance.
 *
 * The public storefront must never advertise the signed-in application: there is
 * no footer link, no header button and no visible back-office door for a
 * shopper to stumble into. Staff who need the till type one exact word into the
 * shop's own search field — the field a customer already uses to find products
 * — and that word reveals a single "enter ALYQ POS" option. Choosing it (by
 * click or by pressing Enter) opens the real login screen at `/login`.
 *
 * This is a link to the existing sign-in, not an authentication path of its
 * own. Nothing here grants a session, skips a credential or widens a
 * capability: after `/login` the usual `RequireAuth` guard and the role →
 * screen capability table still decide what the signed-in person may open, and
 * an anonymous visitor who types the word sees exactly the same login form a
 * deep link to `/dashboard` would have shown them.
 *
 * Why search and not a visible control: the word appears nowhere in the UI, so
 * a customer never meets it, while a cashier on a floor phone can get to the
 * till without a bookmark or a second URL to remember.
 */

/** The exact word that arms the entrance. Compared trimmed and case-insensitively. */
export const STAFF_ENTRY_KEYWORD = "logpos";

/** The public staff sign-in route this opens — never a protected screen itself. */
export const STAFF_ENTRY_ROUTE = "/login";

/**
 * True only when the *whole* query is the activation word.
 *
 * Deliberately not a substring test. "logpos" inside a longer query — or a
 * product that happens to be named that — must leave product search completely
 * alone, and a shopper typing anything else must never be shown a staff
 * control. Case is ignored so a phone that capitalises the first letter
 * (`Logpos`) still works; surrounding whitespace is ignored so a stray space
 * from a mobile keyboard does not swallow the word.
 */
export function isStaffEntryQuery(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === STAFF_ENTRY_KEYWORD;
}

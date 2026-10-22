# The hidden staff entrance in the shop's search

A cashier who needs the till opens the shop on a phone and types one word into
the shop's own search field. That word reveals a single option — **دخول نظام
ALYQ POS / Enter ALYQ POS** — and the option opens the app's real staff sign-in
screen. Nothing else changes for a shopper.

## The rule

| | |
|---|---|
| Activation word | `logpos` — the *whole* query, trimmed, case-insensitive |
| Revealed control | one option, only while the word is typed |
| Destination | `#/login` — the existing `LoginRoute` / `LoginPage` |
| Permanent control | none, anywhere in the storefront |
| Product search | unchanged — results, URL state and filters |
| Shopper account | unchanged — `#/store/account` keeps its own sign-in |
| Authentication | untouched — no session, token or capability is created here |

## Why it is built this way

**Search, not a link.** The word appears nowhere in the UI, in the stylesheet or
in a URL, so a customer never meets a back-office door, and a crawler never
indexes one. A cashier who knows the word gets in from any browser without a
bookmark or a second address to remember.

**A whole-query match, never a substring.** `logpos ring`, `logpos1` and
`logpo` leave product search completely alone, so a product that happens to be
named that — or a shopper who types it by accident — sees no staff control and
no change in results. Case and stray spaces are ignored because a phone
keyboard adds both (`Logpos`, ` logpos `).

**A link, not a login path.** The option calls `navigate("/login")` and nothing
else. It does not import the auth service, read or write a session, or touch
localStorage. After the sign-in, `RequireAuth` and the role → screen capability
table decide what the person may open, exactly as they do for a deep link to
`#/dashboard`. There is no way to reach a protected screen through the entrance.

**A `<button>`.** Tap, click, Tab-then-Enter and the form's own Enter all reach
the same handler, so the entrance behaves identically on a desktop mouse, an
Android touch screen and an iPhone one. `autoCapitalize="none"`,
`autoCorrect="off"` and `spellCheck={false}` on the two search fields stop a
phone keyboard from rewriting the word before it is read.

**The shop's own palette.** The option uses the configured gold accent
(`--v2-accent-text` / `--v2-header-accent-text`), the ivory surface and the
shop's corner radius, inherits the header's colours where it sits inside the
header, and keeps a 48px touch target. No new colour, font or radius is
introduced.

## Where it lives

| File | Role |
|---|---|
| `src/modules/online/v2/staffEntry.ts` | the word, the route, the matcher (pure, no DOM) |
| `src/modules/online/v2/StaffEntryOption.tsx` | the one revealed control |
| `src/modules/online/v2/StorefrontV2Shell.tsx` | header search: reveal, click, Enter |
| `src/modules/online/v2/StorefrontV2Catalog.tsx` | catalogue search: reveal, click, Enter |
| `src/modules/online/v2/storefront-v2.css` | the option's styling, on existing tokens |
| `src/lib/i18n/dictionary.ts` | `store.v2.staffEntry`, `store.v2.staffEntryHint` (EN + AR) |

## Tests

- `src/modules/online/v2/__tests__/staffEntry.selftest.ts` — 13 checks: the
  matcher, the gate, the destination, and refusals (no hardcoded keyword, no
  permanent link, no auth import, no new colour).
- `scripts/storefront-v2-staff-entry.flow.mjs` — the real app bundle in jsdom:
  nothing is advertised, near-misses reveal nothing, the exact word reveals one
  option, Enter and click both open the real login screen, the Arabic shop shows
  the Arabic label, an ordinary search still filters the catalogue and still
  writes `?q=`, and a shopper still signs into their own account.
- Run: `npm run test:e2e staff-entry` and `npm test staffEntry`.

# Authentication phase — what was built

The demo role switcher is gone. The app now starts signed out, and every screen
below the login page is served only to an authenticated session. This document is
the summary of that change: what exists, how it is layered, how it is tested, and
what is deliberately left for later.

Companion document: [`AUTHORIZATION.md`](./AUTHORIZATION.md) — the permission
matrix this phase builds on. **Nothing in that matrix was removed or narrowed.**

---

## 1. The flow

```
boot ──► restore persisted session
         ├─ valid      ──► authenticated ──► the app shell
         └─ missing/expired ──► anonymous ──► #/login

#/login ──► credentials ──► UserRepository.authenticate() ──► session
                                   │                 ├─ ok    ──► persisted + enter app
                                   └─ code           └─ error ──► generic message, no session
```

* **Login screen** (`#/login`) — username, password, remember-me, sign-in button,
  bilingual EN/AR, rendered *outside* the app shell and outside every module
  provider. No business data is loaded before a session exists.
* **Session** — opaque token, acting user (`id`, `username`, `name`, `role`),
  `issued_at`, sliding `expires_at`, `remember`. TTLs: 8 h idle by default, 7 days
  with remember-me, hard absolute cap of 30 days.
* **Logout** — a control in the sidebar; ends the local session, clears storage
  and, in live mode, asks the provider to revoke it.
* **Expiry** — enforced at three points, cheapest first: on boot
  (`restoreSession`), on every navigation (`hashchange` / `popstate`) and on a
  60-second heartbeat plus tab-focus. An expired session ends with an explanatory
  message on the login screen instead of a silent bounce.

## 2. Where each piece lives

| Concern | File |
| --- | --- |
| Domain types | `src/lib/auth/types.ts` |
| Session lifecycle (create / validate / touch / restore) | `src/lib/auth/services/authService.ts` |
| Persistence + the acting-user cache | `src/lib/auth/services/sessionStore.ts` |
| Credential verification (salted digests) | `src/lib/auth/services/password.ts` |
| Demo accounts — **data only** | `src/lib/auth/demoUsers.ts` |
| Repository seam (`UserRepository`) | `src/lib/auth/data/` |
| React context (`useAuth`) | `src/lib/auth/hooks/AuthProvider.tsx` |
| Login screen / guards | `src/lib/auth/components/` |
| Screen → capability table (used by the guard **and** the sidebar) | `src/lib/permissions/routes.ts` |
| Route guard | `src/components/layout/RouteGuard.tsx` |

Storage layout — one key, so a future migration has a single thing to clear:

```
localStorage   alyq.auth.session.v1   { session, persistence: "local" }    remember-me
sessionStorage alyq.auth.session.v1   { session, persistence: "session" }  otherwise
```

Never both at once. The pre-authentication demo identity key
(`alyq.inventory.currentUser.v1`) is removed on first read and is no longer
written anywhere.

## 3. Roles and users

Five roles, one demo account each (all with the demo password `alyq1234`):

| Username | Role | Name |
| --- | --- | --- |
| `admin` | `admin` | ALYQ Admin |
| `manager` | `manager` | Branch Manager |
| `cashier` | `cashier` | Cashier One |
| `clerk` | `inventory_clerk` | Inventory Clerk |
| `viewer` | `viewer` | Viewer |

The credentials live in `demoUsers.ts` — a data module. **No UI component
contains a username, a password or a role list**; the login screen renders the
hint by reading the directory.

Route protection (same table the sidebar uses, so navigation cannot drift from
enforcement):

| Screen | Capability | Roles allowed |
| --- | --- | --- |
| Dashboard, Products, Categories, Customers | *(session only)* | all five |
| POS register, Sales history | `sell` | admin, manager, cashier, inventory_clerk |
| Returns | `process_return` | admin, manager, cashier, inventory_clerk |
| Refunds | `process_refund` | admin, manager, cashier, inventory_clerk |
| Inventory, Movements | `view_inventory` | all five (read-only for `viewer`) |
| Shifts, Shift history, Expenses | `view_shifts` | all five |
| Audit log | `view_audit_log` | admin, manager |

Three layers apply the same decision on purpose: the sidebar hides what a role
cannot open, `RouteGuard` refuses the screen on a direct URL, and the action
layers (`InventoryProvider.adjustStock`, `PosProvider.completeSale`) still throw
`FORBIDDEN` before writing.

> **Cashier gate fixed.** `pos.canCompleteSale` used to list roles by hand and
> omitted `cashier`, even though the matrix grants `cashier` `sell`. Every
> module helper now asks the matrix, so a signed-in cashier can run the register
> — verified in the auth flow test, step 5.

Closed-signed-out state fails closed: `ANONYMOUS_USER` has role `""`, which is
not a member of the model, so **every** capability is denied rather than
defaulting to something.

## 4. Migration path to Supabase Auth

> **Status: taken.** The seam below is what Phase 10 migrated across, and it is
> still the only seam — but it has grown from three methods to nine
> (`signOut({ everywhere })`, `currentSession`, `refreshSession`, `onAuthChange`,
> `requestPasswordReset`, `consumeRecoveryLink`, `updatePassword`). Read
> [`src/lib/auth/data/repository.ts`](../src/lib/auth/data/repository.ts) for the
> current contract; the sketch below is kept as the shape the migration was
> planned around.

`UserRepository` is the only seam the app talks to:

```ts
interface UserRepository {
  readonly kind: "demo" | "supabase";
  listUsers(): Promise<AuthUserSummary[]>;
  authenticate(username, password): Promise<AuthenticateResult>;
  signOut(): Promise<void>;
}
```

`getUserRepository()` picks the implementation the same way every other module
does — Supabase when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set,
demo otherwise. `SupabaseUserRepository` takes two roads to the same provider
verdict: an identifier containing `@` goes to `auth.signInWithPassword()`
directly (unchanged email login), and a bare username is resolved by the
`alyq-auth` edge function, which finds the account's REAL Auth email
server-side (username → `profiles.id` → `auth.users`), verifies the password
through Supabase Auth's own grant, enforces the active-account gate and answers
with session tokens only — the browser never learns the email behind a
username, and recovery by username mails the real address the same way.
(An older revision signed usernames in against a synthetic
`<username>@alyq.local`, which silently failed for any account whose Auth
identity is a real email; `usernameToEmail` survives only as the
account-creation fallback for a user made without an email.) Identity is then
read from the `profiles` table (`id`, `name`, `username`, `role`) exactly as
before. No component, guard or permission helper knows which one is active.

## 5. Tests

| Suite | Command | Result |
| --- | --- | --- |
| Authentication logic (17) | `npx esbuild src/lib/auth/__tests__/auth.selftest.ts --bundle --format=esm --platform=node --outfile=/tmp/alyq-auth.mjs --define:import.meta.env='{"VITE_CURRENCY":"EGP"}' && node /tmp/alyq-auth.mjs` | 17/17 |
| Role model (12) | same pattern on `src/lib/permissions/__tests__/roles.selftest.ts` | 12/12 |
| Phase 8 shifts (17) | same pattern on `src/modules/shifts/__tests__/logic.selftest.ts` | 17/17 |
| POS (34) / Returns (9) / Products (36) | same pattern per module | green |
| Auth flow, 9 steps | `node scripts/auth.flow.mjs` (bundle first — see its header) | 9/9 |
| Full DOM smoke | `node scripts/smoke.dom.mjs` (bundle first) | green, 0 console errors |

`scripts/auth.flow.mjs` covers, end to end: open → login screen → valid
credentials → dashboard → cashier permissions → unauthorized action blocked →
logout → **wrong password** → **session expiry** (a session that lapses while the
app runs, and one that had already lapsed at boot).

`scripts/smoke.dom.mjs` now signs in before it starts driving the app, then
repeats the role gating per signed-in account; every earlier phase still runs
unchanged as an admin.

## 6. Known gaps / not in this phase

> **Status after Phase 10 (Trustworthy Backend & Identity).** Four of the six are
> closed, two are narrower than they were:
>
> 1. **Closed.** Live mode delegates verification to Supabase Auth; the browser
>    only ever verifies the *offline demo directory*, and it does so against a
>    salt and two digests, never clear text.
> 2. **Closed.** `/forgot-password` and `/reset-password` (both recovery flows,
>    PKCE `?code=` and implicit `#access_token`), a self-service change, and
>    Settings → Users / Settings → Roles: create, edit, activate, deactivate,
>    reset a password, assign a system role or a custom role.
> 3. **Closed.** `src/lib/permissions/routes.ts` carries the `/settings*`
>    entries, gated per screen on `manage_users` and `manage_roles`.
> 4. **Closed.** The session *is* the Supabase access token, revalidated on a
>    heartbeat and on every `onAuthStateChange` event; authority is decided
>    server-side by `public.can()` inside RLS policies and every admin RPC, and
>    the `alyq-admin` edge function re-checks `manage_users` as the caller before
>    it will touch a credential.
> 5. **Narrower, still open.** Audit rows are still written by the client, so the
>    *name* on a row is self-reported. What changed is that every action now
>    passes a server-side capability check first, so a tampered client can no
>    longer perform the action it would be mis-attributing. Server-stamped
>    attribution (writing the trail from a trigger or the edge function) is the
>    remaining step, and it has to solve double-logging before it is worth doing.
> 6. **Narrower, still open.** No hosted Supabase project has been used. What now
>    exercises the live path without one: 27 contract tests drive
>    `SupabaseUserRepository` against a scripted client, and `npm run db:check`
>    applies all 21 migrations plus `seed.sql` to a real PostgreSQL engine
>    (PGlite) twice, runs the RLS role scenarios, and asserts that `public.can()`
>    follows a custom-role overlay.

1. **Passwords are verified in the browser.** Fine for the demo directory, wrong
   for production: a client is never a trust boundary. Live mode delegates
   verification to Supabase Auth (the repository seam is already there).
2. **No password change / reset, no user administration UI.** Accounts are
   seeded; a "users & roles" screen was not requested and was not built.
3. **No Settings screen exists in the app**, so there is nothing to protect there
   yet. When one is added it needs a row in `src/lib/permissions/routes.ts`.
4. **No server session validation.** The session token is carried but not
   verified against a backend; it becomes the Supabase access token in live mode.
5. **Audit rows are client-attributed** — the acting user is taken from the
   session, so a tampered client could write a different name. Server-side
   attribution arrives with the live backend.
6. **Supabase path is unexercised** — there is no Supabase instance in this
   environment, so `SupabaseUserRepository` is written and typed but not run
   against a real backend.

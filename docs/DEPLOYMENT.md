# Deployment

How to stand up ALYQ Cloud POS against a real Supabase project, and how to
verify that what you deployed is what the code expects.

Everything here is checkable: `npm run db:check` builds the schema from scratch
on every run, and the suites cover the application. No step below relies on
knowledge that is not in this repository.

---

## 1. Prerequisites

| Requirement | Why |
| --- | --- |
| Node 22+ and npm | build and test tooling |
| A Supabase project | Postgres, Auth and Storage |
| The project's `URL` and `anon` key | inlined into the front end at build time |
| `service_role` key (server-side only, never in the front end) | applying migrations where the CLI is unavailable |

---

## 2. Configure the front end

```bash
cp .env.example .env
```

```ini
VITE_APP_MODE=production
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_CURRENCY=EGP
# Optional — only if the shop is served from its own origin.
VITE_STOREFRONT_URL=
```

Vite inlines `VITE_*` at **build** time. Two consequences that catch people out:

- a running `npm run dev` does not pick up a changed `.env` — restart it;
- the deployed artefact carries the values it was built with, so changing an
  environment variable means rebuilding, not just redeploying.

### The application mode (`VITE_APP_MODE`)

| Value | Meaning |
| --- | --- |
| `production` | A live deployment. A missing, half-set, malformed, plain-`http` or secret-shaped Supabase configuration is a **build failure** — there is no fallback to demo data. A bundle built with such a configuration anyway shows the configuration-error screen, not the till. |
| `demo` | The in-browser dataset on purpose. Supabase values, if present, are ignored so a demonstration can never reach a project. |
| *(unset)* | Legacy inference: a valid pair means live, none means demo. Supported so existing deployments keep building, but `npm run release:probe` warns — name the mode. |

The rules are enforced at build time (`vite.config.ts`, via `src/lib/appMode.ts`)
and proved end-to-end by `npm run check:production-guard`, which performs three
real builds: production without configuration (must fail), production with a
configuration (must succeed), and demo (must succeed and be labelled `demo`).

Leaving both Supabase values empty **without** declaring a mode is still the
local-development default, but it is not a production configuration — demo data
lives in the visitor's browser. Set `VITE_APP_MODE=production` on the host
(Vercel: Project → Settings → Environment Variables) so a broken configuration
fails the build instead of shipping a demo till.

### The storefront URL (`VITE_STOREFRONT_URL`)

The customer-facing shop is a **public route inside this same bundle**: `#/store`,
rendered outside the authenticated shell, so it needs no sign-in and no
capability. That is why the variable is optional and empty by default.

With it empty, "View website" on the POS register (and in the app shell, and on
the website settings screen) navigates internally to `#/store`. Internal
navigation is the default on purpose:

- it behaves identically in demo mode and live mode — there is no second origin
  to host, no CORS, no separate deployment;
- there is no popup, so no popup blocker can swallow the click. A till browser is
  frequently locked down, and `window.open` failing there produces a button that
  appears to do nothing;
- the cashier cannot lose the shop's window behind the register.

Set it **only** when the shop really is served from its own origin, for example a
separate marketing site backed by the same database:

```ini
VITE_STOREFRONT_URL=https://shop.example.com
```

The same control then becomes an anchor to that origin, opened in a new tab with
`rel="noopener noreferrer"`. Because the value is rendered into an `href`, it is
validated rather than trusted: only `http:` and `https:` are accepted. A
`javascript:` or `data:` value — or anything unparseable — is refused, the
built-in shop at `#/store` is opened instead, and the operator is told on screen
that the configured URL is invalid. The failure is never silent, and the button
is never dead.

This value is **not a secret**; like every `VITE_*` variable it is inlined into
the build and readable by any visitor. Never put a key here.

---

## 3. Apply the schema

Migrations live in `supabase/migrations/`, numbered and applied in filename
order. They are written to be idempotent, so re-running them is safe.

```bash
# Verify first. This applies everything to a throwaway in-process PostgreSQL,
# twice, and checks the result against what the code queries — no project and no
# Docker needed.
npm run db:check
```

Then, against the real project, pick one:

```bash
# Option A — Supabase CLI
supabase link --project-ref <ref>
supabase db push

# Option B — psql
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f "$f" || break
done

# Option C — SQL editor
# Paste each file in numeric order and run it.
```

Apply them in one transaction per file (`--single-transaction`, as above): a
half-applied migration is worse than a failed one.

> **Adding an enum value.** PostgreSQL refuses to *use* a new enum label in the
> same transaction that added it. A migration that adds a value and then
> references it must be split into two files. Migrations 0011+ follow this rule.

Against a live project you can also re-run just the inspection stage:

```bash
npm run db:check -- --driver=psql --url="$DATABASE_URL" --verify-only
```

That applies nothing and reports whether the deployed schema still matches the
code — the safe way to check production after a release.

---

## 4. What Supabase provides, and what the migrations create

The migrations assume the objects Supabase itself owns; the repository never
creates them:

| Object | Owner | Used for |
| --- | --- | --- |
| `auth.users`, `auth.uid()` | Supabase Auth | identity |
| `anon`, `authenticated`, `service_role` roles | Supabase | RLS grants and policies |
| `storage.buckets`, `storage.objects` | Supabase Storage | product images (bucket `product-images`) |

Everything else — `categories`, `products`, `stock_movements`, `sales`,
`sale_items`, `sale_payments`, `customers`, `sales_returns`, `return_items`,
`refund_records`, and the RPCs that write them — is created by the migrations.

One Supabase behaviour is worth stating plainly, because it bit this schema:
since **2026-04-28** a new table in `public` is *not* granted to `authenticated`
automatically. A table can exist with RLS, the right policies and still answer
`permission denied`. Every application table therefore carries an explicit
`grant select`, and `db:check` fails if one is missing.

When the migration check runs locally there is no Supabase, so
[`supabase/tests/supabase-shim.sql`](../supabase/tests/supabase-shim.sql)
supplies stand-ins for the row above — the schemas, the three roles, `auth.uid()`
and the `auth.users` / `auth.identities` / `storage.*` columns the migrations
touch. It is a test fixture, never applied to a real project.

`supabase/tests/scenarios.sql` then exercises the result as each role. Because
it drives the real policies and triggers, it is the check that proves the
DATABASE enforces the permission matrix rather than just the UI:

| Scenario | Proves |
| --- | --- |
| capability resolution | cashier / viewer / admin / anonymous / no-profile each resolve to the right capabilities, and an unknown role resolves to none |
| deactivation | deactivating a profile revokes everything; reactivating restores it |
| invariant triggers | with RLS bypassed (owner + impersonated claim) a viewer still cannot open a shift or record an expense, and the table constraints still hold |
| staff onboarding | `handle_new_user()` reads the role from metadata (through the aliases), and creates an inactive viewer when there is none |
| shift lifecycle | one open shift installation-wide, close, freeze, and an approval that can happen once and only with `approve_shift_adjustment` |
| expense rules | attribution is stamped to the caller, is immutable, and editing/deleting needs manager rights |
| audit trail | append-only under an RLS bypass, entity derived from the action, read access is oversight-only |
| admin maintenance | backfill, demo seed and retention purge are admin-only and idempotent |
| refund lifecycle | a return recorded as `pending` reserves the sale's refundable amount without stamping a settlement; only `approve_refund` may settle or reject; a rejected refund frees the amount again; settling twice writes one audit row; a decision is final; a counter refund is stamped settled when it is recorded |
| pos payments | cash, InstaPay and card side by side: a card sale completes without touching the drawer, cash still records tender and change, InstaPay still waits to be confirmed, and a split of cash and card still sums to the total |

They run automatically against the local in-process database. Against a real
server they are opt-in (`--scenarios`), because they insert test staff rows into
`auth.users`.

---

## 5. Initial data and the first sign-in

Application data — users, and therefore roles — lives in Supabase Auth, and each
user needs a matching row in `public.profiles` before they can sign in. The
schema now handles that:

### On a development project: `supabase/seed.sql`

`supabase db reset` runs [`supabase/seed.sql`](../supabase/seed.sql) after the
migrations, and it can be applied by hand to any development database:

```bash
psql "$SUPABASE_DB_URL" -f supabase/seed.sql
```

It creates the five demo accounts (`admin`, `manager`, `cashier`,
`inventory_clerk`, `viewer` — all with the password `alyq1234`, the same five the
offline demo directory offers), backfills `profiles.email` from `auth.users`, and
inserts the four custom-role presets the app offers in Settings → Roles. It ends
with a contract block that raises if a role grants a capability the catalogue
does not know, if a role is empty, if a system role lost its matrix, if a profile
has no `auth.users` row, or if there is no active admin — so a database that
disagrees with the application fails to seed instead of failing later as a button
that does nothing.

Idempotent: it never resets a password, never creates a second account, and
leaves an operator's own roles and `active` flags alone (re-running refreshes the
preset *definitions* only). `npm run db:check` applies it twice and then compares
the rows it wrote with `CUSTOM_ROLE_PRESETS` in
`src/lib/permissions/customRoles.ts`, and proves that `public.can()` follows an
overlay: assign → the custom role's list decides, deactivate → the base role,
clear → the system matrix.

**Do not run it on production.** It creates real sign-ins with a published
password. On a live project follow the steps below instead.

### On any project: the first admin, by hand

1. **Create the first admin by hand.** An installation cannot bootstrap its own
   first identity: use the Dashboard (Authentication → Users → *Add user*), set
   the password, and give the account role metadata:

   ```json
   { "role": "admin", "username": "admin", "name": "Your Name" }
   ```

   The `on_auth_user_created` trigger (migration `0014`) creates the profile
   from that metadata, resolving the role through the same alias table the app
   uses (`owner` and `super_admin` also mean admin).

   **No metadata means an inactive viewer.** That is deliberate: turning public
   sign-up on by accident would otherwise give every visitor read access. An
   admin activates or promotes the account afterwards with
   `upsert_staff_profile()` — or from the staff screen, once it exists.

   **Forgot the metadata on a brand-new project?** Before migration `0085`
   that was a dead end twice over: the fail-closed viewer row could not even
   be *inserted* (the `0059` guard refused a directory with nobody holding
   `manage_users`), and nothing could promote it afterwards, because every
   staff RPC is admin-gated and there was no admin yet. `0085` fixes both,
   without opening anything on a managed installation:

   - the `0059` guard now ignores INSERTs — a new row can only ever *add* a
     capability holder, so the first fail-closed account may exist;
   - `bootstrap_first_admin()` promotes the **caller** to an active admin,
     **exactly once**, and only while the directory has never been managed —
     it refuses while any admin profile row exists (active or not) or while
     anyone holds `manage_users`, serializes concurrent callers with an
     advisory lock, and writes the promotion to the audit trail
     (`user.role_changed`).

   Sign in as the stranded account (authentication works even while the
   profile is inactive) and call the RPC with that session's access token:

   ```bash
   curl -X POST "$SUPABASE_URL/rest/v1/rpc/bootstrap_first_admin" \
     -H "apikey: $SUPABASE_ANON_KEY" \
     -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
     -H "Content-Type: application/json" -d '{}'
   ```

   The SQL editor is not a way around the guard: the function refuses a
   session without `auth.uid()`, so it cannot be run anonymously, and the
   anon role holds no EXECUTE on it. Run the bootstrap **before** enabling
   any public sign-up — on a never-managed directory the function promotes
   whichever authenticated caller reaches it first; that is the point, and
   also the reason the door closes forever the moment one admin row exists.

2. **Seed the rest, on a development project.** As the admin:

   ```sql
   select public.seed_demo_staff('alyq1234');   -- admin, manager, cashier,
                                               -- inventory_clerk, viewer
   ```

   It is idempotent, leaves existing accounts (and their passwords) alone, and
   uses the `<username>@alyq.local` email the login screen builds from a typed
   username. Do not run it on production.

3. **Accounts that already exist** get profiles with:

   ```sql
   select public.backfill_staff_profiles();     -- admin only, idempotent
   ```

4. **Then disable public sign-up** in Authentication → Providers, unless you
   actually want anyone who can reach the site to have an account.

Migrations 0003 and 0010 also seed a small demo catalog (categories, products)
and skip it when the SKUs already exist, so applying them to a project that
already has data is safe.

### The `alyq-admin` edge function (required in live mode)

Two operations in Settings → Users cannot be database functions, because they
have to create or change credentials in `auth.users` and nothing reachable with
the anon key may do that: **creating a user** and **resetting somebody else's
password**. The app calls the edge function
[`supabase/functions/alyq-admin`](../supabase/functions/alyq-admin/index.ts) for
both; without it deployed, those two actions fail in live mode (everything else
on that screen — editing, activating, role and custom-role assignment — is an RPC
and works without it).

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<project service_role key>
supabase functions deploy alyq-admin
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected into every function by the
runtime; the service key is the only secret you set. Leave `verify_jwt` at its
default (`true`).

The function holds the service role for exactly as long as one credential call
needs it, and not a moment sooner: it resolves the caller with `auth.getUser()`
from the request's own access token, asks the database `public.can('manage_users')`
**as that caller** — the same question every RLS policy asks, so a custom role
counts here as it counts everywhere — and only then builds a service-role client.
It mirrors the app's username, email, role and password rules, so a request that
skips the form meets the same bar; it refuses to reset the password of an id that
has no `profiles` row (staff only); and if the profile write fails after the
credentials were created it deletes the account rather than leaving a half-made
one behind.

It writes **no audit rows**: `settingsService` records one attributed entry per
action (`user.created`, `user.password_reset`, never the password itself), and a
second row here would put every creation in the trail twice. It also ignores a
`custom_role_id` in the request — the app assigns overlays with
`admin_set_custom_role`, which is where the rule "assigning an overlay also moves
`profiles.role` to its base" lives.

Rotate the service key (Dashboard → Settings → API) if it ever leaks, then
re-run both commands above.

### The `alyq-auth` edge function (required in live mode)

Staff sign in with a **username**, but Supabase Auth is email-shaped and this
project's accounts carry their **real email** — the one Forgot Password mails.
Resolving "admin" → the real address cannot happen in the browser (`profiles`
is RLS'd to self-or-oversight, and a public username → email lookup would be an
enumeration oracle), so
[`supabase/functions/alyq-auth`](../supabase/functions/alyq-auth/index.ts) does
it per request: `login {identifier, password}` resolves server-side, lets
Supabase Auth verify the password, enforces the active-account gate and returns
**session tokens only**; `recover {identifier, redirect_to}` resolves and hands
the real address to Supabase's own recovery mailer, answering identically
whether or not the identifier exists. Without it deployed, username sign-in and
username recovery fail in live mode (email login and email recovery are direct
provider calls and keep working).

```bash
supabase functions deploy alyq-auth --no-verify-jwt
```

`--no-verify-jwt` is required — the function is pre-authentication by nature.
What keeps that safe: it holds no admin power (the service role only resolves a
username to the Auth email and revokes sessions that must never leave it), the
password is transient and never logged or returned, every refusal is the same
generic `invalid_credentials` (unknown usernames are checked against a
deterministic `@alyq.invalid` sinkhole so timing cannot enumerate either), and
a best-effort per-IP limiter (12 logins / 5 recoveries per 10 minutes) runs
before any provider call. It uses the same project-wide
`SUPABASE_SERVICE_ROLE_KEY` secret as `alyq-admin`; no migration accompanies
it.

### Password recovery in production (Site URL, Redirect URLs, SMTP)

The recovery feature is built — `/#/forgot-password`, `/#/reset-password`,
[`recoveryUrl.ts`](../src/lib/auth/services/recoveryUrl.ts) and the
`requestPasswordReset` / `consumeRecoveryLink` / `updatePassword` seam in
[`supabaseRepository.ts`](../src/lib/auth/data/supabaseRepository.ts) — but
whether a reset email actually reaches a person is a **project configuration**
question, answered in the Supabase Dashboard, not in this repository. Three
settings decide it.

**1. Site URL** (Dashboard → Authentication → URL Configuration). Must be the
deployed ALYQ website, e.g. `https://<ALYQ-HOST>/`. It is the fallback
destination for every auth email whose redirect target is not explicitly
allowlisted, so a wrong Site URL sends staff to a host that is not the app.

**2. Redirect URLs** (same screen). Add the recovery route:

```text
https://<ALYQ-HOST>/#/reset-password
```

The app routes on the URL *fragment* (`HashRouter`), which is why the route is
a `#/…` path — and Supabase's implicit flow also delivers its tokens in the
fragment. The app resolves that collision at boot (`normalizeRecoveryUrl()`
rewrites `#access_token=…&type=recovery` into `#/reset-password?…` before the
router reads it), so the link lands on the reset page under either flow. If
the deployment is reachable under more than one origin (staging host, preview
host), allowlist each one; the reset request always carries the origin it was
made from.

**3. Email / SMTP** (Dashboard → Authentication → SMTP / Emails). Real
recovery emails require a working Supabase email sender. The **built-in sender
has delivery and rate limitations and is not meant for production** — configure
a proper SMTP provider for a live shop. SMTP credentials belong in the
Dashboard (and, for anything server-side, in `supabase secrets` / CI secrets):
**never in this repository, never in a `VITE_*` variable.**

**The flow, end to end.** Login screen → "Forgot password" (`/#/forgot-password`)
→ the app calls `auth.resetPasswordForEmail(email, { redirectTo })` with the
current origin's `/#/reset-password` → Supabase emails a single-use recovery
link (it expires shortly after) → the person opens it → the app exchanges the
PKCE `?code=` (or the implicit-flow tokens) for one recovery session →
`/#/reset-password` shows the new-password form, held to the same policy an
admin meets when creating an account (`passwordPolicy.ts`, with Supabase Auth's
own server-side verdict on top) → `auth.updateUser({ password })` → the person
signs in with the new password. In **demo mode** there is no mail server and
the screen says so instead of pretending: the offline recovery path is an admin
reset from Settings → Users.

**Security notes.**

- **No admin can view an existing password.** Supabase stores only a hash; the
  administrative path (`alyq-admin` → `reset_password`) *sets a new* password
  and never retrieves the old one.
- **Passwords, recovery tokens and reset-destination addresses are never
  logged.** The audit vocabulary (`user.password_reset_requested`,
  `user.password_reset`, `user.password_changed`) records that the event
  happened and who asked — nothing that would let a reader of the trail finish
  what the link started.
- **Recovery responses do not reveal whether an account exists.** Supabase
  answers identically either way and `/#/forgot-password` deliberately mirrors
  that. Do not "improve" the message into a directory of who works here.
- **Redirect URLs must be allowlisted.** The allowlist is what stops a forged
  `redirectTo` from mailing somebody's recovery link to an attacker's host; a
  target that is not on the list falls back to the Site URL.
- **SMTP and service credentials stay server-side / Dashboard-only** — see the
  secrets rule in §8.

**Production verification checklist** (run once per environment, after any
Auth configuration change):

- [ ] Request recovery for a test account from `/#/forgot-password` on the
      deployed build.
- [ ] The email arrives (check spam first; Supabase's Auth logs second).
- [ ] The link opens `/#/reset-password` showing the new-password form — not
      the dashboard, not a failure message.
- [ ] Set a new password; the page confirms it.
- [ ] The **old** password no longer signs in.
- [ ] The **new** password signs in.
- [ ] Re-opening the same link — or opening it after expiry — fails with the
      "request a new link" message: recovery material is single-use, and the
      page reports expired, used and tampered links identically on purpose.

## 6. Build and release

```bash
npm ci
npm run production:preflight                # read-only repository/environment audit
npm run typecheck                          # includes EN/AR dictionary parity
VITE_APP_MODE=production \
  VITE_SUPABASE_URL=https://<ref>.supabase.co \
  VITE_SUPABASE_ANON_KEY=<anon-key> \
  VITE_DEMO_SEED=off \
  npm run build                            # → dist/ (single-file bundle)
```

In CI the same Vite build writes `dist/release.json` — version, commit, build
time and the declared mode — and `npm run release:probe` reads it back and walks
the shipped bundle against an empty catalogue without writing anything. Both are
part of the release job in `.github/workflows/ci.yml`; the admin-only settings
that CI cannot change itself (branch protection, Pages) are listed in
`docs/production/manual-github-settings.md`.

`dist/` is a static bundle: serve it over HTTPS from any static host or CDN.
There is no server component; the browser talks to Supabase directly, which is
why row-level security — not the UI — is the security boundary.

Before releasing, in order:

```bash
npm run db:check                                         # schema builds and matches the code
npm run test:all                                         # types, logic suites, E2E
npm run check:production-guard                           # three real builds: the gate fails closed
npm run release:probe                                    # manifest + empty-catalogue walk, read-only
npm run db:check -- --driver=psql --url="$DATABASE_URL" --verify-only   # deployed schema still matches
```

---

## 7. Rollback

- **Front end** — redeploy the previous `dist/`. It is stateless.
- **Schema** — migrations are additive and guarded: they create and alter, they
  do not drop. Rolling back application code therefore does not require a schema
  rollback. If a release must be undone *and* the schema changed, restore from a
  Supabase backup (Dashboard → Database → Backups) — there is no down-migration
  tooling, by design.

---

## 8. Operational notes

- **Secrets.** Only the `anon` key belongs in the front end. `service_role`
  belongs in CI secrets or a server-side job, and must never appear in a
  `VITE_*` variable. With `VITE_APP_MODE=production` a secret-shaped key does
  not merely leak — it fails the build.
- **Environments.** Use separate Supabase projects for staging and production;
  the CI `live` job is designed to point at staging only.
- **Monitoring.** Supabase's Postgres logs plus its Auth logs cover sign-in
  failures; the application's own `audit_log` covers what users did.
- **Demo mode in production.** If a build is ever deployed without credentials,
  it silently runs in demo mode. Treat "Supabase unreachable → app still boots"
  as a feature of the codebase but a misconfiguration in production: check the
  deployment's environment before releasing.

## 9. Backups and recovery in production

Migration `0029_backup_and_recovery.sql` adds a `backups` table and the functions
the panel calls. Nothing else in the release depends on a scheduler, so the app is
deployable without one — but without one, "automatic" means "the first time an
admin opens **Settings → Backup & recovery** after a snapshot falls due".

**Take the automatic schedule seriously.** `public.automatic_backup_if_due()` takes
a snapshot when the stored policy says one is due, applies retention, and writes
the audit entry. It is idempotent and safe to call often. Schedule it with pg_cron
(or any external scheduler) rather than relying on an admin opening the panel:

```sql
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'alyq-backup',
  '17 3 * * *',                 -- 03:17 daily; the function itself decides
  $$select public.automatic_backup_if_due()$$   -- whether a snapshot is due
);
```

Run it as a role that passes `public.can('create_backup')` — the function refuses
otherwise, which is the point. A weekly policy is honoured by the same daily call:
the function reads the stored settings and skips the days the policy does not want.

**Who may do what.** All five capabilities are admin-only by default except
`view_backups`, `create_backup` and `run_health_check`, which a manager also holds.
`restore_backup` and `export_backup` are admin-only through the role matrix — grant
them in the Permission Builder if an installation wants a second person able to
recover it, and understand that a backup file contains the user directory and the
audit trail, not just the catalogue.

**Restoring.** Settings → Backup & recovery → *Restore* on a snapshot, or *Restore
from a file* for one downloaded earlier. It requires typing `RESTORE`, validates
the document (format, schema version, mode, every table present, non-empty, and the
md5 the database took) and refuses a document from the other mode — an offline JSON
file cannot be poured into the live database, nor the reverse. Before anything is
deleted it stores a `pre_restore` snapshot of the current state, so the restore can
itself be undone by restoring that row. The audit log is carried by a snapshot but
never rewritten by a restore: it is append-only evidence, enforced by
`audit_log_enforce_invariants` and by the `audit_log_no_update` policy.

**Off-database copies.** *Download* (`export_backup`) hands an admin a JSON file,
and *Export everything* builds one workbook of the business as it stands using the
same builders as every other export. Keep the downloaded files somewhere this
database cannot reach: a snapshot stored only in the database it protects is not a
backup. Retention never deletes a snapshot somebody took by hand, nor the newest
`pre_restore`.

**Before a risky migration.** Take a manual snapshot first — it is the fastest way
back if a migration and the application disagree. `npm run db:check` verifies that
all 29 migrations apply cleanly, are idempotent, and still match the app's row
types, role grants, audit vocabulary and seed; run it in CI on every change to
`supabase/migrations/`.

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
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_CURRENCY=EGP
```

Vite inlines `VITE_*` at **build** time. Two consequences that catch people out:

- a running `npm run dev` does not pick up a changed `.env` — restart it;
- the deployed artefact carries the values it was built with, so changing an
  environment variable means rebuilding, not just redeploying.

Leaving both Supabase values empty is a supported, deliberate state: the app
falls back to demo mode. That is useful for a smoke test of a build, but it is
not a production configuration — demo data lives in the visitor's browser.

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

## 6. Build and release

```bash
npm ci
npm run typecheck     # includes EN/AR dictionary parity
npm run build         # → dist/ (single-file bundle)
```

`dist/` is a static bundle: serve it over HTTPS from any static host or CDN.
There is no server component; the browser talks to Supabase directly, which is
why row-level security — not the UI — is the security boundary.

Before releasing, in order:

```bash
npm run db:check                                         # schema builds and matches the code
npm run test:all                                         # types, logic suites, E2E
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
  `VITE_*` variable.
- **Environments.** Use separate Supabase projects for staging and production;
  the CI `live` job is designed to point at staging only.
- **Monitoring.** Supabase's Postgres logs plus its Auth logs cover sign-in
  failures; the application's own `audit_log` covers what users did.
- **Demo mode in production.** If a build is ever deployed without credentials,
  it silently runs in demo mode. Treat "Supabase unreachable → app still boots"
  as a feature of the codebase but a misconfiguration in production: check the
  deployment's environment before releasing.

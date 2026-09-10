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
VITE_CURRENCY=SAR
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

When the migration check runs locally there is no Supabase, so
[`supabase/tests/supabase-shim.sql`](../supabase/tests/supabase-shim.sql)
supplies minimal stand-ins for the row above. It is a test fixture, never
applied to a real project.

---

## 5. Initial data

Migrations 0003 and 0010 seed a small demo catalog (categories, products) and
leave it alone if the SKUs already exist, so applying them to a project that
already has data is safe.

Application data — users, and therefore roles — is created in Supabase Auth, and
each user needs a matching profile row before they can sign in. These are **new**
tables in the production-readiness workstream (migration
`0011_profiles_and_auth`); until it lands, sign-in runs against the demo
repository only. See
[`docs/PRODUCTION_READINESS_PLAN.md`](PRODUCTION_READINESS_PLAN.md).

---

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

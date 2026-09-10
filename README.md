# ALYQ Cloud POS

Bilingual (Arabic / English) retail operations suite: catalog, inventory, point
of sale, customers, returns and refunds, cashier shifts and expenses, with
role-based access control throughout.

React 19 · TypeScript · Vite · Tailwind 4 · Supabase (Postgres + Auth + Storage).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

With no environment file the app runs in **demo mode**: an in-browser dataset in
`localStorage`, seeded with five accounts — one per role — all using the
password `alyq1234`.

| Username | Role | Can do |
| --- | --- | --- |
| `admin` | Admin | everything, including the audit log |
| `manager` | Manager | everything except user management |
| `cashier` | Cashier | sell, returns, refunds, open/close shifts, record expenses |
| `inventory_clerk` | Inventory clerk | catalog and stock only |
| `viewer` | Viewer | read-only: dashboard, catalog, customers, sales history |

Demo mode is for development and evaluation. It is per-browser, has no
server-side enforcement, and must never be used for real money.

## Live mode (Supabase)

```bash
cp .env.example .env      # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run db:check          # verify the migrations build the schema the app needs
npm run build
```

Then apply `supabase/migrations/*.sql` in numeric order — via the Supabase CLI
(`supabase db push`) or by pasting them into the SQL editor. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

`VITE_*` values are inlined at **build** time, so a running dev server needs a
restart after changing `.env`. The anon key is safe to ship — row-level security
decides what it can reach. Never put the `service_role` key in the front end;
it bypasses RLS.

## Checks

```bash
npm run typecheck    # tsc; also guarantees the EN/AR dictionary is complete
npm run build        # production bundle
npm test             # logic suites: money math, validation, permissions, repos
npm run db:check     # migrations apply, are idempotent, and satisfy the code
npm run test:e2e     # the real bundle driven in jsdom (smoke + auth flows)
npm run test:all     # typecheck + logic + e2e
```

`npm run db:check` runs a WebAssembly PostgreSQL in-process, so no Docker or
database server is required. It applies every migration (twice), runs the role
scenarios as each of the five roles, and asserts that the schema matches the
code: every table and RPC the repositories name, every column of every `…Row`
interface, RLS enabled everywhere, and the capability matrix, audit vocabulary
and role aliases identical on both sides. Point it at a real project with
`--driver=psql --url=postgres://… --verify-only` to check what is deployed.

## Layout

```
src/
  app/            shell, navigation, routing
  lib/            auth, permissions, i18n, storage, supabase client
  modules/        one folder per domain: dashboard, products, inventory, pos,
                  customers, returns, shifts, expenses, audit, settings
scripts/          test runners, migration check, E2E suites
supabase/
  migrations/     numbered, idempotent schema migrations (+ README)
  tests/          Supabase stand-ins used when checking migrations locally
docs/             architecture and phase documentation (start with PHASE_STATUS)
```

Each module owns its types, validation, services, repositories, hooks and
components. Two rules keep it maintainable: UI never talks to Supabase directly
(everything goes through a repository), and permissions are decided in one place
(`src/lib/permissions/roles.ts`) rather than inside components.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) | What exists, what is missing, per phase |
| [`docs/PRODUCTION_READINESS_PLAN.md`](docs/PRODUCTION_READINESS_PLAN.md) | The current workstream: live mode, auth, authorization, refunds, card payments, audit, dashboard |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Provisioning, migrating, seeding, releasing |
| [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) | Sign-in, sessions, roles |
| [`docs/AUTHORIZATION.md`](docs/AUTHORIZATION.md) | Capability matrix and enforcement |
| [`docs/DESIGN_LANGUAGE.md`](docs/DESIGN_LANGUAGE.md) | UI rules |
| [`supabase/migrations/README.md`](supabase/migrations/README.md) | Schema reference and migration conventions |

## Status

Feature phases 1–8 are implemented and covered by the suites above. The current
focus is **production readiness**: the live schema now covers identity, roles,
shifts, expenses, the audit trail, card payment at the register and the refund
lifecycle, and the database enforces the permission matrix itself. Still to
come: the application slices for card payments and refund settlement, wider
audit coverage and a dashboard upgrade. The plan, acceptance criteria and
testing strategy live in
[`docs/PRODUCTION_READINESS_PLAN.md`](docs/PRODUCTION_READINESS_PLAN.md).


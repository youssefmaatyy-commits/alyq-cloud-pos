# ALYQ Cloud POS

Bilingual (Arabic / English) retail operations suite: catalog, inventory, point
of sale, customers, returns and refunds, cashier shifts and expenses, an online
storefront that feeds the same register, and Excel exports throughout — all
under role-based access control.

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
| `cashier` | Cashier | sell, returns, refunds, open/close shifts, record expenses, work the online-order queue |
| `inventory_clerk` | Inventory clerk | catalog and stock, plus the online-order queue |
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
npm run test:e2e     # the real bundle driven in jsdom (smoke + auth + store flows)
npm run test:all     # typecheck + logic + e2e
```

`npm run db:check` runs a WebAssembly PostgreSQL in-process, so no Docker or
database server is required. It applies every migration (twice), runs the role
scenarios as each of the five roles, and asserts that the schema matches the
code: every table and RPC the repositories name, every column of every `…Row`
interface, RLS enabled everywhere, and the capability matrix, audit vocabulary
and role aliases identical on both sides. Point it at a real project with
`--driver=psql --url=postgres://… --verify-only` to check what is deployed.

## Online store

The storefront lives at `#/store` and is **public** — no account, no session, no
role. It reads the same catalog the POS does, so a price or a stock level is
never entered twice.

| Screen | What it does |
| --- | --- |
| `#/store` | Homepage: hero, featured, best sellers, new arrivals, categories, promos, brands, reviews, FAQ — each section shown, hidden and ordered from the admin |
| `#/store/products` | Search (name, barcode, SKU), category / brand / price / availability filters, sorting |
| `#/store/products/:slug` | Gallery with zoom, description, specs, related products, New / Sale / Best-seller badges |
| `#/store/cart` · `#/store/checkout` | Cart editing, coupon codes, delivery or pickup, COD or InstaPay |
| `#/store/track` | Order status and payment status, looked up by order number + phone |
| `#/store/account` | Optional customer account: profile, addresses, order history, reorder, wishlist |
| `#/online/orders` | The POS queue for those orders |
| `#/online/website` · `/online/content` · `/online/marketing` | The website builder, homepage sections, campaigns / coupons |
| `#/online/reports` | Online sales, pending and cancelled orders, best sellers online, payment status |

Three invariants the store does not break:

1. **Stock is reserved, never double-sold.** A pending order holds its units;
   approving it converts the hold into a sale, cancelling releases it. Only
   stock-tracked products can be ordered.
2. **An online order is not a sale until a person says so.** Approving creates
   the sale with `source: "online"`, which the till's history and the reports
   show as its own origin.
3. **InstaPay is verified by a human.** The customer sends a reference and a
   proof image; the order waits in *payment verification pending*; an employee
   approves or rejects it. Nothing auto-completes on upload.

Admins and managers get everything; cashiers and inventory clerks work the order
queue but cannot restyle the website; viewers see neither.

## Exports

Every list screen — products, inventory, sales, customers, returns, expenses,
reports — exports to Excel (`.xlsx`) in the language and currency currently on
screen, with an Arabic sheet for the same rows. Payments and cash movements have
their own exports. The Excel **import** for products is unchanged and round-trips
against the export format (`npm test` proves it).

## Layout

```
src/
  app/            shell, navigation, routing
  lib/            auth, permissions, i18n, export, storage, supabase client
  modules/        one folder per domain: dashboard, products, inventory, pos,
                  customers, returns, shifts, expenses, audit, reports,
                  settings, online
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

Feature phases 1–20 are implemented and covered by the suites above: phases 1–8
for the back office, phase 9 for the online store and its queue in the POS,
phases 10–14 for identity, custom roles, enforcement, advanced reports and the
dashboard, phases 15–16 for stock-hold reconciliation and realtime, phase 17 for
dynamic access control, phase 18 for backup, recovery and data safety, phase 19
for a full QA and hardening pass, and phase 20 for production readiness — 45
capabilities across five roles and twelve Permission Builder groups, per-user
exceptions, an access preview, whole-installation snapshots with a rollback point
behind every restore, and a 27-check data-health report. Every sensitive act is
enforced in the screen, in the service and in the database alike; the register of
47 such acts and the matrix that ties each to its guard and its database
protection are in
[`docs/PERMISSION_MATRIX.md`](docs/PERMISSION_MATRIX.md). The live schema
(migrations 0001–0029) covers identity, roles, shifts, expenses, the audit trail,
card payment at the register, the refund lifecycle, the storefront's catalog
reads, order placement, payment proofs and resolution, and backups — with the
database enforcing the permission matrix itself. The plan, acceptance criteria and
testing strategy live in
[`docs/PRODUCTION_READINESS_PLAN.md`](docs/PRODUCTION_READINESS_PLAN.md), and the
latest verification snapshot — including what each phase deliberately left undone
— in [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md).


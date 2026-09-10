# ALYQ Cloud POS — Production Readiness Plan

**Status:** M0 (foundations) and M1 (WS1 migrations 0011–0014) complete. Next: `0015_pos_card_payments`, `0016_refund_settlement`, then WS2–WS7.
**Delivered so far:** CI (5 jobs), `.gitignore`, `.env.example`, root `README.md`, `docs/DEPLOYMENT.md`, the check/test runners, four migration defects fixed (F1), and migrations 0011–0014 — identity and the capability matrix, shifts and expenses, the audit trail, and the onboarding/seed policies. The database now enforces the permission matrix, and `npm run db:check` proves it on every run with four parity checks and thirteen role scenarios.
**Baseline:** branch `arena/01a08778-alyq-cloud-pos`, HEAD `01a2a35` (Phase status report).
**Companion reading:** `docs/PHASE_STATUS.md` (where the project stands), `docs/AUTHORIZATION.md` (permission
model), `docs/AUTHENTICATION.md` (auth as built), `docs/DESIGN_LANGUAGE.md` (UI rules).

This phase is **production readiness**, not new product features. The seven workstreams are taken in the
order given, with the dependency notes in §10. Workstream 1 comes first because everything else is
unverifiable while the live database cannot be created.

---

## 0. Ground rules for this phase

These apply to every workstream and are part of the acceptance criteria.

| Rule | Meaning |
| --- | --- |
| **POS behaviour is frozen** | No change to cart, totals, discount, cash/InstaPay payment, completion, void, receipt or sales-history behaviour. Additive changes only (new optional parameters, new UI legs, new fields). |
| **The repository seam is the only data path** | UI → provider → service → repository. No component talks to Supabase directly, and no new `localStorage` access is introduced. |
| **Demo mode stays working** | It is the only mode executable in this environment and the basis of the DOM suites. Live mode is added *beside* it, never instead of it. |
| **Permission matrix is extended, never narrowed** | New capabilities may be added; no role loses an existing capability. `roles.selftest.ts` asserts this. |
| **Migrations are idempotent and ordered** | `do $$ ... if not exists ... $$`, `create table if not exists`, no destructive statements, one numbered file per concern, never edited after being applied to a shared database. |
| **Money remains server-authoritative in live mode** | Balances and totals are recomputed in Postgres RPCs, not trusted from the client (the existing `pos_complete_sale` pattern). |
| **Every workstream lands behind a green suite** | `tsc`, `npm run build`, all logic self-tests, DOM smoke and `auth.flow.mjs` (see §9). |

---

## 1. Findings from the code review

These are facts established by reading the code, not assumptions. They drive the plan.

| # | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| F1 | **No migration file could be applied to a real database at all — the live schema had never been built anywhere.** Four independent defects, all found by `scripts/migrations.check.mjs` on its first run: (a) 0010 typed `sales_returns.refund_status` and `refund_records.status` as `public.payment_status` — an enum of `('paid','pending')` — while defaulting them to `'completed'`, so `create table` failed and the RPC's `'completed'::payment_status` cast would fail at runtime; (b) six policies across 0007, 0009 and 0010 declared `for insert … using (false)`, which PostgreSQL rejects (`only WITH CHECK expression allowed for INSERT`); (c) 0007's `raise exception 'Discount above 100%'` left the `%` unescaped, so the function would not compile (`too few parameters specified for RAISE`); (d) 0007 aborted before 0008–0010 could run, which is why nobody noticed the other three. **All four fixed** (see §2.1). | `0007:161,107,115`, `0009:40`, `0010:71-88,186,193,200` — verified by applying all ten files twice |
| F2 | Four tables the code already queries do not exist: `shifts`, `expenses`, `audit_log`, `profiles`. The Supabase repositories are written and typed against them. | `shifts/data/supabaseRepository.ts:16-33`, `expenses/…:7-22`, `audit/…:7-16`, `lib/auth/data/supabaseRepository.ts:13-18`; `supabase/migrations/` ends at 0010 | Live mode for Phase 8 and auth is impossible. WS1. |
| F3 | Live mode has never executed: no `.env.example`, no `.gitignore`, no root README, env vars are build-time (`import.meta.env`) and only discoverable in `client.ts`. | repo root listing; `src/lib/supabase/client.ts:14-22` | A deploy target cannot be configured from the repo. WS1-M4. |
| F4 | Action-layer permission checks exist for only two of six write paths. | Present: `pos/hooks/PosProvider.tsx:223`, `inventory/hooks/InventoryProvider.tsx:92`. Absent: returns, refunds, expenses, shifts (UI-only gating). | A direct service/repository call bypasses the UI gate. WS3. |
| F5 | The refund `pending` state is unreachable from the UI and unsettleable once present. | `returns/components/ReturnFormModal.tsx:188` hardcodes `refund_status: "completed"`; `returns/pages/RefundsPage.tsx` + `RefundDetailPage.tsx` are read-only; `ReturnRepository` has no settle method; the DB/RPC already accept `refund_status` from the payload (`0010:210`) | Money can be "owed" in the data model but never released. WS4. |
| F6 | No card/Visa payment at the register, and the database would reject one anyway. | `pos/types.ts:14` `PAYMENT_METHODS = ["cash","instapay"]`; `0007:24` enum; `0007:57` check requires `amount_received >= total` for non-InstaPay; `0007:163` RPC whitelist | Card sales are not possible. WS5. |
| F7 | The audit trail covers 6 actions across 2 entities, has no table, and is attributed client-side. | `audit/types.ts:11-23`; call sites only in `ExpenseProvider.tsx` (3) and `ShiftProvider.tsx` (3); `recordAudit()` takes the actor from the browser session | Sales, returns, refunds, customers and catalog changes leave no trail. WS6. |
| F8 | The dashboard is Phase-1 scoped. | `dashboard/DashboardPage.tsx` reads only `useCatalog()` (4 catalog tiles) | No operational picture on the landing screen. WS7. |
| F9 | No CI, no automated migration validation. | no `.github/`; suites are hand-rolled esbuild/jsdom scripts run manually | Regressions are caught only when someone runs the scripts. §9. |
| F10 | No server-side identities: users live in `demoUsers.ts`; `opened_by`, `user_id`, `created_by` columns are free text. | `lib/auth/demoUsers.ts`; `0007`/`0010` `user_id text not null` | Nothing ties a row to a real authenticated principal. WS1/WS2. |

---

## 2. Workstream 1 — Complete Supabase live mode (priority 1)

**Goal:** a fresh Supabase project can be provisioned from this repository and every module runs against it,
with the demo path still available as a fallback.

### 2.1 Migration plan

Numbered after the existing 0010. Each file is idempotent and independently re-runnable.

| Migration | Purpose | Key contents |
| --- | --- | --- |
| *(none — F1 is fixed in place)* | No repair migration is needed: 0010 could never have applied anywhere, so it is corrected directly. `public.refund_status` is declared in 0010 itself (`'pending','completed','rejected'`) and both columns use it. A repair migration would have been dead code guarding a state that cannot exist. **The migration numbering below therefore starts at 0011 for new work.** | `0010_customers_returns_refunds.sql` |
| `0011_profiles_and_auth.sql` | Identities + roles. | `public.app_role` enum (`admin`,`manager`,`cashier`,`inventory_clerk`,`viewer`); `public.profiles` (`id uuid pk references auth.users on delete cascade`, `username citext/text unique`, `name`, `role app_role not null`, `active boolean default true`, `created_at`, `updated_at`); trigger `on_auth_user_created` creating a profile; `public.current_role()` and `public.current_profile()` helpers; RLS: self-select; admin select-all; role changes only through `admin_set_user_role()` (SECURITY DEFINER, admin-checked); trigger precluding self-promotion. |
| `0012_shifts.sql` | Cashier drawer sessions. | `public.shift_status` enum (`open`,`closed`); `public.shifts` matching `ShiftRow` exactly (`shift_number text unique`, `branch`, `register`, `status`, `opening_cash numeric(14,2)`, `opening_at`, `opened_by text`, `opened_by_name`, `closing_cash`, `closed_at`, `closed_by`, `closed_by_name`, `notes`, `summary jsonb`, `adjustment_approved_by`, `adjustment_approved_by_name`, `adjustment_approved_at`, `created_at`, `updated_at`); partial unique index `one_open_shift` on `(status) where status='open'`; `shift_counters` + `next_shift_number()`; `open_shift()` / `close_shift()` / `approve_shift_adjustment()` RPCs with role checks and server-side freeze of the summary; RLS read for authenticated, **no direct write**. |
| `0013_expenses.sql` | Shift expenses. | `public.expense_category` and `public.expense_method` enums (mirroring `expenses/types.ts`); `public.expenses` matching `ExpenseRow`; `expense_counters` + `next_expense_number()`; `create_expense()` / `update_expense()` / `delete_expense()` RPCs (add = till tier, edit = manager+, delete = admin+); RLS read + no direct write. |
| `0014_audit_log.sql` | Append-only trail (WS6 server side). | `public.audit_entity` / `public.audit_action` enums; `public.audit_log` matching `AuditRow` (`id`, `action`, `entity`, `entity_id`, `entity_label`, `details jsonb`, `user_id`, `user_name`, `created_at`); indexes on `(created_at desc)`, `(entity, entity_id)`, `(user_id)`; **no update/delete policy, no update/delete grant**; triggers (§7.2) that write rows from the tables above; `authenticated` read restricted by role (manager/admin). |
| `0015_pos_card_payments.sql` | WS5 database side. The enum value is already there — `0012` added `visa` to `public.payment_method` because the expenses and refunds modules offered card payments while the enum did not. What remains is the POS path: relax the `amount_received` check on `sales` (today every non-InstaPay sale is treated as cash) and recreate `pos_complete_sale` with `'visa'` accepted. |
| `0016_refund_settlement.sql` | WS4 database side. | `refund_records` gains `settled_at`, `settled_by`, `settled_by_name` (nullable, backfilled from `created_at` for completed rows); `pos_settle_refund(uuid, text, text)` RPC — transactional, idempotent, role-checked, only `pending → completed` (or `→ rejected`); `pos_settle_refund` writes the audit row. |
| `0017_lookup_tables.sql` *(optional, decision D8)* | Branch / register registry instead of free text. | `public.branches`, `public.registers` with RLS read-only for authenticated; shifts and expenses reference them by name for now (`text` retained) so no app change is forced. |

**Ordering note:** PostgreSQL refuses to *use* an enum label in the transaction that added it, so a
file that adds a value must be followed by another that references it. `scripts/migrations.check.mjs`
applies each file in its own transaction and fails on a violation, so this rule is enforced rather
than remembered.

### 2.2 Repository and service-layer changes

| Area | Change | Files |
| --- | --- | --- |
| Enum/type parity | `refund_status` values shared by app + DB; new columns mapped. | `returns/types.ts`, `returns/data/supabaseRepository.ts`, `returns/data/demoRepository.ts` |
| Shift/expense/audit | Repositories already exist — re-validate every column name against the migration, add the new fields. | `shifts/data/supabaseRepository.ts`, `expenses/data/supabaseRepository.ts`, `audit/data/supabaseRepository.ts` |
| Mode selection | One shared helper instead of seven copies of the same decision. | new `src/lib/data/mode.ts`; refactor `*/data/index.ts` to use it |
| Residual demo coupling | Audit every direct `localStorage` / `safeStorage` use and confine it to demo repositories + `demoSeed`. | `lib/auth/services/sessionStore.ts`, `products/data/demoSeed.ts`, all `*/data/demoRepository.ts` |

### 2.3 Provisioning, config and deployment

| Item | Deliverable |
| --- | --- |
| Env template | `.env.example` documenting `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_CURRENCY`; note that these are **build-time** values. |
| Repo hygiene (previously deferred, now in scope) | `.gitignore` (`node_modules/`, `dist/`, `.env*`, `*.local`), remove or relocate the stray root `vite-env.d.ts` into `src/`, keep `vite.preview.config.ts` out of the repo (sandbox-only). |
| Live seed | `supabase/seed.sql` — one profile per role, a branch/register pair, a small category/product set, counters at 1. Demo seed stays separate. |
| Docs | `supabase/migrations/README.md` extended to 0017; new `docs/DEPLOYMENT.md` (provision → migrate → seed → build → host, plus rollback). |
| Root README | Short: what the app is, how to run demo, how to run live, how to run the suites. |

### 2.4 Moving off the demo dependency

Demo mode is **kept** (decision D5) but demoted to an explicit, documented fallback:

1. Live mode is selected whenever `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are valid — unchanged behaviour.
2. Demo-only affordances must be invisible in live mode: the login credential hint (already conditional), the catalog Reset button (already conditional), any seeded demo data.
3. A **mode-parity contract test** (§9-L2) runs the same assertions against both repositories of every module, so "demo works, live doesn't" becomes a test failure rather than a discovery.
4. Demo storage keys get a single owner module, so "are we depending on localStorage?" has one place to look.

### 2.5 Acceptance criteria

- `scripts/migrations.check.mjs` applies 0001→0017 in order, twice (idempotency), with zero errors. **Done for 0001→0014.**
- The same script asserts the schema satisfies the code: every table/RPC the repositories name exists, RLS is on, and no enum column defaults outside its labels.
- `supabase/seed.sql` applies cleanly after migrations.
- With live credentials set, every screen loads and the DOM smoke suite passes against Supabase.
- With credentials absent, every existing suite still passes unchanged (demo regression gate).

---

## 3. Workstream 2 — Real authentication (priority 2)

**Goal:** identities, sessions, login/logout and role mapping live in Supabase Auth, while the demo
repository keeps working for the offline path.

### 3.1 What already exists (reuse, do not rebuild)

`UserRepository` seam, `SupabaseUserRepository` (`signInWithPassword` + `profiles`), `AuthProvider`,
`RequireAuth`, `LoginRoute`, `RouteGuard`, `routes.ts` capability table, session store/service with TTLs,
`normalizeRole` role mapping, `auth.selftest.ts` (17) and `auth.flow.mjs` (9 steps). The login UI, guards and
role mapping are **done**; this workstream makes the *backend* real and closes the session gaps.

### 3.2 Work items

| # | Item | Files |
| --- | --- | --- |
| A1 | Profiles + role mapping against `auth.users` (WS1-M2 migration). No app change needed beyond `auth_id` (already in `AuthUser`). | migration `0012` |
| A2 | Provider-backed session: stop inventing a local token in live mode; project the Supabase session into `AuthSession` (`access_token` as `token`, expiry from the provider). | `lib/auth/services/authService.ts`, `sessionStore.ts` |
| A3 | Session sync: `client.auth.onAuthStateChange` → `AuthProvider` (SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT), including cross-tab sign-out. | `lib/auth/hooks/AuthProvider.tsx` |
| A4 | Refresh/expiry: provider refresh replaces the local sliding-expiry simulation in live mode; the 8 h / 7 d / 30 d model remains the demo policy. Expiry UX unchanged (login screen message). | `authService.ts`, `LoginPage.tsx` |
| A5 | Server-side revocation on logout (already called) + confirm the app clears local state even if the network call fails. | `AuthProvider.signOut` |
| A6 | User management screen (admin only): list users (`listUsers()` exists), create user, set/change role, activate/deactivate. New route `/settings/users` — also the first real `/settings` screen (see D6). | new `src/modules/settings/…`, migration `0012` admin RPCs |
| A7 | Password reset (self-service e-mail flow; admin-triggered reset in the user screen). | `LoginPage` ("forgot password"), new `ResetPasswordPage`, `settings` |
| A8 | Session events in the audit trail: `session.login`, `session.logout`, `session.login_failed`. | `audit` actions (WS6) + `AuthProvider` |
| A9 | Rate limiting / lockout after repeated failures (Supabase settings + an audit-driven counter). | config + `0015` audit |
| A10 | Close the pinned POS gap in the live path too: `profiles.role` must accept `cashier` and the matrix already grants it `sell`. | migration `0012` seed |

### 3.3 Acceptance criteria

- Login with a live account creates a real Supabase session; the shell shows the profile name and role.
- A profile with an unmapped/absent role is refused sign-in (fail closed) — already implemented, now exercised live.
- Sign-out revokes the provider session; a deep link after sign-out bounces to `#/login?next=…`.
- Token refresh keeps a long-running session alive without a re-login, and a revoked session ends within one heartbeat.
- Admin can create a user, assign a role, deactivate them; a deactivated user cannot sign in.
- `scripts/auth.flow.mjs` runs its 9 steps against live credentials (new `ALYQ_LIVE=1` mode) as well as demo.

---

## 4. Workstream 3 — Action-level authorization (priority 3)

**Goal:** every money-moving action is re-checked below the UI, in the app *and* in the database.

### 4.1 Client-side checks (closes F4)

Same shape as the two existing gates — `throw new AppError("FORBIDDEN", …)` (POS) / `{ code: "FORBIDDEN" }`
(inventory) — placed in the **service** (so every caller is covered) and mirrored in the provider for a
fast, UI-friendly failure.

| Module | Entry point | Capability | Files |
| --- | --- | --- | --- |
| Returns | `processReturn()` | `process_return` | `returns/services/returnService.ts`, `returns/hooks/ReturnProvider.tsx` |
| Refunds | `settleRefund()` (new, WS4) | `process_refund` + `approve_refund` (decision D1) | `returns/services/returnService.ts`, `ReturnProvider.tsx` |
| Expenses | `createExpense` / `updateExpense` / `deleteExpense` | `add_expense` / `edit_expense` / `delete_expense` | `expenses/services/expenseService.ts`, `ExpenseProvider.tsx` |
| Shifts | `openShift` / `closeShift` / `approveShiftAdjustment` | `open_shift` / `close_shift` / `approve_shift_adjustment` | `shifts/services/shiftService.ts`, `ShiftProvider.tsx` |
| Payments | `confirmPayment` (sale detail) | `confirm_payment` | `pos/pages/SaleDetailPage.tsx` (additive guard) |

Housekeeping in the same pass: replace the ad-hoc `Object.assign(new Error("FORBIDDEN"), …)` in
`InventoryProvider` with `AppError` so all four modules report identical error codes to the UI.

### 4.2 Server-side checks (live mode)

Every write RPC re-derives the caller's role from `profiles` via `current_role()` and raises
`insufficient_privilege` when the capability is missing — mirroring the capability list, not the UI. This is
the part that makes the client-side checks a convenience rather than the control.

### 4.3 Tests

- New `scripts/permissions.selftest.ts`: a **table-driven matrix test** — for each (action, role) pair, call
  the service with an injected identity and assert allow/deny. 4 modules × 5 roles × their actions, so a
  missing guard is a failing row rather than a manual audit.
- Extend `scripts/smoke.dom.mjs`: for a `viewer`, attempt each guarded action and assert the denial message
  and that **no** write happened to the data store.
- CI SQL test: call each RPC as a low-privilege role and assert `insufficient_privilege`.

---

## 5. Workstream 4 — Complete refund workflow (priority 4)

**Goal:** a refund has a real lifecycle, and money leaves the drawer only when it is settled.

### 5.1 State machine

```
                 create return (cashier, process_return)
                            │
        refund_method ∈ {cash, visa, instapay}
                            │
      ┌─────────────────────┴─────────────────────┐
refund_status = completed                  refund_status = pending
(paid at the counter)                      (owed / awaiting approval)
      │                                            │
      │                       settle (approve_refund) ──► completed  (settled_at, settled_by)
      │                                            └──► rejected  (no cash movement, reason)
      └──────────────► immutable record
```

Rules to encode: a refund is settled at most once (idempotent RPC); `rejected` never moves cash;
cumulative refunds per sale may never exceed the sale total (already enforced); settlement is the event that
deducts cash from a shift.

### 5.2 Changes

| Layer | Change | Files |
| --- | --- | --- |
| Types | `RefundRecord` gains `settled_at`, `settled_by`, `settled_by_name`, `rejection_reason`; status union becomes `pending \| completed \| rejected`. | `returns/types.ts` |
| Repository | `settleRefund(id, input)` on `ReturnRepository`; demo + Supabase implementations. | `returns/data/{repository,demoRepository,supabaseRepository}.ts` |
| Service/provider | `settleRefund` with an action-layer check, audit entry and list refresh. | `returns/services/returnService.ts`, `hooks/ReturnProvider.tsx` |
| UI | Return form gains the refund status choice (completed / pending); refund list gains a status filter and an explicit "pending" emphasis; refund detail gains **Settle** / **Reject** actions behind a confirm dialog with the amount restated. | `returns/components/ReturnFormModal.tsx`, `returns/pages/RefundsPage.tsx`, `returns/pages/RefundDetailPage.tsx` |
| Money model | A refund must deduct from the shift in which cash actually left: window completed refunds on `settled_at` (falling back to `created_at` for legacy/backfilled rows — behaviour identical to today for all existing data). | `shifts/services/shiftCalculations.ts`, `shifts/types.ts` (summary already reports `pending_refunds`) |
| Dashboard/audit | `pending_refunds` surfaced as an operational KPI (WS7); audit actions `refund.created`, `refund.settled`, `refund.rejected` (WS6). | `dashboard`, `audit` |
| DB | Migration `0016`: columns + `pos_settle_refund` RPC (role-checked, idempotent, audit-writing). The status enum itself is already correct (`0010` declares `refund_status`). | `supabase/migrations/0016` |

### 5.3 Acceptance criteria

- A cashier can record a return whose refund is `pending`; the shift's expected cash is unaffected.
- A later settlement (manager, per D1) moves the refund to `completed`, stamps who/when, writes an audit
  row, and reduces the expected cash **of the shift open at settlement time**.
- Double-settling is idempotent; a rejected refund never affects cash; the per-sale cap still holds.
- Existing behaviour is unchanged for refunds that are created `completed` (the current default) — the
  returns self-test (9/9) and the smoke return/refund sections must pass untouched.

---

## 6. Workstream 5 — Visa / card payments (priority 5)

**Goal:** the register accepts card payments without disturbing the existing cash/InstaPay flows.

### 6.1 Design rule (non-negotiable)

`smartPaymentCalc(total, cashTendered, instapay)` keeps its exact current behaviour for existing callers.
Card support is **additive**: an optional fourth argument (default `0`) and a new payment leg, so every
existing test and code path is byte-identical when no card amount is entered.

### 6.2 Changes

| Layer | Change | Files |
| --- | --- | --- |
| Types | `PAYMENT_METHODS = ["cash","instapay","visa"]`; receipt/payment labels. | `pos/types.ts` |
| Math | `smartPaymentCalc(total, cash, instapay, visa = 0)`; `autoBalanceOther` reused for a third leg; pure functions, fully unit-tested. | `pos/services/posMath.ts` |
| Payment UI | A card leg in the split area (amount + paid/pending selector, per D2) and assembly of `payments[]`; cash change logic untouched. | `pos/components/PaymentPanel.tsx` |
| Receipts | Card line in the receipt summary and the payment-method labels (EN + AR). | `pos/services/receiptStrings.ts`, `receipt.ts`, `lib/i18n/dictionary.ts` |
| Shift maths | `visa_sales` (and `visa_pending` if D2 chooses a pending card state) added to `ShiftSummary` + the summary grid; card money never enters expected cash (already the rule for non-cash). | `shifts/services/shiftCalculations.ts`, `shifts/components/ShiftSummaryGrid.tsx`, `shifts/types.ts` |
| Data | Demo + Supabase sale mapping accept `visa`; demo validation updated. | `pos/data/*Repository.ts`, `returns/*` (refund method already includes visa), `expenses/*` (already includes visa) |
| DB | Migration `0015`: enum value, relaxed `amount_received` check, `pos_complete_sale` accepting `visa`, `sale_payments` unchanged in shape. | `supabase/migrations/0015` |
| E2E | Card sale end-to-end, card refund, card expense, shift summary excluding card money. | `scripts/smoke.dom.mjs` (new block) |

### 6.3 Acceptance criteria

- POS logic self-test: the existing 34 assertions pass **unchanged**, plus new cases (card-only sale, cash+card split, card+InstaPay, change still correct for cash).
- A card sale completes, prints a receipt showing the card line, and appears in sales history with method `visa`.
- The shift summary reports card takings separately and leaves expected cash untouched — proven by the DOM smoke.
- The database rejects an unknown method and accepts `visa`.

---

## 7. Workstream 6 — Expand audit logging (priority 6)

**Goal:** every consequential change is recorded, with a trustworthy actor.

### 7.1 Coverage matrix

| Entity | Actions | Source |
| --- | --- | --- |
| `session` | `login`, `logout`, `login_failed` | app (auth events) |
| `sale` | `completed`, `voided`, `payment_confirmed` | DB trigger on `sales` + `sale_payments` |
| `return` | `created` | DB trigger on `sales_returns` |
| `refund` | `created`, `settled`, `rejected` | DB trigger on `refund_records` |
| `customer` | `created`, `updated`, `deleted` | DB trigger on `customers` |
| `product` | `created`, `updated`, `archived`, `restored`, `deleted` | DB trigger on `products` |
| `category` | `created`, `updated`, `deleted` | DB trigger on `categories` |
| `stock` | `adjusted` (movement committed) | DB trigger on `stock_movements` or the existing RPC |
| `shift` | `opened`, `closed`, `adjustment_approved` | already audited; move to trigger for server attribution |
| `expense` | `created`, `updated`, `deleted` | already audited; move to trigger |

### 7.2 Mechanism: server-side triggers, app enrichment

- **Triggers are the source of truth** in live mode: `after insert/update/delete` on the tables above writing
  `audit_log` rows with `auth.uid()` resolved to `profiles.name` — this removes the client-tamper gap (F7)
  and cannot be skipped by a client that forgets to call `recordAudit`.
- `recordAudit()` remains for (a) demo mode, (b) events with no table behind them (`session.*`), and (c)
  human-readable detail enrichment.
- Writes are append-only: no update/delete policy and no update/delete grant on `audit_log`.

### 7.3 App changes

| Item | Files |
| --- | --- |
| Extend `AUDIT_ACTIONS` / `AUDIT_ENTITIES` to the matrix above | `audit/types.ts` |
| EN + AR labels for every new action and entity | `lib/i18n/dictionary.ts` |
| Audit page: filter by entity as well as action, descriptions that name the record, paging beyond the current 500-row cap | `audit/pages/AuditLogPage.tsx`, `audit/services/auditService.ts` |
| Read access stays manager/admin (`view_audit_log`); the capability is unchanged | `lib/permissions/roles.ts` (no change), `audit/components/RequireAuditAccess.tsx` (no change) |
| Optional export (decision D9) | new `audit/services/auditExport.ts` |

### 7.4 Acceptance criteria

- Every row in §7.1 has a passing test: perform the action (demo + live) → assert exactly one audit row with the right action, entity, label and actor.
- A direct SQL write to `products` (bypassing the app) still produces an audit row — proving the trigger path.
- `audit_log` rejects update/delete attempts.
- A label exists for every action: a test iterates `AUDIT_ACTIONS` and fails on a missing translation (this is how the EN/AR gap surfaces instead of shipping).

---

## 8. Workstream 7 — Dashboard upgrade (priority 7)

**Goal:** the landing screen answers "how did we do today, and is anything wrong?" using data the app
already loads.

### 8.1 Content

| Group | Metrics | Source (existing hooks) |
| --- | --- | --- |
| Today | sales count, revenue, average basket, returns/refunds today | `usePos().sales`, `useReturns()` |
| Cash | open shift branch/register, opening cash, sales by channel (cash / InstaPay / card), expected cash, live difference | `useShifts()` |
| Spend | expenses today, cash vs non-cash | `useExpenses()` |
| Attention | low-stock and out-of-stock counts, pending InstaPay payments, pending refunds, unapproved shift differences | `useInventory()`, `usePos()`, `useReturns()`, `useShifts()` |
| Trend | 7-day sales/refund sparkline | derived from `sales` + `returns` |
| Activity | the last ~8 audit entries | `loadAuditLog()` (manager/admin only) |

### 8.2 Approach

- New `src/modules/dashboard/services/dashboardMetrics.ts`: **pure** functions taking the loaded collections
  plus a `now` argument, so all the arithmetic is unit-testable with a fixed clock (the Phase 8 lesson).
- New presentational components under `src/modules/dashboard/components/`, built only from existing
  primitives (`StatTile`, `Card`, `Badge`, `EmptyState`) per `docs/DESIGN_LANGUAGE.md`.
- Role awareness: money tiles respect the capability model — `viewer` sees counts only (decision D6).
- Empty states for every group (fresh install, no shift open, no sales yet).
- No new global provider: the dashboard already sits inside every module provider (`App.tsx`).

### 8.3 Acceptance criteria

- Metric self-test (fixed clock, seeded fixtures) covering: empty data, a day boundary, a voided sale, a
  pending refund excluded from revenue, card sales excluded from expected cash.
- DOM smoke: KPI values match the seeded demo data, in both languages, LTR and RTL, with no overflow.
- No change to any other screen's data or behaviour.

---

## 9. Testing strategy

### 9.1 Layers

| Layer | What it proves | How | Runs |
| --- | --- | --- | --- |
| **L1** Pure logic self-tests | Money math, validation, state machines | existing esbuild + `node` harness (`src/**/__tests__/*.selftest.ts`) | always |
| **L2** Repository contract tests | the schema provides what the repositories read and write | **built:** column parity (every `…Row` field must be a real column), capability/vocabulary/alias parity, and the role scenarios in `scripts/migrations.check.mjs` | always |
| **L3** Migration tests | migrations apply from scratch, in order, twice; seeds apply; RLS denies the wrong role | new `scripts/migrations.check.mjs` against a Postgres service container | CI |
| **L4** DOM smoke | the real UI works end to end in demo mode | `scripts/smoke.dom.mjs` (jsdom) — extended per workstream | always |
| **L5** Live E2E | the same flows against a real Supabase project | `scripts/smoke.live.mjs` (L4 against live credentials) | CI (nightly / on demand) |
| **L6** Permission matrix | action-level guards for every (action, role) pair, client and server | `supabase/tests/scenarios.sql` (13 scenarios run as each role, client-side matrix in `roles.selftest.ts`) | always |
| **L7** Audit coverage | every auditable action writes exactly one row with the right actor | `scripts/audit.coverage.selftest.ts` | always |

### 9.2 New/extended scripts

| Script | Purpose |
| --- | --- |
| `scripts/migrations.check.mjs` | Apply 0001→0017 in order (each file atomic), re-apply for idempotency, then assert the schema satisfies the code. Runs against in-process PGlite by default (no Docker, no server) or `--driver=psql --url=…` for a real project. |
| `scripts/contract.selftest.ts` | Interface parity: same inputs → same outputs for demo and live repositories; create/read/update/delete round-trips; error codes (`NOT_FOUND`, `VALIDATION`, `FORBIDDEN`, `CONFLICT` where applicable). |
| `scripts/permissions.selftest.ts` | Table-driven allow/deny matrix across the five roles for every guarded action. |
| `scripts/audit.coverage.selftest.ts` | Drives each auditable action and asserts the resulting trail row(s). |
| `scripts/smoke.live.mjs` | L4 pointed at live credentials via env vars (`ALYQ_BASE_URL`, plus a seeded live project). |
| `scripts/auth.flow.mjs` (extend) | Add live mode (`ALYQ_LIVE=1`) and the new user-management steps. |

### 9.3 Non-regression gates (must stay green at every merge)

| Gate | Baseline today |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | green, 964 kB / 254 kB gzip |
| roles self-test | 12/12 |
| auth self-test | 17/17 |
| products self-test | 36/36 |
| POS self-test | **34/34, unchanged assertions** |
| returns self-test | 9/9 |
| Phase 8 self-test | 17/17 |
| `scripts/auth.flow.mjs` | 9/9 |
| `scripts/smoke.dom.mjs` | green, 0 console errors |

### 9.4 CI

New `.github/workflows/ci.yml`:

1. **static** — `tsc --noEmit`, `vite build`, translation-completeness check (EN ↔ AR key parity), dead-key check.
2. **logic** — every `*.selftest.ts` plus `scripts/auth.flow.mjs`.
3. **dom** — `scripts/smoke.dom.mjs` (jsdom), artifacts on failure.
4. **database** — Postgres service container: `scripts/migrations.check.mjs` + RLS/RPC role tests (this job
   alone would have caught F1).
5. **live** *(optional until a staging project exists)* — `scripts/smoke.live.mjs` with secrets.

### 9.5 Definition of done for the phase

- All five CI jobs green; every workstream's acceptance criteria met.
- A fresh clone can: copy `.env.example` → `.env`, provision a project with migrations + seed, run live, and
  run every suite — with no undocumented step.
- No `localStorage` read outside demo repositories and the session store.
- Every guarded action is enforced twice (client + server) and covered by L6.
- Dashboard answers the "today" question from live data.

---

## 10. Sequencing, dependencies and risk

### 10.1 Milestones

| Milestone | Contents | Depends on |
| --- | --- | --- |
| **M0 — Foundations** ✅ | CI workflow, `.gitignore`, `.env.example`, README, `migrations.check.mjs`, the three migration defects (F1) | — |
| **M1 — Live schema** ✅ | `0011`–`0014`, seed, contract/parity checks, role scenarios (WS1) | M0 |
| **M2 — Identity** | Live auth + session sync + user management + reset (WS2); action-layer checks (WS3) | M1 (profiles), WS3 can start in parallel |
| **M3 — Money correctness** | Refund lifecycle (WS4) + card payments (WS5) | M1, M2 for settlement permissions |
| **M4 — Visibility** | Audit expansion (WS6) + dashboard upgrade (WS7) | M1 (audit_log + triggers), M3 (refund/card KPIs) |

### 10.2 Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Migration 0010 already applied somewhere and now diverges | None — it could never apply | Medium | The check script reports any divergence from a fresh build; `--verify-only` inspects a deployed project |
| Enum alteration requires a separate transaction | Medium | Medium | Split "add value" and "use value" into two migrations; test against the project's Postgres version |
| RLS misconfiguration locks staff out of their own data | Medium | High | Role-based RLS tests in CI; a documented "break glass" (service-role) recovery path |
| Card payments change existing POS behaviour | Medium | High | Additive optional parameter; the frozen-behaviour rule; the 34 POS assertions must pass unchanged |
| Refund settlement changes shift totals for historical data | Medium | Medium | `settled_at` backfilled from `created_at`; the money model is identical for all pre-existing rows |
| Audit triggers slow down hot paths (sales) | Low | Medium | Triggers are `after` inserts writing one narrow row; measure with a seeded volume test |
| Live E2E can't run in this environment (no Docker, no Supabase project) | High | Medium | L1/L2(demo)/L4 remain fully local; L3/L5 run in CI; nothing in the plan depends on local Docker |
| Scope creep into new features | Medium | Medium | §12 out-of-scope list; the phase is gated on the acceptance criteria above |

---

## 11. Decisions needed before coding

Each has a recommended default so work is not blocked.

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Refund approval: one step or two? | **Two-step**: cashier creates/requests (`process_return`), manager settles (`approve_refund`, a new capability granted to admin+manager). Matches the existing "manager approves a cash difference" precedent. |
| D2 | Does a card payment need a `pending` state (terminal confirmation separate from capture)? | **No for v1** — card sales complete as `paid`; the model already supports pending if a terminal integration arrives later. |
| D3 | Which timestamp decides the shift a settled refund deducts from? | **`settled_at`** — the cash leaves the drawer when it is paid, not when the return was recorded. |
| D4 | Live testing environment | **Local `supabase start` in CI** plus an optional staging project for `smoke.live.mjs`; never required for local dev. |
| D5 | Keep demo mode? | **Keep** as an explicit, documented fallback (and the offline dev path); never the default when credentials exist. |
| D6 | Should `viewer` see money on the dashboard? | **Counts only, no amounts** — consistent with `viewer` holding neither `sell` nor audit access. |
| D7 | Where does "Settings" live? | New `/settings` area hosting **Users & roles** (WS2-A6); other settings later. `viewer`/`cashier` have no access. Note: `/settings` **does not exist today** — there is no nav entry, no route and no capability row in `ROUTE_CAPABILITIES`, so the authentication phase's "protect Settings" item was satisfied only by the catch-all redirect. WS2 creates the screen and adds its capability row. |
| D8 | Add branch/register lookup tables now? | **Optional, last** — keep `text` columns working so no app change is forced. |
| D9 | Audit retention & export | **Keep the 500-row display cap but paginate the query**, add CSV export for managers; define retention (e.g. 24 months) in the deployment doc. |

---

## 12. Explicitly out of scope for this phase

- New POS product features beyond card payment: hold/park sale, camera scanning, PDF/e-mail receipts, quotes.
- A customer-facing storefront consuming `show_on_website` / `is_featured`.
- Multi-branch or multi-warehouse stock (single stock location stays).
- Loyalty/points, exchanges, customer credit ledgers.
- Offline/PWA operation, real-time multi-terminal sync.
- Languages beyond English and Arabic.
- Removing demo mode or the demo role switcher from the offline path.

---

## 13. Suggested relative sizing

| Workstream | Size | Why |
| --- | --- | --- |
| WS1 Live mode | **L** | 7 migrations, RLS/RPC design, seed, config, contract tests |
| WS2 Authentication | **M/L** | Backend is small; session sync + user management + reset are the bulk |
| WS3 Authorization | **S/M** | Mechanical guard placement + a table-driven test suite |
| WS4 Refunds | **M** | Schema + state machine + UI actions + shift-window subtlety |
| WS5 Visa/card | **M** | Additive but touches math, UI, receipts, DB enum and the shift summary |
| WS6 Audit | **M** | Triggers touch every table; app surface is mostly types + i18n + tests |
| WS7 Dashboard | **S/M** | Pure selectors + presentational tiles over existing data |

---

*No production-readiness code has been written yet. This plan is the deliverable for review; the
non-regression gates in §9.3 are the contract that protects the working POS during implementation.*

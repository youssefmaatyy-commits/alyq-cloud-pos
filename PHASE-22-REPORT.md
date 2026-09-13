# Phase 22 — Production Security, Live-Mode Hardening & Performance

**Branch:** `arena/01a09298-alyq-cloud-pos` · **Commit:** `0cce7af` (parent `c1f9b86`)
**Date:** 2026-09-13 · **Scope:** confirmed findings from `AUDIT-FINAL.md` only

---

## 1. Verdict

Every Critical and High finding from the audit is fixed and verified. The two
Medium findings that were code-level (Excel upload limits, CI/CD hygiene) are
fixed too, along with the dead-code and test-harness items. **Pushed** to
`origin/arena/01a09298-alyq-cloud-pos` (§12).

> **Correction, added by the verification pass (§14).** This verdict was written
> before the fixes were independently re-tested, and it was wrong in one place:
> **H1 was not fully closed.** A stale `with check (true)` insert policy from
> migration 0003 survived beside the new gated one on `categories`, and because
> row level security ORs the policies for a command, a viewer — who holds no
> write capability at all — could still insert a category with a forged request.
> The scenario suite passed with the hole open, because it tested the category
> UPDATE and DELETE paths but never the INSERT. Fixed in `0031`, with a
> schema-wide guard that now fails on any open write policy on any table (§14).

Nothing in the POS, inventory, order lifecycle, permission architecture, or
storefront design was changed. No new business feature was added.

## 2. Issues fixed

| ID | Finding | Fix |
|---|---|---|
| **C1** | Anon could not browse the live catalogue | Storefront reads through `SECURITY DEFINER` RPCs returning public fields only; `storefrontCatalog.ts` switched to them. No cost price, stock internals or supplier data crosses the boundary. |
| **C2** | Signup privilege escalation via client-supplied role metadata | The auth trigger no longer reads `raw_user_meta_data->>'role'`. Every new profile lands **inactive** with the **viewer** role; `alyq-admin` stopped accepting a role in signup metadata; role/activation changes are audited. |
| **H1** | Direct table writes bypassed the capability system | `products`, `categories`, `stock_movements` gated by `public.can()`; `public` revoked first so default privileges cannot re-open the door; counters **REVOKEd** from anon/authenticated (a document number cannot be advanced by hand); RLS added as a second door; a trigger catches cost/price movement that a policy cannot (policies cannot compare OLD to NEW). |
| **H2** | Reports read all history, filtered in the browser, silently truncated at 1,000 rows | Bounded, paged, counted queries (§5). |
| **H3** | A crash in any screen blanked the app and leaked stack traces | `ErrorBoundary` rewritten (readable message + reload, no stack, no internals) and mounted three times: shell, till, storefront — each with its own fallback. |
| **M1** | Excel import had no size or shape validation | 8 MB / 10,000 rows / 200 columns, **refused rather than truncated**, plus a binary-that-is-not-a-workbook check. |
| **M-CI** | Deploy workflow targeted a stale branch, Node 20, no static gate | Both workflows pin Node 22; deploy runs from `main`; lint + typecheck gate before build. |
| **M-lint** | No linter existed — conditional hooks were uncatchable by any test | ESLint 10 flat config with `react-hooks` rules; wired into `package.json` and CI. |
| **M-trig** | `updated_at` not maintained on several tables | `set_updated_at()` triggers added in 0030. |
| **M-dead** | `public/modules/` shipped 97 stale duplicates of source (844 KB) to anyone who asked | Deleted. Referenced by nothing. |
| **M7** | Offline test shim read only legacy JWT GUCs | `supabase-shim.sql` now reads `request.jwt.claims` (JSON, production form) *and* `request.jwt.claim.*`, preferring JSON; `auth.jwt()` added. Policies tested offline now behave as they do in the project. |

## 3. Files changed

**134 files changed, +4,112 / −17,149.**

- **Added (5):** `supabase/migrations/0030_live_mode_hardening.sql`, `eslint.config.js`, `src/modules/pos/data/saleListQuery.ts`, `src/modules/reports/__tests__/salesCoverage.selftest.ts`, `AUDIT-FINAL.md`
- **Deleted (97):** `public/modules/**` (stale duplicate source tree)
- **Modified (32):** database (`scenarios.sql`, `supabase-shim.sql`, `alyq-admin/index.ts`), POS data layer (`repository.ts`, `supabaseRepository.ts`, `demoRepository.ts`, `index.ts`, `PosProvider.tsx`), reports (`ReportsPage.tsx`, `dateRanges.ts`), Excel (`excelImport.ts`, `ExcelImportModal.tsx`, `products/data/repository.ts`, `excelImportWorkbook.selftest.ts`), shell (`App.tsx`, `ErrorBoundary.tsx`), storefront data (`storefrontCatalog.ts`), i18n (`dictionary.ts`), CI (both workflows), tooling (`package.json`, `package-lock.json`, 5 `scripts/*.mjs` lint fixes), and 6 product-code lint defects (`dashboardQuery.ts`, `receipt.ts`, `seo.ts`, `PaymentProofPanel.tsx`, `auth/data/supabaseRepository.ts`).

## 4. Migrations

**31 migrations**, `0030_live_mode_hardening.sql` (410 lines) and
`0031_category_insert_gate.sql` are new. Verified by `npm run db:check`: all 31
apply cleanly, **are idempotent** (re-applied in the
same run), and satisfy the application contract — 28 tables exist with RLS
enabled, 32 RPCs exist and are executable by `authenticated`, every repository
row interface matches its table, `role_capabilities` matches the app's matrix
(5 roles / 139 grants), `audit_actions` matches (55 actions / 16 entities),
`role_aliases` matches (11), and **every scenario passes**.

`supabase/tests/scenarios.sql` grew by 474 lines: anon storefront reads, signup
escalation attempts, direct-write attacks (including the silent-zero-rows case,
now asserted with `GET DIAGNOSTICS`), cashier cost-price rights, and counter
tampering.

## 5. Security improvements

1. **Anonymous attack surface reduced to a read-only public catalogue** — the storefront RPCs are the only path, and they cannot be persuaded to return internal columns.
2. **Signup can no longer mint an admin.** Role and activation come from the database, never from the client; the escalation attempt is audited rather than honoured.
3. **Capability checks moved into the database.** `public.can()` now gates the tables themselves, so a write that bypasses the UI is still refused. Revoking `public` first matters: default privileges would otherwise re-grant what the migration removed.
4. **Counters are not writable** by anon/authenticated — invoice, refund and document numbering stays inside its `SECURITY DEFINER` functions.
5. **Cost/price movement is trigger-enforced**, covering the case a policy structurally cannot (comparing OLD to NEW).
6. **No stack traces or internal detail reach a user.** All three boundaries show a message and a reload.
7. **Excel upload cannot be used as a memory bomb**: size, shape and row count are checked before parsing, and the reader stops early (`sheetRows`) instead of materialising a hostile workbook.
8. **The test harness now models production JWT handling**, so a policy that passes offline passes live.

## 6. Performance improvements

1. **`sale_payments` is no longer fetched whole.** Previously *every* sales refresh selected every payment row ever written; it now selects only the page's sales (`.in("sale_id", …)`).
2. **Date bounds, limit and offset are pushed into SQL** (`.gte` / `.lte` / `.range`) instead of downloading history and filtering it in the browser.
3. **Reports read their own bounded window** for the period on screen, through the same repository the till uses — no second data path, no fork of the sales contract.
4. **A single row cap** (`SALES_ROW_CAP = 1000`) is declared once in the contract and used by the repository default, the till window and the reports read. A ceiling that lives in three files drifts in one of them, and the drift looks like missing sales.
5. **844 KB of dead duplicated source no longer ships** in the public bundle.
6. **Lint is the cheapest CI gate** and now runs before typecheck, catching conditional hooks that no test renders.

## 7. Tests

- **Logic suites: 27/27 pass** (was 26). New: `salesCoverage.selftest.ts` — 10 tests covering inclusive local-day bounds, agreement between the SQL bounds and the client predicate at every edge, disjoint paging, counts that ignore paging, and truncation reproduced at **cap + 1 sales** (the acceptance criterion "test with 1000+ sales").
- **Excel suite: 23 → 29 tests** — oversize file, empty file, binary-that-is-not-a-workbook, CSV over the row cap, CSV exactly at the cap, workbook over the cap.
- **E2E: 4/4 suites pass** (smoke, auth, store, backup) with **0 console errors and 0 network calls**.
- **Database scenarios: all pass**, including the new attack scenarios.
- Two failures found and fixed during the phase: a doubled `];` from my own test splice, and `storefrontLink.selftest.ts` — a deliberate regression guard that reads `App.tsx` and asserts the literal `<Route path="/store"` still exists. My boundary work had reformatted that attribute onto its own line, which broke the guard without changing the routing. The literal was restored and the reason is now commented in `App.tsx` so the next person does not reformat it again.

## 8. Verification results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ exit 0 — **0 errors**, 23 warnings |
| `npm test` | ✅ **27/27** suites |
| `npm run test:e2e` | ✅ **4/4** suites, 0 console errors, 0 network calls |
| `npm run db:check` | ✅ 30 migrations, idempotent, all scenarios + contract checks green |
| `npm run build` | ✅ built in 6.25 s — `dist/index.html` 2,446.71 kB (gzip **656.23 kB**) |

## 9. What I deliberately did not change

POS logic, inventory logic, the order lifecycle, the permission architecture, the
database architecture (beyond the security fixes), storefront design, branding,
homepage layout, product cards and the customer experience. The `/store` and
`/pos` routes gained error boundaries — their paths, elements and ordering are
untouched. Reports still render the same numbers from the same builders; only the
*source window* and an added coverage notice changed.

## 10. Limitations and remaining work

1. **Aggregation is still client-side.** Reads are bounded and honest, but the 1,000-row PostgREST cap still limits how much detail one period can show. A period larger than the cap now *says so* and asks for a narrower range; the permanent fix is a database-side aggregation RPC (totals computed in SQL), which is a larger change than this phase's "no architecture churn" constraint allowed. **This is the main remaining item.**
2. **`xlsx@0.18.5` is the last version published to npm**; the maintained releases with CVE fixes ship only from the SheetJS CDN. The size/shape/row guards mitigate the exposure, but the dependency cannot be upgraded through npm.
3. **The DOM smoke E2E suite is slow (~3 min) and flaked once** — on the first combined run of this phase it reported a failure with no assertion detail; it then passed standalone and in two further full runs. I could not reproduce it and did not want to "fix" a suite I cannot observe failing. It should be watched in CI.
4. **23 lint warnings remain** (unused vars, `any`), 0 errors. One `react-hooks/exhaustive-deps` warning in `PosProvider.completeSale` is **pre-existing** (verified against the stashed tree) and was left alone: removing a dependency from the sale-completion path is exactly the kind of POS change this phase forbids.
5. **Live-project checks were not run.** The `ci.yml` live job needs real Supabase credentials; everything here was verified against the offline harness and the migration checker.
6. **The coverage notice is new UI text** on the reports page (English + Arabic). It appears only when a read is genuinely truncated, so it is invisible in normal use.

## 11. Commit

`0cce7af` — *"Phase 22: live-mode hardening — storefront access, signup
escalation, write gates, bounded reports"*. The message documents each finding
and the reasoning behind the non-obvious decisions (why the cap is declared once,
why local-day bounds, why a failed ranged read falls back instead of blanking).

## 12. Push status — ✅ PUSHED

`0cce7af` (the fixes) and `83b8fb8` (this report) were committed while the
workspace's GitHub credential was expired, so they sat local-only. The credential
is valid again and both were pushed:

```
c1f9b86..83b8fb8  arena/01a09298-alyq-cloud-pos -> arena/01a09298-alyq-cloud-pos
```

`0031` and the policy-set scenario (§14) were pushed in the same session. Nothing
was force-pushed, no remote was rewritten, and no credentials were requested or
stored.

## 13. Working tree status

**Clean.** All 134 file changes of the first pass are in `0cce7af`; the
verification pass adds two files (§14) and nothing else. `dist/` remains
gitignored, so the re-run build did not pollute the tree. Temporary probe scripts
were deleted after use — no `scripts/tmp-*` remains.

---

## 14. Verification pass — what was re-tested, and the one hole it found

Everything above was re-verified from scratch rather than taken on trust, using a
49-check probe written from the audit findings instead of from the fixes: each
attack the audit proved possible is re-attempted, and each legitimate write is
re-allowed, so an over-tight policy fails the probe rather than failing in
production. **49/49 pass** after the fix below — 48/49 before it.

### 14.1 The finding: an open policy beside a gated one

| | |
|---|---|
| Table | `public.categories` |
| Policies in force | `categories_insert_authenticated` (0030, `with check (public.can('add_product'))`) **and** `categories_write_authenticated` (0003, `with check (true)`) |
| Why it mattered | RLS ORs the policies applying to a command, so one open policy defeats every gated policy beside it — any signed-in identity could insert a category. |
| Who could do it | A viewer. The seeded viewer holds *no* write capability: `add_product`, `edit_product`, `delete_product`, `change_price`, `change_cost` and `adjust_stock` all resolve false. |
| Why nothing caught it | The scenario suite asserted the category UPDATE and DELETE paths, never INSERT. 0030 dropped the policy name it knew — a name that did not exist until 0030 created it — and never looked for a differently-named one. |
| Why the UI hid it | `catalogService.ts` requires `add_product` before offering the button and `actions.ts` already declares the rule as "RLS insert on categories — add_product". The policy set simply disagreed with the rule the application documented. |

**Fix — `0031_category_insert_gate.sql`:** drops `categories_write_authenticated`
and restates the gated policy, so the migration states its own end condition and
re-applies cleanly. Nothing else writes categories: the only other inserts are
the migration seed and the test fixture, both running as the table owner, and no
security-invoker function touches the table.

### 14.2 The guard that keeps this class of bug dead

`scenarios.sql` now asserts the *shape of the policy set* rather than the outcome
of one statement: it fails if **any** public table carries an INSERT / UPDATE /
DELETE / ALL policy whose `qual` or `with_check` is literally `true`. Proven to
bite — reintroducing the 0003 policy fails the check, and so does an open UPDATE
on `sales`; removing either passes. `npm run db:check` runs in CI (twice), so the
guard gates every push and pull request.

That is how the hole survived thirty migrations: a per-table test can only catch
the attack somebody thought to write. The sweep catches the ones nobody wrote.

### 14.3 What the probe confirmed, by finding

**C1 (9 checks)** — anon browses 3/3 website-visible products and 6 categories
through the definer RPCs; the 20 returned columns include no `cost_price`, no
`low_stock_level`, no `created_by`/`updated_by`; anon still reads 0 rows from
`products` and `customers` directly and cannot call the till RPC; staff still
read `products` directly.

**C2 (9 checks)** — signups declaring `admin`, `owner`, `superadmin`, `manager`,
nothing at all, and a quote-injection string each land `viewer` + inactive; a
real admin can still promote and activate; a cashier cannot promote anybody; a
viewer cannot self-promote.

**H1 (18 checks)** — a viewer is refused on price, cost, product insert,
**category insert**, stock-movement insert, counter rewrite and product delete;
anon is refused on the counter. Every legitimate write still works: all four
roles that hold `change_price` in the shipped matrix (admin, manager, cashier,
inventory_clerk) can reprice, admin can move a cost, manager can add a product,
cashier can add a category, and a clerk can record a movement and adjust stock.

The price trigger bites an *overlay* rather than the base matrix, so it was
tested that way: denying `change_price` for one cashier via
`admin_set_user_exceptions` stops that cashier moving a price ("Changing a
selling price requires the change_price capability") while leaving every other
edit intact, and clearing the denial restores the right.

**Regression (3 checks)** — a cashier still completes a sale end to end through
`pos_complete_sale`, stock decrements 10 → 8 through the definer path with the
new BEFORE UPDATE trigger installed, and the storefront still serves anon
afterwards.

**Quality (6 checks)** — `updated_at` advances at millisecond precision on write
(22 tables carry the trigger), `profiles.custom_role_id` is indexed, 0030 and
0031 both re-apply cleanly, and no ungated write policy remains anywhere.

### 14.4 Four probe failures that were the probe's fault

Recorded because each is a fact about the system that is easy to get wrong:

* **"a viewer deleted a product"** — it did not. A refused DELETE affects 0 rows
  and raises nothing, so the probe's own detail label was misleading; the row
  count is the assertion.
* **"a clerk moved a price"** — `inventory_clerk` *holds* `change_price` in the
  shipped matrix, so allowing it is correct. Expectations are now read from
  `role_capabilities` instead of assumed.
* **"the till refused a sale"** — the payload key is `lines`; `items` is not read
  by the current definition. Every seeded product also ships with
  `stock_quantity = 0`, so a sale needs a stocked shelf first.
* **"`updated_at` did not move"** — it moved by 14 ms; the probe compared
  second-precision `Date` strings.

### 14.5 Gates re-run

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 23 warnings |
| `npm test` | ✅ exit 0 — 27/27 suites |
| `npm run db:check` | ✅ 31 migrations, idempotent, all scenarios and contract checks green, including the new policy-set guard |
| `npm run build` | ✅ 6.69 s — `dist/index.html` 2,446.71 kB (gzip 656.23 kB) |
| `npm run test:e2e` | ✅ 4/4 suites, 0 console errors, 0 network calls |
| Independent security probe | ✅ 49/49 |

The E2E flake noted in §10.3 did not recur.

`xlsx` was re-checked against the registry rather than assumed: **npm's latest is
0.18.5**, the version already pinned, so §10.2 stands — the maintained releases
ship only from the SheetJS CDN and the size / shape / row guards remain the
mitigation.

### 14.6 Remaining limitation, unchanged

§10.1 is still the main open item. Report reads are bounded, date-filtered in
SQL, paged, counted, and honest about truncation — `listSales` and `countSales`
over one window, with a coverage line in English and Arabic whenever `total`
exceeds what was shown — but the aggregation is still client-side, so a period
wider than the 1,000-row cap displays its most recent 1,000 sales and says so.
Closing it properly means a database-side aggregation RPC computing totals in
SQL, which is a change to the reports data path that this phase's "no
architecture churn" constraint excluded.

---

## 15. Second verification pass — the missing crash test, and two harness findings

Re-checked against the phase brief section by section rather than against the
previous report. Twelve of the thirteen sections were already satisfied and are
unchanged. Two real gaps were found and closed, and one harness weakness was
measured and is recorded rather than silently altered.

### 15.1 §12 gap: there was no React crash-recovery test

The brief requires new tests for anonymous storefront, signup escalation, direct
write attacks, large reports, **React crash recovery** and Excel size validation.
Five existed. The sixth did not: `ErrorBoundary` was referenced only by
`App.tsx` and its own file, so nothing proved any of its three mount points
worked. A boundary that is never rendered past a crash is indistinguishable from
one that is missing.

**Added — `scripts/crash.flow.mjs` + `scripts/lib/crash-entry.ts`**, registered
as the `crash` suite in `scripts/test.e2e.mjs` (so it runs under
`npm run test:e2e` and in CI). It bundles the entry to its own outfile because a
crash has to be forced deterministically and the application has no component
that throws on purpose. Eight steps:

| # | Asserts |
|---|---|
| 1 | A healthy tree renders straight through the boundary, logging nothing |
| 2 | A render crash shows a recovery screen (EN **and** AR) instead of a blank page |
| 3 | The screen says nothing was lost and offers a reload |
| 4 | No secret, raw message or stack frame reaches the DOM |
| 5 | The detail **does** reach the console — the one place it may go |
| 6 | The reload button actually asks the browser to reload |
| 7 | A boundary given a `fallback` shows that instead of the generic screen (the storefront/till path) |
| 8 | A crash in one subtree leaves its sibling still rendering |

Step 8 is the one that justifies mounting three boundaries instead of one: it is
the difference between "this screen broke" and "the application died".

The thrown error deliberately carries `sk-live-51HsuperSECRETtoken` and
`src/lib/supabase/client.ts:42`, so steps 4 and 5 are assertions about real
strings rather than about the absence of a pattern nobody would print.

**Negative controls — the suite was broken on purpose to prove it can fail:**

* `if (this.state.hasError)` → `if (false)` (boundary never engages): **5 steps
  fail** (2, 3, 6, 7, 8).
* The error message and stack rendered into a `<pre>` — exactly what the
  pre-Phase-22 boundary did: **step 4 fails** on the leaked token.

Both were reverted; `ErrorBoundary.tsx` is byte-identical to `HEAD`.

### 15.2 Harness finding: the window console stub does not observe the bundle

Step 5 initially reported **0 console errors** while React and the boundary were
visibly logging. The cause: the suites stub `dom.window.console.error`, but the
bundle executes in Node's module scope, where a bare `console.error` is **Node's**
console. Only an explicit `window.console.error` call would reach the stub.
Measured directly: for the same crash, the window stub captured 0 and the Node
stub captured 6.

`crash.flow.mjs` therefore captures both. **The other four suites were left
exactly as they are**, per the standing instruction not to change their console
capture. It is recorded here because it means their `console errors: 0` line is
weaker evidence than it reads: it would not observe a React error, a warning, or
anything the app logs through the bare global. Making those suites capture
Node's console too is a one-line change per suite and is recommended, but it is
a test-harness decision that belongs to whoever owns that instruction, not to
this phase.

Also worth recording: `window.location.reload()` **cannot be stubbed** under
jsdom. It is an own, non-configurable property of the location instance
(`[LegacyUnforgeable]`), so a prototype stub is shadowed and an instance
redefine throws `Cannot redefine property: reload`. Step 6 observes the call
through a `VirtualConsole` `jsdomError` (`Not implemented: navigation to another
Document`) instead, which proves the handler fired and asked for a reload.

### 15.3 Repository recovery — the local clone was reset, the remote was not

Mid-session the sandbox recycled: `.git` was re-cloned fresh, landing the branch
at `90ba299` (its original branch point, around migration 0016), while the
workspace **files** were restored from the persisted snapshot at their latest
state. The result was a tree containing all of Phase 22 on top of a HEAD that
pre-dated it — hundreds of files showing as modified or untracked, and
`git show HEAD:src/components/ErrorBoundary.tsx` returning the old screen that
printed `error.stack` into a `<pre>`.

Nothing was lost and nothing was force-pushed. `git ls-remote` confirmed the
remote still held `3f7a2e998f0bc725a351aead5570d18db70ea02c`; recovery was
`git fetch origin arena/01a09298-alyq-cloud-pos` followed by
`git reset --mixed FETCH_HEAD`, which moves the branch pointer and the index
**without touching a single working file**. Afterwards the tree differed from
the pushed commit by exactly the three files this pass added. `node_modules` had
also been wiped by the recycle (0 entries) and was restored with `npm ci` from
the committed lockfile — 251 packages, 5 s.

This is worth knowing for any future session: after a recycle, verify
`git rev-parse HEAD` against `git ls-remote` **before** trusting `git status`.
A dirty tree that large is a reset clone, not uncommitted work.

### 15.4 Gates after this pass

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 23 warnings (unchanged — the new files added none) |
| `npm test` | ✅ exit 0 — 27/27 suites |
| `npm run db:check` | ✅ 31 migrations, idempotent, all scenarios green |
| `npm run build` | ✅ 6.66 s — 2,446.71 kB (gzip 656.23 kB), unchanged |
| `npm run test:e2e` | ✅ **5/5 suites** (smoke, auth, store, backup, crash), 0 network calls |
| `scripts/crash.flow.mjs` | ✅ 8/8, both negative controls fail as intended |

### 15.5 E2E, through the runner

`npm run test:e2e` → **5/5 suites passed**, exit 0: smoke, auth, store, backup,
crash. The runner builds the app bundle once and spawns each suite; `crash`
builds its own entry bundle and so is independent of that step. Network calls: 0.

The §14.5 figure of 4/4 was correct when written and is superseded by this one.
The flake noted in §10.3 did not recur in this run either.

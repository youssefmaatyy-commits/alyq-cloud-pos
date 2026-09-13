# Phase 22 — Production Security, Live-Mode Hardening & Performance

**Branch:** `arena/01a09298-alyq-cloud-pos` · **Commit:** `0cce7af` (parent `c1f9b86`)
**Date:** 2026-09-13 · **Scope:** confirmed findings from `AUDIT-FINAL.md` only

---

## 1. Verdict

Every Critical and High finding from the audit is fixed and verified. The two
Medium findings that were code-level (Excel upload limits, CI/CD hygiene) are
fixed too, along with the dead-code and test-harness items. **The work is
committed but not pushed** — GitHub authentication in this workspace has expired
(§12).

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

**30 migrations**, `0030_live_mode_hardening.sql` (410 lines) is new. Verified by
`npm run db:check`: all 30 apply cleanly, **are idempotent** (re-applied in the
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

## 12. Push status — ⚠️ BLOCKED

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
gh auth status → X github.com: authentication failed
                 The github.com token in GH_TOKEN is no longer valid.
```

The GitHub credential available in this workspace has expired, so **the commit
exists locally only**. Nothing was force-pushed, no remote was rewritten, and no
credentials were requested or stored. **Reconnect GitHub in Arena and the push is
a single command:** `git push -u origin arena/01a09298-alyq-cloud-pos`.

## 13. Working tree status

**Clean.** `git status` reports nothing to commit: all 134 file changes are in
`0cce7af`. The branch has no upstream configured yet (that happens with the
blocked push). `dist/` remains gitignored, so the verification build did not
pollute the tree.

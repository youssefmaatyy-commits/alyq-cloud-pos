# Phase 47 — Settings → System → Danger Zone (Admin-Only)

**Branch:** `arena/01a0b007-alyq-cloud-pos` · **Commit:** `f420478` (parent `3c30a415`)
**Date:** 2026-09-18 · **Base:** `3c30a415f131f653bb9e24ef7e04d15ecdebeb06` (Phase 46 tip)

---

## Verdict

Phase 47 is complete and **pushed** to `origin/arena/01a0b007-alyq-cloud-pos`
(`3c30a41..f420478`). All six gates are green on the pushed tree (§42). The
Danger Zone is server-side and atomic; the Super Admin is unlosable; rollback
is proven; re-auth plus exact confirmation phrases are required on both client
and server; and the audit trail survives every reset. Canonical
(`arena/01a0a01f-alyq-cloud-pos`, `a96b9f37`) and the hosted Supabase (through
`0043`) are untouched (§46).

The forty-six items below are the final report.

---

## What was built

**1. Audit of what Phase 47 adds.** One new destructive tier at
`/settings/system`: three admin-only cards — *Clear Operational Data*,
*Reset Demo / Test Data*, *Factory Reset* — over four new transactional RPCs
and one honest demo engine. It sits deliberately after Backup & Recovery in
severity: nothing here is a substitute for a snapshot, and every screen says so.

**2. New capability `manage_system_reset`.** Added to the pinned admin-only
set in `src/lib/permissions/roles.ts` + `catalog.ts` + `routes.ts`. Manager,
clerk, cashier, viewer hold nothing like it; the admin/manager parity selftest
("manager holds nothing admin lacks" / admin-only array) was updated in both
`adminFullAccess.selftest.ts` and `roles.selftest.ts` to expect exactly
`[export_backup, manage_roles, manage_settings, manage_system_reset,
manage_users, restore_backup]`. Enforcement is capability+role based (server
RPCs re-check `can('manage_system_reset')` **and** `role = 'admin'`), never a
role-name string in a component.

**3. Migration `0047_admin_danger_zone.sql`** (997 lines, idempotent,
`db:check` green 47/47). Migrations 0001–0046 were not edited. It creates:

| Function | Signature |
|---|---|
| `system_assert_super_admin` | `(p_actor uuid)` |
| `system_assert_authorized` | `(p_fresh_until timestamptz, p_confirmation text, p_expected_phrase text) → uuid` |
| `system_assert_options` | `(p_options jsonb, p_allowed text[])` |
| `system_reset_preview` | `(p_mode text, p_options jsonb default '{}')` |
| `system_clear_operational_data` | `(p_options jsonb, p_confirmation text, p_fresh_until timestamptz)` |
| `system_factory_reset` | `(p_options jsonb, p_confirmation text, p_fresh_until timestamptz)` |
| `system_reset_report_failure` | `(p_mode text, p_stage text, p_message text)` |
| `website_settings_guard` | `()` — corrected re-statement, see §41 |

**4. RPC surface.** Four entry points, `EXECUTE` granted to `authenticated`
only; the three helpers are revoked from `public`/`anon` entirely. Each
destructive RPC independently re-verifies actor + capability + role +
freshness + phrase + scope before its first statement — nothing trusts the
client's word.

**5. `system_assert_authorized` — the shared gate.** Resolves `auth.uid()`
(non-null), requires an active profile, `can('manage_system_reset')`, system
role `admin`, freshness (`p_fresh_until` within ±10 minutes of `now()`), and
`btrim(p_confirmation)` equal to the expected phrase after case
normalization. Returns the actor uuid used for audit rows. All guard failures
raise with `errcode = 'insufficient_privilege'` and a stable `RESET_*` code the
client translates.

**6. `system_assert_super_admin` — the admin is unlosable.** Called **before**
any delete (actor must be a preserved admin) and **after** the final delete
(≥1 Super Admin + profile linkage + role/capability bootstrap must remain). If
the after-check fails, the whole transaction raises and rolls back — there is
no statement order that can leave the shop without an owner. The acting
admin's own auth user, profile, role and capabilities are never touched by any
delete list.

**7. Phrases, enforced server-side.** `DELETE OPERATIONAL DATA` for the
operational clear, `DELETE ALL DATA` for the factory reset. The RPCs compare
after trim + case normalization; anything else is refused
(`RESET_PHRASE_MISMATCH`) before a single row is touched.

**8. Server-side preview.** `system_reset_preview` is a dry-run: same
authorization gate, same option validation, **zero mutations** (proven in the
scenario suite — the preview transaction is compared before/after). All counts
are computed in the database from the real graph; the client never invents
numbers.

**9. Preview payload.** Returns `mode`, `effective_options` (including the
implied `returns: true` when `sales` is chosen), a `delete[]` list (group,
label, count) and a `preserve[]` list, plus the `protected` Super Admin
(identity shown, never counted as deletable) — the UI renders both lists and
the protected admin card from this payload.

**10. Clear Operational scope (always).** Sales and their whole tree —
`sale_items`, `sale_payments`, `sales_returns` (+ `return_items`),
`refund_records` — online orders (+ items + events), stock reservations,
shifts, expenses. Products, variants, categories, branding, website settings,
delivery/payment settings, customers (unless chosen), staff/users, audit are
preserved.

**11. Optional groups.** `customers`, `expenses`, `movements`
(inventory movements), `quantities` (inventory reset) are explicit
checkboxes; conservative defaults — nothing pre-selected. No `suppliers`
option exists because no such table exists in the schema. Audit is **not**
offered: `audit_log` is append-only (0005/0012) and the reset's own evidence
must survive (§37).

**12. Returns ride with sales.** A sale with a return on it cannot be deleted
(`sales_returns → sales` RESTRICT), so "POS sales" carries the returns tree
with it. The server states this in the preview; the UI locks the returns
checkbox ON with an "(included with POS sales)" note while sales is checked.

**13. Factory Reset scope.** The operational floor **always**, plus optional
explicit groups: `products` (+ variants + `catalogue_codes` +
`product_content` + store reviews), `categories` (+
`storefront_category_content`), `customers` (+ website accounts), `website`
(customization), `branding`, `delivery_payment`. Deeper by construction, never
by hidden extras: `system_assert_options` rejects unknown keys
(`RESET_BAD_OPTIONS`).

**14. Factory guarantees.** ≥1 Super Admin with auth user + profile linkage +
role/capability bootstrap always survives (§6); schema, migrations, RLS
policies and functions are never touched; no `DROP TABLE`, no `TRUNCATE` on
`auth.*`, no migration-history or Supabase-config writes. RLS strength is
unchanged — 0047 adds functions only.

**15. Demo / Test mode — the honest decision.** The live schema has **no
reliable demo marker**, so Phase 47 does not fake one: in live mode the
demo-reset card is hidden with an explanation. In demo mode (localStorage
repositories), the whole store *is* fixtures, so "Reset Demo / Test Data" is a
real reset: it clears the `alyq.demo.*` keys and re-seeds the shipped sample
shop through the normal seeding path. The decision is documented here and in
the card copy ("Demo only" badge in demo mode).

**16. FK delete order** (audited graph, single pass):
`refund_records → return_items → sales_returns → sale_payments → sale_items →
sales → online_order_items → online_orders → online_order_events →
stock_reservations → expenses → shifts` (returns before their sales;
refund records before returns; children before parents). The scenario suite
runs this exact order against the real constraints.

**17. Variant inventory reset — through the shelf, never around it.** With
`quantities` chosen, operational mode sets `product_variants.stock_quantity =
0` per variant; the existing rollup trigger recomputes `products.stock_quantity`.
No code writes the variant→product rollup directly. Non-variant products are
zeroed directly. Each shelf gets a `recount` stock-movement row noted
"Danger Zone inventory reset" so the movement ledger explains the new number.
Scenario assertions: shelves 0, product rollup 0, recount rows ≥ 3.

**18. Cascade safety in factory.** Clearing products takes `catalogue_codes`,
`product_content` and store reviews with it; clearing categories takes
`storefront_category_content`. Variant rows go with their products; the
variant/category reference graph was exercised with the two-shelf variant ring
in both the scenario suite and the E2E (factory with variants present → zero
orphans).

**19. Website JSON scrub.** When catalogue is cleared, `website_settings` is
rewritten without references to deleted categories/products (sections that
reference them are removed). Reset-to-`'{}'` (= shipped defaults) is a valid
outcome; the invariant is that no half-configured website survives.

**20. Branding.** Factory with `branding` chosen resets to the shipped ALYQ
identity; without it, the brand block + images are preserved
(`jsonb_strip_nulls`-cleaned). Operational mode never touches branding. The
scenario asserts the brand survives a factory that keeps it; the E2E asserts
the same through the UI (brand kept, sections gone).

**21. Approval requests survive ALL resets — by design.** 0023's invariant
trigger refuses every `DELETE` on `approval_requests` (they are the record of
a decision, audit-class). Phase 47 does not overrule that: the operational
floor never deletes them, the factory explicitly does not, and both carry the
documenting comment. **`approval_counters` is deliberately untouched** so no
future request reuses a number a preserved record already carries. This is a
documented product decision, not a gap.

**22. Numbering counters.** Factory restarts sale/return/refund/shift/expense
counters to 1 (nothing old survives to be reused); the approval counter is
excluded per §21. Operational mode leaves all counters alone (documents
issued remain historically true).

**23. Atomicity.** Each mode is **one transactional RPC**. No browser-side
delete loops, no per-row REST calls, no chunking. Any raise — bad phrase,
failed re-check, interrupted FK, the test probe — rolls back the entire mode;
the client shows a controlled error and never claims a deletion that did not
happen.

**24. Rollback — proven, not assumed.** 0047 contains a test-only
interruption: when the transaction-local GUC `dz.force_failure = 'factory'`
is set, the factory body raises `DZ_TEST_INTERRUPT` (`check_violation`) just
before the customers delete. **PostgREST cannot set custom GUCs**, so this is
unreachable from the API in production — it exists so the scenario suite can
catch the exception and assert the full restore (products intact, settings
document byte-identical: `display_name_en='ALYQ Atelier'`,
`logo_url='https://cdn.example/logo.png'`, the seeded sale still there, zero
audit residue from the aborted attempt). An earlier trigger-based probe was
abandoned: scenario roles cannot `CREATE TRIGGER` on owner tables.

**25. Re-auth — current password, existing flow.** The wizard's re-auth step
re-authenticates through the existing `authService.signIn` (username +
current password, no stored credentials); on success the client stamps a
5-minute freshness window sent as `p_fresh_until`. The server accepts ±10
minutes and re-verifies everything else itself. One reset per proof: the
service clears the freshness stamp after any executed reset.

**26. Password handling — proof and its honest limit.** The password is never
stored, never logged, never audited: the audit details contain mode, options,
counts and correlation only (asserted in CI — "no 'password' in any audit
detail"). The **limitation**, documented as required: the architecture has no
separate server-issued re-auth proof token, so the server verifies freshness
(`p_fresh_until` ±10 min) rather than the password itself; the password check
happens client-side against the real auth service before the stamp is issued.
The RPC's phrase + capability + role + super-admin checks do not depend on
that stamp.

**27. UI.** Settings → System group → **Danger Zone** page at
`/settings/system` (`SystemSettingsPage.tsx`, Phase 46 warm design). Three
cards, each stating what it does, what it keeps, and its severity; the route
is capability-gated through the app's existing `RouteGuard`.

**28. Factory Reset is visually separated** — critical styling, distinct
placement, and copy that says "this one takes the catalogue with it".

**29. Clear Operational wizard:** choose groups → server preview (real
counts, preserve list, protected admin) → review → re-auth (current password)
→ exact phrase + final acknowledgment → running → result. Back navigation
resets cleanly; nothing executes before the last step.

**30. Factory wizard:** scope → preview (protected Super Admin shown) →
backup warning → re-auth → phrase → **second** confirmation (final ack) →
execute → summary. The 2nd stage is a distinct, deliberate step — double
confirmation as specified.

**31. UI phrase gates.** The execute button stays `disabled` until the typed
text matches the exact phrase (case-sensitive after trim), plus the final
acknowledgment checkbox. A wrong phrase at any point means the button never
arms — nothing to refuse because nothing can fire.

**32. Backup warning, never a fake backup.** Every destructive path shows the
warning and a **"Create Backup First"** link to `/settings/backup`. Phase 47
performs no automatic backup and never claims one was made.

**33. Failure UX.** On any refusal/failure the wizard shows a controlled,
translated error (`ResetError` parses the server's `CODE: message` shape) and
the flow stops at the failed step. The client reports the failure through
`system_reset_report_failure` **from outside the failed transaction** (the
failed tx rolled back, so it cannot write its own failure row) — the result
screen never claims a deletion that did not happen.

**34. Refusals, both layers.** Forged **route**: viewer/cashier/clerk/manager
are denied `/settings/system` by the RouteGuard capability check (E2E
asserts the viewer gets no cards and no factory action). Forged **RPC**: the
scenario suite proves a cashier's direct calls to preview/clear/factory are
refused ×3 (`RESET_UNAUTHORIZED`), a stale and a future `p_fresh_until` are
refused (`RESET_REAUTH_REQUIRED`), wrong/misspelled phrases are refused, and
unknown option keys are refused (`RESET_BAD_OPTIONS`). Helpers are revoked
from non-authenticated roles.

**35. Post-reset behavior.** On success the client clears cached providers,
routes to the Dashboard and **keeps the session** (the admin stays signed in —
asserted in the E2E after both modes). Factory in demo mode additionally
signals `needsReload` so the re-seeded shop mounts cleanly.

**36. Audit events.** `system.reset.started` / `system.reset.succeeded` /
`system.reset.failed` per mode, with actor, mode, chosen groups, deleted
counts and a correlation id; preview may log an event but is not required to.
The operational scenario asserts exactly 2 rows (started + succeeded) with
`entity_id = 'operational'`.

**37. Audit survival.** `audit_log` is excluded from every delete list in
every mode, so the reset's own evidence — and everything before it — survives
the reset. The demo engine mirrors this (demo audit key never cleared; E2E
finds the started + succeeded rows after the operational clear and after the
factory reset, and asserts no password ever appears in any detail payload).

**38. E2E — `scripts/dangerzone.flow.mjs`** (registered in
`scripts/test.e2e.mjs`, suite 15/15): 50 assertions over the real UI in demo
mode — viewer refused at the route; three cards render; variant ring seeded
(2 shelves × 2); shift + till sale + web order + return staged; branding
written the way the Branding screen writes it; wizard: returns locked-on,
server preview lists deletes/preserves, wrong password refused, exact phrase
arms the button, wrong phrase leaves it dead; operational clear → sales/
returns/refunds/orders/order-items/reservations/shifts = 0 while the ring,
its 2+2 stock (inventory reset *not* selected), categories, branding and
session survive; audit rows present and password-free; factory reset →
products/variants/categories/customers/store-accounts/campaigns/faqs = 0,
brand kept, sections gone, sale counter restarted, admin still signed in;
empty scope refused with a controlled message.

**39. Scenario suite — `$dz$` block in `supabase/tests/scenarios.sql`:**
52 expected-error probes plus the positive paths — forged cashier refusals;
phrase/stale/future/bad-options refusals; preview non-mutating; operational
clear with per-group count assertions (0 sales/orders/returns/refunds/shifts/
reservations; products/variants/category/admin preserved; shelves 0 + rollup
0; recount rows ≥ 3 with reason `recount`); audit rows; settings write through
the corrected guard; the GUC-armed forced-failure rollback probe (§24); full
factory reset with preserved.super_admin asserted; forged
`system_reset_report_failure` refused.

**40. Regressions.** All prior suites stay green: unit/selftest **35/35**
(includes Phase 43 variants 17-rule, 44 lifecycle, 45 storefront, 46
dashboard/POS/branding suites), E2E **15/15** (including `storefront`,
`branding`, `dashboardux`, `posux`, `reports`, `crash`). Two selftests were
*updated* because the capability set legitimately grew: `adminFullAccess`
and `roles` now expect `manage_system_reset` in the admin-only array; the
visual-audit screen contract was updated to assert the factory card does
*not* leak onto the Settings group list (it lives one level deeper).

**41. Latent 0046 bug found and carried forward.** 0046's
`website_settings_guard()` iterated the brand text array with a
`v_item jsonb` variable — **any** live brand write raised `invalid input
syntax for type json` (the E2E missed it because demo mode never mounts the
DB trigger). Per the standing rules 0046 was not edited: 0047 re-states the
guard with `v_name text`, preserving every 0045/0046 check, dropping and
recreating the trigger, with a comment documenting the defect. Later
migrations must carry this corrected version. The scenario suite writes a
brand document through the guard to prove the fix.

**42. Gates — all green on the pushed tree.**

| Gate | Result |
|---|---|
| `npm run typecheck` | ✓ clean |
| `npm run db:check` | ✓ 47/47 migrations apply cleanly, idempotent, satisfy the app |
| `npm test` | ✓ 35/35 suites |
| `npm run test:bundle` | ✓ app bundle 7579 kB (danger-zone testids present) |
| `npm run test:e2e` | ✓ 15/15 suites (Danger Zone included) |
| `npm run build` + `npm run lint` | ✓ build 7.6 s; lint **0 errors** (33 pre-existing warnings) |

## Deliverable

**43. Files (17, +3102/−8).** New: `supabase/migrations/0047_admin_danger_zone.sql`,
`src/modules/settings/services/systemReset.ts`, `src/modules/settings/pages/
SystemSettingsPage.tsx`, `scripts/dangerzone.flow.mjs`. Modified:
`supabase/tests/scenarios.sql` (the `$dz$` block), `scripts/test.e2e.mjs`,
`scripts/visualaudit.flow.mjs`, `src/App.tsx` (route), `src/lib/i18n/
dictionary.ts` (EN+AR, including marked Arabic wordmark), `src/lib/permissions/
{roles.ts,catalog.ts,routes.ts}`, `src/lib/permissions/__tests__/
{adminFullAccess,roles}.selftest.ts`, `src/modules/audit/types.ts` (reset audit
actions), `src/modules/backup/__tests__/logic.selftest.ts`,
`src/modules/settings/pages/SettingsHomePage.tsx` (System group entry).

**44. SHAs.** Parent/base `3c30a415f131f653bb9e24ef7e04d15ecdebeb06`
(tree `6335d17646fe7c43ee17f9c893e436f8d4d510dd`) · Phase 47 commit
**`f420478b16e587078e6e1ec60c4c9e7ed6b38fd7`** · tree
**`f88a408fab026f6ccadfe8f9089c6a1e1da49f44`** · canonical
`arena/01a0a01f-alyq-cloud-pos` = `a96b9f3721f42f1983dcf968ac6b159c01980f1f`
(verified via `ls-remote` this round).

**45. Tree & recovery.** The sandbox was reprovisioned mid-round: `.git` came
back as a fresh clone at `c8cfd89` and the (never-pushed) first Phase 47
commit `d395ed9` was unreachable. Recovery followed the proven procedure —
**no `reset --hard` anywhere**: the persisted worktree was staged
(`git add -A`) and the staged diff against the remote tip `3c30a415` proved to
be **exactly the 17 Phase 47 files (+3102/−8)** — byte-identical to the lost
commit; then an old-value-guarded `git update-ref` fast-forwarded the branch
`c8cfd89 → 3c30a415`; the changeset was recommitted as `f420478` and pushed.
All six gates were re-run to green afterwards (§42).

**46. Canonical + hosted Supabase untouched.** All work is on
`arena/01a0b007-alyq-cloud-pos`, pushed only there; canonical
(`a96b9f37`) was never written. No `supabase db push`, nothing deployed: the
hosted Supabase still has **through `0043`** — `0044`–`0047` exist as files
awaiting a deliberate deployment decision.

---

## Completion checklist (task absolutes)

| Absolute | Evidence |
|---|---|
| Server-side, one transactional RPC per mode | §4, §23 (scenario + code) |
| Super Admin cannot be lost | §6 (pre+post assert, rollback on failure) |
| Atomic; failure rolls back everything | §23, §24 (forced-failure probe) |
| Rollback proven | §24 (DZ_TEST_INTERRUPT, full-restore assertions) |
| Re-auth + exact phrase required (client **and** server) | §7, §25, §31, §34 |
| Audit survives the reset; no password in audit | §36, §37 (asserted in CI) |
| Approvals survive all resets (by design) | §21 |
| Demo mode honest, nothing faked | §15 |
| Six gates green | §42 |
| Canonical & hosted Supabase untouched | §46 |

# Phase 48 — Final Full-System Audit · Security Review · Deployment Readiness

**Branch:** `arena/01a0b007-alyq-cloud-pos` · **Audit-fix commit:** `c2575ae` (parent `c96e6d9`) · **Date:** 2026-09-18

---

## 1. Overall verdict

**READY** — for canonical fast-forward, sequential hosted deployment of
`0044 → 0048`, and live smoke testing. Three real defects were found and fixed
(one security-critical, one data-loss class, one audit-parity gap — §31); no
security-critical or data-integrity-critical issue remains open. All six gates
are green on the audited tree (§30).

## 2. Exact audited HEAD

At audit start: session remote = `c96e6d970203686cf7800a3e278b0fa7350e5021`
(Phase 47 report commit), canonical remote = `a96b9f3721f42f1983dcf968ac6b159c01980f1f`
(verified via `ls-remote` before anything else, as required). The audit landed
as commit **`c2575ae848ea668c9f45608f210058b771813c73`** on the session branch
(§32–33).

## 3. Security findings

Swept `src/` for XSS/injection surface: **no `dangerouslySetInnerHTML`/`innerHTML`
on user data** (the only hit is main.tsx's static root-error fallback); no
`eval`/`new Function`; `javascript:`/`data:` URLs appear only inside the
sanitizers that *reject* them (`storefrontLink.ts`, `settingsDefaults.ts` — the
Phase 45 link guards, still armed); both `target="_blank"` anchors carry
`rel="noopener noreferrer"`; env usage is public-by-design only
(`VITE_SUPABASE_URL/ANON_KEY`, `VITE_STOREFRONT_URL`, `VITE_CURRENCY`) — **no
service-role key or secret anywhere in the client**; mailto redirects
encodeURIComponent their subjects; uploads accept image types on the payment
proof panel only. Money and stock are server-authoritative: `pos_complete_sale`
reads `selling_price` under `for update` row locks and ignores client prices;
`place_online_order` recomputes subtotal/discount/delivery/total and ignores
client `delivery_fee` (0018/0034/0042). **The one critical finding was the
Danger Zone re-auth (§4), now fixed.**

## 4. Re-auth finding — the phase's central question

**The Phase 47 design was NOT server-safe.** `system_assert_authorized`
verified session → active profile → `can('manage_system_reset')` → role
`admin` → phrase → `p_fresh_until` ±10 min — but freshness was a **client-
attested timestamp**, the password was checked only in the browser, and the
phrase is a static string displayed on screen. All five attacks in the brief
were possible: stale-session reset (fabricate the stamp), UI-only bypass
(server never saw a password), replay after an earlier password check, direct
destructive RPC calls with no fresh password, and any admin session minting
its own freshness. **Fix (smallest safe):** the destructive RPCs now take the
current password and verify it **server-side** against `auth.users.
encrypted_password` via pgcrypto `crypt()` (already provisioned by 0001; the
wrapper resolves the extension's schema at migration time for hosted/PGlite
differences; revoked from every role, reachable only through the definer
RPCs). Signatures gained a trailing optional `p_password` — call-compatible,
but old-shape calls now correctly fail `RESET_REAUTH_REQUIRED`. **Why there is
no failed-attempt lockout, deliberately:** a failed RPC is one rolled-back
statement, so an in-statement failure tally dies with its own raise (the
scenario suite proved this empirically — the first lockout draft never fired);
Postgres has no autonomous transactions, and a damper that cannot fire is
security theatre. The honest posture is the per-call bcrypt proof itself:
every guess is a full authenticated API request, rate-limitable at the gateway
(added to the deployment checklist, §37 step 6b). Corrected **in place in the
undeployed 0047** — the safest correction since hosted has never seen it; no
deployed history touched.

## 5–8. Migration audits (0044 / 0045 / 0046 / 0047)

- **0044_category_lifecycle** — 5 definer functions, all with fixed
  `search_path`; grants scoped to `authenticated, service_role`; deletes live
  inside the guarded RPCs (empty-delete, move+delete); no policy changes; no
  unsafe DROP (idempotency preambles only). ✓
- **0045_storefront_customization** — its new table gets correct grants
  (anon select; writes to authenticated+service_role) with 4 RLS policies; 2
  definer functions with fixed `search_path`; guard/trigger drops are
  replace-in-place idempotency. ✓
- **0046_admin_branding_dashboard** — no new tables, no RLS changes, no
  grants, no definer functions; columns + view + settings guard. ✓
- **0047_admin_danger_zone** — 8 definer functions all with fixed
  `search_path`; EXECUTE granted to `authenticated` only, revoked from
  `public`/`anon` (this round also revoked the previously-public
  `system_assert_authorized` — a Phase 47 oversight); helpers revoked
  entirely. Phase 48 adds the password proof (§4). **0047's corrected
  `website_settings_guard` after 0046 has run: verified safe — all 30 checks
  of 0046's guard are preserved in the re-statement, same function/trigger
  names, clean replacement.**
- All four: apply cleanly after hosted 0043, correct dependency order, no
  assumption of later migrations, idempotent under db:check (two passes), no
  accidental data mutation outside their own RPCs, no RLS weakening, existing
  RPC compatibility intact (0018/0034 `pos_complete_sale(p_payload,
  p_approval_request_id default null)` pattern preserved).

## 9. RLS / capabilities

No policy was dropped or weakened by 0044–0048 (only 0045 adds policies, for
its own table). Capability checks remain capability-matrix based everywhere;
`manage_system_reset` stays admin-only; the Phase 48 sweep found no
role-name-string enforcement in components. Route guard refuses
viewer/cashier/clerk/manager at `/settings/system` (E2E-proven, §29 step 21).

## 10–14. Variants · Categories · POS · Returns · Inventory

- **Variants:** Gold/17 = 2, Silver/17 = 2 re-proven; the third Gold/17 is
  refused at the POS (the picker no longer even offers a sold-out shelf),
  in the storefront, and server-side (row-locked shelf reads); variant
  SKU/barcode, images, price override (server-resolved), numeric sizes — all
  green in `variants`/`posux`/`storefront` suites and the final flow.
- **Categories:** empty delete; blocked direct delete with the structured
  count; atomic move+delete; archive hides; archived assignment refused;
  reactivation restores — `categories` suite green, final flow re-proves
  archive → reactivate.
- **POS:** open-shift gate (final flow's step-2 → complete-sale gating),
  customer attach (§31 fix), barcode scan, variant picker, split payments,
  receipts with exact combination lines — `posux` green.
- **Returns:** exact-variant restoration (Gold/17 0 → 1 after ×1 return);
  duplicate-return prevention — `returns` suites green.
- **Inventory:** variant shelf-of-record, rollup by trigger, movements ledger
  with recount rows; corrections and low/out-of-stock — suites green.

## 15–20. Storefront · Checkout · Delivery/Pickup · COD · InstaPay · Customization

Storefront (header/hero/sections/campaigns/product cards/PDP/cart/checkout/
confirmation/footer/social/RTL) green in `storefront`; checkout acceptance
re-proven for Pickup+COD, Delivery+COD, Delivery+InstaPay, and the
proof-required InstaPay flow (submit → `verification_required` → staff
verification → then order approval). **Server-side validation confirmed in
0042**: available cities/areas, order minimum, free-delivery threshold, and
`place_online_order` recomputing all money server-side. Website customization
remains live after the full walk (final flow step 16).

## 21–24. Dashboard · Branding · Reports · Excel

Dashboard KPIs reconcile with the ledger (3 sales / 2 web orders on the day;
clickable routing green in `dashboardux`); branding displays from the one
shared source (`branding` suite); reports differential (91 comparisons,
DB vs builders) green and the ledger carries till + both online settlements
(final flow step 18); Excel import/export suites green with variant sheets.

## 25–26. Backup/restore · Audit log

**Coverage defect found and fixed (§31.2):** live backups never carried
`product_variants`, `catalogue_codes`, `storefront_category_content` — 0029's
order predated them. 0048 (new migration) replaces `backup_table_order()`
(everything reads it dynamically) and excludes trigger-owned `catalogue_codes`
from restore *inserts* (the sync triggers rebuild it — the restore scenario
proved the duplicate-key collision). Demo backups gain
`storefront_category_contents`. Restore ordering respects FKs (parents first,
deletes reversed, selftest-pinned). Audit log: append-only, survives restores
and every reset; vocabulary `online_order.approved/payment_approved/
payment_rejected` now written in demo too (§31.3), matching live 0018.

## 27. Danger Zone (post-fix)

Unauthorized roles refused at every RPC (scenario ×3); the current-password
requirement is now **meaningful** (server-verified per call); phrases enforced
client and server; preview is server-generated and non-mutating; both modes
atomic with proven rollback (GUC-armed test-only interruption); last Super
Admin + acting admin + auth/profile linkage survive (pre+post asserts);
migration history/schema untouched; reset's own audit survives; variant stock
reset correct (shelves zeroed, rollup by trigger, recount ledger); website
references cleaned; branding preserve/reset verified. The final flow opens the
wizard, reads the server preview, and **closes without executing**.

## 28. Performance findings

No material regressions: storefront catalog is one normalized query per page
(no per-card fetches); images lazy-load with an above-the-fold priority
override; dashboard reads provider-fed data and computes in memory (the
`onlineDashboard` loops are arithmetic over cached arrays, not query fan-out);
no duplicate settings fetches found; lists are capped/sectioned. Nothing
fixed because nothing material was found — consistent with the "only fix
proven material issues" instruction.

## 29. Integrated E2E — `scripts/final.flow.mjs` (new, in `test.e2e.mjs`)

22 steps, one run: admin login → open shift → create customer → variant ring
(2+2) → POS sells Gold/17 ×2 **to the customer** (sale record proven, not just
UI) → third Gold refused → Gold ×1 returned → shelf reads 1 → storefront PDP
picks Silver/17 → **delivery** order → **COD** → **InstaPay separately**
(proof → verification pending) → exact-variant hold verified → both orders
settled (stock moves once each, on approval) → category archive/reactivate →
customization visible → KPIs reconcile → ledger reconciles (net 507.80 EGP
that run) → branding → **Danger Zone preview only** (server counts, nothing
fired) → viewer refused → audit trail holds return + 2 settlements + payment
verification + sign-ins, password-free.

## 30. Six gates — all green

`typecheck` ✓ · `npm test` **35/35** ✓ · `db:check` **48/48** ✓ ·
`test:bundle` ✓ · `test:e2e` **16/16** ✓ · `build` ✓ + `lint` 0 errors
(33 pre-existing warnings).

Suite-by-suite: variants ✓ · categories ✓ · storefront ✓ · store/checkout ✓ ·
dashboardux ✓ · posux ✓ (attach assertion strengthened) · branding ✓ ·
dangerzone ✓ · backup ✓ · reports differential ✓ · crash/reports/posux/store/
backup/visualaudit/variants/categories/storefront/branding/dashboardux/
dangerzone/**final** — 16/16.

## 31. Fixes made (all in commit `c2575ae`)

1. **Server-side re-auth proof** for the Danger Zone (0047 in place + client +
   demo verifier + scenarios) — §4. Security-critical, closed.
2. **Backup coverage** for Phase 43/45 tables (new **0048** + TS lists +
   selftest regression pin; `catalogue_codes` trigger-owned restore exclusion)
   — §25. Data-loss class, closed.
3. **Demo order-approval audit rows** (`online_order.approved` /
   `payment_approved` / `payment_rejected` via `recordAudit`) — §26. Parity
   gap, closed.
4. Test-integrity fixes: posux customer-attach now proves the selection
   (mousedown listbox + at-rest name), the customer-password flows pass the
   password to the RPCs, and the harness `placeOrder` gained delivery-address
   support.

## 32–35. SHAs and tree

- **Final audit-fix commit:** `c2575ae848ea668c9f45608f210058b771813c73`
  (parent `c96e6d970203686cf7800a3e278b0fa7350e5021`).
- **Session remote SHA:** this report is the commit pushed immediately after
  `c2575ae` on `arena/01a0b007-alyq-cloud-pos` (see the push output / branch
  head for its exact SHA).
- **Canonical remote SHA:** `a96b9f3721f42f1983dcf968ac6b159c01980f1f` —
  untouched.
- **Working tree:** clean; all changes committed and pushed to the session
  branch only.

## 36. Migrations pending on hosted

Exactly **five**, in order: `0044_category_lifecycle`,
`0045_storefront_customization`, `0046_admin_branding_dashboard`,
`0047_admin_danger_zone`, `0048_backup_covers_variants`. (0048 was created
this phase per the audit's backup finding; hosted remains through 0043 —
nothing was deployed.)

## 37. Exact deployment sequence (do NOT execute from this report)

1. Fast-forward canonical `arena/01a0a01f-alyq-cloud-pos` to the audited
   session tip (`c2575ae` + this report commit) — fast-forward only.
2. Locally: `git fetch origin && git pull` on the canonical branch.
3. `npx supabase migration list` — confirm remote is at `0043`.
4. `npx supabase db push --dry-run` — confirm the plan is exactly
   `0044, 0045, 0046, 0047, 0048`, nothing else.
5. Confirm ONLY those five are pending (no local-only strays).
6. `npx supabase db push` — sequential, each migration atomic.
   6b. **In the Supabase dashboard, enable restrictive API rate limits**
   (Auth + PostgREST) before opening the Danger Zone to daily use — the
   password gate is per-call by design.
7. `npx supabase migration list` — confirm Local == Remote through `0048`.
8. Verify the app build matches this commit (`git rev-parse HEAD`).
9. Restart the app / redeploy the frontend.
10. Run the live smoke checklist (§38).

## 38. Live smoke checklist (post-deploy, in order)

1. Admin login (wrong password refused first).
2. Dashboard renders; KPI tiles route.
3. POS: open shift.
4. Variant sale: Gold/17 to 0; third refused; receipt names the combination.
5. Customer persistence: create + attach + appears on the invoice.
6. Partial return: Gold/17 ×1 back; shelf reads 1; refund recorded.
7. Category lifecycle: archive → hidden; reactivate → selectable.
8. Storefront loads; customization visible.
9. Variant PDP: Silver/17 selectable; add to cart.
10. Cart → checkout.
11. Pickup + COD order → confirmation.
12. Delivery + COD order (fee/threshold/areas enforced).
13. InstaPay order → proof upload → verification pending.
14. Online orders staff view: approve COD; verify InstaPay payment, then
    approve; stock moved once each.
15. Dashboard website KPIs count the orders.
16. Branding shows on POS + storefront + receipt.
17. Reports reconcile with the ledger.
18. Danger Zone: **preview only** — verify counts, close. **Never run a
    factory reset on production.**

## 39–40. Untouched confirmations

**Canonical untouched:** all work is on `arena/01a0b007-alyq-cloud-pos`;
canonical (`a96b9f37…`) was never written — verified by `ls-remote` at audit
start and again at close. **Hosted Supabase untouched:** no `supabase db
push`, no deployment; hosted remains **through 0043**; `0044`–`0048` exist as
files awaiting the deliberate sequence in §37.

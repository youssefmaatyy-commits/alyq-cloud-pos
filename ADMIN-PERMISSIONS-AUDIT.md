# ALYQ · Admin Full Permissions Audit & Fix

**Date:** 2026-09-15 · **Branch:** `arena/01a0a6f1-alyq-cloud-pos` · **Starting HEAD:** `29a5ffe`
**Question audited:** *Does the `admin` role pass every permission decision point in the application — and does every wall that protects the installation from self-lockout hold in every mode the app runs in?*

The audit was run in two directions:

1. **The promise** — the admin may do everything: every capability, every screen,
   every service gate, every database guard, in demo mode and in live mode.
2. **The walls** — the self-protection guardrails (the three ways an
   administrator can lock the installation out of its own administration) must
   answer identically in demo mode and in the database, because demo mode is
   documented to "behave the same way" and a wall that only exists on one side
   is a door.

**Verdict:** the promise holds at every layer in both modes (proven, below).
Two defects were found and fixed:

- **F1 (a wall with a hole):** the client-side self-lockout guard in demo mode
  was narrower than its SQL mirror, in two ways that were both reproducible
  self-lockouts. Both are fixed and pinned by tests on both sides.
- **F2 (a door that said the wrong thing):** a real Admin on the Inventory
  screen read *"Viewing as Admin — changes are not permitted"* even though
  every control beside that sentence was enabled. The banner sentence was a
  read-only string rendered unconditionally — there was no "permitted" variant
  and no condition. It is now conditional on the same capability the buttons
  use, and the whole inventory path (gate → service → repository → RLS → audit)
  is proven end to end for the admin, the non-stock-tracked product, and the
  restricted roles.

---

## 1. How the audit was run

### 1.1 The client layers (TypeScript)

`src/lib/permissions/__tests__/adminFullAccess.selftest.ts` (new, 10 tests)
answers the promise at every layer that can say no on the client:

| # | Claim | Method |
|---|---|---|
| 1 | The matrix is total for admin | admin holds all 45 capabilities; no duplicates; no capability orphaned |
| 2 | Admin is a superset of every role; the admin-only set is exact | for each of the other four roles, its set ⊆ admin's; the set only admin holds is exactly `manage_users`, `manage_roles`, `manage_settings`, `restore_backup`, `export_backup` |
| 3 | No URL lands an admin on a denial | every `ROUTE_CAPABILITIES` entry and all 29 registered screen paths pass |
| 4 | Every gate in the app is on a real capability admin holds | a scan of `src/` (non-test) for the capability literal each gate asks about — `assertCapability`, `canAct`, `canActAs`, `userCan`, `hasCapability`, `canActAny`, the route-table rows — asserts the union is real and held by admin. A future gate on a capability admin could lack, or a typo of a capability id, fails the suite |
| 5 | The role-list gates include admin | every exported `*ROLES` list (`APP_ROLES`, `POS_ROLES`, `INVENTORY_ROLES`) contains `admin` |
| 6 | Every sensitive action is admin-performable | each `SENSITIVE_ACTIONS` entry names a real capability admin holds |
| 7 | The offline installation agrees | the demo admin account exists and resolves to all 45; the admin aliases (`owner`, `superadmin`, `super_admin`) resolve to the same full set; signed-out and unknown roles resolve to nothing |

The scan is deliberately over the application's own source only: test fixtures
legitimately hand the gates names like `not_a_capability` to prove they refuse,
and a fixture is a test of a gate, not a gate itself.

### 1.2 The database layer (SQL)

`supabase/tests/scenarios.sql` gained the **Phase 26** block ("admin full
permissions"), applied by `npm run db:check` against a real PostgreSQL engine
(PGlite) with the real policies, triggers and RPCs:

| # | Claim | Method |
|---|---|---|
| A | `public.can()` answers true for **every** capability the model knows, as the admin profile | iterated over the distinct capabilities of `role_capabilities`; `current_user_capabilities()` resolves the full set (45 of 45) |
| B | The admin's own row keeps its guardrails | self-demotion and self-deactivation refused by `admin_upsert_staff_profile`; a change to one's own custom role refused by `admin_set_custom_role` for **any** value including NULL; self-denial of `manage_users` refused by `admin_set_user_exceptions` — while the own row's contact fields still write |
| C | The same wall for a **non-admin** holder of `manage_users` | a custom role (`co_admin`, base `manager`, holding `manage_users` + `manage_roles`) is put on the cashier through the admin RPCs; the cashier is then refused self-demotion and self-overlay-clearing — and *allowed* to reassign another account, which is what the authority is for |
| D | The last-admin invariant | an admin may promote and demote a **second** admin; the acting admin's own authority is re-asserted afterwards — the only path that would remove the last admin (self-demotion) is the one B refuses |
| E | The read sweep | `has_table_privilege` for all 29 tables/views the repositories read, plus `count(*) > 0` on the ten tables with guaranteed rows by that point — an RLS policy that silently filtered the admin's own book surfaces as an empty answer, which is the failure the sweep exists to name |
| F | The admin's own ledger write — the reported Inventory path, end to end | as the admin: an insert into `stock_movements` (the `with check (can('adjust_stock'))` policy, 0030), the shelf update (`can('edit_product')`), and an `audit_log` trail row — the shelf must land exactly delta away from the ledger's `quantity_after`, and the trail row must be stamped with the acting admin. Judged on deltas over the file's existing tracked product, because the ledger is append-only by design |

### 1.3 The demo-mode behaviour

The self-lockout wall is client-side in demo mode (`assertNotSelfLockout` in
`src/modules/settings/services/settingsService.ts`) and server-side in live
mode (the SQL guards B and C above). The audit compared the two statements of
the same wall side by side, and reproduced every disagreement before fixing it
(§2). The fix is pinned by a new test in the settings suite (now 28 tests):
*"an admin wearing a custom role cannot lock themselves out either — the same
wall the database makes."*

### 1.4 The Inventory path, driven from a real session

The reported symptom was a *behaviour* claim ("the adjustment failed"), so it
was reproduced the way the report was made — by signing a real session into a
headless run of the actual module code (no mocks of the gate, the service or
the repositories): a bare admin, the same admin wearing an overlay without
`adjust_stock`, a cashier and a viewer, each driving the real
`canAdjustStock` → `inventoryService.adjustStock` → demo repository → demo
audit store path. The results are the "Proven" list under F2; the permanent
pins live in the inventory suite (now 27 tests) and Phase 26 F.

---

## 2. What the audit found

### F1 — Demo mode let an admin lock themselves out, two ways the database refuses (Fixed)

**Location:** `src/modules/settings/services/settingsService.ts`, `assertNotSelfLockout`.

The guard is documented as the restatement of three SQL guards — "what makes
the *demo* installation behave the same way". Two of its conditions were
narrower than the SQL they mirror:

**(a) The self-demotion guard only fired when the session role read `admin`:**

```ts
// before
if (change.role && change.role !== "admin" && actor.role === "admin") {
// after
if (change.role && change.role !== "admin") {
```

The SQL guard is unconditional:

```sql
-- admin_upsert_staff_profile (0021)
if p_role is distinct from 'admin' and p_user_id = auth.uid() then
  raise exception 'You cannot remove your own admin role';
```

**Why the difference is a real hole, not a formality:** a *system admin wearing
a custom role whose base is not `admin`* carries that base in the session
(`identity.ts` resolves `role` to the base and the overlay's list absolutely).
For that seat `actor.role` is `manager` (or whatever the base is), so the old
condition never fired. Reproduced in demo mode: an admin wearing a
`co_admin` overlay (base `manager`, holding `manage_users`) opened
Settings → Users, changed their own row's role to `viewer` — **allowed** — and
the demo repository's "a hand-edited role clears the overlay" rule cleared the
overlay on the way down. The account ended as a bare viewer: no
`manage_users` left to undo it, and no error anywhere in the flight. The same
write is refused by the database in live mode with
"You cannot remove your own admin role".

**(b) Clearing one's own overlay was allowed in demo mode, refused in live:**

```ts
// before
if (change.custom_role_id !== undefined && change.custom_role_id !== null) {
// after
if (change.custom_role_id !== undefined) {
```

The SQL guard (`admin_set_custom_role`) refuses **every** change to the
caller's own row, including `NULL`. The overlay may be what carries the very
`manage_users` that would undo the change, so "take it off" is not always the
safe direction it looks. Reproduced: the same seat cleared their own overlay —
**allowed** in demo mode — and degraded from `manager + manage_users via the
overlay` to a bare manager, again with no way to undo it from the account.

**Scope check, stated honestly:** the vectors need a seat that holds
`manage_users` while its session role is not `admin` — i.e. a system admin
wearing a non-admin-based overlay (assigned by another administrator, which
`admin_set_custom_role` allows for other rows) or any custom role granted
`manage_users`. A bare system admin was never affected, which is why the
existing "an admin cannot lock themselves out" test stayed green through this.

**Fix:** the two conditions above, so the client wall states exactly what the
database states — with the same sentences, because a live refusal reaches the
UI untranslated and the demo now says the same thing.

**UI half of the wall:** `UserFormModal` already showed a banner on one's own
row — *"You cannot deactivate it or change your own role"* — and disabled the
active toggle, but left the system-role and custom-role selects enabled on the
self row, so the banner promised a refusal the demo-mode service would not
deliver (vector a) and never delivered for overlay-clearing (vector b). Both
selects are now `disabled={isSelf}`, matching the toggle's existing pattern:
the wall is visible, not discovered after a refused request. The service and
the database remain the controls; this is the visible half.

**Pinned by:**

* settings suite, new test (28/28): both vectors refused with the database's
  own sentences, the directory untouched after the refusals (base role,
  overlay and active flag all stand), contact fields on the own row still
  save, and a plain admin demoting *another* account still works;
* Phase 26 C: the same refusals from the database for the same seat.

---

### F2 — The Inventory screen told a fully privileged Admin that "changes are not permitted" (Fixed)

**The production report:** a real Admin account on Inventory showed
*"أنت تتصفح بصلاحية Admin — التعديلات غير مسموحة"*
("Viewing as Admin — modifications are not allowed") and the stock
adjustment was taken to have failed.

**The exact capability the whole path turns on is `adjust_stock`** — one
capability, checked at every layer, resolved from the *session* (custom role
and exceptions included), exactly as `public.can('adjust_stock')` resolves it
in the database:

| Layer | Where | What it asks |
|---|---|---|
| Dashboard edit state + the per-row Adjust button | `InventoryPage` → `useInventory().canAdjust` | `canActAs(user, "adjust_stock")` — the session decides (`enforce.canActAs`) |
| The Adjust modal's save | `StockAdjustmentModal.handleSave` | re-checks `canAdjust`, then `wouldGoNegative` |
| Stock movement service | `inventoryService.adjustStock` | `assertSensitiveAction("stock.adjust")` → `assertCapability("adjust_stock")`; a `recount` also asserts `stock.correct` (same capability, own register entry) |
| Repository / live RPC path | `applySupabaseAdjustment` | three statements: `insert stock_movements` (with check `can('adjust_stock')`, 0030), update that row's before/after snapshot, `update products.stock_quantity` (`can('edit_product')`, 0030) — **there is no RPC**; the movement row is the write (per the `SENSITIVE_ACTIONS` register) |
| Database permission check | 0030 policies + 0011 `public.can()` | `with check (public.can('adjust_stock'))` on the ledger; `can('edit_product')` on the shelf; the audit trail row goes to `audit_log` under `auth.uid() is not null` |

**Root cause — two independent facts, and the first one is the reported string:**

1. **The sentence was wrong for a privileged admin, unconditionally.**
   `InventoryPage` renders the identity strip on *every* visit, and the
   sentence in it was the single dictionary string
   `inventory.perm.banner` = *"Viewing as {{role}} — changes are not
   permitted."* There is no "permitted" variant in the dictionary and no
   condition around the string — the only dynamic element was the status dot
   (green when `canAdjust`, amber when not). So a bare Admin, whose dot was
   green and whose Adjust buttons were enabled, read *"Viewing as Admin —
   changes are not permitted"* beside them. The sibling page, `MovementsPage`,
   does it right (`!canAdjust ? banner : null`) — which is what shows the
   dashboard form is the defect, not the intent.
2. **And separately, the seat can genuinely be read-only while the label
   still says "Admin".** `canAdjust` resolves from the *session*: a seat whose
   active custom role (or personal denial) does not carry `adjust_stock` is
   refused at the gate, at the service and in the database — while the banner
   label prints the *base* role (`ROLE_LABEL[user.role]`), which for a system
   admin is "Admin". So that seat reads the same sentence, now truthfully —
   with no explanation of *why*. That is the "and the adjustment failed" half
   of the report: for such a seat the refusal is correct and matches
   `public.can('adjust_stock')` in live mode; what was missing was the
   permitted/denied distinction in the wording.

**Fix (minimal, no unrelated changes):**

* `inventory.perm.bannerAllowed` added to the dictionary in both languages
  (*"Viewing as {{role}} — changes are permitted."* / *"أنت تتصفح بصلاحية
  {{role}} — التعديلات مسموحة."*);
* `InventoryPage` now renders `t(canAdjust ? "…bannerAllowed" : "…banner")` —
  the dot and the sentence track the same resolved capability; `MovementsPage`
  was already conditional and is untouched;
* no capability, role, grant, migration or service changed — the gate, the
  service and the RLS policies were verified correct, not rewritten.

**Proven (headless repro + permanent pins), all from a real session:**

* a bare admin: `canAdjust` true; an adjustment on a stock-tracked product
  succeeds; the movement row (with before/after and the admin's attribution)
  persists; the audit trail records `stock.corrected` / `stock.adjusted` with
  the before/after pair; the quantity lands exactly delta away;
* a non-stock-tracked (service) product: refused with VALIDATION
  *"Stock tracking is disabled for this product"* — quantity untouched, no
  movement row written;
* restricted roles: cashier and viewer are `canAdjust` false and refused
  FORBIDDEN by the service; `inventory_clerk` keeps the ledger (it is theirs);
* the database half (Phase 26 F, `db:check` on a real engine): as the admin,
  the ledger insert, the shelf update and the audit trail row all land —
  judged on deltas over the file's existing tracked product, because the
  ledger is append-only by design (`using (false)` on delete) and a block may
  not delete its way back out; the refusal half of that door is Phase 16's
  (cashier and viewer are both refused the same first insert);
* the admin wearing an overlay without `adjust_stock`: the base role still
  reads "Admin" in the banner, `canAdjust` is false, the service refuses —
  the seat is read-only by design, and now the sentence says so.

**Pinned by:**

* inventory suite, new tests (27/27): the banner has a permitted variant in
  both languages and `InventoryPage` picks between them on `canAdjust` (the
  denied sentence is no longer rendered unconditionally); the gate answers
  from the resolved session, not the base role (the overlay case); restricted
  roles stay blocked and the clerk keeps its ledger;
* Phase 26 F: the admin's own ledger + shelf + trail write, on the database.

**Relation to F1:** separate findings, one shared theme. F1 is the
*settings* self-lockout wall (a seat editing its own row in Settings → Users);
F2 is the *inventory* read-only wording and gate. They meet in exactly one
idea — that the seat's authority is its **resolved** capability list, not its
base-role label — and both fixes make a layer state what the resolved list
says. The self-lockout fix does not touch the inventory path, and the banner
fix does not touch the guard.

---

## 3. What the audit verified as correct

Recorded because the promise was checked at each of these, not assumed:

- **The matrix** — admin holds all 45 capabilities (the whole
  `CAPABILITIES` list by construction, and asserted); the admin-only set is
  exactly the four oversight acts plus the two backup acts; admin is a strict
  superset of the other four roles.
- **The routes** — admin passes all 23 route-table entries and all 29 screen
  paths; the storefront's public routes need no session at all.
- **The service layer** — every `assertCapability`/`assertSensitiveAction`
  call site in the application asks about a capability admin holds (37 distinct
  capabilities at 101 gate sites, per the audit scan).
- **The database** — `can()` true for all 45 as the admin; the admin passes
  every admin RPC that was exercised (`admin_upsert_staff_profile`,
  `admin_create_custom_role`, `admin_set_custom_role`,
  `admin_set_custom_role_active`, `admin_set_user_exceptions`); the admin reads
  every table the repositories read, with rows; the admin *writes* the stock
  ledger, the shelf and the audit trail in one pass (Phase 26 F).
- **The Inventory path (F2's premise)** — the gate, the service and the
  policies were verified **correct**, not defective: `canAdjustStock` resolves
  from the session (so an overlay or a personal denial reaches the button, the
  modal, the service and the ledger together); the service asserts
  `adjust_stock` (and, for a `recount`, `stock.correct`) before any write; the
  non-stock-tracked product is refused with the quantity untouched and no
  ledger row; cashier and viewer are refused by the same policy the admin
  passes; `inventory_clerk` keeps the ledger. Only the *wording* on the
  dashboard was wrong.
- **The last-admin invariant** — a demotion always leaves the acting admin in
  place, and self-demotion is refused; an installation therefore always keeps
  an admin (Phase 26 D).
- **The documented, deliberate limits** (audited, not bugs):
  - a person's **own denials bind even the admin role** — exceptions belong to
    the person, not the role (Phase 17), and `public.can()` is deny-first for
    everyone including admin;
  - an **active custom role is absolute** — a system admin wearing one is
    governed by its list by design;
  - the admin's own row: deactivation, self-demotion and own-overlay changes
    are refused **by design** (the wall this audit fixed), everything else on
    the row is writable, in both modes.

---

## 4. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | clean (EN/AR dictionary parity included) |
| `npm test` | all suites — including **10/10 admin full-permission audit** (new), **28/28 settings** (was 27) and **27/27 inventory** (was 24) |
| `npm run db:check` | 37 migrations ×2, role scenarios incl. **Phase 26** (new, A–F) — all pass |
| `npm run test:e2e` | all suites, 0 console errors |
| `npm run lint` | 0 errors |
| `npm run build` | clean |

Mutation checks (each weakening re-introduced, caught by the intended gate,
restored byte-exact, full battery re-run green afterwards):

| Mutation | Gate that caught it |
|---|---|
| Revert the client self-demotion condition to `actor.role === "admin"` | settings suite — *"a self-demotion is refused even when the session role is the overlay's base"* |
| Revert the client overlay condition to allow `null` on the own row | settings suite — the same wall test (the form always carries the overlay field, so the weakened guard re-opens the self-demotion path too) |
| Drop `restore_backup` from the admin's row in `ROLE_CAPABILITIES` | adminFullAccess suite — 7 of 10 tests fail, starting with *"admin must hold all 45 capabilities"* |
| Make `public.role_can` refuse `delete_customer` for the admin | Phase 26 A — *"can() refuses the admin for: delete_customer"* (no earlier scenario block asks that capability of the admin, so Phase 26 is the first gate to meet it) |
| Revert the banner to the unconditional denied sentence | inventory suite — *"the dashboard banner … picks it on the gate"* fails (the denied sentence is detected as rendered unconditionally) |
| Drop `inventory.perm.bannerAllowed` from one language | inventory suite — the same test fails (the permitted variant is missing) |
| Make `canActAs` answer from the passed object instead of the matched session | inventory suite — *"the gate answers from the resolved session, not the base role"* fails (the overlay seat is no longer read-only) |
| Deny the `stock_movements` insert policy to everyone (`with check (false)`) | `db:check` — the first ledger write after the admin's (Phase 16's clerk) is refused, so the run fails |

One limitation noted for the record: the DB↔TS matrix parity check parses
`ROLE_CAPABILITIES` with a regex that recognises only the two literal forms
(the bare `CAPABILITIES` reference and an explicit string array), so an
expression row would sail through it. The type system and the adminFullAccess
suite hold that direction instead; the `role_can` mutation above covers the
database side.

---

## 5. Files changed

| File | Change |
|---|---|
| `src/modules/settings/services/settingsService.ts` | **Fix** — `assertNotSelfLockout` mirrors the SQL guards exactly (two conditions tightened, with the reasoning recorded) |
| `src/modules/settings/components/UserFormModal.tsx` | The two role selects are disabled on the self row, matching the active toggle and the banner's promise |
| `src/lib/permissions/__tests__/adminFullAccess.selftest.ts` | **New** — the standing admin full-permission audit (10 tests, incl. the `src/` gate scan) |
| `src/modules/settings/__tests__/logic.selftest.ts` | **New test** — the overlay-wearing admin's self-lockout vectors, the untouched-directory assertions, the contact-edit and other-admin controls |
| `src/modules/inventory/pages/InventoryPage.tsx` | **Fix (F2)** — the identity-strip sentence now follows `canAdjust` (`bannerAllowed` / `banner`) instead of rendering the read-only string unconditionally; the reasoning is recorded in the JSX comment |
| `src/lib/i18n/dictionary.ts` | **F2** — `inventory.perm.bannerAllowed` added in EN and AR (the permitted variant) |
| `src/modules/inventory/__tests__/logic.selftest.ts` | **New tests** — the banner has both variants in both languages and the page picks on `canAdjust`; the gate answers from the resolved session (the overlay seat); restricted roles stay blocked, the clerk keeps its ledger |
| `supabase/tests/scenarios.sql` | **New Phase 26 block** — the database half of the audit (A–F + fixture restoration); F is the admin's own ledger + shelf + trail write |
| `scripts/admin-audit.mjs`, `scripts/tmp-inventory-repro.ts`, `scripts/tmp-harness.ts` | Removed (throwaway audit/repro harnesses; their permanent successors are the selftests above) |

No capability, role or grant changed. No migration. No RLS policy or service
rewritten — F2's fix is the banner wording plus the pins; the gate, service
and policies were verified correct and are pinned as-is.

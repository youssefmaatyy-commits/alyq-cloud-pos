# ALYQ Cloud POS — Critical Audit: POS Customer Flow · Sales Without Open Shift · INV-000002 Returns · Storefront Checkout

**Status: AUDIT ONLY.** No code was changed, nothing was committed or pushed, no historical data was touched, INV-000002 was not manually "fixed", and RLS was not weakened. Fix proposals below are for approval.

**Scope & method**

- Repository: `alyq-cloud-pos` at `b14ddb17527a65e4d3ab5209746563c367e5344b` (canonical `arena/01a0a01f-alyq-cloud-pos`), tree clean.
- Full read of the affected modules: `pos/` (UI, provider, services, repositories), `customers/`, `shifts/`, `returns/`, `online/` (storefront), `permissions/`, plus migrations 0001–0037 and `supabase/tests/scenarios.sql`.
- Headless demo-mode reproductions (esbuild + node, memory `localStorage` shim, signed-in demo session) — scripts in `/tmp/repro3/` (`a_happy`, `b_orphan`, `c_rejected`, `d_checkout`), outputs quoted in the appendix.
- The hosted Supabase project cannot be reached from this sandbox; "hosted behavior" below is derived from the exact code paths, grant/policy text, and migration history, with the precise SQL to verify each claim on the live project.

---

## Executive summary

| # | Issue | Reproduced | Type | Severity | One-line root cause |
|---|-------|-----------|------|----------|--------------------|
| 1 | POS customer selection / creation / attachment | **Yes** (code-level + demo) | UI + **DB** | **High** | The live RPC `pos_complete_sale` **never writes the customer fields** — every live-mode sale silently loses its customer; plus UI discoverability gaps (picker hidden on empty cart, no free-text search, no email field in the customer model). |
| 2 | Sale completes with **no open shift** | **Yes** (demo, no shift open at all) | **DB** (absent at every layer) | **High** | There is **no shift requirement anywhere** — not in the UI, not in `saleService`, not in either repository, not in `pos_complete_sale`. Shift↔sale linkage is purely time-window aggregation in the shift summary, so a no-shift sale lands in **no** shift's books. |
| 3 | INV-000002 "already returned" + no stock restore | **Yes** (exact symptom reproduced in demo) | **Data** (historical orphan) + 2 real code asymmetries | **High** | A `sales_returns`+`return_items` row covering the full quantity exists for INV-000002 **without** its `refund_records` row and **without** stock movement. The modal's "fully returned" test reads return rows (any status) while "remaining returnable" reads refund rows — the mismatch is displayed as two contradictory facts, and the invoice is stuck with no correction path. Current code writes all three side effects atomically, so the state is historical (pre-fix data) or a rare demo crash between two non-atomic `localStorage` writes. |
| 4 | Storefront checkout → generic "حدث خطأ من جانبنا" | **Yes** (mechanism reproduced; demo checkout itself works) | **DB deployment** + error-UX | **Critical** | The live function in migration ≤0033 read `unit_price` from the client payload, which the app **never sends** → **every live-mode checkout failed** `online_order_items.unit_price NOT NULL` (23502) → no regex match → generic `db` code. Fixed in-repo by 0034 (server-side pricing) — **the hosted project must have 0034 applied**; until then all live checkouts fail. The UI also discards the real error message entirely. |

Admin-permission interplay (details in §7): Issue 3's gate is `process_return` (cashier **has** it); Issues 1/2/4 introduce or touch no new capability — all fixes can stay inside the existing capability architecture with no frontend-only bypass and no change to non-admin permissions.

---

## Issue 1 — POS customer flow: select / create / attach

### 1.1 What exists today

- **Picker**: `CustomerSearchSelect` renders inside the cart panel — a native `<select>` listing every customer the session may see, default option `customers.guestCustomer` ("Walk-in customer (no account)" / "عميل نقدي (بدون حساب)"), a detach (✕) action, and a "+ add" button opening `CustomerFormModal` (fields: name*, phone*, address, notes; phone unique).
  - `src/modules/pos/components/CartPanel.tsx:51` (render), `src/modules/customers/components/CustomerSearchSelect.tsx`.
- **Quick add from POS**: gated by `allowQuickAdd && canAct("add_customer")` (`CustomerSearchSelect.tsx:29`). Cashier, manager and admin all hold `add_customer` (23/40/45 capabilities in `src/lib/permissions/roles.ts`), so **creation from the till works for every till role**.
- **Attachment**: the chosen customer is snapshotted onto the sale in `PosProvider.completeSale` — `customer_id / customer_name / customer_phone` (`src/modules/pos/hooks/PosProvider.tsx:301-303`). Detach = walk-in (`null`).
- **Walk-in**: fully supported by design — DB columns nullable, receipt prints guest when name+phone absent (`src/modules/pos/services/receipt.ts:51-70` handles "guest" receipts explicitly).

### 1.2 Reproduced? **Yes** — the gaps, exactly

| Gap | Evidence | Repro |
|-----|----------|-------|
| **G1 — no customer field on an empty till** | `CartPanel.tsx` returns the empty-cart UI at line 32 **before** the picker (line 51) is rendered. | Sign in as cashier → POS page → no customer control anywhere until the first product is scanned. |
| **G2 — no free-text search** | The control is a native `<select>` over the loaded list (`CustomerSearchSelect.tsx:70+`). No name/phone type-ahead. | 200 customers → the cashier must scroll a dropdown; searching "0101…" is impossible. |
| **G3 — no email anywhere in the customer model** | `Customer` = `{name, phone, address, notes}` (`src/modules/customers/types.ts:7-16`); `customers` table (migration 0010) has the same four; `CompleteSaleInput` carries no `customer_email`. (Online orders do capture `customer_email` — `online_orders` — but the customer database does not.) | Open the customer form from POS → no email field exists to enter or leave optional. |
| **G4 — roles without `view_customers` get no picker at all** | `CustomerSearchSelect.tsx:34` → `if (!canView) return null`. | A custom role lacking `view_customers` sells silently as walk-in with no indicator. |
| **G5 — LIVE MODE DROPS THE CUSTOMER (data bug)** | `pos_complete_sale` accepts `customer_id/customer_name/customer_phone` in the payload (sent by `supabaseRepository.ts:160-162`) but **never uses them**: across all six historical definitions of the function (0007, 0009, 0015, 0018, 0033, 0035) the function body contains **zero** references to `customer_id` (verified by extracting each body up to its closing `$$;`). The `sales` table has the columns since 0010 (`customer_id uuid → customers(id) on delete set null`, `customer_name`, `customer_phone`), but the INSERT in the effective 0035 version (lines 460-476 of `0035_server_enforced_approvals.sql`) lists only: `sale_number, client_ref, status, payment_method, payment_status, subtotal, discount_*, total, amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name, source`. There is no post-RPC update in the repository either. | In a hosted deployment: select any customer, complete any sale, open the invoice/receipt → customer shows as guest; `sales.customer_id/name/phone` are NULL. In demo mode the same sale **does** persist the customer (`demoRepository.ts:234-236`) — so the bug is invisible in demo and only shows in live. |

### 1.3 Root cause & classification

- **G5 is the dominant defect: DB layer.** A client→server contract (`p_payload->>'customer_id'`) that the server silently ignores. The field was added to the payload in 0018 (the online-order era) but the `sales` INSERT was never extended, so the "fix" shipped only half.
- G1–G4 are **UI** discoverability/permissions-gating choices (arguably intentional for walk-in-first, but they make the feature read as broken).

### 1.4 Exact files / functions

- `src/modules/pos/components/CartPanel.tsx` (empty-cart early return at L32; picker at L51)
- `src/modules/customers/components/CustomerSearchSelect.tsx` (`canView` gate L34, quick-add gate L29, guest option L70/84)
- `src/modules/customers/components/CustomerFormModal.tsx` + `src/modules/customers/validation.ts` (`CustomerFormValues` = name/phone/address/notes)
- `src/modules/customers/types.ts`, `src/modules/customers/hooks/CustomerProvider.tsx` (L56 `canView`)
- `src/modules/pos/hooks/PosProvider.tsx:301-303` (snapshot)
- `src/modules/pos/data/supabaseRepository.ts:146-176` (payload), `:116-118` (read mapping)
- `src/modules/pos/data/demoRepository.ts:234-236` (demo persists the fields)
- `supabase/migrations/0010_customers_returns_refunds.sql:40-56` (columns + FK), `0035_server_enforced_approvals.sql` (effective `pos_complete_sale`, no customer columns in INSERT)

### 1.5 Exact tables / RPCs / policies

- Tables: `sales.customer_id/customer_name/customer_phone` (added 0010), `customers` (0010).
- RPC: `public.pos_complete_sale(p_payload jsonb, p_approval_request_id uuid default null)` — effective definition 0035.
- Policies: none involved in the write (no direct write path on `sales`; only the definer RPC writes).

### 1.6 Demo vs hosted behavior

- **Demo**: selection, quick-add and attachment all work end-to-end; the sale row and receipt carry the customer. Walk-in works.
- **Hosted**: selection/quick-add work in the UI, but **the customer never reaches the database** — every sale reads back as guest (receipt, history, reports that group by customer).

### 1.7 Severity

**High.** Silent data loss on a financial record in live mode (every customer sale), plus the till reads as if the feature doesn't exist.

### 1.8 Correct expected behavior

- The picker (search box + walk-in default) is available **from the first screen**, before any product.
- Name **and** phone are searchable; an optional email can be entered and stored.
- The completed sale in live mode persists exactly what the till shows: `customer_id`, `customer_name`, `customer_phone` (and email if the model gains it); a walk-in sale persists NULLs; deleting a customer sets the sale's `customer_id` to NULL (FK `ON DELETE SET NULL` already does this) while the name/phone snapshot remains for the receipt.

### 1.9 Safest minimal fix (for approval)

1. **DB (the actual fix)**: new migration — `create or replace function public.pos_complete_sale` adding, to the `sales` INSERT: `customer_id, customer_name, customer_phone` taken from `p_payload`, with `customer_id` validated to exist in `customers` (else NULL) so a forged/stale id cannot fail the sale. Three-line change pattern, same shape as 0034. `EXECUTE` grants unchanged (already `authenticated`); anonymous unaffected.
2. **UI**: move the customer control out of the non-empty branch of `CartPanel` (render it in the empty state too); replace the bare `<select>` with a search input that filters the already-loaded list by name/phone (no new data source, no new capability).
3. **Model (decision needed)**: email — add `customers.email` (nullable, not part of the unique index) + an optional form field + sale snapshot column. This is the only piece that changes a schema beyond the RPC; it can be a separate follow-up if you prefer.
4. Keep the `view_customers` gate, but when it hides the picker show a one-line "customer selection unavailable for your role" hint on the till instead of nothing.

### 1.10 Tests required

- Scenario SQL: `pos_complete_sale` with a real `customer_id` → row stored; with a bogus id → NULL + sale succeeds; walk-in → NULLs; `customers` DELETE → sale keeps snapshot, `customer_id` NULL (FK).
- TS self-test: picker visible with empty cart; search filters by phone; quick-add gate per role (cashier yes, viewer no) — extend the existing `enforcement.selftest.ts` pattern.
- `db:check` parity: the new INSERT columns appear in both the RPC and the repository payload test.

---

## Issue 2 — A sale completes with **no open shift**

### 2.1 Reproduced? **Yes** — in demo mode, with no shift opened at all

Repro (demo, exact steps): sign in as cashier/admin → **do not open any shift** → POS → add product → pay → "Complete". The sale completes, stock moves, payments are recorded. My headless run (`/tmp/repro3/a_happy.cjs`) did exactly this — no shift exists anywhere in the store, and `completeSale` returned `INV-000001` successfully.

Live-mode repro: call `pos_complete_sale` directly (any seat with `sell`), or simply use the till — there is **no gate to pass**, so "reproduction" is the default behavior of the system.

### 2.2 Root cause: the requirement does not exist anywhere

Checked every layer; **zero** shift references in the entire POS module (grep over `src/modules/pos/**` finds one comment in `saleService.ts:221` and nothing else):

| Layer | File / object | Shift check? |
|-------|--------------|--------------|
| UI (checkout button) | `PaymentPanel.tsx:112` — `canComplete = !isEmpty && !completing && canSell && balanced` | **No** (payment balance only) |
| UI (page) | `PosPage.tsx`, `CartPanel.tsx` | **No** |
| Provider | `PosProvider.completeSale` (L~298-335) | **No** |
| Service | `saleService.completeSale` — asserts `sell` (+ `apply_discount` + approval cap) | **No** |
| Repo (demo) | `pos/data/demoRepository.ts` `completeSale` | **No** |
| Repo (live) | `pos/data/supabaseRepository.ts:146` → `rpc("pos_complete_sale")` | **No** |
| RPC | `public.pos_complete_sale` (0035) — authorization block checks `can('sell') or can('manage_online_orders')` only | **No** |
| DB schema | `sales` table has **no `shift_id` column**; the only `shift_id` FK in the schema is on `expenses` (0012) | **None possible** |

The **only** connection between shifts and sales is **time-window aggregation** at summary time: `computeShiftSummary` (`src/modules/shifts/services/shiftCalculations.ts:101`) counts a sale into a shift iff `isWithinWindow(sale.created_at, {start: shift.opening_at, end: shift.closed_at ?? now})` — no user filter, no FK.

### 2.3 Consequences (the business-integrity damage)

1. **A sale made while no shift is open belongs to no shift.** With at most one open shift at a time (enforced by the `shifts_enforce_invariants` trigger, 0012: "An open shift already exists"), any sale whose `created_at` falls outside every shift window is counted by **no** shift summary:
   - a shift closed before the sale: window ends before `created_at` → excluded;
   - a shift opened after the sale: window starts after `created_at` → excluded.
2. **Cash drawer math breaks.** For a cash sale: the money physically sits in the drawer, but `expected_cash` (= opening + cash sales − refunds − expenses, `shiftCalculations.ts:57-66`) never includes it → the close-out shows an unexplained **negative** difference, and the shift record cannot be reconciled from the data (there is no column to link the sale to the drawer that actually held the cash).
3. **No attribution.** `shifts.opened_by` (who opened) and `sales.user_id` (who rang) are independent free-text fields; nothing verifies the seller belongs to the open shift — and per-cashier shifts don't even exist (one global open shift), so "the cashier's shift" is not a defined concept today.
4. **No partial records** — the sale itself is complete: `sales`, `sale_items`, `sale_payments`, product decrement and `stock_movements` are all written by the RPC transaction. The only thing missing is the relationship, which the schema cannot even express.
5. **Historical data:** any past sale in the hosted DB that was rung while no shift was open is permanently orphaned from the books; it can only be *found* by window analysis (no column to query).
6. **Online orders** take the identical path (`resolve_online_order()` → `pos_complete_sale` with `source='online'`), so they are equally shift-free — consistent with the model you described (online independent unless the model says otherwise; the model says nothing).

### 2.4 Exact files / functions

- `src/modules/pos/components/PaymentPanel.tsx:112,297` (the only checkout gate: payment balance)
- `src/modules/pos/hooks/PosProvider.tsx` `completeSale`
- `src/modules/pos/services/saleService.ts` `completeSale` (capability + discount/approval only)
- `src/modules/pos/data/{demoRepository,supabaseRepository}.ts`
- `supabase/migrations/0035_server_enforced_approvals.sql` `pos_complete_sale` (authorization block ~L310)
- `supabase/migrations/0012_shifts_and_expenses.sql` — `shifts` DDL (L~40), `enforce_shift_invariants` (L183: single open shift), RLS `shifts_insert_till_staff` / `shifts_update_till_staff_or_approver` (L315-333)
- `src/modules/shifts/services/shiftCalculations.ts:79-150` (`computeShiftSummary`, window predicate L101)
- `src/modules/shifts/hooks/ShiftProvider.tsx:129` (`openShift = shifts.find(s => s.status === "open")`)

### 2.5 Exact tables / RPCs / policies

- Tables: `shifts` (status/opening_at/closed_at/opened_by — no per-user assignment), `sales` (no `shift_id`), `expenses.shift_id` (the only shift FK in the schema).
- RPC: `pos_complete_sale` (no shift check).
- Policies: `shifts_insert_till_staff` (`open_shift`), `shifts_update_till_staff_or_approver` (`close_shift` / `approve_shift_adjustment`) — these gate the shift itself, which nobody needs to open to sell.

### 2.6 Demo vs hosted behavior

Identical — the absence is total in both. Demo additionally enforces the single-open-shift rule in the repository (`shifts/data/demoRepository.ts:84-90`), mirroring the DB trigger.

### 2.7 Severity

**High** (your "critical business-integrity" suspicion is correct). It is not a crash bug; it is a silent accounting hole: cash can leave the drawer outside every shift's books, and the shop's daily reconciliation can never explain the difference.

### 2.8 Correct expected behavior

- **A POS sale requires a valid open shift, enforced server-side in the same transaction as the sale** — refused sales leave **zero** rows (no sale, no items, no payments, no stock movement).
- Online orders remain independent (the RPC accepts `source='online'` without the check), matching the intended model.
- The till shows the shift state (open shift number / "no shift open — open a shift to sell") and disables checkout with that reason when none is open.
- A sale can be attributed to the open shift (at minimum by window — already how summaries work — or by an explicit `shift_id`, see fix option B).

### 2.9 Safest minimal fix (for approval)

**Option A (minimal, no schema change):**
1. New migration: `create or replace function public.pos_complete_sale` — in the authorization block, before any write: `if v_source = 'pos' and not exists (select 1 from public.shifts where status = 'open') then raise exception 'Cannot complete a sale: no open shift' using errcode = 'no_data_found'; end if;`. `source='online'` untouched.
2. Mirror in `pos/data/demoRepository.ts` `completeSale` (same check against the demo shift store) so demo and live cannot drift — the pattern this codebase already uses for every invariant.
3. UI: `PosProvider`/`PaymentPanel` read `useShifts().openShift`; when null, disable "Complete" with the banner and the reason string (new i18n keys). This is *informational* — the real gate is the RPC.
4. One-off report (read-only) to find historical orphans: sales whose `created_at` is inside no shift window (`NOT EXISTS (select 1 from shifts s where s.opening_at <= sales.created_at and (s.closed_at is null or s.closed_at > sales.created_at))`). Decide per row: backfill under the nearest shift's window (via an approved adjustment) or leave documented. **No automatic data rewrite.**

**Option B (stronger, small schema change):** Option A + `ALTER TABLE sales ADD COLUMN shift_id uuid references shifts(id) on delete set null`; the RPC stamps the currently open shift; summaries keep window logic but can also aggregate by FK. Backfill is a separate approved job. Recommended only if you want shift attribution to be a hard fact rather than a time inference.

### 2.10 Tests required

- Scenario SQL: open no shift → `pos_complete_sale(source='pos')` raises and **leaves no rows** in `sales/sale_items/sale_payments/stock_movements/products.stock` (assert counts before/after); open a shift → sale succeeds; `source='online'` succeeds with no shift; closed shift → refused again.
- TS self-tests: demo repository mirrors the refusal; `PaymentPanel` disabled state + banner (unit test on the provider state).
- `db:check` parity for the new check text.
- Regression: existing scenarios (sales with shifts open in fixtures) still pass.

---

## Issue 3 — INV-000002: false "already returned" **and** "remaining returnable: 700", stock never restored

### 3.1 Reproduced? **Yes — the exact reported symptom, in demo mode**

Repro (headless, `/tmp/repro3/b_orphan.cjs`; same steps in a browser):
1. Demo store, signed-in admin. Create product (2g gold necklace, 350, stock 10).
2. Complete sale INV-000001 (1 × 350), then the gold sale **INV-000002** (2 × 350 = 700). Stock: 10 → 7.
3. Present the persisted state of a return that has **no** refund row and **no** stock movement — i.e. a `sales_returns` row with a full-quantity `return_items` row only (what an earlier build of the app left behind; see 3.4 for why the current code cannot write this state fresh):
   `localStorage["alyq.demo.returns.v1"] = [ {return covering the whole line} ]`, refunds key absent, stock untouched.
4. Start the app (repositories snapshot storage at construction), open **Returns → New return**, select INV-000002.

Result (verbatim from the run):

```
[B] per-line returnable: 0
[B] hasAnyReturnable: false → modal banner 'تم إرجاع كافة أصناف هذه الفاتورة مسبقًا' shown = true
[B] remainingRefundable: 700 → modal shows 'المتبقي القابل للإرجاع: 700'
[B] refunds loaded for sale: 0 (none)
[B] retry full return → valid: false  errors: {"item_…":"qtyExceedsSold"}
[B] service refused: qtyExceedsSold
[B] stock now: 7 (should be 10 if the return had restored; customer_return movements: 0)
```

Both messages the user reported appear **simultaneously**, the invoice cannot be returned again from the UI or the service, and the shelf is short by the returned quantity.

### 3.2 The two computations that disagree (exact code)

`ReturnFormModal` (`src/modules/returns/components/ReturnFormModal.tsx`) renders:

- The banner `⚠ returns.allReturned` ("تم إرجاع كافة أصناف هذه الفاتورة مسبقًا") **iff** `hasAnyReturnable === false` — i.e. every line's remaining quantity is ≤ 0, where
  `getRemainingReturnableQuantities` (`src/modules/returns/validation.ts:30-52`) =
  `sold_qty − Σ(return_items.quantity over ALL sales_returns with this sale_id)` — **no status filter** (pending or rejected returns count as returned).
- The financial summary `returns.returnableQty` ("المتبقي القابل للإرجاع") = `validation.remainingRefundable`, where
  `validateReturnDraft` (`validation.ts:135-140`) =
  `sale.total − Σ(refund_records.amount for this sale_id)` via `getTotalRefundedForSale` — **no status filter either**.

INV-000002's data satisfies: return rows cover 100% of the quantities (banner) **and** refund rows sum to 0 (remaining = 700 − 0). The UI shows both as facts; nothing reconciles them.

### 3.3 **The exact reason INV-000002 is considered returned**

The sale is "fully returned" **because a `return_items` row exists against INV-000002's sale line whose `quantity` equals the sold quantity** (the "already returned" test sums exactly those rows, keyed by `sale_item_id`, scoped by `sale_id`). It is *not* derived from any status field on the sale — **there is no `fully_returned` column anywhere**; `sales.status` only takes `completed/pending/voided` and returns never change it. The quantity side and the money side are read from two different tables with no invariant linking them, so one side can be true without the other.

### 3.4 Why this state exists — and why the current code is exonerated for *creating* it fresh

Verified against both write paths:

- **Live**: `public.pos_process_return` (effective definition, 0035) writes, **in one transaction**: `sales_returns` + `return_items` + product stock increment + `stock_movements (adjustment_in/customer_return)` + `refund_records` (always — pending or completed), then spends the approval if one was supplied. RLS makes direct writes impossible (`sales_returns_no_direct_write`, `return_items_no_direct_write`, `refund_records_no_direct_write` — 0010). So a live return row **always** has its refund row and its stock movement.
- **Demo**: `DemoReturnRepository.createReturn` (`src/modules/returns/data/demoRepository.ts:117-226`) does the same: per-item `applyDemoAdjustment` (stock + movement), then `persistReturns(...)` and `persistRefunds(...)` — two **separate, non-atomic** `localStorage` writes. The only in-code window in which the current build can orphan a return is a crash/tab-close *between those two sets* — rare, but real.

Therefore INV-000002's state (return row ✓, refund row ✗, stock movement ✗) was written by **data from an earlier version of the app** — persisted demo `localStorage` from an older build, or early hosted rows from before the write path gained all three side effects — and the current UI then: displays the contradiction, blocks any correction, and never restores the stock. **No current single action reproduces the *creation* of this state; current code only *exposes* it badly.**

### 3.5 Two genuine current-code asymmetries (reproduced, `/tmp/repro3/c_rejected.cjs`)

Scenario: full return recorded with the refund left `pending` (what the approval flow writes for over-cap refunds), then the refund is **rejected**:

```
[C] returnable after REJECTED return: 0
[C] modal 'all returned' banner shown = true   (goods ARE back — banner is factually right)
[C] client remainingRefundable: 0              (client counts the REJECTED 700)
[C] DB (pos_process_return) remaining refundable: 700   (0016/0035: status <> 'rejected' only)
[C] re-return attempt → valid: false  errors: {"item_…":"qtyExceedsSold","refund":"exceedsSaleError"}
```

1. **A rejected return permanently blocks the invoice.** Neither `getRemainingReturnableQuantities` (client) nor the RPC's `v_already_returned` (0035: `sum(ri.quantity)` with no status filter) distinguishes a rejected return from a settled one, while the money side *does* exclude rejected refunds (DB comment 0016(a); client `getTotalRefundedForSale` does **not** exclude them). Result: the goods came back (stock correctly restored — settlement never reverses stock), the shop paid nothing, and the same goods can never be returned again — with client and DB disagreeing about how much money is still refundable (0 vs 700 in the run above).
2. **Client/DB parity gap** on exactly this count: the client's "remaining refundable" over-subtracts rejected refunds relative to the database, so a till operator and the server answer differently after any rejection.

(Also confirmed sound in the same battery: a *settled* full return is consistent — banner + remaining 0, stock restored exactly once, one `customer_return` movement, second return refused: `/tmp/repro3/a_happy.cjs`.)

### 3.6 Cross-checks against the 15 audit points

- **Cross-invoice leak**: none — client scopes by `ret.sale_id === sale.id` and keys by `sale_item_id`; RPC scopes `ri.sale_item_id = v_sale_item.id and r.sale_id = v_sale.id`; `sale_item_id` UUIDs are globally unique anyway.
- **Failed/cancelled/empty returns**: empty is refused everywhere (`No items to return` / `noItemsSelected`); a *rejected* return is the one bad state (3.5.1); "failed" returns don't exist — the RPC is one transaction.
- **Status fields**: `sales_returns.refund_status` mirrors `refund_records.status` on settlement (demo `settleRefund` L262-270; `pos_settle_refund` 0016) — but nothing in the returnable math reads it (3.5.1).
- **Stock**: restored exactly once per settled return in both modes (verified A); never reversed on rejection (intended — goods stayed).
- **Audit**: `return.created` + `refund.created` rows written by the service in both modes (fire-and-forget).
- **Duplicate protection**: quantity check (client + DB) and amount check (both sides) — sound for settled data; the orphan and the rejected-return cases slip past the *intent* of the checks.
- **Demo vs hosted**: same logic on both sides by construction (this codebase mirrors every invariant in both repositories); the orphan data is more likely in demo `localStorage` than in live (live rows always carry all three side effects since 0010), but the UI cannot tell them apart — which is the UX bug.

### 3.7 Exact files / functions

- `src/modules/returns/validation.ts` — `getRemainingReturnableQuantities` (L30-52), `getTotalRefundedForSale` (L54-61), `validateReturnDraft` (L63-151)
- `src/modules/returns/components/ReturnFormModal.tsx` — banner condition (`!hasAnyReturnable`, ~L417-421), financial summary (`validation.remainingRefundable`, ~L355)
- `src/modules/returns/data/demoRepository.ts` — `createReturn` (L117-226; non-atomic double persist), `settleRefund` (L233-277; return status mirror)
- `src/modules/returns/data/supabaseRepository.ts` — `createReturn` (L181+; `rpc("pos_process_return")`), `listReturns` (L129+)
- `src/modules/returns/services/returnService.ts` — `processReturn` (L~120-185: pending + approval flow), `settleRefund`
- `supabase/migrations/0035_server_enforced_approvals.sql` — `pos_process_return` (`v_already_returned` unfiltered L~66-70; amount cap excludes rejected L~55-58; writes all side effects)
- `supabase/migrations/0010_customers_returns_refunds.sql` — tables + no-direct-write policies; `0016_refund_settlement.sql` — `pos_settle_refund`
- `src/modules/returns/types.ts` — `SalesReturn`, `RefundRecord` (status lifecycles)

### 3.8 Exact tables / RPCs / policies

- Tables: `sales_returns`, `return_items`, `refund_records`, `stock_movements`, `products.stock_quantity`.
- RPCs: `pos_process_return`, `pos_settle_refund`.
- Policies: the three `*_no_direct_write` policies (0010); select policies for `authenticated`.

### 3.9 Severity

**High.** Financial records (refund) and physical records (stock) can both be wrong for the same invoice while the UI asserts the opposite of both; the invoice is stuck with no correction path; and every rejected return silently poisons its invoice forever (3.5.1).

### 3.10 Correct expected behavior

- No completed (settled) return ⇒ the invoice is **not** shown as fully returned; full quantity stays returnable; stock unchanged; the invoice is eligible.
- A real return ⇒ `return_items` + stock restored **exactly once** + `stock_movements` + status + audit + refund row, and **no double-restore** (second return refused) — this half already holds (verified).
- A rejected return ⇒ the goods-side record stays (stock stays restored), but the quantity is **released** for re-return and the client/DB agree on the refundable amount.
- An orphaned (inconsistent) state ⇒ the UI shows *which* return records consumed the quantities (with their status) and, when quantities are fully consumed while refundable money remains, flags the discrepancy explicitly instead of printing two contradictory facts; staff have a supervised reconcile action.

### 3.11 Safest minimal fix (for approval)

1. **Reject-aware returnable math (code, both sides, parity):**
   - Client: `getRemainingReturnableQuantities` and `getTotalRefundedForSale` take a predicate `refund_status/refund status <> 'rejected'` — rejected returns stop consuming quantities, rejected refunds stop consuming amount (already so for the client's *pending* counting, which matches the DB).
   - DB: 0035 `pos_process_return` — `v_already_returned` sums `return_items` joined to `sales_returns where refund_status <> 'rejected'` (the status is already kept in mirror by settlement).
   - Add the client/DB parity case to `db:check` so the two formulas cannot drift again.
2. **Surface the inconsistency (UI, read-only):** when `!hasAnyReturnable && remainingRefundable > 0`, render a distinct "record mismatch" panel: list the consuming return records (number, date, **status**, quantity) and the refund rows (or "none"), and disable creating another return with that explanation. This is what would have made INV-000002 diagnosable in one click.
3. **Supervised reconciliation (admin, explicit):** an admin-only action (new capability or reuse `process_return` + `approve_shift_adjustment`-style sign-off — decision) that, for a flagged invoice, either (a) completes the missing side (create the refund row + stock movement to match the existing return) or (b) annuls the orphan return (delete return+items, no stock effect since none happened), writing an audit row. **Runs only on user request, one invoice at a time; nothing is auto-migrated.** INV-000002 is left untouched until you approve which side to believe (goods returned? then (a); phantom row? then (b)).
4. **Demo atomicity:** persist returns+refunds as one storage record (or write a compound key) so the crash window closes.
5. **No** changes to RLS, no direct-write policies, no weakening.

### 3.12 Tests required

- Scenario SQL: settled full return invariants (rows, single movement, double-return refusal — mostly present); **rejected** return ⇒ quantity released, re-return accepted, amount parity with client; orphan state ⇒ `pos_process_return` on top of it is refused (quantity) — document the reconcile action's effect.
- TS self-tests: `getRemainingReturnableQuantities`/`getTotalRefundedForSale` with pending/rejected mixtures; banner vs mismatch-panel conditions (the B and C scenarios as unit cases); demo `createReturn` atomicity (crash-simulation test writing the compound record).
- E2E (demo): the B scenario end-to-end — orphan injected → mismatch panel shows the return record and the zero refunds.

---

## Issue 4 — Storefront checkout: "إرسال الطلب" → "حدث خطأ من جانبنا"

### 4.1 Reproduced? **Yes — the mechanism, exactly.** Demo-mode checkout itself works (Part 1 below); the live failure is reproduced by running the real error through the real normalization chain (Part 2).

### 4.2 The actual underlying error (not the UI message)

The live error is, for any deployment still running the pre-0034 function:

```
23502: null value in column "unit_price" of relation "online_order_items" violates not-null constraint
```

Proven chain, step by step:

1. **The client never sends a price** — by contract: `PlaceOrderInput.lines: { product_id: string; qty: number }[]` (`src/modules/online/types.ts`); `StoreCartProvider` builds exactly that (`src/modules/online/hooks/StoreCartProvider.tsx:509-514`); `supabaseRepository.placeOrder` sends it verbatim (`src/modules/online/data/supabaseRepository.ts:687`).
2. **The pre-0034 function read the price from that payload**: `v_unit := round((v_line->>'unit_price')::numeric, 2)` (`0018_online_order_functions.sql`, second loop, L219) → `NULL`.
3. **The snapshot table forbids it**: `online_order_items.unit_price numeric(14,2) not null` (`0017_online_storefront.sql`) → 23502 on the item INSERT.
4. **The app documents this itself**: migration 0034's header states — *"every checkout failed — `null value in column "unit_price" of relation "online_order_items" violates not-null constraint`. Online ordering did not work at all in live mode."* and *"Demo mode keeps its orders in localStorage, which is why the whole suite passed over the top of this for twenty migrations."*
5. **The UI hides it**: `toOnlineError` (`src/modules/online/data/repository.ts:101-155`) has **no** regex matching a NOT NULL constraint text → falls through to `new OnlineError("db", message)`; `StoreCheckoutPage.tsx:193-199` renders only `t("store.error.db")` = **"حدث خطأ من جانبنا. حاول مرة أخرى."** and never renders `checkoutError.message`. Reproduced in the headless run:

```
[D] live error → OnlineError.code: db
[D] checkout UI renders store.error.db = «حدث خطأ من جانبنا. حاول مرة أخرى.»
```

6. **Why it is still failing for you today**: the fix (server-side pricing, `v_priced_lines`) shipped in **0034, added in commit `29a5ffe` on 2026-09-15** — the base of this session. The repository is fixed; the **hosted Supabase project is only fixed once migration 0034 has been applied there** (`supabase db push` / migration up). A hosted project last synced before 0034 still runs the 0018 function and fails *every* checkout with exactly the message you saw. (This sandbox cannot reach the hosted project to confirm; the verification SQL is in 4.7.)

### 4.3 Demo vs hosted behavior

- **Demo**: checkout works (reproduced — order `WEB-000001`, priced line, reservation created, oversell refused with a typed `insufficient_stock` error). `d_checkout.cjs` Part 1.
- **Hosted**: fails on every submit while pre-0034 (4.2); works after 0034 is applied. The storefront is **anonymous** (`/store/*`, no auth — `App.tsx:86`); the only write path is the SECURITY DEFINER RPC `place_online_order` with `EXECUTE` granted to `anon, authenticated` (`0018` L543 — grants survive `CREATE OR REPLACE` in 0034). No RLS weakening is involved or needed: `online_orders` has `no_direct_insert (false)` / `no_delete` / staff-only update (0017 L634-645), and `online_order_items`/`stock_reservations` likewise admit no direct writes.

### 4.4 Secondary findings (same surface)

1. **Eight live exception texts still fall through to the generic `db`** (reproduced in `d_checkout.cjs` Part 2): `Invalid delivery type`, `Invalid payment method`, `Invalid quantity`, `Product … not found`, `Product … cannot be ordered online`, `Coupon … has been fully used`, `Coupon … needs a subtotal of at least …`, `Coupon … does not apply to this cart`. Two are text drift from existing codes (`has been fully used` vs the regex `has reached its usage limit`; `needs a subtotal of at least` vs `requires a subtotal`) — i.e. the mapping was written against different wording than the RPC raises.
2. **The real message is dropped everywhere customer-facing** (`StoreCheckoutPage` shows only the dictionary string + sku for stock errors). Staff see nothing either — no console log, no detail.
3. **Double-submit safety is sound** (idempotency key per attempt, `clientRefRef`, DB `client_ref` unique + RPC early-return; demo mirrors — verified in the run: second order with a new key = new order, same key = duplicate).
4. **Server pricing is now authoritative** post-0034 (the 0.01-forgery case is covered by `supabase/tests/scenarios.sql` ~L2438-2460).

### 4.5 Exact files / functions

- `src/modules/online/pages/StoreCheckoutPage.tsx:193-199` (error render), `:572` (submit button "إرسال الطلب")
- `src/modules/online/hooks/StoreCartProvider.tsx:500-539` (submit, idempotency key, `toOnlineError`)
- `src/modules/online/data/repository.ts:101-155` (`toOnlineError` regex table + `db` fallback)
- `src/modules/online/data/supabaseRepository.ts:674-703` (RPC call; payload without prices)
- `src/modules/online/data/demoRepository.ts:709+` (demo `placeOrder`)
- `src/lib/i18n/dictionary.ts:5261-5265` (`store.error.*` incl. `db`)
- `supabase/migrations/0018_online_order_functions.sql` (buggy second loop L219; anon grant L543), `0034_online_order_line_prices.sql` (fix + documentation), `0017_online_storefront.sql` (DDL, `reserved_quantity`, RLS)

### 4.6 Exact tables / RPCs / policies

- RPC: `public.place_online_order(p_payload jsonb)` — SECURITY DEFINER, `anon`+`authenticated` EXECUTE.
- Tables: `online_orders`, `online_order_items` (`unit_price NOT NULL`), `stock_reservations`, `order_events`, `website_settings` (read, defensive `coalesce`), `products` (locked, `reserved_quantity()`).
- Policies: no direct writes for anon or authenticated on any of the above (0017) — all writes inside the definer RPC.

### 4.7 Severity

**Critical** — while the hosted project runs pre-0034, the public storefront **cannot place a single order**; and the error UX makes it undiagnosable from the shop's side (that is how it survived unnoticed).

### 4.8 Correct expected behavior

- A submit either creates the order (server-priced lines, reservation, idempotent) or fails with a **specific, human-readable reason** — in Arabic, in the language of the till — that staff can act on.
- The underlying message is never silently swallowed: shown in a detail line for staff builds / dev mode, always logged.
- Applying 0034 to the hosted project is a **deployment step**, not a code change.

### 4.9 Safest minimal fix (for approval)

1. **Deploy 0034 (and 0035–0037) to the hosted project** — `supabase db push` from this exact commit. Then verify on the live project:
   ```sql
   select prosrc like '%v_priced_lines%' from pg_proc where proname = 'place_online_order'; -- expect true
   select version from supabase_migrations.schema_migrations order by version desc limit 5;
   ```
2. **Complete the error map** in `toOnlineError` (pure client code, zero schema/RLS impact): add the eight texts from 4.4.1 (fix the two drifted coupon regexes to the actual RPC wording); keep the generic `db` string for customers but append the raw message to `detail` and `console.error` it so staff/dev see the truth.
3. **No** RLS changes, no new public grants, no anon writes — the fix does not need any of it.

### 4.10 Tests required

- The 0034 scenarios already in `supabase/tests/scenarios.sql` (NULL-price failure before, server price + forged-price refusal after) — run them against the **hosted** project as the deployment acceptance test.
- TS self-test: table-driven `toOnlineError` over every `raise` text in 0018/0034 — assert **no** text maps to `db` (this is the regression test that would have caught the drift).
- E2E (demo): happy checkout + double-submit idempotency (mirrors the headless run).

---

## 7. Interaction with the admin-permissions work (no rework)

- All four fixes stay inside the existing capability architecture (`src/lib/permissions/*`): no new capability is strictly required. Issue 3's reconcile action, if you want it gated beyond `process_return`, should be a **new named capability** wired through `assertSensitiveAction` + an RPC guard + the `db:` column of the register — the pattern the admin audit established — not a role sniff in the UI.
- Cashier already holds `view_customers/add_customer/edit_customer/process_return/open_shift/close_shift` — Issues 1 and 2 need **no matrix change**; viewer/inventory_clerk keep exactly what they have. Nothing in the fixes weakens non-admin permissions or adds frontend-only bypasses.

## 8. Suggested fix order (after approval)

1. **Issue 4 step 1** — deploy migrations 0034–0037 to the hosted project (restores online ordering immediately; no code ship needed).
2. **Issue 4 step 2** — error-map completion + message surfacing (small client change).
3. **Issue 1** — RPC customer persistence + picker/search UI (the email field is a decision item).
4. **Issue 2** — server-side open-shift gate + till banner (Option A; Option B = `shift_id` column as a follow-up decision).
5. **Issue 3** — reject-aware parity fix + mismatch panel + supervised reconcile; INV-000002 handled *only* through the approved reconcile action, one invoice at a time.

Each step ships with its scenario-SQL + TS self-test additions from the sections above; the full battery (`typecheck/test/db:check/test:e2e/lint/build`) must stay green — it is green at `b14ddb1` today.

---

## Appendix — headless reproduction evidence

Scripts: `/tmp/repro3/{prelude,a_happy,b_orphan,c_rejected,d_checkout}.ts` (bundled with esbuild, run under node with memory storage shims and a signed-in demo session; all in `src/` untouched).

**A — happy-path invariants (demo, current code) — all hold:**
```
sale INV-000001 total=700 · stock 10→8 (1 issue movement)
return RET-000001 + refund REF-000001 (700, completed) · stock 8→10 (exactly 1 customer_return movement)
returnable 0 · remainingRefundable 0 · second return refused (qtyExceedsSold) · re-settle idempotent
```
Note: A ran with **no shift open at all** — which is itself the Issue 2 reproduction.

**B — the user's INV-000002 state** — verbatim in §3.1.

**C — rejected-refund asymmetry** — verbatim in §3.5.

**D — storefront checkout** — verbatim in §4.2/§4.4.

No files in the repository were modified; `git status` is clean; nothing was committed or pushed.

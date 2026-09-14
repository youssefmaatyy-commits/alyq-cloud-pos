# Phase 24 — Server-Enforced Approval Controls

Phase 23.5 found that the capability matrix was enforced in the database but the
**approval thresholds were enforced in the browser**: `public.approval_rules` was
read by `get_approval_rules()` and by nothing that enforced anything, so the four
places that decided "this act is too big for you to do alone" were TypeScript.
Phase 23 fixed *who may call* the POS writers. This phase fixes *what the call
may contain*.

**Committed state:** migration `0035_server_enforced_approvals.sql`, 1,027 lines.
No role, capability or grant on the capability matrix changed. All six gates
green.

---

## The three defects this migration closes

**1 · An over-limit act needed no approval if you skipped the browser.**
Proven against this schema as the seeded cashier, who holds `sell` and does not
hold `approve_limit_request`: `pos_complete_sale` with `discount_type 'percent'`
and `discount_value 99.9` wrote a completed sale for 0.01 of a 10.00 basket,
decremented stock and recorded it as legitimate. The RPC validated only that the
discount type was known, the value was not negative, a percentage did not exceed
100 and a fixed amount did not exceed the subtotal — and there is no trigger on
`sales` or `sale_items` at all. A direct `INSERT` into `expenses` of any size was
accepted from anyone holding `add_expense`.

**2 · `submit_approval_request` has never worked against a live database.**
Line 489 of 0023 read `lpad(next_value::text - 1, 6, '0')`. `::text` binds
tighter than `-`, so Postgres parsed it as `text - integer` and raised
`operator does not exist` before the row was written — every call failed. This is
the same defect 0015 fixed for the sale counter and 0016 for the return and
refund counters, repeated in 0023. Nobody noticed because demo mode numbers its
own requests in TypeScript. **This was found by the Phase 24 tests, not by
reading**: the first scenario that raised a real request hit it immediately.
Server-side enforcement is worthless if asking for an approval cannot work, so
the one-token fix travels with this migration.

**3 · Any signed-in seat could spend somebody else's approval.**
`mark_approval_applied` is `SECURITY DEFINER`, so it reads past row level
security. It checked that a request was approved and unspent, but never asked who
was holding the pen: a cashier who knew a colleague's request id could mark it
applied to an entity of their own choosing, burning it so the real act could
never use it and writing a link between the decision and a record that never
existed. Proven before the fix — the cashier spent the manager's approved,
unspent request on `'burned-by-somebody-else'`. This is requirement 6's "approval
cannot be reused incorrectly", and the honest answer was *yes, it can*.

---

## Requirement 1 · the database authority

```sql
public.approval_required_for(p_kind text, p_value numeric) returns boolean
```

`SECURITY INVOKER` — not definer, because it does not need to be: `approval_rules`
is `SELECT`-granted to `authenticated` and readable by policy, and when it is
called from inside a definer function it runs as the owner and reads the same
row. `set search_path = public`. Server-side data only: it reads `approval_rules`
and `public.can()`, and nothing a caller supplied.

It is the single source of truth for the thresholds, and it mirrors the four
evaluators in `src/modules/approvals/validation.ts` condition for condition, so
moving the enforcement did not move the meaning:

| kind | required when | unit |
|---|---|---|
| `discount` | rule on, value > 0, value > `discount_limit_percent` | percentage |
| `refund` | rule on, value > `refund_limit_amount` | money |
| `expense` | rule on, value > `expense_limit_amount` | money |
| `price_change` | `price_change_approval_enabled` (no threshold — the rule is "any move") | money |

Two decisions worth stating:

- **The exemption is inside the oracle.** `assertWithinApprovalLimit()` has always
  returned early for a holder of `approve_limit_request` — "the limits bind the
  seats below the authority … the only reading that does not make a manager file
  paperwork to do their job". Encoding that anywhere else would have produced two
  answers to one question, so `approval_required_for` returns `false` for them.
  It is still server-side data: `public.can()` reads the acting identity's
  resolved capabilities, not a flag in a payload.
- **`p_value` for `discount` is a percentage**, because that is the unit
  `discount_limit_percent` and `approval_requests.amount` are both written in.
  Passing money there would compare 8.00 against a 10% threshold.

A second, internal helper does the validation:

```sql
public.approval_assert_satisfied(p_kind text, p_value numeric,
                                 p_request_id uuid, p_match jsonb default '{}')
  returns uuid
```

It proves a real decision stands behind the act and returns its id **without
spending it** — the caller spends it with `mark_approval_applied()` once the
record it produced exists, so a rolled-back act leaves the approval unspent.
`EXECUTE` is revoked from `public`, `anon` and `authenticated`: the authorization
it performs belongs to the act that asked for it, not to a browser.

It checks, in order: the caller is signed in; the request exists; `status =
'approved'`; `kind` matches the act; **`requested_by` is the caller**; it has not
already been applied; **`amount >= p_value`**, so an approval covers the value
actually being written and not merely the value that was asked for; and every key
in `p_match` equals what was approved, so a price-change approval naming one
product and one price cannot be spent on another.

## Requirement 2 · `pos_complete_sale`

New signature `pos_complete_sale(p_payload jsonb, p_approval_request_id uuid
default null)`. The one-argument version is **dropped** rather than left
alongside: two functions of the same name where one takes a defaulted argument
make every existing single-argument call ambiguous. The default keeps
`resolve_online_order()` — which completes an online order by calling this
function with no discount — and every other caller working unchanged.

The percentage is **computed inside the function** from the numbers the function
itself derived:

```sql
v_discount_percent := case
  when v_subtotal > 0 then round((v_discount_amount * 100.0 / v_subtotal)::numeric, 2)
  else 0
end;
```

`v_subtotal` is the sum of `v_product.selling_price * qty` for lines re-read
`for update` from the catalogue, and `v_discount_amount` is the discount the
function clamped. Neither comes from the caller, so a **fixed** discount is
measured the way the till measures it: 8.00 off a 20.00 basket is the 40% act it
is. No client approval flag is trusted — the id is a reference that gets
validated, and when it is absent the function looks for the caller's own
approved, unspent request instead of believing anything asserted about it.

Validation happens **before** the sale counter is advanced, so a refused discount
does not burn an invoice number; the approval is spent **after** the sale row
exists, inside the same transaction.

The client-side check in `saleService.completeSale` is untouched and remains a
UX optimisation: it produces the good error and the "send for approval" flow. It
now also forwards `approval?.requestId` to the repository, which passes it as
`p_approval_request_id`, so the database validates the exact decision the till
was shown.

## Requirement 3 · the same pattern on the other three

| Act | Where it is enforced | How the request reaches it |
|---|---|---|
| **Price changes** | `enforce_price_authority()` (BEFORE UPDATE on `products`, 0030) | found: a trigger has no channel for an id |
| **Returns / refunds** | `pos_process_return`, after the refundable-amount cap | `p_payload->>'approval_request_id'`, else found |
| **Expenses** | `enforce_expense_invariants()` (BEFORE INSERT OR UPDATE, 0012) | found |

The refund gate sits at *creation*, which is where the amount is decided;
`pos_settle_refund` (completing it) keeps its own `approve_refund` gate and is
unchanged. An expense edit is gated only when it **raises** the amount over the
cap, so fixing a note on last month's large expense does not demand fresh
paperwork. The price gate matches on exactly the columns that moved, so an
approval naming a new selling price cannot be spent on a cost-price move, and it
sits behind the rule's `price_change_approval_enabled` flag — **off by default**,
so an installation that has not asked for it sees no change.

"Found" means: the caller's own request, of this kind, `approved`, unspent, for
at least this value, oldest first. It cannot be forged —
`enforce_approval_request_invariants` stamps `requested_by` from `auth.uid()` and
freezes it, and a status may only move to `approved` under
`approve_limit_request`.

## Requirement 4 · migration and compatibility

One migration, `0035_server_enforced_approvals.sql`. `CREATE OR REPLACE`
throughout and a single `DROP FUNCTION IF EXISTS`, so it is idempotent —
`db:check` applies all 35 twice and asserts the second run changes nothing.

- **No role changed. No capability changed. No permission removed.**
  `role_capabilities` is not touched; the exemption for `approve_limit_request`
  is the existing rule evaluated where it cannot be skipped.
- No arithmetic, return shape or existing validation altered. The five redefined
  bodies (`pos_complete_sale`, `pos_process_return`, `enforce_expense_invariants`,
  `enforce_price_authority`, `submit_approval_request`, plus
  `mark_approval_applied`) were **extracted verbatim** from the migrations that
  last defined them by a script that asserted each splice anchor occurred exactly
  once — the discipline 0033 set. Nothing was retyped.
- Backward compatibility held everywhere except the one place it had to break: an
  over-limit act by a seat below the authority now needs a decision. Exactly one
  existing scenario was in that position (the cashier's 8.00-off-20.00 = 40%
  discount in the refunds scenario), and it was updated to raise and sign a real
  request the way the till does. Every number in it is unchanged, so the return
  and refund assertions after it still test what they always tested.

## Requirement 5 · the tests

All six required cases run against the real RPC, in `supabase/tests/scenarios.sql`,
as the seeded cashier — with two preconditions asserted first, so the cases mean
what they say: `can('approve_limit_request')` must be false (or the limits would
not bind) and `can('sell')` must be true (or the sales would fail for the wrong
reason).

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | 99.9% discount, no approval | FAIL | ✓ refused `insufficient_privilege`, and **no sale row written** |
| 2 | same, with a valid approved `p_approval_request_id` | SUCCESS | ✓ sale written, discount recorded as the catalogue-derived 9.99 / total 0.01, request spent **and linked to that sale id** |
| 3 | fabricated request id (`gen_random_uuid()`) | FAIL | ✓ refused `no_data_found` |
| 4 | approval belonging to another person | FAIL | ✓ refused `insufficient_privilege`; the borrowed approval is **still unspent** afterwards |
| 4b | approval already spent on another sale | FAIL | ✓ refused `check_violation`, no sale row written |
| 5 | approval for 20% used for a 99.9% discount | FAIL | ✓ refused `check_violation`; the 20% it *was* signed for then succeeds — a gate, not a wall |
| 6 | ordinary sale, 5% discount, no approval | SUCCESS | ✓ written, recorded as 0.50 off / 9.50 total |

Plus the boundary agreement between the two sides of the same rule:
`approval_required_for` answers false at 0, at 10.00, at exactly 1000.00 and at
exactly 500.00, and true at 10.01, 1000.01 and 500.01 — the same edges
`evaluateDiscountRule`, `evaluateRefundRule` and `evaluateExpenseRule` use — an
unknown kind is refused, `price_change` is off by default, and for an admin
holding `approve_limit_request` every value answers false.

**Requirement 6 · the ledger itself**, asserted in the same block: a request
cannot be forged (`INSERT` is refused for every browser role, and
`submit_approval_request` attributes it to `auth.uid()` whatever the payload
claimed); an `approved` status cannot be injected (`UPDATE` and `DELETE` move zero
rows, and the row is re-read afterwards and still `pending`); a cashier cannot
sign their own request through `decide_approval_request`; a **pending** request is
not a licence — the 99.9% discount is still refused with one sitting there, which
is the case a gate reading only "a request exists" would get wrong; and one
caller cannot spend another's decision.

**Every gate was verified to have teeth**, by disabling it and watching the right
test fail:

- Neutering only the "no id supplied" path of the discount gate — leaving the
  explicit-id path intact so the rest of the suite still passes — makes the
  bypass work again, and the run fails with `TEST 1 FAILED: a cashier rang up a
  99.9 percent discount with no approval behind it`.
- Neutering `mark_approval_applied`'s new caller check fails with `a cashier
  spent the manager's approved request on an entity of their own choosing`.
- Making `approval_required_for` always return false fails the suite.

Before any of that, the very first run of this migration failed with `This
discount is above the shop limit and has no approved request behind it` on a
scenario that had been passing for eleven phases — the direct RPC bypass, caught.

## Requirement 7 · the register

Seven `db` notes in `src/lib/permissions/actions.ts` now say where approval is
enforced, replacing silence with the mechanism: `sale.complete`, `sale.discount`,
`return.create`, `refund.record`, `expense.create`, `product.price_change` and
`product.cost_change` each record that approval is enforced server-side through
`public.approval_required_for()` and a validated approval request, naming the
function or trigger that does it. The Phase 23.5 test that fails whenever a note
cites a `public.*` object that does not exist now covers these too.

## Files changed

| File | Change |
|---|---|
| `supabase/migrations/0035_server_enforced_approvals.sql` | **new**, 1,027 lines — the oracle, the validator, four enforcement points, the counter fix, the caller check |
| `supabase/tests/scenarios.sql` | +368 lines — the six cases, the boundary agreement, the ledger audit; and the one existing over-limit scenario now carries a real approval |
| `src/lib/permissions/actions.ts` | seven register notes |
| `src/modules/pos/data/repository.ts` | `completeSale` takes the approval id |
| `src/modules/pos/data/supabaseRepository.ts` | passes it as `p_approval_request_id` |
| `src/modules/pos/data/demoRepository.ts` | same signature; demo mode has no database to enforce it |
| `src/modules/pos/services/saleService.ts` | forwards `approval?.requestId` |

## Security impact

| | Before | After |
|---|---|---|
| 99.9% discount by direct RPC | completed sale for 0.01 of the basket | refused, nothing written |
| Over-cap expense by direct `INSERT` | accepted from any `add_expense` holder | refused by the trigger |
| Over-cap refund by direct RPC | accepted up to the sale's refundable amount | refused without a decision |
| Price move with the rule on | browser-only | refused by the trigger unless an approval names that product and that price |
| Raising an approval request | **failed on every call** (counter bug) | works |
| Spending somebody else's approval | possible for any signed-in seat | refused |
| Where the thresholds are decided | `approvalService.ts` in the browser | `approval_required_for()` in the database, with the browser as the first of two layers |

## Remaining risks

Stated plainly, because an audit that ends with "all clear" is not an audit:

1. **Demo mode has no database**, so there the client-side check is still the only
   one. That is what demo mode is — in-memory data, announced on the login card —
   and it cannot reach a real till, but it does mean the two modes are not
   equally protected.
2. **Non-browser callers are exempt from the two trigger gates.**
   `enforce_price_authority` returns early unless `role = 'authenticated'` (0030's
   own design, so migrations, the seed, psql and the service-role edge function
   can still write a price), and the expense trigger inherits the same shape.
   The consequence is that the `service_role` key bypasses these limits — as it
   bypasses everything in Supabase. `pos_complete_sale` and `pos_process_return`
   have no such hatch: they require `can('sell')` / `can('process_return')`, so
   they are gated for every caller that can reach them at all.
3. **A found approval is not bound to one basket.** When no id is supplied, the
   act consumes the caller's own oldest approved unspent request covering the
   value, so a decision authorises "this person, this kind, up to this value,
   once" rather than "this specific transaction". It cannot be forged or
   borrowed, and the till now supplies the id for sales; if a shop wants a
   decision bound to an exact transaction, the remaining three acts need a
   channel for the id, which a trigger cannot offer without an RPC in front of
   it.
4. **Thresholds are one global row.** No per-role, per-branch or per-category
   limits. Unchanged from Phase 12, and not something this phase was asked to
   alter.
5. **`approve_expense` is still inert** — grantable in the role editor, read by no
   production path. Reported in Phase 23.5, unchanged here, because removing or
   rewiring it means changing the capability architecture.
6. **The four evaluators in `validation.ts` and the oracle in SQL are two
   implementations of one rule.** They are asserted to agree at the boundaries
   and were written condition for condition, but nothing stops them drifting: a
   future threshold added to one and not the other would reopen a gap in the
   browser only, which is now the weaker layer — so the failure mode is a
   missing early error, not a bypass.

## Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **27/27 suites** |
| `npm run db:check` | ✓ **35 migrations** apply cleanly, are idempotent, and satisfy the application — including all role scenarios |
| `npm run test:e2e` | ✓ **6/6 suites** |
| `npm run build` | ✓ 6.46s · `dist/index.html` 2,450.52 kB (gzip 657.67 kB) |
| `npm run lint` | **0 errors / 23 warnings** — the Phase 23 baseline |

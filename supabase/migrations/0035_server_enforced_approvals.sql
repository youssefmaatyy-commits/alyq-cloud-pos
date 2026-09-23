-- ════════════════════════════════════════════════════════════════════════════
-- 0035 · Server-enforced approval controls
--
-- WHAT THIS FIXES
--   Phase 12 built an approval-limit system: a discount above a percentage, a
--   refund or an expense above an amount, and — if the shop wants it — every
--   price move must be sent for approval and decided by somebody holding
--   approve_limit_request. The thresholds live in public.approval_rules.
--
--   Nothing in the database ever consulted that table when it enforced
--   anything. get_approval_rules() is a read helper: the browser fetched the
--   thresholds, compared the number it was about to send, and refused itself
--   (approvalService.ts:210, assertWithinApprovalLimit). The four enforcement
--   points were TypeScript — saleService.ts:146, catalogService.ts:188,
--   returnService.ts:246, expenseService.ts:65 — so any of them could be
--   bypassed by not using the browser.
--
--   Proven against this schema before the fix, as the seeded CASHIER, who does
--   not hold approve_limit_request:
--
--     · pos_complete_sale with discount_type 'percent' and discount_value 99.9
--       wrote a sale for a fraction of the basket's value, decremented stock,
--       and recorded it as a legitimate completed sale. The RPC validated only
--       that the type was known, the value was not negative, a percentage did
--       not exceed 100 and a fixed amount did not exceed the subtotal — and
--       there is no trigger on sales or sale_items at all.
--     · a direct INSERT into expenses of any size was accepted from a caller
--       holding add_expense: enforce_expense_invariants checked the capability
--       and never the amount.
--
--   What Phase 23 fixed was *who may call* these functions. This fixes *what the
--   call may contain*. Both are needed: a gate that admits the right person and
--   then trusts their arithmetic only stops the honest.
--
-- WHAT IT ADDS
--   · approval_required_for(kind, value)  the one authority on the thresholds.
--     Reads approval_rules and the acting identity's capabilities, and nothing
--     the caller supplied. Mirrors the four evaluators in
--     src/modules/approvals/validation.ts condition for condition, so moving the
--     enforcement did not move the meaning.
--   · approval_assert_satisfied(kind, value, request_id, match)  proves a real
--     decision stands behind an over-limit act and returns its id without
--     spending it. Internal: EXECUTE revoked from every browser role.
--   · the four acts now consult both, and spend the approval with the existing
--     mark_approval_applied() inside the same transaction as the record it
--     produced, so a rolled-back act leaves the approval unspent.
--   · mark_approval_applied() itself learns whose decision it is holding. It was
--     definer, so it read past row level security and asked only whether a
--     request was approved and unspent — never who was asking. A cashier who
--     knew a colleague's request id could mark it applied to an entity of their
--     choosing, burning it. Requirement 6 asks whether an approval can be
--     reused incorrectly; the answer was yes, and section 8 is the fix.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE
--   · no role, no capability and no grant on the capability matrix. The
--     exemption for holders of approve_limit_request is the existing rule, now
--     evaluated where it cannot be skipped.
--   · no arithmetic, no return shape, no validation that already existed.
--   · the browser-side checks all stay. They produce the good error message and
--     the "send for approval" flow; they are now the first of two layers instead
--     of the only one.
--   · pos_complete_sale's new parameter is optional, so resolve_online_order()
--     and every other existing caller are unaffected.
--
-- HOW IT WAS PRODUCED
--   The four redefined bodies are lifted verbatim from the migrations that last
--   defined them (0033, 0033, 0012, 0030) by scripts that asserted each splice
--   anchor occurs exactly once. Nothing was retyped.
--
-- Idempotent: CREATE OR REPLACE throughout, and the one DROP below is guarded by
-- IF EXISTS and followed by a CREATE that a second run simply replaces.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. the threshold oracle ─────────────────────────────────────────────────

create or replace function public.approval_required_for(
  p_kind  text,
  p_value numeric
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  -- The table's own defaults, so an installation that has no rules row yet gets
  -- the same answer it would get after 0023 seeded it — never "no approval
  -- needed" by accident.
  v_discount_enabled boolean := true;
  v_discount_percent numeric := 10.00;
  v_refund_enabled   boolean := true;
  v_refund_amount    numeric := 1000.00;
  v_expense_enabled  boolean := true;
  v_expense_amount   numeric := 500.00;
  v_price_enabled    boolean := false;
  v_value            numeric := coalesce(p_value, 0);
begin
  if p_kind is null or p_kind not in ('discount', 'refund', 'expense', 'price_change') then
    raise exception 'Unknown approval kind: %', coalesce(p_kind, '(none)')
      using errcode = 'check_violation';
  end if;

  -- The limits bind the seats below the authority. Somebody holding
  -- approve_limit_request is never routed through their own inbox, which is the
  -- reading assertWithinApprovalLimit() has always applied in the browser and
  -- the only one that does not make a manager file paperwork to do their job.
  -- This is server-side data: public.can() reads the acting identity's resolved
  -- capabilities, not anything the caller sent.
  if public.can('approve_limit_request') then
    return false;
  end if;

  select coalesce(r.discount_limit_enabled, true),
         coalesce(r.discount_limit_percent, 10.00),
         coalesce(r.refund_limit_enabled, true),
         coalesce(r.refund_limit_amount, 1000.00),
         coalesce(r.expense_limit_enabled, true),
         coalesce(r.expense_limit_amount, 500.00),
         coalesce(r.price_change_approval_enabled, false)
    into v_discount_enabled, v_discount_percent, v_refund_enabled, v_refund_amount,
         v_expense_enabled, v_expense_amount, v_price_enabled
    from public.approval_rules r
   where r.id = 1;

  return case p_kind
    -- Mirrors evaluateDiscountRule(): nothing to approve at or below zero, and
    -- the threshold is a percentage, which is the unit approval_requests.amount
    -- stores for this kind.
    when 'discount' then v_discount_enabled and v_value > 0 and v_value > v_discount_percent
    -- Mirrors evaluateRefundRule() and evaluateExpenseRule(): money, and the
    -- limit is the amount itself, not a percentage of it.
    when 'refund'   then v_refund_enabled  and v_value > v_refund_amount
    when 'expense'  then v_expense_enabled and v_value > v_expense_amount
    -- Mirrors evaluatePriceChangeRule(): there is no numeric threshold, the rule
    -- is "any move", so the caller asks only when a value actually moved.
    else v_price_enabled
  end;
end;
$$;

comment on function public.approval_required_for(text, numeric) is
  'Does this act need an approved request behind it? The single source of truth '
  'for the Phase 12 thresholds: reads public.approval_rules and the acting '
  'identity''s capabilities, and nothing a caller supplied. p_value is a '
  'percentage for kind = discount and money for refund and expense. Holders of '
  'approve_limit_request are exempt, which is what the browser has always done.';

grant execute on function public.approval_required_for(text, numeric) to authenticated;
revoke execute on function public.approval_required_for(text, numeric) from anon;

-- ── 2. the request validator ────────────────────────────────────────────────

create or replace function public.approval_assert_satisfied(
  p_kind       text,
  p_value      numeric,
  p_request_id uuid,
  p_match      jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_uid     text := auth.uid()::text;
  v_request public.approval_requests;
  v_key     text;
begin
  if v_uid is null then
    raise exception 'An over-limit act needs a signed-in identity'
      using errcode = 'insufficient_privilege';
  end if;

  if p_request_id is not null then
    select * into v_request from public.approval_requests r where r.id = p_request_id;
    if v_request.id is null then
      raise exception 'Approval request % not found', p_request_id
        using errcode = 'P0002';
    end if;
  else
    -- No id was supplied, which is the situation a trigger is always in: there
    -- is no channel to pass one through an UPDATE or an INSERT. Find the
    -- caller's own approved, unspent request of this kind that covers the value.
    -- That cannot be forged — enforce_approval_request_invariants stamps
    -- requested_by from auth.uid() and freezes it, and a status may only move to
    -- 'approved' under approve_limit_request — so what is found is a real
    -- decision about this person and a value at least this large.
    select * into v_request
      from public.approval_requests r
     where r.kind::text = p_kind
       and r.status = 'approved'
       and r.result_entity_id is null
       and r.requested_by = v_uid
       and r.amount >= coalesce(p_value, 0)
     order by r.requested_at
     limit 1;
    if v_request.id is null then
      raise exception 'This % is above the shop limit and has no approved request behind it', p_kind
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- The same checks whether the id was supplied or found. This is the
  -- server-side form of assertRequestApplicable() — approved, right kind, not
  -- already spent — plus the two a browser could never make about itself: that
  -- the approval belongs to the person acting, and that it covers the value
  -- actually being written rather than the value that was asked for.
  if v_request.status <> 'approved' then
    raise exception 'Only an approved request can be applied (this one is %)', v_request.status
      using errcode = 'check_violation';
  end if;
  if v_request.kind::text <> p_kind then
    raise exception 'This request is for a %, not a %', v_request.kind, p_kind
      using errcode = 'check_violation';
  end if;
  if v_request.requested_by <> v_uid then
    raise exception 'An approval belongs to the person who asked for it'
      using errcode = 'insufficient_privilege';
  end if;
  if v_request.result_entity_id is not null then
    raise exception 'This request has already been applied'
      using errcode = 'check_violation';
  end if;
  if v_request.amount < coalesce(p_value, 0) then
    raise exception 'The approval covers % but this act needs %',
      v_request.amount, coalesce(p_value, 0)
      using errcode = 'check_violation';
  end if;

  -- Context. Every key the caller insists on must match what was approved, so a
  -- price-change approval for one product cannot be spent on another.
  if jsonb_typeof(coalesce(p_match, '{}'::jsonb)) = 'object' then
    for v_key in select * from jsonb_object_keys(coalesce(p_match, '{}'::jsonb))
    loop
      if v_request.new_value ->> v_key is distinct from (p_match ->> v_key) then
        raise exception 'The approval was for % = %, not %', v_key,
          coalesce(v_request.new_value ->> v_key, '(unset)'), p_match ->> v_key
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  return v_request.id;
end;
$$;

comment on function public.approval_assert_satisfied(text, numeric, uuid, jsonb) is
  'Proves an over-limit act has a real decision behind it and returns that '
  'request''s id, without spending it — the caller spends it with '
  'mark_approval_applied() once the record it produced exists, so a rolled-back '
  'act leaves the approval unspent. Internal: EXECUTE is revoked from every '
  'browser role, because the authorization it performs belongs to the act that '
  'asked for it.';

revoke execute on function public.approval_assert_satisfied(text, numeric, uuid, jsonb) from public;
revoke execute on function public.approval_assert_satisfied(text, numeric, uuid, jsonb) from anon;
revoke execute on function public.approval_assert_satisfied(text, numeric, uuid, jsonb) from authenticated;

-- ── 3. pos_complete_sale: the discount is measured here, not in the browser ──
-- The one-argument version is dropped rather than left alongside the new one:
-- two functions of the same name where one takes a defaulted argument make every
-- existing single-argument call ambiguous.

drop function if exists public.pos_complete_sale(jsonb);

create or replace function public.pos_complete_sale(
  p_payload jsonb,
  -- Phase 24: the request that authorises an over-limit discount. Optional so
  -- every existing caller — resolve_online_order() included, which completes an
  -- online order with no discount — keeps working unchanged.
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref      text := p_payload->>'client_ref';
  v_discount_type   text := coalesce(p_payload->>'discount_type', 'none');
  v_discount_value  numeric(14,2) := coalesce((p_payload->>'discount_value')::numeric, 0);
  v_user_id         text := p_payload->>'user_id';
  v_user_name       text := p_payload->>'user_name';
  v_source          text := coalesce(p_payload->>'source', 'pos');

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;

  v_subtotal        numeric(14,2) := 0;
  v_discount_percent numeric(8,2) := 0;
  v_approval_id      uuid;
  v_discount_amount numeric(14,2) := 0;
  v_total           numeric(14,2);

  v_pay             jsonb;
  v_pay_method      text;
  v_pay_amount      numeric(14,2);
  v_pay_status      text;
  v_pay_tendered    numeric(14,2);
  v_sum             numeric(14,2) := 0;
  v_cash_received   numeric(14,2) := 0;
  v_cash_applied    numeric(14,2) := 0;
  v_all_paid        boolean := true;
  v_first_method    public.payment_method;

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
  v_pay_status_enum public.payment_status;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- This function is SECURITY DEFINER, so row level security does not apply
  -- inside it, and EXECUTE is granted to `authenticated`. Until this guard
  -- existed, the capability matrix was enforced only in the browser: any
  -- signed-in seat — including a read-only `viewer`, whose `can('sell')` is
  -- false — could call the RPC directly and write a sale, its items, its
  -- payments and a stock movement. Reproduced before the fix: a viewer created
  -- INV-000002 and moved stock 500 → 498.
  --
  -- `manage_online_orders` is accepted alongside `sell` because
  -- `resolve_online_order()` completes an order by calling this function with
  -- source = 'online'. That path must keep working for a seat that works the
  -- online queue. Every shipped role that resolves orders also holds `sell`;
  -- this widens the gate only for a custom role built to work orders without
  -- ringing up sales at the till.
  if not (public.can('sell') or public.can('manage_online_orders')) then
    raise exception 'Not permitted to complete a sale'
      using errcode = 'insufficient_privilege';
  end if;
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_source not in ('pos', 'online') then
    raise exception 'Invalid source' using errcode = 'check_violation';
  end if;

  if v_discount_type not in ('none','percent','fixed') or v_discount_value < 0
     or (v_discount_type = 'percent' and v_discount_value > 100) then
    raise exception 'Invalid discount' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_payload->'lines','[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'payments','[]'::jsonb)) = 0 then
    raise exception 'At least one payment is required' using errcode = 'check_violation';
  end if;

  -- 2. validate lines against live catalog + accumulate subtotal
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Product % is not sellable', v_product.sku using errcode = 'check_violation';
    end if;
    if v_qty > v_product.stock_quantity then
      raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
    end if;
    v_subtotal := v_subtotal + round((v_product.selling_price * v_qty)::numeric, 2);
  end loop;

  -- 3. authoritative totals
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_subtotal * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- ── approval limits, enforced here and not in the browser (Phase 24) ──────
  -- Until now the only thing between a signed-in seat and an arbitrary discount
  -- was saleService.ts:146, which a direct call to this function never passes
  -- through. The percentage below is derived from numbers this function computed
  -- itself — the catalogue-priced subtotal and the discount it clamped — and not
  -- from anything the caller claims, so a fixed discount is measured the same
  -- way the till measures it: 8.00 off a 20.00 basket is the 40% act it is.
  v_discount_percent := case
    when v_subtotal > 0 then round((v_discount_amount * 100.0 / v_subtotal)::numeric, 2)
    else 0
  end;
  if public.approval_required_for('discount', v_discount_percent) then
    if p_approval_request_id is not null then
      v_approval_id := p_approval_request_id;
    elsif coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    -- Validates and returns the request without spending it: the sale does not
    -- exist yet, and a sale that fails below must not burn an approval.
    v_approval_id := public.approval_assert_satisfied(
      'discount', v_discount_percent, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 4. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- 0015 added 'visa'; 0018 adds 'cod' for online orders.
    if v_pay_method not in ('cash','instapay','visa','cod') or v_pay_amount <= 0 then
      raise exception 'Invalid payment' using errcode = 'check_violation';
    end if;
    if v_pay_method = 'cash' then
      v_pay_tendered := round(coalesce((v_pay->>'tendered')::numeric, v_pay_amount), 2);
      if v_pay_tendered < v_pay_amount then
        raise exception 'Insufficient cash received' using errcode = 'check_violation';
      end if;
      v_cash_received := v_cash_received + v_pay_tendered;
      v_cash_applied  := v_cash_applied + v_pay_amount;
      v_pay_status := 'paid';
    else
      -- Card money is captured at the terminal, so `visa` is always paid.
      -- Cash on delivery has NOT been collected, so `cod` is always pending —
      -- a client cannot claim delivery cash it has not taken. InstaPay alone
      -- stays pending until the transfer is confirmed.
      v_pay_status := case
        when v_pay_method = 'visa' then 'paid'
        when v_pay_method = 'cod' then 'pending'
        when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending'
        else 'paid'
      end;
    end if;
    if v_pay_status = 'pending' then v_all_paid := false; end if;
    if v_first_method is null then v_first_method := v_pay_method::public.payment_method; end if;
    v_sum := v_sum + v_pay_amount;
  end loop;

  if v_sum <> v_total then
    raise exception 'Payments sum to %, but the sale total is %', v_sum, v_total using errcode = 'check_violation';
  end if;

  v_sale_status := case when v_all_paid then 'completed' else 'pending' end;

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end,
    v_source
  ) returning id into v_sale_id;

  -- Spend it now, inside the same transaction as the sale it produced, so a
  -- rolled-back sale leaves the approval unspent and it cannot be replayed
  -- against the next one.
  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_sale_id::text);
  end if;

  -- 6. payment rows + sale items + stock + movements
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- The same rule as validation above: InstaPay follows the payload, card and
    -- cash are paid, cash on delivery is never paid at creation.
    v_pay_status := case
      when v_pay_method = 'instapay'
        then case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end
      when v_pay_method = 'cod' then 'pending'
      else 'paid'
    end;
    v_pay_status_enum := v_pay_status::public.payment_status;

    insert into public.sale_payments (sale_id, method, amount, status, paid_at, paid_by, paid_by_name)
    values (
      v_sale_id, v_pay_method::public.payment_method, v_pay_amount, v_pay_status_enum,
      case when v_pay_status_enum = 'paid' then now() else null end,
      case when v_pay_status_enum = 'paid' then v_user_id else null end,
      case when v_pay_status_enum = 'paid' then v_user_name else null end
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    insert into public.sale_items (sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total)
    values (v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
            v_product.barcode, v_product.selling_price, v_qty,
            round((v_product.selling_price * v_qty)::numeric, 2));

    v_before := v_product.stock_quantity;
    update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

    insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
    values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
            case when v_source = 'online'
                 then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
                 else 'Sale ' || v_sale_number
            end,
            v_user_id, v_user_name);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;
-- ── 4. pos_process_return: a refund above the cap needs a signature ─────────

create or replace function public.pos_process_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale             public.sales%rowtype;
  v_line             jsonb;
  v_return_id        uuid;
  v_refund_id        uuid;
  v_return_number    text;
  v_refund_number    text;
  v_refund_total     numeric(14,2) := 0;
  v_approval_id      uuid;
  v_refunded_so_far  numeric(14,2) := 0;
  v_sale_item        public.sale_items%rowtype;
  v_already_returned integer;
  v_qty              integer;
  v_before           integer;
  v_refund_method    text := coalesce(p_payload->>'refund_method', 'cash');
  v_refund_status    text := coalesce(p_payload->>'refund_status', 'completed');
  v_reason           text := btrim(coalesce(p_payload->>'reason', ''));
  v_user_id          text := p_payload->>'user_id';
  v_user_name        text := p_payload->>'user_name';
  v_product          public.products%rowtype;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- SECURITY DEFINER + EXECUTE to `authenticated` + no predicate meant any
  -- signed-in seat could process a return and issue a refund — money out of the
  -- till — regardless of `process_return`. A viewer did exactly that in the
  -- reproduction that prompted this guard.
  if not public.can('process_return') then
    raise exception 'Not permitted to process a return'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason = '' then
    raise exception 'Return reason is required' using errcode = 'check_violation';
  end if;
  if v_refund_method not in ('cash', 'visa', 'instapay') then
    raise exception 'Invalid refund method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'No items to return' using errcode = 'check_violation';
  end if;

  select * into v_sale from public.sales where id = (p_payload->>'sale_id')::uuid for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Voided sales cannot be returned' using errcode = 'check_violation';
  end if;

  -- 0016 (a): a rejected refund never moved money, so it does not consume the
  -- sale's refundable amount. Pending still does.
  select coalesce(sum(amount), 0) into v_refunded_so_far
    from public.refund_records
   where sale_id = v_sale.id
     and status <> 'rejected';

  -- validate every line before writing anything
  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Return quantity must be a positive whole number' using errcode = 'check_violation';
    end if;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;
    if not found then
      raise exception 'Sale item not found on this invoice' using errcode = 'foreign_key_violation';
    end if;

    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id and ri.sale_item_id = v_sale_item.id;

    if v_qty > (v_sale_item.quantity - v_already_returned) then
      raise exception 'Return quantity exceeds remaining returnable quantity for %', v_sale_item.sku
        using errcode = 'check_violation';
    end if;

    v_refund_total := v_refund_total + round((v_sale_item.unit_price * v_qty)::numeric, 2);
  end loop;

  if v_refund_total > (v_sale.total - v_refunded_so_far) then
    raise exception 'Refund exceeds remaining refundable amount for this sale'
      using errcode = 'check_violation';
  end if;

  -- ── approval limits (Phase 24) ────────────────────────────────────────────
  -- The refund total above is built from the sale's own line prices and capped
  -- at what is still refundable, so it cannot be inflated. What a direct call
  -- could do until now is issue a refund above the shop's cap with nobody
  -- signing it off, because returnService.ts:246 is the only place that checked.
  if public.approval_required_for('refund', v_refund_total) then
    if coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    v_approval_id := public.approval_assert_satisfied(
      'refund', v_refund_total, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 0016 (b): `::text` binds tighter than `-`, so `next_value::text - 1` was
  -- parsed as `text - integer` and raised on every return and every refund.
  update public.return_counters set next_value = next_value + 1 where id = 1
    returning 'RET-' || lpad((next_value - 1)::text, 6, '0') into v_return_number;
  update public.refund_counters set next_value = next_value + 1 where id = 1
    returning 'REF-' || lpad((next_value - 1)::text, 6, '0') into v_refund_number;

  insert into public.sales_returns (
    return_number, sale_id, sale_number, customer_id, customer_name,
    reason, refund_amount, refund_method, refund_status, user_id, user_name
  ) values (
    v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    v_reason, v_refund_total, v_refund_method::public.refund_method,
    v_refund_status::public.refund_status, v_user_id, v_user_name
  ) returning id into v_return_id;

  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;

    insert into public.return_items (
      return_id, sale_item_id, product_id, name_ar, name_en, sku, barcode,
      unit_price, quantity, line_total
    ) values (
      v_return_id, v_sale_item.id, v_sale_item.product_id, v_sale_item.name_ar,
      v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
      v_sale_item.unit_price, v_qty,
      round((v_sale_item.unit_price * v_qty)::numeric, 2)
    );

    select * into v_product from public.products where id = v_sale_item.product_id for update;
    if found then
      v_before := v_product.stock_quantity;
      update public.products
         set stock_quantity = stock_quantity + v_qty, updated_at = now()
       where id = v_product.id;

      insert into public.stock_movements (
        product_id, delta, quantity_before, quantity_after,
        type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_qty, v_before, v_before + v_qty,
        'adjustment_in', 'customer_return',
        'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
        v_user_id, v_user_name
      );
    end if;
  end loop;

  -- 0016 (c): a refund paid over the counter is settled now, by the person
  -- recording it; a pending one waits for approval and stays unstamped.
  insert into public.refund_records (
    refund_number, sale_id, sale_number, return_id, amount,
    payment_method, status, reason, user_id, user_name,
    settled_at, settled_by, settled_by_name
  ) values (
    v_refund_number, v_sale.id, v_sale.sale_number, v_return_id, v_refund_total,
    v_refund_method::public.refund_method,
    v_refund_status::public.refund_status,
    v_reason, v_user_id, v_user_name,
    case when v_refund_status = 'completed' then now() else null end,
    case when v_refund_status = 'completed' then v_user_id else null end,
    case when v_refund_status = 'completed' then v_user_name else null end
  ) returning id into v_refund_id;

  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_refund_id::text);
  end if;

  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id);
end;
$$;
-- ── 5. expenses: the amount is checked where the row is written ─────────────

create or replace function public.enforce_expense_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := auth.uid()::text;
  v_role public.app_role := public.current_user_role();
  v_approval uuid;
begin
  if tg_op = 'INSERT' then
    if not public.can('add_expense') then
      raise exception 'Your role cannot record an expense' using errcode = 'insufficient_privilege';
    end if;
    -- Attribute to the authenticated caller, whatever the client sent.
    if v_uid is not null then
      new.user_id := v_uid;
      if v_role is not null then
        new.user_name := (select p.name from public.profiles p where p.id = auth.uid());
      end if;
    end if;
  else
    if not public.can('edit_expense') then
      raise exception 'Your role cannot edit an expense' using errcode = 'insufficient_privilege';
    end if;
    -- Attribution is immutable: editing must not re-attribute the record.
    new.user_id    := old.user_id;
    new.user_name  := old.user_name;
    new.created_at := old.created_at;
  end if;

  -- ── approval limits (Phase 24) ────────────────────────────────────────────
  -- Filing an expense above the cap used to be refused only by
  -- expenseService.ts:65, so a direct INSERT of any size was accepted as long as
  -- the caller held add_expense. Raising an existing expense over the cap is the
  -- same act as filing it over the cap, so an increase is gated too; an edit that
  -- does not raise the amount is not, or fixing a note on last month's large
  -- expense would demand fresh paperwork.
  --
  -- A trigger has no channel for a request id, so this looks the approval up:
  -- the caller's own, approved, unspent, and for at least this amount. The
  -- createExpense(input, approval) funnel in the service still runs first and
  -- still produces the good error message; mark_approval_applied() below spends
  -- the request, and the service's own markRequestApplied() then finds it
  -- already spent, which it treats as success.
  if (tg_op = 'INSERT' or new.amount > old.amount)
     and public.approval_required_for('expense', new.amount) then
    v_approval := public.approval_assert_satisfied(
      'expense', new.amount, null, '{}'::jsonb
    );
    perform public.mark_approval_applied(v_approval, new.id::text);
  end if;

  if new.shift_id is not null then
    if not exists (select 1 from public.shifts s where s.id = new.shift_id) then
      raise exception 'Shift % not found', new.shift_id using errcode = 'foreign_key_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ── 6. price changes: how far a price may move ──────────────────────────────

create or replace function public.enforce_price_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approval uuid;
  v_match    jsonb := '{}'::jsonb;
begin
  -- Only a browser session is subject to this. `public.can()` denies a missing
  -- profile, which is the right answer for an authenticated caller and the
  -- wrong one for a migration, the development seed, psql or the service-role
  -- edge function — none of which carry a staff identity, and all of which must
  -- still be able to write a price. PostgREST pins `role` per request, so
  -- "authenticated" is exactly "a signed-in user of the app".
  if coalesce(nullif(current_setting('role', true), ''), 'postgres') <> 'authenticated' then
    return new;
  end if;

  if new.selling_price is distinct from old.selling_price
     and not public.can('change_price') then
    raise exception 'Changing a selling price requires the change_price capability'
      using errcode = 'insufficient_privilege';
  end if;

  if new.cost_price is distinct from old.cost_price
     and not public.can('change_cost') then
    raise exception 'Changing a cost price requires the change_cost capability'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── approval limits (Phase 24) ────────────────────────────────────────────
  -- Reached only for a browser session, because of the early return above, and
  -- only when the shop has turned the rule on — it is off by default, so an
  -- installation that has not asked for this sees no change. The capability
  -- checks above answer "may this seat move a price at all"; this answers "may
  -- it move it this far without a second signature", which catalogService.ts:188
  -- used to be the only place asking.
  if (new.selling_price is distinct from old.selling_price
      or new.cost_price is distinct from old.cost_price)
     and public.approval_required_for('price_change', new.selling_price) then
    -- Match on exactly the columns that moved, so an approval naming the new
    -- selling price cannot be spent on a cost-price move.
    if new.selling_price is distinct from old.selling_price then
      v_match := v_match || jsonb_build_object('selling_price', new.selling_price);
    end if;
    if new.cost_price is distinct from old.cost_price then
      v_match := v_match || jsonb_build_object('cost_price', new.cost_price);
    end if;
    v_approval := public.approval_assert_satisfied(
      'price_change', new.selling_price, null, v_match
    );
    perform public.mark_approval_applied(v_approval, new.id::text);
  end if;

  return new;
end
$$;

-- ── 7. submit_approval_request: asking for an approval has to work ───────────

create or replace function public.submit_approval_request(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind   public.approval_request_kind;
  v_number text;
  v_id     uuid;
  v_uid    text := auth.uid()::text;
  v_name   text;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to raise an approval request'
      using errcode = 'insufficient_privilege';
  end if;

  begin
    v_kind := (p_request ->> 'kind')::public.approval_request_kind;
  exception when others then
    raise exception 'Unknown approval request kind: %', coalesce(p_request ->> 'kind', '(none)')
      using errcode = 'check_violation';
  end;

  v_reason := btrim(coalesce(p_request ->> 'reason', ''));
  if v_reason = '' then
    raise exception 'An approval request needs a reason'
      using errcode = 'check_violation';
  end if;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  update public.approval_counters set next_value = next_value + 1 where id = 1
    -- 0035 (b): `::text` binds tighter than `-`, so `next_value::text - 1` was
    -- parsed as `text - integer` and raised before the row was ever written —
    -- the same defect 0015 fixed for the sale counter and 0016 for the return and
    -- refund counters, repeated here in 0023. Every call to this function failed,
    -- so no approval request has ever been raised against a live database; the
    -- browser never noticed because demo mode numbers its own requests. Server
    -- side enforcement is worthless if asking for an approval cannot work, so the
    -- one-character fix travels with this migration.
    returning 'APR-' || lpad((next_value - 1)::text, 6, '0') into v_number;

  insert into public.approval_requests (
    request_number, kind, entity_type, entity_id, entity_label, branch,
    amount, limit_value, previous_value, new_value, payload, reason,
    requested_by, requested_by_name
  ) values (
    v_number,
    v_kind,
    coalesce(nullif(btrim(p_request ->> 'entity_type'), ''), v_kind::text),
    coalesce(p_request ->> 'entity_id', ''),
    coalesce(nullif(btrim(p_request ->> 'entity_label'), ''), v_number),
    nullif(btrim(p_request ->> 'branch'), ''),
    coalesce((p_request ->> 'amount')::numeric, 0),
    (p_request ->> 'limit_value')::numeric,
    coalesce(p_request -> 'previous_value', '{}'::jsonb),
    coalesce(p_request -> 'new_value', '{}'::jsonb),
    coalesce(p_request -> 'payload', '{}'::jsonb),
    v_reason,
    v_uid,
    coalesce(nullif(btrim(p_request ->> 'requested_by_name'), ''), v_name, 'Staff')
  )
  returning id into v_id;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'approval.requested',
    'approval_request',
    v_id::text,
    v_number,
    jsonb_build_object(
      'kind',   v_kind::text,
      'amount', coalesce((p_request ->> 'amount')::numeric, 0),
      'limit',  (p_request ->> 'limit_value')::numeric,
      'entity', coalesce(p_request ->> 'entity_label', ''),
      'reason', v_reason
    ),
    v_uid,
    coalesce(v_name, 'Staff')
  );

  return jsonb_build_object('request_id', v_id, 'request_number', v_number, 'status', 'pending');
end;
$$;

-- ── 8. mark_approval_applied: who is allowed to hold the pen ────────────────
-- Lifted verbatim from 0023_approval_limits.sql with the caller check above inserted.

create or replace function public.mark_approval_applied(
  p_request_id uuid,
  p_entity_id  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests;
  v_name    text;
begin
  select * into v_request from public.approval_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'Approval request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- ── 0035 (c) · the caller must have a claim on the decision ───────────────
  -- This function is SECURITY DEFINER, so it reads past row level security. It
  -- checked that the request was approved and unspent, but never asked who was
  -- holding the pen, so any signed-in seat that knew a request's id could mark
  -- it applied to an entity of their own choosing: the act the decision was for
  -- could then never use it, and the link between the decision and what it
  -- produced would record something that never happened. Proven against this
  -- schema before the fix — a cashier spent a manager's approved, unspent
  -- request on 'burned-by-somebody-else'.
  --
  -- The requester may record what their own approval produced, and somebody
  -- holding approve_limit_request may record it on their behalf, which is the
  -- same authority that decided it in the first place.
  if v_request.requested_by <> coalesce(auth.uid()::text, '')
     and not public.can('approve_limit_request') then
    raise exception 'An approval may only be applied by the person who asked for it'
      using errcode = 'insufficient_privilege';
  end if;
  if v_request.status <> 'approved' then
    raise exception 'Only an approved request can be applied (this one is %)', v_request.status
      using errcode = 'check_violation';
  end if;
  if v_request.result_entity_id is not null then
    return jsonb_build_object(
      'request_id', v_request.id,
      'result_entity_id', v_request.result_entity_id,
      'already_applied', true
    );
  end if;
  if nullif(btrim(coalesce(p_entity_id, '')), '') is null then
    raise exception 'Applying a request needs the record it produced'
      using errcode = 'check_violation';
  end if;

  update public.approval_requests
     set result_entity_id = btrim(p_entity_id),
         entity_id        = case when btrim(entity_id) = '' then btrim(p_entity_id) else entity_id end
   where id = p_request_id and result_entity_id is null;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'approval.applied',
    'approval_request',
    p_request_id::text,
    v_request.request_number,
    jsonb_build_object(
      'kind',        v_request.kind::text,
      'amount',      v_request.amount,
      'result',      btrim(p_entity_id),
      'decided_by',  v_request.decided_by_name
    ),
    coalesce(auth.uid()::text, v_request.requested_by),
    coalesce(v_name, v_request.requested_by_name)
  );

  return jsonb_build_object(
    'request_id', v_request.id, 'result_entity_id', btrim(p_entity_id), 'already_applied', false
  );
end;
$$;

-- ── grants ─────────────────────────────────────────────────────────────────
-- Re-stated because the DROP above took the old ones with it. Same role, same
-- reach as 0018: a browser may complete a sale, nothing else may.

grant execute on function public.pos_complete_sale(jsonb, uuid) to authenticated;
revoke execute on function public.pos_complete_sale(jsonb, uuid) from anon;

comment on function public.pos_complete_sale(jsonb, uuid) is
  'Completes a sale in one transaction: validates stock, re-prices every line '
  'from the catalogue, allocates a sale number, inserts the sale, its items and '
  'its payments, and writes the stock movements. Requires can(sell) or '
  'can(manage_online_orders), and — since 0035 — an approved request behind any '
  'discount above the shop limit, passed as p_approval_request_id or found '
  'among the caller''s own approved requests.';

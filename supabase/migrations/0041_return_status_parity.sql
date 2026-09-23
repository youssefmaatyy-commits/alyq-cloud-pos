-- ═══════════════════════════════════════════════════════════════════════════
-- 0041 · rejected returns stop holding the goods
--
-- THE DISAGREEMENT
--   Two sides of one return each kept their own ledger:
--     · the money side (0016/0035): a REJECTED refund never moved money, so it
--       does not consume the sale's refundable balance — explicit, with a
--       comment;
--     · the goods side: the return's quantities WERE counted as returned, by
--       `pos_process_return`'s unfiltered `v_already_returned` and by the
--       client's `getRemainingReturnableQuantities` (same unfiltered sum).
--   And while the demo repository mirrored the return's refund_status on
--   settlement, the live `pos_settle_refund` did not — so on a live project
--   a rejected return's row stayed `pending` forever and no status-aware fix
--   could even see the rejection.
--
--   The result (reproduced): a full return whose refund is rejected shows the
--   invoice as fully returned, keeps the shop's money, and permanently blocks
--   any further return — while client and database disagree on how much is
--   still refundable (0 vs the full total).
--
-- THE RULE (client and database, same words)
--   Only a return whose refund is NOT rejected holds returned quantity.
--   Pending and completed both hold it — in both states the goods physically
--   came back (the restoration happens at return time, and stays until the
--   return is cancelled). A rejection cancels the return:
--     1. `sales_returns.refund_status` mirrors the refund ('rejected');
--     2. the stock restoration is reversed unit for unit (adjustment_out,
--        reason customer_return, floored at zero like every out-movement);
--     3. the quantity is released for a future, genuine return — which then
--        restores stock exactly once, for the goods that actually came back
--        that time.
--
--   `pos_process_return` therefore sums `v_already_returned` with
--   `refund_status <> 'rejected'`; `pos_settle_refund` gains the mirror and
--   the reversal. Both bodies otherwise lifted verbatim (0035 / 0016).
--   Grants re-asserted, unchanged.
--
-- Idempotent: CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════

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

    -- 0041: a REJECTED return is cancelled — its goods are written back out
    -- when the refund is rejected (see pos_settle_refund), so it must not
    -- hold the quantity. Pending and completed both count: the goods are on
    -- the shelf either way, and double-returning would restore them twice.
    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id
       and ri.sale_item_id = v_sale_item.id
       and r.refund_status <> 'rejected';

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

create or replace function public.pos_settle_refund(
  p_refund_id uuid,
  p_user_id   text,
  p_user_name text,
  p_decision  text default 'completed',
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.refund_records%rowtype;
  v_actor  text := coalesce(auth.uid()::text, p_user_id);
  v_name   text := p_user_name;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_return_number  text;
  v_ri             public.return_items%rowtype;
  v_product        public.products%rowtype;
  v_before         integer;
  v_after          integer;
  v_reversed_units integer := 0;
begin
  if p_decision not in ('completed', 'rejected') then
    raise exception 'A refund may only be settled or rejected, not %', p_decision
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'A rejected refund needs a reason'
      using errcode = 'check_violation';
  end if;
  if not public.can('approve_refund') then
    raise exception 'Your role cannot settle a refund'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_refund from public.refund_records where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent in the same direction, refused in the other.
  if v_refund.status <> 'pending' then
    if v_refund.status = p_decision::public.refund_status then
      return jsonb_build_object(
        'refund_id', p_refund_id, 'status', v_refund.status, 'already_settled', true
      );
    end if;
    raise exception 'This refund was already settled as %', v_refund.status
      using errcode = 'check_violation';
  end if;

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    v_name := coalesce(v_name, p_user_name);
  end if;

  update public.refund_records
     set status           = p_decision::public.refund_status,
         settled_at       = now(),
         settled_by       = v_actor,
         settled_by_name  = v_name,
         rejection_reason = case when p_decision = 'rejected' then v_reason else null end
   where id = p_refund_id and status = 'pending';

  -- The linked return follows the money (Phase 27, parity with the demo
  -- repository, which already mirrored this in its settleRefund): a rejected
  -- return is a cancelled return, and a completed one is settled.
  if v_refund.return_id is not null then
    update public.sales_returns
       set refund_status = p_decision::public.refund_status
     where id = v_refund.return_id
       and refund_status = 'pending';
  end if;

  -- A rejection writes the goods back out: the return's stock restoration is
  -- reversed unit for unit, so the shelf returns to what it was before the
  -- customer brought the item in. This is what makes the released quantity
  -- (0041's v_already_returned) honest — and it is what keeps a re-accepted
  -- return from restoring the same units a second time.
  --
  -- `greatest(0, …)` mirrors the negative-stock guard and the movement
  -- consistency constraint: if stock moved since the return (a manual
  -- recount down to zero), the reversal floors at zero rather than failing
  -- the settlement.
  if p_decision = 'rejected' and v_refund.return_id is not null then
    select return_number into v_return_number
      from public.sales_returns where id = v_refund.return_id;

    for v_ri in select * from public.return_items
                where return_id = v_refund.return_id
    loop
      select * into v_product from public.products
        where id = v_ri.product_id for update;
      if found then
        v_before := v_product.stock_quantity;
        v_after  := greatest(0, v_before - v_ri.quantity);
        update public.products
           set stock_quantity = v_after, updated_at = now()
         where id = v_ri.product_id;
        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after, type, reason, notes,
          user_id, user_name
        ) values (
          v_ri.product_id, v_ri.quantity, v_before, v_after,
          'adjustment_out', 'customer_return',
          'Reversed: refund ' || v_refund.refund_number || ' rejected (Return '
            || coalesce(v_return_number, '?') || ')',
          coalesce(v_actor, v_refund.user_id),
          coalesce(v_name, v_refund.user_name)
        );
        v_reversed_units := v_reversed_units + v_ri.quantity;
      end if;
    end loop;
  end if;

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    case when p_decision = 'rejected' then 'refund.rejected' else 'refund.settled' end,
    'refund',
    p_refund_id::text,
    v_refund.refund_number,
    jsonb_build_object(
      'amount',   v_refund.amount,
      'method',   v_refund.payment_method::text,
      'sale',     v_refund.sale_number,
      'decision', p_decision,
      'reason',   v_reason,
      'reversed_units', v_reversed_units
    ),
    coalesce(v_actor, v_refund.user_id),
    coalesce(v_name, v_refund.user_name)
  );

  return jsonb_build_object(
    'refund_id', p_refund_id, 'status', p_decision, 'already_settled', false,
    'reversed_units', v_reversed_units
  );
end;
$$;
grant execute on function public.pos_process_return(jsonb) to authenticated;
grant execute on function public.pos_settle_refund(uuid, text, text, text, text) to authenticated;


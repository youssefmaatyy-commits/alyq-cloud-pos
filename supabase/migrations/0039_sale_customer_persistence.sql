-- ═══════════════════════════════════════════════════════════════════════════
-- 0039 · pos_complete_sale: persist the customer the till actually chose
--
-- THE BUG
--   `sales` has carried `customer_id` / `customer_name` / `customer_phone`
--   since 0010, and the client has sent all three in the payload since 0018 —
--   but no version of this function ever read them. The INSERT below the
--   (previously) final `v_source` column simply did not contain them, so:
--
--     · every LIVE-mode sale persisted its customer as NULL: invoice, history
--       and reports all read back a walk-in, no matter who was selected;
--     · a forged or stale `customer_id` could not even be stored — the
--       payload key was dead on arrival;
--     · demo mode writes the fields through its own repository, so the whole
--       suite passed over the gap (same shape as 0034's unit_price bug).
--
-- THE FIX
--   Three lines of INSERT and a small resolution block:
--     · the id must be well-formed AND present in `customers`; anything else
--       becomes NULL (a real sale with an unprovable link, not a failed sale
--       and not a dangling foreign key);
--     · a valid id takes name/phone from the customer book — the book is the
--       source of truth, the till's dropdown is a view of it;
--     · a walk-in (no id) keeps the payload name/phone, blanks become NULL.
--
--   Nothing else changes: authorization, idempotency, pricing, discounts,
--   approvals, payments, stock — all lifted verbatim from 0035. The `sales`
--   table already has the columns and the FK (`on delete set null`), so a
--   deleted customer leaves historical sales with their snapshot, as 0010
--   designed. Grants are re-asserted for the same signature (0035's), so a
--   project that re-runs this file cannot drift.
--
-- Idempotent: CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_customer_id    uuid;
  v_customer_name  text;
  v_customer_phone text;

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

  -- ── customer linkage (Phase 27) ─────────────────────────────────────────
  -- The till selects a customer (or a walk-in) and snapshots name/phone for
  -- the receipt. Until this existed the payload was read by no version of the
  -- function — every live sale lost its customer and read back as a guest,
  -- while demo mode (its own repository) kept it, so the drift was invisible
  -- in the suite. The rules here:
  --   · a well-formed id that is not in `customers` is dropped to NULL rather
  --     than failing the sale — the sale is real, the link is not;
  --   · a valid id takes the customer's current name/phone from the book
  --     (authoritative), a walk-in keeps the payload snapshot, blank → NULL.
  v_customer_id := case
    when coalesce(btrim(p_payload ->> 'customer_id'), '') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (p_payload ->> 'customer_id')::uuid
    else null
  end;
  if v_customer_id is not null
     and not exists (select 1 from public.customers where id = v_customer_id) then
    v_customer_id := null;
  end if;
  v_customer_name  := nullif(btrim(coalesce(p_payload ->> 'customer_name', '')), '');
  v_customer_phone := nullif(btrim(coalesce(p_payload ->> 'customer_phone', '')), '');
  if v_customer_id is not null then
    select c.name, c.phone into v_customer_name, v_customer_phone
      from public.customers c where c.id = v_customer_id;
  end if;

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source, customer_id, customer_name, customer_phone
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
    v_source,
    v_customer_id, v_customer_name, v_customer_phone
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
grant execute on function public.pos_complete_sale(jsonb, uuid) to authenticated;
revoke execute on function public.pos_complete_sale(jsonb, uuid) from anon;


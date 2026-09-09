-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0009
-- Phase 6 — Split payments (one sale, multiple payment methods).
--
--   * `sale_payments` — one row per payment (method, amount, status).
--   * `pos_complete_sale` is replaced with a payment-aware version that
--     validates the payments sum exactly to the sale total and inserts the
--     payment rows atomically with the sale + stock deduction.
--   * `pos_confirm_payment` is replaced to mark the pending InstaPay payments
--     paid and recompute the sale status.
--   * Existing sales are backfilled with a single payment derived from their
--     legacy columns.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── sale_payments ─────────────────────────────────────────────────────────
create table if not exists public.sale_payments (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references public.sales (id) on delete cascade,
  method       public.payment_method   not null,
  amount       numeric(14, 2)          not null check (amount > 0),
  status       public.payment_status   not null default 'paid',
  paid_at      timestamptz,
  paid_by      text,
  paid_by_name text,
  created_at   timestamptz             not null default now()
);

comment on table public.sale_payments is 'One row per payment applied to a sale (split payment). Sum of `amount` equals the sale total.';

create index if not exists sale_payments_sale_idx on public.sale_payments (sale_id, created_at);

alter table public.sale_payments enable row level security;

drop policy if exists "sale_payments_select_authenticated" on public.sale_payments;
create policy "sale_payments_select_authenticated"
  on public.sale_payments for select to authenticated using (true);

drop policy if exists "sale_payments_no_direct_write" on public.sale_payments;
create policy "sale_payments_no_direct_write"
  on public.sale_payments for insert to authenticated using (false);

-- ── backfill existing sales (single payment from legacy columns) ──────────
insert into public.sale_payments (sale_id, method, amount, status, paid_at, paid_by, paid_by_name)
select s.id,
       s.payment_method,
       case when s.payment_method = 'cash' and s.amount_received is not null
            then s.total else s.total end,
       case when s.payment_status = 'paid' then 'paid'::public.payment_status else 'pending'::public.payment_status end,
       case when s.payment_status = 'paid' then coalesce(s.paid_at, s.created_at) else null end,
       case when s.payment_status = 'paid' then coalesce(s.paid_by, s.user_id) else null end,
       case when s.payment_status = 'paid' then coalesce(s.paid_by_name, s.user_name) else null end
  from public.sales s
 where not exists (select 1 from public.sale_payments p where p.sale_id = s.id);

-- ── complete sale (payment-aware, transactional) ───────────────────────────
create or replace function public.pos_complete_sale(p_payload jsonb)
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

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;

  v_subtotal        numeric(14,2) := 0;
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
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
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

  -- 4. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    if v_pay_method not in ('cash','instapay') or v_pay_amount <= 0 then
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
      v_pay_status := case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end;
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
    returning 'INV-' || lpad(next_value::text - 1, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end
  ) returning id into v_sale_id;

  -- 6. payment rows + sale items + stock + movements
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    if v_pay_method = 'instapay' then
      v_pay_status := case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end;
    else
      v_pay_status := 'paid';
    end if;
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
    values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other', 'Sale ' || v_sale_number, v_user_id, v_user_name);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

grant execute on function public.pos_complete_sale(jsonb) to authenticated;

-- ── confirm payment (payment-aware, transactional) ─────────────────────────
create or replace function public.pos_confirm_payment(
  p_sale_id   uuid,
  p_user_id   text,
  p_user_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_pending integer;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Cannot confirm a voided sale' using errcode = 'check_violation';
  end if;

  select count(*) into v_pending from public.sale_payments
   where sale_id = p_sale_id and method = 'instapay' and status = 'pending';

  if v_pending = 0 then
    return jsonb_build_object('sale_id', p_sale_id, 'already_paid', true);
  end if;

  update public.sale_payments
     set status = 'paid', paid_at = now(), paid_by = p_user_id, paid_by_name = p_user_name
   where sale_id = p_sale_id and method = 'instapay' and status = 'pending';

  -- all pending instapay payments are now paid → sale completes.
  update public.sales
     set status = 'completed', payment_status = 'paid',
         paid_at = now(), paid_by = p_user_id, paid_by_name = p_user_name
   where id = p_sale_id;

  return jsonb_build_object('sale_id', p_sale_id, 'already_paid', false);
end;
$$;

grant execute on function public.pos_confirm_payment(uuid, text, text) to authenticated;

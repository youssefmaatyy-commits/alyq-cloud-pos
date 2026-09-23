-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0007
-- Phase 4 — POS + Sales: sales ledger, sale items, sale numbering and the
-- transactional `pos_complete_sale` / `pos_void_sale` RPCs.
--
-- Design:
--   * `sales`        — one row per transaction (financial record)
--   * `sale_items`   — snapshot lines (name/sku/barcode/price frozen at sale time)
--   * stock movement — reuses the Phase 3 `stock_movements` table (type 'issue',
--                      reason 'sale') so the inventory audit trail stays unified
--   * `pos_complete_sale(jsonb)` — ALL of: validate stock, recalculate totals
--     from catalog prices, allocate a sale number, insert sale + items, deduct
--     stock and write the movements. All-or-nothing. The client never trusts
--     its own totals.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── enums ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_status') then
    create type public.sale_status as enum ('completed', 'pending', 'voided');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type public.payment_method as enum ('cash', 'instapay');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum ('paid', 'pending');
  end if;
  if not exists (select 1 from pg_type where typname = 'discount_type') then
    create type public.discount_type as enum ('none', 'percent', 'fixed');
  end if;
end
$$;

-- ── sales ─────────────────────────────────────────────────────────────────
create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  sale_number     text not null unique,
  client_ref      text not null unique,           -- idempotency key
  status          public.sale_status not null default 'completed',
  payment_method  public.payment_method not null,
  payment_status  public.payment_status not null default 'paid',
  subtotal        numeric(14, 2) not null check (subtotal >= 0),
  discount_type   public.discount_type not null default 'none',
  discount_value  numeric(14, 2) not null default 0 check (discount_value >= 0),
  discount_amount numeric(14, 2) not null default 0 check (discount_amount >= 0),
  total           numeric(14, 2) not null check (total >= 0),
  amount_received numeric(14, 2),
  change          numeric(14, 2),
  user_id         text not null,
  user_name       text not null,
  voided_at       timestamptz,
  void_reason     text,
  created_at      timestamptz not null default now(),

  constraint sales_cash_received_covers_total
    check (payment_method = 'instapay' or (amount_received is not null and amount_received >= total)),
  constraint sales_discount_le_subtotal
    check (discount_amount <= subtotal),
  constraint sales_total_matches
    check (total = subtotal - discount_amount)
);

comment on table public.sales is 'Financial record of a POS transaction. Immutable except for voiding.';

create index if not exists sales_created_idx on public.sales (created_at desc);
create index if not exists sales_status_idx  on public.sales (status, created_at desc);
create index if not exists sales_user_idx    on public.sales (user_id, created_at desc);

-- ── sale_items (snapshot lines) ───────────────────────────────────────────
create table if not exists public.sale_items (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete restrict,
  name_ar     text not null,
  name_en     text not null,
  sku         text not null,
  barcode     text,
  unit_price  numeric(14, 2) not null check (unit_price >= 0),
  quantity    integer not null check (quantity > 0),
  line_total  numeric(14, 2) not null check (line_total >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists sale_items_sale_idx    on public.sale_items (sale_id);
create index if not exists sale_items_product_idx on public.sale_items (product_id);

-- ── sale numbering ────────────────────────────────────────────────────────
create table if not exists public.sale_counters (
  id         smallint primary key default 1 check (id = 1),
  next_value bigint not null default 1
);
insert into public.sale_counters (id, next_value) values (1, 1) on conflict do nothing;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;

drop policy if exists "sales_select_authenticated" on public.sales;
create policy "sales_select_authenticated"
  on public.sales for select to authenticated using (true);

-- Writes go through the RPC below (SECURITY DEFINER), so direct table writes
-- are denied to ordinary roles.
drop policy if exists "sales_no_direct_write" on public.sales;
create policy "sales_no_direct_write"
  on public.sales for insert to authenticated with check (false);

drop policy if exists "sale_items_select_authenticated" on public.sale_items;
create policy "sale_items_select_authenticated"
  on public.sale_items for select to authenticated using (true);

drop policy if exists "sale_items_no_direct_write" on public.sale_items;
create policy "sale_items_no_direct_write"
  on public.sale_items for insert to authenticated with check (false);

-- ── complete sale (transactional) ─────────────────────────────────────────
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
  v_payment_method  text := p_payload->>'payment_method';
  v_payment_status  text := coalesce(p_payload->>'payment_status', 'paid');
  v_amount_received numeric(14,2) := nullif(p_payload->>'amount_received', '')::numeric;
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

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
begin
  -- 1. idempotency: a retried submit with the same key returns the existing sale
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_discount_type not in ('none', 'percent', 'fixed') then
    raise exception 'Invalid discount type' using errcode = 'check_violation';
  end if;
  if v_discount_value < 0 then
    raise exception 'Negative discount' using errcode = 'check_violation';
  end if;
  if v_discount_type = 'percent' and v_discount_value > 100 then
    -- `%%` not `%`: RAISE treats a lone % as a format placeholder, and the
    -- original single % made the whole function fail to compile.
    raise exception 'Discount above 100%%' using errcode = 'check_violation';
  end if;
  if v_payment_method not in ('cash', 'instapay') then
    raise exception 'Invalid payment method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;

  -- 2. lock + validate every line against CURRENT catalog state
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_product
      from public.products
      where id = (v_line->>'product_id')::uuid
      for update;  -- row lock: prevents concurrent oversell
    if not found then
      raise exception 'Product % not found', v_line->>'product_id'
        using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Product % is not sellable', v_product.sku
        using errcode = 'check_violation';
    end if;
    if v_qty > v_product.stock_quantity then
      raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku
        using errcode = 'check_violation';
    end if;

    v_unit := v_product.selling_price;
    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);
  end loop;

  -- 3. authoritative totals — never taken from the client
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_subtotal * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- 4. payment validation
  if v_payment_method = 'cash' then
    if v_amount_received is null or v_amount_received < v_total then
      raise exception 'Insufficient cash' using errcode = 'check_violation';
    end if;
  else
    if v_payment_status not in ('paid', 'pending') then
      raise exception 'Invalid InstaPay status' using errcode = 'check_violation';
    end if;
  end if;

  v_sale_status := case
    when v_payment_method = 'instapay' and v_payment_status = 'pending' then 'pending'
    else 'completed'
  end;

  -- 5. sale number (allocated atomically)
  update public.sale_counters
    set next_value = next_value + 1
    where id = 1
    returning 'INV-' || lpad(next_value::text - 1, 6, '0')
    into v_sale_number;

  -- 6. write the sale
  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    v_payment_method::public.payment_method, v_payment_status::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_payment_method = 'cash' then v_amount_received else null end,
    case when v_payment_method = 'cash' then round((v_amount_received - v_total)::numeric, 2) else null end,
    v_user_id, v_user_name
  ) returning id into v_sale_id;

  -- 7. write snapshot lines + deduct stock + movements (same transaction)
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;

    select * into v_product
      from public.products
      where id = (v_line->>'product_id')::uuid
      for update;

    insert into public.sale_items (
      sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total
    ) values (
      v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
      v_product.barcode, v_product.selling_price, v_qty,
      round((v_product.selling_price * v_qty)::numeric, 2)
    );

    v_before := v_product.stock_quantity;
    update public.products
      set stock_quantity = stock_quantity - v_qty,
          updated_at = now()
      where id = v_product.id;

    insert into public.stock_movements (
      product_id, delta, quantity_before, quantity_after,
      type, reason, notes, user_id, user_name
    ) values (
      v_product.id, v_qty, v_before, v_before - v_qty,
      'issue', 'other', 'Sale ' || v_sale_number, v_user_id, v_user_name
    );
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

grant execute on function public.pos_complete_sale(jsonb) to authenticated;

-- ── void sale (reverses stock in the same transaction) ────────────────────
create or replace function public.pos_void_sale(
  p_sale_id   uuid,
  p_user_id   text,
  p_user_name text,
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale    public.sales%rowtype;
  v_item    public.sale_items%rowtype;
  v_product public.products%rowtype;
  v_before  integer;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    return jsonb_build_object('sale_id', p_sale_id);
  end if;

  update public.sales
    set status = 'voided', voided_at = now(), void_reason = p_reason
    where id = p_sale_id;

  for v_item in select * from public.sale_items where sale_id = p_sale_id
  loop
    select * into v_product
      from public.products
      where id = v_item.product_id
      for update;
    if found then
      v_before := v_product.stock_quantity;
      update public.products
        set stock_quantity = stock_quantity + v_item.quantity,
            updated_at = now()
        where id = v_product.id;

      insert into public.stock_movements (
        product_id, delta, quantity_before, quantity_after,
        type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_item.quantity, v_before, v_before + v_item.quantity,
        'adjustment_in', 'other',
        'Void of ' || v_sale.sale_number || coalesce(': ' || p_reason, ''),
        p_user_id, p_user_name
      );
    end if;
  end loop;

  return jsonb_build_object('sale_id', p_sale_id);
end;
$$;

grant execute on function public.pos_void_sale(uuid, text, text, text) to authenticated;

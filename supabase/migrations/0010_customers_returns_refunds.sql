-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0010
-- Phase 7 — Customers + Returns + Refunds.
--
--   * `customers` — customer database (name, phone unique, address, notes).
--   * `sales` gains optional customer linkage columns (existing rows keep NULL).
--   * `sales_returns` + `return_items` — immutable return records snapshotting
--     the original product data at return time.
--   * `refund_records` — one row per refund, linked to sale + return.
--   * `pos_process_return` — transactional RPC: validates remaining
--     returnable quantities and remaining refundable amount, inserts the
--     return + items + refund, restores stock and writes `customer_return`
--     stock movements. Never modifies the original sale.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── customers ─────────────────────────────────────────────────────────────
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (char_length(btrim(name)) between 1 and 100),
  phone      text        not null check (char_length(btrim(phone)) between 1 and 30),
  address    text        check (char_length(coalesce(address, '')) <= 300),
  notes      text        check (char_length(coalesce(notes, '')) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customers is 'Customer database (Phase 7). Linked to sales by id; historical sales keep a name/phone snapshot.';

create unique index if not exists customers_phone_unique
  on public.customers (btrim(phone));
create index if not exists customers_name_idx on public.customers (lower(name));
create index if not exists customers_created_idx on public.customers (created_at desc);

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ── sales customer linkage (optional, existing rows untouched) ────────────
alter table public.sales
  add column if not exists customer_id    uuid,
  add column if not exists customer_name  text,
  add column if not exists customer_phone text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.sales'::regclass and conname = 'sales_customer_fk'
  ) then
    alter table public.sales
      add constraint sales_customer_fk
      foreign key (customer_id) references public.customers (id) on delete set null;
  end if;
end
$$;

create index if not exists sales_customer_idx on public.sales (customer_id, created_at desc);

-- ── refund method enum (cash / visa / instapay) ───────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'refund_method') then
    create type public.refund_method as enum ('cash', 'visa', 'instapay');
  end if;
end
$$;

-- ── refund status enum (pending / completed / rejected) ───────────────────
-- Corrected 2026-09: this migration originally typed `refund_status` and
-- `refund_records.status` as `public.payment_status`, which only holds
-- ('paid','pending') — so `default 'completed'` failed the moment the table was
-- created, and the RPC's `'completed'::public.payment_status` cast would have
-- failed at runtime. A refund lifecycle is not the same thing as whether a sale
-- has been paid, so refunds get their own enum. `rejected` is reserved for a
-- refund that was requested, refused and therefore never paid out.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'refund_status') then
    create type public.refund_status as enum ('pending', 'completed', 'rejected');
  end if;
end
$$;

-- ── sales_returns ─────────────────────────────────────────────────────────
create table if not exists public.sales_returns (
  id            uuid primary key default gen_random_uuid(),
  return_number text not null unique,
  sale_id       uuid not null references public.sales (id) on delete restrict,
  sale_number   text not null,
  customer_id   uuid references public.customers (id) on delete set null,
  customer_name text,
  reason        text not null check (char_length(btrim(reason)) between 1 and 300),
  refund_amount numeric(14, 2) not null check (refund_amount >= 0),
  refund_method public.refund_method not null,
  refund_status public.refund_status  not null default 'completed',
  user_id       text not null,
  user_name     text not null,
  created_at    timestamptz not null default now()
);

comment on table public.sales_returns is 'Immutable sales return records. The original sale is never modified.';

create index if not exists sales_returns_sale_idx     on public.sales_returns (sale_id, created_at desc);
create index if not exists sales_returns_customer_idx on public.sales_returns (customer_id, created_at desc);
create index if not exists sales_returns_created_idx  on public.sales_returns (created_at desc);

-- ── return_items (product snapshots at return time) ───────────────────────
create table if not exists public.return_items (
  id           uuid primary key default gen_random_uuid(),
  return_id    uuid not null references public.sales_returns (id) on delete cascade,
  sale_item_id uuid not null,
  product_id   uuid not null references public.products (id) on delete restrict,
  name_ar      text not null,
  name_en      text not null,
  sku          text not null,
  barcode      text,
  unit_price   numeric(14, 2) not null check (unit_price >= 0),
  quantity     integer not null check (quantity > 0),
  line_total   numeric(14, 2) not null check (line_total >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists return_items_return_idx  on public.return_items (return_id);
create index if not exists return_items_product_idx on public.return_items (product_id);

-- ── refund_records ────────────────────────────────────────────────────────
create table if not exists public.refund_records (
  id            uuid primary key default gen_random_uuid(),
  refund_number text not null unique,
  sale_id       uuid not null references public.sales (id) on delete restrict,
  sale_number   text not null,
  return_id     uuid references public.sales_returns (id) on delete set null,
  amount        numeric(14, 2) not null check (amount > 0),
  payment_method public.refund_method not null,
  status        public.refund_status    not null default 'completed',
  reason        text,
  user_id       text not null,
  user_name     text not null,
  created_at    timestamptz not null default now()
);

comment on table public.refund_records is 'Financial refunds linked to a sale (and its return). Cumulative refunds per sale must never exceed the sale total.';

create index if not exists refund_records_sale_idx   on public.refund_records (sale_id, created_at desc);
create index if not exists refund_records_return_idx on public.refund_records (return_id);

-- ── numbering counters ────────────────────────────────────────────────────
create table if not exists public.return_counters (
  id         smallint primary key default 1 check (id = 1),
  next_value bigint not null default 1
);
insert into public.return_counters (id, next_value) values (1, 1) on conflict do nothing;

create table if not exists public.refund_counters (
  id         smallint primary key default 1 check (id = 1),
  next_value bigint not null default 1
);
insert into public.refund_counters (id, next_value) values (1, 1) on conflict do nothing;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.customers      enable row level security;
alter table public.sales_returns  enable row level security;
alter table public.return_items   enable row level security;
alter table public.refund_records enable row level security;

drop policy if exists "customers_select_authenticated" on public.customers;
create policy "customers_select_authenticated"
  on public.customers for select to authenticated using (true);
drop policy if exists "customers_write_authenticated" on public.customers;
create policy "customers_write_authenticated"
  on public.customers for insert to authenticated with check (true);
drop policy if exists "customers_update_authenticated" on public.customers;
create policy "customers_update_authenticated"
  on public.customers for update to authenticated using (true) with check (true);
drop policy if exists "customers_delete_authenticated" on public.customers;
create policy "customers_delete_authenticated"
  on public.customers for delete to authenticated using (true);

-- Returns / refunds are written through the RPC below; direct writes denied.
drop policy if exists "sales_returns_select_authenticated" on public.sales_returns;
create policy "sales_returns_select_authenticated"
  on public.sales_returns for select to authenticated using (true);
drop policy if exists "sales_returns_no_direct_write" on public.sales_returns;
create policy "sales_returns_no_direct_write"
  on public.sales_returns for insert to authenticated with check (false);

drop policy if exists "return_items_select_authenticated" on public.return_items;
create policy "return_items_select_authenticated"
  on public.return_items for select to authenticated using (true);
drop policy if exists "return_items_no_direct_write" on public.return_items;
create policy "return_items_no_direct_write"
  on public.return_items for insert to authenticated with check (false);

drop policy if exists "refund_records_select_authenticated" on public.refund_records;
create policy "refund_records_select_authenticated"
  on public.refund_records for select to authenticated using (true);
drop policy if exists "refund_records_no_direct_write" on public.refund_records;
create policy "refund_records_no_direct_write"
  on public.refund_records for insert to authenticated with check (false);

-- ── process return (transactional) ────────────────────────────────────────
-- Validates remaining returnable quantities per line and the remaining
-- refundable amount, inserts return + items + refund, restores stock and
-- writes `customer_return` movements. The original sale row is never touched.
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

  select coalesce(sum(amount), 0) into v_refunded_so_far
    from public.refund_records where sale_id = v_sale.id;

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

  update public.return_counters set next_value = next_value + 1 where id = 1
    returning 'RET-' || lpad(next_value::text - 1, 6, '0') into v_return_number;
  update public.refund_counters set next_value = next_value + 1 where id = 1
    returning 'REF-' || lpad(next_value::text - 1, 6, '0') into v_refund_number;

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

  insert into public.refund_records (
    refund_number, sale_id, sale_number, return_id, amount,
    payment_method, status, reason, user_id, user_name
  ) values (
    v_refund_number, v_sale.id, v_sale.sale_number, v_return_id, v_refund_total,
    v_refund_method::public.refund_method,
    v_refund_status::public.refund_status,
    v_reason, v_user_id, v_user_name
  ) returning id into v_refund_id;

  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id);
end;
$$;

grant execute on function public.pos_process_return(jsonb) to authenticated;

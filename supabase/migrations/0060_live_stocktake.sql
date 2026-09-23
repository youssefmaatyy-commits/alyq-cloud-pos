-- 0060 — Live stocktake. Sessions and lines are the count of record.
--
-- The browser key `alyq.inventory.stocktakes.v1` is a demo adapter. Live mode
-- must not read it, and a finalized count must not be a client loop of stock
-- writes: that can stop halfway and leave the shelf half-reconciled.
--
-- This file does not edit 0001–0059. It adds the tables, the one finalize
-- transaction, the audit words, and a restatement of the backup order so a
-- snapshot carries the count without replaying its movements.
--
-- Expected quantity is a snapshot. A later sale does not rewrite it. If the
-- shelf moved before finalize, the transaction commits an audit row and no
-- movement. Corrections are a new adjustment, never an edit of a finalized row.

-- ── 1. the session and its lines ───────────────────────────────────────────

create table if not exists public.stocktakes (
  id                uuid primary key default gen_random_uuid(),
  reference         text not null,
  status            text not null default 'counting',
  blind             boolean not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        text not null,
  created_by_name   text not null,
  finalized_at      timestamptz,
  finalized_by      text,
  finalized_by_name text,
  constraint stocktakes_reference_not_blank check (btrim(reference) <> ''),
  constraint stocktakes_reference_unique unique (reference),
  constraint stocktakes_status_shape check (status in ('draft', 'counting', 'review', 'finalized')),
  constraint stocktakes_note_length check (note is null or char_length(note) <= 500),
  constraint stocktakes_finalized_complete check (
    status <> 'finalized'
    or (finalized_at is not null and finalized_by is not null and btrim(finalized_by_name) <> '')
  )
);

comment on table public.stocktakes is
  'A physical count. Live mode reads and writes this table; the browser store is demo-only. Finalized rows are historical.';
comment on column public.stocktakes.reference is
  'Human reference (ST-YYYYMMDD-…). Stable. Not reused, not rewritten.';
comment on column public.stocktakes.status is
  'draft, counting, review, or finalized. Only stocktake_finalize may enter finalized.';

create table if not exists public.stocktake_lines (
  id                  uuid primary key default gen_random_uuid(),
  stocktake_id        uuid not null references public.stocktakes (id) on delete cascade,
  product_id          uuid not null references public.products (id) on delete cascade,
  variant_id          uuid references public.product_variants (id) on delete set null,
  -- Survives a variant-row delete during a catalogue wipe, so the line still
  -- names the combination after variant_id is cleared. Not rewritten.
  shelf_key           text not null,
  sku                 text not null,
  barcode             text,
  product_name_ar     text not null default '',
  product_name_en     text not null default '',
  variant_label       text not null default '',
  expected_quantity   integer not null,
  physical_quantity   integer,
  variance            integer,
  movement_id         uuid references public.stock_movements (id) on delete set null,
  -- Copy of the movement id. Not a foreign key, so a ledger wipe cannot erase
  -- the link the count recorded. Restore does not replay the movement.
  movement_reference  text,
  constraint stocktake_lines_shelf_not_blank check (btrim(shelf_key) <> ''),
  constraint stocktake_lines_sku_not_blank check (btrim(sku) <> ''),
  constraint stocktake_lines_expected_not_negative check (expected_quantity >= 0),
  constraint stocktake_lines_physical_not_negative check (physical_quantity is null or physical_quantity >= 0),
  constraint stocktake_lines_variance_matches check (
    (physical_quantity is null and variance is null)
    or (physical_quantity is not null and variance = physical_quantity - expected_quantity)
  )
);

comment on table public.stocktake_lines is
  'One shelf in a count: a product, or one exact variant. Gold/17 and Silver/17 are two rows. expected_quantity is the snapshot at creation and is never recalculated.';
comment on column public.stocktake_lines.expected_quantity is
  'Historical system quantity at session creation. A later sale, import, or refresh must not rewrite it.';
comment on column public.stocktake_lines.movement_reference is
  'The ledger row this line produced, kept as text so the link survives a movement delete. Null when the variance was zero.';

create unique index if not exists stocktake_lines_shelf_unique
  on public.stocktake_lines (stocktake_id, shelf_key);
create index if not exists stocktake_lines_stocktake_idx
  on public.stocktake_lines (stocktake_id);
create index if not exists stocktake_lines_product_idx
  on public.stocktake_lines (product_id);
create index if not exists stocktake_lines_variant_idx
  on public.stocktake_lines (variant_id);
create index if not exists stocktakes_status_idx
  on public.stocktakes (status, created_at desc);

-- ── 2. historical rows stay historical ─────────────────────────────────────
-- Authenticated has no write grant. These triggers are the backstop for the
-- table owner and for security-definer writers, including a catalogue wipe
-- that must still be able to delete products.

create or replace function public.stocktakes_release_product()
returns trigger
language plpgsql
as $$
begin
  -- Transaction-local. Lets the line guard allow the cascade that follows a
  -- product delete (factory reset, or a product that was allowed to leave).
  perform set_config('alyq.stocktake_releasing_product', old.id::text, true);
  return old;
end;
$$;

drop trigger if exists products_release_stocktakes on public.products;
create trigger products_release_stocktakes
  before delete on public.products
  for each row execute function public.stocktakes_release_product();

create or replace function public.stocktakes_release_variant()
returns trigger
language plpgsql
as $$
begin
  perform set_config('alyq.stocktake_releasing_variant', old.id::text, true);
  return old;
end;
$$;

drop trigger if exists product_variants_release_stocktakes on public.product_variants;
create trigger product_variants_release_stocktakes
  before delete on public.product_variants
  for each row execute function public.stocktakes_release_variant();

create or replace function public.stocktakes_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'finalized'
       and exists (select 1 from public.stocktake_lines l where l.stocktake_id = old.id) then
      raise exception 'A finalized stocktake is historical and cannot be deleted'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'finalized' then
    raise exception 'A finalized stocktake is historical and cannot be rewritten'
      using errcode = 'check_violation';
  end if;
  if new.status = 'finalized' and old.status is distinct from 'finalized'
     and current_setting('alyq.stocktake_finalizing', true) is distinct from new.id::text then
    raise exception 'Only stocktake_finalize may mark a stocktake finalized'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists stocktakes_guard on public.stocktakes;
create trigger stocktakes_guard
  before update or delete on public.stocktakes
  for each row execute function public.stocktakes_guard();

create or replace function public.stocktake_lines_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    if current_setting('alyq.stocktake_releasing_product', true) = old.product_id::text then
      return old;
    end if;
    select status into v_status from public.stocktakes where id = old.stocktake_id;
    if v_status = 'finalized' then
      raise exception 'A finalized stocktake line is historical and cannot be deleted'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- Snapshot columns never move. variant_id may become null only while the
  -- variant row is leaving (ON DELETE SET NULL). shelf_key and expected stay.
  -- movement_id may become null only when the ledger row leaves; the text
  -- reference stays.
  if new.expected_quantity is distinct from old.expected_quantity
     or new.shelf_key is distinct from old.shelf_key
     or new.product_id is distinct from old.product_id
     or new.sku is distinct from old.sku
     or new.stocktake_id is distinct from old.stocktake_id
     or (
       new.variant_id is distinct from old.variant_id
       and not (
         new.variant_id is null
         and current_setting('alyq.stocktake_releasing_variant', true) = coalesce(old.variant_id::text, '')
       )
     ) then
    raise exception 'A stocktake line snapshot cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  select status into v_status from public.stocktakes where id = old.stocktake_id;
  if v_status = 'finalized' then
    if new.physical_quantity is distinct from old.physical_quantity
       or new.variance is distinct from old.variance
       or new.movement_reference is distinct from old.movement_reference
       or new.barcode is distinct from old.barcode
       or new.product_name_ar is distinct from old.product_name_ar
       or new.product_name_en is distinct from old.product_name_en
       or new.variant_label is distinct from old.variant_label then
      raise exception 'A finalized stocktake line is historical and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
    if new.movement_id is distinct from old.movement_id
       and not (new.movement_id is null and old.movement_id is not null) then
      raise exception 'A finalized stocktake line is historical and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
    -- A catalogue wipe deletes variants before products. The line stays, with
    -- its shelf name and the quantity it counted, after the foreign key clears.
    if new.variant_id is distinct from old.variant_id
       and not (
         new.variant_id is null
         and current_setting('alyq.stocktake_releasing_variant', true) = coalesce(old.variant_id::text, '')
       ) then
      raise exception 'A finalized stocktake line is historical and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  return new;
end;
$$;

drop trigger if exists stocktake_lines_guard on public.stocktake_lines;
create trigger stocktake_lines_guard
  before update or delete on public.stocktake_lines
  for each row execute function public.stocktake_lines_guard();

create or replace function public.stocktakes_drop_empty()
returns trigger
language plpgsql
as $$
begin
  delete from public.stocktakes s
   where not exists (select 1 from public.stocktake_lines l where l.stocktake_id = s.id);
  return null;
end;
$$;

drop trigger if exists stocktake_lines_drop_empty on public.stocktake_lines;
create trigger stocktake_lines_drop_empty
  after delete on public.stocktake_lines
  for each statement execute function public.stocktakes_drop_empty();

-- ── 3. words the trail will accept ─────────────────────────────────────────

insert into public.audit_actions (action, entity) values
  ('stocktake.created', 'stocktake'),
  ('stocktake.updated', 'stocktake'),
  ('stocktake.finalized', 'stocktake'),
  ('stocktake.conflict', 'stocktake')
on conflict (action) do nothing;

-- ── 4. staff permanent delete keeps the count ──────────────────────────────
-- Factory reset deletes products directly and the cascade takes the lines.
-- The staff door does not: a counted product is archived, not erased.
-- Restated from 0037 with the stocktake check added. The reference-count
-- signature is unchanged so the app's column list still matches.

create or replace function public.delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_refs    record;
  v_actor   text := auth.uid()::text;
  v_name    text;
  v_counts  integer;
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a product requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  select * into v_refs from public.product_reference_counts(p_product_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception
      'Product % has historical transactions (sale_items %, return_items %, stock_movements %, online_order_items %, stock_reservations %) and cannot be permanently deleted; archive it instead',
      v_product.sku, v_refs.sale_items, v_refs.return_items, v_refs.stock_movements,
      v_refs.online_order_items, v_refs.stock_reservations
      using errcode = 'restrict_violation';
  end if;

  select count(*) into v_counts from public.stocktake_lines where product_id = p_product_id;
  if v_counts > 0 then
    raise exception 'Product % has stocktake history and cannot be permanently deleted; archive it instead',
      v_product.sku
      using errcode = 'restrict_violation';
  end if;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    'product.deleted',
    'product',
    v_product.id::text,
    v_product.sku,
    jsonb_build_object(
      'product', v_product.name_en,
      'sku',     v_product.sku,
      'barcode', v_product.barcode
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, v_actor, 'Unknown')
  );

  delete from public.products where id = p_product_id;

  return jsonb_build_object(
    'deleted',    true,
    'product_id', v_product.id,
    'sku',        v_product.sku
  );
end;
$$;

comment on function public.delete_product(uuid) is
  'Permanently delete a product ONLY when no business, stocktake, or history table references it. Requires delete_product. Writes product.deleted before the delete.';

create or replace function public.delete_variant(p_variant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.product_variants%rowtype;
  v_product public.products%rowtype;
  v_refs    record;
  v_siblings integer;
  v_counts integer;
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a variant requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_variant.product_id;

  if v_product.variants_enabled then
    select count(*) into v_siblings
      from public.product_variants where product_id = v_variant.product_id;
    if v_siblings <= 1 then
      raise exception 'Product % would have nothing left to sell — add another combination first', v_product.sku
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_refs from public.variant_reference_counts(p_variant_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception 'Variant % is named by % historical record(s) — archive it instead of deleting',
      v_variant.sku, v_refs.total
      using errcode = 'restrict_violation';
  end if;

  select count(*) into v_counts from public.stocktake_lines where variant_id = p_variant_id;
  if v_counts > 0 then
    raise exception 'Variant % is named by a stocktake and cannot be deleted; archive it instead',
      v_variant.sku
      using errcode = 'restrict_violation';
  end if;

  delete from public.product_variants where id = v_variant.id;

  return jsonb_build_object('variant_id', v_variant.id, 'sku', v_variant.sku, 'deleted', true);
end;
$$;

comment on function public.delete_variant(uuid) is
  'Permanently removes a combination (requires delete_product). Refused when sales, returns, or a stocktake name it. The audit row is written by the table trigger.';

-- ── 5. the count itself ────────────────────────────────────────────────────

create or replace function public.stocktake_assert_adjust()
returns table (actor_id text, actor_name text)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id   text;
  v_name text;
begin
  if auth.uid() is null or not public.can('adjust_stock') then
    raise exception 'Recording or finalizing a stocktake requires the adjust_stock capability'
      using errcode = 'insufficient_privilege';
  end if;
  v_id := auth.uid()::text;
  select name into v_name from public.profiles where id = auth.uid();
  if v_name is null or btrim(v_name) = '' then
    v_name := v_id;
  end if;
  return query select v_id, v_name;
end;
$$;

create or replace function public.stocktake_document(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.stocktakes%rowtype;
begin
  select * into v_row from public.stocktakes where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_NOT_FOUND');
  end if;
  return jsonb_build_object(
    'id', v_row.id,
    'reference', v_row.reference,
    'status', v_row.status,
    'blind', v_row.blind,
    'note', v_row.note,
    'created_at', v_row.created_at,
    'created_by', v_row.created_by,
    'created_by_name', v_row.created_by_name,
    'finalized_at', v_row.finalized_at,
    'finalized_by', v_row.finalized_by,
    'finalized_by_name', v_row.finalized_by_name,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'product_id', l.product_id,
        'variant_id', l.variant_id,
        'sku', l.sku,
        'barcode', l.barcode,
        'product_name_ar', l.product_name_ar,
        'product_name_en', l.product_name_en,
        'variant_label', l.variant_label,
        'expected_quantity', l.expected_quantity,
        'physical_quantity', l.physical_quantity,
        'variance', l.variance,
        'movement_id', l.movement_id,
        'movement_reference', l.movement_reference
      ) order by l.sku, l.variant_label, l.id)
      from public.stocktake_lines l
      where l.stocktake_id = v_row.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.stocktake_create(p_blind boolean default false, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor   text;
  v_name    text;
  v_id      uuid := gen_random_uuid();
  v_ref     text;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_lines   integer := 0;
  v_label   text;
begin
  select a.actor_id, a.actor_name into v_actor, v_name from public.stocktake_assert_adjust() a;
  if p_note is not null and char_length(btrim(p_note)) > 500 then
    raise exception 'Stocktake note is too long' using errcode = 'check_violation';
  end if;
  v_ref := 'ST-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 8));

  insert into public.stocktakes (id, reference, status, blind, note, created_by, created_by_name)
  values (
    v_id, v_ref, 'counting', coalesce(p_blind, false), nullif(btrim(p_note), ''), v_actor, v_name
  );

  for v_product in
    select * from public.products
     where active and stock_tracking_enabled
     order by sku
  loop
    if v_product.variants_enabled then
      for v_variant in
        select * from public.product_variants
         where product_id = v_product.id and active
         order by color_key, size, sku
      loop
        v_label := coalesce(
          public.variant_label(v_variant.color_en, v_variant.color_ar, v_variant.size, v_variant.size_label),
          v_variant.sku
        );
        insert into public.stocktake_lines (
          stocktake_id, product_id, variant_id, shelf_key, sku, barcode,
          product_name_ar, product_name_en, variant_label, expected_quantity
        ) values (
          v_id, v_product.id, v_variant.id, v_variant.id::text, v_variant.sku, v_variant.barcode,
          v_product.name_ar, v_product.name_en, v_label, v_variant.stock_quantity
        );
        v_lines := v_lines + 1;
      end loop;
    else
      insert into public.stocktake_lines (
        stocktake_id, product_id, variant_id, shelf_key, sku, barcode,
        product_name_ar, product_name_en, variant_label, expected_quantity
      ) values (
        v_id, v_product.id, null, v_product.id::text, v_product.sku, v_product.barcode,
        v_product.name_ar, v_product.name_en, '', v_product.stock_quantity
      );
      v_lines := v_lines + 1;
    end if;
  end loop;

  if v_lines = 0 then
    raise exception 'There is no tracked stock to count' using errcode = 'check_violation';
  end if;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'stocktake.created', 'stocktake', v_id::text, v_ref,
    jsonb_build_object('lines', v_lines, 'blind', coalesce(p_blind, false)),
    v_actor, v_name
  );

  return jsonb_build_object('ok', true, 'session', public.stocktake_document(v_id));
end;
$$;

comment on function public.stocktake_create(boolean, text) is
  'Opens a count of every active tracked shelf. Variant products become one line per active combination, never one rolled-up row. Requires adjust_stock. Snapshots expected quantity. Does not move stock.';

create or replace function public.stocktake_save_counts(
  p_stocktake_id uuid,
  p_counts jsonb,
  p_status text default null,
  p_audit boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor   text;
  v_name    text;
  v_row     public.stocktakes%rowtype;
  v_item    jsonb;
  v_line_id uuid;
  v_physical integer;
  v_line    public.stocktake_lines%rowtype;
  v_counted integer := 0;
begin
  select a.actor_id, a.actor_name into v_actor, v_name from public.stocktake_assert_adjust() a;
  select * into v_row from public.stocktakes where id = p_stocktake_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_NOT_FOUND');
  end if;
  if v_row.status = 'finalized' then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_FINALIZED');
  end if;
  if p_status is not null and p_status not in ('draft', 'counting', 'review') then
    raise exception 'A stocktake cannot be moved to that status from a count save'
      using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_counts, '[]'::jsonb)) <> 'array' then
    raise exception 'Stocktake counts must be a list' using errcode = 'check_violation';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_counts, '[]'::jsonb)) loop
    v_line_id := public.variant_id_of(v_item->>'line_id');
    if v_line_id is null then
      raise exception 'A stocktake count named a line that is not an id'
        using errcode = 'check_violation';
    end if;
    if jsonb_typeof(v_item->'physical_quantity') <> 'number'
       or (v_item->>'physical_quantity')::numeric < 0
       or (v_item->>'physical_quantity')::numeric <> trunc((v_item->>'physical_quantity')::numeric)
       or (v_item->>'physical_quantity')::numeric > 1000000000 then
      raise exception 'A physical count must be a whole number of units'
        using errcode = 'check_violation';
    end if;
    v_physical := trunc((v_item->>'physical_quantity')::numeric)::integer;
    select * into v_line from public.stocktake_lines
     where id = v_line_id and stocktake_id = v_row.id
     for update;
    if not found then
      raise exception 'A stocktake count named a line that is not in this session'
        using errcode = 'foreign_key_violation';
    end if;
    update public.stocktake_lines
       set physical_quantity = v_physical,
           variance = v_physical - expected_quantity
     where id = v_line.id;
    v_counted := v_counted + 1;
  end loop;

  if p_status = 'review' and exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_row.id and physical_quantity is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_INCOMPLETE');
  end if;

  if p_status is not null and p_status is distinct from v_row.status then
    update public.stocktakes set status = p_status where id = v_row.id;
  end if;

  -- One trail row per explicit save, never per keystroke. The page asks for
  -- the audit only when the count is sent to review.
  if coalesce(p_audit, false) then
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values (
      'stocktake.updated', 'stocktake', v_row.id::text, v_row.reference,
      jsonb_build_object('lines_saved', v_counted, 'status', coalesce(p_status, v_row.status)),
      v_actor, v_name
    );
  end if;

  return jsonb_build_object('ok', true, 'session', public.stocktake_document(v_row.id));
end;
$$;

comment on function public.stocktake_save_counts(uuid, jsonb, text, boolean) is
  'Writes physical counts. Cannot change expected quantity, shelf, or a finalized session. Requires adjust_stock. Audits only when p_audit is true.';

create or replace function public.stocktake_finalize(p_stocktake_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_actor     text;
  v_name      text;
  v_row       public.stocktakes%rowtype;
  v_line      public.stocktake_lines%rowtype;
  v_product   public.products%rowtype;
  v_variant   public.product_variants%rowtype;
  v_current   integer;
  v_conflicts jsonb := '[]'::jsonb;
  v_delta     integer;
  v_type      public.stock_movement_type;
  v_before    integer;
  v_after     integer;
  v_movement  uuid;
  v_written   integer := 0;
begin
  select a.actor_id, a.actor_name into v_actor, v_name from public.stocktake_assert_adjust() a;
  select * into v_row from public.stocktakes where id = p_stocktake_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_NOT_FOUND');
  end if;
  if v_row.status = 'finalized' then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_FINALIZED', 'session', public.stocktake_document(v_row.id));
  end if;
  if not exists (select 1 from public.stocktake_lines where stocktake_id = v_row.id) then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_EMPTY');
  end if;
  if exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_row.id and physical_quantity is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'STOCKTAKE_INCOMPLETE');
  end if;

  -- Lock shelves in a stable order, then decide. A conflict writes nothing
  -- to the ledger. The audit row commits with this refusal.
  for v_line in
    select * from public.stocktake_lines
     where stocktake_id = v_row.id
     order by product_id, variant_id nulls first, id
  loop
    select * into v_product from public.products where id = v_line.product_id for update;
    if not found then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id, 'sku', v_line.sku, 'expected', v_line.expected_quantity, 'current', null
      ));
      continue;
    end if;
    if v_product.variants_enabled and v_line.variant_id is null then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id, 'sku', v_line.sku, 'expected', v_line.expected_quantity, 'current', null
      ));
      continue;
    end if;
    if v_line.variant_id is not null then
      select * into v_variant from public.product_variants
       where id = v_line.variant_id and product_id = v_product.id
       for update;
      if not found then
        v_current := null;
      else
        v_current := v_variant.stock_quantity;
      end if;
    else
      v_current := v_product.stock_quantity;
    end if;
    if v_current is null or v_current is distinct from v_line.expected_quantity then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'sku', v_line.sku,
        'product_id', v_line.product_id,
        'variant_id', v_line.variant_id,
        'expected', v_line.expected_quantity,
        'current', v_current
      ));
    end if;
  end loop;

  if jsonb_array_length(v_conflicts) > 0 then
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values (
      'stocktake.conflict', 'stocktake', v_row.id::text, v_row.reference,
      jsonb_build_object('conflicts', v_conflicts),
      v_actor, v_name
    );
    return jsonb_build_object(
      'ok', false,
      'code', 'STOCKTAKE_CONFLICT',
      'conflicts', v_conflicts,
      'session', public.stocktake_document(v_row.id)
    );
  end if;

  for v_line in
    select * from public.stocktake_lines
     where stocktake_id = v_row.id
       and physical_quantity is distinct from expected_quantity
     order by product_id, variant_id nulls first, id
  loop
    v_before := v_line.expected_quantity;
    v_after := v_line.physical_quantity;
    if v_after > v_before then
      v_type := 'adjustment_in';
      v_delta := v_after - v_before;
    else
      v_type := 'adjustment_out';
      v_delta := v_before - v_after;
    end if;

    if v_line.variant_id is not null then
      select * into v_variant from public.product_variants where id = v_line.variant_id;
      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_line.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_delta, v_before, v_after, v_type, 'recount',
        'Stocktake ' || v_row.reference,
        v_actor, v_name
      ) returning id into v_movement;
      update public.product_variants
         set stock_quantity = v_after,
             updated_at = now()
       where id = v_variant.id
         and stock_quantity = v_before;
      if not found then
        raise exception 'Stock changed while the stocktake was finalizing'
          using errcode = 'serialization_failure';
      end if;
    else
      insert into public.stock_movements (
        product_id, variant_id, delta, quantity_before, quantity_after,
        type, reason, notes, user_id, user_name
      ) values (
        v_line.product_id, null, v_delta, v_before, v_after,
        v_type, 'recount', 'Stocktake ' || v_row.reference, v_actor, v_name
      ) returning id into v_movement;
      update public.products
         set stock_quantity = v_after,
             updated_at = now()
       where id = v_line.product_id
         and not variants_enabled
         and stock_quantity = v_before;
      if not found then
        raise exception 'Stock changed while the stocktake was finalizing'
          using errcode = 'serialization_failure';
      end if;
    end if;

    update public.stocktake_lines
       set movement_id = v_movement,
           movement_reference = v_movement::text
     where id = v_line.id;
    v_written := v_written + 1;
  end loop;

  perform set_config('alyq.stocktake_finalizing', v_row.id::text, true);
  update public.stocktakes
     set status = 'finalized',
         finalized_at = now(),
         finalized_by = v_actor,
         finalized_by_name = v_name
   where id = v_row.id;
  perform set_config('alyq.stocktake_finalizing', '', true);

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'stocktake.finalized', 'stocktake', v_row.id::text, v_row.reference,
    jsonb_build_object('movements', v_written),
    v_actor, v_name
  );

  return jsonb_build_object(
    'ok', true,
    'movements', v_written,
    'session', public.stocktake_document(v_row.id)
  );
end;
$$;

comment on function public.stocktake_finalize(uuid) is
  'Applies a reviewed count in one transaction through the stock ledger. Requires adjust_stock. Rejects the whole count if any shelf moved since the snapshot. Zero-variance lines write no movement. Does not rewrite expected quantity.';

revoke all on function public.stocktake_assert_adjust() from public, anon, authenticated;
revoke all on function public.stocktake_document(uuid) from public, anon, authenticated;
revoke all on function public.stocktake_create(boolean, text) from public, anon;
revoke all on function public.stocktake_save_counts(uuid, jsonb, text, boolean) from public, anon;
revoke all on function public.stocktake_finalize(uuid) from public, anon;

grant execute on function public.stocktake_create(boolean, text) to authenticated, service_role;
grant execute on function public.stocktake_save_counts(uuid, jsonb, text, boolean) to authenticated, service_role;
grant execute on function public.stocktake_finalize(uuid) to authenticated, service_role;

-- ── 6. who may read ────────────────────────────────────────────────────────
alter table public.stocktakes enable row level security;
alter table public.stocktake_lines enable row level security;

drop policy if exists stocktakes_select on public.stocktakes;
create policy stocktakes_select on public.stocktakes
  for select to authenticated
  using (public.can('view_inventory'));

drop policy if exists stocktake_lines_select on public.stocktake_lines;
create policy stocktake_lines_select on public.stocktake_lines
  for select to authenticated
  using (public.can('view_inventory'));

revoke all on public.stocktakes from public, anon;
revoke all on public.stocktake_lines from public, anon;
grant select on public.stocktakes to authenticated;
grant select on public.stocktake_lines to authenticated;

-- ── 7. backup carries the count and does not replay it ────────────────────
-- 0050's order, plus the session before its lines and the lines after the
-- movements they point at. Restore inserts those rows. It does not call
-- stocktake_finalize, so movements are not applied twice.

create or replace function public.backup_table_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    'approval_counters',
    'refund_counters',
    'return_counters',
    'sale_counters',
    'role_aliases',
    'role_capabilities',
    'audit_actions',
    'approval_rules',
    'campaigns',
    'coupons',
    'delivery_zones',
    'promotions',
    'store_faqs',
    'website_settings',
    'categories',
    'custom_roles',
    'customers',
    'store_customers',
    'shifts',
    'products',
    'product_variants',
    'catalogue_codes',
    'profiles',
    'expenses',
    'sales',
    'audit_log',
    'online_orders',
    'sales_returns',
    'stocktakes',
    'promotion_targets',
    'sale_items',
    'sale_payments',
    'stock_movements',
    'stocktake_lines',
    'product_content',
    'storefront_category_content',
    'store_reviews',
    'online_order_items',
    'order_events',
    'stock_reservations',
    'promo_code_usages',
    'return_items',
    'refund_records',
    'approval_requests'
  ];
$$;

create or replace function public.backup_restore_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array(
    select t
      from unnest(public.backup_table_order()) with ordinality as x(t, n)
     where t <> all (array[
       'role_aliases', 'role_capabilities', 'audit_actions', 'audit_log',
       'catalogue_codes'
     ])
     order by n
  ), '{}');
$$;

-- ── 8. the snapshot cannot be rewritten, even by the table owner ───────────
-- The check rows, and the audit a category delete would write, are rolled
-- back by the inner exception. A real failure still aborts the migration.
do $$
declare
  v_cat uuid;
  v_product uuid;
  v_take uuid;
  v_line uuid;
begin
  begin
    insert into public.categories (name_ar, name_en)
    values ('فحص جرد', 'Stocktake check')
    returning id into v_cat;
    insert into public.products (sku, name_ar, name_en, category_id, selling_price, cost_price, stock_quantity)
    values ('STCHECK1', 'فحص', 'Stocktake check', v_cat, 1, 0, 4)
    returning id into v_product;
    insert into public.stocktakes (reference, status, created_by, created_by_name, finalized_at, finalized_by, finalized_by_name)
    values ('ST-CHECK-IMMUTABLE', 'finalized', 'migration', 'migration', now(), 'migration', 'migration')
    returning id into v_take;
    insert into public.stocktake_lines (
      stocktake_id, product_id, shelf_key, sku, product_name_ar, product_name_en,
      expected_quantity, physical_quantity, variance
    ) values (
      v_take, v_product, v_product::text, 'STCHECK1', 'فحص', 'Stocktake check', 4, 4, 0
    ) returning id into v_line;

    begin
      update public.stocktake_lines set expected_quantity = 9 where id = v_line;
      raise exception 'finalized expected quantity was rewritten';
    exception when check_violation then
      null;
    end;

    if (select expected_quantity from public.stocktake_lines where id = v_line) <> 4 then
      raise exception 'the immutability refusal still changed the snapshot';
    end if;
    raise exception 'STOCKTAKE_CHECK_OK';
  exception when others then
    if SQLERRM not like '%STOCKTAKE_CHECK_OK%' then
      raise;
    end if;
  end;
end
$$;

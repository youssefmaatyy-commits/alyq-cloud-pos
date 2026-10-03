-- 0075 — authoritative, retry-safe inventory adjustments
--
-- Replaces the live browser's former insert-then-update sequence with one
-- branch-scoped transaction. This extends the existing stock_movements ledger;
-- it does not introduce a parallel stock total or ledger.

begin;

alter table public.stock_movements
  add column if not exists variant_size_label text,
  add column if not exists client_ref text,
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists reference text;

alter table public.stock_movements
  drop constraint if exists stock_movements_client_ref_length;
alter table public.stock_movements
  add constraint stock_movements_client_ref_length
  check (client_ref is null or (btrim(client_ref) <> '' and char_length(client_ref) <= 120));

alter table public.stock_movements
  drop constraint if exists stock_movements_source_type_valid;
alter table public.stock_movements
  add constraint stock_movements_source_type_valid
  check (source_type is null or source_type in ('sale','return','adjustment','transfer','stocktake','receipt'));

create unique index if not exists stock_movements_branch_client_ref_uidx
  on public.stock_movements(branch_id, client_ref)
  where client_ref is not null;

create index if not exists stock_movements_source_idx
  on public.stock_movements(branch_id, source_type, source_id)
  where source_type is not null;

comment on column public.stock_movements.client_ref is
  'Retry identity for an authoritative inventory operation. Unique inside its branch when present.';
comment on column public.stock_movements.source_type is
  'Supported business origin: sale, return, adjustment, transfer, stocktake, or receipt.';
comment on column public.stock_movements.source_id is
  'Origin record id when the movement has a durable linked record.';
comment on column public.stock_movements.reference is
  'Human-readable immutable origin reference for movement history.';

-- Link existing sale/return/stocktake movement notes to their durable origin.
-- Those authoritative functions predate explicit provenance columns; this is a
-- metadata backfill only and does not change a quantity or ledger amount.
update public.stock_movements sm
   set source_type = 'return', source_id = r.id, reference = r.return_number
  from public.sales_returns r
 where sm.source_type is null
   and sm.branch_id = r.branch_id
   and sm.notes like 'Customer Return: ' || r.return_number || '%';

update public.stock_movements sm
   set source_type = 'stocktake', source_id = st.id, reference = st.reference
  from public.stocktakes st
 where sm.source_type is null
   and sm.branch_id = st.branch_id
   and sm.notes = 'Stocktake ' || st.reference;

update public.stock_movements sm
   set source_type = 'sale', source_id = s.id, reference = s.sale_number
  from public.sales s
 where sm.source_type is null
   and sm.branch_id = s.branch_id
   and sm.notes like '%Sale ' || s.sale_number;

create or replace function public.stock_movement_derive_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := coalesce(new.branch_id, public.current_branch_id());
  v_reference text;
begin
  if new.source_type is not null then return new; end if;

  if new.notes like 'Customer Return: %' then
    v_reference := substring(new.notes from '^Customer Return: ([^ ]+)');
    select r.id into new.source_id
      from public.sales_returns r
     where r.branch_id = v_branch and r.return_number = v_reference;
    if new.source_id is not null then
      new.source_type := 'return'; new.reference := v_reference;
    end if;
  elsif new.notes like 'Stocktake %' then
    v_reference := substring(new.notes from '^Stocktake (.+)$');
    select st.id into new.source_id
      from public.stocktakes st
     where st.branch_id = v_branch and st.reference = v_reference;
    if new.source_id is not null then
      new.source_type := 'stocktake'; new.reference := v_reference;
    end if;
  elsif new.notes like '%Sale %' then
    v_reference := substring(new.notes from 'Sale ([^ ]+)$');
    select s.id into new.source_id
      from public.sales s
     where s.branch_id = v_branch and s.sale_number = v_reference;
    if new.source_id is not null then
      new.source_type := 'sale'; new.reference := v_reference;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_derive_source on public.stock_movements;
create trigger stock_movements_derive_source
  before insert on public.stock_movements
  for each row execute function public.stock_movement_derive_source();

create or replace function public.inventory_adjust_stock(
  p_client_ref text,
  p_product_id uuid,
  p_variant_id uuid,
  p_type text,
  p_reason text,
  p_quantity integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_ref text := nullif(btrim(coalesce(p_client_ref, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_existing public.stock_movements%rowtype;
  v_movement public.stock_movements%rowtype;
  v_type public.stock_movement_type;
  v_reason public.stock_reason;
  v_before integer;
  v_after integer;
  v_outbound boolean;
  v_actor_name text;
  v_reference text;
begin
  if auth.uid() is null or v_branch is null then
    raise exception 'An active branch session is required' using errcode = '42501';
  end if;
  if not public.can('adjust_stock') then
    raise exception 'Inventory adjustment requires adjust_stock' using errcode = '42501';
  end if;
  if v_ref is null or char_length(v_ref) > 120 then
    raise exception 'A valid inventory client reference is required' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Adjustment quantity must be a positive integer' using errcode = '23514';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'Adjustment notes must be at most 500 characters' using errcode = '22001';
  end if;

  -- Transfer is intentionally not a disguised one-sided adjustment. A branch
  -- transfer needs two branch-qualified shelves, which the current catalogue
  -- schema does not have. Refuse rather than subtracting without a destination.
  if lower(btrim(coalesce(p_type, ''))) = 'transfer' then
    raise exception 'Use the branch transfer workflow; a one-sided transfer is not an adjustment'
      using errcode = '0A000';
  end if;

  begin
    v_type := lower(btrim(p_type))::public.stock_movement_type;
    v_reason := lower(btrim(p_reason))::public.stock_reason;
  exception when invalid_text_representation then
    raise exception 'Unknown stock movement type or reason' using errcode = '22023';
  end;

  if v_type not in ('adjustment_in','adjustment_out','receive','issue','correction') then
    raise exception 'Unsupported manual adjustment type %', v_type using errcode = '22023';
  end if;

  select * into v_existing
    from public.stock_movements
   where branch_id = v_branch and client_ref = v_ref;
  if found then
    if v_existing.product_id <> p_product_id
       or v_existing.variant_id is distinct from p_variant_id
       or v_existing.type <> v_type
       or v_existing.reason <> v_reason
       or v_existing.delta <> p_quantity then
      raise exception 'Inventory client reference was already used for another operation'
        using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'replayed', true, 'movement', to_jsonb(v_existing));
  end if;

  select * into v_product
    from public.products
   where id = p_product_id
   for update;
  if not found then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if not v_product.stock_tracking_enabled then
    raise exception 'Stock tracking is disabled for this product' using errcode = '23514';
  end if;

  if v_product.variants_enabled then
    if p_variant_id is null then
      raise exception 'An exact product variant is required' using errcode = '23514';
    end if;
    select * into v_variant
      from public.product_variants
     where id = p_variant_id and product_id = v_product.id and active
     for update;
    if not found then
      raise exception 'Active product variant not found' using errcode = 'P0002';
    end if;
    v_before := v_variant.stock_quantity;
  else
    if p_variant_id is not null then
      raise exception 'This product does not use variants' using errcode = '23514';
    end if;
    v_before := v_product.stock_quantity;
  end if;

  v_outbound := v_type in ('adjustment_out','issue');
  v_after := case when v_outbound then v_before - p_quantity else v_before + p_quantity end;
  if v_after < 0 then
    raise exception 'Insufficient stock: % available, % requested', v_before, p_quantity
      using errcode = '23514';
  end if;

  if v_product.variants_enabled then
    update public.product_variants
       set stock_quantity = v_after, updated_at = now()
     where id = v_variant.id;
  else
    update public.products
       set stock_quantity = v_after, updated_at = now()
     where id = v_product.id;
  end if;

  select coalesce(nullif(btrim(p.name), ''), nullif(btrim(p.username), ''), 'Staff')
    into v_actor_name
    from public.profiles p
   where p.id = auth.uid();
  v_actor_name := coalesce(v_actor_name, 'Staff');
  v_reference := 'ADJ-' || upper(substr(replace(v_ref, '-', ''), 1, 10));

  insert into public.stock_movements(
    product_id, variant_id, variant_color_ar, variant_color_en,
    variant_size, variant_size_label, delta, quantity_before, quantity_after,
    type, reason, notes, user_id, user_name, branch_id,
    client_ref, source_type, reference
  ) values (
    v_product.id, case when v_product.variants_enabled then v_variant.id else null end,
    case when v_product.variants_enabled then v_variant.color_ar else null end,
    case when v_product.variants_enabled then v_variant.color_en else null end,
    case when v_product.variants_enabled then v_variant.size else null end,
    case when v_product.variants_enabled then v_variant.size_label else null end,
    p_quantity, v_before, v_after, v_type, v_reason, v_notes,
    auth.uid()::text, v_actor_name, v_branch,
    v_ref, 'adjustment', v_reference
  ) returning * into v_movement;

  insert into public.audit_log(
    action, entity, entity_id, entity_label, details,
    user_id, user_name, branch_id, module
  ) values (
    case when v_reason = 'recount' then 'stock.corrected' else 'stock.adjusted' end,
    'stock', v_product.id::text,
    case when v_product.variants_enabled then v_variant.sku else v_product.sku end,
    jsonb_build_object(
      'movement_id', v_movement.id,
      'reference', v_reference,
      'product_id', v_product.id,
      'variant_id', v_movement.variant_id,
      'movement', v_type,
      'reason', v_reason,
      'delta', p_quantity,
      'before', v_before,
      'after', v_after,
      'notes', v_notes
    ),
    auth.uid()::text, v_actor_name, v_branch, 'inventory'
  );

  return jsonb_build_object('ok', true, 'replayed', false, 'movement', to_jsonb(v_movement));
exception
  when unique_violation then
    select * into v_existing
      from public.stock_movements
     where branch_id = v_branch and client_ref = v_ref;
    if found and v_existing.product_id = p_product_id
       and v_existing.variant_id is not distinct from p_variant_id
       and v_existing.type = v_type
       and v_existing.reason = v_reason
       and v_existing.delta = p_quantity then
      return jsonb_build_object('ok', true, 'replayed', true, 'movement', to_jsonb(v_existing));
    end if;
    raise;
end;
$$;

comment on function public.inventory_adjust_stock(text,uuid,uuid,text,text,integer,text) is
  'Atomically locks one exact shelf, rejects negative stock and one-sided transfers, updates the authoritative quantity, appends one branch-scoped stock movement and one audit event, and replays safely by client_ref.';

revoke all on function public.inventory_adjust_stock(text,uuid,uuid,text,text,integer,text)
  from public, anon;
grant execute on function public.inventory_adjust_stock(text,uuid,uuid,text,text,integer,text)
  to authenticated, service_role;
revoke all on function public.stock_movement_derive_source()
  from public, anon, authenticated;

commit;

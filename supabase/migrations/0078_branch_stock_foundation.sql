-- 0078 — True branch shelf balances and atomic branch transfers
--
-- `products.stock_quantity` and `product_variants.stock_quantity` are retained as
-- compatibility ROLLUPS only. Operational authority moves to one branch-qualified
-- balance row per sellable shelf. Existing units are assigned exactly once to the
-- deterministic default branch; they are never copied into every branch.

begin;

-- ── Branch-qualified stock authority ───────────────────────────────────────
create table if not exists public.branch_stock_balances (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references public.branches(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete cascade,
  variant_id      uuid references public.product_variants(id) on delete cascade,
  quantity        integer not null default 0,
  reorder_level   integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint branch_stock_quantity_nonnegative check (quantity >= 0),
  constraint branch_stock_reorder_nonnegative check (reorder_level >= 0)
);

create unique index if not exists branch_stock_variant_uidx
  on public.branch_stock_balances(branch_id, variant_id)
  where variant_id is not null;
create unique index if not exists branch_stock_product_uidx
  on public.branch_stock_balances(branch_id, product_id)
  where variant_id is null;
create index if not exists branch_stock_branch_product_idx
  on public.branch_stock_balances(branch_id, product_id, variant_id);
create index if not exists branch_stock_low_idx
  on public.branch_stock_balances(branch_id, quantity, reorder_level);

comment on table public.branch_stock_balances is
  'Authoritative on-hand and reorder level for one product/variant shelf at one branch. A missing row means zero units and no configured reorder threshold.';
comment on column public.branch_stock_balances.quantity is
  'Operational stock authority. Legacy product/variant stock columns are aggregate compatibility rollups of these rows.';
comment on column public.branch_stock_balances.reorder_level is
  'Branch × exact shelf reorder threshold. Zero means no threshold was configured for this branch.';

create or replace function public.branch_stock_validate_shelf()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product uuid;
  v_active boolean;
begin
  select active into v_active from public.branches where id=new.branch_id;
  if not found or not v_active then
    raise exception 'Stock branch is missing or inactive' using errcode='23514';
  end if;
  if new.variant_id is not null then
    select product_id into v_product from public.product_variants where id=new.variant_id;
    if v_product is null or v_product<>new.product_id then
      raise exception 'Stock variant does not belong to its product' using errcode='23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists branch_stock_validate_shelf on public.branch_stock_balances;
create trigger branch_stock_validate_shelf
before insert or update on public.branch_stock_balances
for each row execute function public.branch_stock_validate_shelf();

-- Existing global stock is assigned to ONE location only. The Phase 2 default
-- branch is deterministic for upgraded installations; no unit is multiplied.
insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
select b.id,p.id,null,greatest(p.stock_quantity,0),greatest(p.low_stock_level,0)
  from public.products p
  cross join lateral (select id from public.branches where is_default order by created_at,id limit 1) b
 where p.stock_tracking_enabled and not p.variants_enabled
on conflict do nothing;

insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
select b.id,v.product_id,v.id,greatest(v.stock_quantity,0),greatest(v.low_stock_level,0)
  from public.product_variants v
  join public.products p on p.id=v.product_id and p.stock_tracking_enabled
  cross join lateral (select id from public.branches where is_default order by created_at,id limit 1) b
on conflict do nothing;

-- ── Compatibility rollups and legacy-writer bridge ─────────────────────────
create or replace function public.branch_stock_rollup_legacy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product uuid := case when tg_op='DELETE' then old.product_id else new.product_id end;
  v_variant uuid := case when tg_op='DELETE' then old.variant_id else new.variant_id end;
  v_total integer;
  v_previous_rollup text := current_setting('alyq.branch_stock_rollup',true);
begin
  if v_variant is not null then
    select coalesce(sum(quantity),0)::integer into v_total
      from public.branch_stock_balances where variant_id=v_variant;
    perform set_config('alyq.branch_stock_rollup',v_variant::text,true);
    update public.product_variants
       set stock_quantity=v_total,updated_at=now()
     where id=v_variant and stock_quantity is distinct from v_total;
  else
    -- Product-level balances exist only for products that do not sell by variant.
    if exists(select 1 from public.products where id=v_product and not variants_enabled) then
      select coalesce(sum(quantity),0)::integer into v_total
        from public.branch_stock_balances where product_id=v_product and variant_id is null;
      perform set_config('alyq.branch_stock_rollup',v_product::text,true);
      update public.products
         set stock_quantity=v_total,updated_at=now()
       where id=v_product and stock_quantity is distinct from v_total;
    end if;
  end if;
  perform set_config('alyq.branch_stock_rollup',coalesce(v_previous_rollup,''),true);
  return null;
end
$function$;

drop trigger if exists branch_stock_rollup_legacy on public.branch_stock_balances;
create trigger branch_stock_rollup_legacy
after insert or update of quantity or delete on public.branch_stock_balances
for each row execute function public.branch_stock_rollup_legacy();

create or replace function public.variant_stock_bridge_to_branch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid;
  v_delta integer;
begin
  if new.stock_quantity is not distinct from old.stock_quantity
     or current_setting('alyq.branch_stock_rollup',true)=new.id::text then
    return null;
  end if;
  v_delta := new.stock_quantity-old.stock_quantity;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at,id limit 1;
  end if;
  if v_branch is null then raise exception 'No stock branch is available' using errcode='42501'; end if;
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_branch,new.product_id,new.id,0,greatest(new.low_stock_level,0))
  on conflict (branch_id,variant_id) where variant_id is not null do nothing;
  update public.branch_stock_balances
     set quantity=quantity+v_delta
   where branch_id=v_branch and variant_id=new.id;
  return null;
end
$function$;

drop trigger if exists zz_variant_stock_bridge_to_branch on public.product_variants;
create trigger zz_variant_stock_bridge_to_branch
after update of stock_quantity on public.product_variants
for each row execute function public.variant_stock_bridge_to_branch();

create or replace function public.product_stock_bridge_to_branch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid;
  v_delta integer;
begin
  if new.variants_enabled
     or new.stock_quantity is not distinct from old.stock_quantity
     or current_setting('alyq.branch_stock_rollup',true)=new.id::text
     or current_setting('alyq.variant_rollup_product',true)=new.id::text then
    return null;
  end if;
  v_delta := new.stock_quantity-old.stock_quantity;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at,id limit 1;
  end if;
  if v_branch is null then raise exception 'No stock branch is available' using errcode='42501'; end if;
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_branch,new.id,null,0,greatest(new.low_stock_level,0))
  on conflict (branch_id,product_id) where variant_id is null do nothing;
  update public.branch_stock_balances
     set quantity=quantity+v_delta
   where branch_id=v_branch and product_id=new.id and variant_id is null;
  return null;
end
$function$;

drop trigger if exists zz_product_stock_bridge_to_branch on public.products;
create trigger zz_product_stock_bridge_to_branch
after update of stock_quantity on public.products
for each row execute function public.product_stock_bridge_to_branch();

-- Opening stock on a newly-created legacy product belongs to the actor's active
-- branch (or the installation default for service/upgrade paths).
create or replace function public.product_opening_branch_stock()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_branch uuid;
begin
  if not new.stock_tracking_enabled or new.variants_enabled then return null; end if;
  v_branch:=public.current_branch_id();
  if v_branch is null then select id into v_branch from public.branches where is_default and active order by created_at,id limit 1; end if;
  if v_branch is not null then
    insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
    values(v_branch,new.id,null,new.stock_quantity,new.low_stock_level)
    on conflict (branch_id,product_id) where variant_id is null do nothing;
  end if;
  return null;
end
$function$;
drop trigger if exists product_opening_branch_stock on public.products;
create trigger product_opening_branch_stock
after insert on public.products for each row execute function public.product_opening_branch_stock();

create or replace function public.variant_opening_branch_stock()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_branch uuid;
begin
  v_branch:=public.current_branch_id();
  if v_branch is null then select id into v_branch from public.branches where is_default and active order by created_at,id limit 1; end if;
  if v_branch is not null then
    insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
    values(v_branch,new.product_id,new.id,new.stock_quantity,new.low_stock_level)
    on conflict (branch_id,variant_id) where variant_id is not null do nothing;
  end if;
  return null;
end
$function$;
drop trigger if exists variant_opening_branch_stock on public.product_variants;
create trigger variant_opening_branch_stock
after insert on public.product_variants for each row execute function public.variant_opening_branch_stock();

-- Remove the obsolete product-level shelf after an exact-variant conversion.
create or replace function public.product_variant_mode_branch_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.variants_enabled and not old.variants_enabled then
    delete from public.branch_stock_balances where product_id=new.id and variant_id is null;
  end if;
  return null;
end
$function$;
drop trigger if exists product_variant_mode_branch_cleanup on public.products;
create trigger product_variant_mode_branch_cleanup
after update of variants_enabled on public.products
for each row execute function public.product_variant_mode_branch_cleanup();

-- Every new movement reports branch-shelf before/after figures, even when an
-- older authoritative RPC supplied former global-rollup figures.
create or replace function public.stock_movement_branch_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_after integer;
begin
  if new.source_type is null then return new; end if;
  select quantity into v_after from public.branch_stock_balances
   where branch_id=new.branch_id and product_id=new.product_id
     and variant_id is not distinct from new.variant_id;
  if v_after is null then return new; end if;
  if new.type in ('issue','adjustment_out','transfer') then
    new.quantity_after:=v_after; new.quantity_before:=v_after+new.delta;
  elsif new.type in ('receive','adjustment_in') then
    new.quantity_after:=v_after; new.quantity_before:=v_after-new.delta;
  end if;
  return new;
end
$function$;
drop trigger if exists zz_stock_movement_branch_snapshot on public.stock_movements;
create trigger zz_stock_movement_branch_snapshot
before insert on public.stock_movements
for each row execute function public.stock_movement_branch_snapshot();

-- Pending storefront holds are also branch-specific. This final boundary check
-- prevents the older aggregate pre-check from promising another branch's units.
create or replace function public.stock_reservation_branch_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_stock integer; v_held integer;
begin
  if new.status<>'reserved' then return new; end if;
  select quantity into v_stock from public.branch_stock_balances
   where branch_id=new.branch_id and product_id=new.product_id
     and variant_id is not distinct from new.variant_id
   for update;
  v_stock:=coalesce(v_stock,0);
  select coalesce(sum(quantity),0)::integer into v_held from public.stock_reservations
   where branch_id=new.branch_id and product_id=new.product_id
     and variant_id is not distinct from new.variant_id and status='reserved'
     and id is distinct from new.id;
  if v_held+new.quantity>v_stock then
    raise exception 'Only % units are available at the fulfillment branch',greatest(v_stock-v_held,0)
      using errcode='23514';
  end if;
  return new;
end
$function$;
drop trigger if exists zz_stock_reservation_branch_guard on public.stock_reservations;
create trigger zz_stock_reservation_branch_guard
before insert or update of quantity,status,variant_id,product_id,branch_id on public.stock_reservations
for each row execute function public.stock_reservation_branch_guard();

-- The Phase 2 branch stamper continues to reject browser-supplied branch ids.
-- Its one narrow exception is the destination movement emitted inside the
-- authoritative transfer RPC, proven by a transaction-local transfer id.
create or replace function public.stamp_branch_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid:=public.current_branch_id();
  v_transfer uuid;
begin
  if tg_table_name in ('sale_items','sale_payments') then
    select branch_id into new.branch_id from public.sales where id=new.sale_id;
  elsif tg_table_name in ('sales_returns','refund_records') then
    select branch_id into new.branch_id from public.sales where id=new.sale_id;
    if v_branch is not null and new.branch_id<>v_branch then raise exception 'Cross-branch financial write rejected' using errcode='42501'; end if;
  elsif tg_table_name='return_items' then
    select branch_id into new.branch_id from public.sales_returns where id=new.return_id;
  elsif tg_table_name='order_events' then
    select branch_id into new.branch_id from public.online_orders where id=new.order_id;
  elsif tg_table_name='stock_reservations' then
    select branch_id into new.branch_id from public.online_orders where id=new.online_order_id;
  elsif tg_table_name='stock_movements' and nullif(current_setting('alyq.authoritative_stock_transfer',true),'') is not null then
    v_transfer:=current_setting('alyq.authoritative_stock_transfer',true)::uuid;
    if new.source_type<>'transfer' or new.source_id is distinct from v_transfer
       or not exists(select 1 from public.stock_transfers t where t.id=v_transfer and new.branch_id in(t.source_branch_id,t.destination_branch_id)) then
      raise exception 'Forged transfer movement branch rejected' using errcode='42501';
    end if;
  elsif v_branch is not null then
    new.branch_id:=v_branch;
  end if;
  if new.branch_id is null then
    select id into new.branch_id from public.branches where is_default order by created_at,id limit 1;
  end if;
  return new;
end
$function$;

-- ── True atomic transfers ──────────────────────────────────────────────────
create table if not exists public.stock_transfers (
  id                    uuid primary key default gen_random_uuid(),
  client_ref            text not null,
  reference             text not null,
  source_branch_id      uuid not null references public.branches(id) on delete restrict,
  destination_branch_id uuid not null references public.branches(id) on delete restrict,
  product_id            uuid not null references public.products(id) on delete restrict,
  variant_id            uuid references public.product_variants(id) on delete restrict,
  quantity              integer not null,
  reason                text,
  status                text not null default 'completed',
  initiated_by          uuid not null references public.profiles(id) on delete restrict,
  initiated_by_name     text not null,
  created_at            timestamptz not null default now(),
  completed_at          timestamptz not null default now(),
  constraint stock_transfers_ref_not_blank check (btrim(client_ref)<>'' and char_length(client_ref)<=120),
  constraint stock_transfers_reference_not_blank check (btrim(reference)<>''),
  constraint stock_transfers_branches_differ check (source_branch_id<>destination_branch_id),
  constraint stock_transfers_quantity_positive check (quantity>0),
  constraint stock_transfers_status_shape check (status in ('completed')),
  constraint stock_transfers_client_unique unique(source_branch_id,client_ref),
  constraint stock_transfers_reference_unique unique(reference)
);
create index if not exists stock_transfers_source_idx on public.stock_transfers(source_branch_id,created_at desc);
create index if not exists stock_transfers_destination_idx on public.stock_transfers(destination_branch_id,created_at desc);
create index if not exists stock_transfers_shelf_idx on public.stock_transfers(product_id,variant_id,created_at desc);

insert into public.audit_actions(action,entity) values('stock.transferred','stock_transfer') on conflict(action) do nothing;

create or replace function public.inventory_transfer_stock(
  p_client_ref text,
  p_destination_branch_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity integer,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_source uuid:=public.current_branch_id();
  v_ref text:=nullif(btrim(coalesce(p_client_ref,'')),'');
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_existing public.stock_transfers%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_source_before integer;
  v_destination_before integer;
  v_held integer;
  v_actor_name text;
  v_reference text;
begin
  if auth.uid() is null or v_source is null then raise exception 'An active source branch is required' using errcode='42501'; end if;
  if v_ref is null or char_length(v_ref)>120 then raise exception 'A valid transfer client reference is required' using errcode='22023'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Transfer quantity must be positive' using errcode='23514'; end if;
  if p_destination_branch_id is null or p_destination_branch_id=v_source then raise exception 'Destination must be another branch' using errcode='23514'; end if;
  if not public.branch_member_can(auth.uid(),v_source,'adjust_stock')
     or not public.branch_member_can(auth.uid(),p_destination_branch_id,'adjust_stock') then
    raise exception 'Stock transfer requires adjust_stock at source and destination' using errcode='42501';
  end if;

  select * into v_existing from public.stock_transfers where source_branch_id=v_source and client_ref=v_ref;
  if found then
    if v_existing.destination_branch_id<>p_destination_branch_id or v_existing.product_id<>p_product_id
       or v_existing.variant_id is distinct from p_variant_id or v_existing.quantity<>p_quantity then
      raise exception 'Transfer client reference was used for another operation' using errcode='23505';
    end if;
    return jsonb_build_object('ok',true,'replayed',true,'transfer',to_jsonb(v_existing));
  end if;

  select * into v_product from public.products where id=p_product_id and stock_tracking_enabled for share;
  if not found then raise exception 'Tracked product not found' using errcode='P0002'; end if;
  if v_product.variants_enabled then
    if p_variant_id is null then raise exception 'An exact variant is required' using errcode='23514'; end if;
    select * into v_variant from public.product_variants where id=p_variant_id and product_id=p_product_id and active;
    if not found then raise exception 'Active product variant not found' using errcode='P0002'; end if;
  elsif p_variant_id is not null then raise exception 'This product does not use variants' using errcode='23514';
  end if;

  -- Destination is materialized before both rows are locked. The deterministic
  -- branch-id lock order prevents opposite-direction transfers from deadlocking.
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(p_destination_branch_id,p_product_id,p_variant_id,0,
    case when p_variant_id is null then greatest(v_product.low_stock_level,0) else greatest(v_variant.low_stock_level,0) end)
  on conflict do nothing;
  -- Lock both shelves in branch-id order. Opposite-direction transfers then
  -- take the same locks in the same order instead of deadlocking.
  perform 1 from public.branch_stock_balances
   where product_id=p_product_id and variant_id is not distinct from p_variant_id
     and branch_id in (v_source,p_destination_branch_id)
   order by branch_id for update;

  -- A concurrent identical request may have committed while this request was
  -- waiting for the shelves. Re-check under the locks before changing stock.
  select * into v_existing from public.stock_transfers where source_branch_id=v_source and client_ref=v_ref;
  if found then
    if v_existing.destination_branch_id<>p_destination_branch_id or v_existing.product_id<>p_product_id
       or v_existing.variant_id is distinct from p_variant_id or v_existing.quantity<>p_quantity then
      raise exception 'Transfer client reference was used for another operation' using errcode='23505';
    end if;
    return jsonb_build_object('ok',true,'replayed',true,'transfer',to_jsonb(v_existing));
  end if;

  select quantity into v_source_before from public.branch_stock_balances
   where branch_id=v_source and product_id=p_product_id and variant_id is not distinct from p_variant_id;
  select quantity into v_destination_before from public.branch_stock_balances
   where branch_id=p_destination_branch_id and product_id=p_product_id and variant_id is not distinct from p_variant_id;
  select coalesce(sum(quantity),0)::integer into v_held from public.stock_reservations
   where branch_id=v_source and product_id=p_product_id
     and variant_id is not distinct from p_variant_id and status='reserved';
  if v_source_before is null or v_source_before-v_held<p_quantity then
    raise exception 'Insufficient unreserved source stock: % available, % requested',greatest(coalesce(v_source_before,0)-v_held,0),p_quantity using errcode='23514';
  end if;

  update public.branch_stock_balances set quantity=quantity-p_quantity
   where branch_id=v_source and product_id=p_product_id and variant_id is not distinct from p_variant_id;
  update public.branch_stock_balances set quantity=quantity+p_quantity
   where branch_id=p_destination_branch_id and product_id=p_product_id and variant_id is not distinct from p_variant_id;

  select coalesce(nullif(btrim(name),''),nullif(btrim(username),''),'Staff') into v_actor_name from public.profiles where id=auth.uid();
  v_actor_name:=coalesce(v_actor_name,'Staff');
  v_reference:='TRF-'||upper(substr(md5(v_source::text||':'||v_ref),1,16));
  insert into public.stock_transfers(client_ref,reference,source_branch_id,destination_branch_id,product_id,variant_id,quantity,reason,initiated_by,initiated_by_name)
  values(v_ref,v_reference,v_source,p_destination_branch_id,p_product_id,p_variant_id,p_quantity,nullif(btrim(coalesce(p_reason,'')),''),auth.uid(),v_actor_name)
  returning * into v_transfer;

  perform set_config('alyq.authoritative_stock_transfer',v_transfer.id::text,true);
  insert into public.stock_movements(product_id,variant_id,variant_color_ar,variant_color_en,variant_size,variant_size_label,delta,quantity_before,quantity_after,type,reason,notes,user_id,user_name,branch_id,client_ref,source_type,source_id,reference)
  values
    (p_product_id,p_variant_id,v_variant.color_ar,v_variant.color_en,v_variant.size,v_variant.size_label,p_quantity,v_source_before,v_source_before-p_quantity,'transfer','transfer_out',v_transfer.reason,auth.uid()::text,v_actor_name,v_source,v_ref,'transfer',v_transfer.id,v_reference),
    (p_product_id,p_variant_id,v_variant.color_ar,v_variant.color_en,v_variant.size,v_variant.size_label,p_quantity,v_destination_before,v_destination_before+p_quantity,'receive','transfer_in',v_transfer.reason,auth.uid()::text,v_actor_name,p_destination_branch_id,v_ref,'transfer',v_transfer.id,v_reference);
  perform set_config('alyq.authoritative_stock_transfer','',true);

  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module,correlation_id)
  values('stock.transferred','stock_transfer',v_transfer.id::text,v_reference,
    jsonb_build_object('source_branch_id',v_source,'destination_branch_id',p_destination_branch_id,'product_id',p_product_id,'variant_id',p_variant_id,'quantity',p_quantity,'reason',v_transfer.reason),
    auth.uid()::text,v_actor_name,v_source,'inventory',v_ref);
  return jsonb_build_object('ok',true,'replayed',false,'transfer',to_jsonb(v_transfer));
exception when unique_violation then
  select * into v_existing from public.stock_transfers where source_branch_id=v_source and client_ref=v_ref;
  if found and v_existing.destination_branch_id=p_destination_branch_id and v_existing.product_id=p_product_id
     and v_existing.variant_id is not distinct from p_variant_id and v_existing.quantity=p_quantity then
    return jsonb_build_object('ok',true,'replayed',true,'transfer',to_jsonb(v_existing));
  end if;
  raise;
end
$function$;

-- Authoritative adjustment now reads and writes the active branch shelf itself.
create or replace function public.inventory_adjust_stock(
  p_client_ref text,p_product_id uuid,p_variant_id uuid,p_type text,p_reason text,
  p_quantity integer,p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid:=public.current_branch_id(); v_ref text:=nullif(btrim(coalesce(p_client_ref,'')),'');
  v_notes text:=nullif(btrim(coalesce(p_notes,'')),''); v_product public.products%rowtype;
  v_variant public.product_variants%rowtype; v_existing public.stock_movements%rowtype;
  v_movement public.stock_movements%rowtype; v_type public.stock_movement_type; v_reason public.stock_reason;
  v_before integer; v_after integer; v_held integer; v_outbound boolean; v_actor_name text; v_reference text;
begin
  if auth.uid() is null or v_branch is null then raise exception 'An active branch session is required' using errcode='42501'; end if;
  if not public.branch_member_can(auth.uid(),v_branch,'adjust_stock') then raise exception 'Inventory adjustment requires adjust_stock at the active branch' using errcode='42501'; end if;
  if v_ref is null or char_length(v_ref)>120 then raise exception 'A valid inventory client reference is required' using errcode='22023'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Adjustment quantity must be positive' using errcode='23514'; end if;
  if lower(btrim(coalesce(p_type,'')))='transfer' then raise exception 'Use the branch transfer workflow' using errcode='0A000'; end if;
  begin v_type:=lower(btrim(p_type))::public.stock_movement_type; v_reason:=lower(btrim(p_reason))::public.stock_reason;
  exception when invalid_text_representation then raise exception 'Unknown stock movement type or reason' using errcode='22023'; end;
  if v_type not in ('adjustment_in','adjustment_out','receive','issue','correction') then raise exception 'Unsupported adjustment type' using errcode='22023'; end if;
  select * into v_existing from public.stock_movements where branch_id=v_branch and client_ref=v_ref;
  if found then
    if v_existing.product_id<>p_product_id or v_existing.variant_id is distinct from p_variant_id or v_existing.type<>v_type or v_existing.reason<>v_reason or v_existing.delta<>p_quantity then
      raise exception 'Inventory client reference was used for another operation' using errcode='23505'; end if;
    return jsonb_build_object('ok',true,'replayed',true,'movement',to_jsonb(v_existing));
  end if;
  select * into v_product from public.products where id=p_product_id and stock_tracking_enabled;
  if not found then raise exception 'Tracked product not found' using errcode='P0002'; end if;
  if v_product.variants_enabled then
    if p_variant_id is null then raise exception 'An exact variant is required' using errcode='23514'; end if;
    select * into v_variant from public.product_variants where id=p_variant_id and product_id=p_product_id and active;
    if not found then raise exception 'Active variant not found' using errcode='P0002'; end if;
  elsif p_variant_id is not null then raise exception 'This product does not use variants' using errcode='23514'; end if;
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_branch,p_product_id,p_variant_id,0,case when p_variant_id is null then v_product.low_stock_level else v_variant.low_stock_level end)
  on conflict do nothing;
  select quantity into v_before from public.branch_stock_balances
   where branch_id=v_branch and product_id=p_product_id and variant_id is not distinct from p_variant_id for update;
  v_outbound:=v_type in ('adjustment_out','issue');
  if v_outbound then
    select coalesce(sum(quantity),0)::integer into v_held from public.stock_reservations
     where branch_id=v_branch and product_id=p_product_id
       and variant_id is not distinct from p_variant_id and status='reserved';
  else
    v_held:=0;
  end if;
  v_after:=case when v_outbound then v_before-p_quantity else v_before+p_quantity end;
  if v_after<v_held then raise exception 'Insufficient unreserved stock: % available, % requested',greatest(v_before-v_held,0),p_quantity using errcode='23514'; end if;
  update public.branch_stock_balances set quantity=v_after
   where branch_id=v_branch and product_id=p_product_id and variant_id is not distinct from p_variant_id;
  select coalesce(nullif(btrim(name),''),nullif(btrim(username),''),'Staff') into v_actor_name from public.profiles where id=auth.uid();
  v_actor_name:=coalesce(v_actor_name,'Staff'); v_reference:='ADJ-'||upper(substr(replace(v_ref,'-',''),1,10));
  insert into public.stock_movements(product_id,variant_id,variant_color_ar,variant_color_en,variant_size,variant_size_label,delta,quantity_before,quantity_after,type,reason,notes,user_id,user_name,branch_id,client_ref,source_type,reference)
  values(p_product_id,p_variant_id,v_variant.color_ar,v_variant.color_en,v_variant.size,v_variant.size_label,p_quantity,v_before,v_after,v_type,v_reason,v_notes,auth.uid()::text,v_actor_name,v_branch,v_ref,'adjustment',v_reference)
  returning * into v_movement;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
  values(case when v_reason='recount' then 'stock.corrected' else 'stock.adjusted' end,'stock',p_product_id::text,case when p_variant_id is null then v_product.sku else v_variant.sku end,
    jsonb_build_object('movement_id',v_movement.id,'reference',v_reference,'product_id',p_product_id,'variant_id',p_variant_id,'movement',v_type,'reason',v_reason,'delta',p_quantity,'before',v_before,'after',v_after,'notes',v_notes),
    auth.uid()::text,v_actor_name,v_branch,'inventory');
  return jsonb_build_object('ok',true,'replayed',false,'movement',to_jsonb(v_movement));
exception when unique_violation then
  select * into v_existing from public.stock_movements where branch_id=v_branch and client_ref=v_ref;
  if found and v_existing.product_id=p_product_id and v_existing.variant_id is not distinct from p_variant_id and v_existing.type=v_type and v_existing.reason=v_reason and v_existing.delta=p_quantity then
    return jsonb_build_object('ok',true,'replayed',true,'movement',to_jsonb(v_existing)); end if;
  raise;
end
$function$;

-- A branch-filterable authoritative read. Supplying another branch is accepted
-- only when the caller is an active member with inventory visibility there.
create or replace function public.inventory_branch_stock(p_branch_id uuid default null)
returns table(branch_id uuid,branch_code text,branch_name_en text,branch_name_ar text,product_id uuid,variant_id uuid,quantity integer,reorder_level integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_branch uuid:=coalesce(p_branch_id,public.current_branch_id());
begin
  if auth.uid() is null or v_branch is null then raise exception 'Branch stock access denied' using errcode='42501'; end if;
  if not public.can_access_branch(v_branch) or not (
    public.branch_member_can(auth.uid(),v_branch,'view_inventory') or public.branch_member_can(auth.uid(),v_branch,'adjust_stock')
    or public.branch_member_can(auth.uid(),v_branch,'sell')) then
    raise exception 'Branch stock access denied' using errcode='42501';
  end if;
  return query
  select v_branch,b.code,b.name_en,b.name_ar,p.id,v.id,coalesce(bs.quantity,0),coalesce(bs.reorder_level,0)
    from public.products p join public.branches b on b.id=v_branch
    left join public.product_variants v on v.product_id=p.id and p.variants_enabled
    left join public.branch_stock_balances bs on bs.branch_id=v_branch and bs.product_id=p.id and bs.variant_id is not distinct from v.id
   where p.stock_tracking_enabled and (not p.variants_enabled or v.id is not null);
end
$function$;

-- ── RLS and grants ─────────────────────────────────────────────────────────
-- RLS cannot invoke the deliberately private branch_member_can helper as the
-- browser role. This narrow definer exposes only the yes/no read decision for
-- the signed-in user and named branch; no caller-supplied user id is accepted.
create or replace function public.can_read_branch_stock(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select public.can_access_branch(p_branch_id) and (
    public.branch_member_can(auth.uid(),p_branch_id,'view_inventory')
    or public.branch_member_can(auth.uid(),p_branch_id,'adjust_stock')
    or public.branch_member_can(auth.uid(),p_branch_id,'sell')
  )
$function$;

alter table public.branch_stock_balances enable row level security;
alter table public.stock_transfers enable row level security;
drop policy if exists branch_stock_select_members on public.branch_stock_balances;
create policy branch_stock_select_members on public.branch_stock_balances for select to authenticated
using(public.can_read_branch_stock(branch_id));
drop policy if exists branch_stock_select_storefront on public.branch_stock_balances;
drop policy if exists stock_transfers_select_members on public.stock_transfers;
create policy stock_transfers_select_members on public.stock_transfers for select to authenticated
using((source_branch_id=public.current_branch_id() or destination_branch_id=public.current_branch_id()) and public.can('view_inventory'));

revoke all on public.branch_stock_balances,public.stock_transfers from public,anon,authenticated;
grant select on public.branch_stock_balances to authenticated,service_role;
revoke all on function public.can_read_branch_stock(uuid) from public,anon;
grant execute on function public.can_read_branch_stock(uuid) to authenticated,service_role;
grant select on public.stock_transfers to authenticated,service_role;
revoke all on function public.inventory_transfer_stock(text,uuid,uuid,uuid,integer,text) from public,anon;
grant execute on function public.inventory_transfer_stock(text,uuid,uuid,uuid,integer,text) to authenticated,service_role;
revoke all on function public.inventory_branch_stock(uuid) from public,anon;
grant execute on function public.inventory_branch_stock(uuid) to authenticated,service_role;
revoke all on function public.inventory_adjust_stock(text,uuid,uuid,text,text,integer,text) from public,anon;
grant execute on function public.inventory_adjust_stock(text,uuid,uuid,text,text,integer,text) to authenticated,service_role;

comment on column public.products.stock_quantity is
  'Compatibility aggregate across branch_stock_balances. Never operational authority after migration 0078.';
comment on column public.product_variants.stock_quantity is
  'Compatibility aggregate across branch_stock_balances for this exact variant. Never operational authority after migration 0078.';
comment on function public.inventory_transfer_stock(text,uuid,uuid,uuid,integer,text) is
  'Atomically moves one exact branch shelf between two authorized branches and replays by source-branch client_ref without one-sided completion.';

commit;

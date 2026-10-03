-- 0080 — Branch-authoritative selling, storefront, stocktakes and backup
--
-- 0078 established the shelf of record. This migration moves the remaining
-- operational boundaries onto it: POS preflight, reservation floors, public
-- default-branch availability, live stocktakes, safe variant consolidation and
-- backup coverage. Legacy aggregate columns remain output-only compatibility.

begin;

-- Backup restore keeps the append-only audit log in place while replacing its
-- referenced branches inside the same transaction. RESTRICT fires too early for
-- that safe delete/reinsert cycle; deferred NO ACTION still refuses a branch
-- that is absent at commit and preserves every historical branch identifier.
alter table public.audit_log drop constraint if exists audit_log_branch_id_fkey;
alter table public.audit_log
  add constraint audit_log_branch_id_fkey foreign key (branch_id)
  references public.branches(id) on delete no action deferrable initially deferred;

-- Product/POS repositories need the active-branch quantity even for a narrowly
-- scoped catalogue seat. This remains membership-bound and exposes no cost or
-- cross-branch data; direct balance-table RLS keeps its stricter inventory gate.
create or replace function public.inventory_branch_stock(p_branch_id uuid default null)
returns table(
  branch_id uuid,branch_code text,branch_name_en text,branch_name_ar text,
  product_id uuid,variant_id uuid,quantity integer,reorder_level integer
)
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=coalesce(p_branch_id,public.current_branch_id());
begin
  if auth.uid() is null or v_branch is null then raise exception 'Branch stock access denied' using errcode='42501'; end if;
  if not public.can_access_branch(v_branch) or not (
    public.branch_member_can(auth.uid(),v_branch,'view_inventory')
    or public.branch_member_can(auth.uid(),v_branch,'adjust_stock')
    or public.branch_member_can(auth.uid(),v_branch,'sell')
    or public.branch_member_can(auth.uid(),v_branch,'view_products')
  ) then raise exception 'Branch stock access denied' using errcode='42501'; end if;
  return query
  select v_branch,b.code,b.name_en,b.name_ar,p.id,v.id,coalesce(bs.quantity,0),coalesce(bs.reorder_level,0)
    from public.products p join public.branches b on b.id=v_branch
    left join public.product_variants v on v.product_id=p.id and p.variants_enabled
    left join public.branch_stock_balances bs on bs.branch_id=v_branch and bs.product_id=p.id and bs.variant_id is not distinct from v.id
   where p.stock_tracking_enabled and (not p.variants_enabled or v.id is not null);
end
$function$;

-- Restore the new shelf table without product/variant opening-stock triggers
-- manufacturing a second copy before the backed-up balances are inserted.
do $block$
begin
  if to_regprocedure('public.admin_restore_document_branch_legacy(jsonb)') is null
     and to_regprocedure('public.admin_restore_document(jsonb)') is not null then
    alter function public.admin_restore_document(jsonb)
      rename to admin_restore_document_branch_legacy;
  end if;
end
$block$;

create or replace function public.admin_restore_document(p_document jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare v_previous text:=current_setting('alyq.backup_restore',true); v_result jsonb;
begin
  perform set_config('alyq.backup_restore','on',true);
  v_result:=public.admin_restore_document_branch_legacy(p_document);
  perform set_config('alyq.backup_restore',coalesce(v_previous,''),true);
  return v_result;
exception when others then
  perform set_config('alyq.backup_restore',coalesce(v_previous,''),true);
  raise;
end
$function$;
revoke all on function public.admin_restore_document(jsonb) from public;
grant execute on function public.admin_restore_document(jsonb) to authenticated;

create or replace function public.sync_default_branch_membership()
returns trigger language plpgsql security definer set search_path=public
as $function$
declare v_default uuid;
begin
  if current_setting('alyq.backup_restore',true)='on' then return new; end if;
  select id into v_default from public.branches where is_default limit 1;
  if v_default is null then return new; end if;
  insert into public.branch_memberships(
    user_id,branch_id,role,custom_role_id,extra_capabilities,denied_capabilities,active
  ) values(
    new.id,v_default,new.role,new.custom_role_id,
    coalesce(new.extra_capabilities,'{}'),coalesce(new.denied_capabilities,'{}'),new.active
  ) on conflict(user_id,branch_id) do update set
    role=excluded.role,custom_role_id=excluded.custom_role_id,
    extra_capabilities=excluded.extra_capabilities,
    denied_capabilities=excluded.denied_capabilities,active=excluded.active;
  if new.active_branch_id is null then
    update public.profiles set active_branch_id=v_default where id=new.id;
  end if;
  return new;
end
$function$;

create or replace function public.product_opening_branch_stock()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_branch uuid;
begin
  if current_setting('alyq.backup_restore',true)='on'
     or not new.stock_tracking_enabled or new.variants_enabled then return null; end if;
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

create or replace function public.variant_opening_branch_stock()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_branch uuid;
begin
  if current_setting('alyq.backup_restore',true)='on' then return null; end if;
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

-- ── Reservation floor shared by POS, adjustments, stocktakes and transfers ─
create or replace function public.branch_stock_reserved_floor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare v_held integer; v_converting uuid;
begin
  if new.quantity>=old.quantity then return new; end if;
  begin v_converting:=nullif(current_setting('alyq.online_converting_order',true),'')::uuid;
  exception when invalid_text_representation then v_converting:=null;
  end;
  select coalesce(sum(quantity),0)::integer into v_held
    from public.stock_reservations
   where branch_id=new.branch_id and product_id=new.product_id
     and variant_id is not distinct from new.variant_id and status='reserved'
     and (v_converting is null or online_order_id<>v_converting);
  if new.quantity<v_held then
    raise exception 'Only % unreserved units are available at this branch',greatest(old.quantity-v_held,0)
      using errcode='23514';
  end if;
  return new;
end
$function$;
drop trigger if exists branch_stock_reserved_floor on public.branch_stock_balances;
create trigger branch_stock_reserved_floor
before update of quantity on public.branch_stock_balances
for each row execute function public.branch_stock_reserved_floor();

-- Wrap the latest POS implementation rather than rebuilding it. The wrapper
-- locks and verifies every exact active-branch shelf first; the preserved RPC
-- continues to own prices, promotions, payments, shifts, invoices and retries.
do $rename_pos$
begin
  if to_regprocedure('public.pos_complete_sale_branch_legacy(jsonb,uuid)') is null then
    alter function public.pos_complete_sale(jsonb,uuid) rename to pos_complete_sale_branch_legacy;
  end if;
end
$rename_pos$;

create or replace function public.pos_complete_sale(p_payload jsonb,p_approval_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid:=public.current_branch_id();
  v_client_ref text:=nullif(btrim(coalesce(p_payload->>'client_ref','')),'');
  v_source text:=coalesce(p_payload->>'source','pos');
  v_order uuid;
  v_line record;
  v_stock integer;
  v_held integer;
  v_previous text:=current_setting('alyq.online_converting_order',true);
  v_result jsonb;
begin
  if auth.uid() is null or v_branch is null then raise exception 'An active selling branch is required' using errcode='42501'; end if;
  -- Let the preserved implementation adjudicate an already-completed retry.
  if exists(select 1 from public.sales where branch_id=v_branch and client_ref=v_client_ref) then
    return public.pos_complete_sale_branch_legacy(p_payload,p_approval_request_id);
  end if;
  if v_source='online' and v_client_ref like 'online-%' then
    begin v_order:=replace(v_client_ref,'online-','')::uuid;
    exception when invalid_text_representation then v_order:=null;
    end;
    if v_order is null or not exists(select 1 from public.online_orders where id=v_order and branch_id=v_branch) then
      raise exception 'Online sale does not belong to the active branch' using errcode='42501';
    end if;
  end if;

  -- Group duplicate payload lines before comparing availability.
  for v_line in
    select (x->>'product_id')::uuid product_id,
           nullif(x->>'variant_id','')::uuid variant_id,
           sum((x->>'qty')::integer)::integer quantity
      from jsonb_array_elements(coalesce(p_payload->'lines','[]'::jsonb)) x
     group by 1,2
     order by 1,2 nulls first
  loop
    insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
    select v_branch,p.id,v_line.variant_id,0,
           case when v_line.variant_id is null then p.low_stock_level else coalesce(v.low_stock_level,0) end
      from public.products p left join public.product_variants v on v.id=v_line.variant_id
     where p.id=v_line.product_id
    on conflict do nothing;
    select quantity into v_stock from public.branch_stock_balances
     where branch_id=v_branch and product_id=v_line.product_id
       and variant_id is not distinct from v_line.variant_id for update;
    select coalesce(sum(quantity),0)::integer into v_held from public.stock_reservations
     where branch_id=v_branch and product_id=v_line.product_id
       and variant_id is not distinct from v_line.variant_id and status='reserved'
       and (v_order is null or online_order_id<>v_order);
    if coalesce(v_stock,0)-v_held<v_line.quantity then
      raise exception 'Only % unreserved units are available at the active branch',greatest(coalesce(v_stock,0)-v_held,0)
        using errcode='23514';
    end if;
  end loop;
  perform set_config('alyq.online_converting_order',coalesce(v_order::text,''),true);
  v_result:=public.pos_complete_sale_branch_legacy(p_payload,p_approval_request_id);
  perform set_config('alyq.online_converting_order',coalesce(v_previous,''),true);
  return v_result;
end
$function$;

revoke all on function public.pos_complete_sale_branch_legacy(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.pos_complete_sale(jsonb,uuid) from public,anon;
grant execute on function public.pos_complete_sale(jsonb,uuid) to authenticated,service_role;

-- ── Explicit default-branch storefront fulfillment ─────────────────────────
create or replace function public.storefront_branch_product_variants()
returns table(
  id uuid,product_id uuid,sku text,barcode text,color_key text,color_ar text,color_en text,color_hex text,
  size numeric,size_label text,size_value text,size_sort_order integer,image_url text,price_override numeric,
  stock_quantity integer,active boolean,sort_order integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select v.id,v.product_id,v.sku,v.barcode,v.color_key,v.color_ar,v.color_en,v.color_hex,
         v.size,v.size_label,v.size_value,v.size_sort_order,v.image_url,v.price_override,
         coalesce(bs.quantity,0),v.active,v.sort_order
    from public.product_variants v
    join public.products p on p.id=v.product_id
    cross join lateral(select id from public.branches where is_default and active order by created_at,id limit 1) b
    left join public.branch_stock_balances bs on bs.branch_id=b.id and bs.variant_id=v.id
   where p.active and p.show_on_website and p.variants_enabled and v.active
   order by v.product_id,v.color_key,v.size_sort_order,lower(v.size_value),v.sort_order
$function$;

create or replace function public.storefront_catalogue()
returns table(
  id uuid,sku text,barcode text,name_ar text,name_en text,description_ar text,description_en text,
  category_id uuid,product_type public.product_type,selling_price numeric,tax_rate numeric,
  stock_tracking_enabled boolean,stock_quantity integer,show_on_website boolean,is_featured boolean,
  active boolean,image_url text,images text[],created_at timestamptz,updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p.id,p.sku,p.barcode,p.name_ar,p.name_en,p.description_ar,p.description_en,p.category_id,
         p.product_type,p.selling_price,p.tax_rate,p.stock_tracking_enabled,
         case when p.variants_enabled then coalesce((select sum(bs.quantity)::integer from public.branch_stock_balances bs where bs.branch_id=b.id and bs.product_id=p.id and bs.variant_id is not null),0)
              else coalesce(bs_plain.quantity,0) end,
         p.show_on_website,p.is_featured,p.active,p.image_url,p.images,p.created_at,p.updated_at
    from public.products p
    cross join lateral(select id from public.branches where is_default and active order by created_at,id limit 1) b
    left join public.branch_stock_balances bs_plain on bs_plain.branch_id=b.id and bs_plain.product_id=p.id and bs_plain.variant_id is null
   where p.active and p.show_on_website
   order by p.is_featured desc,p.name_en
$function$;

revoke all on function public.storefront_branch_product_variants() from public;
grant execute on function public.storefront_branch_product_variants() to anon,authenticated,service_role;
revoke all on function public.storefront_catalogue() from public;
grant execute on function public.storefront_catalogue() to anon,authenticated,service_role;

-- ── Branch-correct live stocktakes ─────────────────────────────────────────
create or replace function public.stocktake_create(p_blind boolean default false,p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor text; v_name text; v_id uuid:=gen_random_uuid(); v_ref text; v_branch uuid:=public.current_branch_id();
  v_shelf record; v_lines integer:=0; v_label text;
begin
  select a.actor_id,a.actor_name into v_actor,v_name from public.stocktake_assert_adjust() a;
  if v_branch is null then raise exception 'An active stocktake branch is required' using errcode='42501'; end if;
  if p_note is not null and char_length(btrim(p_note))>500 then raise exception 'Stocktake note is too long' using errcode='23514'; end if;
  v_ref:='ST-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,8));
  insert into public.stocktakes(id,reference,status,blind,note,created_by,created_by_name,branch_id)
  values(v_id,v_ref,'counting',coalesce(p_blind,false),nullif(btrim(p_note),''),v_actor,v_name,v_branch);

  for v_shelf in
    select p.id product_id,p.name_ar,p.name_en,
           case when p.variants_enabled then v.id else null end variant_id,
           case when p.variants_enabled then v.sku else p.sku end sku,
           case when p.variants_enabled then v.barcode else p.barcode end barcode,
           v.color_en,v.color_ar,v.size,v.size_value,
           coalesce(bs.quantity,0) quantity
      from public.products p
      left join public.product_variants v on v.product_id=p.id and p.variants_enabled and v.active
      left join public.branch_stock_balances bs on bs.branch_id=v_branch and bs.product_id=p.id
        and bs.variant_id is not distinct from(case when p.variants_enabled then v.id else null end)
     where p.active and p.stock_tracking_enabled and (not p.variants_enabled or v.id is not null)
     order by p.sku,v.color_key,v.size_sort_order,v.sku
  loop
    v_label:=case when v_shelf.variant_id is null then '' else
      concat_ws(' / ',coalesce(v_shelf.color_en,v_shelf.color_ar),v_shelf.size_value) end;
    insert into public.stocktake_lines(
      stocktake_id,product_id,variant_id,shelf_key,sku,barcode,product_name_ar,product_name_en,variant_label,expected_quantity
    ) values(v_id,v_shelf.product_id,v_shelf.variant_id,coalesce(v_shelf.variant_id,v_shelf.product_id)::text,
      v_shelf.sku,v_shelf.barcode,v_shelf.name_ar,v_shelf.name_en,v_label,v_shelf.quantity);
    v_lines:=v_lines+1;
  end loop;
  if v_lines=0 then raise exception 'There is no tracked stock to count' using errcode='23514'; end if;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id)
  values('stocktake.created','stocktake',v_id::text,v_ref,jsonb_build_object('lines',v_lines,'blind',coalesce(p_blind,false)),v_actor,v_name,v_branch);
  return jsonb_build_object('ok',true,'session',public.stocktake_document(v_id));
end
$function$;

create or replace function public.stocktake_finalize(p_stocktake_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor text; v_name text; v_branch uuid:=public.current_branch_id(); v_row public.stocktakes%rowtype;
  v_line public.stocktake_lines%rowtype; v_variant public.product_variants%rowtype;
  v_current integer; v_conflicts jsonb:='[]'::jsonb; v_delta integer; v_type public.stock_movement_type;
  v_movement uuid; v_written integer:=0;
begin
  select a.actor_id,a.actor_name into v_actor,v_name from public.stocktake_assert_adjust() a;
  select * into v_row from public.stocktakes where id=p_stocktake_id for update;
  if not found then return jsonb_build_object('ok',false,'code','STOCKTAKE_NOT_FOUND'); end if;
  if v_row.branch_id is distinct from v_branch then raise exception 'Stocktake belongs to another branch' using errcode='42501'; end if;
  if v_row.status='finalized' then return jsonb_build_object('ok',false,'code','STOCKTAKE_FINALIZED','session',public.stocktake_document(v_row.id)); end if;
  if not exists(select 1 from public.stocktake_lines where stocktake_id=v_row.id) then return jsonb_build_object('ok',false,'code','STOCKTAKE_EMPTY'); end if;
  if exists(select 1 from public.stocktake_lines where stocktake_id=v_row.id and physical_quantity is null) then return jsonb_build_object('ok',false,'code','STOCKTAKE_INCOMPLETE'); end if;

  for v_line in select * from public.stocktake_lines where stocktake_id=v_row.id order by product_id,variant_id nulls first,id loop
    insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
    select v_branch,p.id,v_line.variant_id,0,case when v_line.variant_id is null then p.low_stock_level else coalesce(v.low_stock_level,0) end
      from public.products p left join public.product_variants v on v.id=v_line.variant_id where p.id=v_line.product_id
    on conflict do nothing;
    select quantity into v_current from public.branch_stock_balances
     where branch_id=v_branch and product_id=v_line.product_id and variant_id is not distinct from v_line.variant_id for update;
    if v_current is distinct from v_line.expected_quantity then
      v_conflicts:=v_conflicts||jsonb_build_array(jsonb_build_object('line_id',v_line.id,'sku',v_line.sku,
        'product_id',v_line.product_id,'variant_id',v_line.variant_id,'expected',v_line.expected_quantity,'current',v_current));
    end if;
  end loop;
  if jsonb_array_length(v_conflicts)>0 then
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id)
    values('stocktake.conflict','stocktake',v_row.id::text,v_row.reference,jsonb_build_object('conflicts',v_conflicts),v_actor,v_name,v_branch);
    return jsonb_build_object('ok',false,'code','STOCKTAKE_CONFLICT','conflicts',v_conflicts,'session',public.stocktake_document(v_row.id));
  end if;

  for v_line in select * from public.stocktake_lines where stocktake_id=v_row.id and physical_quantity is distinct from expected_quantity order by product_id,variant_id nulls first,id loop
    v_delta:=abs(v_line.physical_quantity-v_line.expected_quantity);
    v_type:=case when v_line.physical_quantity>v_line.expected_quantity then 'adjustment_in'::public.stock_movement_type else 'adjustment_out'::public.stock_movement_type end;
    update public.branch_stock_balances set quantity=v_line.physical_quantity
     where branch_id=v_branch and product_id=v_line.product_id and variant_id is not distinct from v_line.variant_id and quantity=v_line.expected_quantity;
    if not found then raise exception 'Stock changed while the stocktake was finalizing' using errcode='40001'; end if;
    if v_line.variant_id is not null then select * into v_variant from public.product_variants where id=v_line.variant_id; end if;
    insert into public.stock_movements(
      product_id,variant_id,variant_color_ar,variant_color_en,variant_size,variant_size_label,
      delta,quantity_before,quantity_after,type,reason,notes,user_id,user_name,branch_id,source_type,source_id,reference
    ) values(
      v_line.product_id,v_line.variant_id,
      case when v_line.variant_id is null then null else v_variant.color_ar end,
      case when v_line.variant_id is null then null else v_variant.color_en end,
      case when v_line.variant_id is null then null else v_variant.size end,
      case when v_line.variant_id is null then null else v_variant.size_value end,
      v_delta,v_line.expected_quantity,v_line.physical_quantity,v_type,'recount','Stocktake '||v_row.reference,
      v_actor,v_name,v_branch,'stocktake',v_row.id,v_row.reference
    ) returning id into v_movement;
    update public.stocktake_lines set movement_id=v_movement,movement_reference=v_row.reference where id=v_line.id;
    v_written:=v_written+1;
  end loop;
  perform set_config('alyq.stocktake_finalizing',v_row.id::text,true);
  update public.stocktakes set status='finalized',finalized_at=now(),finalized_by=v_actor,finalized_by_name=v_name where id=v_row.id;
  perform set_config('alyq.stocktake_finalizing','',true);
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id)
  values('stocktake.finalized','stocktake',v_row.id::text,v_row.reference,jsonb_build_object('movements',v_written),v_actor,v_name,v_branch);
  return jsonb_build_object('ok',true,'movements',v_written,'session',public.stocktake_document(v_row.id));
end
$function$;

-- ── Variant rollup marker hygiene and branch-preserving consolidation ──────
create or replace function public.variants_sync_product_stock()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product_id uuid:=case when tg_op='DELETE' then old.product_id else new.product_id end;
  v_total integer; v_enabled boolean; v_previous text:=current_setting('alyq.variant_rollup_product',true);
begin
  select variants_enabled into v_enabled from public.products where id=v_product_id;
  if not coalesce(v_enabled,false) then return null; end if;
  select coalesce(sum(stock_quantity),0)::integer into v_total from public.product_variants where product_id=v_product_id;
  perform set_config('alyq.variant_rollup_product',v_product_id::text,true);
  update public.products set stock_quantity=v_total,updated_at=now() where id=v_product_id and stock_quantity is distinct from v_total;
  perform set_config('alyq.variant_rollup_product',coalesce(v_previous,''),true);
  return null;
end
$function$;

-- Preserve per-branch totals before the old disable function deletes exact rows.
-- The marker lets the compatibility product update pass without adding the
-- consolidated total a second time to the actor's branch.
create or replace function public.disable_product_variants(
  p_product_id uuid,p_consolidated_stock numeric,p_user_id text default null,p_user_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product public.products%rowtype; v_total integer; v_active integer; v_refs integer; v_holds integer;
  v_wanted integer; v_actor text:=coalesce(auth.uid()::text,p_user_id,''); v_name text:=coalesce(p_user_name,v_actor);
  v_previous text:=current_setting('alyq.branch_stock_rollup',true);
begin
  if not public.can('edit_product') then raise exception 'Switching a product off variant stock requires edit_product' using errcode='42501'; end if;
  select * into v_product from public.products where id=p_product_id for update;
  if not found then raise exception 'Product not found' using errcode='23503'; end if;
  if not v_product.variants_enabled then return jsonb_build_object('product_id',p_product_id,'changed',false,'variants_enabled',false); end if;
  select coalesce(sum(stock_quantity),0)::integer,count(*) filter(where active) into v_total,v_active from public.product_variants where product_id=p_product_id;
  select (select count(*) from public.sale_items where variant_id in(select id from public.product_variants where product_id=p_product_id))+
         (select count(*) from public.return_items where variant_id in(select id from public.product_variants where product_id=p_product_id))+
         (select count(*) from public.stock_movements where variant_id in(select id from public.product_variants where product_id=p_product_id))+
         (select count(*) from public.online_order_items where variant_id in(select id from public.product_variants where product_id=p_product_id))+
         (select count(*) from public.stock_reservations where variant_id in(select id from public.product_variants where product_id=p_product_id)) into v_refs;
  if v_refs>0 then raise exception 'Product % has % historical record(s) naming its variants — it stays in variant mode; archive the combinations instead',v_product.sku,v_refs using errcode='23001'; end if;
  select count(*) into v_holds from public.stock_reservations where status='reserved' and variant_id in(select id from public.product_variants where product_id=p_product_id);
  if v_holds>0 then raise exception 'Product still has open stock holds' using errcode='23001'; end if;
  v_wanted:=coalesce(p_consolidated_stock,v_total)::integer;
  if v_product.stock_tracking_enabled and v_wanted<>v_total then raise exception 'The consolidated figure is %, but the variants hold % — nothing is created or destroyed by switching back',v_wanted,v_total using errcode='23514'; end if;

  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  select branch_id,p_product_id,null,sum(quantity)::integer,max(reorder_level)::integer
    from public.branch_stock_balances where product_id=p_product_id and variant_id is not null group by branch_id
  on conflict(branch_id,product_id) where variant_id is null do update set quantity=excluded.quantity,reorder_level=excluded.reorder_level;
  delete from public.product_variants where product_id=p_product_id;
  perform set_config('alyq.branch_stock_rollup',p_product_id::text,true);
  update public.products set variants_enabled=false,stock_quantity=case when stock_tracking_enabled then v_total else stock_quantity end,updated_at=now() where id=p_product_id;
  perform set_config('alyq.branch_stock_rollup',coalesce(v_previous,''),true);
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name)
  values('product.variants_disabled','product',p_product_id::text,v_product.sku,
    jsonb_build_object('sku',v_product.sku,'product',v_product.name_en,'units',v_total,'variants',v_active),v_actor,v_name);
  return jsonb_build_object('product_id',p_product_id,'changed',true,'variants_enabled',false,'units',v_total);
end
$function$;

-- ── Backup now carries branch authority and colour galleries ────────────────
create or replace function public.backup_table_order()
returns text[] language sql immutable set search_path=public as $function$
  select array[
    'approval_counters','refund_counters','return_counters','sale_counters','role_aliases','role_capabilities','audit_actions','approval_rules',
    'branches','campaigns','coupons','delivery_zones','promotions','store_faqs','website_settings','categories','custom_roles','customers','store_customers','shifts',
    'products','product_variants','product_color_images','branch_stock_balances','catalogue_codes','profiles','branch_memberships','operation_policies','manager_credentials','manager_pin_attempts',
    'expenses','sales','audit_log','online_orders','sales_returns','stocktakes','stock_transfers','promotion_targets','sale_items','sale_payments','cash_movements','stock_movements','stocktake_lines',
    'product_content','storefront_category_content','store_reviews','online_order_items','order_events','stock_reservations','promo_code_usages','return_items','refund_records','approval_requests','cleanup_previews'
  ]
$function$;
create or replace function public.backup_restore_order()
returns text[] language sql immutable set search_path=public as $function$
  select coalesce(array(select t from unnest(public.backup_table_order()) with ordinality x(t,n)
    where t<>all(array['role_aliases','role_capabilities','audit_actions','audit_log','catalogue_codes']) order by n),'{}')
$function$;

comment on function public.pos_complete_sale(jsonb,uuid) is
  'Preserves the central POS authority while preflighting and locking exact active-branch shelves, excluding only the approving online order own holds, and replaying safely.';
comment on function public.stocktake_create(boolean,text) is
  'Snapshots every exact tracked shelf at the active branch. Missing branch rows are zero, never another branch stock.';
comment on function public.stocktake_finalize(uuid) is
  'Atomically reconciles the active branch balances and branch movement ledger, rejecting stale or cross-branch counts.';

commit;

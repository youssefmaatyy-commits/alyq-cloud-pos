-- 0081 — Safe offline-sale replay contract and authenticated system health probe
--
-- Offline remains deliberately narrow: one cash payment, no coupon, promotion,
-- manual discount or approval. Browser evidence is compared with server facts;
-- it is never accepted as price authority. Existing pos_complete_sale remains
-- the only writer and keeps stock/payment/client_ref idempotency.

begin;

create or replace function public.pos_sync_offline_sale(p_payload jsonb,p_evidence jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_branch uuid:=public.current_branch_id();
  v_ref text:=nullif(btrim(coalesce(p_payload->>'client_ref','')),'');
  v_existing uuid;
  v_line jsonb;
  v_evidence_line jsonb;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_variant_id uuid;
  v_qty integer;
  v_unit numeric(14,2);
  v_subtotal numeric(14,2):=0;
  v_pricing_lines jsonb:='[]'::jsonb;
  v_pricing jsonb;
  v_index integer:=0;
  v_payment jsonb;
begin
  if auth.uid() is null or v_branch is null or not public.can('sell')
     or not public.can_access_branch(v_branch) then
    raise exception 'Offline sale sync is not permitted in the active branch' using errcode='42501';
  end if;
  if v_ref is null then raise exception 'Offline sale client reference is required' using errcode='23514'; end if;

  -- Lost-response retry: authoritative completion wins before any later price
  -- change can turn an already-committed sale into a false conflict.
  select id into v_existing from public.sales where branch_id=v_branch and client_ref=v_ref;
  if v_existing is not null then
    return public.pos_complete_sale(p_payload,null);
  end if;

  if coalesce((p_evidence->>'schema_version')::integer,0)<>1
     or nullif(p_evidence->>'branch_id','')::uuid is distinct from v_branch then
    raise exception 'Offline schema or original branch conflict' using errcode='23514';
  end if;
  if coalesce(p_payload->>'source','pos')<>'pos'
     or nullif(btrim(coalesce(p_payload->>'coupon_code',p_payload->>'promo_code','')),'') is not null
     or coalesce(p_payload->>'discount_type','none')<>'none'
     or coalesce((p_payload->>'discount_value')::numeric,0)<>0 then
    raise exception 'Offline sale contains an online-only pricing or approval operation' using errcode='23514';
  end if;
  if jsonb_array_length(coalesce(p_payload->'payments','[]'::jsonb))<>1 then
    raise exception 'Offline sale requires one cash payment' using errcode='23514';
  end if;
  v_payment:=p_payload->'payments'->0;
  if coalesce(v_payment->>'method','')<>'cash' or coalesce(v_payment->>'status','')<>'paid' then
    raise exception 'Offline sale requires one paid cash payment' using errcode='23514';
  end if;
  if jsonb_array_length(coalesce(p_payload->'lines','[]'::jsonb))=0
     or jsonb_array_length(coalesce(p_payload->'lines','[]'::jsonb))<>
        jsonb_array_length(coalesce(p_evidence->'lines','[]'::jsonb)) then
    raise exception 'Offline pricing evidence does not match sale lines' using errcode='23514';
  end if;

  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_evidence_line:=p_evidence->'lines'->v_index;
    v_qty:=coalesce((v_line->>'qty')::integer,0);
    v_variant_id:=public.variant_id_of(v_line->>'variant_id');
    if v_qty<=0
       or v_evidence_line->>'product_id' is distinct from v_line->>'product_id'
       or nullif(v_evidence_line->>'variant_id','')::uuid is distinct from v_variant_id
       or coalesce((v_evidence_line->>'qty')::integer,0)<>v_qty then
      raise exception 'Offline pricing evidence line identity conflict' using errcode='23514';
    end if;
    if coalesce(v_line->>'discount_type','none')<>'none'
       or coalesce((v_line->>'discount_value')::numeric,0)<>0 then
      raise exception 'Offline item discount requires an online authority check' using errcode='23514';
    end if;

    select * into v_product from public.products
     where id=nullif(v_line->>'product_id','')::uuid for update;
    if not found or not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Offline stock conflict: product is unavailable' using errcode='23514';
    end if;
    if v_product.variants_enabled then
      select * into v_variant from public.product_variants
       where id=v_variant_id and product_id=v_product.id for update;
      if not found or not v_variant.active then
        raise exception 'Offline stock conflict: exact variant is unavailable' using errcode='23514';
      end if;
      if v_evidence_line->>'sku' is distinct from v_variant.sku
         or nullif(v_evidence_line->>'barcode','') is distinct from v_variant.barcode
         or nullif(v_evidence_line->>'color_ar','') is distinct from v_variant.color_ar
         or nullif(v_evidence_line->>'color_en','') is distinct from v_variant.color_en
         or nullif(v_evidence_line->>'size_value','') is distinct from v_variant.size_value then
        raise exception 'Offline evidence conflict: exact SKU, barcode, color or size changed' using errcode='23514';
      end if;
      v_unit:=coalesce(v_variant.price_override,v_product.selling_price);
    elsif v_variant_id is not null then
      raise exception 'Offline stock conflict: unexpected variant' using errcode='23514';
    else
      if v_evidence_line->>'sku' is distinct from v_product.sku
         or nullif(v_evidence_line->>'barcode','') is distinct from v_product.barcode
         or nullif(v_evidence_line->>'color_ar','') is not null
         or nullif(v_evidence_line->>'color_en','') is not null
         or nullif(v_evidence_line->>'size_value','') is not null then
        raise exception 'Offline evidence conflict: exact product identity changed' using errcode='23514';
      end if;
      v_unit:=v_product.selling_price;
    end if;
    if round(coalesce((v_evidence_line->>'unit_price')::numeric,-1),2)<>round(v_unit,2) then
      raise exception 'Offline pricing conflict: catalogue price changed' using errcode='23514';
    end if;
    v_subtotal:=v_subtotal+round(v_unit*v_qty,2);
    v_pricing_lines:=v_pricing_lines||jsonb_build_array(jsonb_build_object(
      'product_id',v_product.id,'category_id',v_product.category_id,
      'variant_id',v_variant_id,'qty',v_qty,'unit_price',v_unit,'line_total',round(v_unit*v_qty,2)
    ));
    v_index:=v_index+1;
  end loop;

  -- If a promotion became applicable while the till was offline, do not
  -- silently reprice history. The operation remains a visible conflict.
  v_pricing:=public.evaluate_order_pricing_channel(
    v_subtotal,v_pricing_lines,null,null,'{}'::jsonb,'{}'::jsonb,'pickup',false,'pos'
  );
  if coalesce((v_pricing->>'auto_discount')::numeric,0)<>0
     or round(coalesce((p_evidence->>'subtotal')::numeric,-1),2)<>round(v_subtotal,2)
     or round(coalesce((p_evidence->>'discount_amount')::numeric,-1),2)<>0
     or round(coalesce((p_evidence->>'total')::numeric,-1),2)<>round(v_subtotal,2)
     or round(coalesce((v_payment->>'amount')::numeric,-1),2)<>round(v_subtotal,2) then
    raise exception 'Offline pricing conflict: totals or promotions changed' using errcode='23514';
  end if;

  return public.pos_complete_sale(p_payload,null);
end
$function$;

revoke all on function public.pos_sync_offline_sale(jsonb,jsonb) from public,anon;
grant execute on function public.pos_sync_offline_sale(jsonb,jsonb) to authenticated,service_role;
comment on function public.pos_sync_offline_sale(jsonb,jsonb) is
  'Validates immutable branch/identity/price evidence for a narrow offline cash sale, then delegates atomically to idempotent pos_complete_sale.';

create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=public.current_branch_id();
begin
  if auth.uid() is null then raise exception 'Authenticated health check required' using errcode='42501'; end if;
  return jsonb_build_object(
    'authenticated',true,
    'server_time',now(),
    'migration','0081_offline_sync_health.sql',
    'migration_count',81,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch)
  );
end
$function$;
revoke all on function public.system_health_probe() from public,anon;
grant execute on function public.system_health_probe() to authenticated,service_role;
comment on function public.system_health_probe() is
  'Lightweight authenticated reachability/schema/active-branch fact. Returns no secrets and performs no repair or migration.';

commit;

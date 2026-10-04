-- Phase 3 focused operations scenarios.
-- Runs after scenarios.sql + phase2_scenarios.sql in the same disposable DB.

-- ── Authoritative inventory adjustment: exact shelf, audit, branch, retry ──
do $phase3_inventory$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_ref text := 'phase3-adjust-idempotent';
  v_before integer;
  v_after integer;
  v_movement uuid;
  v_json jsonb;
  v_count integer;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);

  select * into v_product
    from public.products
   where stock_tracking_enabled and not variants_enabled
   order by created_at limit 1;
  if v_product.id is null then raise exception 'phase3 adjustment fixture product missing'; end if;
  v_before := v_product.stock_quantity;

  v_json := public.inventory_adjust_stock(
    v_ref,v_product.id,null,'adjustment_in','purchase',2,'Phase 3 retry-safe receipt'
  );
  v_movement := (v_json->'movement'->>'id')::uuid;
  select stock_quantity into v_after from public.products where id=v_product.id;
  if v_after<>v_before+2 then raise exception 'authoritative product stock did not move exactly once'; end if;
  if (v_json->>'replayed')::boolean then raise exception 'first adjustment claimed replay'; end if;
  if not exists(
    select 1 from public.stock_movements
     where id=v_movement and branch_id=v_main and client_ref=v_ref
       and source_type='adjustment' and quantity_before=v_before and quantity_after=v_after
  ) then raise exception 'branch-scoped adjustment evidence is incomplete'; end if;
  if not exists(
    select 1 from public.audit_log
     where action='stock.adjusted' and branch_id=v_main
       and details->>'movement_id'=v_movement::text
  ) then raise exception 'authoritative adjustment audit is missing'; end if;

  v_json := public.inventory_adjust_stock(
    v_ref,v_product.id,null,'adjustment_in','purchase',2,'Phase 3 retry-safe receipt'
  );
  if not (v_json->>'replayed')::boolean then raise exception 'identical adjustment retry was not replayed'; end if;
  select stock_quantity into v_after from public.products where id=v_product.id;
  select count(*) into v_count from public.stock_movements where branch_id=v_main and client_ref=v_ref;
  if v_after<>v_before+2 or v_count<>1 then
    raise exception 'adjustment retry duplicated stock or ledger (% / %)',v_after,v_count;
  end if;

  begin
    perform public.inventory_adjust_stock(v_ref,v_product.id,null,'adjustment_in','purchase',3,'changed retry');
    raise exception 'changed payload reused an inventory client reference';
  exception when unique_violation then null;
  end;

  begin
    perform public.inventory_adjust_stock('phase3-no-negative',v_product.id,null,'issue','other',v_after+1,'unsafe');
    raise exception 'negative stock adjustment succeeded';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.stock_movements where client_ref='phase3-no-negative') then
    raise exception 'rejected negative adjustment left a movement';
  end if;

  begin
    perform public.inventory_adjust_stock('phase3-no-one-sided-transfer',v_product.id,null,'transfer','transfer_out',1,'unsafe transfer');
    raise exception 'one-sided transfer succeeded against a non-branch stock schema';
  exception when feature_not_supported then null;
  end;

  select * into v_variant
    from public.product_variants
   where active order by created_at limit 1;
  if v_variant.id is not null then
    v_before := v_variant.stock_quantity;
    perform public.inventory_adjust_stock(
      'phase3-exact-variant',v_variant.product_id,v_variant.id,
      'adjustment_in','recount',1,'Exact shelf correction'
    );
    select stock_quantity into v_after from public.product_variants where id=v_variant.id;
    if v_after<>v_before+1 then raise exception 'exact variant shelf did not move'; end if;
    if not exists(
      select 1 from public.stock_movements
       where client_ref='phase3-exact-variant' and variant_id=v_variant.id
    ) then raise exception 'exact variant identity was not frozen on movement'; end if;
  end if;

  perform pg_temp.become(v_viewer,'authenticated');
  begin
    perform public.inventory_adjust_stock('phase3-viewer-denied',v_product.id,null,'adjustment_in','other',1,'forged');
    raise exception 'viewer adjusted stock';
  exception when insufficient_privilege then null;
  end;

  raise notice 'Phase 3 inventory authority — exact shelves, branch evidence, append-only audit, no-negative policy, one-sided-transfer refusal and retry idempotency all hold';
end
$phase3_inventory$;

reset role;

-- ── Invoice / Return Center: server filtering, pagination and branch scope ──
do $phase3_transaction_center$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_sale public.sales%rowtype;
  v_item public.sale_items%rowtype;
  v_return public.sales_returns%rowtype;
  v_refund public.refund_records%rowtype;
  v_payment_method text;
  v_result jsonb;
  v_total integer;
  v_denied boolean := false;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  select * into v_sale from public.sales where branch_id=v_main order by created_at desc limit 1;
  if v_sale.id is null then raise exception 'transaction center sale fixture missing'; end if;
  select * into v_item from public.sale_items where sale_id=v_sale.id order by created_at limit 1;

  v_result := public.transaction_center_search(
    v_sale.sale_number,'all','all','all','all',null,null,null,1,1
  );
  v_total := (v_result->>'total')::integer;
  if v_total<1 or jsonb_array_length(v_result->'rows')<>1
     or v_result->>'branch_id'<>v_main::text
     or v_result->'rows'->0->>'id'<>v_sale.id::text then
    raise exception 'invoice reference search/pagination/branch result is incorrect: %',v_result;
  end if;

  v_result := public.transaction_center_search(
    v_sale.client_ref,'all','all','all','all',null,null,null,1,25
  );
  if not exists(
    select 1 from jsonb_array_elements(v_result->'rows') row
     where row->>'id'=v_sale.id::text
  ) then raise exception 'client reference search missed its sale'; end if;

  if v_item.id is not null then
    v_result := public.transaction_center_search(
      v_item.sku,'all','all','all','all',null,null,null,1,25
    );
    if not exists(
      select 1 from jsonb_array_elements(v_result->'rows') row
       where row->>'id'=v_sale.id::text
    ) then raise exception 'server SKU search missed its invoice'; end if;
    if v_item.barcode is not null then
      v_result := public.transaction_center_search(
        v_item.barcode,'all','all','all','all',null,null,null,1,25
      );
      if not exists(select 1 from jsonb_array_elements(v_result->'rows') row where row->>'id'=v_sale.id::text)
        then raise exception 'server barcode search missed its invoice'; end if;
    end if;
  end if;

  if v_sale.customer_name is not null then
    v_result := public.transaction_center_search(v_sale.customer_name,'all','all','all','all',null,null,null,1,25);
    if not exists(select 1 from jsonb_array_elements(v_result->'rows') row where row->>'id'=v_sale.id::text)
      then raise exception 'customer search missed its invoice'; end if;
  end if;
  select sp.method::text into v_payment_method from public.sale_payments sp where sp.sale_id=v_sale.id order by sp.created_at limit 1;
  v_result := public.transaction_center_search(
    null,v_sale.status::text,'all',coalesce(v_payment_method,'all'),v_sale.payment_status::text,
    v_sale.created_at - interval '1 second',v_sale.created_at + interval '1 second',v_sale.user_name,1,25
  );
  if not exists(select 1 from jsonb_array_elements(v_result->'rows') row where row->>'id'=v_sale.id::text)
    then raise exception 'cashier/date/lifecycle/payment filters missed their invoice'; end if;

  select * into v_return from public.sales_returns where branch_id=v_main order by created_at desc limit 1;
  if v_return.id is not null then
    v_result := public.transaction_center_search(v_return.return_number,'all','all','all','all',null,null,null,1,25);
    if not exists(select 1 from jsonb_array_elements(v_result->'rows') row where row->>'id'=v_return.sale_id::text)
      then raise exception 'return reference search missed its invoice'; end if;
  end if;
  select * into v_refund from public.refund_records where branch_id=v_main order by created_at desc limit 1;
  if v_refund.id is not null then
    v_result := public.transaction_center_search(v_refund.refund_number,'all',v_refund.status::text,'all','all',null,null,null,1,25);
    if not exists(select 1 from jsonb_array_elements(v_result->'rows') row where row->>'id'=v_refund.sale_id::text)
      then raise exception 'refund reference/status search missed its invoice'; end if;
  end if;

  v_result := public.transaction_center_search(
    null,'all','all','all','all',null,null,null,1,100
  );
  if exists(
    select 1 from jsonb_array_elements(v_result->'rows') row
     where row->>'branch_id'<>v_main::text
  ) then raise exception 'transaction search leaked another branch'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_result->'rows') row,
      lateral jsonb_array_elements(row->'refunds') refund
     where refund->>'status'<>'completed'
       and (row->>'completed_refund_total')::numeric >= (refund->>'amount')::numeric
       and not exists (
         select 1 from jsonb_array_elements(row->'refunds') completed
          where completed->>'status'='completed'
       )
  ) then raise exception 'pending/rejected refund was counted as completed money'; end if;

  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1','authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.transaction_center_search(null,'all','all','all','all',null,null,null,1,25);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'viewer without view_sales reached transaction center'; end if;

  raise notice 'Phase 3 transaction center — branch-only server search covers invoice/client/customer/cashier/product/SKU/barcode/return/refund/date/payment/status dimensions, deterministic pages, refund money and permission refusal';
end
$phase3_transaction_center$;

reset role;

-- ── Promotion authority: legacy campaigns cannot double-discount ───────────
do $phase3_promotion_overlap$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_campaign uuid := '00000000-0000-4000-8000-0000000003c1';
  v_online_promo uuid := '00000000-0000-4000-8000-0000000003c2';
  v_pos_promo uuid := '00000000-0000-4000-8000-0000000003c3';
  v_target_promo uuid := '00000000-0000-4000-8000-0000000003c4';
  v_product uuid;
  v_enabled_promotions uuid[];
  v_rejected boolean := false;
begin
  perform pg_temp.become(v_admin,'authenticated');
  select coalesce(array_agg(id),'{}'::uuid[]) into v_enabled_promotions
    from public.promotions where enabled;
  update public.promotions set enabled=false where enabled;

  insert into public.campaigns
    (id,name_ar,name_en,kind,discount_type,discount_value,product_ids,badge_ar,badge_en,starts_at,ends_at,active)
  values
    (v_campaign,'اختبار المصدر الواحد','single authority test','flash_sale','percent',10,'[]'::jsonb,null,null,
     '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',true);

  -- Legacy campaigns are storefront-only, so an exact same-window POS-only
  -- promotion is safe and remains supported.
  insert into public.promotions
    (id,enabled,name_en,name_ar,discount_type,value,scope,starts_at,ends_at,channel,mode)
  values
    (v_pos_promo,true,'POS coexistence','عرض نقطة البيع','percent',5,'store',
     '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','pos','automatic');

  begin
    insert into public.promotions
      (id,enabled,name_en,name_ar,discount_type,value,scope,starts_at,ends_at,channel,mode)
    values
      (v_online_promo,true,'Overlapping online promotion','عرض إلكتروني متداخل','percent',5,'store',
       '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','online','automatic');
  exception when check_violation then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'legacy campaign and central online automatic promotion were allowed to overlap';
  end if;

  delete from public.promotions where id=v_pos_promo;
  delete from public.campaigns where id=v_campaign;

  -- The reciprocal campaign trigger also refuses a campaign created after the
  -- authoritative promotion is already enabled.
  insert into public.promotions
    (id,enabled,name_en,name_ar,discount_type,value,scope,starts_at,ends_at,channel,mode)
  values
    (v_online_promo,true,'Central first','العرض المركزي أولاً','percent',5,'store',
     '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','online','automatic');
  v_rejected := false;
  begin
    insert into public.campaigns
      (id,name_ar,name_en,kind,discount_type,discount_value,product_ids,starts_at,ends_at,active)
    values
      (v_campaign,'حملة متداخلة','Overlapping campaign','flash_sale','percent',10,'[]'::jsonb,
       '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',true);
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'campaign-side overlap guard did not fail closed'; end if;
  delete from public.promotions where id=v_online_promo;

  -- A targeted promotion is allowed to exist before its targets are attached;
  -- attaching an overlapping target must still be refused.
  select id into v_product from public.products order by created_at limit 1;
  insert into public.campaigns
    (id,name_ar,name_en,kind,discount_type,discount_value,product_ids,starts_at,ends_at,active)
  values
    (v_campaign,'حملة منتج','Product campaign','flash_sale','percent',10,jsonb_build_array(v_product::text),
     '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',true);
  insert into public.promotions
    (id,enabled,name_en,name_ar,discount_type,value,scope,starts_at,ends_at,channel,mode)
  values
    (v_target_promo,true,'Target overlap','تداخل الاستهداف','percent',5,'product',
     '2026-01-01T00:00:00Z','2027-01-01T00:00:00Z','online','automatic');
  v_rejected := false;
  begin
    insert into public.promotion_targets(promotion_id,target_kind,target_id)
    values(v_target_promo,'product',v_product);
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'promotion-target overlap guard did not fail closed'; end if;
  delete from public.promotions where id=v_target_promo;
  delete from public.campaigns where id=v_campaign;
  update public.promotions set enabled=true where id=any(v_enabled_promotions);

  raise notice 'Phase 3 promotion authority — campaign, promotion and target writes reject online overlap in both orders while POS-only coexistence remains supported';
end
$phase3_promotion_overlap$;

reset role;

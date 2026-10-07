-- Prompt 4 focused scenarios: narrow offline cash replay and health contract.
-- Runs last in the same disposable database as the baseline/Phase 2/3/3.5 rings.

do $phase4_offline$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_other uuid := '00000000-0000-4000-8000-0000000035b2';
  -- Reuse the concrete Phase 3.5 fixture rather than inventing another ALYQ-01.
  v_product uuid := '00000000-0000-4000-8000-0000000035a1';
  v_variant uuid := '00000000-0000-4000-8000-000000003542';
  v_sibling uuid := '00000000-0000-4000-8000-000000003541';
  v_payload jsonb;
  v_evidence jsonb;
  v_first jsonb;
  v_second jsonb;
  v_health jsonb;
  v_before integer;
  v_after integer;
  v_sibling_before integer;
  v_other_before integer;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  if not exists(select 1 from public.product_variants where id=v_variant and product_id=v_product and sku='ALYQ-01-BLK-42' and barcode='629ALYQ0142') then
    raise exception 'Phase 3.5 ALYQ-01 Black / 42 fixture is unavailable';
  end if;

  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  perform pg_temp.ensure_open_shift(v_cashier::text);
  select quantity into v_before from public.branch_stock_balances
   where branch_id=v_main and product_id=v_product and variant_id=v_variant;
  select coalesce((select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_sibling),0) into v_sibling_before;
  select coalesce((select quantity from public.branch_stock_balances where branch_id=v_other and variant_id=v_variant),0) into v_other_before;

  v_payload:=jsonb_build_object(
    'client_ref','phase4-offline-alyq01-black42',
    'user_id',v_cashier::text,'user_name','Karim Cashier','source','pos',
    'discount_type','none','discount_value',0,
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',100,'status','paid','tendered',100)),
    'lines',jsonb_build_array(jsonb_build_object(
      'product_id',v_product::text,'variant_id',v_variant::text,'qty',1,
      'discount_type','none','discount_value',0
    ))
  );
  v_evidence:=jsonb_build_object(
    'schema_version',1,'branch_id',v_main::text,'captured_at',now(),
    'subtotal',100,'discount_amount',0,'total',100,
    'lines',jsonb_build_array(jsonb_build_object(
      'product_id',v_product::text,'variant_id',v_variant::text,
      'sku','ALYQ-01-BLK-42','barcode','629ALYQ0142',
      'color_ar','أسود','color_en','Black','size_value','42','qty',1,'unit_price',100
    ))
  );

  v_first:=public.pos_sync_offline_sale(v_payload,v_evidence);
  -- Lost response replay: the exact client reference returns the committed sale
  -- and never touches the Black / 42 shelf twice.
  v_second:=public.pos_sync_offline_sale(v_payload,v_evidence);
  if v_first->>'sale_id' is distinct from v_second->>'sale_id'
     or (select count(*) from public.sales where branch_id=v_main and client_ref='phase4-offline-alyq01-black42')<>1
     or (select count(*) from public.sale_payments where sale_id=(v_first->>'sale_id')::uuid)<>1
     or (select count(*) from public.stock_movements where branch_id=v_main and variant_id=v_variant and notes='Sale '||(v_first->>'sale_number'))<>1 then
    raise exception 'lost-response replay duplicated the sale, payment, or stock movement';
  end if;
  select quantity into v_after from public.branch_stock_balances
   where branch_id=v_main and product_id=v_product and variant_id=v_variant;
  if v_after<>v_before-1
     or coalesce((select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_sibling),0)<>v_sibling_before
     or coalesce((select quantity from public.branch_stock_balances where branch_id=v_other and variant_id=v_variant),0)<>v_other_before then
    raise exception 'offline replay changed the wrong exact Branch × Color × Size shelf';
  end if;

  -- A Branch A operation cannot be redirected by a Branch B session.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_other);
  begin
    perform public.pos_sync_offline_sale(v_payload||jsonb_build_object('client_ref','phase4-wrong-branch','user_id',v_admin::text,'user_name','Amina Admin'),v_evidence);
    raise exception 'cross-branch offline replay was accepted';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.sales where client_ref='phase4-wrong-branch') then
    raise exception 'cross-branch refusal still wrote a sale';
  end if;

  -- Server pricing remains authoritative. Historical evidence is preserved as
  -- a conflict rather than silently re-priced after the variant changes.
  perform public.switch_active_branch_with_audit(v_main);
  update public.products set selling_price=105 where id=v_product;
  perform pg_temp.become(v_cashier,'authenticated');
  begin
    perform public.pos_sync_offline_sale(v_payload||jsonb_build_object('client_ref','phase4-price-conflict'),v_evidence);
    raise exception 'changed catalogue price silently repriced offline history';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.sales where client_ref='phase4-price-conflict')
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_variant)<>v_after then
    raise exception 'pricing conflict wrote a transaction or changed stock';
  end if;

  -- Revoked/absent sale authority fails closed.
  perform pg_temp.become(v_viewer,'authenticated');
  begin
    perform public.pos_sync_offline_sale(v_payload||jsonb_build_object('client_ref','phase4-revoked'),v_evidence);
    raise exception 'viewer synchronized an offline sale';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from public.sales where client_ref='phase4-revoked') then
    raise exception 'revoked authority refusal still wrote a sale';
  end if;

  -- Health proves the authenticated contract and exact schema compatibility;
  -- it does not mutate or expose credentials.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  v_health:=public.system_health_probe();
  if v_health->>'migration'<>'0094_web_push_subscriptions.sql'
     or (v_health->>'migration_count')::integer<>94
     or coalesce((v_health->>'authenticated')::boolean,false) is false
     or coalesce((v_health->>'branch_context_valid')::boolean,false) is false then
    raise exception 'system health contract did not verify migration/auth/branch: %',v_health;
  end if;

  raise notice 'Prompt 4 offline replay and health scenarios passed';
end
$phase4_offline$;

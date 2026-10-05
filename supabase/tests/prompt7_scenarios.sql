-- Prompt 7 focused scenarios (branch-exact movement audit + bridge safety).
-- Runs after Final Store QA, in the same disposable DB, and proves the two
-- fixes in migration 0087 (BRANCH_INVENTORY_AUDIT_REPORT.md findings B1/B2):
--   B2 — sale/return stock_movements.quantity_before/after are branch-exact.
--   B1 — the legacy-column bridge triggers fail loudly instead of silently
--        choosing a default branch when there is no active branch context.
-- It also proves branch isolation, variant isolation, idempotent replay for
-- sale/return/transfer, and branch+variant-exact stocktake finalization.

do $prompt7_branch_exact_audit$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_destination uuid := '00000000-0000-4000-8000-0000000087b2';
  v_category uuid := '00000000-0000-4000-8000-0000000087c1';
  v_product uuid := '00000000-0000-4000-8000-0000000087d1';
  v_plain_product uuid := '00000000-0000-4000-8000-0000000087f1';
  v_v1 uuid := '00000000-0000-4000-8000-000000008701';
  v_v2 uuid := '00000000-0000-4000-8000-000000008702';
  v_broken uuid := '00000000-0000-4000-8000-0000000087e1';
  v_sale jsonb;
  v_sale_id uuid;
  v_sale_item uuid;
  v_return jsonb;
  v_return_id uuid;
  v_transfer_result jsonb;
  v_stocktake_result jsonb;
  v_stocktake uuid;
  v_counts jsonb;
  v_legacy_variant_before integer;
  v_legacy_plain_before integer;
begin
  -- ── Fixtures: a second active branch, and the admin's membership there ──
  perform pg_temp.become(null,'postgres');
  insert into public.branches(id,code,name_en,name_ar,active,is_default)
  values(v_destination,'prompt7-branch-b','Prompt 7 Branch B','فرع برومبت 7 ب',true,false)
  on conflict(id) do update set active=true;
  insert into public.branch_memberships(user_id,branch_id,role,active)
  values(v_admin,v_destination,'admin',true)
  on conflict(user_id,branch_id) do update set role='admin',active=true;

  -- ── Catalogue: one variant-enabled product (V1/V2) + one plain product ──
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.categories(id,name_ar,name_en) values(v_category,'فئة برومبت 7','Prompt 7 fixture');
  insert into public.products(
    id,sku,name_ar,name_en,category_id,selling_price,cost_price,stock_quantity,
    active,show_on_website,stock_tracking_enabled
  ) values(
    v_product,'P87-MULTI','منتج متعدد 87','Prompt 7 variant fixture',v_category,40,20,17,
    true,true,true
  );
  insert into public.product_variants(
    id,product_id,sku,barcode,color_en,color_ar,color_hex,
    size_value,size_sort_order,stock_quantity,active,sort_order
  ) values
    (v_v1,v_product,'P87-V1','629PROMPT70001','Red','أحمر','#ff0000','S',0,0,true,0),
    (v_v2,v_product,'P87-V2','629PROMPT70002','Blue','أزرق','#0000ff','M',1,0,true,1);
  perform public.enable_product_variants(
    v_product,
    jsonb_build_object(v_v1::text,10,v_v2::text,7),
    v_admin::text,'Amina Admin'
  );
  insert into public.products(
    id,sku,name_ar,name_en,category_id,selling_price,cost_price,stock_quantity,
    active,show_on_website,stock_tracking_enabled
  ) values(
    v_plain_product,'P87-PLAIN','منتج بسيط 87','Prompt 7 plain fixture',v_category,15,8,20,
    true,true,true
  );

  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>10
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v2)<>7
     or exists(select 1 from public.branch_stock_balances where branch_id=v_destination and variant_id in (v_v1,v_v2) and quantity<>0)
     or (select quantity from public.branch_stock_balances where branch_id=v_main and product_id=v_plain_product and variant_id is null)<>20 then
    raise exception 'prompt7 fixture baseline is wrong before Branch B is seeded';
  end if;

  -- Seed Branch B's V1 shelf independently of Branch A, matching the audit's
  -- worked example (Branch A V1 = 10, Branch B V1 = 50).
  perform public.switch_active_branch_with_audit(v_destination);
  perform public.inventory_adjust_stock(
    'prompt7-seed-branch-b-v1',v_product,v_v1,'adjustment_in','purchase',50,'Seed Branch B V1 to 50'
  );
  perform public.switch_active_branch_with_audit(v_main);
  if (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50 then
    raise exception 'prompt7 fixture could not seed Branch B V1 to 50';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- E — B1: a missing active branch must fail loudly, never silently land
  -- on a default/arbitrary branch. Exercised directly against the trigger
  -- (owner role, so RLS cannot mask whether the TRIGGER itself still guards
  -- the legacy write — the same posture scenarios.sql uses to prove
  -- invariant triggers hold for service_role/psql/a migration, not just UI).
  -- ═══════════════════════════════════════════════════════════════════════
  perform pg_temp.become(null,'postgres');
  insert into auth.users(id,email) values(v_broken,'prompt7-broken@alyq.local')
  on conflict(id) do nothing;
  insert into public.profiles(id,username,name,role,active)
  values(v_broken,'prompt7broken','Broken Branch User','cashier',true)
  on conflict(id) do update set username=excluded.username,name=excluded.name,
    role=excluded.role,active=excluded.active;
  update public.profiles set active_branch_id=null where id=v_broken;
  if (select active_branch_id from public.profiles where id=v_broken) is not null then
    raise exception 'prompt7 setup could not null the broken user active branch';
  end if;

  perform pg_temp.become(v_broken,'postgres');
  if public.current_branch_id() is not null then
    raise exception 'prompt7 setup: broken user unexpectedly resolved an active branch';
  end if;

  -- The legacy product_variants.stock_quantity column is the cross-branch
  -- compatibility rollup (Main 10 + Branch B 50 = 60 at this point), not the
  -- Main-only figure — capture it rather than assume a fixed number, then
  -- prove the rejected write did not change it by even one unit.
  select stock_quantity into v_legacy_variant_before from public.product_variants where id=v_v1;
  begin
    update public.product_variants set stock_quantity = stock_quantity + 1 where id = v_v1;
    raise exception 'B1 regression: variant_stock_bridge_to_branch accepted a write with no active branch';
  exception when insufficient_privilege then null;
  end;
  if (select stock_quantity from public.product_variants where id=v_v1) <> v_legacy_variant_before then
    raise exception 'B1 regression: the rejected write still changed product_variants.stock_quantity';
  end if;
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>10
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50
     or exists(
       select 1 from public.branch_stock_balances
        where variant_id=v_v1 and branch_id not in (v_main,v_destination)
     ) then
    raise exception 'B1 regression: the rejected variant write landed on some other/default branch shelf';
  end if;

  select stock_quantity into v_legacy_plain_before from public.products where id=v_plain_product;
  begin
    update public.products set stock_quantity = stock_quantity + 1 where id = v_plain_product;
    raise exception 'B1 regression: product_stock_bridge_to_branch accepted a write with no active branch';
  exception when insufficient_privilege then null;
  end;
  if (select stock_quantity from public.products where id=v_plain_product) <> v_legacy_plain_before then
    raise exception 'B1 regression: the rejected write still changed products.stock_quantity';
  end if;
  if (select quantity from public.branch_stock_balances where branch_id=v_main and product_id=v_plain_product and variant_id is null)<>20
     or exists(
       select 1 from public.branch_stock_balances
        where product_id=v_plain_product and branch_id<>v_main
     ) then
    raise exception 'B1 regression: the rejected plain-product write landed on some other/default branch shelf';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- A/B2 — a sale deducts the EXACT active-branch shelf and records a
  -- branch-exact movement snapshot; Branch B and the sibling variant are
  -- untouched (C: branch isolation, D: variant isolation).
  -- ═══════════════════════════════════════════════════════════════════════
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);

  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref','prompt7-sale-v1',
    'source','online',
    'user_id',v_admin::text,'user_name','Amina Admin',
    'payments',jsonb_build_array(jsonb_build_object('method','cod','amount',80,'status','pending')),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product::text,'variant_id',v_v1::text,'qty',2))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_sale_item from public.sale_items where sale_id=v_sale_id and variant_id=v_v1;

  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>8
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v2)<>7
     or not exists(
       select 1 from public.stock_movements
        where source_type='sale' and source_id=v_sale_id and branch_id=v_main and variant_id=v_v1
          and type='issue' and quantity_before=10 and quantity_after=8
     ) then
    raise exception 'A/B2 regression: sale did not deduct exact Main V1 10->8 with a branch-correct movement snapshot';
  end if;

  -- F (sale half) — a replayed client_ref must not mutate stock twice or
  -- write a second movement row.
  perform public.pos_complete_sale(jsonb_build_object(
    'client_ref','prompt7-sale-v1','source','online',
    'user_id',v_admin::text,'user_name','Amina Admin',
    'payments',jsonb_build_array(jsonb_build_object('method','cod','amount',80,'status','pending')),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product::text,'variant_id',v_v1::text,'qty',2))
  ));
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>8
     or (select count(*) from public.stock_movements where source_type='sale' and source_id=v_sale_id)<>1 then
    raise exception 'F regression: replaying the same sale client_ref mutated stock or duplicated the movement';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- B/B2 — a return restores the EXACT active-branch shelf and records a
  -- branch-exact movement snapshot; Branch B and the sibling variant stay
  -- untouched.
  -- ═══════════════════════════════════════════════════════════════════════
  v_return := public.pos_process_return(jsonb_build_object(
    'client_ref','prompt7-return-v1',
    'sale_id',v_sale_id::text,
    'reason','Prompt 7 regression check',
    'refund_method','cash',
    'refund_status','completed',
    'user_id',v_admin::text,'user_name','Amina Admin',
    'items',jsonb_build_array(jsonb_build_object('sale_item_id',v_sale_item::text,'quantity',1))
  ));
  v_return_id := (v_return->>'return_id')::uuid;

  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>9
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v2)<>7
     or not exists(
       select 1 from public.stock_movements
        where source_type='return' and source_id=v_return_id and branch_id=v_main and variant_id=v_v1
          and type='adjustment_in' and quantity_before=8 and quantity_after=9
     ) then
    raise exception 'B/B2 regression: return did not restore exact Main V1 8->9 with a branch-correct movement snapshot';
  end if;

  -- C — explicit branch-isolation statement: across the entire sale+return
  -- chain above, Branch B's V1 shelf never moved off its independently
  -- seeded value.
  if (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50 then
    raise exception 'C regression: a Branch A mutation affected Branch B''s shelf for the same variant';
  end if;

  -- F (return half) — replay must not duplicate the restock or the movement.
  perform public.pos_process_return(jsonb_build_object(
    'client_ref','prompt7-return-v1','sale_id',v_sale_id::text,
    'reason','Prompt 7 regression check','refund_method','cash','refund_status','completed',
    'user_id',v_admin::text,'user_name','Amina Admin',
    'items',jsonb_build_array(jsonb_build_object('sale_item_id',v_sale_item::text,'quantity',1))
  ));
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>9
     or (select count(*) from public.stock_movements where source_type='return' and source_id=v_return_id)<>1 then
    raise exception 'F regression: replaying the same return client_ref mutated stock or duplicated the movement';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- G — transfer moves the exact variant between the exact two branches and
  -- stays idempotent on retry (unrelated to B1/B2, re-confirmed here so the
  -- same fixtures prove no regression in the transfer path).
  -- ═══════════════════════════════════════════════════════════════════════
  v_transfer_result := public.inventory_transfer_stock(
    'prompt7-transfer-v2',v_destination,v_product,v_v2,3,'Prompt 7 transfer check'
  );
  if (v_transfer_result->>'replayed')::boolean then
    raise exception 'G regression: first transfer falsely reported a replay';
  end if;
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v2)<>4
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v2)<>3
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>9
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>50 then
    raise exception 'G regression: transfer moved the wrong variant or touched the wrong shelf';
  end if;
  v_transfer_result := public.inventory_transfer_stock(
    'prompt7-transfer-v2',v_destination,v_product,v_v2,3,'Prompt 7 transfer check'
  );
  if not (v_transfer_result->>'replayed')::boolean
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v2)<>4
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v2)<>3 then
    raise exception 'G regression: replayed transfer was not idempotent';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- H — stocktake finalization stays branch+variant exact and cannot be
  -- applied twice (unrelated to B1/B2, re-confirmed here for the same
  -- reason as G).
  -- ═══════════════════════════════════════════════════════════════════════
  perform public.switch_active_branch_with_audit(v_destination);
  v_stocktake_result := public.stocktake_create(false,'Prompt 7 Branch B count');
  v_stocktake := (v_stocktake_result->'session'->>'id')::uuid;
  if not exists(
    select 1 from public.stocktake_lines
     where stocktake_id=v_stocktake and variant_id=v_v1 and expected_quantity=50
  ) then
    raise exception 'H regression: destination stocktake did not snapshot Branch B V1 = 50';
  end if;

  select jsonb_agg(jsonb_build_object(
    'line_id',id,
    'physical_quantity',case when variant_id=v_v1 then expected_quantity-1 else expected_quantity end
  )) into v_counts
  from public.stocktake_lines where stocktake_id=v_stocktake;
  perform public.stocktake_save_counts(v_stocktake,v_counts,'review',true);
  v_stocktake_result := public.stocktake_finalize(v_stocktake);
  if not (v_stocktake_result->>'ok')::boolean
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>49
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_v1)<>9
     or not exists(
       select 1 from public.stock_movements
        where source_type='stocktake' and source_id=v_stocktake and branch_id=v_destination
          and variant_id=v_v1 and quantity_before=50 and quantity_after=49
     ) then
    raise exception 'H regression: stocktake did not correct only the active Branch B V1 shelf';
  end if;
  v_stocktake_result := public.stocktake_finalize(v_stocktake);
  if v_stocktake_result->>'code'<>'STOCKTAKE_FINALIZED'
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_v1)<>49 then
    raise exception 'H regression: stocktake retry was not idempotent';
  end if;
  perform public.switch_active_branch_with_audit(v_main);

  raise notice 'Prompt 7 branch-exact audit and bridge safety — (A) sale deducts exact Branch A V1 10->8 with a branch-correct movement, (B) return restores exact Branch A V1 8->9, (C) Branch B V1 stays 50 throughout, (D) sibling variant V2 stays 7 throughout, (E) a missing active branch is a loud 42501 failure for both the variant and plain-product legacy bridges with no mutation anywhere, (F) replayed sale/return client_refs are no-ops, (G) transfer moves only the exact variant and is replay-safe, (H) stocktake finalizes the exact branch/variant shelf once and refuses a second finalize';
end
$prompt7_branch_exact_audit$;

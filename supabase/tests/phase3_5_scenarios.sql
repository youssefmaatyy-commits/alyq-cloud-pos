-- Phase 3.5 focused branch-stock foundation scenarios.
-- Runs after the baseline, Phase 2, and Phase 3 scenarios in the same disposable DB.

-- ── One-time stock placement, exact branch shelves, transfers and retries ──
do $phase35_branch_stock$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_destination uuid := '00000000-0000-4000-8000-0000000035b2';
  v_category uuid := '00000000-0000-4000-8000-0000000035c1';
  v_product uuid := '00000000-0000-4000-8000-0000000035d1';
  v_order uuid := '00000000-0000-4000-8000-0000000035e1';
  v_reservation uuid;
  v_result jsonb;
  v_transfer uuid;
  v_before integer;
  v_rows integer;
begin
  -- Create a second active location and grant the fixture admin real authority
  -- there. Setup is owner-only; every operation under test runs authenticated.
  perform pg_temp.become(null,'postgres');
  insert into public.branches(id,code,name_en,name_ar,active,is_default)
  values(v_destination,'phase35-destination','Phase 3.5 Destination','وجهة المرحلة 3.5',true,false)
  on conflict(id) do update set active=true;
  insert into public.branch_memberships(user_id,branch_id,role,active)
  values(v_admin,v_destination,'admin',true)
  on conflict(user_id,branch_id) do update set role='admin',active=true;

  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.categories(id,name_ar,name_en)
  values(v_category,'مخزون فرعي','Branch stock fixture');
  insert into public.products(
    id,sku,name_ar,name_en,category_id,selling_price,stock_quantity,
    low_stock_level,active,show_on_website,stock_tracking_enabled
  ) values(
    v_product,'P35-BRANCH','منتج فرعي','Branch fixture',v_category,25,11,
    3,true,true,true
  );

  -- Opening inventory is assigned once, to the active/default legacy branch.
  if (select quantity from public.branch_stock_balances
       where branch_id=v_main and product_id=v_product and variant_id is null) <> 11 then
    raise exception 'opening stock was not placed on the deterministic source shelf';
  end if;
  if (select coalesce(sum(quantity),0) from public.branch_stock_balances where product_id=v_product) <> 11
     or (select count(*) from public.branch_stock_balances where product_id=v_product and quantity>0) <> 1 then
    raise exception 'opening stock was multiplied across branches';
  end if;
  if (select stock_quantity from public.products where id=v_product) <> 11 then
    raise exception 'legacy product rollup disagrees with branch stock';
  end if;

  -- A reserved unit belongs to this branch and cannot be transferred away.
  -- Reservation fixture setup uses the table owner; transfer behavior remains
  -- authenticated and the branch stamper still derives Main from the order.
  perform pg_temp.become(null,'postgres');
  insert into public.online_orders(
    id,client_ref,customer_name,customer_phone,delivery_type,address,
    subtotal,discount_amount,delivery_fee,total,payment_method
  ) values(
    v_order,'phase35-reservation-order','Branch Customer','01000000355','pickup','{}',
    25,0,0,25,'cod'
  );
  insert into public.stock_reservations(online_order_id,product_id,quantity,status)
  values(v_order,v_product,10,'reserved') returning id into v_reservation;
  perform pg_temp.become(v_admin,'authenticated');
  begin
    perform public.inventory_transfer_stock(
      'phase35-reserved-refusal',v_destination,v_product,null,2,'Must preserve holds'
    );
    raise exception 'transfer consumed stock promised to a storefront order';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.stock_transfers where client_ref='phase35-reserved-refusal') then
    raise exception 'refused reserved-stock transfer left a transfer record';
  end if;
  perform pg_temp.become(null,'postgres');
  begin
    insert into public.stock_reservations(online_order_id,product_id,quantity,status)
    values(v_order,v_product,2,'reserved');
    raise exception 'branch reservation guard accepted more than branch stock';
  exception when check_violation then null;
  end;
  update public.stock_reservations set status='released',resolved_at=now() where id=v_reservation;
  perform pg_temp.become(v_admin,'authenticated');

  -- Completion is one transaction: both balances, two branch-correct movement
  -- snapshots, one transfer record and one audit event share the same identity.
  v_result := public.inventory_transfer_stock(
    'phase35-transfer-once',v_destination,v_product,null,4,'Rebalance fixture'
  );
  if (v_result->>'replayed')::boolean then raise exception 'first transfer claimed replay'; end if;
  v_transfer := (v_result->'transfer'->>'id')::uuid;
  if (select quantity from public.branch_stock_balances
       where branch_id=v_main and product_id=v_product and variant_id is null) <> 7
     or (select quantity from public.branch_stock_balances
       where branch_id=v_destination and product_id=v_product and variant_id is null) <> 4 then
    raise exception 'transfer did not debit and credit its exact branch shelves';
  end if;
  if (select stock_quantity from public.products where id=v_product) <> 11 then
    raise exception 'transfer changed the aggregate inventory total';
  end if;
  -- Owner visibility is used only to prove both RLS-isolated ledger halves.
  perform pg_temp.become(null,'postgres');
  if (select count(*) from public.stock_movements where source_type='transfer' and source_id=v_transfer) <> 2
     or not exists(
       select 1 from public.stock_movements
        where source_id=v_transfer and branch_id=v_main
          and type='transfer' and quantity_before=11 and quantity_after=7
     )
     or not exists(
       select 1 from public.stock_movements
        where source_id=v_transfer and branch_id=v_destination
          and type='receive' and quantity_before=0 and quantity_after=4
     ) then
    raise exception 'transfer ledger is not a linked branch-correct pair: %',
      (select jsonb_agg(jsonb_build_object('branch',branch_id,'type',type,'before',quantity_before,'after',quantity_after,'source',source_id))
         from public.stock_movements where source_id=v_transfer);
  end if;
  if not exists(
    select 1 from public.stock_transfers
     where id=v_transfer and status='completed' and source_branch_id=v_main
       and destination_branch_id=v_destination and quantity=4
       and initiated_by=v_admin and completed_at is not null
  ) or not exists(
    select 1 from public.audit_log
     where action='stock.transferred' and entity='stock_transfer'
       and entity_id=v_transfer::text and branch_id=v_main
  ) then
    raise exception 'completed transfer identity, actor, status or audit is incomplete';
  end if;

  perform pg_temp.become(v_admin,'authenticated');
  v_result := public.inventory_transfer_stock(
    'phase35-transfer-once',v_destination,v_product,null,4,'Rebalance fixture'
  );
  if not (v_result->>'replayed')::boolean then raise exception 'identical transfer retry was not replayed'; end if;
  perform pg_temp.become(null,'postgres');
  if (select quantity from public.branch_stock_balances
       where branch_id=v_main and product_id=v_product and variant_id is null) <> 7
     or (select quantity from public.branch_stock_balances
       where branch_id=v_destination and product_id=v_product and variant_id is null) <> 4
     or (select count(*) from public.stock_transfers where client_ref='phase35-transfer-once') <> 1
     or (select count(*) from public.stock_movements where source_id=v_transfer) <> 2 then
    raise exception 'transfer retry duplicated stock or evidence';
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  begin
    perform public.inventory_transfer_stock(
      'phase35-transfer-once',v_destination,v_product,null,3,'Changed payload'
    );
    raise exception 'changed payload reused a transfer client reference';
  exception when unique_violation then null;
  end;

  -- Adjustment authority follows the active branch and reports that branch's
  -- before/after quantities rather than the aggregate compatibility figure.
  perform public.switch_active_branch_with_audit(v_destination);
  v_result := public.inventory_adjust_stock(
    'phase35-destination-adjust',v_product,null,'adjustment_in','purchase',2,'Destination receipt'
  );
  if (v_result->'movement'->>'branch_id')::uuid <> v_destination
     or (v_result->'movement'->>'quantity_before')::integer <> 4
     or (v_result->'movement'->>'quantity_after')::integer <> 6
     or (select quantity from public.branch_stock_balances
          where branch_id=v_main and product_id=v_product and variant_id is null) <> 7
     or (select stock_quantity from public.products where id=v_product) <> 13 then
    raise exception 'branch adjustment touched the wrong shelf or movement snapshot';
  end if;
  v_result := public.inventory_adjust_stock(
    'phase35-destination-adjust',v_product,null,'adjustment_in','purchase',2,'Destination receipt'
  );
  if not (v_result->>'replayed')::boolean
     or (select stock_quantity from public.products where id=v_product) <> 13 then
    raise exception 'branch adjustment retry was not idempotent';
  end if;

  -- Read authority can name an accessible branch but cannot be widened by URL
  -- or payload to a location where the caller has no membership.
  perform pg_temp.become(v_viewer,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.inventory_branch_stock(v_destination);
    raise exception 'viewer read branch stock outside their memberships';
  exception when insufficient_privilege then null;
  end;
  select count(*) into v_rows from public.branch_stock_balances
   where branch_id=v_destination and product_id=v_product;
  if v_rows<>0 then raise exception 'branch-stock RLS leaked destination rows'; end if;
  begin
    perform public.inventory_transfer_stock(
      'phase35-viewer-forged',v_destination,v_product,null,1,'Forged transfer'
    );
    raise exception 'viewer completed a forged transfer';
  exception when insufficient_privilege then null;
  end;

  raise notice 'Phase 3.5 branch stock — opening units are placed once, reservations protect fulfillment stock, adjustments use the active shelf, transfers debit+credit atomically with branch snapshots/audit, retries are idempotent, changed retries fail, and cross-branch payload/RLS forgery is refused';
end
$phase35_branch_stock$;

reset role;

-- ── Exact variant identity stays exact through branch transfer ────────────
do $phase35_exact_variant$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_destination uuid := '00000000-0000-4000-8000-0000000035b2';
  v_category uuid := '00000000-0000-4000-8000-0000000035c1';
  v_product uuid := '00000000-0000-4000-8000-0000000035d2';
  v_red_m uuid := '00000000-0000-4000-8000-0000000035f1';
  v_blue_m uuid := '00000000-0000-4000-8000-0000000035f2';
  v_result jsonb;
  v_transfer uuid;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.products(
    id,sku,name_ar,name_en,category_id,selling_price,stock_quantity,
    active,stock_tracking_enabled
  ) values(v_product,'P35-VARIANT','متغير دقيق','Exact variant fixture',v_category,40,6,true,true);
  insert into public.product_variants(
    id,product_id,sku,barcode,color_key,color_en,color_ar,size,size_label,
    stock_quantity,active,sort_order
  ) values
    (v_red_m,v_product,'P35-RED-M','P35BARREDM','red','Red','أحمر',1,'M',0,true,1),
    (v_blue_m,v_product,'P35-BLUE-M','P35BARBLUEM','blue','Blue','أزرق',1,'M',0,true,2);
  perform public.enable_product_variants(
    v_product,jsonb_build_object(v_red_m::text,2,v_blue_m::text,4),
    v_admin::text,'Amina Admin'
  );
  if exists(select 1 from public.branch_stock_balances where product_id=v_product and variant_id is null)
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_red_m) <> 2
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_blue_m) <> 4
     or (select sum(quantity) from public.branch_stock_balances where product_id=v_product) <> 6 then
    raise exception 'variant conversion multiplied, lost, or retained a parent shelf';
  end if;

  v_result := public.inventory_transfer_stock(
    'phase35-exact-variant-transfer',v_destination,v_product,v_red_m,1,'Exact combination'
  );
  v_transfer := (v_result->'transfer'->>'id')::uuid;
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_red_m) <> 1
     or (select quantity from public.branch_stock_balances where branch_id=v_destination and variant_id=v_red_m) <> 1
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_blue_m) <> 4
     or (select stock_quantity from public.product_variants where id=v_red_m) <> 2
     or (select stock_quantity from public.products where id=v_product) <> 6 then
    raise exception 'exact-variant transfer crossed a sibling or changed aggregate stock';
  end if;
  perform pg_temp.become(null,'postgres');
  if (select count(*) from public.stock_movements
       where source_id=v_transfer and variant_id=v_red_m
         and variant_color_en='Red' and variant_size_label='M') <> 2 then
    raise exception 'transfer did not freeze exact variant identity on both movements';
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  begin
    perform public.inventory_transfer_stock(
      'phase35-parent-forged',v_destination,v_product,null,1,'Missing exact variant'
    );
    raise exception 'variant product transferred without its exact variant';
  exception when check_violation then null;
  end;

  raise notice 'Phase 3.5 exact shelves — variant conversion preserves the total once, removes the parent shelf, transfer moves only the chosen Color × Size identity, sibling stock stays fixed, and movement snapshots retain exact variant evidence';
end
$phase35_exact_variant$;

reset role;

-- ── Flexible size strings, Arabic-only colours and shared colour galleries ──
do $phase35_flexible_catalogue$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_category uuid := '00000000-0000-4000-8000-0000000035c1';
  v_product uuid := '00000000-0000-4000-8000-0000000035d3';
  v_xs uuid := '00000000-0000-4000-8000-0000000035f3';
  v_pants uuid := '00000000-0000-4000-8000-0000000035f4';
  v_one uuid := '00000000-0000-4000-8000-0000000035f5';
  v_images jsonb;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.products(id,sku,name_ar,name_en,category_id,selling_price,stock_quantity,active,show_on_website,stock_tracking_enabled)
  values(v_product,'P35-FLEX','مقاسات مرنة','Flexible sizes',v_category,50,0,true,true,true);
  insert into public.product_variants(
    id,product_id,sku,barcode,color_ar,color_en,color_hex,size_value,size_sort_order,stock_quantity,active
  ) values
    (v_xs,v_product,'P35-FLEX-XS','P35FLEXXS','أحمر',null,null,'XS',0,0,true),
    (v_pants,v_product,'P35-FLEX-2830','P35FLEX2830','أحمر',null,null,'28x30',1,0,true),
    (v_one,v_product,'P35-FLEX-ONE','P35FLEXONE','أحمر',null,null,'One Size',2,0,true);
  perform public.enable_product_variants(
    v_product,jsonb_build_object(v_xs::text,0,v_pants::text,0,v_one::text,0),v_admin::text,'Amina Admin'
  );
  if (select size_value from public.product_variants where id=v_xs)<>'XS'
     or (select size from public.product_variants where id=v_xs) is not null
     or (select size_value from public.product_variants where id=v_pants)<>'28x30'
     or (select size_sort_order from public.product_variants where id=v_one)<>2 then
    raise exception 'flexible size strings or explicit ordering were not preserved';
  end if;
  begin
    insert into public.product_variants(product_id,sku,color_ar,size_value,stock_quantity)
    values(v_product,'P35-FLEX-DUP','أحمر','xs',0);
    raise exception 'case-only duplicate Color × Size identity was accepted';
  exception when unique_violation then null;
  end;

  v_images:=jsonb_build_array(
    jsonb_build_object('color_key','أحمر','image_url','https://cdn.example/red-front.webp','is_primary',true),
    jsonb_build_object('color_key','أحمر','image_url','https://cdn.example/red-side.webp','is_primary',false)
  );
  perform public.replace_product_color_images(v_product,v_images);
  if (select count(*) from public.product_color_images where product_id=v_product and color_key='أحمر')<>2
     or (select count(*) from public.product_color_images where product_id=v_product and color_key='أحمر' and is_primary)<>1 then
    raise exception 'shared colour gallery did not retain two ordered URLs and one primary';
  end if;
  if exists(
    select image_url from public.product_variants where product_id=v_product and image_url is not null
  ) then raise exception 'colour gallery duplicated URLs onto each size'; end if;

  perform pg_temp.become(null,'anon');
  if (select count(*) from public.storefront_color_images() where product_id=v_product)<>2 then
    raise exception 'published colour gallery was not available through the bounded storefront read';
  end if;
  begin
    perform public.replace_product_color_images(v_product,'[]'::jsonb);
    raise exception 'anonymous visitor replaced a colour gallery';
  exception when insufficient_privilege then null;
  end;

  raise notice 'Phase 3.5 catalogue dimensions — letter, pants and One Size strings retain explicit order, Arabic-only colours work without HEX, case-only duplicate combinations fail, two colour images share one gallery with one primary instead of per-size copies, bounded storefront read works, and anonymous writes fail';
end
$phase35_flexible_catalogue$;

reset role;


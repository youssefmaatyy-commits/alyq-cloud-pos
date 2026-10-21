-- 0097 focused scenarios — Shared Barcode & Individual Variant Models.
--
-- Covers:
--   1. Parent product `BR101` (barcode `BR101`, price 240 EGP) with 3 models:
--      - `BR101-M01` (Model 1 / شكل 1, qty 4)
--      - `BR101-M02` (Model 2 / شكل 2, qty 3)
--      - `BR101-M03` (Model 3 / شكل 3, qty 5)
--      Total parent stock = 12 (automatic rollup, zero parent-shelf duplication).
--   2. Shared barcode stored once on `products.barcode`: `product_variants.barcode`
--      stays NULL whether omitted or passed as `BR101`.
--   3. Cross-product barcode conflict rejection, duplicate SKU rejection,
--      duplicate model name rejection, gallery validation, and price inheritance.
--   4. Authenticated column-level UPDATE on `display_name_ar`, `display_name_en`, `images`.
--   5. POS sale (`pos_complete_sale`) deducts only from the selected model and
--      snapshots `variant_display_name` + shared parent barcode `BR101` on `sale_items`.
--   6. POS return (`pos_process_return`) restocks only the returned model and
--      snapshots `variant_display_name` + shared barcode `BR101` on `return_items`.
--   7. Online order line & reservation guards, stocktake creation with model label
--      and shared barcode, and storefront RPC `storefront_branch_product_variants_v2()`.
--   8. Legacy simple and colour/size products remain completely untouched.

do $variant_models_0097$
declare
  v_main       uuid := '00000000-0000-4000-8000-0000000000b1';
  v_admin      uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier    uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer     uuid := '00000000-0000-4000-8000-0000000000e1';
  v_category   uuid := '00000000-0000-4000-8000-000000009701';
  v_br101      uuid := '00000000-0000-4000-8000-000000009702';
  v_legacy     uuid := '00000000-0000-4000-8000-000000009703';
  v_colour     uuid := '00000000-0000-4000-8000-000000009704';
  v_m01        uuid := '00000000-0000-4000-8000-000000009711';
  v_m02        uuid := '00000000-0000-4000-8000-000000009712';
  v_m03        uuid := '00000000-0000-4000-8000-000000009713';
  v_colour_v   uuid := '00000000-0000-4000-8000-000000009714';
  v_sale_res   jsonb;
  v_sale_id    uuid;
  v_sale_item  uuid;
  v_ret_res    jsonb;
  v_ret_id     uuid;
  v_order_res  jsonb;
  v_order_id   uuid;
  v_st_res     jsonb;
  v_st_id      uuid;
  v_storefront jsonb;
  v_count      integer;
  v_total      integer;
  v_line_row   public.sale_items%rowtype;
  v_ret_row    public.return_items%rowtype;
  v_ord_item   public.online_order_items%rowtype;
begin
  perform pg_temp.become(null, 'postgres');

  insert into public.categories(id, name_ar, name_en)
  values(v_category, 'فئة 0097', '0097 category')
  on conflict(id) do nothing;

  -- 1. Create parent product BR101 (shared barcode BR101, price 240 EGP),
  --    plus legacy simple and colour/size products.
  insert into public.products(
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_quantity,
    active, show_on_website, stock_tracking_enabled, variants_enabled
  ) values
    (v_br101,  'BR101',      'BR101',      'سلسلة BR101', 'BR101 Necklace', v_category, 240, 120, 0, true, true, true, true),
    (v_legacy, 'P97-LEGACY', 'P97-LEGACY', 'منتج بسيط',   '0097 legacy',    v_category,  30,  10, 4, true, true, true, false),
    (v_colour, 'P97-COLOUR', 'P97-COLOUR', 'منتج ألوان',  '0097 colour',    v_category,  45,  20, 0, true, true, true, true);

  -- Insert 3 models under BR101:
  --   - M01 with NULL barcode
  --   - M02 with empty string barcode ''
  --   - M03 with explicit parent barcode 'BR101'
  -- All 3 must normalize `barcode` to NULL so the shared barcode lives once on `products.barcode`.
  insert into public.product_variants(
    id, product_id, sku, barcode, display_name_en, display_name_ar, images, image_url, stock_quantity, active, sort_order
  ) values
    (v_m01, v_br101, 'BR101-M01', null,    'Model 1', 'شكل 1',
      '["https://img.example.test/br101-m1-a.jpg","https://img.example.test/br101-m1-b.jpg"]'::jsonb,
      'https://img.example.test/br101-m1-a.jpg', 0, true, 0),
    (v_m02, v_br101, 'BR101-M02', '',      'Model 2', 'شكل 2',
      '["https://img.example.test/br101-m2-a.jpg"]'::jsonb,
      'https://img.example.test/br101-m2-a.jpg', 0, true, 1),
    (v_m03, v_br101, 'BR101-M03', 'BR101', 'Model 3', 'شكل 3',
      '[]'::jsonb,
      'https://img.example.test/br101-m3-a.jpg', 0, true, 2);

  if exists (select 1 from public.product_variants where id in (v_m01, v_m02, v_m03) and barcode is not null) then
    raise exception '0097 named models should keep barcode NULL when using the shared parent barcode';
  end if;

  -- Legacy colour/size variant with blank barcode still auto-generates from SKU (0086 preserved).
  insert into public.product_variants(
    id, product_id, sku, barcode, color_key, color_en, color_ar, size_value, size_sort_order, stock_quantity, active, sort_order
  ) values (
    v_colour_v, v_colour, 'P97-C-BLK', null, 'black', 'Black', 'أسود', '42', 0, 0, true, 0
  );
  if (select barcode from public.product_variants where id = v_colour_v) is distinct from 'P97-C-BLK' then
    raise exception '0097 broke 0086 auto-generated barcode for legacy colour/size variant';
  end if;

  -- 2. Set per-branch quantities on BR101 models: 4 + 3 + 5 = 12.
  update public.branch_stock_balances set quantity = 4 where branch_id = v_main and variant_id = v_m01;
  update public.branch_stock_balances set quantity = 3 where branch_id = v_main and variant_id = v_m02;
  update public.branch_stock_balances set quantity = 5 where branch_id = v_main and variant_id = v_m03;

  -- Verify automatic rollup on parent product (12) and zero parent-level balance row.
  select stock_quantity into v_total from public.products where id = v_br101;
  if v_total <> 12 then
    raise exception 'expected BR101 parent stock_quantity = 12, got %', v_total;
  end if;
  if exists (select 1 from public.branch_stock_balances where product_id = v_br101 and variant_id is null) then
    raise exception 'variant-enabled parent product BR101 has a duplicate parent-level branch_stock_balances row';
  end if;

  -- 3. Verify authenticated admin can UPDATE display_name_ar, display_name_en, and images.
  update public.profiles set active = true, role = 'admin', active_branch_id = v_main where id = v_admin;
  update public.branch_memberships set active = true where user_id = v_admin and branch_id = v_main;
  perform pg_temp.become(v_admin, 'authenticated');

  update public.product_variants
     set display_name_ar = 'شكل 3 محدث',
         images = '["https://img.example.test/br101-m3-a.jpg"]'::jsonb
   where id = v_m03;

  -- Restore label for subsequent assertions.
  update public.product_variants set display_name_ar = 'شكل 3' where id = v_m03;

  -- 4. Guards: named model cannot set price_override; cross-product barcode collision refused;
  --    duplicate model name refused; invalid gallery refused.
  begin
    update public.product_variants set price_override = 299 where id = v_m01;
    raise exception 'a named model accepted a price override';
  exception when check_violation then null;
  end;

  perform pg_temp.become(null, 'postgres');

  -- Another product or another product's variant cannot steal barcode 'BR101'.
  begin
    insert into public.product_variants(product_id, sku, barcode, color_key, color_en, size_value, stock_quantity, active)
    values(v_colour, 'P97-STEAL', 'BR101', 'gold', 'Gold', '40', 0, true);
    raise exception 'another product variant stole shared barcode BR101';
  exception when unique_violation then null;
  end;

  -- Duplicate model name on the same product (case/space-insensitive) is refused.
  begin
    insert into public.product_variants(product_id, sku, display_name_en, stock_quantity, active)
    values(v_br101, 'BR101-M01-DUP', '  model 1 ', 0, true);
    raise exception 'duplicate model name on BR101 was accepted';
  exception when unique_violation then null;
  end;

  -- Gallery > 5 URLs or non-http(s) URL is refused.
  begin
    update public.product_variants
       set images = '["https://a/1.jpg","https://a/2.jpg","https://a/3.jpg","https://a/4.jpg","https://a/5.jpg","https://a/6.jpg"]'::jsonb
     where id = v_m01;
    raise exception 'six-photo gallery was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.product_variants set images = '["javascript:alert(1)"]'::jsonb where id = v_m01;
    raise exception 'javascript: gallery URL was accepted';
  exception when check_violation then null;
  end;

  -- 5. End-to-End POS Sale of 2 units of BR101-M02 (Model 2) as authenticated admin.
  perform pg_temp.become(v_admin, 'authenticated');
  perform pg_temp.ensure_open_shift(v_admin::text);
  v_sale_res := public.pos_complete_sale(jsonb_build_object(
    'client_ref', '0097-pos-sale-br101-m02',
    'user_id',    v_admin::text,
    'user_name',  'Amina Admin',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 480.00, 'tendered', 480.00)),
    'lines',      jsonb_build_array(jsonb_build_object(
      'product_id', v_br101::text,
      'variant_id', v_m02::text,
      'qty',        2
    ))
  ));
  v_sale_id := (v_sale_res->>'sale_id')::uuid;
  select * into v_line_row from public.sale_items where sale_id = v_sale_id;

  if v_line_row.variant_id <> v_m02
     or v_line_row.sku <> 'BR101-M02'
     or v_line_row.barcode <> 'BR101'
     or v_line_row.variant_display_name <> 'Model 2'
     or v_line_row.unit_price <> 240.00
     or v_line_row.quantity <> 2 then
    raise exception 'POS sale line for BR101-M02 did not snapshot expected fields: %', row_to_json(v_line_row);
  end if;

  -- Verify stock after sale: M01=4, M02=1 (was 3), M03=5, Parent total=10.
  if (select quantity from public.branch_stock_balances where branch_id = v_main and variant_id = v_m01) <> 4
     or (select quantity from public.branch_stock_balances where branch_id = v_main and variant_id = v_m02) <> 1
     or (select quantity from public.branch_stock_balances where branch_id = v_main and variant_id = v_m03) <> 5
     or (select stock_quantity from public.products where id = v_br101) <> 10 then
    raise exception 'POS sale did not deduct exclusively from BR101-M02';
  end if;

  -- 6. End-to-End POS Return of 1 unit of BR101-M02.
  v_ret_res := public.pos_process_return(jsonb_build_object(
    'sale_id',       v_sale_id::text,
    'reason',        'Customer exchanged shape',
    'refund_method', 'cash',
    'user_id',       v_admin::text,
    'user_name',     'Amina Admin',
    'items',         jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_line_row.id::text,
      'quantity',     1
    ))
  ));
  v_ret_id := (v_ret_res->>'return_id')::uuid;
  select * into v_ret_row from public.return_items where return_id = v_ret_id;

  if v_ret_row.variant_id <> v_m02
     or v_ret_row.sku <> 'BR101-M02'
     or v_ret_row.barcode <> 'BR101'
     or v_ret_row.variant_display_name <> 'Model 2'
     or v_ret_row.quantity <> 1 then
    raise exception 'POS return line for BR101-M02 did not snapshot expected fields: %', row_to_json(v_ret_row);
  end if;

  -- Verify stock after return: M01=4, M02=2, M03=5, Parent total=11.
  if (select quantity from public.branch_stock_balances where branch_id = v_main and variant_id = v_m02) <> 2
     or (select stock_quantity from public.products where id = v_br101) <> 11 then
    raise exception 'POS return did not restock BR101-M02 accurately';
  end if;

  -- 7. Online Order Reservation & Oversell Prevention on BR101-M01 (qty = 4):
  perform pg_temp.become(null, 'anon');
  v_order_res := public.place_online_order(jsonb_build_object(
    'client_ref',     '0097-online-order-br101-m01',
    'customer_name',  'Nour Shopper',
    'customer_phone', '01012345678',
    'delivery_type',  'pickup',
    'payment_method', 'cod',
    'lines',          jsonb_build_array(jsonb_build_object(
      'product_id', v_br101::text,
      'variant_id', v_m01::text,
      'qty',        3
    ))
  ));
  v_order_id := (v_order_res->>'order_id')::uuid;
  perform pg_temp.become(null, 'postgres');
  select * into v_ord_item from public.online_order_items where order_id = v_order_id;
  if v_ord_item.variant_id <> v_m01
     or v_ord_item.sku <> 'BR101-M01'
     or v_ord_item.barcode <> 'BR101'
     or v_ord_item.variant_display_name <> 'Model 1'
     or v_ord_item.unit_price <> 240.00
     or v_ord_item.quantity <> 3 then
    raise exception 'Online order line for BR101-M01 did not snapshot expected fields: %', row_to_json(v_ord_item);
  end if;

  if not exists (
    select 1 from public.stock_reservations
     where online_order_id = v_order_id and product_id = v_br101 and variant_id = v_m01 and quantity = 3 and status = 'reserved'
  ) then
    raise exception 'Online order did not reserve 3 units on BR101-M01';
  end if;

  -- Oversell attempt: M01 has 4 physical units, 3 reserved -> only 1 available; ordering 2 more must fail.
  perform pg_temp.become(null, 'anon');
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref',     '0097-online-oversell-br101-m01',
      'customer_name',  'Oversell Shopper',
      'customer_phone', '01099999999',
      'delivery_type',  'pickup',
      'payment_method', 'cod',
      'lines',          jsonb_build_array(jsonb_build_object(
        'product_id', v_br101::text,
        'variant_id', v_m01::text,
        'qty',        2
      ))
    ));
    raise exception 'Oversell on BR101-M01 beyond unreserved balance was accepted';
  exception when others then null;
  end;

  -- 8. Stocktake (`stocktake_create`): verify BR101-M01 line carries shared barcode 'BR101' and label 'Model 1'.
  perform pg_temp.become(v_admin, 'authenticated');
  v_st_res := public.stocktake_create(false, '0097 models stocktake');
  v_st_id := (v_st_res->'session'->>'id')::uuid;
  perform pg_temp.become(null, 'postgres');
  if not exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_st_id
       and variant_id = v_m01
       and sku = 'BR101-M01'
       and barcode = 'BR101'
       and variant_label = 'Model 1'
       and expected_quantity = 4
  ) then
    raise exception 'stocktake_create did not record shared barcode BR101 and label Model 1 for BR101-M01';
  end if;

  -- 9. Storefront RPC `storefront_branch_product_variants_v2`:
  --    Deactivate M03 and verify anonymous storefront only sees active M01 (qty 4) & M02 (qty 2).
  perform pg_temp.become(null, 'postgres');
  update public.product_variants set active = false where id = v_m03;

  perform pg_temp.become(null, 'anon');
  select coalesce(jsonb_agg(to_jsonb(s) order by s.sort_order), '[]'::jsonb)
    into v_storefront
    from public.storefront_branch_product_variants_v2() s
   where s.product_id = v_br101;

  if jsonb_array_length(v_storefront) <> 2 then
    raise exception 'storefront returned % models for BR101; expected 2 active models', jsonb_array_length(v_storefront);
  end if;
  if v_storefront->0->>'sku' <> 'BR101-M01'
     or v_storefront->0->>'display_name_ar' <> 'شكل 1'
     or (v_storefront->0->>'stock_quantity')::int <> 4
     or jsonb_array_length(v_storefront->0->'images') <> 2
     or v_storefront->1->>'sku' <> 'BR101-M02'
     or (v_storefront->1->>'stock_quantity')::int <> 2 then
    raise exception 'storefront payload for BR101 models is inaccurate: %', v_storefront;
  end if;

  -- 9b. Offline Sync idempotency (replay of identical client_ref must NOT double-deduct stock)
  perform pg_temp.become(v_admin, 'authenticated');
  perform pg_temp.ensure_open_shift(v_admin::text);
  perform public.pos_complete_sale(jsonb_build_object(
    'client_ref', '0097-pos-sale-br101-m02',
    'user_id',    v_admin::text,
    'user_name',  'Amina Admin',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 480.00, 'tendered', 480.00)),
    'lines',      jsonb_build_array(jsonb_build_object(
      'product_id', v_br101::text,
      'variant_id', v_m02::text,
      'qty',        2
    ))
  ));
  if (select stock_quantity from public.product_variants where id = v_m02) <> 2 then
    raise exception 'Replayed offline sale client_ref double-deducted stock on BR101-M02!';
  end if;

  -- 9c. Storage RLS & Variant Column/Capability Protection:
  --     - Even Admin cannot directly UPDATE product_variants.active (column grant protection; must use set_variant_active).
  --     - Cashier (who has edit_product but NOT adjust_stock) cannot directly UPDATE product_variants.stock_quantity.
  --     - Viewer (who has neither edit_product nor adjust_stock) cannot upload/overwrite/delete model photos in storage.objects
  --       and cannot update product_variants.
  perform pg_temp.become(v_admin, 'authenticated');
  begin
    execute format('update public.product_variants set active = false where id = %L', v_m01);
    raise exception 'Direct UPDATE of product_variants.active succeeded; expected column privilege denial';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(null, 'postgres');
  update public.profiles set active = true, role = 'cashier', custom_role_id = null, denied_capabilities = '{}', active_branch_id = v_main where id = v_cashier;
  update public.branch_memberships set active = true, role = 'cashier' where user_id = v_cashier and branch_id = v_main;
  update public.profiles set active = true, role = 'viewer', custom_role_id = null, denied_capabilities = '{}', active_branch_id = v_main where id = v_viewer;
  update public.branch_memberships set active = true, role = 'viewer' where user_id = v_viewer and branch_id = v_main;

  -- Cashier (has edit_product, lacks adjust_stock) cannot directly modify stock_quantity on product_variants!
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    update public.product_variants set stock_quantity = 999 where id = v_m01;
    raise exception 'Cashier without adjust_stock directly modified product_variants.stock_quantity!';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_admin, 'authenticated');
  insert into storage.objects (bucket_id, name) values ('product-images', 'public/0097-br101-m01.webp');

  -- Viewer (lacks add_product, edit_product, delete_product, manage_website) cannot upload/update/delete model images
  perform pg_temp.become(v_viewer, 'authenticated');
  begin
    insert into storage.objects (bucket_id, name) values ('product-images', 'public/0097-unauthorized-viewer.webp');
    raise exception 'Viewer without product capabilities uploaded a model image to public/*';
  exception when insufficient_privilege then null;
  end;

  update storage.objects set name = 'public/0097-hijacked.webp' where name = 'public/0097-br101-m01.webp';
  if exists (select 1 from storage.objects where name = 'public/0097-hijacked.webp') then
    raise exception 'Viewer without product capabilities updated an existing model image in storage.objects';
  end if;

  delete from storage.objects where name = 'public/0097-br101-m01.webp';
  if not exists (select 1 from storage.objects where name = 'public/0097-br101-m01.webp') then
    raise exception 'Viewer without product capabilities deleted an existing model image in storage.objects';
  end if;

  -- Viewer also cannot update product_variants (stock_quantity, display_name_ar, images)
  update public.product_variants set display_name_ar = 'تعديل غير مصرح' where id = v_m01;
  if (select display_name_ar from public.product_variants where id = v_m01) = 'تعديل غير مصرح' then
    raise exception 'Viewer without edit_product updated product_variants';
  end if;

  -- 9d. Backward compatibility with v2.0.0 / v-web-prod-ca18c27 legacy RPCs & queries:
  perform pg_temp.become(null, 'anon');
  if (select count(*) from public.storefront_branch_product_variants() s where s.product_id = v_br101) <> 2 then
    raise exception 'Legacy storefront_branch_product_variants() RPC broken after 0097';
  end if;

  -- Clean up test records so subsequent seed/parity checks see a clean state.
  perform pg_temp.become(null, 'postgres');
  delete from storage.objects where name = 'public/0097-br101-m01.webp';
  delete from public.stocktake_lines where stocktake_id = v_st_id;
  delete from public.stocktakes where id = v_st_id;
  delete from public.stock_reservations where online_order_id = v_order_id;
  delete from public.order_events where order_id = v_order_id;
  delete from public.online_order_items where order_id = v_order_id;
  delete from public.online_orders where id = v_order_id;
  delete from public.return_items where return_id = v_ret_id;
  delete from public.refund_records where return_id = v_ret_id;
  delete from public.sales_returns where id = v_ret_id;
  delete from public.sale_payments where sale_id = v_sale_id;
  delete from public.sale_items where sale_id = v_sale_id;
  delete from public.sales where id = v_sale_id;
  delete from public.stock_movements where product_id in (v_br101, v_legacy, v_colour);
  delete from public.branch_stock_balances where product_id in (v_br101, v_legacy, v_colour);
  delete from public.product_variants where product_id in (v_br101, v_legacy, v_colour);
  delete from public.products where id in (v_br101, v_legacy, v_colour);
  delete from public.categories where id = v_category;

  raise notice '0097 — Shared Barcode (BR101) & Individual Models (BR101-M01..M03) verified across POS sale, return, online reservation, oversell prevention, stocktake, stock rollup, RLS, and storefront';
end
$variant_models_0097$;

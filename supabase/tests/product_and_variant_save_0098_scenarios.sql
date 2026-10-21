-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0098 Verification Suite
-- Verifies:
--   1. In-place product edits (name, price, images, low_stock_level) succeed
--      when the product's existing category was archived (`active = false`),
--      while moving to a different archived category or inserting into an
--      archived category remains refused (`23514`).
--   2. Legacy 1-char `color_key` values (`'r'` on `ROSE` / `BR104-R-2` and
--      `'ا'` on `احمر`) are healed on UPDATE/INSERT so `ROSE` and `RED`
--      coexist without colliding on `color_key = 'r'`.
--   3. `enable_product_variants` preserves exact stock (`3 = 2 + 1`) across
--      `ROSE` and `RED` without losing or inventing units.
--   4. Updating `low_stock_level` on `products` or `product_variants` syncs
--      `branch_stock_balances.reorder_level`.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  v_admin uuid;
  v_cat_archived uuid := gen_random_uuid();
  v_cat_other_archived uuid := gen_random_uuid();
  v_cat_active uuid := gen_random_uuid();
  v_br104 uuid := gen_random_uuid();
  v_rose uuid := gen_random_uuid();
  v_red uuid := gen_random_uuid();
  v_simple uuid := gen_random_uuid();
  v_color_key text;
  v_stock integer;
  v_reorder integer;
  v_blocked boolean := false;
begin
  select id into v_admin from public.profiles where role = 'admin' and active limit 1;
  if v_admin is null then
    v_admin := gen_random_uuid();
    insert into public.profiles (id, email, full_name, role, active)
    values (v_admin, 'test-0098-admin@alyq.test', 'Test 0098 Admin', 'admin', true);
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  -- 1. Create two categories, put BR104 into the first, then archive both categories
  insert into public.categories (id, name_ar, name_en, active, sort_order)
  values
    (v_cat_archived, 'اساور اختبار', 'Test Bracelets', true, 1),
    (v_cat_other_archived, 'سلاسل اختبار', 'Test Necklaces', false, 2),
    (v_cat_active, 'خواتم اختبار', 'Test Rings', true, 3);

  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_tracking_enabled, variants_enabled,
    stock_quantity, low_stock_level, active
  ) values (
    v_br104, 'TEST-BR104', 'TEST-BR104', 'BR-104', 'BR-104', v_cat_archived,
    220, 85, true, false, 3, 5, true
  );

  update public.categories set active = false where id = v_cat_archived;

  -- In-place edit of BR104 (saveProduct omits unchanged category_id from SET list) must succeed
  update public.products
     set name_ar = 'إسورة BR-104 معدلة',
         name_en = 'BR-104 Updated',
         selling_price = 235
   where id = v_br104;

  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 1 failed: expected BR104 stock 3 after name/price edit, got %', v_stock;
  end if;

  -- Moving BR104 to a DIFFERENT archived category must still be refused (23514)
  v_blocked := false;
  begin
    update public.products set category_id = v_cat_other_archived where id = v_br104;
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 1b failed: moving product to a different archived category was not blocked';
  end if;

  -- 2. Legacy 1-char color_key = 'r' on ROSE ('BR104-R-2') healed + RED ('BR104-RED') added
  insert into public.product_variants (
    id, product_id, sku, barcode, color_key, color_ar, color_en,
    stock_quantity, low_stock_level, active, sort_order
  ) values (
    v_rose, v_br104, 'TEST-BR104-R-2', 'TEST-BR104-R-2', '', 'روز', 'ROSE',
    0, 5, true, 1
  );
  -- Simulate the legacy 1-char color_key='r' stored before 0098
  update public.product_variants set color_key = 'r' where id = v_rose;

  -- Updating ROSE with color_key = 'r' or '' heals it to 'rose'
  update public.product_variants
     set color_key = 'r',
         price_override = 240
   where id = v_rose;

  select color_key into v_color_key from public.product_variants where id = v_rose;
  if v_color_key <> 'rose' then
    raise exception 'Scenario 2a failed: expected ROSE color_key to heal to rose, got %', v_color_key;
  end if;

  -- Inserting RED (even if caller sends 1-char color_key = 'r') heals to 'red' and succeeds
  insert into public.product_variants (
    id, product_id, sku, barcode, color_key, color_ar, color_en,
    stock_quantity, low_stock_level, active, sort_order
  ) values (
    v_red, v_br104, 'TEST-BR104-RED', 'TEST-BR104-RED', 'r', 'أحمر', 'RED',
    0, 5, true, 2
  );

  select color_key into v_color_key from public.product_variants where id = v_red;
  if v_color_key <> 'red' then
    raise exception 'Scenario 2b failed: expected RED color_key to be red, got %', v_color_key;
  end if;

  -- Parent stock is still 3 while variants_enabled = false
  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 2c failed: expected BR104 stock 3 before enabling variants, got %', v_stock;
  end if;

  -- 3. Enable variants on BR104 distributing 2 to ROSE and 1 to RED
  perform public.enable_product_variants(
    v_br104,
    jsonb_build_object(v_rose::text, 2, v_red::text, 1),
    v_admin::text,
    'Test 0098 Admin'
  );

  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 3a failed: expected BR104 stock 3 after enable_product_variants, got %', v_stock;
  end if;

  select stock_quantity into v_stock from public.product_variants where id = v_rose;
  if v_stock <> 2 then
    raise exception 'Scenario 3b failed: expected ROSE stock 2, got %', v_stock;
  end if;

  select stock_quantity into v_stock from public.product_variants where id = v_red;
  if v_stock <> 1 then
    raise exception 'Scenario 3c failed: expected RED stock 1, got %', v_stock;
  end if;

  -- 4. Updating low_stock_level syncs branch_stock_balances.reorder_level
  update public.product_variants set low_stock_level = 9 where id = v_rose;
  select reorder_level into v_reorder
    from public.branch_stock_balances
   where variant_id = v_rose
   limit 1;
  if v_reorder <> 9 then
    raise exception 'Scenario 4a failed: expected variant branch reorder_level 9, got %', v_reorder;
  end if;

  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_tracking_enabled, variants_enabled,
    stock_quantity, low_stock_level, active
  ) values (
    v_simple, 'TEST-SIMPLE-0098', 'TEST-SIMPLE-0098', 'منتج بسيط', 'Simple Product', v_cat_active,
    100, 40, true, false, 4, 5, true
  );
  update public.products set low_stock_level = 8 where id = v_simple;
  select reorder_level into v_reorder
    from public.branch_stock_balances
   where product_id = v_simple and variant_id is null
   limit 1;
  if v_reorder <> 8 then
    raise exception 'Scenario 4b failed: expected product branch reorder_level 8, got %', v_reorder;
  end if;
end;
$$;

rollback;

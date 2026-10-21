-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0098 Verification Suite (10 Scenarios)
-- Verifies:
--   1. Editing name, price, and images of a product inside an intentionally
--      archived category (`active = false`) succeeds (both minimal PATCH and
--      full-row UPDATE with unchanged `category_id`), while moving a product
--      into an archived category remains strictly refused (`23514`).
--   2. Saving legacy variants (`ROSE` / `BR104-R-2` with `color_key = 'r'`)
--      via Save Combinations heals `color_key` to `'rose'` and allows adding
--      `RED` (`BR104-RED`) without collision or deleting legacy rows.
--   3. Saving the product (Save Product) and enabling variants preserves exact
--      stock (`3 = 2 + 1`).
--   4. The archived category remains archived (`active = false`) throughout
--      and is never auto-reactivated.
--   5. The archived category remains hidden from `storefront_categories()`
--      and `storefront_categories_v2()`.
--   6. Stock balances (`stock_quantity` and `branch_stock_balances.quantity`)
--      never change without a legitimate stock movement, and direct stock
--      writes on variant-enabled products are refused (`23514`).
--   7. Authorized staff (`admin`) can read and manage the product and its
--      `low_stock_level` syncs `branch_stock_balances.reorder_level`.
--   8. Products inside active categories remain completely unaffected.
--   9. Shared-barcode multi-model products (`0097` — `BR101` + `BR101-M01`,
--      `BR101-M02`) work seamlessly with `0098` inside archived and active
--      categories.
--  10. RLS & permissions strictly block unauthorized users (`viewer` /
--      `cashier` without `edit_product`) from modifying products or variants
--      in archived categories.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  v_admin uuid;
  v_viewer uuid := gen_random_uuid();
  v_cat_archived uuid := gen_random_uuid();
  v_cat_other_archived uuid := gen_random_uuid();
  v_cat_active uuid := gen_random_uuid();
  v_br104 uuid := gen_random_uuid();
  v_rose uuid := gen_random_uuid();
  v_red uuid := gen_random_uuid();
  v_simple uuid := gen_random_uuid();
  v_br101 uuid := gen_random_uuid();
  v_m01 uuid := gen_random_uuid();
  v_m02 uuid := gen_random_uuid();
  v_color_key text;
  v_stock integer;
  v_reorder integer;
  v_cat_is_active boolean;
  v_count integer;
  v_blocked boolean := false;
  v_backup_manifest jsonb;
  v_backup_id uuid;
  v_restore_outcome jsonb;
  v_name_ar text;
begin
  select id into v_admin from public.profiles where role = 'admin' and active limit 1;
  if v_admin is null then
    v_admin := '00000000-0000-4000-8000-0000000000a1';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  -- Setup categories: v_cat_archived starts active to shelve BR104 & BR101
  -- (matching Production history where BR104 & BR101 existed before archiving),
  -- then is intentionally archived.
  insert into public.categories (id, name_ar, name_en, active, sort_order)
  values
    (v_cat_archived, 'اساور مؤرشفة عمدا', 'Intentionally Archived Bracelets', true, 1),
    (v_cat_other_archived, 'سلاسل مؤرشفة عمدا', 'Intentionally Archived Necklaces', false, 2),
    (v_cat_active, 'خواتم نشطة', 'Active Rings', true, 3);

  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_tracking_enabled, variants_enabled,
    stock_quantity, low_stock_level, active, image_url, images
  ) values (
    v_br104, 'TEST-BR104', 'TEST-BR104', 'BR-104', 'BR-104', v_cat_archived,
    220, 85, true, false, 3, 5, true, null, '{}'::text[]
  );

  -- Existing BR101 created while the category was still active (before archiving)
  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_tracking_enabled, variants_enabled,
    stock_quantity, low_stock_level, active
  ) values (
    v_br101, 'TEST-BR101', 'TEST-BR101', 'إسورة موديلات', 'Models Bracelet', v_cat_archived,
    250, 100, true, false, 5, 5, true
  );

  -- Intentionally archive the category (matching the owner's production state)
  update public.categories set active = false where id = v_cat_archived;

  -- ── Scenario 1: Edit name, price, and images of BR104 inside the archived category ──
  -- 1a. Minimal PATCH (omitting category_id, as sent by saveProduct)
  update public.products
     set name_ar = 'إسورة BR-104 معدلة',
         name_en = 'BR-104 Updated',
         selling_price = 235,
         image_url = 'https://example.com/br104-cover.jpg',
         images = array['https://example.com/br104-cover.jpg', 'https://example.com/br104-2.jpg']
   where id = v_br104;

  -- 1b. Full-row UPDATE including unchanged category_id = v_cat_archived
  update public.products
     set name_ar = 'إسورة BR-104 معدلة 2',
         selling_price = 240,
         category_id = v_cat_archived
   where id = v_br104;

  -- 1c. Moving BR104 to a DIFFERENT archived category must still be refused (23514)
  v_blocked := false;
  begin
    update public.products set category_id = v_cat_other_archived where id = v_br104;
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 1c failed: moving product to a different archived category was not blocked';
  end if;

  -- 1d. Pure forged `SET category_id = v_cat_archived` with no product edits is refused
  v_blocked := false;
  begin
    update public.products set category_id = v_cat_archived where id = v_br104;
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 1d failed: pure forged category_id assignment to archived category was not blocked';
  end if;

  -- 1e. Creating a NEW product inside an already-archived category is strictly refused (23514)
  v_blocked := false;
  begin
    insert into public.products (
      id, sku, barcode, name_ar, name_en, category_id,
      selling_price, cost_price, stock_tracking_enabled, variants_enabled,
      stock_quantity, low_stock_level, active
    ) values (
      gen_random_uuid(), 'TEST-ILLEGAL-NEW', 'TEST-ILLEGAL-NEW',
      'منتج جديد مرفوض', 'Illegal New Product', v_cat_archived,
      100, 50, true, false, 1, 1, true
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 1e failed: creating a new product inside an archived category was not blocked';
  end if;

  -- ── Scenario 2: Save Combinations on legacy ROSE ('r') + new RED ('red') ──
  insert into public.product_variants (
    id, product_id, sku, barcode, color_key, color_ar, color_en,
    stock_quantity, low_stock_level, active, sort_order
  ) values (
    v_rose, v_br104, 'TEST-BR104-R-2', 'TEST-BR104-R-2', '', 'روز', 'ROSE',
    0, 5, true, 1
  );
  update public.product_variants set color_key = 'r' where id = v_rose;

  update public.product_variants
     set color_key = 'r',
         price_override = 245,
         image_url = 'https://example.com/br104-rose.jpg'
   where id = v_rose;

  select color_key into v_color_key from public.product_variants where id = v_rose;
  if v_color_key <> 'rose' then
    raise exception 'Scenario 2a failed: expected ROSE color_key to heal to rose, got %', v_color_key;
  end if;

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

  -- ── Scenario 3: Save Product & enable_product_variants preserves stock 3 = 2 + 1 ──
  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 3a failed: expected BR104 stock 3 before enabling variants, got %', v_stock;
  end if;

  perform public.enable_product_variants(
    v_br104,
    jsonb_build_object(v_rose::text, 2, v_red::text, 1),
    v_admin::text,
    'Test 0098 Admin'
  );

  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 3b failed: expected BR104 stock 3 after enable_product_variants, got %', v_stock;
  end if;

  -- ── Scenario 4: Category remains archived (active = false) after all saves ──
  select active into v_cat_is_active from public.categories where id = v_cat_archived;
  if v_cat_is_active is not false then
    raise exception 'Scenario 4 failed: archived category was unexpectedly reactivated';
  end if;

  -- ── Scenario 5: Archived category is hidden from storefront_categories / v2 ──
  select count(*) into v_count from public.storefront_categories() where id = v_cat_archived;
  if v_count <> 0 then
    raise exception 'Scenario 5a failed: archived category appeared in storefront_categories()';
  end if;

  select count(*) into v_count from public.storefront_categories_v2() where id = v_cat_archived;
  if v_count <> 0 then
    raise exception 'Scenario 5b failed: archived category appeared in storefront_categories_v2()';
  end if;

  -- ── Scenario 6: Stock is unchanged by metadata edits & direct write is blocked ──
  update public.products set name_en = 'BR-104 Final Name', selling_price = 250 where id = v_br104;
  select stock_quantity into v_stock from public.products where id = v_br104;
  if v_stock <> 3 then
    raise exception 'Scenario 6a failed: metadata edit altered product stock to %', v_stock;
  end if;

  v_blocked := false;
  begin
    update public.products set stock_quantity = 99 where id = v_br104;
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 6b failed: direct stock write on variant-enabled product was not blocked';
  end if;

  -- ── Scenario 7: Authorized staff reads & reorder_level syncs ──
  update public.product_variants set low_stock_level = 9 where id = v_rose;
  select reorder_level into v_reorder from public.branch_stock_balances where variant_id = v_rose limit 1;
  if v_reorder <> 9 then
    raise exception 'Scenario 7 failed: expected variant branch reorder_level 9, got %', v_reorder;
  end if;

  -- ── Scenario 8: Products inside active categories are unaffected ──
  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_tracking_enabled, variants_enabled,
    stock_quantity, low_stock_level, active, show_on_website
  ) values (
    v_simple, 'TEST-SIMPLE-0098', 'TEST-SIMPLE-0098', 'منتج بسيط', 'Simple Product', v_cat_active,
    100, 40, true, false, 4, 5, true, true
  );
  update public.products set low_stock_level = 8, selling_price = 115 where id = v_simple;
  select reorder_level into v_reorder
    from public.branch_stock_balances
   where product_id = v_simple and variant_id is null
   limit 1;
  if v_reorder <> 8 then
    raise exception 'Scenario 8a failed: expected active-category product reorder_level 8, got %', v_reorder;
  end if;

  select count(*) into v_count from public.storefront_categories_v2() where id = v_cat_active;
  if v_count <> 1 then
    raise exception 'Scenario 8b failed: active category missing from storefront_categories_v2()';
  end if;

  -- ── Scenario 9: Shared Barcode + Multi-Model (0097) on an existing product inside an archived category ──
  -- Prove that adding 0097 shared-barcode models (color_key = '', barcode = NULL)
  -- and enabling variants on an ALREADY-EXISTING product (v_br101) inside an
  -- archived category succeeds, while v_cat_archived remains active = false.
  insert into public.product_variants (
    id, product_id, sku, barcode, color_key, display_name_ar, display_name_en,
    images, stock_quantity, low_stock_level, active, sort_order
  ) values
    (v_m01, v_br101, 'TEST-BR101-M01', null, '', 'موديل فراشة', 'Butterfly Model', '["https://example.com/m1.jpg"]'::jsonb, 0, 2, true, 1),
    (v_m02, v_br101, 'TEST-BR101-M02', null, '', 'موديل قلب', 'Heart Model', '["https://example.com/m2.jpg"]'::jsonb, 0, 2, true, 2);

  perform public.enable_product_variants(
    v_br101,
    jsonb_build_object(v_m01::text, 3, v_m02::text, 2),
    v_admin::text,
    'Test 0098 Admin'
  );

  update public.products
     set name_ar = 'إسورة موديلات محدثة',
         selling_price = 265,
         image_url = 'https://example.com/br101-main.jpg'
   where id = v_br101;

  update public.product_variants
     set display_name_ar = 'موديل فراشة ذهبي',
         images = '["https://example.com/m1-new.jpg","https://example.com/m1-side.jpg"]'::jsonb
   where id = v_m01;

  select stock_quantity into v_stock from public.products where id = v_br101;
  if v_stock <> 5 then
    raise exception 'Scenario 9a failed: expected BR101 shared-barcode model rollup stock 5, got %', v_stock;
  end if;

  select count(*) into v_count from public.product_variants where product_id = v_br101 and barcode is null;
  if v_count <> 2 then
    raise exception 'Scenario 9b failed: expected 2 shared-barcode models with NULL variant barcode, got %', v_count;
  end if;

  select active into v_cat_is_active from public.categories where id = v_cat_archived;
  if v_cat_is_active is not false then
    raise exception 'Scenario 9c failed: archived category was reactivated during 0097 model save';
  end if;

  -- ── Scenario 10: RLS & permission enforcement for unauthorized user (viewer) ──
  perform set_config('request.jwt.claim.sub', v_viewer::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text, true);

  if public.can('edit_product') then
    raise exception 'Scenario 10a failed: viewer unexpectedly holds edit_product capability';
  end if;

  v_blocked := false;
  begin
    perform public.set_product_active(v_br104, false);
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 10b failed: viewer was not refused by set_product_active';
  end if;

  v_blocked := false;
  begin
    perform public.set_variant_active(v_rose, false);
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'Scenario 10c failed: viewer was not refused by set_variant_active';
  end if;

  -- Restore admin context
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  -- ── Scenario 11: Real Backup & Restore Verification with archived categories & 0097/0098 data ──
  update public.profiles
     set extra_capabilities = array_append(coalesce(extra_capabilities, '{}'), 'restore_backup')
   where id = v_admin
     and not ('restore_backup' = any(coalesce(extra_capabilities, '{}')));

  v_backup_manifest := public.create_backup('manual', '0098 archived-categories + models restore test');
  v_backup_id := (v_backup_manifest->>'id')::uuid;

  -- Mutate state after snapshot
  update public.products set name_ar = 'اسم مؤقت سيتم التراجع عنه بالاستعادة', selling_price = 999 where id = v_br104;
  update public.product_variants set display_name_ar = 'اسم موديل مؤقت' where id = v_m01;

  -- Execute full system restore from backup
  v_restore_outcome := public.admin_restore_backup(v_backup_id);
  if not coalesce((v_restore_outcome->>'ok')::boolean, false) then
    raise exception 'Scenario 11a failed: admin_restore_backup did not return ok=true: %', v_restore_outcome;
  end if;

  -- Verify archived categories remained active = false after restore
  select active into v_cat_is_active from public.categories where id = v_cat_archived;
  if v_cat_is_active is not false then
    raise exception 'Scenario 11b failed: restored archived category became active';
  end if;

  -- Verify BR104 and BR101 and their variants/models restored to exact snapshot state
  select name_ar, stock_quantity into v_name_ar, v_stock from public.products where id = v_br104;
  if v_name_ar <> 'إسورة BR-104 معدلة 2' or v_stock <> 3 then
    raise exception 'Scenario 11c failed: restored BR104 mismatch (name_ar=%, stock=%)', v_name_ar, v_stock;
  end if;

  select display_name_ar into v_name_ar from public.product_variants where id = v_m01;
  if v_name_ar <> 'موديل فراشة ذهبي' then
    raise exception 'Scenario 11d failed: restored BR101-M01 display_name_ar mismatch (%)', v_name_ar;
  end if;
end;
$$;

rollback;

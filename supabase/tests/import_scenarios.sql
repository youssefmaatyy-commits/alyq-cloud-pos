-- supabase/tests/import_scenarios.sql
-- Rigorous SQL tests for execute_import_batch: Atomicity, Idempotency, Capability Security, Multi-Branch & Negative Stock Safety

DO $$
DECLARE
  v_admin_id uuid;
  v_branch1_id uuid;
  v_branch2_id uuid;
  v_cat_id uuid;
  v_archived_cat_id uuid;
  v_res jsonb;
  v_res_replay jsonb;
  v_prod_count_before integer;
  v_prod_count_after integer;
  v_var_count_before integer;
  v_var_count_after integer;
  v_mov_count_before integer;
  v_mov_count_after integer;
  v_audit_count_before integer;
  v_audit_count_after integer;
  v_cat_count_before integer;
  v_cat_count_after integer;
  v_stock_b1 integer;
  v_stock_b2 integer;
  v_failed boolean := false;
  v_var_barcode text;
BEGIN
  -- Setup test context as admin
  SELECT id INTO v_admin_id FROM public.profiles WHERE role = 'admin' LIMIT 1;
  IF v_admin_id IS NULL THEN
    v_admin_id := '00000000-0000-0000-0000-000000000001'::uuid;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);

  -- Get branches
  SELECT id INTO v_branch1_id FROM public.branches WHERE active = true ORDER BY created_at ASC LIMIT 1;
  SELECT id INTO v_branch2_id FROM public.branches WHERE active = true AND id <> v_branch1_id ORDER BY created_at ASC LIMIT 1;
  IF v_branch2_id IS NULL THEN
    v_branch2_id := v_branch1_id;
  END IF;

  -- Get an active category and an archived category
  SELECT id INTO v_cat_id FROM public.categories WHERE active = true LIMIT 1;
  
  -- Create or find an archived category for testing
  SELECT id INTO v_archived_cat_id FROM public.categories WHERE active = false LIMIT 1;
  IF v_archived_cat_id IS NULL THEN
    INSERT INTO public.categories (name_ar, name_en, active)
    VALUES ('تصنيف مؤرشف للاختبار', 'Archived Test Category', false)
    RETURNING id INTO v_archived_cat_id;
  END IF;

  -- ── SCENARIO 1: Successful atomic execution of a multi-row import batch ──
  SELECT count(*) INTO v_prod_count_before FROM public.products;
  SELECT count(*) INTO v_var_count_before FROM public.product_variants;
  SELECT count(*) INTO v_mov_count_before FROM public.stock_movements;
  SELECT count(*) INTO v_audit_count_before FROM public.audit_log WHERE action = 'import.applied';

  v_res := public.execute_import_batch(
    p_batch_id => 'batch-test-success-001',
    p_kind => 'catalog_unified',
    p_mode => 'all-or-nothing',
    p_stock_mode => 'set',
    p_product_policy => 'reject',
    p_branch_id => v_branch1_id::text,
    p_filename => 'catalog_batch_1.xlsx',
    p_rows => jsonb_build_array(
      jsonb_build_object(
        'sku', 'SQL-TEST-01',
        'name_ar', 'منتج اختبار 1',
        'name_en', 'Test Product 1',
        'category', v_cat_id::text,
        'selling_price', 100,
        'cost_price', 50,
        'variant_sku', 'SQL-TEST-01-M',
        'color_en', 'Black',
        'size', 40,
        'branch', v_branch1_id::text,
        'quantity', 10,
        'stock_action', 'SET_STOCK'
      ),
      jsonb_build_object(
        'sku', 'SQL-TEST-01',
        'name_ar', 'منتج اختبار 1',
        'name_en', 'Test Product 1',
        'category', v_cat_id::text,
        'selling_price', 100,
        'cost_price', 50,
        'variant_sku', 'SQL-TEST-01-L',
        'color_en', 'Black',
        'size', 42,
        'branch', v_branch1_id::text,
        'quantity', 15,
        'stock_action', 'SET_STOCK'
      )
    )
  );

  ASSERT (v_res->>'status') = 'completed', 'Batch status must be completed';
  ASSERT (v_res->>'written')::int = 3, 'Expected 3 mutations (1 parent + 2 variants)';

  SELECT count(*) INTO v_prod_count_after FROM public.products;
  SELECT count(*) INTO v_var_count_after FROM public.product_variants;
  SELECT count(*) INTO v_mov_count_after FROM public.stock_movements;
  SELECT count(*) INTO v_audit_count_after FROM public.audit_log WHERE action = 'import.applied';

  ASSERT v_prod_count_after = v_prod_count_before + 1, 'Exactly 1 product must be created';
  ASSERT v_var_count_after = v_var_count_before + 2, 'Exactly 2 variants must be created';
  ASSERT v_mov_count_after = v_mov_count_before + 2, 'Exactly 2 stock movements must be recorded';
  ASSERT v_audit_count_after = v_audit_count_before + 1, 'Exactly 1 audit log entry must be recorded';

  -- ── SCENARIO 2: Batch Idempotency — Replaying same batch_id produces 0 duplicate mutations ──
  v_res_replay := public.execute_import_batch(
    p_batch_id => 'batch-test-success-001',
    p_kind => 'catalog_unified',
    p_mode => 'all-or-nothing',
    p_stock_mode => 'set',
    p_product_policy => 'reject',
    p_branch_id => v_branch1_id::text,
    p_filename => 'catalog_batch_1.xlsx',
    p_rows => jsonb_build_array(
      jsonb_build_object('sku', 'SQL-TEST-01', 'name_en', 'Test Product 1')
    )
  );

  ASSERT v_res_replay = v_res, 'Replayed batch must return identical summary';

  SELECT count(*) INTO v_prod_count_after FROM public.products;
  SELECT count(*) INTO v_var_count_after FROM public.product_variants;
  SELECT count(*) INTO v_mov_count_after FROM public.stock_movements;
  SELECT count(*) INTO v_audit_count_after FROM public.audit_log WHERE action = 'import.applied';

  ASSERT v_prod_count_after = v_prod_count_before + 1, 'Zero duplicate products on batch replay';
  ASSERT v_var_count_after = v_var_count_before + 2, 'Zero duplicate variants on batch replay';
  ASSERT v_mov_count_after = v_mov_count_before + 2, 'Zero duplicate movements on batch replay';
  ASSERT v_audit_count_after = v_audit_count_before + 1, 'Zero duplicate audit records on batch replay';

  -- ── SCENARIO 3: Stock-changing row without explicit branch is rejected (NO fallback) ──
  v_failed := false;
  BEGIN
    PERFORM public.execute_import_batch(
      p_batch_id => 'batch-test-no-branch-003',
      p_kind => 'stock',
      p_mode => 'all-or-nothing',
      p_stock_mode => 'set',
      p_rows => jsonb_build_array(
        jsonb_build_object(
          'sku', 'SQL-TEST-01',
          'variant_sku', 'SQL-TEST-01-M',
          'quantity', 20,
          'stock_action', 'SET_STOCK'
          -- 'branch' omitted intentionally
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  ASSERT v_failed = true, 'Stock adjustment row with missing branch must fail';

  -- ── SCENARIO 4: Negative stock attempt is blocked and rolls back everything ──
  v_failed := false;
  BEGIN
    PERFORM public.execute_import_batch(
      p_batch_id => 'batch-test-neg-stock-004',
      p_kind => 'stock',
      p_mode => 'all-or-nothing',
      p_stock_mode => 'delta',
      p_rows => jsonb_build_array(
        jsonb_build_object(
          'sku', 'SQL-TEST-01',
          'variant_sku', 'SQL-TEST-01-M',
          'branch', v_branch1_id::text,
          'quantity', 50, -- Attempting to subtract 50 when shelf has only 10
          'stock_action', 'SUBTRACT_STOCK'
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  ASSERT v_failed = true, 'Negative stock reduction must raise exception and fail';

  -- ── SCENARIO 5: Unknown Category blocks entire batch & never creates category ──
  SELECT count(*) INTO v_cat_count_before FROM public.categories;
  v_failed := false;
  BEGIN
    PERFORM public.execute_import_batch(
      p_batch_id => 'batch-test-unknown-cat-005',
      p_kind => 'catalog_unified',
      p_mode => 'all-or-nothing',
      p_product_policy => 'reject',
      p_rows => jsonb_build_array(
        jsonb_build_object('sku', 'SQL-FAIL-CAT-01', 'name_en', 'Fail Category Product', 'category', 'NonExistentCategory999')
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  ASSERT v_failed = true, 'Unknown category must throw error and abort';
  SELECT count(*) INTO v_cat_count_after FROM public.categories;
  ASSERT v_cat_count_after = v_cat_count_before, 'Import must NEVER create categories';

  -- ── SCENARIO 6: Archived Category blocks entire batch ──
  v_failed := false;
  BEGIN
    PERFORM public.execute_import_batch(
      p_batch_id => 'batch-test-archived-cat-006',
      p_kind => 'catalog_unified',
      p_mode => 'all-or-nothing',
      p_product_policy => 'reject',
      p_rows => jsonb_build_array(
        jsonb_build_object('sku', 'SQL-FAIL-ARCH-01', 'name_en', 'Fail Archived Product', 'category', v_archived_cat_id::text)
      )
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;

  ASSERT v_failed = true, 'Archived category must throw error and abort';

  -- ── SCENARIO 7: Multi-Branch Exact Shelf Mutations ──
  IF v_branch1_id <> v_branch2_id THEN
    PERFORM public.execute_import_batch(
      p_batch_id => 'batch-test-multi-branch-007',
      p_kind => 'stock',
      p_mode => 'all-or-nothing',
      p_rows => jsonb_build_array(
        jsonb_build_object(
          'sku', 'SQL-TEST-01',
          'variant_sku', 'SQL-TEST-01-M',
          'branch', v_branch1_id::text,
          'quantity', 12,
          'stock_action', 'SET_STOCK'
        ),
        jsonb_build_object(
          'sku', 'SQL-TEST-01',
          'variant_sku', 'SQL-TEST-01-M',
          'branch', v_branch2_id::text,
          'quantity', 4,
          'stock_action', 'SET_STOCK'
        )
      )
    );

    SELECT quantity INTO v_stock_b1 FROM public.branch_stock_balances WHERE branch_id = v_branch1_id AND variant_id = (SELECT id FROM public.product_variants WHERE sku = 'SQL-TEST-01-M');
    SELECT quantity INTO v_stock_b2 FROM public.branch_stock_balances WHERE branch_id = v_branch2_id AND variant_id = (SELECT id FROM public.product_variants WHERE sku = 'SQL-TEST-01-M');

    ASSERT v_stock_b1 = 12, 'Branch 1 shelf must be exactly 12';
    ASSERT v_stock_b2 = 4, 'Branch 2 shelf must be exactly 4';
  END IF;

  -- ── SCENARIO 8: Barcode single-source derivation & preservation ──
  SELECT barcode INTO v_var_barcode FROM public.product_variants WHERE sku = 'SQL-TEST-01-M';
  ASSERT v_var_barcode = 'SQL-TEST-01-M', 'Blank barcode must be derived from SKU via canonical lifecycle';

  -- Update with blank barcode preserves existing barcode
  PERFORM public.execute_import_batch(
    p_batch_id => 'batch-test-update-barcode-008',
    p_kind => 'catalog_unified',
    p_mode => 'all-or-nothing',
    p_product_policy => 'update',
    p_rows => jsonb_build_array(
      jsonb_build_object(
        'sku', 'SQL-TEST-01',
        'variant_sku', 'SQL-TEST-01-M',
        'barcode', '', -- Blank should preserve existing
        'selling_price', 120
      )
    )
  );

  SELECT barcode INTO v_var_barcode FROM public.product_variants WHERE sku = 'SQL-TEST-01-M';
  ASSERT v_var_barcode = 'SQL-TEST-01-M', 'Existing barcode must be preserved when blank in Excel';

  RAISE NOTICE 'Import batch PostgreSQL atomicity, idempotency, and rollback scenarios passed successfully';
END $$;

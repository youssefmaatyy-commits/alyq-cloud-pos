-- 0089_import_history_and_batch_tracking.sql
-- Master Excel Import History, Batch Idempotency, and Server-Side Atomic Transaction RPC.

-- 1. Create public.import_batches table
CREATE TABLE IF NOT EXISTS public.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id text UNIQUE NOT NULL,
  kind text NOT NULL,
  mode text NOT NULL DEFAULT 'all-or-nothing',
  stock_mode text,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'rolled_back')),
  filename text,
  total_rows integer NOT NULL DEFAULT 0,
  written_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  summary jsonb,
  errors jsonb,
  branch_id text,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for batch lookup & audit query
CREATE INDEX IF NOT EXISTS idx_import_batches_batch_id ON public.import_batches(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON public.import_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_kind ON public.import_batches(kind);

-- Enable RLS
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Staff with import permission can view import batches" ON public.import_batches;
CREATE POLICY "Staff with import permission can view import batches"
  ON public.import_batches
  FOR SELECT
  TO authenticated
  USING (
    public.can('import_data') OR
    public.can('view_products') OR
    public.can('view_reports')
  );

DROP POLICY IF EXISTS "Staff with import permission can insert import batches" ON public.import_batches;
CREATE POLICY "Staff with import permission can insert import batches"
  ON public.import_batches
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can('import_data')
  );

DROP POLICY IF EXISTS "Staff with import permission can update import batches" ON public.import_batches;
CREATE POLICY "Staff with import permission can update import batches"
  ON public.import_batches
  FOR UPDATE
  TO authenticated
  USING (
    public.can('import_data')
  );

-- Grants
GRANT SELECT, INSERT, UPDATE ON public.import_batches TO authenticated;

-- 2. Authoritative PostgreSQL Transaction RPC for Atomic Import
CREATE OR REPLACE FUNCTION public.execute_import_batch(
  p_batch_id text,
  p_kind text,
  p_mode text DEFAULT 'all-or-nothing',
  p_stock_mode text DEFAULT 'set',
  p_product_policy text DEFAULT 'reject',
  p_branch_id text DEFAULT NULL,
  p_filename text DEFAULT NULL,
  p_rows jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_actor_name text := 'Admin';
  v_existing_status text;
  v_existing_summary jsonb;
  row_item jsonb;
  r_product_group text;
  r_sku text;
  r_barcode text;
  r_name_ar text;
  r_name_en text;
  r_category text;
  r_product_type text;
  r_selling_price numeric;
  r_cost_price numeric;
  r_tax_rate numeric;
  r_low_stock integer;
  r_stock_tracking boolean;
  r_variant_sku text;
  r_color_ar text;
  r_color_en text;
  r_size numeric;
  r_size_label text;
  r_price_override numeric;
  r_cost_override numeric;
  r_branch text;
  r_stock_action text;
  r_quantity integer;
  r_reason text;
  
  v_cat_id uuid;
  v_cat_matches integer;
  v_prod_id uuid;
  v_prod_variants boolean;
  v_prod_stock integer;
  v_var_id uuid;
  v_var_barcode text;
  v_var_stock integer;
  v_effective_branch_id uuid;
  v_branch_name text;
  v_current_shelf integer := 0;
  v_new_shelf integer := 0;
  v_delta integer := 0;
  v_curr_selling_price numeric;
  v_curr_cost_price numeric;
  
  -- In-batch group tracking for new products (group_key -> created product id)
  v_group_key text;
  v_new_groups jsonb := '{}'::jsonb;
  
  v_created_products text[] := '{}';
  v_updated_products text[] := '{}';
  v_created_variants text[] := '{}';
  v_updated_variants text[] := '{}';
  v_stock_adj_count integer := 0;
  v_written_count integer := 0;
  v_result_summary jsonb;
BEGIN
  IF p_batch_id IS NULL OR p_batch_id = '' THEN
    RAISE EXCEPTION 'Import batch ID is required';
  END IF;

  -- 1. Acquire transaction-level advisory lock on batch ID to guarantee concurrency safety
  -- Any concurrent request for the same batch waits here until the first transaction commits/rolls back.
  PERFORM pg_advisory_xact_lock(hashtext('import_batch_' || p_batch_id));

  v_uid := auth.uid();

  -- 2. Authoritative Server-Side Entry Capability Check:
  -- Caller MUST hold import_data to invoke the import execution engine.
  IF v_uid IS NOT NULL THEN
    IF NOT public.can('import_data') THEN
      RAISE EXCEPTION 'Forbidden: User lacks import_data capability' USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(name, username, 'Staff') INTO v_actor_name FROM public.profiles WHERE id = v_uid;
  END IF;

  -- 3. True Batch Idempotency Gate (Executed BEFORE any business side effect)
  SELECT status, summary INTO v_existing_status, v_existing_summary
  FROM public.import_batches
  WHERE batch_id = p_batch_id;

  IF v_existing_status = 'completed' AND v_existing_summary IS NOT NULL THEN
    -- Exactly zero mutations repeated: return previous completed summary immediately
    RETURN v_existing_summary;
  END IF;

  IF v_existing_status = 'processing' THEN
    RAISE EXCEPTION 'Import batch % is already processing', p_batch_id;
  END IF;

  -- Acquire / record batch processing state
  INSERT INTO public.import_batches (
    batch_id, kind, mode, stock_mode, status, filename, total_rows, branch_id, user_id, user_name
  ) VALUES (
    p_batch_id, p_kind, p_mode, p_stock_mode, 'processing', p_filename, jsonb_array_length(p_rows), p_branch_id, v_uid, v_actor_name
  )
  ON CONFLICT (batch_id) DO UPDATE SET
    status = 'processing',
    updated_at = now();

  -- 4. Execute batch rows inside this single atomic PostgreSQL transaction
  FOR row_item IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    r_product_group := trim(coalesce(row_item->>'product_group', row_item->>'group_key', ''));
    r_sku := trim(coalesce(row_item->>'sku', ''));
    r_barcode := trim(coalesce(row_item->>'barcode', ''));
    r_name_ar := trim(coalesce(row_item->>'name_ar', ''));
    r_name_en := trim(coalesce(row_item->>'name_en', ''));
    r_category := trim(coalesce(row_item->>'category', ''));
    r_product_type := coalesce(nullif(trim(row_item->>'product_type'), ''), 'physical');
    r_selling_price := (row_item->>'selling_price')::numeric;
    r_cost_price := (row_item->>'cost_price')::numeric;
    r_tax_rate := (row_item->>'tax_rate')::numeric;
    r_low_stock := (row_item->>'low_stock_level')::integer;
    r_stock_tracking := coalesce((row_item->>'stock_tracking_enabled')::boolean, true);
    
    r_variant_sku := trim(coalesce(row_item->>'variant_sku', ''));
    r_color_ar := trim(coalesce(row_item->>'color_ar', ''));
    r_color_en := trim(coalesce(row_item->>'color_en', ''));
    r_size := (row_item->>'size')::numeric;
    r_size_label := trim(coalesce(row_item->>'size_label', ''));
    r_price_override := (row_item->>'price_override')::numeric;
    r_cost_override := (row_item->>'cost_override')::numeric;
    
    r_branch := trim(coalesce(row_item->>'branch', ''));
    r_stock_action := upper(coalesce(nullif(trim(row_item->>'stock_action'), ''), p_stock_mode, 'NO_STOCK_CHANGE'));
    r_quantity := (row_item->>'quantity')::integer;
    r_reason := coalesce(nullif(trim(row_item->>'stock_reason'), ''), 'Excel Import Batch ' || p_batch_id);

    IF r_sku = '' AND r_product_group = '' AND (row_item->>'product_id' IS NULL OR row_item->>'product_id' = '') AND r_variant_sku = '' THEN
      RAISE EXCEPTION 'Row has no Product ID, SKU, Variant SKU, or Product Group';
    END IF;

    -- Resolve category: Category MUST exist and be active.
    -- STRICT RULE: Import NEVER creates categories.
    v_cat_id := NULL;
    IF r_category != '' THEN
      SELECT count(*), min(id::text)::uuid INTO v_cat_matches, v_cat_id
      FROM public.categories
      WHERE active = true AND (id::text = r_category OR name_ar = r_category OR name_en = r_category);

      IF v_cat_matches = 0 THEN
        RAISE EXCEPTION 'Category "%" does not exist or is archived', r_category;
      ELSIF v_cat_matches > 1 THEN
        RAISE EXCEPTION 'Category "%" is ambiguous (matches multiple active categories)', r_category;
      END IF;
    ELSE
      SELECT id INTO v_cat_id FROM public.categories WHERE active = true ORDER BY created_at ASC LIMIT 1;
    END IF;

    IF v_cat_id IS NULL THEN
      RAISE EXCEPTION 'No active category available in catalog';
    END IF;

    -- Resolve existing product identity:
    -- STRICT RULE: ONLY resolve by (1) Product ID > (2) Variant ID/SKU parent > (3) Product SKU.
    -- NEVER match existing products by product name (AR or EN).
    v_prod_id := NULL;
    IF row_item->>'product_id' IS NOT NULL AND row_item->>'product_id' != '' THEN
      SELECT id, variants_enabled, stock_quantity, selling_price, cost_price
      INTO v_prod_id, v_prod_variants, v_prod_stock, v_curr_selling_price, v_curr_cost_price
      FROM public.products
      WHERE id::text = trim(row_item->>'product_id');
    END IF;

    -- Resolve parent by existing variant ID / SKU if product_id not directly given
    IF v_prod_id IS NULL AND row_item->>'variant_id' IS NOT NULL AND row_item->>'variant_id' != '' THEN
      SELECT product_id INTO v_prod_id
      FROM public.product_variants
      WHERE id::text = trim(row_item->>'variant_id');
      IF v_prod_id IS NOT NULL THEN
        SELECT variants_enabled, stock_quantity, selling_price, cost_price
        INTO v_prod_variants, v_prod_stock, v_curr_selling_price, v_curr_cost_price
        FROM public.products WHERE id = v_prod_id;
      END IF;
    END IF;

    IF v_prod_id IS NULL AND r_variant_sku != '' THEN
      SELECT product_id INTO v_prod_id
      FROM public.product_variants
      WHERE sku = r_variant_sku;
      IF v_prod_id IS NOT NULL THEN
        SELECT variants_enabled, stock_quantity, selling_price, cost_price
        INTO v_prod_variants, v_prod_stock, v_curr_selling_price, v_curr_cost_price
        FROM public.products WHERE id = v_prod_id;
      END IF;
    END IF;

    -- Resolve by product SKU
    IF v_prod_id IS NULL AND r_sku != '' THEN
      SELECT id, variants_enabled, stock_quantity, selling_price, cost_price
      INTO v_prod_id, v_prod_variants, v_prod_stock, v_curr_selling_price, v_curr_cost_price
      FROM public.products
      WHERE sku = r_sku;
    END IF;

    -- Check if this row belongs to a newly grouped product in the current batch
    v_group_key := coalesce(nullif(r_product_group, ''), r_sku);
    IF v_prod_id IS NULL AND v_group_key != '' AND v_new_groups ? v_group_key THEN
      v_prod_id := (v_new_groups->>v_group_key)::uuid;
      SELECT variants_enabled, stock_quantity, selling_price, cost_price
      INTO v_prod_variants, v_prod_stock, v_curr_selling_price, v_curr_cost_price
      FROM public.products WHERE id = v_prod_id;
    END IF;

    -- Handle Product Creation vs Update Policy
    IF v_prod_id IS NULL THEN
      -- Product creation requires add_product capability
      IF v_uid IS NOT NULL AND NOT public.can('add_product') THEN
        RAISE EXCEPTION 'Forbidden: Product creation requires add_product capability' USING ERRCODE = '42501';
      END IF;

      -- New product creation
      IF r_name_ar = '' AND r_name_en = '' THEN
        RAISE EXCEPTION 'Product name (Arabic or English) is required for new product';
      END IF;

      INSERT INTO public.products (
        sku, barcode, name_ar, name_en, category_id, product_type,
        selling_price, cost_price, tax_rate, low_stock_level,
        stock_tracking_enabled, variants_enabled, stock_quantity, active
      ) VALUES (
        coalesce(nullif(r_sku, ''), r_product_group),
        nullif(r_barcode, ''),
        coalesce(nullif(r_name_ar, ''), r_name_en),
        coalesce(nullif(r_name_en, ''), r_name_ar),
        v_cat_id,
        r_product_type::public.product_type,
        coalesce(r_selling_price, 0),
        coalesce(r_cost_price, 0),
        coalesce(r_tax_rate, 0),
        coalesce(r_low_stock, 5),
        r_stock_tracking,
        (r_variant_sku != '' OR r_color_ar != '' OR r_color_en != '' OR r_size IS NOT NULL),
        0,
        true
      ) RETURNING id, variants_enabled, stock_quantity INTO v_prod_id, v_prod_variants, v_prod_stock;

      IF v_group_key != '' THEN
        v_new_groups := jsonb_set(v_new_groups, array[v_group_key], to_jsonb(v_prod_id::text));
      END IF;

      v_created_products := array_append(v_created_products, v_prod_id::text);
      v_written_count := v_written_count + 1;
    ELSE
      -- Existing product encountered
      IF p_kind != 'stock' AND p_product_policy = 'reject' AND NOT (v_prod_id::text = ANY(v_created_products)) AND NOT (v_group_key != '' AND v_new_groups ? v_group_key) THEN
        RAISE EXCEPTION 'Product with SKU "%" already exists. Policy is set to reject.', coalesce(r_sku, r_product_group);
      ELSIF p_product_policy = 'update' OR p_kind = 'stock' THEN
        -- Product modification requires edit_product capability
        IF v_uid IS NOT NULL AND NOT public.can('edit_product') THEN
          RAISE EXCEPTION 'Forbidden: Product modification requires edit_product capability' USING ERRCODE = '42501';
        END IF;

        -- Price change requires change_price capability
        IF r_selling_price IS NOT NULL AND v_curr_selling_price IS DISTINCT FROM r_selling_price THEN
          IF v_uid IS NOT NULL AND NOT public.can('change_price') THEN
            RAISE EXCEPTION 'Forbidden: Changing selling price requires change_price capability' USING ERRCODE = '42501';
          END IF;
        END IF;

        -- Cost change requires change_cost capability
        IF r_cost_price IS NOT NULL AND v_curr_cost_price IS DISTINCT FROM r_cost_price THEN
          IF v_uid IS NOT NULL AND NOT public.can('change_cost') THEN
            RAISE EXCEPTION 'Forbidden: Changing cost price requires change_cost capability' USING ERRCODE = '42501';
          END IF;
        END IF;

        UPDATE public.products SET
          name_ar = coalesce(nullif(r_name_ar, ''), name_ar),
          name_en = coalesce(nullif(r_name_en, ''), name_en),
          category_id = coalesce(v_cat_id, category_id),
          selling_price = coalesce(r_selling_price, selling_price),
          cost_price = coalesce(r_cost_price, cost_price),
          tax_rate = coalesce(r_tax_rate, tax_rate),
          low_stock_level = coalesce(r_low_stock, low_stock_level),
          updated_at = now()
        WHERE id = v_prod_id;

        IF NOT (v_prod_id::text = ANY(v_updated_products)) THEN
          v_updated_products := array_append(v_updated_products, v_prod_id::text);
          v_written_count := v_written_count + 1;
        END IF;
      END IF;
    END IF;

    -- Variant mutation
    v_var_id := NULL;
    IF r_variant_sku != '' OR r_color_ar != '' OR r_color_en != '' OR r_size IS NOT NULL OR (row_item->>'variant_id' IS NOT NULL AND row_item->>'variant_id' != '') THEN
      -- Ensure parent product has variants_enabled = true
      UPDATE public.products SET variants_enabled = true WHERE id = v_prod_id AND variants_enabled = false;

      IF row_item->>'variant_id' IS NOT NULL AND row_item->>'variant_id' != '' THEN
        SELECT id, barcode, stock_quantity INTO v_var_id, v_var_barcode, v_var_stock
        FROM public.product_variants
        WHERE id::text = trim(row_item->>'variant_id');
      END IF;

      IF v_var_id IS NULL AND r_variant_sku != '' THEN
        SELECT id, barcode, stock_quantity INTO v_var_id, v_var_barcode, v_var_stock
        FROM public.product_variants
        WHERE product_id = v_prod_id AND sku = r_variant_sku;
      END IF;

      IF v_var_id IS NULL THEN
        -- Creating new variant requires add_product capability
        IF v_uid IS NOT NULL AND NOT public.can('add_product') THEN
          RAISE EXCEPTION 'Forbidden: Variant creation requires add_product capability' USING ERRCODE = '42501';
        END IF;

        -- Insert new variant.
        -- Blank barcode uses NULL: canonical BEFORE INSERT trigger on product_variants derives it from SKU!
        IF r_barcode != '' THEN
          IF EXISTS (SELECT 1 FROM public.products WHERE barcode = r_barcode UNION ALL SELECT 1 FROM public.product_variants WHERE barcode = r_barcode) THEN
            RAISE EXCEPTION 'Barcode "%" already belongs to another product or variant', r_barcode;
          END IF;
        END IF;

        INSERT INTO public.product_variants (
          product_id, sku, barcode, color_ar, color_en, size, size_label,
          price_override, cost_override, stock_quantity, active
        ) VALUES (
          v_prod_id,
          coalesce(nullif(r_variant_sku, ''), r_sku || '-' || coalesce(nullif(r_color_en, ''), 'VAR')),
          nullif(r_barcode, ''),
          nullif(r_color_ar, ''), nullif(r_color_en, ''), r_size, nullif(r_size_label, ''),
          r_price_override, r_cost_override, 0, true
        ) RETURNING id, barcode, stock_quantity INTO v_var_id, v_var_barcode, v_var_stock;

        v_created_variants := array_append(v_created_variants, v_var_id::text);
        v_written_count := v_written_count + 1;
      ELSE
        -- Updating existing variant requires edit_product capability
        IF v_uid IS NOT NULL AND NOT public.can('edit_product') THEN
          RAISE EXCEPTION 'Forbidden: Variant modification requires edit_product capability' USING ERRCODE = '42501';
        END IF;

        -- Update variant (preserve existing barcode when blank)
        UPDATE public.product_variants SET
          barcode = coalesce(nullif(r_barcode, ''), barcode),
          color_ar = coalesce(nullif(r_color_ar, ''), color_ar),
          color_en = coalesce(nullif(r_color_en, ''), color_en),
          size = coalesce(r_size, size),
          size_label = coalesce(nullif(r_size_label, ''), size_label),
          price_override = coalesce(r_price_override, price_override),
          cost_override = coalesce(r_cost_override, cost_override),
          updated_at = now()
        WHERE id = v_var_id;

        v_updated_variants := array_append(v_updated_variants, v_var_id::text);
        v_written_count := v_written_count + 1;
      END IF;
    END IF;

    -- Branch Stock mutation (Strict explicit per-row branch resolution & validation)
    IF r_quantity IS NOT NULL AND r_stock_action IN ('SET_STOCK', 'ADD_STOCK', 'SUBTRACT_STOCK', 'SET', 'DELTA') THEN
      -- Stock adjustment requires adjust_stock capability
      IF v_uid IS NOT NULL AND NOT public.can('adjust_stock') THEN
        RAISE EXCEPTION 'Forbidden: Stock adjustments require adjust_stock capability' USING ERRCODE = '42501';
      END IF;

      -- STRICT NO-FALLBACK RULE: Excel stock row MUST explicitly specify a target branch.
      IF r_branch = '' THEN
        RAISE EXCEPTION 'Branch is mandatory for stock adjustment row (SKU: %)', coalesce(r_variant_sku, r_sku);
      END IF;

      v_effective_branch_id := NULL;
      SELECT id, name_en INTO v_effective_branch_id, v_branch_name
      FROM public.branches
      WHERE active = true AND (id::text = r_branch OR name_en = r_branch OR name_ar = r_branch OR code = r_branch)
      LIMIT 1;

      IF v_effective_branch_id IS NULL THEN
        RAISE EXCEPTION 'Invalid or inactive branch: "%"', r_branch;
      END IF;

      -- Check actor's authorization for THIS specific target branch
      IF v_uid IS NOT NULL AND NOT public.can_access_branch(v_effective_branch_id) THEN
        RAISE EXCEPTION 'Forbidden: User is not authorized to access branch "%"', coalesce(v_branch_name, r_branch) USING ERRCODE = '42501';
      END IF;

      -- Check current shelf balance from branch_stock_balances
      SELECT coalesce(quantity, 0) INTO v_current_shelf
      FROM public.branch_stock_balances
      WHERE branch_id = v_effective_branch_id
        AND ((v_var_id IS NOT NULL AND variant_id = v_var_id) OR (v_var_id IS NULL AND product_id = v_prod_id AND variant_id IS NULL))
      LIMIT 1;
      v_current_shelf := coalesce(v_current_shelf, 0);

      -- Compute new shelf balance with strict non-negative rules
      IF r_stock_action IN ('SET_STOCK', 'SET') THEN
        IF r_quantity < 0 THEN
          RAISE EXCEPTION 'SET_STOCK cannot be negative (% < 0)', r_quantity;
        END IF;
        v_new_shelf := r_quantity;
        v_delta := v_new_shelf - v_current_shelf;
      ELSIF r_stock_action IN ('ADD_STOCK', 'DELTA') THEN
        IF r_quantity < 0 THEN
          RAISE EXCEPTION 'ADD_STOCK quantity cannot be negative (% < 0)', r_quantity;
        END IF;
        v_delta := r_quantity;
        v_new_shelf := v_current_shelf + v_delta;
      ELSIF r_stock_action = 'SUBTRACT_STOCK' THEN
        IF r_quantity < 0 THEN
          RAISE EXCEPTION 'SUBTRACT_STOCK quantity cannot be negative (% < 0)', r_quantity;
        END IF;
        v_delta := -abs(r_quantity);
        v_new_shelf := v_current_shelf + v_delta;
      END IF;

      -- ABSOLUTE SAFETY RULE: Resulting stock must NEVER be negative
      IF v_new_shelf < 0 THEN
        RAISE EXCEPTION 'Stock balance would become negative (% < 0) for SKU % on branch % (current: %, delta: %)',
          v_new_shelf, coalesce(r_variant_sku, r_sku), v_branch_name, v_current_shelf, v_delta;
      END IF;

      -- Update branch stock balances (Branch × Variant isolation)
      IF v_var_id IS NOT NULL THEN
        INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity, updated_at)
        VALUES (v_effective_branch_id, v_prod_id, v_var_id, v_new_shelf, now())
        ON CONFLICT (branch_id, variant_id) WHERE variant_id IS NOT NULL
        DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now();

        -- Update compatibility rollup on variant
        UPDATE public.product_variants SET stock_quantity = (
          SELECT coalesce(sum(quantity), 0) FROM public.branch_stock_balances WHERE variant_id = v_var_id
        ) WHERE id = v_var_id;
        -- Update compatibility rollup on parent product
        UPDATE public.products SET stock_quantity = (
          SELECT coalesce(sum(quantity), 0) FROM public.branch_stock_balances WHERE product_id = v_prod_id
        ) WHERE id = v_prod_id;
      ELSE
        INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity, updated_at)
        VALUES (v_effective_branch_id, v_prod_id, NULL, v_new_shelf, now())
        ON CONFLICT (branch_id, product_id) WHERE variant_id IS NULL
        DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now();

        -- Update compatibility rollup on product
        UPDATE public.products SET stock_quantity = (
          SELECT coalesce(sum(quantity), 0) FROM public.branch_stock_balances WHERE product_id = v_prod_id
        ) WHERE id = v_prod_id;
      END IF;

      -- Append-only Stock Movement audit row (only when delta != 0)
      IF v_delta != 0 THEN
        INSERT INTO public.stock_movements (
          product_id, variant_id, branch_id, type, reason, delta, quantity_before, quantity_after, user_id, user_name, notes
        ) VALUES (
          v_prod_id, v_var_id, v_effective_branch_id,
          (CASE WHEN v_delta >= 0 THEN 'adjustment_in'::public.stock_movement_type ELSE 'adjustment_out'::public.stock_movement_type end),
          'recount'::public.stock_reason,
          abs(v_delta), v_current_shelf, v_new_shelf,
          coalesce(v_uid::text, '00000000-0000-0000-0000-000000000001'),
          v_actor_name,
          'Import Batch: ' || p_batch_id || coalesce(' · ' || nullif(r_reason, ''), '')
        );

        v_stock_adj_count := v_stock_adj_count + 1;
      END IF;
    END IF;
  END LOOP;

  -- 5. Audit Log entry (within the same transaction)
  INSERT INTO public.audit_log (
    action, entity, entity_id, entity_label, user_id, user_name, details
  ) VALUES (
    'import.applied', 'system', p_batch_id, coalesce(p_filename, 'Excel Import'),
    coalesce(v_uid::text, '00000000-0000-0000-0000-000000000001'), v_actor_name,
    jsonb_build_object(
      'batch_id', p_batch_id,
      'kind', p_kind,
      'filename', p_filename,
      'written', v_written_count,
      'created_products', array_length(v_created_products, 1),
      'updated_products', array_length(v_updated_products, 1),
      'created_variants', array_length(v_created_variants, 1),
      'updated_variants', array_length(v_updated_variants, 1),
      'stock_adjustments', v_stock_adj_count
    )
  );

  -- 6. Mark batch completed and record authoritative summary
  v_result_summary := jsonb_build_object(
    'batch_id', p_batch_id,
    'status', 'completed',
    'written', v_written_count,
    'created_product_ids', v_created_products,
    'updated_product_ids', v_updated_products,
    'created_variant_ids', v_created_variants,
    'updated_variant_ids', v_updated_variants,
    'stock_adjustments_count', v_stock_adj_count,
    'rolled_back', false,
    'errors', 0
  );

  UPDATE public.import_batches SET
    status = 'completed',
    written_count = v_written_count,
    summary = v_result_summary,
    updated_at = now()
  WHERE batch_id = p_batch_id;

  RETURN v_result_summary;
END;
$$;

GRANT EXECUTE ON FUNCTION public.execute_import_batch TO authenticated;

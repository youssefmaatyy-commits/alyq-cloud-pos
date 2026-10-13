-- 0096 focused scenarios — free-size variant models.
--
-- Covers: a legacy colour/size product untouched; a multi-model free-size parent
-- with independent SKU/barcode and per-branch stock; the storefront read exposing
-- only active models with safe fields and their own gallery; the gallery and
-- identity guards; the parent-owned price rule; line snapshots that record the
-- model name and refuse a variant from another product; NULL variant history;
-- and the restrict-delete rule for a referenced variant.

do $variant_models_0096$
declare
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_category uuid := '00000000-0000-4000-8000-000000009601';
  v_models uuid := '00000000-0000-4000-8000-000000009602';
  v_legacy uuid := '00000000-0000-4000-8000-000000009603';
  v_colour uuid := '00000000-0000-4000-8000-000000009604';
  v_model_a uuid := '00000000-0000-4000-8000-000000009611';
  v_model_b uuid := '00000000-0000-4000-8000-000000009612';
  v_colour_v uuid := '00000000-0000-4000-8000-000000009613';
  v_sale uuid := '00000000-0000-4000-8000-000000009621';
  v_line_a uuid := '00000000-0000-4000-8000-000000009622';
  v_line_legacy uuid := '00000000-0000-4000-8000-000000009623';
  v_storefront jsonb;
  v_count integer;
  v_name text;
begin
  perform pg_temp.become(null,'postgres');

  delete from public.sale_items where sale_id = v_sale;
  delete from public.sales where id = v_sale;
  delete from public.branch_stock_balances where product_id in (v_models, v_legacy, v_colour);
  delete from public.product_variants where product_id in (v_models, v_legacy, v_colour);
  delete from public.products where id in (v_models, v_legacy, v_colour);

  insert into public.categories(id,name_ar,name_en)
  values(v_category,'فئة 0096','0096 category')
  on conflict(id) do nothing;

  -- A free-size ring family (no colour, no size), a legacy simple product and a
  -- colour/size product. The legacy and colour products are the compatibility
  -- fixtures: nothing about them may change.
  insert into public.products(id,sku,name_ar,name_en,category_id,selling_price,cost_price,stock_quantity,
    active,show_on_website,stock_tracking_enabled,variants_enabled) values
    (v_models,'P96-RINGS','خواتم مقاس حر','0096 free-size rings',v_category,120,60,0,true,true,true,true),
    (v_legacy,'P96-LEGACY','منتج قديم','0096 legacy',v_category,30,10,4,true,true,true,false),
    (v_colour,'P96-COLOUR','منتج ألوان','0096 colour',v_category,45,20,0,true,true,true,true);

  insert into public.product_variants(id,product_id,sku,barcode,display_name_en,display_name_ar,images,stock_quantity,active,sort_order) values
    (v_model_a,v_models,'P96-A','P96A00001','Model A','موديل A',
      '["https://img.example.test/a-front.jpg","https://img.example.test/a-side.jpg"]'::jsonb,0,true,0),
    (v_model_b,v_models,'P96-B','P96B00001','Model B','موديل B','[]'::jsonb,0,true,1);

  insert into public.product_variants(id,product_id,sku,barcode,color_key,color_en,color_ar,size_value,size_sort_order,stock_quantity,active,sort_order)
  values(v_colour_v,v_colour,'P96-C-BLK','P96C00001','black','Black','أسود','42',0,0,true,0);

  -- Independent per-branch stock: the shelf for Model A is not the shelf for B.
  -- Creating a variant opens its shelf on the default branch (0043/0078), so the
  -- scenario sets quantities on those shelves rather than inserting a second row.
  update public.branch_stock_balances set quantity = 3 where branch_id = v_main and variant_id = v_model_a;
  update public.branch_stock_balances set quantity = 0 where branch_id = v_main and variant_id = v_model_b;
  if (select count(*) from public.branch_stock_balances where branch_id = v_main and variant_id in (v_model_a, v_model_b)) <> 2 then
    raise exception 'model shelves were not opened on the default branch';
  end if;

  -- ── Guards: a named model may not carry its own price (the parent owns it) ──
  -- Price changes need the change_price capability, which the seeded admin holds;
  -- the capability check runs first, so the admin is the seat that reaches the
  -- model-price rule itself.
  perform pg_temp.become(v_admin,'authenticated');
  begin
    update public.product_variants set price_override = 99 where id = v_model_a;
    raise exception 'a named model accepted a price override';
  exception when check_violation then null;
  end;
  perform pg_temp.become(null,'postgres');

  -- ── Guards: a combination with no colour, no size and no name is refused ───
  begin
    insert into public.product_variants(product_id,sku,stock_quantity,active)
    values(v_models,'P96-NOTHING',0,true);
    raise exception 'a nameless, colourless, sizeless variant was accepted';
  exception when check_violation then null;
  end;

  -- ── Guards: one model name per product (case- and space-insensitive) ───────
  begin
    insert into public.product_variants(product_id,sku,display_name_en,stock_quantity,active)
    values(v_models,'P96-A-DUP','  model a ',0,true);
    raise exception 'a duplicate model name on the same product was accepted';
  exception when unique_violation then null;
  end;

  -- ── Guards: at most five https photos, each a real link ────────────────────
  begin
    insert into public.product_variants(product_id,sku,display_name_en,images,stock_quantity,active)
    values(v_models,'P96-SIX','Model Six',
      '["https://a/1.jpg","https://a/2.jpg","https://a/3.jpg","https://a/4.jpg","https://a/5.jpg","https://a/6.jpg"]'::jsonb,0,true);
    raise exception 'a six-photo gallery was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.product_variants set images = '["javascript:alert(1)"]'::jsonb where id = v_model_a;
    raise exception 'a javascript: photo link was accepted';
  exception when check_violation then null;
  end;

  -- ── A variant must belong to its own product, on every line table ──────────
  insert into public.sales(id,sale_number,client_ref,payment_method,subtotal,total,amount_received,user_id,user_name)
  values(v_sale,'S96-0001','0096-client-ref-1','cash',150,150,150,'00000000-0000-4000-8000-0000000000a1','Amina Admin');

  begin
    insert into public.sale_items(sale_id,product_id,variant_id,name_ar,name_en,sku,unit_price,quantity,line_total)
    values(v_sale,v_legacy,v_model_a,'x','x','P96-A',120,1,120);
    raise exception 'a line accepted a variant that belongs to another product';
  exception when check_violation then null;
  end;

  -- ── Line snapshot: the sold model name is recorded on the line ─────────────
  insert into public.sale_items(id,sale_id,product_id,variant_id,name_ar,name_en,sku,unit_price,quantity,line_total)
  values(v_line_a,v_sale,v_models,v_model_a,'خاتم','Ring','P96-A',120,1,120);
  select variant_display_name into v_name from public.sale_items where id = v_line_a;
  if v_name is distinct from 'Model A' then
    raise exception 'sale line did not snapshot the model name (got %)', v_name;
  end if;

  -- ── NULL variant history: a legacy line keeps a null variant and null name ─
  insert into public.sale_items(id,sale_id,product_id,variant_id,name_ar,name_en,sku,unit_price,quantity,line_total)
  values(v_line_legacy,v_sale,v_legacy,null,'قديم','Legacy','LEG',30,1,30);
  if (select variant_display_name from public.sale_items where id = v_line_legacy) is not null then
    raise exception 'a legacy line gained a variant name';
  end if;

  -- ── Restrict: a variant referenced by history cannot be deleted ───────────
  begin
    delete from public.product_variants where id = v_model_a;
    raise exception 'a variant referenced by a sale line was deleted';
  exception when restrict_violation then null; -- ON DELETE RESTRICT raises 23001
  end;

  -- ── Storefront: anonymous readers see active models only, with their own
  --    gallery and the branch's own stock. Inactive models are not published.
  update public.product_variants set active = false where id = v_model_b;
  perform pg_temp.become(null,'anon');
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_storefront
    from public.storefront_branch_product_variants_v2() s
   where s.product_id = v_models;
  if jsonb_array_length(v_storefront) <> 1 then
    raise exception 'storefront shows % model(s); expected only the active Model A', jsonb_array_length(v_storefront);
  end if;
  if v_storefront->0->>'sku' <> 'P96-A'
     or v_storefront->0->>'display_name_en' <> 'Model A'
     or (v_storefront->0->>'stock_quantity')::int <> 3
     or jsonb_array_length(v_storefront->0->'images') <> 2 then
    raise exception 'storefront model is missing its name, own stock or own gallery: %', v_storefront->0;
  end if;

  -- The colour/size product still publishes its combination with a null name.
  select count(*) into v_count from public.storefront_branch_product_variants_v2() s where s.product_id = v_colour;
  if v_count <> 1 then
    raise exception 'colour/size product stopped publishing its combination';
  end if;
  -- The legacy simple product (variants disabled) publishes no variants at all.
  select count(*) into v_count from public.storefront_branch_product_variants_v2() s where s.product_id = v_legacy;
  if v_count <> 0 then
    raise exception 'a product with variants disabled leaked into the variant read';
  end if;

  -- Reactivate Model B so later scenarios see a normal family again.
  perform pg_temp.become(null,'postgres');
  update public.product_variants set active = true where id = v_model_b;

  raise notice 'Migration 0096 focused scenarios passed: free-size models, guards, line snapshots, NULL history, restrict delete, storefront publication';
end
$variant_models_0096$;

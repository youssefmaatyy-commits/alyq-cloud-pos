-- 0095 focused scenarios.
--
--   1. Completed-sale cancellation is refused for every role, and the sale is
--      left exactly as it was.
--   2. Storefront checkout sells from the fulfilment (default) branch shelf only.
--      A unit that exists only on another branch cannot be promised online —
--      for a plain product and for one exact variant — and the variant that is
--      sold out at the fulfilment branch is refused while its sibling is sold.
--   3. A storefront order names the exact variant it reserves, and the reservation
--      is per variant.
--   4. Anonymous visitors cannot read the variant tables directly; the public
--      storefront function exposes only active variants.
--   5. A cashier at the default branch cannot read another branch's shelf rows.
--
-- Runs in the disposable database after scenarios.sql and the other focused
-- files. Setup is owner-only; every operation under test runs as the actor that
-- would really make it.

do $sale_cancel_0095$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_default  uuid;
  v_remote   uuid := '00000000-0000-4000-8000-000000009501';
  v_category uuid := '00000000-0000-4000-8000-000000009502';
  v_plain    uuid := '00000000-0000-4000-8000-000000009503';
  v_ring     uuid := '00000000-0000-4000-8000-000000009504';
  v_model_a  uuid := '00000000-0000-4000-8000-000000009505';
  v_model_b  uuid := '00000000-0000-4000-8000-000000009506';
  v_model_c  uuid := '00000000-0000-4000-8000-000000009507';
  v_sale     jsonb;
  v_sale_id  uuid;
  v_order    jsonb;
  v_order_id uuid;
  v_count    integer;
  v_status   text;
  v_codes    text;
  v_refused  boolean;
begin
  -- ── fixtures (owner) ──────────────────────────────────────────────────────
  perform pg_temp.become(null,'postgres');
  select id into v_default from public.branches
   where is_default and active order by created_at, id limit 1;
  if v_default is null then raise exception '0095 scenario needs an active default branch'; end if;

  insert into public.branches(id,code,name_en,name_ar,active,is_default)
  values(v_remote,'p95-remote','Remote 0095','فرع 0095 البعيد',true,false)
  on conflict(id) do update set active=true;

  insert into public.categories(id,name_ar,name_en)
  values(v_category,'فئة 0095','Scenario 0095')
  on conflict(id) do nothing;

  -- A plain product: 4 units at the fulfilment branch, 9 more only at the remote
  -- branch. Before 0095 the online check read the all-branch rollup (13).
  insert into public.products(id,sku,name_ar,name_en,category_id,selling_price,stock_quantity,
    low_stock_level,active,show_on_website,stock_tracking_enabled)
  values(v_plain,'P95-PLAIN','منتج 0095','Plain 0095',v_category,10,0,0,true,true,true);
  -- Shelf rows are created by the branch-stock triggers in some cases; ensure a
  -- row exists, then set the exact figure.
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_default,v_plain,null,0,0),(v_remote,v_plain,null,0,0)
  on conflict do nothing;
  update public.branch_stock_balances set quantity=4 where branch_id=v_default and product_id=v_plain and variant_id is null;
  update public.branch_stock_balances set quantity=9 where branch_id=v_remote and product_id=v_plain and variant_id is null;

  -- A variant product (free-size rings: one colour per model, no size).
  insert into public.products(id,sku,name_ar,name_en,category_id,selling_price,stock_quantity,
    low_stock_level,active,show_on_website,stock_tracking_enabled,variants_enabled)
  values(v_ring,'P95-RING','خاتم 0095','Ring 0095',v_category,40,0,0,true,true,true,true);

  insert into public.product_variants(id,product_id,sku,color_en,color_ar,stock_quantity,low_stock_level,active,sort_order)
  values
    (v_model_a,v_ring,'P95-RING-A','Model A','نموذج أ',0,0,true,1),
    (v_model_b,v_ring,'P95-RING-B','Model B','نموذج ب',0,0,true,2),
    (v_model_c,v_ring,'P95-RING-C','Model C','نموذج ج',0,0,false,3);

  -- Model A: 2 at the fulfilment branch. Model B: sold out at the fulfilment
  -- branch, 5 at the remote branch (the rollup would show 5 and sell it).
  -- Model C is inactive and must never reach the storefront.
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_default,v_ring,v_model_a,0,0),(v_remote,v_ring,v_model_b,0,0),(v_default,v_ring,v_model_c,0,0)
  on conflict do nothing;
  update public.branch_stock_balances set quantity=2 where branch_id=v_default and variant_id=v_model_a;
  update public.branch_stock_balances set quantity=0 where branch_id=v_default and variant_id=v_model_b;
  update public.branch_stock_balances set quantity=5 where branch_id=v_remote and variant_id=v_model_b;
  update public.branch_stock_balances set quantity=3 where branch_id=v_default and variant_id=v_model_c;

  -- ── 1 · completed-sale cancellation is refused for every role ─────────────
  -- The till seat (cashier) opens the drawer and makes the sale, as in production.
  perform pg_temp.become(v_cashier,'authenticated');
  perform pg_temp.ensure_open_shift(v_cashier::text);
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref','p95-sale-'||gen_random_uuid()::text,
    'user_id',v_cashier::text,'user_name','Karim Cashier',
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_plain::text,'qty',1)),
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',10.00))));
  v_sale_id := (v_sale->>'sale_id')::uuid;

  perform pg_temp.become(v_admin,'authenticated');
  v_refused := false;
  begin
    perform public.pos_void_sale(v_sale_id,v_admin::text,'Amina Admin','admin attempt');
  exception when feature_not_supported then
    v_refused := true;
  end;
  if not v_refused then raise exception 'an admin cancelled a completed sale'; end if;

  perform pg_temp.become(v_cashier,'authenticated');
  v_refused := false;
  begin
    perform public.pos_void_sale(v_sale_id,v_cashier::text,'Karim Cashier','cashier attempt');
  exception when feature_not_supported then
    v_refused := true;
  end;
  if not v_refused then raise exception 'a cashier cancelled a completed sale'; end if;

  perform pg_temp.become(null,'postgres');
  select status::text into v_status from public.sales where id = v_sale_id;
  if v_status <> 'completed' then
    raise exception 'a refused cancellation changed the sale to %', v_status;
  end if;
  if exists(select 1 from public.sales where id=v_sale_id and voided_at is not null) then
    raise exception 'a refused cancellation stamped voided_at';
  end if;
  raise notice '0095 · completed-sale cancellation refused for admin and cashier; sale stays completed';

  -- ── 2 · storefront checkout sells from the fulfilment shelf only ─────────
  perform pg_temp.become(null,'anon');

  -- The plain product: 4 at the fulfilment branch, one of which the till just sold
  -- (3 left). The all-branch rollup would have said 12 and promised the rest.
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref','p95-plain-over-'||gen_random_uuid()::text,
      'customer_name','Scenario Shopper','customer_phone','01000000095',
      'delivery_type','pickup','payment_method','cod',
      'lines',jsonb_build_array(jsonb_build_object('product_id',v_plain::text,'qty',4))));
    raise exception 'checkout promised units held only at another branch';
  exception when check_violation then
    if sqlerrm not like 'Only 3 of %' then
      raise exception 'plain product refusal read "%" instead of the fulfilment figure 3', sqlerrm;
    end if;
  end;

  v_order := public.place_online_order(jsonb_build_object(
    'client_ref','p95-plain-ok-'||gen_random_uuid()::text,
    'customer_name','Scenario Shopper','customer_phone','01000000095',
    'delivery_type','pickup','payment_method','cod',
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_plain::text,'qty',3))));
  if v_order->>'order_id' is null then raise exception 'the fulfilment-shelf order was refused'; end if;

  -- Model B: sold out at the fulfilment branch although the rollup says 5.
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref','p95-b-'||gen_random_uuid()::text,
      'customer_name','Scenario Shopper','customer_phone','01000000095',
      'delivery_type','pickup','payment_method','cod',
      'lines',jsonb_build_array(jsonb_build_object('product_id',v_ring::text,'variant_id',v_model_b::text,'qty',1))));
    raise exception 'a variant sold out at the fulfilment branch was sold online';
  exception when check_violation then
    if sqlerrm not like 'Only 0 of %Model B%' then
      raise exception 'sold-out variant refusal read "%"', sqlerrm;
    end if;
  end;
  raise notice '0095 · plain product and sold-out variant refused against the fulfilment shelf only';

  -- ── 3 · the order names the exact variant it reserves ────────────────────
  v_order := public.place_online_order(jsonb_build_object(
    'client_ref','p95-a-'||gen_random_uuid()::text,
    'customer_name','Scenario Shopper','customer_phone','01000000095',
    'delivery_type','pickup','payment_method','cod',
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_ring::text,'variant_id',v_model_a::text,'qty',2))));
  v_order_id := (v_order->>'order_id')::uuid;

  perform pg_temp.become(null,'postgres');
  if not exists(select 1 from public.online_order_items
                 where order_id = v_order_id and variant_id = v_model_a and quantity = 2) then
    raise exception 'the order line does not name Model A';
  end if;
  if not exists(select 1 from public.stock_reservations
                 where online_order_id = v_order_id and variant_id = v_model_a and quantity = 2 and status='reserved') then
    raise exception 'the reservation is not held on Model A';
  end if;

  -- Model A is now fully promised: a further unit is refused, and Model B is
  -- still sold out — the variants are independent.
  perform pg_temp.become(null,'anon');
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref','p95-a-over-'||gen_random_uuid()::text,
      'customer_name','Scenario Shopper','customer_phone','01000000095',
      'delivery_type','pickup','payment_method','cod',
      'lines',jsonb_build_array(jsonb_build_object('product_id',v_ring::text,'variant_id',v_model_a::text,'qty',1))));
    raise exception 'a promised unit of Model A was sold twice';
  exception when check_violation then
    if sqlerrm not like 'Only 0 of %Model A%' then
      raise exception 'double-promise refusal read "%"', sqlerrm;
    end if;
  end;

  -- An inactive variant is not sellable even with stock on its shelf.
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref','p95-c-'||gen_random_uuid()::text,
      'customer_name','Scenario Shopper','customer_phone','01000000095',
      'delivery_type','pickup','payment_method','cod',
      'lines',jsonb_build_array(jsonb_build_object('product_id',v_ring::text,'variant_id',v_model_c::text,'qty',1))));
    raise exception 'an inactive variant was sold online';
  exception when check_violation then null;
  end;
  raise notice '0095 · order lines name the exact variant; reservations are per variant';

  -- ── 4 · anonymous visitors: no direct table reads, only the public view ──
  v_count := -1;
  begin
    select count(*) into v_count from public.product_variants;
  exception when insufficient_privilege then
    v_count := 0;
  end;
  if v_count <> 0 then raise exception 'an anonymous visitor read % product_variants rows directly', v_count; end if;

  select string_agg(sku, ',' order by sku) into v_codes
    from public.storefront_branch_product_variants()
   where product_id = v_ring;
  if v_codes is distinct from 'P95-RING-A,P95-RING-B' then
    raise exception 'the public storefront exposed % (expected only the active models)', v_codes;
  end if;
  raise notice '0095 · anonymous reads are closed; the storefront function exposes active models only';

  -- ── 5 · a cashier at the default branch cannot read the remote shelf ──────
  perform pg_temp.become(v_cashier,'authenticated');
  select count(*) into v_count from public.branch_stock_balances where branch_id = v_remote;
  if v_count <> 0 then
    raise exception 'a default-branch cashier read % rows of the remote branch shelf', v_count;
  end if;
  raise notice '0095 · remote branch shelf rows are invisible to a default-branch cashier';

  perform pg_temp.become(null,'postgres');
end
$sale_cancel_0095$;

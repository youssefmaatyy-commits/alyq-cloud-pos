-- 0095 — Completed-sale cancellation is disabled; storefront checkout sells
-- from the fulfilment branch shelf; cancel-path refusal for converted orders.
--
-- 1. pos_void_sale (and its internal core from 0072) refuse every caller. A
--    completed sale is corrected by a sales return (pos_process_return), which
--    keeps refunds, stock and the audit trail. The historical `sales.status =
--    'voided'` rows, void_reason/voided_at columns, the sale.voided audit
--    vocabulary and every read of them are untouched. The RPC keeps its signature
--    and its EXECUTE grant so that an old client gets an explanatory SQLSTATE
--    (feature_not_supported) rather than a missing-function error, and nothing
--    is written.
--
-- 2. storefront_fulfilment_available(product, variant) — available to promise on
--    the default active branch's shelf, less open online reservations. Previously
--    place_online_order compared the request with products/product_variants
--    .stock_quantity, which 0078 turned into ALL-BRANCH rollups. The storefront
--    displays the fulfilment branch, so a unit another branch holds could be sold
--    online and then fail at approval. place_online_order is redefined below from
--    its 0062 text with only those two availability reads changed.
--
-- Single-branch installations are unaffected: the fulfilment shelf then holds every
-- unit the rollup counted. Forward-only and idempotent.

-- ── 1. completed-sale cancellation is refused ───────────────────────────────
create or replace function public.pos_void_sale_core_0072(
  p_sale_id uuid, p_user_id text, p_user_name text, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Deliberately refuses before reading or writing anything. Kept as a function
  -- (not dropped) so the 0072 wrapper below and any historical reference still
  -- resolve, and so the refusal is the only behaviour that exists.
  raise exception 'Completed-sale cancellation is disabled. Record a sales return instead.'
    using errcode = 'feature_not_supported';
end
$$;

revoke all on function public.pos_void_sale_core_0072(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.pos_void_sale(
  p_sale_id uuid,
  p_user_id text,
  p_user_name text,
  p_reason text default null,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Completed-sale cancellation is disabled. Record a sales return instead.'
    using errcode = 'feature_not_supported';
end
$$;

grant execute on function public.pos_void_sale(uuid, text, text, text, uuid) to authenticated;
revoke all on function public.pos_void_sale(uuid, text, text, text, uuid) from public, anon;

comment on function public.pos_void_sale(uuid, text, text, text, uuid) is
  'Disabled since 0095: completed sales are never cancelled. Returns (pos_process_return) are the correction path. Refuses for every caller without touching the sale.';

-- ── 2. storefront availability on the fulfilment branch ─────────────────────
create or replace function public.storefront_fulfilment_available(p_product_id uuid, p_variant_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select greatest(
           coalesce((
             select bs.quantity
               from public.branch_stock_balances bs
               cross join lateral (
                 select id from public.branches
                  where is_default and active
                  order by created_at, id
                  limit 1
               ) b
              where bs.branch_id = b.id
                and bs.product_id = p_product_id
                and bs.variant_id is not distinct from p_variant_id
           ), 0)
           - case when p_variant_id is null
                  then public.reserved_quantity(p_product_id)
                  else public.reserved_quantity_variant(p_variant_id)
             end,
           0)::integer
$$;

revoke all on function public.storefront_fulfilment_available(uuid, uuid) from public, anon;
grant execute on function public.storefront_fulfilment_available(uuid, uuid) to authenticated, service_role;

-- ── 3. checkout (0062 definition; availability now fulfilment-branch aware) ─
create or replace function public.place_online_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref     text := p_payload->>'client_ref';
  v_delivery_type  text := coalesce(p_payload->>'delivery_type', 'delivery');
  v_payment_method text := p_payload->>'payment_method';
  v_coupon_code    text := nullif(upper(regexp_replace(btrim(coalesce(p_payload->>'coupon_code', '')), '\s+', '', 'g')), '');
  v_zone_id_raw    text := coalesce(p_payload->>'delivery_zone_id', p_payload->'address'->>'zone_id');
  v_zone_id        uuid := null;
  v_settings       jsonb;
  v_delivery_fee   numeric(14,2) := 0;
  v_city           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'city', '')), '\s+', ' ', 'g'));
  v_area           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'area', '')), '\s+', ' ', 'g'));
  v_street         text := coalesce(btrim(coalesce(p_payload->'address'->>'street', p_payload->'address'->>'address_line1', '')), '');
  v_zone           public.delivery_zones%rowtype;
  v_zone_json      jsonb := null;
  v_legacy_json    jsonb;
  v_has_enabled_zones boolean;
  v_customer_key   text;

  v_line           jsonb;
  v_product        public.products%rowtype;
  v_qty            integer;
  v_available      integer;
  v_variant        public.product_variants%rowtype;
  v_variant_id     uuid;
  v_variant_label  text;
  v_price_fixed    boolean;
  v_unit           numeric(14,2);
  v_subtotal       numeric(14,2) := 0;
  v_priced_lines   jsonb := '[]'::jsonb;

  v_core           jsonb;
  v_discount       numeric(14,2) := 0;
  v_campaign       public.campaigns%rowtype;
  v_cart_products  text[] := '{}';
  v_cart_categories text[] := '{}';

  v_total          numeric(14,2);
  v_order_id       uuid;
  v_order_number   text;
  v_customer_id    uuid := nullif(p_payload->>'store_customer_id', '')::uuid;
  v_payment_status public.online_payment_status;
  v_item           record;
  v_core_line      jsonb;
  v_auto_promo_id  uuid;
  v_coupon_promo_id uuid;
  v_winning_promo_id uuid;
  v_winning_promo_name text;
  v_winning_rule_type text;
  v_winning_buy_x integer;
  v_winning_get_y integer;
  v_winning_reward_qty integer;
begin
  -- 1. idempotency: a double submit returns the original order
  select id, order_number into v_order_id, v_order_number
  from public.online_orders where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number, 'duplicate', true);
  end if;

  if coalesce(btrim(p_payload->>'customer_name'), '') = '' then
    raise exception 'Customer name is required' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_payload->>'customer_phone'), '') = '' then
    raise exception 'Customer phone is required' using errcode = 'check_violation';
  end if;
  if v_delivery_type not in ('delivery', 'pickup') then
    raise exception 'Invalid delivery type' using errcode = 'check_violation';
  end if;
  if v_payment_method not in ('cod', 'instapay') then
    raise exception 'Invalid payment method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;

  select settings into v_settings from public.website_settings where id = 1;
  v_settings := coalesce(v_settings, '{}'::jsonb);

  v_customer_key := coalesce(
    nullif(v_customer_id::text, ''),
    'phone:' || nullif(regexp_replace(coalesce(p_payload->>'customer_phone', ''), '[^0-9]', '', 'g'), ''),
    'order:' || coalesce(v_client_ref, '')
  );

  -- 2. delivery fee preparation
  if v_delivery_type = 'delivery' then
    if v_city = '' or v_area = '' or v_street = '' then
      raise exception 'A delivery address is required' using errcode = 'check_violation';
    end if;

    select exists(select 1 from public.delivery_zones where enabled) into v_has_enabled_zones;

    if v_has_enabled_zones then
      if v_zone_id_raw is null or btrim(v_zone_id_raw) = '' then
        raise exception 'Please select a delivery zone' using errcode = 'check_violation';
      end if;

      begin
        v_zone_id := v_zone_id_raw::uuid;
      exception when invalid_text_representation then
        raise exception 'Invalid delivery zone' using errcode = 'check_violation';
      end;

      select * into v_zone from public.delivery_zones where id = v_zone_id;
      if not found or not v_zone.enabled then
        raise exception 'Delivery zone is not available' using errcode = 'check_violation';
      end if;

      v_zone_json := jsonb_build_object(
        'id', v_zone.id::text,
        'name', coalesce(nullif(v_zone.name_en, ''), v_zone.name_ar),
        'fee', v_zone.shipping_fee,
        'minimum', v_zone.minimum_order_amount,
        'threshold', coalesce(v_zone.free_shipping_threshold, 0)
      );
    else
      -- Zero enabled delivery zones: fallback to legacy website_settings
      v_zone_id := null;
      if coalesce((v_settings->'delivery'->>'enabled')::boolean, true) = false then
        raise exception 'Delivery is not available' using errcode = 'check_violation';
      end if;

      if jsonb_typeof(v_settings->'delivery'->'areas') = 'array'
         and jsonb_array_length(v_settings->'delivery'->'areas') > 0
         and not exists (
           select 1
           from jsonb_array_elements(v_settings->'delivery'->'areas') as place
           where (
             coalesce(place->>'ar', '') <> ''
             and lower(regexp_replace(btrim(place->>'ar'), '\s+', ' ', 'g')) in (v_city, v_area)
           ) or (
             coalesce(place->>'en', '') <> ''
             and lower(regexp_replace(btrim(place->>'en'), '\s+', ' ', 'g')) in (v_city, v_area)
           )
         ) then
        raise exception 'Delivery to % is not available',
          coalesce(nullif(btrim(coalesce(p_payload->'address'->>'city', '')), ''),
                   btrim(coalesce(p_payload->'address'->>'area', '')))
          using errcode = 'check_violation';
      end if;
    end if;

    v_legacy_json := jsonb_build_object(
      'fee', greatest(round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2), 0),
      'minimum', coalesce(nullif(v_settings->'delivery'->>'minimum_order', '')::numeric, 0),
      'threshold', coalesce(nullif(v_settings->'delivery'->>'free_delivery_threshold', '')::numeric, 0)
    );
  else
    v_legacy_json := jsonb_build_object('fee', 0, 'minimum', 0, 'threshold', 0);
  end if;

  -- 3. lines: authoritative prices, campaign discounts, ATP availability
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_product from public.products
    where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.show_on_website then
      raise exception 'Product % is not available on the website', v_product.sku
        using errcode = 'check_violation';
    end if;
    if not v_product.stock_tracking_enabled then
      raise exception 'Product % cannot be ordered online', v_product.sku
        using errcode = 'check_violation';
    end if;

    v_variant_id := null;
    v_price_fixed := false;
    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      if v_variant_id is null then
        raise exception 'Choose the colour and the size for %', v_product.sku
          using errcode = 'check_violation';
      end if;
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      if not v_variant.active then
        raise exception '% is no longer sold',
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
      v_variant_label := coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                                      v_variant.size, v_variant.size_label), v_variant.sku);
      -- 0095: the storefront sells from the fulfilment (default) branch shelf only,
      -- exactly what the catalogue shows. A rollup summed across branches could promise
      -- units no customer can collect.
      v_available := public.storefront_fulfilment_available(v_product.id, v_variant.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_variant_label
          using errcode = 'check_violation';
      end if;
      if v_variant.price_override is not null then
        v_price_fixed := true;
      end if;
    elsif v_product.stock_tracking_enabled then
      v_available := public.storefront_fulfilment_available(v_product.id, null);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_product.sku
          using errcode = 'check_violation';
      end if;
    end if;

    v_cart_products := array_append(v_cart_products, v_product.id::text);
    if v_product.category_id is not null then
      v_cart_categories := array_append(v_cart_categories, v_product.category_id::text);
    end if;

    v_unit := case when v_variant_id is not null and v_price_fixed
                   then v_variant.price_override
                   else v_product.selling_price
              end;
    if not v_price_fixed then
      select * into v_campaign
      from public.campaigns
      where active
        and starts_at <= now() and ends_at >= now()
        and (product_ids = '[]'::jsonb or jsonb_array_length(product_ids) = 0 or product_ids @> to_jsonb(array[v_product.id::text]))
      order by case when discount_type = 'percent' then 1000 + discount_value else discount_value end desc
      limit 1;
      if found then
        if v_campaign.discount_type = 'percent' then
          v_unit := round((v_unit * (100 - v_campaign.discount_value) / 100)::numeric, 2);
        else
          v_unit := greatest(round((v_unit - v_campaign.discount_value)::numeric, 2), 0);
        end if;
      end if;
    end if;

    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);

    v_priced_lines := v_priced_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'category_id', v_product.category_id::text,
      'qty',        v_qty,
      'unit_price', v_unit,
      'variant_id', case when v_variant_id is null then null else v_variant_id::text end
    );
  end loop;

  -- 4. Central promotions pricing evaluation
  v_core := public.evaluate_order_pricing_channel(
    v_subtotal, v_priced_lines, v_coupon_code, v_customer_key,
    v_zone_json, v_legacy_json, v_delivery_type, true, 'online'
  );
  v_discount := (v_core->>'total_discount')::numeric;
  v_delivery_fee := (v_core->>'delivery_fee')::numeric;
  v_total := (v_core->>'total')::numeric;

  v_payment_status := case
    when v_payment_method = 'instapay' then 'verification_required'::public.online_payment_status
    else 'pending'::public.online_payment_status
  end;

  v_auto_promo_id := nullif(v_core->>'auto_promotion_id', '')::uuid;
  v_coupon_promo_id := nullif(v_core->>'coupon_promotion_id', '')::uuid;
  v_winning_promo_id := nullif(v_core->>'winning_promotion_id', '')::uuid;
  v_winning_promo_name := v_core->>'winning_promotion_name';
  v_winning_rule_type := v_core->>'winning_rule_type';
  v_winning_buy_x := (v_core->>'winning_buy_x')::integer;
  v_winning_get_y := (v_core->>'winning_get_y')::integer;
  v_winning_reward_qty := (v_core->>'winning_reward_qty')::integer;

  -- 5. Insert order with full snapshot fields
  insert into public.online_orders (
    client_ref, store_customer_id, customer_name, customer_phone, customer_email,
    delivery_type, address, subtotal, discount_code, discount_amount, delivery_fee,
    total, payment_method, payment_status, status, notes,
    promotion_id, price_snapshot,
    automatic_promotion_id, automatic_promotion_name, automatic_discount_amount,
    promotion_rule_type, promotion_buy_x, promotion_get_y, promotion_reward_qty,
    delivery_zone_id, delivery_zone_name_en, delivery_zone_name_ar, delivery_free_shipping
  ) values (
    v_client_ref,
    v_customer_id,
    btrim(p_payload->>'customer_name'),
    btrim(p_payload->>'customer_phone'),
    nullif(btrim(coalesce(p_payload->>'customer_email', '')), ''),
    v_delivery_type::public.delivery_type,
    case when v_zone_json is null then coalesce(p_payload->'address', '{}'::jsonb)
         else coalesce(p_payload->'address', '{}'::jsonb)
              || jsonb_build_object('zone_id', v_zone_json->>'id', 'zone_name', v_zone_json->>'name')
    end,
    v_subtotal, v_coupon_code, v_discount, v_delivery_fee,
    v_total, v_payment_method::public.payment_method, v_payment_status,
    'pending'::public.online_order_status,
    nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
    v_winning_promo_id,
    jsonb_build_object(
      'promo_code', v_core->>'promo_code',
      'coupon_promotion_id', v_core->>'coupon_promotion_id',
      'coupon_promotion_name', v_core->>'coupon_promotion_name',
      'coupon_promotion_rule_type', v_core->>'coupon_promotion_rule_type',
      'coupon_promotion_buy_x', v_core->>'coupon_promotion_buy_x',
      'coupon_promotion_get_y', v_core->>'coupon_promotion_get_y',
      'coupon_promotion_reward_qty', v_core->>'coupon_promotion_reward_qty',
      'promotion_id', v_core->>'auto_promotion_id',
      'promotion_name', v_core->>'auto_promotion_name',
      'promotion_rule_type', v_core->>'auto_promotion_rule_type',
      'promotion_buy_x', v_core->>'auto_promotion_buy_x',
      'promotion_get_y', v_core->>'auto_promotion_get_y',
      'promotion_reward_qty', v_core->>'auto_promotion_reward_qty',
      'winning_promotion_id', v_core->>'winning_promotion_id',
      'winning_promotion_name', v_core->>'winning_promotion_name',
      'winning_rule_type', v_core->>'winning_rule_type',
      'winning_buy_x', v_core->>'winning_buy_x',
      'winning_get_y', v_core->>'winning_get_y',
      'winning_reward_qty', v_core->>'winning_reward_qty',
      'auto_discount', (v_core->>'auto_discount')::numeric,
      'promo_discount', (v_core->>'promo_discount')::numeric,
      'promo_free_shipping', coalesce((v_core->>'promo_free_shipping')::boolean, false),
      'original_subtotal', v_subtotal,
      'final_subtotal', round((v_subtotal - v_discount)::numeric, 2),
      'gross_shipping_fee', (v_core->>'gross_shipping_fee')::numeric,
      'shipping_discount', (v_core->>'shipping_discount')::numeric,
      'shipping_source', v_core->>'shipping_source',
      'zone_id', v_core->>'zone_id',
      'zone_name', v_core->>'zone_name',
      'total_discount', v_discount,
      'final_total', v_total
    ),
    v_auto_promo_id,
    v_core->>'auto_promotion_name',
    coalesce((v_core->>'auto_discount')::numeric, 0),
    v_winning_rule_type,
    v_winning_buy_x,
    v_winning_get_y,
    v_winning_reward_qty,
    case when v_zone.id is not null then v_zone.id else null end,
    case when v_zone.id is not null then v_zone.name_en else null end,
    case when v_zone.id is not null then v_zone.name_ar else null end,
    case when v_delivery_type = 'delivery' and v_delivery_fee = 0 then true else false end
  ) returning id, order_number into v_order_id, v_order_number;

  -- 6. Coupon customer tracking (recorded for customer limit checks; total used_count is consumed upon order approval)
  if (v_core->>'promo_code') is not null
     and (((v_core->>'promo_discount')::numeric > 0)
          or coalesce((v_core->>'promo_free_shipping')::boolean, false)) then
    insert into public.promo_code_usages (coupon_id, order_id, customer_key)
    select c.id, v_order_id, v_customer_key
    from public.coupons c where c.code = (v_core->>'promo_code')
    on conflict do nothing;
  end if;

  -- 7. Line items snapshots + reservations
  for v_item in
    select value, ordinality - 1 as idx
    from jsonb_array_elements(v_priced_lines) with ordinality
  loop
    v_line := v_item.value;
    v_qty := (v_line->>'qty')::integer;
    v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    v_unit := round((v_line->>'unit_price')::numeric, 2);
    v_core_line := (v_core->'lines')->(v_item.idx::integer);

    if v_variant_id is not null then
      select * into v_variant from public.product_variants where id = v_variant_id;

      insert into public.online_order_items (
        order_id, product_id, variant_id,
        variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, discounted_unit_price, quantity, line_total,
        automatic_promotion_id, automatic_promotion_name, automatic_discount_amount,
        rewarded_qty, promotion_rule_type
      ) values (
        v_order_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        v_unit, (v_core_line->>'discounted_unit_price')::numeric, v_qty,
        round((v_unit * v_qty)::numeric, 2),
        v_winning_promo_id,
        v_winning_promo_name,
        coalesce((v_core_line->>'discount_amount')::numeric, 0),
        coalesce((v_core_line->>'rewarded_qty')::integer, 0),
        v_winning_rule_type
      );

      if v_product.stock_tracking_enabled then
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id = v_variant_id;
        if not found then
          insert into public.stock_reservations (
            online_order_id, product_id, variant_id, quantity, status
          ) values (
            v_order_id, v_product.id, v_variant_id, v_qty, 'reserved'
          );
        end if;
      end if;
    else
      insert into public.online_order_items (
        order_id, product_id,
        name_ar, name_en, sku, barcode, unit_price, discounted_unit_price, quantity, line_total,
        automatic_promotion_id, automatic_promotion_name, automatic_discount_amount,
        rewarded_qty, promotion_rule_type
      ) values (
        v_order_id, v_product.id,
        v_product.name_ar, v_product.name_en, v_product.sku, v_product.barcode,
        v_unit, (v_core_line->>'discounted_unit_price')::numeric, v_qty,
        round((v_unit * v_qty)::numeric, 2),
        v_winning_promo_id,
        v_winning_promo_name,
        coalesce((v_core_line->>'discount_amount')::numeric, 0),
        coalesce((v_core_line->>'rewarded_qty')::integer, 0),
        v_winning_rule_type
      );

      if v_product.stock_tracking_enabled then
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id is null;
        if not found then
          insert into public.stock_reservations (
            online_order_id, product_id, quantity, status
          ) values (
            v_order_id, v_product.id, v_qty, 'reserved'
          );
        end if;
      end if;
    end if;
  end loop;

  insert into public.order_events (order_id, kind, note)
  values (v_order_id, 'placed'::public.order_event_kind, 'Order placed on storefront');

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total', v_total
  );
end;
$$;

grant execute on function public.place_online_order(jsonb) to authenticated, anon;

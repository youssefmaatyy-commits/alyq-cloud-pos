-- ═══════════════════════════════════════════════════════════════════════════
-- 0042 · place_online_order: the shop's own delivery rules
--
-- WHY THIS MIGRATION EXISTS
--   0001–0041 are applied and immutable, and this function is the only
--   authority on what a delivery order costs and where it may go. Four of the
--   shop's delivery settings had no server-side effect at all:
--
--     · available cities/areas — the website settings let the shop list the
--       places it delivers to (cities or neighbourhoods). Nothing checked an
--       address against them, so a customer the shop does not serve could
--       place a delivery order.
--     · minimum order — a delivery below the shop's minimum was accepted.
--     · free-delivery threshold — `deliveryFeeFor` in the storefront (and the
--       demo repository, which mirrors it) waives the fee at or above the
--       threshold, but this function did not: the checkout quoted "free" and
--       the order recorded the fee, which is also the total that approval
--       copies into the sale. With the shipped default (free at 500 EGP) every
--       delivery order of 500 EGP or more was mispriced in the shop's record.
--     · full address — city *or* street was enough, so a driver could be sent
--       to a city with no street, or a street with no city.
--
--   The contract is unchanged from 0034: the browser is never trusted with a
--   price. A `delivery_fee` in the payload is still ignored — `subtotal`,
--   `discount_amount`, `delivery_fee` and `total` are all recomputed here.
--
-- THE CHANGE
--   Step 2 now requires a city, an area and a street, and — only when the shop
--   has listed places — refuses an address whose city or area matches none of
--   them (trimmed, case-folded, either language, exactly as
--   `deliveryAreaSupported` compares them in the storefront).
--   After the coupon has been applied — the goods total the threshold and the
--   minimum are measured against does not exist before then — the minimum order
--   is enforced and the fee is waived at or above the free-delivery threshold,
--   exactly as `deliveryFeeFor` does. The fee is clamped at zero.
--
--   Everything else — idempotency, authoritative line pricing, campaigns,
--   stock holds, coupon rules, the return shape and the grant — is 0034's body,
--   line for line.
--
-- Idempotent: CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_coupon_code    text := nullif(upper(btrim(coalesce(p_payload->>'coupon_code', ''))), '');
  v_settings       jsonb;
  v_delivery_fee   numeric(14,2) := 0;
  -- Normalized once, so the address and the shop's list of places are compared
  -- the way the storefront compares them: trimmed, case-folded, whitespace
  -- collapsed. `v_minimum`/`v_threshold` are read after the coupon, because the
  -- goods total they are measured against does not exist yet.
  v_city           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'city', '')), '\s+', ' ', 'g'));
  v_area           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'area', '')), '\s+', ' ', 'g'));
  v_minimum        numeric(14,2);
  v_threshold      numeric(14,2);

  v_line           jsonb;
  v_product        public.products%rowtype;
  v_qty            integer;
  v_available      integer;
  v_unit           numeric(14,2);
  v_subtotal       numeric(14,2) := 0;
  -- Phase 23: the priced cart. The first loop works out what each line costs
  -- (catalogue price, less any live campaign) and the second loop writes the
  -- snapshot rows, so the price has to travel between them. It did not: the
  -- second loop read `unit_price` from the caller's payload, which the app
  -- never sends — every live-mode checkout failed the NOT NULL constraint, and
  -- a caller who did send one set the shop's own snapshot price.
  v_priced_lines   jsonb := '[]'::jsonb;

  v_coupon         public.coupons%rowtype;
  v_discount       numeric(14,2) := 0;
  v_campaign       public.campaigns%rowtype;
  -- What is in the cart, so a coupon restricted to certain products or
  -- categories can be checked against the real contents rather than trusted.
  v_cart_products  text[] := '{}';
  v_cart_categories text[] := '{}';

  v_total          numeric(14,2);
  v_order_id       uuid;
  v_order_number   text;
  v_customer_id    uuid := nullif(p_payload->>'store_customer_id', '')::uuid;
  v_payment_status public.online_payment_status;
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

  -- 2. the delivery fee is the shop's, not the customer's — and so are the
  --    places the shop is willing to deliver to
  if v_delivery_type = 'delivery' then
    if coalesce((v_settings->'delivery'->>'enabled')::boolean, true) = false then
      raise exception 'Delivery is not available' using errcode = 'check_violation';
    end if;
    v_delivery_fee := greatest(round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2), 0);

    -- A driver needs a whole address: which city, which area in it, and which
    -- street. Building, floor and apartment stay optional.
    if v_city = ''
       or v_area = ''
       or coalesce(btrim(p_payload->'address'->>'street'), '') = '' then
      raise exception 'A delivery address is required' using errcode = 'check_violation';
    end if;

    -- The shop may list the places it serves — cities or neighbourhoods, in
    -- either language. An empty list means it has not restricted delivery.
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
  else
    v_delivery_fee := 0;
  end if;

  -- 3. lines: authoritative prices, campaign discounts, availability
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
    -- Approval turns the order into a POS sale, and a sale can only carry
    -- stock-tracked products. Refusing here means the customer hears it at
    -- checkout, instead of staff discovering it when they try to approve.
    if not v_product.stock_tracking_enabled then
      raise exception 'Product % cannot be ordered online', v_product.sku
        using errcode = 'check_violation';
    end if;
    if v_product.stock_tracking_enabled then
      v_available := v_product.stock_quantity - public.reserved_quantity(v_product.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_product.sku
          using errcode = 'check_violation';
      end if;
    end if;

    v_cart_products := array_append(v_cart_products, v_product.id::text);
    if v_product.category_id is not null then
      v_cart_categories := array_append(v_cart_categories, v_product.category_id::text);
    end if;

    -- A live campaign on this product lowers the unit price; the customer's
    -- cart total is never trusted.
    v_unit := v_product.selling_price;
    select * into v_campaign
    from public.campaigns
    where active
      and starts_at <= now() and ends_at >= now()
      and product_ids @> to_jsonb(array[v_product.id::text])
    order by discount_value desc
    limit 1;
    if found then
      if v_campaign.discount_type = 'percent' then
        v_unit := round((v_unit * (100 - v_campaign.discount_value) / 100)::numeric, 2);
      else
        v_unit := greatest(round((v_unit - v_campaign.discount_value)::numeric, 2), 0);
      end if;
    end if;

    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);

    -- Carry the shop's price to the snapshot loop. Nothing from the caller's
    -- line is trusted past this point but product_id and qty, both of which
    -- were just validated against the catalogue.
    v_priced_lines := v_priced_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'qty',        v_qty,
      'unit_price', v_unit
    );
  end loop;

  -- 4. coupon, validated against its own rules and the recomputed subtotal
  if v_coupon_code is not null then
    select * into v_coupon from public.coupons
    where code = v_coupon_code for update;
    if not found or not v_coupon.active then
      raise exception 'Coupon % is not valid', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
      raise exception 'Coupon % is not active yet', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.ends_at is not null and v_coupon.ends_at < now() then
      raise exception 'Coupon % has expired', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'Coupon % has been fully used', v_coupon_code using errcode = 'check_violation';
    end if;
    if v_subtotal < v_coupon.min_subtotal then
      raise exception 'Coupon % needs a subtotal of at least %', v_coupon_code, v_coupon.min_subtotal
        using errcode = 'check_violation';
    end if;

    -- A code restricted to certain products or categories only applies when the
    -- cart actually contains one of them. Without this, "10% off coffee" would
    -- discount an espresso machine too.
    if v_coupon.applies_to = 'products' and not exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (v_cart_products)
    ) then
      raise exception 'Coupon % does not apply to this cart', v_coupon_code
        using errcode = 'check_violation';
    end if;
    if v_coupon.applies_to = 'categories' and not exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (v_cart_categories)
    ) then
      raise exception 'Coupon % does not apply to this cart', v_coupon_code
        using errcode = 'check_violation';
    end if;

    if v_coupon.discount_type = 'percent' then
      v_discount := round((v_subtotal * v_coupon.value / 100)::numeric, 2);
      if v_coupon.max_discount is not null then
        v_discount := least(v_discount, v_coupon.max_discount);
      end if;
    else
      v_discount := least(round(v_coupon.value::numeric, 2), v_subtotal);
    end if;

    update public.coupons set used_count = used_count + 1, updated_at = now()
    where id = v_coupon.id;
  end if;

  -- 4b. the shop's delivery rules, measured against the goods total the coupon
  --     has already reduced — the same number the checkout shows.
  if v_delivery_type = 'delivery' then
    v_minimum := nullif(v_settings->'delivery'->>'minimum_order', '')::numeric;
    if v_minimum is not null and v_minimum > 0 and (v_subtotal - v_discount) < v_minimum then
      raise exception 'Delivery orders need at least %', v_minimum
        using errcode = 'check_violation';
    end if;
    v_threshold := nullif(v_settings->'delivery'->>'free_delivery_threshold', '')::numeric;
    if v_threshold is not null and v_threshold > 0
       and (v_subtotal - v_discount) >= v_threshold then
      v_delivery_fee := 0;
    end if;
  end if;

  v_total := v_subtotal - v_discount + v_delivery_fee;

  -- InstaPay always needs a human to confirm the transfer; cash on delivery is
  -- simply unpaid until it is collected.
  v_payment_status := case
    when v_payment_method = 'instapay' then 'verification_required'::public.online_payment_status
    else 'pending'::public.online_payment_status
  end;

  -- 5. the order
  insert into public.online_orders (
    client_ref, store_customer_id, customer_name, customer_phone, customer_email,
    delivery_type, address, subtotal, discount_code, discount_amount, delivery_fee,
    total, payment_method, payment_status, status, notes
  ) values (
    v_client_ref,
    v_customer_id,
    btrim(p_payload->>'customer_name'),
    btrim(p_payload->>'customer_phone'),
    nullif(btrim(coalesce(p_payload->>'customer_email', '')), ''),
    v_delivery_type::public.delivery_type,
    coalesce(p_payload->'address', '{}'::jsonb),
    v_subtotal, v_coupon_code, v_discount, v_delivery_fee,
    v_total, v_payment_method::public.payment_method, v_payment_status,
    'pending'::public.online_order_status,
    nullif(btrim(coalesce(p_payload->>'notes', '')), '')
  ) returning id, order_number into v_order_id, v_order_number;

  -- 6. line items (snapshot) + reservations (inventory protection)
  -- Phase 23: the priced cart, not the payload. Same keys, so the body below
  -- is unchanged; the difference is that `unit_price` is now the shop's.
  for v_line in select * from jsonb_array_elements(v_priced_lines)
  loop
    v_qty := (v_line->>'qty')::integer;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    v_unit := round((v_line->>'unit_price')::numeric, 2);

    insert into public.online_order_items (
      order_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total
    ) values (
      v_order_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
      v_product.barcode, v_unit, v_qty, round((v_unit * v_qty)::numeric, 2)
    );

    if v_product.stock_tracking_enabled then
      insert into public.stock_reservations (online_order_id, product_id, quantity, status)
      values (v_order_id, v_product.id, v_qty, 'reserved'::public.reservation_status);
    end if;
  end loop;

  insert into public.order_events (order_id, kind, note)
  values (v_order_id, 'placed'::public.order_event_kind,
          'Order placed on the website (' || v_delivery_type || ')');

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'total', v_total,
    'payment_status', v_payment_status::text,
    'duplicate', false
  );
end;
$$;

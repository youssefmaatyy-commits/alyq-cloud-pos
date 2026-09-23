-- Phase 9 (part 2) — the online storefront's write paths.
--
-- 0017 created the tables. This file creates the functions that write to them,
-- because the customer side of this app has no identity to gate rows on: a
-- guest checking out is `anon`, and RLS cannot scope an anonymous role to "the
-- order you just placed". So, exactly as the POS does for sales, the public
-- paths go through `security definer` functions that validate server-side and
-- are the only writers the tables have. Direct table access stays denied.
--
--   place_online_order(jsonb)          guest/account checkout → pending order
--                                      + stock reservations
--   submit_online_payment_proof(jsonb) customer uploads the InstaPay reference
--                                      and proof → verification_required
--   lookup_online_order(text, text)    order tracking, gated on order number
--                                      AND the phone number it was placed with
--   list_my_online_orders()            a signed-in customer's own orders
--   resolve_online_order(jsonb)        the staff workflow: approve / cancel /
--                                      processing / ready / complete, plus
--                                      approving or rejecting a payment
--
-- 'cod' (added to the enum in 0017) is used from here on: cash on delivery is
-- recorded as a *pending* payment, never a paid one, because the money has not
-- been collected yet. That is also why it never appears in the till's cash
-- ledger — a courier's pocket is not the drawer.
--
-- One deliberate accounting boundary: a POS sale cannot carry a delivery fee
-- (`sales.total = subtotal − discount_amount` is a table constraint), so an
-- approved order becomes a sale for the MERCHANDISE only, and the delivery fee
-- stays on the order. Online-order reports therefore show goods revenue,
-- delivery fees and the combined total separately — nothing is lost, and the
-- POS money model is unchanged.

-- ── 1. the sale constraint admits cash-on-delivery ────────────────────────
-- Same shape as 0015's rule; 'cod' joins InstaPay and card as a method that
-- puts no cash in the drawer at sale time and therefore records no tender.
alter table public.sales drop constraint if exists sales_cash_received_covers_total;
alter table public.sales add constraint sales_cash_received_covers_total check (
  payment_method in ('instapay', 'visa', 'cod')
  or (
    amount_received is not null
    and coalesce(change, 0) >= 0
    and amount_received >= coalesce(change, 0)
    and (amount_received - coalesce(change, 0)) <= total
  )
);

comment on constraint sales_cash_received_covers_total on public.sales is
  'Cash bookkeeping on a sale row: tender recorded, change non-negative and no larger than the tender, and cash applied never above the total. InstaPay, card and cash-on-delivery sales carry no cash at sale time. Per-payment coverage (cash tender >= cash amount) is enforced by pos_complete_sale, the only writer.';

-- ── 1b. the payment rule 0017 could not state ─────────────────────────────
-- Money is only "paid" once a person has confirmed it — never automatically.
-- Cash on delivery is the one exception, and even then it is confirmed when the
-- courier's money is counted in (see resolve_online_order('payment_approve'));
-- the exemption exists because a COD order is legitimately approved before the
-- cash arrives, and approving it must not require a verification timestamp.
-- Both spellings are dropped so re-applying this migration is a no-op: the
-- migration check runs every file twice and the second pass must change nothing.
alter table public.online_orders drop constraint if exists online_orders_paid_requires_verifier;
alter table public.online_orders drop constraint if exists online_orders_paid_requires_verification;
alter table public.online_orders add constraint online_orders_paid_requires_verification check (
  payment_status <> 'paid'
  or payment_verified_at is not null
  or payment_method = 'cod'
);

comment on constraint online_orders_paid_requires_verification on public.online_orders is
  'A paid payment status means a human verified it (payment_verified_at set), except cash on delivery, which is collected after approval.';

-- ── 2. pos_complete_sale, extended for online sales ───────────────────────
-- This is 0015's function with exactly three changes, so the till keeps
-- behaving identically:
--   1. an optional `source` in the payload ('pos' by default, 'online' when an
--      approved website order creates the sale) — the column 0017 added;
--   2. 'cod' accepted as a payment method and ALWAYS recorded pending;
--   3. the payment-row loop applies the same status rule as validation, so a
--      cod leg cannot be written as paid by falling through the `else`.
create or replace function public.pos_complete_sale(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref      text := p_payload->>'client_ref';
  v_discount_type   text := coalesce(p_payload->>'discount_type', 'none');
  v_discount_value  numeric(14,2) := coalesce((p_payload->>'discount_value')::numeric, 0);
  v_user_id         text := p_payload->>'user_id';
  v_user_name       text := p_payload->>'user_name';
  v_source          text := coalesce(p_payload->>'source', 'pos');

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;

  v_subtotal        numeric(14,2) := 0;
  v_discount_amount numeric(14,2) := 0;
  v_total           numeric(14,2);

  v_pay             jsonb;
  v_pay_method      text;
  v_pay_amount      numeric(14,2);
  v_pay_status      text;
  v_pay_tendered    numeric(14,2);
  v_sum             numeric(14,2) := 0;
  v_cash_received   numeric(14,2) := 0;
  v_cash_applied    numeric(14,2) := 0;
  v_all_paid        boolean := true;
  v_first_method    public.payment_method;

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
  v_pay_status_enum public.payment_status;
begin
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_source not in ('pos', 'online') then
    raise exception 'Invalid source' using errcode = 'check_violation';
  end if;

  if v_discount_type not in ('none','percent','fixed') or v_discount_value < 0
     or (v_discount_type = 'percent' and v_discount_value > 100) then
    raise exception 'Invalid discount' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_payload->'lines','[]'::jsonb)) = 0 then
    raise exception 'Empty cart' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'payments','[]'::jsonb)) = 0 then
    raise exception 'At least one payment is required' using errcode = 'check_violation';
  end if;

  -- 2. validate lines against live catalog + accumulate subtotal
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Product % is not sellable', v_product.sku using errcode = 'check_violation';
    end if;
    if v_qty > v_product.stock_quantity then
      raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
    end if;
    v_subtotal := v_subtotal + round((v_product.selling_price * v_qty)::numeric, 2);
  end loop;

  -- 3. authoritative totals
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_subtotal * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- 4. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- 0015 added 'visa'; 0018 adds 'cod' for online orders.
    if v_pay_method not in ('cash','instapay','visa','cod') or v_pay_amount <= 0 then
      raise exception 'Invalid payment' using errcode = 'check_violation';
    end if;
    if v_pay_method = 'cash' then
      v_pay_tendered := round(coalesce((v_pay->>'tendered')::numeric, v_pay_amount), 2);
      if v_pay_tendered < v_pay_amount then
        raise exception 'Insufficient cash received' using errcode = 'check_violation';
      end if;
      v_cash_received := v_cash_received + v_pay_tendered;
      v_cash_applied  := v_cash_applied + v_pay_amount;
      v_pay_status := 'paid';
    else
      -- Card money is captured at the terminal, so `visa` is always paid.
      -- Cash on delivery has NOT been collected, so `cod` is always pending —
      -- a client cannot claim delivery cash it has not taken. InstaPay alone
      -- stays pending until the transfer is confirmed.
      v_pay_status := case
        when v_pay_method = 'visa' then 'paid'
        when v_pay_method = 'cod' then 'pending'
        when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending'
        else 'paid'
      end;
    end if;
    if v_pay_status = 'pending' then v_all_paid := false; end if;
    if v_first_method is null then v_first_method := v_pay_method::public.payment_method; end if;
    v_sum := v_sum + v_pay_amount;
  end loop;

  if v_sum <> v_total then
    raise exception 'Payments sum to %, but the sale total is %', v_sum, v_total using errcode = 'check_violation';
  end if;

  v_sale_status := case when v_all_paid then 'completed' else 'pending' end;

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end,
    v_source
  ) returning id into v_sale_id;

  -- 6. payment rows + sale items + stock + movements
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- The same rule as validation above: InstaPay follows the payload, card and
    -- cash are paid, cash on delivery is never paid at creation.
    v_pay_status := case
      when v_pay_method = 'instapay'
        then case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end
      when v_pay_method = 'cod' then 'pending'
      else 'paid'
    end;
    v_pay_status_enum := v_pay_status::public.payment_status;

    insert into public.sale_payments (sale_id, method, amount, status, paid_at, paid_by, paid_by_name)
    values (
      v_sale_id, v_pay_method::public.payment_method, v_pay_amount, v_pay_status_enum,
      case when v_pay_status_enum = 'paid' then now() else null end,
      case when v_pay_status_enum = 'paid' then v_user_id else null end,
      case when v_pay_status_enum = 'paid' then v_user_name else null end
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    insert into public.sale_items (sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total)
    values (v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
            v_product.barcode, v_product.selling_price, v_qty,
            round((v_product.selling_price * v_qty)::numeric, 2));

    v_before := v_product.stock_quantity;
    update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

    insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
    values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
            case when v_source = 'online'
                 then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
                 else 'Sale ' || v_sale_number
            end,
            v_user_id, v_user_name);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

grant execute on function public.pos_complete_sale(jsonb) to authenticated;

-- ── 3. checkout: place an online order ────────────────────────────────────
/**
 * The only way an order enters the system.
 *
 * Everything money- or stock-related is recomputed here: the client sends
 * product ids, quantities, a coupon code and its contact/delivery details, and
 * this function re-reads the catalogue prices, re-validates the coupon against
 * its window and usage limit, takes the delivery fee from `website_settings`
 * (never from the client), and checks availability as
 * `stock_quantity − reserved_quantity()` so two customers cannot both promise
 * themselves the last unit.
 *
 * Idempotent on `client_ref`: a retry returns the original order.
 */
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

  v_line           jsonb;
  v_product        public.products%rowtype;
  v_qty            integer;
  v_available      integer;
  v_unit           numeric(14,2);
  v_subtotal       numeric(14,2) := 0;

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

  -- 2. the delivery fee is the shop's, not the customer's
  if v_delivery_type = 'delivery' then
    if coalesce((v_settings->'delivery'->>'enabled')::boolean, true) = false then
      raise exception 'Delivery is not available' using errcode = 'check_violation';
    end if;
    v_delivery_fee := round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2);
    if coalesce(btrim(p_payload->'address'->>'city'), '') = ''
       and coalesce(btrim(p_payload->'address'->>'street'), '') = '' then
      raise exception 'A delivery address is required' using errcode = 'check_violation';
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
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
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

-- Guests place orders: that is the whole point of the storefront.
grant execute on function public.place_online_order(jsonb) to anon, authenticated;

comment on function public.place_online_order(jsonb) is
  'Checkout: validates and prices an order server-side, reserves the stock, and creates it as pending. Idempotent on client_ref.';

-- ── 4. InstaPay proof ─────────────────────────────────────────────────────
/**
 * The customer's half of InstaPay verification: they pay through the shop's
 * InstaPay link, then submit the transaction reference and (optionally) a photo
 * of the confirmation. The order moves to `verification_required` — it is NEVER
 * marked paid here. Only a staff member can do that, through
 * `resolve_online_order('payment_approve')`.
 */
create or replace function public.submit_online_payment_proof(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order      public.online_orders%rowtype;
  v_reference  text := nullif(btrim(coalesce(p_payload->>'payment_reference', '')), '');
begin
  select * into v_order from public.online_orders
  where order_number = nullif(btrim(p_payload->>'order_number'), '')
    and customer_phone = nullif(btrim(p_payload->>'customer_phone'), '');
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.payment_method <> 'instapay' then
    raise exception 'This order is not paid by InstaPay' using errcode = 'check_violation';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'This order was cancelled' using errcode = 'check_violation';
  end if;
  if v_order.payment_status = 'paid' then
    -- Already verified: nothing to do, and no second proof may overwrite it.
    return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'paid');
  end if;
  if v_reference is null then
    raise exception 'A transaction reference is required' using errcode = 'check_violation';
  end if;

  update public.online_orders
  set payment_reference    = v_reference,
      payment_proof_url    = nullif(btrim(coalesce(p_payload->>'payment_proof_url', '')), ''),
      payment_submitted_at = now(),
      payment_status       = 'verification_required'::public.online_payment_status,
      updated_at           = now()
  where id = v_order.id;

  insert into public.order_events (order_id, kind, note)
  values (v_order.id, 'payment_submitted'::public.order_event_kind,
          'InstaPay reference ' || v_reference || ' submitted for verification');

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'payment_status', 'verification_required'
  );
end;
$$;

grant execute on function public.submit_online_payment_proof(jsonb) to anon, authenticated;

-- ── 5. order tracking ─────────────────────────────────────────────────────
/**
 * Guest order tracking. Gated on the order number AND the phone number the
 * order was placed with, because an anonymous caller has no identity: knowing
 * both is what proves the order is yours. Returns the order, its items and its
 * timeline — and nothing about any other order.
 */
create or replace function public.lookup_online_order(p_order_number text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.online_orders%rowtype;
begin
  select * into v_order from public.online_orders
  where order_number = nullif(btrim(p_order_number), '')
    and customer_phone = nullif(btrim(p_phone), '');
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'order', to_jsonb(v_order),
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.id)
      from public.online_order_items i where i.order_id = v_order.id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', e.kind::text, 'note', e.note,
               'user_name', e.user_name, 'created_at', e.created_at)
               order by e.created_at)
      from public.order_events e where e.order_id = v_order.id
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.lookup_online_order(text, text) to anon, authenticated;

/** A signed-in customer's own orders — scoped by the session, not by input. */
create or replace function public.list_my_online_orders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'order', to_jsonb(o),
             'items', coalesce((
               select jsonb_agg(to_jsonb(i) order by i.id)
               from public.online_order_items i where i.order_id = o.id
             ), '[]'::jsonb))
             order by o.created_at desc)
    from public.online_orders o
    where o.store_customer_id = v_uid
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_my_online_orders() to authenticated;

-- ── 6. the staff workflow ─────────────────────────────────────────────────
/**
 * Every state change an employee can make to an online order, in one function
 * so the side effects cannot be forgotten:
 *
 *   approve           pending → approved. Requires a verified payment for
 *                     InstaPay orders (unverified money never creates a sale).
 *                     Converts the stock reservations and creates the POS sale
 *                     through `pos_complete_sale` with source = 'online', so
 *                     the order becomes a real sale with a real deduction.
 *   cancel            → cancelled, with a mandatory reason. Releases any
 *                     reservation still held. If a sale already exists it is
 *                     voided (which restores the stock) — and that needs
 *                     `void_sale`, so a cashier can cancel a pending order but
 *                     only a manager can unwind an approved one.
 *   processing/ready/complete
 *                     forward-only status moves.
 *   payment_approve   verification_required|pending → paid. Needs
 *                     `confirm_payment`, the same capability that confirms an
 *                     InstaPay transfer at the till.
 *   payment_reject    → failed, with a reason.
 *
 * Each action appends an `order_events` row (the customer's tracking timeline)
 * and, where money or stock moves, an `audit_log` entry naming the actor.
 */
create or replace function public.resolve_online_order(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action      text := p_payload->>'action';
  v_order_id    uuid := nullif(p_payload->>'order_id', '')::uuid;
  v_reason      text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_order       public.online_orders%rowtype;
  v_user_id     text := coalesce(auth.uid()::text, p_payload->>'user_id', '');
  v_user_name   text := coalesce(nullif(btrim(coalesce(p_payload->>'user_name', '')), ''),
                                 (select p.name from public.profiles p where p.id = auth.uid()),
                                 'System');
  v_goods_total numeric(14,2);
  v_list_total  numeric(14,2);
  v_sale_discount numeric(14,2);
  v_result      jsonb;
  v_reservation record;
begin
  select * into v_order from public.online_orders where id = v_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  -- ── payment verification ────────────────────────────────────────────────
  if v_action in ('payment_approve', 'payment_reject') then
    if not public.can('confirm_payment') then
      raise exception 'Not allowed to verify payments' using errcode = '42501';
    end if;
    if v_order.payment_status = 'paid' and v_action = 'payment_approve' then
      return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'paid');
    end if;

    if v_action = 'payment_approve' then
      update public.online_orders
      set payment_status = 'paid'::public.online_payment_status,
          payment_verified_by = auth.uid(),
          payment_verified_by_name = v_user_name,
          payment_verified_at = now(),
          updated_at = now()
      where id = v_order.id;

      insert into public.order_events (order_id, kind, note, user_id, user_name)
      values (v_order.id, 'payment_approved'::public.order_event_kind,
              'Payment verified and accepted', auth.uid(), v_user_name);

      insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
      values ('online_order.payment_approved', v_order.id::text, v_order.order_number,
              jsonb_build_object('method', v_order.payment_method::text,
                                 'amount', v_order.total,
                                 'reference', v_order.payment_reference),
              v_user_id, v_user_name);

      return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'paid');
    end if;

    if v_reason is null then
      raise exception 'A rejection reason is required' using errcode = 'check_violation';
    end if;

    update public.online_orders
    set payment_status = 'failed'::public.online_payment_status,
        payment_rejected_reason = v_reason,
        payment_verified_by = auth.uid(),
        payment_verified_by_name = v_user_name,
        payment_verified_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'payment_rejected'::public.order_event_kind,
            'Payment rejected: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.payment_rejected', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'amount', v_order.total),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'payment_status', 'failed');
  end if;

  -- ── everything below is order-state work ────────────────────────────────
  if not public.can('manage_online_orders') then
    raise exception 'Not allowed to manage online orders' using errcode = '42501';
  end if;

  if v_action = 'approve' then
    if v_order.status <> 'pending' then
      raise exception 'Only a pending order can be approved (this one is %)', v_order.status::text
        using errcode = 'check_violation';
    end if;
    -- Unverified money must never become a sale.
    if v_order.payment_method = 'instapay' and v_order.payment_status <> 'paid' then
      raise exception 'Verify the InstaPay payment before approving this order'
        using errcode = 'check_violation';
    end if;

    -- The sale covers the merchandise; the delivery fee stays on the order
    -- (a POS sale has no delivery-fee column, by constraint).
    v_goods_total := v_order.subtotal - v_order.discount_amount;

    -- `pos_complete_sale` re-reads catalogue prices, so the sale's lines come out
    -- at LIST price. Whatever lowered them when the customer checked out — a
    -- flash sale, a coupon, both — has to be carried across as one fixed
    -- discount, or the register would book more revenue than the order took.
    select coalesce(sum(round((p.selling_price * i.quantity)::numeric, 2)), 0)
      into v_list_total
    from public.online_order_items i
    join public.products p on p.id = i.product_id
    where i.order_id = v_order.id;

    v_sale_discount := greatest(round((v_list_total - v_goods_total)::numeric, 2), 0);

    v_result := public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'online-' || v_order.id::text,
      'source', 'online',
      'order_number', v_order.order_number,
      'discount_type', case when v_sale_discount > 0 then 'fixed' else 'none' end,
      'discount_value', v_sale_discount,
      'user_id', v_user_id,
      'user_name', v_user_name,
      'customer_id', v_order.store_customer_id,
      'customer_name', v_order.customer_name,
      'customer_phone', v_order.customer_phone,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'qty', i.quantity))
        from public.online_order_items i where i.order_id = v_order.id
      ), '[]'::jsonb),
      'payments', jsonb_build_array(jsonb_build_object(
        'method', case when v_order.payment_method = 'cod' then 'cod' else 'instapay' end,
        'amount', v_goods_total,
        'status', case when v_order.payment_status = 'paid' then 'paid' else 'pending' end
      ))
    ));

    -- Reservations become the deduction the sale just made.
    update public.stock_reservations
    set status = 'converted'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    update public.online_orders
    set status = 'approved'::public.online_order_status,
        sale_id = (v_result->>'sale_id')::uuid,
        sale_number = v_result->>'sale_number',
        approved_by = auth.uid(),
        approved_by_name = v_user_name,
        approved_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'approved'::public.order_event_kind,
            'Order approved · sale ' || coalesce(v_result->>'sale_number', ''),
            auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.approved', v_order.id::text, v_order.order_number,
            jsonb_build_object('sale_number', v_result->>'sale_number',
                               'total', v_order.total,
                               'payment_method', v_order.payment_method::text,
                               'source', 'website'),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'approved',
                              'sale_number', v_result->>'sale_number');
  end if;

  if v_action = 'cancel' then
    if v_order.status in ('cancelled', 'completed') then
      raise exception 'A % order cannot be cancelled', v_order.status::text
        using errcode = 'check_violation';
    end if;
    if v_reason is null then
      raise exception 'A cancellation reason is required' using errcode = 'check_violation';
    end if;

    -- An approved order already became a sale: unwind it, which is what puts
    -- the stock back. That is a void, so it needs the void capability.
    if v_order.sale_id is not null then
      if not public.can('void_sale') then
        raise exception 'This order was approved and became sale %; only a manager can cancel it',
          coalesce(v_order.sale_number, '') using errcode = '42501';
      end if;
      update public.sales
      set status = 'voided'::public.sale_status,
          voided_at = now(),
          void_reason = 'Online order ' || v_order.order_number || ' cancelled: ' || v_reason
      where id = v_order.sale_id
        and status <> 'voided';

      -- Restore the stock the voided sale took, one movement per line. Mirrors
      -- the void path in 0007 exactly: `delta` is a magnitude (the column
      -- checks delta > 0) and the sign is implied by `adjustment_in`.
      for v_reservation in
        select i.product_id, i.quantity, p.stock_quantity
        from public.online_order_items i
        join public.products p on p.id = i.product_id
        where i.order_id = v_order.id
      loop
        update public.products
        set stock_quantity = stock_quantity + v_reservation.quantity, updated_at = now()
        where id = v_reservation.product_id;

        insert into public.stock_movements
          (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
        values (v_reservation.product_id, v_reservation.quantity,
                v_reservation.stock_quantity,
                v_reservation.stock_quantity + v_reservation.quantity,
                'adjustment_in', 'other',
                'Cancelled online order ' || v_order.order_number, v_user_id, v_user_name);
      end loop;
    end if;

    -- Whatever was still held goes back to the pool.
    update public.stock_reservations
    set status = 'released'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    -- A coupon consumed by a cancelled order is given back.
    if v_order.discount_code is not null then
      update public.coupons
      set used_count = greatest(used_count - 1, 0), updated_at = now()
      where code = v_order.discount_code;
    end if;

    update public.online_orders
    set status = 'cancelled'::public.online_order_status,
        cancellation_reason = v_reason,
        cancelled_by = auth.uid(),
        cancelled_by_name = v_user_name,
        cancelled_at = now(),
        sale_id = null,
        sale_number = null,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'cancelled'::public.order_event_kind,
            'Order cancelled: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.cancelled', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'total', v_order.total,
                               'had_sale', v_order.sale_id is not null),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'cancelled');
  end if;

  if v_action in ('processing', 'ready', 'complete') then
    -- Forward-only: an order may not go backwards or skip approval.
    if v_order.status in ('cancelled', 'pending') then
      raise exception 'A % order must be approved first', v_order.status::text
        using errcode = 'check_violation';
    end if;
    if v_order.status in ('completed') then
      raise exception 'This order is already completed' using errcode = 'check_violation';
    end if;
    if v_order.status = 'ready' and v_action = 'processing' then
      raise exception 'A ready order cannot go back to processing' using errcode = 'check_violation';
    end if;

    update public.online_orders
    set status = v_action::public.online_order_status,
        completed_at = case when v_action = 'complete' then now() else completed_at end,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, v_action::public.order_event_kind,
            initcap(v_action) || ' by ' || v_user_name, auth.uid(), v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', v_action);
  end if;

  raise exception 'Unknown action %', coalesce(v_action, '(none)') using errcode = 'check_violation';
end;
$$;

grant execute on function public.resolve_online_order(jsonb) to authenticated;

comment on function public.resolve_online_order(jsonb) is
  'The staff workflow for a website order: approve (converts reservations, creates the POS sale), cancel (releases or voids, keeps the record and the reason), forward status moves, and payment verification. Every action records who did it and when.';

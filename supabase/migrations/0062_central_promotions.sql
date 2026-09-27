-- ═══════════════════════════════════════════════════════════════════════════
-- 0062 — CENTRAL DISCOUNTS & PROMOTIONS SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════
-- Unifies central promotions across POS and Storefront with:
--   · Automatic and Coupon modes (`mode in ('automatic', 'coupon')`)
--   · Unified coupon code field (`code` text)
--   · Full targeting across store, category, product, and exact variant
--   · Channel awareness ('pos', 'online', 'both')
--   · Authoritative non-stacking best-saving rules and historical snapshots
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.promotions
  add column if not exists mode text not null default 'automatic',
  add column if not exists code text;

alter table public.promotions drop constraint if exists promotions_mode_valid;
alter table public.promotions add constraint promotions_mode_valid
  check (mode in ('automatic', 'coupon'));

alter table public.promotions drop constraint if exists promotions_code_format;
alter table public.promotions add constraint promotions_code_format
  check (mode <> 'coupon' or (code is not null and btrim(code) <> ''));

-- ── evaluate_order_pricing_channel with unified promotions & coupons ───────
create or replace function public.evaluate_order_pricing_channel(
  p_subtotal      numeric,
  p_lines         jsonb,
  p_promo_code    text,
  p_customer_key  text,
  p_zone          jsonb,
  p_legacy        jsonb,
  p_delivery_type text,
  p_lock          boolean default false,
  p_channel       text default 'online'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal     numeric(14,2) := round(greatest(coalesce(p_subtotal, 0), 0)::numeric, 2);
  v_line         jsonb;
  v_cart_products  text[] := '{}';
  v_cart_categories text[] := '{}';
  v_cart_variants  text[] := '{}';

  v_promo        public.promotions%rowtype;
  v_candidate    public.promotions%rowtype;
  v_eligible     numeric(14,2);
  v_discount     numeric(14,2);
  v_auto_discount numeric(14,2) := 0;
  v_auto_id      uuid := null;
  v_auto_name    text := null;
  v_auto_stack   boolean := false;

  v_code         text := nullif(upper(regexp_replace(btrim(coalesce(p_promo_code, '')), '\s+', '', 'g')), '');
  v_coupon_promo public.promotions%rowtype;
  v_coupon       public.coupons%rowtype;
  v_coupon_discount numeric(14,2) := 0;
  v_coupon_free_ship boolean := false;
  v_coupon_stack boolean := false;
  v_code_applied boolean := false;
  v_coupon_promo_matched boolean := false;
  v_uses         integer;
  v_prior_orders integer;

  v_goods_discount numeric(14,2) := 0;
  v_gross_fee    numeric(14,2) := 0;
  v_ship_discount numeric(14,2) := 0;
  v_net_fee      numeric(14,2) := 0;
  v_ship_source  text := 'pickup';
  v_zone_id      uuid := null;
  v_zone_name    text := null;

  v_total        numeric(14,2);
  v_share        numeric(14,2);
  v_line_total   numeric(14,2);
  v_line_qty     integer;
  v_line_disc    numeric(14,2);
  v_out_lines    jsonb := '[]'::jsonb;
  v_count        integer;
  v_item         record;
  v_shares       numeric[];
  v_base         numeric(14,2);
  v_rem          numeric(14,2);
  v_last_elig    integer;
  v_lines        jsonb;
begin
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_cart_products := array_append(v_cart_products, coalesce(v_line->>'product_id', ''));
    if coalesce(v_line->>'category_id', '') <> '' then
      v_cart_categories := array_append(v_cart_categories, v_line->>'category_id');
    end if;
    if coalesce(v_line->>'variant_id', '') <> '' then
      v_cart_variants := array_append(v_cart_variants, v_line->>'variant_id');
    end if;
  end loop;

  select coalesce(jsonb_agg(
    l.value || jsonb_build_object('line_total',
      round(coalesce((l.value->>'line_total')::numeric,
                     coalesce((l.value->>'unit_price')::numeric, 0)
                     * coalesce((l.value->>'qty')::numeric, 0))::numeric, 2))
  ), '[]'::jsonb) into v_lines
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as l(value);

  -- ── 1. Automatic promotions (mode = 'automatic') ──────────────────────────
  for v_candidate in
    select * from public.promotions
    where enabled
      and (mode = 'automatic' or mode is null)
      and (channel = 'both' or channel = coalesce(p_channel, 'online'))
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at >= now())
      and v_subtotal >= coalesce(minimum_order_amount, 0)
    order by priority desc, created_at
  loop
    if v_candidate.scope = 'category' and not exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = v_candidate.id and t.target_kind = 'category'
        and t.target_id::text = any (v_cart_categories)
    ) then
      continue;
    end if;
    if v_candidate.scope = 'product' and not exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = v_candidate.id and t.target_kind = 'product'
        and t.target_id::text = any (v_cart_products)
    ) then
      continue;
    end if;
    if v_candidate.scope = 'variant' and not exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = v_candidate.id and t.target_kind = 'variant'
        and t.target_id::text = any (v_cart_variants)
    ) then
      continue;
    end if;

    if v_candidate.scope = 'store' then
      v_eligible := v_subtotal;
    else
      v_eligible := 0;
      for v_line in select * from jsonb_array_elements(v_lines)
      loop
        if public.promo_scope_matches(v_candidate.scope, v_candidate.id, v_line) then
          v_eligible := v_eligible + round(coalesce((v_line->>'line_total')::numeric, 0), 2);
        end if;
      end loop;
    end if;

    if v_candidate.discount_type = 'percent' then
      v_discount := round((v_eligible * least(v_candidate.value, 100) / 100)::numeric, 2);
      if v_candidate.maximum_discount_amount is not null then
        v_discount := least(v_discount, round(v_candidate.maximum_discount_amount::numeric, 2));
      end if;
    else
      v_discount := least(round(v_candidate.value::numeric, 2), v_eligible);
    end if;
    v_discount := least(greatest(v_discount, 0), v_subtotal);

    if v_promo.id is null or v_discount > v_auto_discount then
      v_promo := v_candidate;
      v_auto_discount := v_discount;
      v_auto_id := v_candidate.id;
      v_auto_name := coalesce(nullif(v_candidate.name_en, ''), v_candidate.name_ar);
      v_auto_stack := v_candidate.stackable;
    end if;
  end loop;

  -- ── 2. Promo Code / Coupon Mode ───────────────────────────────────────────
  if v_code is not null then
    -- Check promotions table for coupon mode first
    select * into v_coupon_promo from public.promotions
    where mode = 'coupon' and upper(btrim(code)) = v_code;

    if found then
      v_coupon_promo_matched := true;
      if not v_coupon_promo.enabled then
        raise exception 'Coupon % is not valid', v_code using errcode = 'check_violation';
      end if;
      if v_coupon_promo.channel <> 'both' and v_coupon_promo.channel <> coalesce(p_channel, 'online') then
        raise exception 'Coupon % is not valid', v_code using errcode = 'check_violation';
      end if;
      if v_coupon_promo.starts_at is not null and v_coupon_promo.starts_at > now() then
        raise exception 'Coupon % is not active yet', v_code using errcode = 'check_violation';
      end if;
      if v_coupon_promo.ends_at is not null and v_coupon_promo.ends_at < now() then
        raise exception 'Coupon % has expired', v_code using errcode = 'check_violation';
      end if;
      if v_subtotal < v_coupon_promo.minimum_order_amount then
        raise exception 'Coupon % needs a subtotal of at least %', v_code, v_coupon_promo.minimum_order_amount
          using errcode = 'check_violation';
      end if;
      if v_coupon_promo.scope = 'category' and not exists (
        select 1 from public.promotion_targets t
        where t.promotion_id = v_coupon_promo.id and t.target_kind = 'category'
          and t.target_id::text = any (v_cart_categories)
      ) then
        raise exception 'Coupon % does not apply to this cart', v_code using errcode = 'check_violation';
      end if;
      if v_coupon_promo.scope = 'product' and not exists (
        select 1 from public.promotion_targets t
        where t.promotion_id = v_coupon_promo.id and t.target_kind = 'product'
          and t.target_id::text = any (v_cart_products)
      ) then
        raise exception 'Coupon % does not apply to this cart', v_code using errcode = 'check_violation';
      end if;
      if v_coupon_promo.scope = 'variant' and not exists (
        select 1 from public.promotion_targets t
        where t.promotion_id = v_coupon_promo.id and t.target_kind = 'variant'
          and t.target_id::text = any (v_cart_variants)
      ) then
        raise exception 'Coupon % does not apply to this cart', v_code using errcode = 'check_violation';
      end if;

      if v_coupon_promo.scope = 'store' then
        v_eligible := v_subtotal;
      else
        v_eligible := 0;
        for v_line in select * from jsonb_array_elements(v_lines)
        loop
          if public.promo_scope_matches(v_coupon_promo.scope, v_coupon_promo.id, v_line) then
            v_eligible := v_eligible + round(coalesce((v_line->>'line_total')::numeric, 0), 2);
          end if;
        end loop;
      end if;

      if v_coupon_promo.discount_type = 'percent' then
        v_coupon_discount := round((v_eligible * least(v_coupon_promo.value, 100) / 100)::numeric, 2);
        if v_coupon_promo.maximum_discount_amount is not null then
          v_coupon_discount := least(v_coupon_discount, round(v_coupon_promo.maximum_discount_amount::numeric, 2));
        end if;
      else
        v_coupon_discount := least(round(v_coupon_promo.value::numeric, 2), v_eligible);
      end if;
      v_coupon_discount := least(greatest(v_coupon_discount, 0), v_subtotal);
      v_coupon_stack := v_coupon_promo.stackable;

    else
      -- Check legacy coupons table
      if p_lock then
        select * into v_coupon from public.coupons where code = v_code for update;
      else
        select * into v_coupon from public.coupons where code = v_code;
      end if;
      if not found or not v_coupon.active then
        raise exception 'Coupon % is not valid', v_code using errcode = 'check_violation';
      end if;
      if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
        raise exception 'Coupon % is not active yet', v_code using errcode = 'check_violation';
      end if;
      if v_coupon.ends_at is not null and v_coupon.ends_at < now() then
        raise exception 'Coupon % has expired', v_code using errcode = 'check_violation';
      end if;
      if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
        raise exception 'Coupon % has been fully used', v_code using errcode = 'check_violation';
      end if;
      if v_subtotal < v_coupon.min_subtotal then
        raise exception 'Coupon % needs a subtotal of at least %', v_code, v_coupon.min_subtotal
          using errcode = 'check_violation';
      end if;
      if v_coupon.applies_to = 'products' and not exists (
        select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
        where target = any (v_cart_products)
      ) then
        raise exception 'Coupon % does not apply to this cart', v_code
          using errcode = 'check_violation';
      end if;
      if v_coupon.applies_to = 'categories' and not exists (
        select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
        where target = any (v_cart_categories)
      ) then
        raise exception 'Coupon % does not apply to this cart', v_code
          using errcode = 'check_violation';
      end if;
      if p_customer_key is not null and v_coupon.per_customer_limit is not null then
        select count(*) into v_uses
        from public.promo_code_usages u
        join public.online_orders o on o.id = u.order_id
        where u.coupon_id = v_coupon.id and u.customer_key = p_customer_key
          and o.status <> 'cancelled';
        if v_uses >= v_coupon.per_customer_limit then
          raise exception 'Coupon % has reached its usage limit', v_code
            using errcode = 'check_violation';
        end if;
      end if;
      if p_customer_key is not null and v_coupon.first_order_only then
        select count(*) into v_prior_orders
        from public.online_orders o
        where o.status <> 'cancelled'
          and (o.store_customer_id::text = p_customer_key
               or 'phone:' || regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g') = p_customer_key);
        if v_prior_orders > 0 then
          raise exception 'Coupon % is for first orders only', v_code
            using errcode = 'check_violation';
        end if;
      end if;

      v_coupon_stack := v_coupon.stackable;
      if v_coupon.discount_type = 'free_shipping' then
        v_coupon_free_ship := true;
        v_coupon_discount := 0;
      elsif v_coupon.discount_type = 'percent' then
        v_coupon_discount := round((v_subtotal * v_coupon.value / 100)::numeric, 2);
        if v_coupon.max_discount is not null then
          v_coupon_discount := least(v_coupon_discount, v_coupon.max_discount);
        end if;
      else
        v_coupon_discount := least(round(v_coupon.value::numeric, 2), v_subtotal);
      end if;
      v_coupon_discount := least(greatest(v_coupon_discount, 0), v_subtotal);
    end if;
  end if;

  -- ── 3. Stacking: best discount wins unless both are stackable ──────────────
  if v_code is not null and v_auto_id is not null then
    if v_auto_stack and v_coupon_stack then
      v_goods_discount := least(v_auto_discount + v_coupon_discount, v_subtotal);
      v_code_applied := true;
    elsif v_coupon_discount >= v_auto_discount then
      v_auto_discount := 0;
      v_auto_id := null;
      v_auto_name := null;
      v_goods_discount := v_coupon_discount;
      v_code_applied := true;
    else
      v_coupon_discount := 0;
      v_coupon_free_ship := false;
      v_goods_discount := v_auto_discount;
      v_code_applied := false;
    end if;
  elsif v_code is not null then
    v_goods_discount := v_coupon_discount;
    v_code_applied := true;
  else
    v_goods_discount := v_auto_discount;
    v_code_applied := false;
  end if;

  -- ── 4. Delivery fee ───────────────────────────────────────────────────────
  if p_delivery_type = 'pickup' then
    v_gross_fee := 0;
    v_ship_source := 'pickup';
  elsif p_zone is not null then
    v_gross_fee := greatest(round(coalesce((p_zone->>'fee')::numeric, 0), 2), 0);
    v_ship_source := 'zone';
    v_zone_id := nullif(p_zone->>'id', '')::uuid;
    v_zone_name := nullif(p_zone->>'name', '');
    if coalesce((p_zone->>'minimum')::numeric, 0) > 0
       and (v_subtotal - v_goods_discount) < (p_zone->>'minimum')::numeric then
      raise exception 'Delivery orders need at least %', (p_zone->>'minimum')::numeric(14,2)
        using errcode = 'check_violation';
    end if;
    if coalesce((p_zone->>'threshold')::numeric, 0) > 0
       and (v_subtotal - v_goods_discount) >= (p_zone->>'threshold')::numeric then
      v_ship_discount := v_gross_fee;
      v_gross_fee := 0;
    end if;
  else
    v_gross_fee := greatest(round(coalesce((p_legacy->>'fee')::numeric, 0), 2), 0);
    v_ship_source := 'settings';
    if coalesce((p_legacy->>'minimum')::numeric, 0) > 0
       and (v_subtotal - v_goods_discount) < (p_legacy->>'minimum')::numeric then
      raise exception 'Delivery orders need at least %', (p_legacy->>'minimum')::numeric(14,2)
        using errcode = 'check_violation';
    end if;
    if coalesce((p_legacy->>'threshold')::numeric, 0) > 0
       and (v_subtotal - v_goods_discount) >= (p_legacy->>'threshold')::numeric then
      v_ship_discount := v_gross_fee;
      v_gross_fee := 0;
    end if;
  end if;

  if v_coupon_free_ship and p_delivery_type = 'delivery' and v_gross_fee > 0 then
    v_ship_discount := v_ship_discount + v_gross_fee;
    v_gross_fee := 0;
    v_ship_source := v_ship_source || '+promo';
  end if;
  v_net_fee := v_gross_fee;
  v_total := round((v_subtotal - v_goods_discount + v_net_fee)::numeric, 2);

  -- ── 5. Per-line allocation ────────────────────────────────────────────────
  v_count := coalesce(jsonb_array_length(v_lines), 0);
  v_shares := array_fill(0::numeric, array[v_count]);
  if v_auto_discount > 0 and v_auto_id is not null then
    select coalesce(sum(round(coalesce((l.value->>'line_total')::numeric, 0), 2)), 0)
      into v_base
    from jsonb_array_elements(v_lines) as l(value)
    where public.promo_scope_matches(v_promo.scope, v_auto_id, l.value);
    select coalesce(max(o.idx), -1) into v_last_elig
    from (select value, ordinality - 1 as idx
          from jsonb_array_elements(v_lines) with ordinality) o
    where public.promo_scope_matches(v_promo.scope, v_auto_id, o.value);
    v_rem := v_auto_discount;
    for v_item in
      select value, ordinality - 1 as idx
      from jsonb_array_elements(v_lines) with ordinality
    loop
      if not public.promo_scope_matches(v_promo.scope, v_auto_id, v_item.value) then
        continue;
      end if;
      v_line_total := round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
      if v_item.idx = v_last_elig then
        v_share := round(v_rem::numeric, 2);
      elsif v_base > 0 then
        v_share := round((v_auto_discount * v_line_total / v_base)::numeric, 2);
        v_rem := v_rem - v_share;
      else
        v_share := 0;
      end if;
      v_shares[v_item.idx + 1] := v_shares[v_item.idx + 1] + v_share;
    end loop;
  end if;

  if v_code_applied and v_coupon_discount > 0 then
    if v_coupon_promo_matched then
      select coalesce(sum(round(coalesce((l.value->>'line_total')::numeric, 0), 2)), 0)
        into v_base
      from jsonb_array_elements(v_lines) as l(value)
      where public.promo_scope_matches(v_coupon_promo.scope, v_coupon_promo.id, l.value);
      select coalesce(max(o.idx), -1) into v_last_elig
      from (select value, ordinality - 1 as idx
            from jsonb_array_elements(v_lines) with ordinality) o
      where public.promo_scope_matches(v_coupon_promo.scope, v_coupon_promo.id, o.value);
      v_rem := v_coupon_discount;
      for v_item in
        select value, ordinality - 1 as idx
        from jsonb_array_elements(v_lines) with ordinality
      loop
        if not public.promo_scope_matches(v_coupon_promo.scope, v_coupon_promo.id, v_item.value) then
          continue;
        end if;
        v_line_total := round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
        if v_item.idx = v_last_elig then
          v_share := round(v_rem::numeric, 2);
        elsif v_base > 0 then
          v_share := round((v_coupon_discount * v_line_total / v_base)::numeric, 2);
          v_rem := v_rem - v_share;
        else
          v_share := 0;
        end if;
        v_shares[v_item.idx + 1] := v_shares[v_item.idx + 1] + v_share;
      end loop;
    else
      select coalesce(sum(round(coalesce((l.value->>'line_total')::numeric, 0), 2)), 0)
        into v_base
      from jsonb_array_elements(v_lines) as l(value)
      where public.coupon_line_matches(v_coupon.applies_to, v_coupon.target_ids, l.value);
      select coalesce(max(o.idx), -1) into v_last_elig
      from (select value, ordinality - 1 as idx
            from jsonb_array_elements(v_lines) with ordinality) o
      where public.coupon_line_matches(v_coupon.applies_to, v_coupon.target_ids, o.value);
      v_rem := v_coupon_discount;
      for v_item in
        select value, ordinality - 1 as idx
        from jsonb_array_elements(v_lines) with ordinality
      loop
        if not public.coupon_line_matches(v_coupon.applies_to, v_coupon.target_ids, v_item.value) then
          continue;
        end if;
        v_line_total := round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
        if v_item.idx = v_last_elig then
          v_share := round(v_rem::numeric, 2);
        elsif v_base > 0 then
          v_share := round((v_coupon_discount * v_line_total / v_base)::numeric, 2);
          v_rem := v_rem - v_share;
        else
          v_share := 0;
        end if;
        v_shares[v_item.idx + 1] := v_shares[v_item.idx + 1] + v_share;
      end loop;
    end if;
  end if;

  for v_item in
    select value, ordinality - 1 as idx
    from jsonb_array_elements(v_lines) with ordinality
  loop
    v_line_total := round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
    v_line_qty := greatest(coalesce((v_item.value->>'qty')::numeric, 0)::integer, 1);
    v_share := round(greatest(v_shares[v_item.idx + 1], 0)::numeric, 2);
    v_line_disc := round(
      greatest((v_line_total - greatest(v_share, 0)) / v_line_qty, 0)::numeric, 2);
    v_out_lines := v_out_lines || jsonb_build_object(
      'product_id', v_item.value->>'product_id',
      'variant_id', v_item.value->>'variant_id',
      'qty', v_line_qty,
      'unit_price', round(coalesce((v_item.value->>'unit_price')::numeric, 0), 2),
      'line_total', v_line_total,
      'discounted_unit_price', v_line_disc
    );
  end loop;

  return jsonb_build_object(
    'subtotal', v_subtotal,
    'auto_discount', v_auto_discount,
    'auto_promotion_id', v_auto_id,
    'auto_promotion_name', v_auto_name,
    'promo_code', v_code,
    'promo_discount', case when v_code is null then 0 else v_coupon_discount end,
    'promo_free_shipping', v_coupon_free_ship,
    'gross_shipping_fee', v_gross_fee + v_ship_discount,
    'shipping_discount', v_ship_discount,
    'shipping_source', v_ship_source,
    'delivery_fee', v_net_fee,
    'zone_id', v_zone_id,
    'zone_name', v_zone_name,
    'total_discount', v_goods_discount,
    'total', v_total,
    'lines', v_out_lines
  );
end;
$$;

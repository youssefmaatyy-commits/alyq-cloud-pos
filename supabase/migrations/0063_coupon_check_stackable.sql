-- ─────────────────────────────────────────────────────────────────────────────
-- 0063 — `check_storefront_coupon` reports whether the code stacks.
--
-- The storefront cart shows an automatic (codeless) promotion's discount
-- alongside a typed coupon's discount before checkout ever asks the server for
-- the authoritative breakdown. `evaluate_order_pricing` already refuses to
-- stack the two unless BOTH are marked stackable (0050); the cart's own quick,
-- local estimate needs that same flag for the coupon to reproduce the rule
-- instead of guessing. `check_storefront_coupon` priced the coupon but never
-- said whether it stacks, so the browser had no way to know without asking a
-- second, unrelated endpoint. This adds the one missing field — nothing else
-- about the function changes.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.check_storefront_coupon(
  p_code         text,
  p_subtotal     numeric,
  p_product_ids  text[] default '{}',
  p_category_ids text[] default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code       text := nullif(upper(btrim(coalesce(p_code, ''))), '');
  v_coupon     public.coupons%rowtype;
  v_subtotal   numeric(14,2) := round(greatest(coalesce(p_subtotal, 0), 0)::numeric, 2);
  v_discount   numeric(14,2);
  v_applies    boolean;
begin
  if v_code is null then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;

  select * into v_coupon from public.coupons where code = v_code;

  -- One wording for "no such code" and "code switched off": telling them apart
  -- would let a caller probe which codes exist.
  if not found or not v_coupon.active then
    return jsonb_build_object('valid', false, 'reason', 'invalid');
  end if;

  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
    return jsonb_build_object('valid', false, 'reason', 'not_started');
  end if;
  if v_coupon.ends_at is not null and v_coupon.ends_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
    return jsonb_build_object('valid', false, 'reason', 'exhausted');
  end if;
  if v_subtotal < v_coupon.min_subtotal then
    return jsonb_build_object(
      'valid', false, 'reason', 'min_subtotal',
      'min_subtotal', v_coupon.min_subtotal
    );
  end if;

  -- Targeting: a code for certain products or categories only applies when the
  -- cart contains one of them.
  v_applies := true;
  if v_coupon.applies_to = 'products' then
    select exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (coalesce(p_product_ids, '{}'))
    ) into v_applies;
  elsif v_coupon.applies_to = 'categories' then
    select exists (
      select 1 from jsonb_array_elements_text(v_coupon.target_ids) as target
      where target = any (coalesce(p_category_ids, '{}'))
    ) into v_applies;
  end if;

  if not v_applies then
    return jsonb_build_object('valid', false, 'reason', 'not_applicable');
  end if;

  if v_coupon.discount_type = 'percent' then
    v_discount := round((v_subtotal * least(v_coupon.value, 100) / 100)::numeric, 2);
    if v_coupon.max_discount is not null then
      v_discount := least(v_discount, round(v_coupon.max_discount::numeric, 2));
    end if;
  else
    v_discount := round(v_coupon.value::numeric, 2);
  end if;
  v_discount := least(greatest(v_discount, 0), v_subtotal);

  -- The amount is advisory: `place_online_order` recomputes it server-side from
  -- the catalogue, so a customer who edits their cart after checking a code
  -- cannot check out on the old number.
  return jsonb_build_object(
    'valid', true,
    'code', v_coupon.code,
    'discount', v_discount,
    'discount_type', v_coupon.discount_type::text,
    'value', v_coupon.value,
    'stackable', v_coupon.stackable
  );
end;
$$;

comment on function public.check_storefront_coupon(text, numeric, text[], text[]) is
  'Advisory coupon check for the storefront: does this code work on this cart, and what is it worth (including whether it stacks with an automatic promotion)? Never trusted at placement.';

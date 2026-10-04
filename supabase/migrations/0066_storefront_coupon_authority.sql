-- ─────────────────────────────────────────────────────────────────────────────
-- 0066 — storefront coupon validation calls the pricing authority
--
-- The old advisory RPC read only `coupons`; Admin's current Coupons mode writes
-- `promotions(mode='coupon')`. This wrapper deliberately does not duplicate
-- eligibility logic. It calls `preview_storefront_pricing`, which calls the
-- same core as placement, then returns a small stable validation shape for the
-- cart. Legacy coupons remain supported as the pricing core's fallback.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.check_storefront_coupon_pricing(
  p_code text,
  p_lines jsonb,
  p_customer_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code text := nullif(upper(regexp_replace(btrim(coalesce(p_code, '')), '\s+', '', 'g')), '');
  v_pricing jsonb;
  v_message text;
  v_reason text := 'invalid';
  v_discount_type text := 'percent';
  v_value numeric := 0;
  v_minimum numeric := null;
  v_stackable boolean := false;
begin
  if v_code is null then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;

  -- Pickup intentionally avoids a delivery-zone/address refusal while retaining
  -- the exact catalogue, campaign, target, scope, channel, date, usage and
  -- stacking checks performed by the order pricing core.
  v_pricing := public.preview_storefront_pricing(
    coalesce(p_lines, '[]'::jsonb), v_code, null, p_customer_key, 'pickup'
  );

  select p.discount_type::text, p.value, p.minimum_order_amount, p.stackable
    into v_discount_type, v_value, v_minimum, v_stackable
    from public.promotions p
   where p.mode = 'coupon'
     and upper(regexp_replace(btrim(p.code), '\s+', '', 'g')) = v_code
   limit 1;
  if not found then
    select c.discount_type::text, c.value, c.min_subtotal, c.stackable
      into v_discount_type, v_value, v_minimum, v_stackable
      from public.coupons c
     where c.code = v_code
     limit 1;
  end if;

  return jsonb_build_object(
    'valid', true,
    'code', v_code,
    'discount', coalesce((v_pricing->>'promo_discount')::numeric, 0),
    'discount_type', coalesce(v_discount_type, 'percent'),
    'value', coalesce(v_value, 0),
    'min_subtotal', v_minimum,
    'stackable', coalesce(v_stackable, false),
    'free_shipping', coalesce((v_pricing->>'promo_free_shipping')::boolean, false)
  );
exception when check_violation then
  get stacked diagnostics v_message = message_text;
  -- Preserve a useful reason without exposing whether a disabled code exists.
  v_reason := case
    when v_message ilike '%active yet%' then 'not_started'
    when v_message ilike '%has expired%' then 'expired'
    when v_message ilike '%fully used%' then 'exhausted'
    when v_message ilike '%usage limit%' then 'limit_reached'
    when v_message ilike '%needs a subtotal%' then 'min_subtotal'
    when v_message ilike '%does not apply%' or v_message ilike '%channel%' then 'not_applicable'
    when v_message ilike '%not valid%' then 'invalid'
    else 'invalid'
  end;

  -- Minimum is advisory UI detail only, and is safe to read from either source.
  select p.minimum_order_amount into v_minimum
    from public.promotions p
   where p.mode = 'coupon'
     and upper(regexp_replace(btrim(p.code), '\s+', '', 'g')) = v_code
   limit 1;
  if not found then
    select c.min_subtotal into v_minimum from public.coupons c where c.code = v_code limit 1;
  end if;
  return jsonb_build_object('valid', false, 'reason', v_reason, 'min_subtotal', v_minimum);
end;
$$;

grant execute on function public.check_storefront_coupon_pricing(text, jsonb, text)
  to anon, authenticated;

comment on function public.check_storefront_coupon_pricing(text, jsonb, text) is
  'Storefront advisory coupon checker. Delegates to preview_storefront_pricing/evaluate_order_pricing so central promotion coupons and legacy coupons have one eligibility and pricing source.';

commit;

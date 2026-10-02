-- ─────────────────────────────────────────────────────────────────────────────
-- 0068 — authoritative POS coupon preview
--
-- The till needs an immediate, scan-friendly answer before it opens payment,
-- but browser prices cannot decide financial facts. This read-only wrapper
-- rebuilds POS lines from the live product/variant shelves and delegates to
-- the one pricing evaluator used by pos_complete_sale. Completion evaluates it
-- again under lock and is the final authority.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.preview_pos_coupon_pricing(
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
  v_line jsonb;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_variant_id uuid;
  v_qty integer;
  v_unit numeric(14,2);
  v_subtotal numeric(14,2) := 0;
  v_priced_lines jsonb := '[]'::jsonb;
  v_pricing jsonb;
  v_message text;
  v_reason text := 'invalid';
begin
  if not public.can('sell') then
    raise exception 'Not permitted to preview POS pricing' using errcode = 'insufficient_privilege';
  end if;
  if v_code is null then
    return jsonb_build_object('valid', false, 'reason', 'not_found', 'message', 'Coupon code is required');
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_qty := coalesce((v_line->>'qty')::integer, 0);
    if v_qty <= 0 then
      raise exception 'A sale line must have a positive quantity' using errcode = 'check_violation';
    end if;
    select * into v_product from public.products where id = nullif(v_line->>'product_id', '')::uuid;
    if not found or not v_product.active then
      raise exception 'A product is no longer available' using errcode = 'check_violation';
    end if;

    v_variant_id := nullif(v_line->>'variant_id', '')::uuid;
    if v_product.variants_enabled then
      if v_variant_id is null then
        raise exception 'Choose an active product variant' using errcode = 'check_violation';
      end if;
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id;
      if not found or not v_variant.active then
        raise exception 'The selected variant is no longer available' using errcode = 'check_violation';
      end if;
      v_unit := coalesce(v_variant.price_override, v_product.selling_price);
    elsif v_variant_id is not null then
      raise exception 'This product is not sold by variant' using errcode = 'check_violation';
    else
      v_unit := v_product.selling_price;
    end if;

    v_subtotal := v_subtotal + round(v_unit * v_qty, 2);
    v_priced_lines := v_priced_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id::text,
      'category_id', v_product.category_id::text,
      'variant_id', case when v_variant_id is null then null else v_variant_id::text end,
      'qty', v_qty,
      'unit_price', v_unit
    ));
  end loop;

  v_pricing := public.evaluate_order_pricing_channel(
    v_subtotal, v_priced_lines, v_code, p_customer_key,
    '{}'::jsonb, '{}'::jsonb, 'pickup', false, 'pos'
  );

  return jsonb_build_object(
    'valid', true,
    'code', v_code,
    'subtotal', v_subtotal,
    'automatic_discount', coalesce((v_pricing->>'auto_discount')::numeric, 0),
    'coupon_discount', coalesce((v_pricing->>'promo_discount')::numeric, 0),
    'total_discount', coalesce((v_pricing->>'total_discount')::numeric, 0),
    'total', coalesce((v_pricing->>'total')::numeric, v_subtotal),
    'stacked', coalesce((v_pricing->>'auto_discount')::numeric, 0) > 0
      and coalesce((v_pricing->>'promo_discount')::numeric, 0) > 0,
    -- Kept nested so clients can render an exact server preview without ever
    -- accepting prices from browser lines. 0069 uses these allocations for
    -- manual-discount stacking display.
    'pricing', v_pricing
  );
exception when check_violation then
  get stacked diagnostics v_message = message_text;
  v_reason := case
    when v_message ilike '%active yet%' then 'not_started'
    when v_message ilike '%has expired%' then 'expired'
    when v_message ilike '%fully used%' then 'exhausted'
    when v_message ilike '%usage limit%' then 'limit_reached'
    when v_message ilike '%needs a subtotal%' then 'min_subtotal'
    when v_message ilike '%does not apply%' or v_message ilike '%channel%' then 'not_applicable'
    when v_message ilike '%no longer available%' or v_message ilike '%variant%' then 'not_applicable'
    else 'invalid'
  end;
  return jsonb_build_object('valid', false, 'reason', v_reason, 'message', v_message);
end;
$$;

grant execute on function public.preview_pos_coupon_pricing(text, jsonb, text) to authenticated;

comment on function public.preview_pos_coupon_pricing(text, jsonb, text) is
  'Read-only, catalog-authoritative POS coupon preview. It never consumes a coupon; pos_complete_sale repeats pricing and consumption transactionally.';

commit;

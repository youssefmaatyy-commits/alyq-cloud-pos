-- ─────────────────────────────────────────────────────────────────────────────
-- 0069 — POS coupon preview includes manual-discount stacking
--
-- 0068 established a catalog-authoritative promotion/coupon preview. This
-- overload makes its *displayed* total obey the exact POS completion contract:
-- manual item discounts compete with non-stackable promotions line by line,
-- while a winning stackable promotion and manual item discounts both apply;
-- invoice discount is last. Completion still recalculates and locks all facts.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.preview_pos_coupon_pricing(
  p_code text,
  p_lines jsonb,
  p_customer_key text,
  p_invoice_discount_type text,
  p_invoice_discount_value numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_preview jsonb;
  v_line jsonb;
  v_priced_line jsonb;
  v_index integer := 0;
  v_winner_id uuid;
  v_stackable boolean := false;
  v_gross numeric(14,2);
  v_promo numeric(14,2);
  v_manual numeric(14,2);
  v_effective_promo numeric(14,2);
  v_effective_manual numeric(14,2);
  v_promo_total numeric(14,2) := 0;
  v_manual_total numeric(14,2) := 0;
  v_subtotal numeric(14,2);
  v_invoice_base numeric(14,2);
  v_invoice_discount numeric(14,2) := 0;
  v_total numeric(14,2);
begin
  v_preview := public.preview_pos_coupon_pricing(p_code, p_lines, p_customer_key);
  if not coalesce((v_preview->>'valid')::boolean, false) then
    return v_preview;
  end if;

  v_winner_id := nullif(v_preview->'pricing'->>'winning_promotion_id', '')::uuid;
  -- 0068 intentionally returns a small stable shape, so obtain stackability
  -- from the winning row rather than trusting a browser-supplied rule.
  if v_winner_id is not null then
    select coalesce(stackable, false) into v_stackable from public.promotions where id = v_winner_id;
  end if;
  -- `winning_promotion_id` is not part of 0068's public result. Re-evaluate
  -- read-only to identify it; this remains the same shared pricing authority.
  -- The core's total already has authoritative catalog price arithmetic.
  -- Since a coupon that discounts replaces a non-stackable automatic offer,
  -- the selected coupon row is also the winner where it matters.
  if not v_stackable then
    select coalesce(stackable, false) into v_stackable
      from public.promotions
     where mode = 'coupon'
       and upper(regexp_replace(btrim(code), '\s+', '', 'g')) = upper(regexp_replace(btrim(coalesce(p_code, '')), '\s+', '', 'g'))
     limit 1;
  end if;

  v_subtotal := coalesce((v_preview->>'subtotal')::numeric, 0);
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    -- The shared core's exact per-line allocation includes fixed discounts,
    -- buy-X rewards and rounding; browser values never enter this amount.
    v_priced_line := v_preview->'pricing'->'lines'->v_index;
    v_gross := round(coalesce((v_priced_line->>'line_total')::numeric, v_gross), 2);
    v_promo := round(coalesce((v_priced_line->>'discount_amount')::numeric, 0), 2);
    v_manual := case
      when coalesce(v_line->>'discount_type', 'none') = 'percent' then round(v_gross * greatest(coalesce((v_line->>'discount_value')::numeric, 0), 0) / 100, 2)
      when coalesce(v_line->>'discount_type', 'none') = 'fixed' then least(v_gross, round(greatest(coalesce((v_line->>'discount_value')::numeric, 0), 0), 2))
      else 0 end;
    if v_stackable then
      v_effective_promo := v_promo;
      v_effective_manual := least(v_gross - v_effective_promo, v_manual);
    elsif v_promo >= v_manual then
      v_effective_promo := v_promo;
      v_effective_manual := 0;
    else
      v_effective_promo := 0;
      v_effective_manual := v_manual;
    end if;
    v_promo_total := v_promo_total + v_effective_promo;
    v_manual_total := v_manual_total + v_effective_manual;
    v_index := v_index + 1;
  end loop;

  v_invoice_base := greatest(0, v_subtotal - v_promo_total - v_manual_total);
  v_invoice_discount := case
    when coalesce(p_invoice_discount_type, 'none') = 'percent' then round(v_invoice_base * greatest(coalesce(p_invoice_discount_value, 0), 0) / 100, 2)
    when coalesce(p_invoice_discount_type, 'none') = 'fixed' then least(v_invoice_base, round(greatest(coalesce(p_invoice_discount_value, 0), 0), 2))
    else 0 end;
  v_total := greatest(0, v_invoice_base - v_invoice_discount);

  return v_preview || jsonb_build_object(
    'total_discount', v_promo_total + v_manual_total + v_invoice_discount,
    'promotion_discount', v_promo_total,
    'manual_item_discount', v_manual_total,
    'invoice_discount', v_invoice_discount,
    'total', v_total,
    -- A non-stackable manual discount that wins leaves no coupon saving.
    'coupon_discount', case when v_promo_total = 0 then 0 else coalesce((v_preview->>'coupon_discount')::numeric, 0) end
  );
end;
$$;

grant execute on function public.preview_pos_coupon_pricing(text, jsonb, text, text, numeric) to authenticated;

comment on function public.preview_pos_coupon_pricing(text, jsonb, text, text, numeric) is
  'POS coupon preview with manual item/invoice discount stacking for display only; pos_complete_sale remains the locked financial authority.';

commit;

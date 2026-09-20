-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — Storefront read privileges, and closing the coupon window.
--
-- Two things this migration fixes, both discovered by writing the repositories
-- that actually use the schema:
--
-- 1. **Grants.** Supabase stopped granting privileges on new `public` tables by
--    default, so a row-level policy alone is not enough: without `grant select`
--    the door is locked before the policy is ever consulted. Migration 0017
--    wrote the policies and no grants, which meant the storefront could read
--    nothing. Every table the repositories touch is granted here, with the
--    narrowest privilege that matches its policies — `select` where the screen
--    only reads, and no `delete` on the settings singleton.
--
-- 2. **Coupons were public.** 0017 gave `anon` a `using (true)` select policy on
--    `coupons`, on the reasoning that checkout needs to validate a code. It does
--    not: validation happens inside `place_online_order`, which is
--    `security definer` and needs no policy at all. What the old policy actually
--    did was hand any visitor the shop's complete discount-code list, including
--    usage limits and windows — one `select * from coupons` and every promotion
--    is public. Codes are now staff-only, and the storefront asks a new function
--    about the one code a customer typed.
--
-- The replacement, `public.check_storefront_coupon`, answers "does this code
-- work on this cart, and what is it worth?" and nothing else. It cannot be used
-- to enumerate codes: it reports one code at a time, and only a code the caller
-- already has. That is the same information a printed flyer gives, and it is
-- what a checkout form needs to show "−50 EGP" before the order is placed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. coupons are staff data ─────────────────────────────────────────────
drop policy if exists "coupons_select_public" on public.coupons;
drop policy if exists "coupons_select_staff" on public.coupons;

create policy "coupons_select_staff"
  on public.coupons for select to authenticated
  using (public.can('manage_website') or public.can('manage_online_orders'));

comment on table public.coupons is
  'Discount codes for the storefront. Readable by staff only — a public read would publish every code; the storefront validates a typed code through public.check_storefront_coupon() instead. `used_count` is incremented when an order is PLACED and decremented again if that order is cancelled, so one customer cannot hold the last use of a code across several pending orders.';

-- ── 2. does this code work on this cart? ──────────────────────────────────
/*
 * check_storefront_coupon:
 *
 * p_subtotal MUST be the post-campaign subtotal (sum of line totals after
 * campaign discounts). The coupon minimum is assessed against this live
 * subtotal, matching evaluate_order_pricing.
 */
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
    'value', v_coupon.value
  );
end;
$$;

grant execute on function public.check_storefront_coupon(text, numeric, text[], text[])
  to anon, authenticated;

comment on function public.check_storefront_coupon(text, numeric, text[], text[]) is
  'Storefront coupon check: does this code apply to this cart, and what is it worth? Reveals nothing about codes the caller does not already have.';

-- ── 3. table privileges ───────────────────────────────────────────────────
-- Staff reads are governed by the policies in 0017; these grants are what let
-- the policy be consulted at all. Writes go through the RPCs in 0018, so the
-- only direct writes are the admin screens for content and marketing.

-- Storefront appearance: everyone reads it, only manage_website writes it, and
-- the singleton is never deleted.
grant select on public.website_settings to anon, authenticated;
grant insert, update on public.website_settings to authenticated;

-- Product slugs, brands and SEO: public reads (the storefront renders them).
grant select on public.product_content to anon, authenticated;
grant insert, update, delete on public.product_content to authenticated;

-- Homepage content.
grant select on public.store_faqs to anon, authenticated;
grant insert, update, delete on public.store_faqs to authenticated;
grant select on public.store_reviews to anon, authenticated;
grant insert, update, delete on public.store_reviews to authenticated;

-- Campaigns are public by design: a flash sale is an advertisement.
grant select on public.campaigns to anon, authenticated;
grant insert, update, delete on public.campaigns to authenticated;

-- Coupons: staff only (see the policy above).
grant select, insert, update, delete on public.coupons to authenticated;

-- Orders: staff reads under the manage_online_orders policy; inserts and status
-- changes happen only through the 0018 functions, so no direct write privilege
-- is granted here.
grant select on public.online_orders to authenticated;
grant select on public.online_order_items to authenticated;
grant select on public.order_events to authenticated;
grant select on public.stock_reservations to authenticated;

-- Website accounts. The rows are keyed by auth uid; the local-account design in
-- `localAccounts.ts` means the storefront does not write here yet, and staff
-- reads stay behind the self-or-staff policy.
grant select, insert, update on public.store_customers to authenticated;

-- The order-number sequence is consumed inside `place_online_order`, which is
-- `security definer`, so no grant is needed for callers.

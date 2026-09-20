-- ═══════════════════════════════════════════════════════════════════════════
-- 0050 — PROMOTIONS: AUTOMATIC DISCOUNTS + RICH PROMO CODES
-- ═══════════════════════════════════════════════════════════════════════════
-- The website had coupons (codes with percent/fixed, min, cap, window, usage
-- limit, product/category targeting) but no COMPLETE discount engine: no
-- automatic (codeless) discounts, no storewide sale, no per-customer limits,
-- no first-order-only, no free-shipping codes, no variant targeting, no
-- stacking rules, no usable history. This file completes it — by EXTENDING the
-- working coupon model, not by replacing it:
--
--   · `coupons` gains titles, per-customer limits, first-order-only and
--     stackable, and its `discount_type` admits the `'free_shipping'` value
--     0049 added to the enum (ordering rule: added there, used here).
--   · `promotions` are automatic discounts (no code): store / category /
--     product / variant scope, min order, max cap, window, priority,
--     stackable — including the "15% off everything" storewide sale.
--   · `promotion_targets` is the relational targeting both tables share in
--     spirit (coupons keep their `target_ids` jsonb for compatibility; new
--     targeting is rows, never free text).
--   · `promo_code_usages` records every code application per order per
--     customer, so per-customer limits and first-order-only survive
--     cancellation (cancelled orders are excluded by join, not deleted).
--
-- PRICE AUTHORITY stays where it was: `place_online_order` (re-stated here)
-- computes subtotal, automatic discount, promo discount, delivery fee and
-- total from the catalogue and these tables. The browser sends product ids,
-- quantities, a code and a zone — never money. The shared core
-- `evaluate_order_pricing()` is what both the order path and the advisory
-- preview call, so the checkout preview and the charged total are the same
-- arithmetic by construction.
--
-- Stacking, stated once: the best applicable automatic discount and the promo
-- code combine ONLY when both are marked stackable; otherwise the single
-- larger discount wins. Nothing compounds infinitely.
--
-- Returns reconcile through the snapshot: every order line carries its
-- discounted unit price, and `pos_process_return` (re-stated here) refunds an
-- online-origin sale at those prices instead of the invoice's list prices.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. coupons grow up (existing rows untouched) ───────────────────────────
alter table public.coupons
  add column if not exists title_en text not null default '',
  add column if not exists title_ar text not null default '',
  add column if not exists description_en text,
  add column if not exists description_ar text,
  add column if not exists per_customer_limit integer
    constraint coupons_per_customer_positive
    check (per_customer_limit is null or per_customer_limit > 0),
  add column if not exists first_order_only boolean not null default false,
  add column if not exists stackable boolean not null default false;

-- The type already admits 'free_shipping' (0049); the table check predates it.
alter table public.coupons drop constraint if exists coupons_discount_type_check;
alter table public.coupons add constraint coupons_discount_type_check
  check (discount_type::text in ('percent', 'fixed', 'free_shipping'));

comment on column public.coupons.stackable is
  'Whether this code may combine with the automatic promotion. Both sides must agree; otherwise the larger discount wins alone.';
comment on column public.coupons.first_order_only is
  'When true, only customers with no prior non-cancelled order may use it.';

-- ── 2. automatic promotions ────────────────────────────────────────────────
create table if not exists public.promotions (
  id                      uuid primary key default gen_random_uuid(),
  enabled                 boolean not null default true,
  name_en                 text not null
    constraint promotions_name_en_not_blank check (btrim(name_en) <> ''),
  name_ar                 text not null
    constraint promotions_name_ar_not_blank check (btrim(name_ar) <> ''),
  description_en          text,
  description_ar          text,
  discount_type           text not null default 'percent'
    constraint promotions_type_valid check (discount_type in ('percent', 'fixed')),
  value                   numeric(14, 2) not null check (value > 0),
  -- What it applies to. 'store' needs no target rows; the rest read
  -- `promotion_targets`. A category scope matches lines whose product sits in
  -- a targeted category; 'variant' matches exact combination ids.
  scope                   text not null default 'store'
    constraint promotions_scope_valid check (scope in ('store', 'category', 'product', 'variant')),
  minimum_order_amount    numeric(14, 2) not null default 0
    constraint promotions_minimum_non_negative check (minimum_order_amount >= 0),
  -- Optional cap (percent promotions only, like coupons): null = uncapped.
  maximum_discount_amount numeric(14, 2)
    constraint promotions_max_positive
    check (maximum_discount_amount is null or maximum_discount_amount > 0),
  starts_at               timestamptz,
  ends_at                 timestamptz,
  -- Higher wins when several apply; ties break toward the larger discount.
  priority                integer not null default 0,
  stackable               boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint promotions_window_ordered
    check (starts_at is null or ends_at is null or starts_at <= ends_at),
  constraint promotions_percent_at_most_100
    check (discount_type <> 'percent' or value <= 100)
);

comment on table public.promotions is
  'Automatic (codeless) discounts: the storewide sale, category offers, product and variant offers. The best applicable one is chosen per order by priority then size; it combines with a promo code only when both are stackable.';

create index if not exists promotions_enabled_window_idx
  on public.promotions (enabled, starts_at, ends_at);

drop trigger if exists promotions_touch_updated_at
  on public.promotions;
create trigger promotions_touch_updated_at
  before update on public.promotions
  for each row execute function public.set_updated_at();

alter table public.promotions enable row level security;

-- The storefront shows struck-through prices only for real, current
-- promotions, so it reads them like campaigns: publicly.
drop policy if exists "promotions_select_public"
  on public.promotions;
create policy "promotions_select_public"
  on public.promotions for select
  to anon, authenticated
  using (true);

drop policy if exists "promotions_write_managers"
  on public.promotions;
create policy "promotions_write_managers"
  on public.promotions for all
  to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

revoke all on public.promotions from public, anon;
grant select on public.promotions to anon, authenticated, service_role;
grant insert, update, delete on public.promotions to authenticated, service_role;

create table if not exists public.promotion_targets (
  promotion_id uuid not null references public.promotions (id) on delete cascade,
  -- 'category' | 'product' | 'variant'. Bogus ids simply never match a cart;
  -- the checkout re-validates every target against the catalogue.
  target_kind  text not null check (target_kind in ('category', 'product', 'variant')),
  target_id    uuid not null,
  created_at   timestamptz not null default now(),
  constraint promotion_targets_pkey primary key (promotion_id, target_kind, target_id)
);

comment on table public.promotion_targets is
  'Relational targeting for automatic promotions: which categories, products or exact variants an offer covers. No free-text id lists.';

alter table public.promotion_targets enable row level security;

drop policy if exists "promotion_targets_select_public"
  on public.promotion_targets;
create policy "promotion_targets_select_public"
  on public.promotion_targets for select
  to anon, authenticated
  using (true);

drop policy if exists "promotion_targets_write_managers"
  on public.promotion_targets;
create policy "promotion_targets_write_managers"
  on public.promotion_targets for all
  to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

revoke all on public.promotion_targets from public, anon;
grant select on public.promotion_targets to anon, authenticated, service_role;
grant insert, update, delete on public.promotion_targets to authenticated, service_role;

-- ── 3. promo-code usage history (per-customer limits + first-order-only) ────
create table if not exists public.promo_code_usages (
  id            uuid primary key default gen_random_uuid(),
  coupon_id     uuid not null references public.coupons (id) on delete cascade,
  order_id      uuid not null references public.online_orders (id) on delete cascade,
  -- store_customer_id when signed in, else 'phone:' + digits. One row per
  -- (code, order): re-placing the same order never double-counts, and
  -- cancelled orders are excluded by join rather than deleted, so the history
  -- stays the history.
  customer_key  text not null
    constraint promo_code_usages_customer_not_blank check (btrim(customer_key) <> ''),
  used_at       timestamptz not null default now(),
  constraint promo_code_usages_one_row_per_order unique (coupon_id, order_id)
);

comment on table public.promo_code_usages is
  'Every promo-code application, per order per customer. Feeds per-customer limits and first-order-only; staff-only, like the codes themselves.';

create index if not exists promo_code_usages_coupon_customer_idx
  on public.promo_code_usages (coupon_id, customer_key);

alter table public.promo_code_usages enable row level security;

drop policy if exists "promo_code_usages_select_staff"
  on public.promo_code_usages;
create policy "promo_code_usages_select_staff"
  on public.promo_code_usages for select
  to authenticated
  using (public.can('manage_website') or public.can('manage_online_orders'));

-- Writes happen inside place_online_order (definer); no direct writes.
revoke all on public.promo_code_usages from public, anon;
grant select on public.promo_code_usages to authenticated, service_role;

-- ── 4. order snapshots (history that later edits cannot rewrite) ────────────
alter table public.online_orders
  add column if not exists promotion_id uuid references public.promotions (id) on delete set null,
  add column if not exists price_snapshot jsonb not null default '{}'::jsonb;

comment on column public.online_orders.price_snapshot is
  'What the customer actually paid and why: promo code, promotion id, discount type/amounts, original and final subtotals, gross and net shipping, per-line discounted prices. Written once at placement; changing a promotion later never rewrites it.';

alter table public.online_order_items
  add column if not exists discounted_unit_price numeric(14, 2)
    constraint online_order_items_discounted_non_negative
    check (discounted_unit_price is null or discounted_unit_price >= 0);

comment on column public.online_order_items.discounted_unit_price is
  'The per-unit price actually paid after every order-level discount, allocated proportionally across lines. Returns refund this, never the list price.';

-- ── 5. the shared pricing core (pure reads; the one arithmetic) ─────────────
-- `place_online_order` and `preview_storefront_pricing` both call this, so the
-- checkout preview and the charged total are the same computation. It writes
-- nothing — usage accounting happens in the order path after it answers.
--
-- Inputs: the campaign-adjusted goods subtotal, the priced lines
-- [{product_id, category_id, variant_id, qty, unit_price, line_total}], the
-- typed promo code (or null), the customer key (store id, else phone digits),
-- the resolved zone {id, fee, minimum, threshold} (or null for the legacy
-- settings path), the legacy settings {fee, minimum, threshold}, and the
-- fulfilment type. `p_lock` takes the coupon row lock for the placement path
-- (serialising concurrent checkouts against the usage limit); the preview
-- passes false.

-- True when a priced line falls in a promotion's scope. One definition for
-- the selection below and the per-line allocation after it, so a line the
-- discount was measured on is a line the discount lands on.
create or replace function public.promo_scope_matches(
  p_scope text, p_promo_id uuid, p_line jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_scope = 'store'
    or (p_scope = 'category' and exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = p_promo_id and t.target_kind = 'category'
        and t.target_id::text = coalesce(p_line->>'category_id', '')))
    or (p_scope = 'product' and exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = p_promo_id and t.target_kind = 'product'
        and t.target_id::text = coalesce(p_line->>'product_id', '')))
    or (p_scope = 'variant' and exists (
      select 1 from public.promotion_targets t
      where t.promotion_id = p_promo_id and t.target_kind = 'variant'
        and t.target_id::text = coalesce(p_line->>'variant_id', '')))
$$;

comment on function public.promo_scope_matches(text, uuid, jsonb) is
  'Whether a priced line falls in a promotion scope. Shared by the offer selection and the per-line allocation so the two can never disagree.';

-- True when a priced line falls in a coupon's targeting. Same sharing rule.
-- `p_applies_to` is the `coupon_target` enum itself: declaring it `text`
-- would refuse the call (no implicit enum→text cast in overload resolution).
create or replace function public.coupon_line_matches(
  p_applies_to public.coupon_target, p_target_ids jsonb, p_line jsonb
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_applies_to = 'all'
    or (p_applies_to = 'products' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_target_ids, '[]'::jsonb)) as target
      where target = coalesce(p_line->>'product_id', '')))
    or (p_applies_to = 'categories' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_target_ids, '[]'::jsonb)) as target
      where target = coalesce(p_line->>'category_id', '')))
$$;

comment on function public.coupon_line_matches(public.coupon_target, jsonb, jsonb) is
  'Whether a priced line falls in a coupon targeting. Shared by validation and allocation.';
create or replace function public.evaluate_order_pricing(
  p_subtotal      numeric,
  p_lines         jsonb,
  p_promo_code    text,
  p_customer_key  text,
  p_zone          jsonb,
  p_legacy        jsonb,
  p_delivery_type text,
  p_lock          boolean default false
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

  -- Normalized exactly like the TypeScript `normalizeCouponCode`: uppercase,
  -- trimmed, inner whitespace removed — so "alyq10", "ALYQ10" and "AlYq 10"
  -- are the same code in both modes. Stored codes are normalized on save, so
  -- no stored code ever carries whitespace to mismatch against.
  v_code         text := nullif(upper(regexp_replace(btrim(coalesce(p_promo_code, '')), '\s+', '', 'g')), '');
  v_coupon       public.coupons%rowtype;
  v_coupon_discount numeric(14,2) := 0;
  v_coupon_free_ship boolean := false;
  v_coupon_stack boolean := false;
  v_code_applied boolean := false;
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
  -- The priced lines, with `line_total` derived once here: callers pass
  -- unit_price × qty, and every downstream sum (eligibility, allocation, the
  -- snapshot) must read the number the snapshot loop will write — not a key
  -- the caller may or may not have included.
  v_lines        jsonb;
begin
  -- What is in the cart, so scoped offers check the real contents.
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

  -- ── automatic promotion: highest priority wins, ties break to the larger
  --    discount. Only enabled, open-window offers whose minimum the goods
  --    total meets; targeted scopes must match the cart.
  for v_candidate in
    select * from public.promotions
    where enabled
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

    -- Eligible base: the whole goods total for store scope, the matching
    -- lines' totals otherwise (same match the allocation uses below, so a
    -- line the discount was measured on is a line it lands on). A fixed
    -- offer never exceeds its base.
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

    -- First candidate sets the bar (priority order); a later one takes it
    -- only by being strictly larger — ties keep the earlier (higher-priority,
    -- older) row. Deterministic, no compounding.
    if v_promo.id is null or v_discount > v_auto_discount then
      v_promo := v_candidate;
      v_auto_discount := v_discount;
      v_auto_id := v_candidate.id;
      v_auto_name := coalesce(nullif(v_candidate.name_en, ''), v_candidate.name_ar);
      v_auto_stack := v_candidate.stackable;
    end if;
  end loop;

  -- ── promo code: the extended coupon rules ─────────────────────────────────
  if v_code is not null then
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
    -- Per-customer and first-order rules ride the usage history. Cancelled
    -- orders are excluded by join, so a cancelled order neither consumes a
    -- personal use nor counts as a first order.
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

  -- ── stacking: both only when both agree, else the larger alone ────────────
  -- `v_code_applied` decides the usage accounting downstream: a code that lost
  -- the contest consumes nothing.
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

  -- ── delivery fee: the zone's numbers, or the legacy settings', never the
  --    browser's. Pickup is always free and never gated by a minimum.
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

  -- A winning free-shipping code waives whatever fee survived above.
  if v_coupon_free_ship and p_delivery_type = 'delivery' and v_gross_fee > 0 then
    v_ship_discount := v_ship_discount + v_gross_fee;
    v_gross_fee := 0;
    v_ship_source := v_ship_source || '+promo';
  end if;
  v_net_fee := v_gross_fee;
  v_total := round((v_subtotal - v_goods_discount + v_net_fee)::numeric, 2);

  -- ── per-line allocation: each discount spreads over ITS eligible lines ───
  -- A category offer on the ring must not take a piastre off the necklace:
  -- the eligible lines share their discount proportionally, the rest keep
  -- their price. Each discount spreads with the last eligible line taking the
  -- remainder, so both shares sum exactly; the line's total share is what its
  -- units actually cost — and what a return refunds.
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
  for v_item in
    select value, ordinality - 1 as idx
    from jsonb_array_elements(v_lines) with ordinality
  loop
    v_line_total := round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
    v_line_qty := greatest(coalesce((v_item.value->>'qty')::numeric, 0)::integer, 1);
    v_share := round(greatest(v_shares[v_item.idx + 1], 0)::numeric, 2);
    v_line_disc := round(
      greatest((v_line_total - v_share) / v_line_qty, 0)::numeric, 2);
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

comment on function public.evaluate_order_pricing(numeric, jsonb, text, text, jsonb, jsonb, text, boolean) is
  'The one pricing arithmetic: automatic promotion, promo code, stacking, delivery fee and per-line allocation. Read-only; place_online_order and the advisory preview both call it.';

-- ── 6. the advisory preview (what the checkout shows before placing) ───────
-- Prices the lines from the catalogue exactly the way the order path does,
-- then answers through the core. STABLE and side-effect free: checking a code
-- never consumes a use, and a customer who edits their cart re-checks on the
-- new contents because nothing is stored.
create or replace function public.preview_storefront_pricing(
  p_lines         jsonb,
  p_promo_code    text default null,
  p_zone_id       uuid default null,
  p_customer_key  text default null,
  p_delivery_type text default 'delivery'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_line        jsonb;
  v_product     public.products%rowtype;
  v_variant     public.product_variants%rowtype;
  v_variant_id  uuid;
  v_settings    jsonb;
  v_zone        public.delivery_zones%rowtype;
  v_zone_json   jsonb := null;
  v_legacy      jsonb;
  v_qty         integer;
  v_unit        numeric(14,2);
  v_campaign    public.campaigns%rowtype;
  v_priced      jsonb := '[]'::jsonb;
  v_customer_key text := nullif(btrim(coalesce(p_customer_key, '')), '');
begin
  select settings into v_settings from public.website_settings where id = 1;
  v_settings := coalesce(v_settings, '{}'::jsonb);

  if p_zone_id is not null then
    select * into v_zone from public.delivery_zones where id = p_zone_id;
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
  end if;

  v_legacy := jsonb_build_object(
    'fee', greatest(round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2), 0),
    'minimum', coalesce(nullif(v_settings->'delivery'->>'minimum_order', '')::numeric, 0),
    'threshold', coalesce(nullif(v_settings->'delivery'->>'free_delivery_threshold', '')::numeric, 0)
  );

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;
    select * into v_product from public.products
    where id = (v_line->>'product_id')::uuid;
    if not found or not v_product.active or not v_product.show_on_website then
      raise exception 'Product % is not available on the website', coalesce(v_product.sku, v_line->>'product_id')
        using errcode = 'check_violation';
    end if;
    v_variant_id := null;
    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      select * into v_variant from public.product_variants
      where id = v_variant_id and product_id = v_product.id;
      if not found or not v_variant.active then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
    end if;
    v_unit := case when v_variant_id is not null and v_variant.price_override is not null
                   then v_variant.price_override
                   else v_product.selling_price end;
    if v_variant_id is null or v_variant.price_override is null then
      select * into v_campaign
      from public.campaigns
      where active and starts_at <= now() and ends_at >= now()
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
    end if;
    v_priced := v_priced || jsonb_build_object(
      'product_id', v_product.id::text,
      'category_id', v_product.category_id::text,
      'variant_id', case when v_variant_id is null then null else v_variant_id::text end,
      'qty', v_qty,
      'unit_price', round(v_unit::numeric, 2),
      'line_total', round((v_unit * v_qty)::numeric, 2)
    );
  end loop;

  return public.evaluate_order_pricing(
    (select coalesce(sum((l->>'line_total')::numeric), 0) from jsonb_array_elements(v_priced) as l),
    v_priced, p_promo_code, v_customer_key, v_zone_json, v_legacy,
    coalesce(p_delivery_type, 'delivery'), false
  );
end;
$$;

grant execute on function public.preview_storefront_pricing(jsonb, text, uuid, text, text)
  to anon, authenticated;

comment on function public.preview_storefront_pricing(jsonb, text, uuid, text, text) is
  'Advisory checkout pricing for the storefront: the same core the order path charges with, without writing anything. Never trusted at placement.';

-- ── 7. place_online_order: zones, promotions, snapshots ─────────────────────
-- 0043's body with three changes, everything else verbatim:
--   (a) §2 resolves an optional zone id (exists + enabled, else refused) and
--       still demands a whole address; the areas-list check stays for the
--       legacy no-zone path only.
--   (b) §4/§4b become one call to `evaluate_order_pricing` (automatic
--       promotion, extended coupon rules, stacking, fee) plus the usage writes.
--       The priced-lines loop gains one key (`category_id`) so scoped offers
--       read the cart without a second catalogue pass.
--   (c) the order carries `promotion_id` + `price_snapshot`, and every line
--       carries its discounted unit price for the returns reconciliation.
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
  v_zone_id        uuid := nullif(p_payload->>'delivery_zone_id', '')::uuid;
  v_settings       jsonb;
  v_delivery_fee   numeric(14,2) := 0;
  -- Normalized once, so the address and the shop's list of places are compared
  -- the way the storefront compares them: trimmed, case-folded, whitespace
  -- collapsed.
  v_city           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'city', '')), '\s+', ' ', 'g'));
  v_area           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'area', '')), '\s+', ' ', 'g'));
  -- The resolved zone (or null), and the legacy settings numbers, as the
  -- pricing core takes them. Prepared here, where the settings are at hand;
  -- measured there, where the goods total exists.
  v_zone           public.delivery_zones%rowtype;
  v_zone_json      jsonb := null;
  v_legacy_json    jsonb;
  v_customer_key   text;

  v_line           jsonb;
  v_product        public.products%rowtype;
  v_qty            integer;
  v_available      integer;
  -- Phase 43: the exact combination this line buys, when the product has them.
  v_variant        public.product_variants%rowtype;
  v_variant_id     uuid;
  v_variant_label  text;
  v_price_fixed    boolean;
  v_unit           numeric(14,2);
  v_subtotal       numeric(14,2) := 0;
  -- Phase 23: the priced cart. The first loop works out what each line costs
  -- (catalogue price, less any live campaign) and the second loop writes the
  -- snapshot rows, so the price has to travel between them. It did not: the
  -- second loop read `unit_price` from the caller's payload, which the app
  -- never sends — every live-mode checkout failed the NOT NULL constraint, and
  -- a caller who did send one set the shop's own snapshot price.
  v_priced_lines   jsonb := '[]'::jsonb;

  v_core           jsonb;
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
  v_item           record;
  v_core_line      jsonb;
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

  -- Who is buying, for per-customer limits and first-order-only: the account
  -- when signed in, else the normalized phone digits. The last fallback keeps
  -- the key non-null for a guest whose phone holds no digits at all (the usage
  -- row requires it); such a key is unique per order, so the limits treat an
  -- unidentifiable customer as new rather than failing the checkout.
  v_customer_key := coalesce(
    nullif(v_customer_id::text, ''),
    'phone:' || nullif(regexp_replace(coalesce(p_payload->>'customer_phone', ''), '[^0-9]', '', 'g'), ''),
    'order:' || coalesce(v_client_ref, '')
  );

  -- 2. delivery: a named zone, or the legacy settings path — the fee itself is
  --    priced later, where the goods total exists. A driver needs a whole
  --    address either way: city, area and street.
  if v_delivery_type = 'delivery' then
    if v_zone_id is not null then
      select * into v_zone from public.delivery_zones where id = v_zone_id;
      if not found or not v_zone.enabled then
        raise exception 'Delivery zone is not available' using errcode = 'check_violation';
      end if;
      if v_city = ''
         or v_area = ''
         or coalesce(btrim(p_payload->'address'->>'street'), '') = '' then
        raise exception 'A delivery address is required' using errcode = 'check_violation';
      end if;
      v_zone_json := jsonb_build_object(
        'id', v_zone.id::text,
        'name', coalesce(nullif(v_zone.name_en, ''), v_zone.name_ar),
        'fee', v_zone.shipping_fee,
        'minimum', v_zone.minimum_order_amount,
        'threshold', coalesce(v_zone.free_shipping_threshold, 0)
      );
    else
      if coalesce((v_settings->'delivery'->>'enabled')::boolean, true) = false then
        raise exception 'Delivery is not available' using errcode = 'check_violation';
      end if;

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
    end if;

    v_legacy_json := jsonb_build_object(
      'fee', greatest(round(coalesce((v_settings->'delivery'->>'fee')::numeric, 0), 2), 0),
      'minimum', coalesce(nullif(v_settings->'delivery'->>'minimum_order', '')::numeric, 0),
      'threshold', coalesce(nullif(v_settings->'delivery'->>'free_delivery_threshold', '')::numeric, 0)
    );
  else
    v_legacy_json := jsonb_build_object('fee', 0, 'minimum', 0, 'threshold', 0);
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
    -- ── Phase 43: which combination, and how many of THAT are promiseable ──
    -- Available-to-promise is per exact combination: stock − the holds on that
    -- variant. G17 = 2 with S17 = 2 refuses a third Gold / 17 while Silver / 17
    -- is untouched, and the product rollup never enters the arithmetic.
    -- The combination id resets every line: without this, a plain line after
    -- a variant line inherits the previous combination and is priced, held
    -- and snapshotted on the wrong shelf.
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
      v_available := v_variant.stock_quantity - public.reserved_quantity_variant(v_variant.id);
      if v_qty > v_available then
        raise exception 'Only % of % available', v_available, v_variant_label
          using errcode = 'check_violation';
      end if;
      if v_variant.price_override is not null then
        v_price_fixed := true;
      end if;
    elsif v_product.stock_tracking_enabled then
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
    --
    -- A combination with its own price is priced by that override and nothing
    -- else: a shop that marked one size down did so deliberately, and letting a
    -- campaign stack on top would quietly sell below the number it chose.
    v_unit := case when v_variant_id is not null and v_price_fixed
                   then v_variant.price_override
                   else v_product.selling_price
              end;
    if not v_price_fixed then
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
    end if;

    v_subtotal := v_subtotal + round((v_unit * v_qty)::numeric, 2);

    -- Carry the shop's price to the snapshot loop. Nothing from the caller's
    -- line is trusted past this point but product_id and qty, both of which
    -- were just validated against the catalogue. `category_id` rides along so
    -- scoped offers read the cart without a second catalogue pass. The
    -- combination is the reset scalar, never the row variable: the row still
    -- holds the previous iteration's combination for a plain line.
    v_priced_lines := v_priced_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'category_id', v_product.category_id::text,
      'qty',        v_qty,
      'unit_price', v_unit,
      -- Carried so the snapshot loop writes the same combination this loop
      -- priced and checked. Null on every legacy line.
      'variant_id', case when v_variant_id is null then null else v_variant_id::text end
    );
  end loop;

  -- 4. promotions, code, fee: the one arithmetic. The coupon row locks here
  --    (when a code was typed), so concurrent checkouts serialize against the
  --    usage limit instead of racing past it.
  v_core := public.evaluate_order_pricing(
    v_subtotal, v_priced_lines, v_coupon_code, v_customer_key,
    v_zone_json, v_legacy_json, v_delivery_type, true
  );
  v_discount := (v_core->>'total_discount')::numeric;
  v_delivery_fee := (v_core->>'delivery_fee')::numeric;
  v_total := (v_core->>'total')::numeric;

  -- InstaPay always needs a human to confirm the transfer; cash on delivery is
  -- simply unpaid until it is collected.
  v_payment_status := case
    when v_payment_method = 'instapay' then 'verification_required'::public.online_payment_status
    else 'pending'::public.online_payment_status
  end;

  -- 5. the order. `promotion_id` and `price_snapshot` are the history that a
  --    later edit of a promotion must never rewrite; `discount_amount` stays
  --    the single goods-discount column the till arithmetic reads.
  insert into public.online_orders (
    client_ref, store_customer_id, customer_name, customer_phone, customer_email,
    delivery_type, address, subtotal, discount_code, discount_amount, delivery_fee,
    total, payment_method, payment_status, status, notes,
    promotion_id, price_snapshot
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
    nullif(v_core->>'auto_promotion_id', '')::uuid,
    jsonb_build_object(
      'promo_code', v_core->>'promo_code',
      'promotion_id', v_core->>'auto_promotion_id',
      'promotion_name', v_core->>'auto_promotion_name',
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
    )
  ) returning id, order_number into v_order_id, v_order_number;

  -- A code that actually lowered the order (or waived its shipping) consumes
  -- one use — and exactly one row in the usage history, keyed to this order.
  -- A code that lost the stacking contest consumes nothing.
  if (v_core->>'promo_code') is not null
     and (((v_core->>'promo_discount')::numeric > 0)
          or coalesce((v_core->>'promo_free_shipping')::boolean, false)) then
    update public.coupons set used_count = used_count + 1, updated_at = now()
    where code = (v_core->>'promo_code');
    insert into public.promo_code_usages (coupon_id, order_id, customer_key)
    select c.id, v_order_id, v_customer_key
    from public.coupons c where c.code = (v_core->>'promo_code');
  end if;

  -- 6. line items (snapshot) + reservations (inventory protection)
  -- Phase 23: the priced cart, not the payload. Same keys, so the body below
  -- is unchanged; the difference is that `unit_price` is now the shop's.
  -- `discounted_unit_price` is the core's proportional allocation — what the
  -- customer actually paid per unit, and what a return refunds.
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
        name_ar, name_en, sku, barcode, unit_price, discounted_unit_price, quantity, line_total
      ) values (
        v_order_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        v_unit, (v_core_line->>'discounted_unit_price')::numeric, v_qty,
        round((v_unit * v_qty)::numeric, 2)
      );

      if v_product.stock_tracking_enabled then
        -- Same order, same product, same combination → the holds ADD UP instead
        -- of hiding the same units twice behind a duplicate row.
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id = v_variant.id
           and status = 'reserved';
        if not found then
          insert into public.stock_reservations (online_order_id, product_id, variant_id, quantity, status)
          values (v_order_id, v_product.id, v_variant.id, v_qty, 'reserved'::public.reservation_status);
        end if;
      end if;
    else
      insert into public.online_order_items (
        order_id, product_id, name_ar, name_en, sku, barcode, unit_price, discounted_unit_price, quantity, line_total
      ) values (
        v_order_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
        v_product.barcode, v_unit, (v_core_line->>'discounted_unit_price')::numeric, v_qty,
        round((v_unit * v_qty)::numeric, 2)
      );

      if v_product.stock_tracking_enabled then
        update public.stock_reservations
           set quantity = quantity + v_qty
         where online_order_id = v_order_id
           and product_id = v_product.id
           and variant_id is null
           and status = 'reserved';
        if not found then
          insert into public.stock_reservations (online_order_id, product_id, quantity, status)
          values (v_order_id, v_product.id, v_qty, 'reserved'::public.reservation_status);
        end if;
      end if;
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

-- ── 8. pos_process_return: refunds respect the discounted price paid ────────
-- 0043's body with one change: the refund unit. A sale that came from an
-- online order carries the order's discounts as one fixed sale discount while
-- its lines stay at list price — refunding those lines at list price hands
-- back money the customer never paid. When the sale has an online origin with
-- snapshotted per-line prices, the refund (and the return rows) use the
-- discounted unit instead. Legacy rows without a snapshot, and every
-- till-origin sale, behave exactly as before.
create or replace function public.pos_process_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale             public.sales%rowtype;
  v_line             jsonb;
  v_return_id        uuid;
  v_refund_id        uuid;
  v_return_number    text;
  v_refund_number    text;
  v_refund_total     numeric(14,2) := 0;
  v_approval_id      uuid;
  v_refunded_so_far  numeric(14,2) := 0;
  v_sale_item        public.sale_items%rowtype;
  v_already_returned integer;
  v_qty              integer;
  v_before           integer;
  v_refund_method    text := coalesce(p_payload->>'refund_method', 'cash');
  v_refund_status    text := coalesce(p_payload->>'refund_status', 'completed');
  v_reason           text := btrim(coalesce(p_payload->>'reason', ''));
  v_user_id          text := p_payload->>'user_id';
  v_user_name        text := p_payload->>'user_name';
  v_product          public.products%rowtype;
  -- Phase 43: the EXACT combination that was sold, read from the sold line.
  v_variant          public.product_variants%rowtype;
  -- 0050: what the customer actually paid per unit, when the sale came from a
  -- snapshotted online order. Null (legacy rows, till sales) means list price.
  v_eff_unit         numeric(14,2);
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  -- SECURITY DEFINER + EXECUTE to `authenticated` + no predicate meant any
  -- signed-in seat could process a return and issue a refund — money out of the
  -- till — regardless of `process_return`. A viewer did exactly that in the
  -- reproduction that prompted this guard.
  if not public.can('process_return') then
    raise exception 'Not permitted to process a return'
      using errcode = 'insufficient_privilege';
  end if;
  if v_reason = '' then
    raise exception 'Return reason is required' using errcode = 'check_violation';
  end if;
  if v_refund_method not in ('cash', 'visa', 'instapay') then
    raise exception 'Invalid refund method' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'No items to return' using errcode = 'check_violation';
  end if;

  select * into v_sale from public.sales where id = (p_payload->>'sale_id')::uuid for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Voided sales cannot be returned' using errcode = 'check_violation';
  end if;

  -- 0016 (a): a rejected refund never moved money, so it does not consume the
  -- sale's refundable amount. Pending still does.
  select coalesce(sum(amount), 0) into v_refunded_so_far
    from public.refund_records
   where sale_id = v_sale.id
     and status <> 'rejected';

  -- validate every line before writing anything
  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Return quantity must be a positive whole number' using errcode = 'check_violation';
    end if;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;
    if not found then
      raise exception 'Sale item not found on this invoice' using errcode = 'foreign_key_violation';
    end if;

    -- 0041: a REJECTED return is cancelled — its goods are written back out
    -- when the refund is rejected (see pos_settle_refund), so it must not
    -- hold the quantity. Pending and completed both count: the goods are on
    -- the shelf either way, and double-returning would restore them twice.
    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id
       and ri.sale_item_id = v_sale_item.id
       and r.refund_status <> 'rejected';

    if v_qty > (v_sale_item.quantity - v_already_returned) then
      raise exception 'Return quantity exceeds remaining returnable quantity for %', v_sale_item.sku
        using errcode = 'check_violation';
    end if;

    -- 0050: the paid price, not the list price. An online-origin sale's lines
    -- read at list while its discount rides as one fixed sale discount; the
    -- order snapshot holds what each unit actually cost, so the refund uses
    -- that. Anything without a snapshot refunds exactly as before.
    v_eff_unit := v_sale_item.unit_price;
    if v_sale.source = 'online' then
      select i.discounted_unit_price into v_eff_unit
        from public.online_order_items i
        join public.online_orders o on o.id = i.order_id
       where o.sale_id = v_sale.id
         and i.product_id = v_sale_item.product_id
         and i.variant_id is not distinct from v_sale_item.variant_id
       -- One row per (order, product, combination) in practice; the id order
       -- is the deterministic tiebreak when a payload listed the same line
       -- twice (their discounted units can differ by a rounding piastre).
       order by i.id
       limit 1;
      if v_eff_unit is null or v_eff_unit < 0 then
        v_eff_unit := v_sale_item.unit_price;
      end if;
    end if;

    v_refund_total := v_refund_total + round((v_eff_unit * v_qty)::numeric, 2);
  end loop;

  if v_refund_total > (v_sale.total - v_refunded_so_far) then
    raise exception 'Refund exceeds remaining refundable amount for this sale'
      using errcode = 'check_violation';
  end if;

  -- ── approval limits (Phase 24) ────────────────────────────────────────────
  -- The refund total above is built from the sale's own line prices and capped
  -- at what is still refundable, so it cannot be inflated. What a direct call
  -- could do until now is issue a refund above the shop's cap with nobody
  -- signing it off, because returnService.ts:246 is the only place that checked.
  if public.approval_required_for('refund', v_refund_total) then
    if coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    v_approval_id := public.approval_assert_satisfied(
      'refund', v_refund_total, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 0016 (b): `::text` binds tighter than `-`, so `next_value::text - 1` was
  -- parsed as `text - integer` and raised on every return and every refund.
  update public.return_counters set next_value = next_value + 1 where id = 1
    returning 'RET-' || lpad((next_value - 1)::text, 6, '0') into v_return_number;
  update public.refund_counters set next_value = next_value + 1 where id = 1
    returning 'REF-' || lpad((next_value - 1)::text, 6, '0') into v_refund_number;

  insert into public.sales_returns (
    return_number, sale_id, sale_number, customer_id, customer_name,
    reason, refund_amount, refund_method, refund_status, user_id, user_name
  ) values (
    v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    v_reason, v_refund_total, v_refund_method::public.refund_method,
    v_refund_status::public.refund_status, v_user_id, v_user_name
  ) returning id into v_return_id;

  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id;

    -- The return rows carry the refunded (paid) price, matching the refund
    -- record to the piastre; the invoice's own lines are untouched history.
    v_eff_unit := v_sale_item.unit_price;
    if v_sale.source = 'online' then
      select i.discounted_unit_price into v_eff_unit
        from public.online_order_items i
        join public.online_orders o on o.id = i.order_id
       where o.sale_id = v_sale.id
         and i.product_id = v_sale_item.product_id
         and i.variant_id is not distinct from v_sale_item.variant_id
       -- One row per (order, product, combination) in practice; the id order
       -- is the deterministic tiebreak when a payload listed the same line
       -- twice (their discounted units can differ by a rounding piastre).
       order by i.id
       limit 1;
      if v_eff_unit is null or v_eff_unit < 0 then
        v_eff_unit := v_sale_item.unit_price;
      end if;
    end if;

    insert into public.return_items (
      return_id, sale_item_id, product_id,
      variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label,
      name_ar, name_en, sku, barcode,
      unit_price, quantity, line_total
    ) values (
      v_return_id, v_sale_item.id, v_sale_item.product_id,
      -- The combination is a FACT ABOUT THE SALE, copied from the sold line.
      -- The caller cannot pick a shelf to put the goods back on, so returning
      -- a Gold / 17 can never restore Gold / 16 or Silver / 17.
      v_sale_item.variant_id, v_sale_item.variant_color_ar, v_sale_item.variant_color_en,
      v_sale_item.variant_size, v_sale_item.variant_size_label,
      v_sale_item.name_ar,
      v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
      v_eff_unit, v_qty,
      round((v_eff_unit * v_qty)::numeric, 2)
    );

    if v_sale_item.variant_id is not null then
      select * into v_variant from public.product_variants
       where id = v_sale_item.variant_id for update;
      if found then
        v_before := v_variant.stock_quantity;
        update public.product_variants
           set stock_quantity = stock_quantity + v_qty, updated_at = now()
         where id = v_variant.id;

        insert into public.stock_movements (
          product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
          delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_sale_item.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_qty, v_before, v_before + v_qty,
          'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
          v_user_id, v_user_name
        );
      end if;
    else
      select * into v_product from public.products where id = v_sale_item.product_id for update;
      if found then
        v_before := v_product.stock_quantity;
        update public.products
           set stock_quantity = stock_quantity + v_qty, updated_at = now()
         where id = v_product.id;

        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name
        ) values (
          v_product.id, v_qty, v_before, v_before + v_qty,
          'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')',
          v_user_id, v_user_name
        );
      end if;
    end if;
  end loop;

  -- 0016 (c): a refund paid over the counter is settled now, by the person
  -- recording it; a pending one waits for approval and stays unstamped.
  insert into public.refund_records (
    refund_number, sale_id, sale_number, return_id, amount,
    payment_method, status, reason, user_id, user_name,
    settled_at, settled_by, settled_by_name
  ) values (
    v_refund_number, v_sale.id, v_sale.sale_number, v_return_id, v_refund_total,
    v_refund_method::public.refund_method,
    v_refund_status::public.refund_status,
    v_reason, v_user_id, v_user_name,
    case when v_refund_status = 'completed' then now() else null end,
    case when v_refund_status = 'completed' then v_user_id else null end,
    case when v_refund_status = 'completed' then v_user_name else null end
  ) returning id into v_refund_id;

  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_refund_id::text);
  end if;

  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id);
end;
$$;

-- ── 9. audit vocabulary: promotions ────────────────────────────────────────
-- Creating a discount or a code, changing one, and switching one on or off
-- all decide what customers pay — each is a trail event with the values in
-- `details`. Written by the website service (demo) and through the
-- manage_website RLS gate (live).
insert into public.audit_actions (action, entity) values
  ('promotion.created', 'promotion'),
  ('promotion.changed', 'promotion'),
  ('promotion.activated', 'promotion'),
  ('promotion.deactivated', 'promotion'),
  ('promo_code.created', 'promo_code'),
  ('promo_code.changed', 'promo_code'),
  ('promo_code.disabled', 'promo_code')
on conflict (action) do nothing;

-- ── 9b. the writes audit themselves, whoever makes them ─────────────────────
-- Admin writes are direct table upserts behind the manage_website RLS gate —
-- no RPC funnel exists to write the trail — so triggers do it, exactly like
-- `categories_audit` (0044): SECURITY DEFINER so the row lands however the
-- change was made, actor from the session. No secrets in details (fees,
-- thresholds, names, windows — never anything credential-like).
create or replace function public.promo_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := coalesce(auth.uid()::text, 'system');
  v_name   text;
  v_action text;
  v_entity text;
  v_label  text;
begin
  select p.name into v_name from public.profiles p where p.id = auth.uid();

  if tg_table_name = 'delivery_zones' then
    v_entity := 'delivery_zone';
    if tg_op = 'INSERT' then
      v_action := 'delivery_zone.created';
      v_label := coalesce(nullif(new.name_en, ''), new.name_ar);
      insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
      values (v_action, v_entity, new.id::text, v_label,
              jsonb_build_object('key', new.key, 'shipping_fee', new.shipping_fee,
                                 'minimum_order_amount', new.minimum_order_amount,
                                 'free_shipping_threshold', new.free_shipping_threshold,
                                 'enabled', new.enabled),
              v_actor, coalesce(v_name, v_actor));
      return new;
    elsif tg_op = 'DELETE' then
      insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
      values ('delivery_zone.changed', v_entity, old.id::text,
              coalesce(nullif(old.name_en, ''), old.name_ar),
              jsonb_build_object('key', old.key, 'deleted', true),
              v_actor, coalesce(v_name, v_actor));
      return old;
    else
      insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
      values ('delivery_zone.changed', v_entity, new.id::text,
              coalesce(nullif(new.name_en, ''), new.name_ar),
              jsonb_build_object('key', new.key, 'shipping_fee', new.shipping_fee,
                                 'minimum_order_amount', new.minimum_order_amount,
                                 'free_shipping_threshold', new.free_shipping_threshold,
                                 'enabled', new.enabled),
              v_actor, coalesce(v_name, v_actor));
      return new;
    end if;
  end if;

  if tg_table_name = 'promotions' then
    v_entity := 'promotion';
    if tg_op = 'INSERT' then
      v_action := 'promotion.created';
    elsif tg_op = 'DELETE' then
      insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
      values ('promotion.changed', v_entity, old.id::text,
              coalesce(nullif(old.name_en, ''), old.name_ar),
              jsonb_build_object('scope', old.scope, 'deleted', true),
              v_actor, coalesce(v_name, v_actor));
      return old;
    elsif old.enabled is distinct from new.enabled
          and old.scope is not distinct from new.scope
          and old.discount_type is not distinct from new.discount_type
          and old.value is not distinct from new.value then
      v_action := case when new.enabled then 'promotion.activated' else 'promotion.deactivated' end;
    else
      v_action := 'promotion.changed';
    end if;
    v_label := coalesce(nullif(new.name_en, ''), new.name_ar);
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values (v_action, v_entity, new.id::text, v_label,
            jsonb_build_object('scope', new.scope, 'discount_type', new.discount_type,
                               'value', new.value, 'enabled', new.enabled,
                               'priority', new.priority, 'stackable', new.stackable),
            v_actor, coalesce(v_name, v_actor));
    return new;
  end if;

  -- coupons
  v_entity := 'promo_code';
  if tg_op = 'INSERT' then
    v_action := 'promo_code.created';
  elsif tg_op = 'DELETE' then
    insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
    values ('promo_code.changed', v_entity, old.id::text, old.code,
            jsonb_build_object('deleted', true),
            v_actor, coalesce(v_name, v_actor));
    return old;
  elsif old.active and not new.active then
    v_action := 'promo_code.disabled';
  else
    v_action := 'promo_code.changed';
  end if;
  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (v_action, v_entity, new.id::text, new.code,
          jsonb_build_object('discount_type', new.discount_type::text, 'value', new.value,
                             'active', new.active, 'stackable', new.stackable,
                             'first_order_only', new.first_order_only),
          v_actor, coalesce(v_name, v_actor));
  return new;
end;
$$;

comment on function public.promo_audit() is
  'Writes the promotion trail (zone created/changed, promotion created/changed/activated/deactivated, promo code created/changed/disabled) on direct admin writes, whoever made them. SECURITY DEFINER; details carry values, never secrets.';

drop trigger if exists delivery_zones_audit on public.delivery_zones;
create trigger delivery_zones_audit
  after insert or update or delete on public.delivery_zones
  for each row execute function public.promo_audit();

drop trigger if exists promotions_audit on public.promotions;
create trigger promotions_audit
  after insert or update or delete on public.promotions
  for each row execute function public.promo_audit();

drop trigger if exists coupons_audit on public.coupons;
create trigger coupons_audit
  after insert or update or delete on public.coupons
  for each row execute function public.promo_audit();

-- ── 10. backup covers everything added here ────────────────────────────────
-- 0049's restatement carried forward with the promotion tables slotted in:
-- definitions beside the storefront documents, targets right after their
-- parent, usages with the order's children. Nothing here is trigger-owned, so
-- the restore exclusion list is 0048's verbatim.
create or replace function public.backup_table_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    -- counters and vocabulary first: nothing points at them, everything may be
    -- pointed at by them
    'approval_counters',
    'refund_counters',
    'return_counters',
    'sale_counters',
    'role_aliases',
    'role_capabilities',
    'audit_actions',
    'approval_rules',
    -- the storefront's own documents
    'campaigns',
    'coupons',
    'delivery_zones',
    'promotions',
    'store_faqs',
    'website_settings',
    -- the catalogue and the people
    'categories',
    'custom_roles',
    'customers',
    'store_customers',
    'shifts',
    'products',
    -- Phase 43/45: the shelf of record and its codes, between their parent and
    -- the children that reference them
    'product_variants',
    'catalogue_codes',
    'profiles',
    -- the trading record
    'expenses',
    'sales',
    'audit_log',
    'online_orders',
    'sales_returns',
    -- children of the above, last
    'promotion_targets',
    'sale_items',
    'sale_payments',
    'stock_movements',
    'product_content',
    'storefront_category_content',
    'store_reviews',
    'online_order_items',
    'order_events',
    'stock_reservations',
    'promo_code_usages',
    'return_items',
    'refund_records',
    'approval_requests'
  ];
$$;

create or replace function public.backup_restore_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array(
    select t
      from unnest(public.backup_table_order()) with ordinality as x(t, n)
     where t <> all (array[
       'role_aliases', 'role_capabilities', 'audit_actions', 'audit_log',
       'catalogue_codes'
     ])
     order by n
  ), '{}');
$$;


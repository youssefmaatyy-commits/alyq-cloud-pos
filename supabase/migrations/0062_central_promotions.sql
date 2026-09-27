-- ═══════════════════════════════════════════════════════════════════════════
-- 0062 — CENTRAL DISCOUNTS & PROMOTIONS SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════
-- Unifies central promotions across POS and Storefront with:
--   · Modes: Automatic (`automatic`) and Coupon (`coupon`)
--   · Unique normalized coupon index for safe code deduplication
--   · Offer Types: Standard (`standard`), Buy X Get Y (`bxgy`), Cheapest Item (`cheapest_item`)
--   · Configurable X & Y for BXGY with Free (100%) or Percentage reward
--   · Cheapest item in eligible cart with min quantity & free/percent/fixed reward
--   · Repeatable offer configuration (YES/NO)
--   · Scopes: Store, Category, Product, Exact Variant (relational UUID targeting)
--   · Channel awareness ('pos', 'online', 'both')
--   · Authoritative server-enforced best-saving non-stacking rules
--   · Server-authoritative POS pricing from DB catalogue (never trusts client unit prices)
--   · Parity in campaign base pricing across POS and Storefront
--   · Server-automatic POS promotion recalculation and snapshot derivation
--   · Safe manual item discount vs central promotion non-stacking (best discount wins)
--   · Exact capped discount reconciliation across lines (sum of line discounts == total discount)
--   · Candidate evaluation state isolation (no reward leakage across candidates)
--   · Zero-discount winner safeguard (unmet thresholds do not produce active promo winner)
--   · Strict role-based authorization (no anon bypass on order management or POS sale)
--   · Trusted cashier identity derivation from auth.uid() (prevents payload identity spoofing)
--   · Cashier-owned open shift enforcement (never attaches a sale to another cashier's shift)
--   · Atomic coupon usage limit enforcement & reservation-safe counting lifecycle
--   · Full historical snapshots for automatic and coupon promotions (BXGY, Cheapest Item, Standard)
--   · Approved online order conversion without double discounting
--   · Approved online order cancellation with complete stock & variant reversal via pos_void_sale
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.promotions
  add column if not exists mode text not null default 'automatic',
  add column if not exists code text,
  add column if not exists used_count integer not null default 0 check (used_count >= 0),
  add column if not exists usage_limit integer default null,
  add column if not exists offer_type text not null default 'standard',
  add column if not exists rule_type text default 'standard',
  add column if not exists buy_x integer default null,
  add column if not exists get_y integer default null,
  add column if not exists reward_type text default 'free',
  add column if not exists reward_value numeric(14,2) default null,
  add column if not exists repeat_offer boolean not null default true,
  add column if not exists min_quantity integer default null;

alter table public.promotions drop constraint if exists promotions_mode_valid;
alter table public.promotions add constraint promotions_mode_valid
  check (mode in ('automatic', 'coupon'));

alter table public.promotions drop constraint if exists promotions_code_format;
alter table public.promotions add constraint promotions_code_format
  check (mode <> 'coupon' or (code is not null and btrim(code) <> ''));

alter table public.promotions drop constraint if exists promotions_offer_type_valid;
alter table public.promotions add constraint promotions_offer_type_valid
  check (offer_type in ('standard', 'bxgy', 'cheapest_item'));

alter table public.promotions drop constraint if exists promotions_reward_type_valid;
alter table public.promotions add constraint promotions_reward_type_valid
  check (reward_type is null or reward_type in ('free', 'percent', 'fixed'));

-- ── Unique normalized coupon code index ──────────────────────────────────────
create unique index if not exists promotions_coupon_code_idx
  on public.promotions (upper(regexp_replace(btrim(code), '\s+', '', 'g')))
  where mode = 'coupon' and code is not null and btrim(code) <> '';

-- ── Shift index: one open shift per cashier/user ────────────────────────────
drop index if exists public.shifts_one_open_idx;
create unique index if not exists shifts_one_open_per_user_idx
  on public.shifts (opened_by, (status)) where status = 'open';

create or replace function public.enforce_shift_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.can('open_shift') then
      raise exception 'Your role cannot open a shift' using errcode = 'insufficient_privilege';
    end if;
    if new.status <> 'open' then
      raise exception 'A shift must be created open' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.shifts s where s.status = 'open' and s.opened_by = new.opened_by) then
      raise exception 'An open shift already exists; close it before opening another'
        using errcode = 'unique_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'closed' then
    if new.branch         is distinct from old.branch
       or new.register       is distinct from old.register
       or new.status         is distinct from old.status
       or new.opening_cash   is distinct from old.opening_cash
       or new.opening_at     is distinct from old.opening_at
       or new.closing_cash   is distinct from old.closing_cash
       or new.closed_at      is distinct from old.closed_at
       or new.summary        is distinct from old.summary
       or new.notes          is distinct from old.notes
    then
      raise exception 'A closed shift cannot be edited'
        using errcode = 'check_violation';
    end if;
    if new.adjustment_approved_at is distinct from old.adjustment_approved_at
       and old.adjustment_approved_at is not null then
      raise exception 'This adjustment has already been approved'
        using errcode = 'check_violation';
    end if;
    if not public.can('approve_shift_adjustment') then
      raise exception 'Your role cannot approve a shift adjustment'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- closing an open shift
  if new.status = 'closed' then
    if not public.can('close_shift') then
      raise exception 'Your role cannot close a shift' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- any other update on an open shift
  if not (public.can('open_shift') or public.can('close_shift')) then
    raise exception 'Your role cannot edit a shift' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

-- ── Snapshot columns for sales, sale_items, online_orders, online_order_items
alter table public.sales
  add column if not exists promotion_rule_type text,
  add column if not exists promotion_buy_x integer,
  add column if not exists promotion_get_y integer,
  add column if not exists promotion_reward_qty integer,
  add column if not exists promotion_rewarded_units jsonb;

alter table public.sale_items
  add column if not exists rewarded_qty integer not null default 0,
  add column if not exists promotion_rule_type text;

alter table public.online_orders
  add column if not exists automatic_promotion_id uuid references public.promotions(id) on delete set null,
  add column if not exists automatic_promotion_name text,
  add column if not exists automatic_discount_amount numeric(14,2) not null default 0,
  add column if not exists promotion_rule_type text,
  add column if not exists promotion_buy_x integer,
  add column if not exists promotion_get_y integer,
  add column if not exists promotion_reward_qty integer;

alter table public.online_order_items
  add column if not exists automatic_promotion_id uuid references public.promotions(id) on delete set null,
  add column if not exists automatic_promotion_name text,
  add column if not exists automatic_discount_amount numeric(14,2) not null default 0,
  add column if not exists rewarded_qty integer not null default 0,
  add column if not exists promotion_rule_type text;

-- ── Clean obsolete function signatures if any exist ────────────────────────
drop function if exists public.complete_pos_sale;
drop function if exists public.complete_online_order;
drop function if exists public.pos_complete_sale(jsonb);

-- ── Candidate evaluation helper function ───────────────────────────────────
create or replace function public.evaluate_promotion_candidate(
  p_promo         public.promotions,
  p_lines         jsonb,
  p_subtotal      numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_count         integer := coalesce(jsonb_array_length(p_lines), 0);
  v_offer_type    text := coalesce(p_promo.offer_type, p_promo.rule_type, 'standard');
  v_discount      numeric(14,2) := 0;
  v_raw_discount  numeric(14,2) := 0;
  v_buy_x         integer := null;
  v_get_y         integer := null;
  v_reward_qty    integer := null;
  v_min_qty       integer := null;
  v_repeat        boolean := coalesce(p_promo.repeat_offer, true);
  v_reward_type   text;
  v_reward_val    numeric(14,2);

  v_line_discounts numeric[];
  v_line_rewards   integer[];

  v_eligible_indices integer[] := '{}';
  v_eligible_base    numeric(14,2) := 0;
  v_item             record;
  v_line             jsonb;
  v_line_total       numeric(14,2);

  v_elig_qty         integer := 0;
  v_group_size       integer;
  v_complete_groups  integer;
  v_rem_reward       integer;
  v_unit_row         record;
  v_take_qty         integer;
  v_unit_disc        numeric(14,2);
  v_last_elig        integer;
  v_rem              numeric(14,2);
  v_share            numeric(14,2);
  v_disc_indices     integer[] := '{}';
  v_idx              integer;
begin
  v_line_discounts := array_fill(0::numeric, array[v_count]);
  v_line_rewards := array_fill(0::integer, array[v_count]);

  if p_subtotal < coalesce(p_promo.minimum_order_amount, 0) then
    return jsonb_build_object(
      'discount', 0,
      'offer_type', v_offer_type,
      'buy_x', null,
      'get_y', null,
      'reward_qty', null,
      'line_discounts', to_jsonb(v_line_discounts),
      'line_rewards', to_jsonb(v_line_rewards)
    );
  end if;

  -- 1. Identify eligible lines
  for v_item in
    select value, ordinality - 1 as idx
    from jsonb_array_elements(p_lines) with ordinality
  loop
    if public.promo_scope_matches(p_promo.scope, p_promo.id, v_item.value) then
      v_eligible_indices := array_append(v_eligible_indices, v_item.idx);
      v_eligible_base := v_eligible_base + round(coalesce((v_item.value->>'line_total')::numeric, 0), 2);
      v_elig_qty := v_elig_qty + greatest(coalesce((v_item.value->>'qty')::numeric, 1)::integer, 1);
    end if;
  end loop;

  if array_length(v_eligible_indices, 1) is null or array_length(v_eligible_indices, 1) = 0 then
    -- Storewide fallback on empty cart lines with non-zero subtotal
    if (p_promo.scope = 'store' or p_promo.scope = 'all') and p_subtotal > 0 and v_offer_type = 'standard' then
      if p_promo.discount_type = 'percent' then
        v_discount := round((p_subtotal * least(p_promo.value, 100) / 100)::numeric, 2);
        if p_promo.maximum_discount_amount is not null and p_promo.maximum_discount_amount > 0 then
          v_discount := least(v_discount, round(p_promo.maximum_discount_amount::numeric, 2));
        end if;
      else
        v_discount := least(round(p_promo.value::numeric, 2), p_subtotal);
      end if;
      v_discount := least(greatest(v_discount, 0), p_subtotal);
      return jsonb_build_object(
        'discount', v_discount,
        'offer_type', v_offer_type,
        'buy_x', null,
        'get_y', null,
        'reward_qty', null,
        'line_discounts', '[]'::jsonb,
        'line_rewards', '[]'::jsonb
      );
    end if;

    return jsonb_build_object(
      'discount', 0,
      'offer_type', v_offer_type,
      'buy_x', null,
      'get_y', null,
      'reward_qty', null,
      'line_discounts', to_jsonb(v_line_discounts),
      'line_rewards', to_jsonb(v_line_rewards)
    );
  end if;

  -- 2. Standard offer type
  if v_offer_type = 'standard' then
    if p_promo.discount_type = 'percent' then
      v_discount := round((v_eligible_base * least(p_promo.value, 100) / 100)::numeric, 2);
      if p_promo.maximum_discount_amount is not null and p_promo.maximum_discount_amount > 0 then
        v_discount := least(v_discount, round(p_promo.maximum_discount_amount::numeric, 2));
      end if;
    else
      v_discount := least(round(p_promo.value::numeric, 2), v_eligible_base);
    end if;
    v_discount := least(greatest(v_discount, 0), p_subtotal);

    if v_discount > 0 and v_eligible_base > 0 then
      v_rem := v_discount;
      v_last_elig := v_eligible_indices[array_upper(v_eligible_indices, 1)];
      foreach v_idx in array v_eligible_indices
      loop
        v_line := p_lines->v_idx;
        v_line_total := round(coalesce((v_line->>'line_total')::numeric, 0), 2);
        if v_idx = v_last_elig then
          v_share := round(v_rem::numeric, 2);
        else
          v_share := round((v_discount * v_line_total / v_eligible_base)::numeric, 2);
          v_rem := v_rem - v_share;
        end if;
        v_line_discounts[v_idx + 1] := v_share;
      end loop;
    end if;

  -- 3. BXGY offer type
  elsif v_offer_type = 'bxgy' then
    v_buy_x := greatest(coalesce(p_promo.buy_x, 2), 1);
    v_get_y := greatest(coalesce(p_promo.get_y, 1), 1);
    v_group_size := v_buy_x + v_get_y;
    v_complete_groups := floor(v_elig_qty / v_group_size);

    if v_complete_groups > 0 then
      if v_repeat then
        v_reward_qty := v_complete_groups * v_get_y;
      else
        v_reward_qty := v_get_y;
      end if;
      v_reward_qty := least(v_reward_qty, v_elig_qty);

      v_reward_type := coalesce(p_promo.reward_type, 'free');
      v_reward_val := coalesce(p_promo.reward_value, case when v_reward_type = 'free' then 100 else coalesce(p_promo.value, 100) end);

      v_rem_reward := v_reward_qty;
      for v_unit_row in
        select o.idx, o.value,
               round(coalesce((o.value->>'unit_price')::numeric, 0), 2) as u_price,
               greatest(coalesce((o.value->>'qty')::numeric, 1)::integer, 1) as l_qty
        from (select value, ordinality - 1 as idx
              from jsonb_array_elements(p_lines) with ordinality) o
        where public.promo_scope_matches(p_promo.scope, p_promo.id, o.value)
        order by u_price asc, o.idx asc
      loop
        if v_rem_reward <= 0 then exit; end if;
        v_take_qty := least(v_rem_reward, v_unit_row.l_qty);
        if v_reward_type = 'free' or v_reward_val >= 100 then
          v_unit_disc := round((v_unit_row.u_price * v_take_qty)::numeric, 2);
        elsif v_reward_type = 'percent' then
          v_unit_disc := round((v_unit_row.u_price * least(v_reward_val, 100) / 100 * v_take_qty)::numeric, 2);
        else
          v_unit_disc := least(v_unit_row.u_price * v_take_qty, v_reward_val * v_take_qty);
        end if;
        v_unit_disc := least(v_unit_disc, round((v_unit_row.u_price * v_take_qty)::numeric, 2));

        v_discount := v_discount + v_unit_disc;
        v_line_discounts[v_unit_row.idx + 1] := v_line_discounts[v_unit_row.idx + 1] + v_unit_disc;
        v_line_rewards[v_unit_row.idx + 1] := v_line_rewards[v_unit_row.idx + 1] + v_take_qty;
        v_rem_reward := v_rem_reward - v_take_qty;
      end loop;

      v_raw_discount := v_discount;
      if p_promo.maximum_discount_amount is not null and p_promo.maximum_discount_amount > 0 then
        v_discount := least(v_discount, round(p_promo.maximum_discount_amount::numeric, 2));
      end if;
      v_discount := least(greatest(v_discount, 0), p_subtotal);

      -- Reconcile line discounts if capped so SUM(line_discounts) == v_discount exactly
      if v_discount < v_raw_discount and v_raw_discount > 0 then
        v_rem := v_discount;
        v_disc_indices := '{}';
        foreach v_idx in array v_eligible_indices
        loop
          if v_line_discounts[v_idx + 1] > 0 then
            v_disc_indices := array_append(v_disc_indices, v_idx);
          end if;
        end loop;

        if array_length(v_disc_indices, 1) > 0 then
          v_last_elig := v_disc_indices[array_upper(v_disc_indices, 1)];
          foreach v_idx in array v_disc_indices
          loop
            if v_idx = v_last_elig then
              v_share := round(v_rem::numeric, 2);
            else
              v_share := round((v_discount * v_line_discounts[v_idx + 1] / v_raw_discount)::numeric, 2);
              v_rem := v_rem - v_share;
            end if;
            v_line_discounts[v_idx + 1] := v_share;
          end loop;
        end if;
      end if;
    else
      -- BXGY group threshold not reached
      v_buy_x := null;
      v_get_y := null;
      v_reward_qty := null;
    end if;

  -- 4. Cheapest item offer type
  elsif v_offer_type = 'cheapest_item' then
    v_min_qty := greatest(coalesce(p_promo.min_quantity, p_promo.buy_x, 3), 1);
    v_repeat := coalesce(p_promo.repeat_offer, false);

    if v_elig_qty >= v_min_qty then
      if v_repeat then
        v_reward_qty := floor(v_elig_qty / v_min_qty);
      else
        v_reward_qty := 1;
      end if;
      v_reward_qty := least(v_reward_qty, v_elig_qty);

      v_reward_type := coalesce(p_promo.reward_type, case when p_promo.discount_type = 'fixed' then 'fixed' when p_promo.value >= 100 then 'free' else 'percent' end);
      v_reward_val := coalesce(p_promo.reward_value, p_promo.value, 100);

      v_rem_reward := v_reward_qty;
      for v_unit_row in
        select o.idx, o.value,
               round(coalesce((o.value->>'unit_price')::numeric, 0), 2) as u_price,
               greatest(coalesce((o.value->>'qty')::numeric, 1)::integer, 1) as l_qty
        from (select value, ordinality - 1 as idx
              from jsonb_array_elements(p_lines) with ordinality) o
        where public.promo_scope_matches(p_promo.scope, p_promo.id, o.value)
        order by u_price asc, o.idx asc
      loop
        if v_rem_reward <= 0 then exit; end if;
        v_take_qty := least(v_rem_reward, v_unit_row.l_qty);
        if v_reward_type = 'free' or (v_reward_type = 'percent' and v_reward_val >= 100) or (p_promo.discount_type = 'percent' and p_promo.value >= 100) then
          v_unit_disc := round((v_unit_row.u_price * v_take_qty)::numeric, 2);
        elsif v_reward_type = 'percent' or (v_reward_type is null and p_promo.discount_type = 'percent') then
          v_unit_disc := round((v_unit_row.u_price * least(v_reward_val, 100) / 100 * v_take_qty)::numeric, 2);
        else
          v_unit_disc := least(v_unit_row.u_price * v_take_qty, v_reward_val * v_take_qty);
        end if;
        v_unit_disc := least(v_unit_disc, round((v_unit_row.u_price * v_take_qty)::numeric, 2));

        v_discount := v_discount + v_unit_disc;
        v_line_discounts[v_unit_row.idx + 1] := v_line_discounts[v_unit_row.idx + 1] + v_unit_disc;
        v_line_rewards[v_unit_row.idx + 1] := v_line_rewards[v_unit_row.idx + 1] + v_take_qty;
        v_rem_reward := v_rem_reward - v_take_qty;
      end loop;

      v_raw_discount := v_discount;
      if p_promo.maximum_discount_amount is not null and p_promo.maximum_discount_amount > 0 then
        v_discount := least(v_discount, round(p_promo.maximum_discount_amount::numeric, 2));
      end if;
      v_discount := least(greatest(v_discount, 0), p_subtotal);

      -- Reconcile line discounts if capped
      if v_discount < v_raw_discount and v_raw_discount > 0 then
        v_rem := v_discount;
        v_disc_indices := '{}';
        foreach v_idx in array v_eligible_indices
        loop
          if v_line_discounts[v_idx + 1] > 0 then
            v_disc_indices := array_append(v_disc_indices, v_idx);
          end if;
        end loop;

        if array_length(v_disc_indices, 1) > 0 then
          v_last_elig := v_disc_indices[array_upper(v_disc_indices, 1)];
          foreach v_idx in array v_disc_indices
          loop
            if v_idx = v_last_elig then
              v_share := round(v_rem::numeric, 2);
            else
              v_share := round((v_discount * v_line_discounts[v_idx + 1] / v_raw_discount)::numeric, 2);
              v_rem := v_rem - v_share;
            end if;
            v_line_discounts[v_idx + 1] := v_share;
          end loop;
        end if;
      end if;
    else
      -- Min quantity threshold not met
      v_min_qty := null;
      v_reward_qty := null;
    end if;
  end if;

  if v_discount <= 0 then
    v_buy_x := null;
    v_get_y := null;
    v_reward_qty := null;
  end if;

  return jsonb_build_object(
    'discount', v_discount,
    'offer_type', v_offer_type,
    'buy_x', v_buy_x,
    'get_y', v_get_y,
    'reward_qty', v_reward_qty,
    'line_discounts', to_jsonb(v_line_discounts),
    'line_rewards', to_jsonb(v_line_rewards)
  );
end;
$$;

revoke execute on function public.evaluate_promotion_candidate(public.promotions, jsonb, numeric) from public, anon, authenticated;

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
  v_eval         jsonb;
  v_cand_discount numeric(14,2);
  v_auto_discount numeric(14,2) := 0;
  v_auto_id      uuid := null;
  v_auto_name    text := null;
  v_auto_stack   boolean := false;
  v_auto_rule_type text := null;
  v_auto_buy_x   integer := null;
  v_auto_get_y   integer := null;
  v_auto_reward_qty integer := null;

  v_auto_line_discounts numeric[];
  v_auto_line_rewards   integer[];
  v_coupon_line_discounts numeric[];
  v_coupon_line_rewards   integer[];

  v_code         text := nullif(upper(regexp_replace(btrim(coalesce(p_promo_code, '')), '\s+', '', 'g')), '');
  v_coupon_promo public.promotions%rowtype;
  v_coupon_promo_id uuid := null;
  v_coupon_promo_name text := null;
  v_coupon_promo_rule_type text := null;
  v_coupon_promo_buy_x integer := null;
  v_coupon_promo_get_y integer := null;
  v_coupon_promo_reward_qty integer := null;
  v_coupon       public.coupons%rowtype;
  v_coupon_discount numeric(14,2) := 0;
  v_coupon_free_ship boolean := false;
  v_coupon_stack boolean := false;
  v_code_applied boolean := false;
  v_coupon_promo_matched boolean := false;
  v_uses         integer;
  v_prior_orders integer;

  v_winning_promo_id uuid := null;
  v_winning_promo_name text := null;
  v_winning_rule_type text := null;
  v_winning_buy_x integer := null;
  v_winning_get_y integer := null;
  v_winning_reward_qty integer := null;

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
  v_idx          integer;
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
    l.value || jsonb_build_object(
      'line_total',
      round(coalesce((l.value->>'line_total')::numeric,
                     coalesce((l.value->>'unit_price')::numeric, 0)
                     * coalesce((l.value->>'qty')::numeric, 0))::numeric, 2),
      'unit_price',
      round(coalesce((l.value->>'unit_price')::numeric,
                     case when coalesce((l.value->>'qty')::numeric, 0) > 0
                          then (l.value->>'line_total')::numeric / (l.value->>'qty')::numeric
                          else 0 end)::numeric, 2),
      'qty',
      greatest(coalesce((l.value->>'qty')::numeric, 0)::integer, 1)
    )
  ), '[]'::jsonb) into v_lines
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as l(value);

  v_count := coalesce(jsonb_array_length(v_lines), 0);
  v_auto_line_discounts := array_fill(0::numeric, array[v_count]);
  v_auto_line_rewards := array_fill(0::integer, array[v_count]);
  v_coupon_line_discounts := array_fill(0::numeric, array[v_count]);
  v_coupon_line_rewards := array_fill(0::integer, array[v_count]);

  -- ── 1. Automatic promotions evaluation ────────────────────────────────────
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

    -- Evaluate candidate cleanly with isolated state
    v_eval := public.evaluate_promotion_candidate(v_candidate, v_lines, v_subtotal);
    v_cand_discount := coalesce((v_eval->>'discount')::numeric, 0);

    -- Only select as winner if discount > 0 and strictly better than previous
    if v_cand_discount > 0 and (v_promo.id is null or v_cand_discount > v_auto_discount) then
      v_promo := v_candidate;
      v_auto_discount := v_cand_discount;
      v_auto_id := v_candidate.id;
      v_auto_name := coalesce(nullif(v_candidate.name_en, ''), v_candidate.name_ar);
      v_auto_stack := v_candidate.stackable;
      v_auto_rule_type := v_eval->>'offer_type';
      v_auto_buy_x := (v_eval->>'buy_x')::integer;
      v_auto_get_y := (v_eval->>'get_y')::integer;
      v_auto_reward_qty := (v_eval->>'reward_qty')::integer;

      select coalesce(array_agg(elem::numeric), '{}'::numeric[])
        into v_auto_line_discounts
        from jsonb_array_elements_text(v_eval->'line_discounts') as elem;

      select coalesce(array_agg(elem::integer), '{}'::integer[])
        into v_auto_line_rewards
        from jsonb_array_elements_text(v_eval->'line_rewards') as elem;
    end if;
  end loop;

  -- ── 2. Promo Code / Coupon Mode ───────────────────────────────────────────
  if v_code is not null then
    if p_lock then
      select * into v_coupon_promo from public.promotions
      where mode = 'coupon' and upper(regexp_replace(btrim(code), '\s+', '', 'g')) = v_code
      for update;
    else
      select * into v_coupon_promo from public.promotions
      where mode = 'coupon' and upper(regexp_replace(btrim(code), '\s+', '', 'g')) = v_code;
    end if;

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
      if v_coupon_promo.usage_limit is not null and v_coupon_promo.used_count >= v_coupon_promo.usage_limit then
        raise exception 'Coupon % has been fully used', v_code using errcode = 'check_violation';
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

      -- Evaluate coupon promo using the candidate evaluator
      v_eval := public.evaluate_promotion_candidate(v_coupon_promo, v_lines, v_subtotal);
      v_coupon_discount := coalesce((v_eval->>'discount')::numeric, 0);

      if v_coupon_discount <= 0 then
        raise exception 'Coupon % does not apply to this cart', v_code using errcode = 'check_violation';
      end if;

      v_coupon_promo_id := v_coupon_promo.id;
      v_coupon_promo_name := coalesce(nullif(v_coupon_promo.name_en, ''), v_coupon_promo.name_ar);
      v_coupon_promo_rule_type := v_eval->>'offer_type';
      v_coupon_promo_buy_x := (v_eval->>'buy_x')::integer;
      v_coupon_promo_get_y := (v_eval->>'get_y')::integer;
      v_coupon_promo_reward_qty := (v_eval->>'reward_qty')::integer;

      select coalesce(array_agg(elem::numeric), '{}'::numeric[])
        into v_coupon_line_discounts
        from jsonb_array_elements_text(v_eval->'line_discounts') as elem;

      select coalesce(array_agg(elem::integer), '{}'::integer[])
        into v_coupon_line_rewards
        from jsonb_array_elements_text(v_eval->'line_rewards') as elem;

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
      v_winning_promo_id := coalesce(v_coupon_promo_id, v_auto_id);
      v_winning_promo_name := coalesce(v_coupon_promo_name, v_auto_name);
      v_winning_rule_type := coalesce(v_coupon_promo_rule_type, v_auto_rule_type);
      v_winning_buy_x := coalesce(v_coupon_promo_buy_x, v_auto_buy_x);
      v_winning_get_y := coalesce(v_coupon_promo_get_y, v_auto_get_y);
      v_winning_reward_qty := coalesce(v_coupon_promo_reward_qty, v_auto_reward_qty);
    elsif v_coupon_discount >= v_auto_discount then
      v_auto_discount := 0;
      v_auto_id := null;
      v_auto_name := null;
      v_auto_rule_type := null;
      v_auto_buy_x := null;
      v_auto_get_y := null;
      v_auto_reward_qty := null;
      v_auto_line_discounts := array_fill(0::numeric, array[v_count]);
      v_auto_line_rewards := array_fill(0::integer, array[v_count]);
      v_goods_discount := v_coupon_discount;
      v_code_applied := true;
      v_winning_promo_id := v_coupon_promo_id;
      v_winning_promo_name := v_coupon_promo_name;
      v_winning_rule_type := v_coupon_promo_rule_type;
      v_winning_buy_x := v_coupon_promo_buy_x;
      v_winning_get_y := v_coupon_promo_get_y;
      v_winning_reward_qty := v_coupon_promo_reward_qty;
    else
      v_coupon_discount := 0;
      v_coupon_free_ship := false;
      v_coupon_line_discounts := array_fill(0::numeric, array[v_count]);
      v_coupon_line_rewards := array_fill(0::integer, array[v_count]);
      v_goods_discount := v_auto_discount;
      v_code_applied := false;
      v_winning_promo_id := v_auto_id;
      v_winning_promo_name := v_auto_name;
      v_winning_rule_type := v_auto_rule_type;
      v_winning_buy_x := v_auto_buy_x;
      v_winning_get_y := v_auto_get_y;
      v_winning_reward_qty := v_auto_reward_qty;
    end if;
  elsif v_code is not null then
    v_goods_discount := v_coupon_discount;
    v_code_applied := true;
    v_winning_promo_id := v_coupon_promo_id;
    v_winning_promo_name := v_coupon_promo_name;
    v_winning_rule_type := v_coupon_promo_rule_type;
    v_winning_buy_x := v_coupon_promo_buy_x;
    v_winning_get_y := v_coupon_promo_get_y;
    v_winning_reward_qty := v_coupon_promo_reward_qty;
  else
    v_goods_discount := v_auto_discount;
    v_code_applied := false;
    v_winning_promo_id := v_auto_id;
    v_winning_promo_name := v_auto_name;
    v_winning_rule_type := v_auto_rule_type;
    v_winning_buy_x := v_auto_buy_x;
    v_winning_get_y := v_auto_get_y;
    v_winning_reward_qty := v_auto_reward_qty;
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
  v_shares := array_fill(0::numeric, array[v_count]);
  if v_auto_discount > 0 and v_auto_id is not null then
    for v_item in
      select ordinality - 1 as idx
      from jsonb_array_elements(v_lines) with ordinality
    loop
      v_shares[v_item.idx + 1] := v_shares[v_item.idx + 1] + coalesce(v_auto_line_discounts[v_item.idx + 1], 0);
    end loop;
  end if;

  if v_code_applied and v_coupon_discount > 0 then
    if v_coupon_promo_matched then
      for v_item in
        select ordinality - 1 as idx
        from jsonb_array_elements(v_lines) with ordinality
      loop
        v_shares[v_item.idx + 1] := v_shares[v_item.idx + 1] + coalesce(v_coupon_line_discounts[v_item.idx + 1], 0);
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
      'discounted_unit_price', v_line_disc,
      'rewarded_qty', coalesce(v_auto_line_rewards[v_item.idx + 1], 0) + coalesce(v_coupon_line_rewards[v_item.idx + 1], 0),
      'discount_amount', v_share
    );
  end loop;

  return jsonb_build_object(
    'subtotal', v_subtotal,
    'auto_discount', v_auto_discount,
    'auto_promotion_id', v_auto_id,
    'auto_promotion_name', v_auto_name,
    'auto_promotion_rule_type', v_auto_rule_type,
    'auto_promotion_buy_x', v_auto_buy_x,
    'auto_promotion_get_y', v_auto_get_y,
    'auto_promotion_reward_qty', v_auto_reward_qty,
    'promo_code', v_code,
    'promo_discount', case when v_code is null then 0 else v_coupon_discount end,
    'promo_free_shipping', v_coupon_free_ship,
    'coupon_promotion_id', v_coupon_promo_id,
    'coupon_promotion_name', v_coupon_promo_name,
    'coupon_promotion_rule_type', v_coupon_promo_rule_type,
    'coupon_promotion_buy_x', v_coupon_promo_buy_x,
    'coupon_promotion_get_y', v_coupon_promo_get_y,
    'coupon_promotion_reward_qty', v_coupon_promo_reward_qty,
    'winning_promotion_id', v_winning_promo_id,
    'winning_promotion_name', v_winning_promo_name,
    'winning_rule_type', v_winning_rule_type,
    'winning_buy_x', v_winning_buy_x,
    'winning_get_y', v_winning_get_y,
    'winning_reward_qty', v_winning_reward_qty,
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

grant execute on function public.evaluate_order_pricing_channel to authenticated, anon;

-- Backwards-compatible online wrapper.
create or replace function public.evaluate_order_pricing(
  p_subtotal numeric, p_lines jsonb, p_promo_code text, p_customer_key text,
  p_zone jsonb, p_legacy jsonb, p_delivery_type text, p_lock boolean default false
) returns jsonb language sql security definer set search_path = public as $$
  select public.evaluate_order_pricing_channel(
    p_subtotal, p_lines, p_promo_code, p_customer_key, p_zone, p_legacy,
    p_delivery_type, p_lock, 'online'
  );
$$;

grant execute on function public.evaluate_order_pricing to authenticated, anon;

-- ── pos_complete_sale with authoritative DB pricing & promotion snapshots ──
create or replace function public.pos_complete_sale(
  p_payload jsonb,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_ref      text := p_payload->>'client_ref';
  v_discount_type   text := coalesce(p_payload->>'discount_type', 'none');
  v_discount_value  numeric(14,2) := coalesce((p_payload->>'discount_value')::numeric, 0);
  v_source          text := coalesce(p_payload->>'source', 'pos');

  -- Trusted actor identity derivation (Phase 23 / 0062)
  v_user_id         text;
  v_user_name       text;

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;
  v_variant         public.product_variants%rowtype;
  v_variant_id      uuid;
  v_variant_label   text;

  v_campaign        public.campaigns%rowtype;

  v_subtotal        numeric(14,2) := 0;
  v_discount_percent numeric(8,2) := 0;
  v_approval_id      uuid;
  v_discount_amount numeric(14,2) := 0;
  v_item_discount_type text;
  v_item_discount_value numeric(14,2);
  v_item_discount_total numeric(14,2) := 0;
  v_actual_promo_discount_total numeric(14,2) := 0;
  v_line_gross numeric(14,2);
  v_invoice_base numeric(14,2);
  v_total           numeric(14,2);
  v_pricing_lines   jsonb := '[]'::jsonb;
  v_priced_lines    jsonb := '[]'::jsonb;
  v_priced_line     jsonb;
  v_auto_id         uuid := null;
  v_auto_name       text := null;
  v_auto_discount   numeric(14,2) := 0;
  v_auto_rule_type  text := null;
  v_auto_buy_x      integer := null;
  v_auto_get_y      integer := null;
  v_auto_reward_qty integer := null;
  v_auto_stack      boolean := false;
  v_line_index      integer := 0;
  v_official_unit   numeric(14,2) := 0;
  v_unit_cost       numeric(14,2) := 0;

  v_manual_item_disc numeric(14,2);
  v_promo_line_disc  numeric(14,2);
  v_line_reward_qty  integer;
  v_effective_promo_disc numeric(14,2);
  v_effective_manual_disc numeric(14,2);
  v_line_applied_reward_qty integer;
  v_line_net numeric(14,2);
  v_rewarded_units_json jsonb := '[]'::jsonb;

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
  v_customer_id    uuid;
  v_customer_name  text;
  v_customer_phone text;
  v_shift_id       uuid;

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
  v_pay_status_enum public.payment_status;
begin
  -- ── authorization (Phase 23) ──────────────────────────────
  if not (public.can('sell') or public.can('manage_online_orders')) then
    raise exception 'Not permitted to complete a sale'
      using errcode = 'insufficient_privilege';
  end if;

  -- Derive trusted actor identity from auth.uid()
  if auth.uid() is not null then
    v_user_id := auth.uid()::text;
    select p.name into v_user_name from public.profiles p where p.id = auth.uid();
    if v_user_name is null or btrim(v_user_name) = '' then
      v_user_name := 'System';
    end if;
  else
    v_user_id := coalesce(nullif(p_payload->>'user_id', ''), 'system');
    select p.name into v_user_name from public.profiles p where p.id = nullif(p_payload->>'user_id', '')::uuid;
    if v_user_name is null or btrim(v_user_name) = '' then
      v_user_name := coalesce(nullif(p_payload->>'user_name', ''), 'System');
    end if;
  end if;

  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_source not in ('pos', 'online') then
    raise exception 'Invalid source' using errcode = 'check_violation';
  end if;

  -- ── open-shift requirement (Phase 27 & 0062) ──────────────────────────────
  -- Ensures the open shift belongs exclusively to the current authenticated cashier
  if v_source = 'pos' then
    select id into v_shift_id
    from public.shifts
    where status = 'open'
      and opened_by = v_user_id
    for update;
    if not found then
      raise exception 'Cannot complete a sale: no open shift'
        using errcode = 'no_data_found';
    end if;
  else
    v_shift_id := null;
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

  -- 2. validate lines against live catalog & derive server-authoritative prices
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Invalid quantity' using errcode = 'check_violation';
    end if;

    v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
    v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
    if v_item_discount_type not in ('none', 'percent', 'fixed')
       or v_item_discount_value < 0
       or (v_item_discount_type = 'percent' and v_item_discount_value > 100) then
      raise exception 'Invalid item discount' using errcode = 'check_violation';
    end if;

    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.active or not v_product.stock_tracking_enabled then
      raise exception 'Product % is not sellable', v_product.sku using errcode = 'check_violation';
    end if;

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
      if v_qty > v_variant.stock_quantity then
        raise exception 'Only % of % in stock', v_variant.stock_quantity,
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;

      if v_variant.price_override is not null then
        v_unit := v_variant.price_override;
      else
        v_unit := v_product.selling_price;
        -- Apply campaign discount for parity if not overridden
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
    else
      v_variant_id := null;
      if v_qty > v_product.stock_quantity then
        raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
      end if;
      v_unit := v_product.selling_price;
      -- Apply campaign discount for parity
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

    v_line_gross := round((v_unit * v_qty)::numeric, 2);
    v_pricing_lines := v_pricing_lines || jsonb_build_object(
      'product_id', v_product.id::text,
      'category_id', v_product.category_id::text,
      'variant_id', case when v_variant_id is null then null else v_variant_id::text end,
      'qty', v_qty,
      'unit_price', v_unit,
      'line_total', v_line_gross
    );
    v_subtotal := v_subtotal + v_line_gross;
  end loop;

  -- ── 3. Server-automatic promotion evaluation (POS ONLY) ───────────────────
  -- Online orders have already been frozen and priced authoritatively at placement
  if v_source = 'pos' then
    select coalesce(result->'lines', '[]'::jsonb),
           nullif(result->>'auto_promotion_id', '')::uuid,
           result->>'auto_promotion_name',
           coalesce((result->>'auto_discount')::numeric, 0),
           result->>'auto_promotion_rule_type',
           (result->>'auto_promotion_buy_x')::integer,
           (result->>'auto_promotion_get_y')::integer,
           (result->>'auto_promotion_reward_qty')::integer
      into v_priced_lines, v_auto_id, v_auto_name, v_auto_discount,
           v_auto_rule_type, v_auto_buy_x, v_auto_get_y, v_auto_reward_qty
      from public.evaluate_order_pricing_channel(
        v_subtotal, v_pricing_lines, null, null, '{}'::jsonb, '{}'::jsonb, 'pickup', false, 'pos'
      ) result;

    if v_auto_discount <= 0 then
      v_auto_id := null;
      v_auto_name := null;
      v_auto_discount := 0;
      v_auto_rule_type := null;
      v_auto_buy_x := null;
      v_auto_get_y := null;
      v_auto_reward_qty := null;
      v_auto_stack := false;
    else
      select coalesce(stackable, false) into v_auto_stack
      from public.promotions where id = v_auto_id;
    end if;

    -- Manual discount + promotion non-stacking line calculation
    v_item_discount_total := 0;
    v_actual_promo_discount_total := 0;
    v_rewarded_units_json := '[]'::jsonb;
    v_line_index := 0;

    for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
      v_priced_line := v_priced_lines -> v_line_index;
      v_qty := (v_line->>'qty')::integer;
      v_unit := round(coalesce((v_priced_line->>'unit_price')::numeric, 0), 2);
      v_line_gross := round((v_unit * v_qty)::numeric, 2);

      v_promo_line_disc := coalesce((v_priced_line->>'discount_amount')::numeric, 0);
      v_line_reward_qty := coalesce((v_priced_line->>'rewarded_qty')::integer, 0);

      v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
      v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
      v_manual_item_disc := case
        when v_item_discount_type = 'percent' then round((v_line_gross * v_item_discount_value / 100)::numeric, 2)
        when v_item_discount_type = 'fixed' then least(v_line_gross, round(v_item_discount_value, 2))
        else 0 end;

      -- Non-stacking rule: best saving wins unless promotion is stackable
      if v_auto_stack then
        v_effective_promo_disc := v_promo_line_disc;
        v_effective_manual_disc := least(v_line_gross - v_effective_promo_disc, v_manual_item_disc);
        v_line_applied_reward_qty := v_line_reward_qty;
      else
        if v_promo_line_disc >= v_manual_item_disc then
          v_effective_promo_disc := v_promo_line_disc;
          v_effective_manual_disc := 0;
          v_item_discount_type := 'none';
          v_item_discount_value := 0;
          v_line_applied_reward_qty := v_line_reward_qty;
        else
          v_effective_promo_disc := 0;
          v_effective_manual_disc := v_manual_item_disc;
          v_line_applied_reward_qty := 0;
        end if;
      end if;

      v_item_discount_total := v_item_discount_total + v_effective_manual_disc;
      v_actual_promo_discount_total := v_actual_promo_discount_total + v_effective_promo_disc;

      if v_line_applied_reward_qty > 0 then
        v_rewarded_units_json := v_rewarded_units_json || jsonb_build_object(
          'product_id', v_line->>'product_id',
          'variant_id', v_line->>'variant_id',
          'rewarded_qty', v_line_applied_reward_qty,
          'discount_amount', v_effective_promo_disc
        );
      end if;

      v_line_index := v_line_index + 1;
    end loop;

    -- Authoritative totals: line discounts precede invoice discount
    v_invoice_base := greatest(0, v_subtotal - v_item_discount_total - v_actual_promo_discount_total);
    if v_discount_type = 'percent' then
      v_discount_amount := round((v_invoice_base * v_discount_value / 100)::numeric, 2);
    elsif v_discount_type = 'fixed' then
      v_discount_amount := least(round(v_discount_value::numeric, 2), v_invoice_base);
    else
      v_discount_amount := 0;
    end if;
    v_total := greatest(0, v_invoice_base - v_discount_amount);

    -- Increment automatic promotion used count if applied
    if v_auto_id is not null and v_actual_promo_discount_total > 0 then
      update public.promotions
      set used_count = used_count + 1, updated_at = now()
      where id = v_auto_id;
    end if;

  else
    -- ── ONLINE CONVERSION ───────────────────────────────────────────────────
    -- Preserves exact server-saved order pricing snapshot without double-discounting
    v_auto_id := nullif(p_payload->>'automatic_promotion_id', '')::uuid;
    v_auto_name := nullif(p_payload->>'automatic_promotion_name', '');
    v_actual_promo_discount_total := coalesce((p_payload->>'automatic_discount_amount')::numeric, 0);
    v_auto_rule_type := nullif(p_payload->>'promotion_rule_type', '');
    v_auto_buy_x := (p_payload->>'promotion_buy_x')::integer;
    v_auto_get_y := (p_payload->>'promotion_get_y')::integer;
    v_auto_reward_qty := (p_payload->>'promotion_reward_qty')::integer;
    v_rewarded_units_json := coalesce(p_payload->'promotion_rewarded_units', '[]'::jsonb);

    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
    v_total := round((v_subtotal - v_discount_amount)::numeric, 2);
  end if;

  -- ── approval limits, enforced here and not in the browser (Phase 24) ──────
  v_discount_percent := case
    when v_subtotal > 0 then round(((v_discount_amount + v_item_discount_total) * 100.0 / v_subtotal)::numeric, 2)
    else 0
  end;

  if public.approval_required_for('discount', v_discount_percent) then
    if p_approval_request_id is not null then
      v_approval_id := p_approval_request_id;
    elsif coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    v_approval_id := public.approval_assert_satisfied(
      'discount', v_discount_percent, v_approval_id, '{}'::jsonb
    );
  end if;

  -- 6. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
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

  -- ── customer linkage (Phase 27) ─────────────────────────────────────────
  v_customer_id := case
    when coalesce(btrim(p_payload ->> 'customer_id'), '') ~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (p_payload ->> 'customer_id')::uuid
    else null
  end;
  if v_customer_id is not null
     and not exists (select 1 from public.customers where id = v_customer_id) then
    v_customer_id := null;
  end if;
  v_customer_name  := nullif(btrim(coalesce(p_payload ->> 'customer_name', '')), '');
  v_customer_phone := nullif(btrim(coalesce(p_payload ->> 'customer_phone', '')), '');
  if v_customer_id is not null then
    select c.name, c.phone into v_customer_name, v_customer_phone
      from public.customers c where c.id = v_customer_id;
  end if;

  -- 7. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, item_discount_amount, total_discount_amount,
    automatic_discount_amount, automatic_promotion_id, automatic_promotion_name,
    promotion_rule_type, promotion_buy_x, promotion_get_y, promotion_reward_qty, promotion_rewarded_units,
    total, amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source, customer_id, customer_name, customer_phone, shift_id
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_item_discount_total,
    v_item_discount_total + v_actual_promo_discount_total + v_discount_amount,
    v_actual_promo_discount_total,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_id else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_name else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_rule_type else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_buy_x else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_get_y else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_auto_reward_qty else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_rewarded_units_json else null end,
    v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end,
    v_source,
    v_customer_id, v_customer_name, v_customer_phone,
    v_shift_id
  ) returning id into v_sale_id;

  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_sale_id::text);
  end if;

  -- 8. payment rows
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
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

  -- 9. sale items + stock deduction + stock movements
  v_line_index := 0;
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_source = 'pos' then
      v_priced_line := v_priced_lines -> v_line_index;
      v_unit := round(coalesce((v_priced_line->>'unit_price')::numeric, 0), 2);
      v_line_gross := round((v_unit * v_qty)::numeric, 2);

      v_promo_line_disc := coalesce((v_priced_line->>'discount_amount')::numeric, 0);
      v_line_reward_qty := coalesce((v_priced_line->>'rewarded_qty')::integer, 0);

      v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
      v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
      v_manual_item_disc := case
        when v_item_discount_type = 'percent' then round((v_line_gross * v_item_discount_value / 100)::numeric, 2)
        when v_item_discount_type = 'fixed' then least(v_line_gross, round(v_item_discount_value, 2))
        else 0 end;

      if v_auto_stack then
        v_effective_promo_disc := v_promo_line_disc;
        v_effective_manual_disc := least(v_line_gross - v_effective_promo_disc, v_manual_item_disc);
        v_line_applied_reward_qty := v_line_reward_qty;
      else
        if v_promo_line_disc >= v_manual_item_disc then
          v_effective_promo_disc := v_promo_line_disc;
          v_effective_manual_disc := 0;
          v_item_discount_type := 'none';
          v_item_discount_value := 0;
          v_line_applied_reward_qty := v_line_reward_qty;
        else
          v_effective_promo_disc := 0;
          v_effective_manual_disc := v_manual_item_disc;
          v_line_applied_reward_qty := 0;
        end if;
      end if;
      v_line_net := v_line_gross - (v_effective_promo_disc + v_effective_manual_disc);
    else
      -- Online conversion line pricing
      select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
      if v_product.variants_enabled then
        v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
        select * into v_variant from public.product_variants where id = v_variant_id;
        v_unit := coalesce(v_variant.price_override, v_product.selling_price);
      else
        v_unit := v_product.selling_price;
      end if;
      v_line_gross := round((v_unit * v_qty)::numeric, 2);
      v_line_net := v_line_gross;
      v_effective_manual_disc := 0;
      v_effective_promo_disc := 0;
      v_line_applied_reward_qty := 0;
      v_item_discount_type := 'none';
      v_item_discount_value := 0;
    end if;

    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      v_official_unit := coalesce(v_variant.price_override, v_product.selling_price);
      v_unit_cost := round(coalesce(v_variant.cost_override, v_product.cost_price, 0)::numeric, 2);
      v_variant_label := coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                                      v_variant.size, v_variant.size_label), v_variant.sku);

      insert into public.sale_items (
        sale_id, product_id, variant_id,
        variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, gross_total, line_total,
        discount_type, discount_value, discount_amount,
        automatic_promotion_id, automatic_promotion_name, automatic_discount_amount,
        rewarded_qty, promotion_rule_type, unit_cost
      ) values (
        v_sale_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        v_official_unit, v_qty,
        v_line_gross, v_line_net,
        v_item_discount_type::public.discount_type, v_item_discount_value, v_effective_manual_disc,
        case when v_effective_promo_disc > 0 then v_auto_id else null end,
        case when v_effective_promo_disc > 0 then v_auto_name else null end,
        v_effective_promo_disc,
        v_line_applied_reward_qty,
        case when v_effective_promo_disc > 0 then v_auto_rule_type else null end,
        v_unit_cost
      );

      v_before := v_variant.stock_quantity;
      update public.product_variants
         set stock_quantity = stock_quantity - v_qty, updated_at = now()
       where id = v_variant.id;

      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_qty, v_before, v_before - v_qty, 'issue', 'other',
        case when v_source = 'online'
             then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
             else 'Sale ' || v_sale_number
        end,
        v_user_id, v_user_name);
    else
      v_official_unit := v_product.selling_price;
      v_unit_cost := round(coalesce(v_product.cost_price, 0)::numeric, 2);

      insert into public.sale_items (
        sale_id, product_id, name_ar, name_en, sku, barcode,
        unit_price, quantity, gross_total, line_total,
        discount_type, discount_value, discount_amount,
        automatic_promotion_id, automatic_promotion_name, automatic_discount_amount,
        rewarded_qty, promotion_rule_type, unit_cost
      ) values (
        v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
        v_product.barcode, v_official_unit, v_qty,
        v_line_gross, v_line_net,
        v_item_discount_type::public.discount_type, v_item_discount_value, v_effective_manual_disc,
        case when v_effective_promo_disc > 0 then v_auto_id else null end,
        case when v_effective_promo_disc > 0 then v_auto_name else null end,
        v_effective_promo_disc,
        v_line_applied_reward_qty,
        case when v_effective_promo_disc > 0 then v_auto_rule_type else null end,
        v_unit_cost
      );

      v_before := v_product.stock_quantity;
      update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

      insert into public.stock_movements (
        product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
      ) values (
        v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
        case when v_source = 'online'
             then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
             else 'Sale ' || v_sale_number
        end,
        v_user_id, v_user_name);
    end if;

    v_line_index := v_line_index + 1;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

grant execute on function public.pos_complete_sale(jsonb, uuid) to authenticated;

-- ── place_online_order with unified promotions & coupons ───────────────────
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
  v_zone_id        uuid := nullif(p_payload->>'delivery_zone_id', '')::uuid;
  v_settings       jsonb;
  v_delivery_fee   numeric(14,2) := 0;
  v_city           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'city', '')), '\s+', ' ', 'g'));
  v_area           text := lower(regexp_replace(btrim(coalesce(p_payload->'address'->>'area', '')), '\s+', ' ', 'g'));
  v_zone           public.delivery_zones%rowtype;
  v_zone_json      jsonb := null;
  v_legacy_json    jsonb;
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

      if v_city = ''
         or v_area = ''
         or coalesce(btrim(p_payload->'address'->>'street'), '') = '' then
        raise exception 'A delivery address is required' using errcode = 'check_violation';
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
    promotion_rule_type, promotion_buy_x, promotion_get_y, promotion_reward_qty
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
    v_winning_reward_qty
  ) returning id, order_number into v_order_id, v_order_number;

  -- 6. Atomic increment of coupon used count if promo code applied
  if (v_core->>'promo_code') is not null
     and (((v_core->>'promo_discount')::numeric > 0)
          or coalesce((v_core->>'promo_free_shipping')::boolean, false)) then
    if v_coupon_promo_id is not null then
      update public.promotions
      set used_count = used_count + 1, updated_at = now()
      where id = v_coupon_promo_id
        and (usage_limit is null or used_count < usage_limit);

      if not found then
        raise exception 'Coupon % has been fully used', v_coupon_code using errcode = 'check_violation';
      end if;
    else
      update public.coupons
      set used_count = used_count + 1, updated_at = now()
      where code = (v_core->>'promo_code')
        and (usage_limit is null or used_count < usage_limit);

      if not found then
        raise exception 'Coupon % has been fully used', v_coupon_code using errcode = 'check_violation';
      end if;

      insert into public.promo_code_usages (coupon_id, order_id, customer_key)
      select c.id, v_order_id, v_customer_key
      from public.coupons c where c.code = (v_core->>'promo_code');
    end if;
  end if;

  -- Increment automatic promotion used count if applied
  if v_auto_promo_id is not null and (v_core->>'auto_discount')::numeric > 0 then
    update public.promotions
    set used_count = used_count + 1, updated_at = now()
    where id = v_auto_promo_id
      and (usage_limit is null or used_count < usage_limit);
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

-- ── resolve_online_order with strict role enforcement & stock reversal ─────
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

  -- Trusted actor identity derivation from auth.uid() (Phase 23 / 0062)
  v_user_id     text;
  v_user_name   text;

  v_goods_total numeric(14,2);
  v_list_total  numeric(14,2);
  v_sale_discount numeric(14,2);
  v_result      jsonb;
  v_reservation record;
  v_status      public.online_order_status;
begin
  if auth.uid() is not null then
    v_user_id := auth.uid()::text;
    select p.name into v_user_name from public.profiles p where p.id = auth.uid();
    if v_user_name is null or btrim(v_user_name) = '' then
      v_user_name := 'System';
    end if;
  else
    v_user_id := coalesce(nullif(p_payload->>'user_id', ''), 'system');
    select p.name into v_user_name from public.profiles p where p.id = nullif(p_payload->>'user_id', '')::uuid;
    if v_user_name is null or btrim(v_user_name) = '' then
      v_user_name := coalesce(nullif(p_payload->>'user_name', ''), 'System');
    end if;
  end if;

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
    if v_order.payment_method = 'instapay' and v_order.payment_status <> 'paid' then
      raise exception 'Verify the InstaPay payment before approving this order'
        using errcode = 'check_violation';
    end if;

    -- The sale covers merchandise; the delivery fee stays on the order
    v_goods_total := round((v_order.subtotal - v_order.discount_amount)::numeric, 2);

    select coalesce(sum(round((coalesce(v.price_override, p.selling_price) * i.quantity)::numeric, 2)), 0)
      into v_list_total
    from public.online_order_items i
    join public.products p on p.id = i.product_id
    left join public.product_variants v on v.id = i.variant_id
    where i.order_id = v_order.id;

    v_sale_discount := greatest(round((v_list_total - v_goods_total)::numeric, 2), 0);

    -- Pass frozen order snapshot to pos_complete_sale with source='online'
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
      'automatic_promotion_id', v_order.automatic_promotion_id,
      'automatic_promotion_name', v_order.automatic_promotion_name,
      'automatic_discount_amount', v_order.automatic_discount_amount,
      'promotion_rule_type', v_order.promotion_rule_type,
      'promotion_buy_x', v_order.promotion_buy_x,
      'promotion_get_y', v_order.promotion_get_y,
      'promotion_reward_qty', v_order.promotion_reward_qty,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'qty', i.quantity,
                                            'variant_id', i.variant_id))
        from public.online_order_items i where i.order_id = v_order.id
      ), '[]'::jsonb),
      'payments', jsonb_build_array(jsonb_build_object(
        'method', case when v_order.payment_method = 'cod' then 'cod' else 'instapay' end,
        'amount', v_goods_total,
        'status', case when v_order.payment_status = 'paid' then 'paid' else 'pending' end
      ))
    ));

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

    -- If approved and converted to a sale, atomically reverse stock and create stock movements via pos_void_sale
    if v_order.sale_id is not null then
      if not public.can('void_sale') then
        raise exception 'This order was approved and became sale %; only a manager can cancel it',
          coalesce(v_order.sale_number, '') using errcode = '42501';
      end if;

      perform public.pos_void_sale(
        v_order.sale_id,
        v_user_id,
        v_user_name,
        'Online order ' || v_order.order_number || ' cancelled: ' || v_reason
      );
    end if;

    -- Release any remaining reservations
    update public.stock_reservations
    set status = 'released'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    -- Safe coupon & promotion lifecycle: release consumed count
    if v_order.discount_code is not null then
      update public.promotions
      set used_count = greatest(0, used_count - 1), updated_at = now()
      where mode = 'coupon'
        and upper(regexp_replace(btrim(code), '\s+', '', 'g')) = upper(regexp_replace(btrim(v_order.discount_code), '\s+', '', 'g'));

      update public.coupons
      set used_count = greatest(0, used_count - 1), updated_at = now()
      where code = v_order.discount_code;
    end if;

    if v_order.automatic_promotion_id is not null then
      update public.promotions
      set used_count = greatest(0, used_count - 1), updated_at = now()
      where id = v_order.automatic_promotion_id;
    end if;

    update public.online_orders
    set status = 'cancelled'::public.online_order_status,
        cancellation_reason = v_reason,
        cancelled_by = auth.uid(),
        cancelled_by_name = v_user_name,
        cancelled_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'cancelled'::public.order_event_kind,
            'Order cancelled: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.cancelled', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'had_sale', v_order.sale_id is not null),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'cancelled');
  end if;

  if v_action in ('processing', 'ready', 'complete') then
    v_status := case v_action
      when 'processing' then 'processing'::public.online_order_status
      when 'ready' then 'ready'::public.online_order_status
      else 'completed'::public.online_order_status
    end;

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
    set status = v_status,
        completed_at = case when v_status = 'completed'::public.online_order_status
                            then now() else completed_at end,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, v_status::text::public.order_event_kind,
            initcap(v_action) || ' by ' || v_user_name, auth.uid(), v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', v_status::text);
  end if;

  raise exception 'Unknown action %', coalesce(v_action, '(none)') using errcode = 'check_violation';
end;
$$;

revoke execute on function public.resolve_online_order(jsonb) from public, anon;
grant execute on function public.resolve_online_order(jsonb) to authenticated;

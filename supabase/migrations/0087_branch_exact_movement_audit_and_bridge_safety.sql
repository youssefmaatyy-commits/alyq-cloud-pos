-- 0087 — Branch-exact movement audit values (B2) + no silent default-branch
-- fallback in the legacy stock bridge (B1).
--
-- Source: BRANCH_INVENTORY_AUDIT_REPORT.md, findings B1 (MEDIUM) and B2 (HIGH).
-- Forward-only. Does not touch 0001–0086. Does not redesign the inventory
-- architecture: sale/return still mutate stock through the legacy
-- products/product_variants.stock_quantity columns and the 0078 bridge
-- triggers into branch_stock_balances — that mutation path is already correct
-- and is left unchanged. Only two things change:
--
--   B2 (HIGH, audit-trail accuracy only — not a stock-correctness bug):
--     pos_complete_sale's and pos_process_return's stock_movements inserts did
--     not set `source_type`, so the existing (unchanged) BEFORE INSERT trigger
--     `zz_stock_movement_branch_snapshot` (0078) never corrected their
--     `quantity_before`/`quantity_after` from the legacy rollup columns to the
--     exact branch shelf. Every other writer (transfer, adjustment, stocktake)
--     already sets `source_type` and already gets the correct branch-scoped
--     values from that trigger. The fix is additive: add
--     `source_type, source_id, reference` to the two stock_movements inserts
--     in the sale and return cores, with every other line of business logic
--     byte-for-byte identical to the last full rewrite of each function before
--     0072 renamed it into the wrapper chain (sale: 0062_central_promotions.sql
--     — the authoritative-pricing/promotion rewrite, not the earlier 0055
--     body, which 0062 fully superseded; return: 0067_return_idempotency.sql).
--     No new trigger, no schema change, no behavioural change to the actual
--     stock quantities.
--
--   B1 (MEDIUM): `variant_stock_bridge_to_branch()` and
--     `product_stock_bridge_to_branch()` (0078) silently fell back to the
--     installation's default active branch when `current_branch_id()` was
--     null, instead of failing. No RPC in the live call graph can currently
--     reach that fallback (every caller already requires a non-null active
--     branch earlier in the same transaction), but it is a latent trap for any
--     future direct write to the legacy stock_quantity columns. The fix
--     removes the fallback and raises a controlled 42501 error instead,
--     matching the "An active branch session is required" wording already
--     used by inventory_adjust_stock/inventory_transfer_stock. Opening-stock
--     triggers (`product_opening_branch_stock` / `variant_opening_branch_stock`,
--     fired on product/variant CREATION, not on existing-stock mutation) and
--     the generic `stamp_branch_scope()` catch-all are deliberately left
--     untouched — they were not part of the cited B1 finding and are
--     legitimate initialization paths, not the mutation path this fix targets.

-- ═══════════════════════════════════════════════════════════════════════════
-- B1 — fail loudly instead of silently choosing a default branch.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.variant_stock_bridge_to_branch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid;
  v_delta integer;
begin
  if new.stock_quantity is not distinct from old.stock_quantity
     or current_setting('alyq.branch_stock_rollup',true)=new.id::text then
    return null;
  end if;
  v_delta := new.stock_quantity-old.stock_quantity;
  v_branch := public.current_branch_id();
  -- 0087 (B1): a missing active branch is now a hard failure. The previous
  -- fallback to "the installation's default active branch" meant a legacy
  -- stock_quantity write made with no branch context would silently land on
  -- the wrong shelf instead of failing. Every caller in the live call graph
  -- already requires a non-null current_branch_id() earlier in the same
  -- transaction (pos_complete_sale, pos_process_return, inventory_adjust_stock,
  -- inventory_transfer_stock all raise first), so this is not reachable from
  -- any existing flow — it only closes the trap for a future direct write.
  if v_branch is null then
    raise exception 'An active branch session is required to adjust legacy variant stock' using errcode='42501';
  end if;
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_branch,new.product_id,new.id,0,greatest(new.low_stock_level,0))
  on conflict (branch_id,variant_id) where variant_id is not null do nothing;
  update public.branch_stock_balances
     set quantity=quantity+v_delta
   where branch_id=v_branch and variant_id=new.id;
  return null;
end
$function$;

create or replace function public.product_stock_bridge_to_branch()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid;
  v_delta integer;
begin
  if new.variants_enabled
     or new.stock_quantity is not distinct from old.stock_quantity
     or current_setting('alyq.branch_stock_rollup',true)=new.id::text
     or current_setting('alyq.variant_rollup_product',true)=new.id::text then
    return null;
  end if;
  v_delta := new.stock_quantity-old.stock_quantity;
  v_branch := public.current_branch_id();
  -- 0087 (B1): same hard failure as variant_stock_bridge_to_branch() above —
  -- no silent default-branch fallback for an existing-stock mutation.
  if v_branch is null then
    raise exception 'An active branch session is required to adjust legacy product stock' using errcode='42501';
  end if;
  insert into public.branch_stock_balances(branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_branch,new.id,null,0,greatest(new.low_stock_level,0))
  on conflict (branch_id,product_id) where variant_id is null do nothing;
  update public.branch_stock_balances
     set quantity=quantity+v_delta
   where branch_id=v_branch and product_id=new.id and variant_id is null;
  return null;
end
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B2 — branch-exact stock_movements.quantity_before / quantity_after for
-- sale and return. Both functions below are byte-for-byte the 0055 / 0067
-- bodies (same validation, pricing, idempotency, locking, approval and
-- customer-linkage logic) with one addition: the stock_movements inserts now
-- carry `source_type, source_id, reference`, which lets the existing
-- `zz_stock_movement_branch_snapshot` trigger (0078, unchanged) overwrite the
-- before/after figures with the exact branch_stock_balances row for this
-- branch + product + variant instead of leaving the pre-0078 global rollup
-- figures the functions compute locally.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.pos_complete_sale_core_0072(
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
  v_pos_promo_code  text := null;
  v_coupon_id       uuid := null;
  v_coupon_name     text := null;
  v_coupon_discount numeric(14,2) := 0;
  v_coupon_rule_type text := null;
  v_coupon_buy_x    integer := null;
  v_coupon_get_y    integer := null;
  v_coupon_reward_qty integer := null;
  v_winning_id      uuid := null;
  v_winning_name    text := null;
  v_winning_rule_type text := null;
  v_winning_buy_x   integer := null;
  v_winning_get_y   integer := null;
  v_winning_reward_qty integer := null;
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

    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;
    if not found then
      raise exception 'Product % not found', v_line->>'product_id' using errcode = 'foreign_key_violation';
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
      if v_source = 'pos' and not v_variant.active then
        raise exception '% is no longer sold',
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
      if v_source = 'pos' and v_qty > v_variant.stock_quantity then
        raise exception 'Only % of % in stock', v_variant.stock_quantity,
          coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                       v_variant.size, v_variant.size_label), v_variant.sku)
          using errcode = 'check_violation';
      end if;
    else
      v_variant_id := null;
      if v_source = 'pos' and v_qty > v_product.stock_quantity then
        raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
      end if;
    end if;

    if v_source = 'pos' then
      v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
      v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
      if v_item_discount_type not in ('none', 'percent', 'fixed')
         or v_item_discount_value < 0
         or (v_item_discount_type = 'percent' and v_item_discount_value > 100) then
        raise exception 'Invalid item discount' using errcode = 'check_violation';
      end if;

      if not v_product.active or not v_product.stock_tracking_enabled then
        raise exception 'Product % is not sellable', v_product.sku using errcode = 'check_violation';
      end if;

      if v_product.variants_enabled then
        if v_variant.price_override is not null then
          v_unit := v_variant.price_override;
        else
          v_unit := v_product.selling_price;
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
        v_unit := v_product.selling_price;
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

    else
      -- ── ONLINE CONVERSION: Use frozen price snapshot from online_order_items (or catalogue fallback) ──
      if v_line->>'unit_price' is not null then
        v_unit := round((v_line->>'unit_price')::numeric, 2);
      elsif v_product.variants_enabled and v_variant.price_override is not null then
        v_unit := v_variant.price_override;
      else
        v_unit := v_product.selling_price;
      end if;
      v_line_gross := round((v_unit * v_qty)::numeric, 2);
      v_subtotal := v_subtotal + v_line_gross;
    end if;
  end loop;

  -- ── 3. Promotion & Coupon evaluation (POS ONLY) ───────────────────────────
  if v_source = 'pos' then
    v_pos_promo_code := nullif(upper(regexp_replace(btrim(coalesce(p_payload->>'coupon_code', p_payload->>'promo_code', '')), '\s+', '', 'g')), '');
    v_customer_phone := nullif(btrim(coalesce(p_payload ->> 'customer_phone', '')), '');

    select coalesce(result->'lines', '[]'::jsonb),
           nullif(result->>'auto_promotion_id', '')::uuid,
           result->>'auto_promotion_name',
           coalesce((result->>'auto_discount')::numeric, 0),
           result->>'auto_promotion_rule_type',
           (result->>'auto_promotion_buy_x')::integer,
           (result->>'auto_promotion_get_y')::integer,
           (result->>'auto_promotion_reward_qty')::integer,
           nullif(result->>'coupon_promotion_id', '')::uuid,
           result->>'coupon_promotion_name',
           coalesce((result->>'promo_discount')::numeric, 0),
           result->>'coupon_promotion_rule_type',
           (result->>'coupon_promotion_buy_x')::integer,
           (result->>'coupon_promotion_get_y')::integer,
           (result->>'coupon_promotion_reward_qty')::integer,
           nullif(result->>'winning_promotion_id', '')::uuid,
           result->>'winning_promotion_name',
           result->>'winning_rule_type',
           (result->>'winning_buy_x')::integer,
           (result->>'winning_get_y')::integer,
           (result->>'winning_reward_qty')::integer
      into v_priced_lines,
           v_auto_id, v_auto_name, v_auto_discount,
           v_auto_rule_type, v_auto_buy_x, v_auto_get_y, v_auto_reward_qty,
           v_coupon_id, v_coupon_name, v_coupon_discount,
           v_coupon_rule_type, v_coupon_buy_x, v_coupon_get_y, v_coupon_reward_qty,
           v_winning_id, v_winning_name, v_winning_rule_type,
           v_winning_buy_x, v_winning_get_y, v_winning_reward_qty
      from public.evaluate_order_pricing_channel(
        v_subtotal, v_pricing_lines, v_pos_promo_code, v_customer_phone, '{}'::jsonb, '{}'::jsonb, 'pickup', true, 'pos'
      ) result;

    if v_winning_id is not null then
      select coalesce(stackable, false) into v_auto_stack
      from public.promotions where id = v_winning_id;
    else
      v_auto_stack := false;
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

    -- Atomic consumption of coupon / promo used_count upon successful sale
    if v_coupon_id is not null and v_coupon_discount > 0 and v_actual_promo_discount_total > 0 then
      update public.promotions
      set used_count = used_count + 1, updated_at = now()
      where id = v_coupon_id
        and (usage_limit is null or used_count < usage_limit);

      if not found and exists (
        select 1 from public.promotions
        where id = v_coupon_id and usage_limit is not null and used_count >= usage_limit
      ) then
        raise exception 'Coupon has already reached its usage limit' using errcode = 'check_violation';
      end if;
    elsif v_pos_promo_code is not null and v_coupon_discount > 0 and v_actual_promo_discount_total > 0 then
      update public.coupons
      set used_count = used_count + 1, updated_at = now()
      where code = v_pos_promo_code
        and (usage_limit is null or used_count < usage_limit);

      if not found and exists (
        select 1 from public.coupons
        where code = v_pos_promo_code and usage_limit is not null and used_count >= usage_limit
      ) then
        raise exception 'Coupon has already reached its usage limit' using errcode = 'check_violation';
      end if;
    end if;

    if v_auto_id is not null and v_auto_discount > 0 and v_actual_promo_discount_total > 0 and (v_coupon_id is null or v_auto_id <> v_coupon_id) then
      update public.promotions
      set used_count = used_count + 1, updated_at = now()
      where id = v_auto_id
        and (usage_limit is null or used_count < usage_limit);
    end if;

  else
    -- ── ONLINE CONVERSION ───────────────────────────────────────────────────
    -- Preserves exact server-saved order pricing snapshot without double-discounting
    v_winning_id := nullif(p_payload->>'automatic_promotion_id', '')::uuid;
    v_winning_name := nullif(p_payload->>'automatic_promotion_name', '');
    v_actual_promo_discount_total := coalesce((p_payload->>'automatic_discount_amount')::numeric, 0);
    v_winning_rule_type := nullif(p_payload->>'promotion_rule_type', '');
    v_winning_buy_x := (p_payload->>'promotion_buy_x')::integer;
    v_winning_get_y := (p_payload->>'promotion_get_y')::integer;
    v_winning_reward_qty := (p_payload->>'promotion_reward_qty')::integer;
    v_rewarded_units_json := coalesce(p_payload->'promotion_rewarded_units', '[]'::jsonb);

    v_discount_amount := 0;
    v_total := round((v_subtotal - v_actual_promo_discount_total)::numeric, 2);
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
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_id else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_name else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_rule_type else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_buy_x else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_get_y else null end,
    case when v_actual_promo_discount_total > 0 or v_source = 'online' then v_winning_reward_qty else null end,
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
      -- Online conversion: use frozen line snapshot directly (or catalogue fallback)
      if v_line->>'unit_price' is not null then
        v_unit := round((v_line->>'unit_price')::numeric, 2);
      elsif v_product.variants_enabled and v_variant.price_override is not null then
        v_unit := v_variant.price_override;
      else
        v_unit := v_product.selling_price;
      end if;
      v_line_gross := round((v_unit * v_qty)::numeric, 2);
      v_effective_manual_disc := 0;
      v_effective_promo_disc := round(coalesce((v_line->>'automatic_discount_amount')::numeric, (v_line->>'discount_amount')::numeric, 0)::numeric, 2);
      v_line_net := v_line_gross - v_effective_promo_disc;
      v_line_applied_reward_qty := coalesce((v_line->>'rewarded_qty')::integer, 0);
      v_winning_rule_type := v_line->>'promotion_rule_type';
      v_item_discount_type := 'none';
      v_item_discount_value := 0;
    end if;

    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    if v_product.variants_enabled then
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      v_official_unit := v_unit;
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
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(nullif(v_line->>'automatic_promotion_id', '')::uuid, v_winning_id) else null end,
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(v_line->>'automatic_promotion_name', v_winning_name) else null end,
        v_effective_promo_disc,
        v_line_applied_reward_qty,
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(v_line->>'promotion_rule_type', v_winning_rule_type) else null end,
        v_unit_cost
      );

      v_before := v_variant.stock_quantity;
      update public.product_variants
         set stock_quantity = stock_quantity - v_qty, updated_at = now()
       where id = v_variant.id;

      insert into public.stock_movements (
        product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
        delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name,
        source_type, source_id, reference
      ) values (
        v_product.id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
        v_qty, v_before, v_before - v_qty, 'issue', 'other',
        case when v_source = 'online'
             then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
             else 'Sale ' || v_sale_number
        end,
        v_user_id, v_user_name,
        -- 0087: source_type/source_id let zz_stock_movement_branch_snapshot (0078)
        -- overwrite quantity_before/quantity_after with the EXACT branch shelf
        -- figures at insert time, fixing audit finding B2 (the values above were
        -- the pre-0078 global rollup, not this branch's balance).
        'sale', v_sale_id, v_sale_number);
    else
      v_official_unit := v_unit;
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
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(nullif(v_line->>'automatic_promotion_id', '')::uuid, v_winning_id) else null end,
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(v_line->>'automatic_promotion_name', v_winning_name) else null end,
        v_effective_promo_disc,
        v_line_applied_reward_qty,
        case when v_effective_promo_disc > 0 or v_source = 'online' then coalesce(v_line->>'promotion_rule_type', v_winning_rule_type) else null end,
        v_unit_cost
      );

      v_before := v_product.stock_quantity;
      update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

      insert into public.stock_movements (
        product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name,
        source_type, source_id, reference
      ) values (
        v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
        case when v_source = 'online'
             then 'Online order ' || coalesce(p_payload->>'order_number', '') || ' · Sale ' || v_sale_number
             else 'Sale ' || v_sale_number
        end,
        v_user_id, v_user_name,
        -- 0087: see the variant branch above — same branch-exact audit fix (B2).
        'sale', v_sale_id, v_sale_number);
    end if;

    v_line_index := v_line_index + 1;
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

create or replace function public.pos_process_return_core_0072(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale             public.sales%rowtype;
  v_line             jsonb;
  v_return_line      jsonb;
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
  v_refund_cents     bigint;
  v_ceiling_cents    bigint;
  v_before_cents     bigint;
  v_after_cents      bigint;
  v_base_cents       bigint;
  v_high_count       integer;
  v_low_count        integer;
  v_refund_method    text := coalesce(p_payload->>'refund_method', 'cash');
  v_refund_status    text := coalesce(p_payload->>'refund_status', 'completed');
  v_reason           text := btrim(coalesce(p_payload->>'reason', ''));
  v_user_id          text := p_payload->>'user_id';
  v_user_name        text := p_payload->>'user_name';
  v_product          public.products%rowtype;
  v_variant          public.product_variants%rowtype;
  v_ceiling          numeric(14,2);
  v_allocation_ok    boolean;
  v_refund_lines     jsonb := '[]'::jsonb;
  v_client_ref       text := nullif(btrim(coalesce(p_payload->>'client_ref', '')), '');
  v_existing_return_id uuid;
  v_existing_refund_id uuid;
  v_existing_refund_total numeric(14,2);
begin
  if not public.can('process_return') then
    raise exception 'Not permitted to process a return' using errcode = 'insufficient_privilege';
  end if;

  -- A client/network retry names the exact original return. This check occurs
  -- before counters, stock, or money move; a duplicate request is therefore a
  -- read-only replay of its original outcome.
  if v_client_ref is not null then
    select r.id, f.id, f.amount
      into v_existing_return_id, v_existing_refund_id, v_existing_refund_total
      from public.sales_returns r
      join public.refund_records f on f.return_id = r.id
     where r.client_ref = v_client_ref
     order by f.created_at
     limit 1;
    if found then
      return jsonb_build_object('return_id', v_existing_return_id, 'refund_id', v_existing_refund_id, 'refund_amount', v_existing_refund_total);
    end if;
  end if;

  if v_reason = '' then
    raise exception 'Return reason is required' using errcode = 'check_violation';
  end if;
  if v_refund_method not in ('cash', 'visa', 'instapay') then
    raise exception 'Invalid refund method' using errcode = 'check_violation';
  end if;
  if v_refund_status not in ('pending', 'completed') then
    raise exception 'Invalid refund status' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(coalesce(p_payload->'items', '[]'::jsonb)) = 0 then
    raise exception 'No items to return' using errcode = 'check_violation';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_payload->'items') i(value)
     group by i.value->>'sale_item_id'
    having count(*) > 1
  ) then
    raise exception 'A sale item may be returned only once per request' using errcode = 'check_violation';
  end if;

  select * into v_sale from public.sales where id = (p_payload->>'sale_id')::uuid for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Voided sales cannot be returned' using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_refunded_so_far
    from public.refund_records
   where sale_id = v_sale.id and status <> 'rejected';

  -- Validate and calculate every request before counters, stock or money move.
  for v_line in select * from jsonb_array_elements(p_payload->'items')
  loop
    v_qty := (v_line->>'quantity')::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Return quantity must be a positive whole number' using errcode = 'check_violation';
    end if;

    select * into v_sale_item from public.sale_items
     where id = (v_line->>'sale_item_id')::uuid and sale_id = v_sale.id
     for update;
    if not found then
      raise exception 'Sale item not found on this invoice' using errcode = 'foreign_key_violation';
    end if;

    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id
       and ri.sale_item_id = v_sale_item.id
       and r.refund_status <> 'rejected';
    if v_qty > v_sale_item.quantity - v_already_returned then
      raise exception 'Return quantity exceeds remaining returnable quantity for %', v_sale_item.sku
        using errcode = 'check_violation';
    end if;

    v_ceiling := v_sale_item.refundable_total;
    v_allocation_ok := v_ceiling is not null;
    if not v_allocation_ok then
      select refundable_total, allocation_available into v_ceiling, v_allocation_ok
        from public.sale_refund_allocation(v_sale.id)
       where sale_item_id = v_sale_item.id;
    end if;
    if not coalesce(v_allocation_ok, false) or v_ceiling is null then
      raise exception 'Refund allocation requires invoice review before this sale can be returned'
        using errcode = 'check_violation';
    end if;

    v_ceiling_cents := round(v_ceiling * 100)::bigint;
    v_before_cents := floor((v_ceiling_cents::numeric * v_already_returned) / v_sale_item.quantity)::bigint;
    v_after_cents := floor((v_ceiling_cents::numeric * (v_already_returned + v_qty)) / v_sale_item.quantity)::bigint;
    v_refund_cents := v_after_cents - v_before_cents;
    if v_refund_cents < 0 then
      raise exception 'Invalid refund allocation' using errcode = 'check_violation';
    end if;

    v_refund_total := v_refund_total + (v_refund_cents::numeric / 100);
    v_refund_lines := v_refund_lines || jsonb_build_object(
      'sale_item_id', v_sale_item.id::text,
      'quantity', v_qty,
      'already_returned', v_already_returned,
      'ceiling_cents', v_ceiling_cents,
      'refund_cents', v_refund_cents
    );
  end loop;

  v_refund_total := round(v_refund_total::numeric, 2);
  if v_refund_total > round((v_sale.total - v_refunded_so_far)::numeric, 2) then
    raise exception 'Refund exceeds remaining refundable amount for this sale' using errcode = 'check_violation';
  end if;

  if public.approval_required_for('refund', v_refund_total) then
    if coalesce(btrim(p_payload ->> 'approval_request_id'), '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_approval_id := (p_payload ->> 'approval_request_id')::uuid;
    else
      v_approval_id := null;
    end if;
    v_approval_id := public.approval_assert_satisfied('refund', v_refund_total, v_approval_id, '{}'::jsonb);
  end if;

  update public.return_counters set next_value = next_value + 1 where id = 1
    returning 'RET-' || lpad((next_value - 1)::text, 6, '0') into v_return_number;
  update public.refund_counters set next_value = next_value + 1 where id = 1
    returning 'REF-' || lpad((next_value - 1)::text, 6, '0') into v_refund_number;

  insert into public.sales_returns (
    client_ref, return_number, sale_id, sale_number, customer_id, customer_name,
    reason, refund_amount, refund_method, refund_status, user_id, user_name
  ) values (
    v_client_ref, v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
    v_reason, v_refund_total, v_refund_method::public.refund_method,
    v_refund_status::public.refund_status, v_user_id, v_user_name
  ) returning id into v_return_id;

  for v_return_line in select * from jsonb_array_elements(v_refund_lines)
  loop
    select * into v_sale_item from public.sale_items
     where id = (v_return_line->>'sale_item_id')::uuid and sale_id = v_sale.id;
    v_qty := (v_return_line->>'quantity')::integer;
    v_ceiling_cents := (v_return_line->>'ceiling_cents')::bigint;
    v_refund_cents := (v_return_line->>'refund_cents')::bigint;
    v_base_cents := v_ceiling_cents / v_sale_item.quantity;
    v_high_count := (v_refund_cents - v_base_cents * v_qty)::integer;
    v_low_count := v_qty - v_high_count;

    -- Store separate whole-piastre rows where necessary. This keeps each
    -- return_item's unit_price × quantity exactly equal to line_total.
    if v_low_count > 0 then
      insert into public.return_items (
        return_id, sale_item_id, product_id, variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_return_id, v_sale_item.id, v_sale_item.product_id, v_sale_item.variant_id,
        v_sale_item.variant_color_ar, v_sale_item.variant_color_en, v_sale_item.variant_size, v_sale_item.variant_size_label,
        v_sale_item.name_ar, v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
        v_base_cents::numeric / 100, v_low_count, v_base_cents::numeric * v_low_count / 100
      );
    end if;
    if v_high_count > 0 then
      insert into public.return_items (
        return_id, sale_item_id, product_id, variant_id, variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, line_total
      ) values (
        v_return_id, v_sale_item.id, v_sale_item.product_id, v_sale_item.variant_id,
        v_sale_item.variant_color_ar, v_sale_item.variant_color_en, v_sale_item.variant_size, v_sale_item.variant_size_label,
        v_sale_item.name_ar, v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
        (v_base_cents + 1)::numeric / 100, v_high_count, (v_base_cents + 1)::numeric * v_high_count / 100
      );
    end if;

    if v_sale_item.variant_id is not null then
      select * into v_variant from public.product_variants where id = v_sale_item.variant_id for update;
      if found then
        v_before := v_variant.stock_quantity;
        update public.product_variants set stock_quantity = stock_quantity + v_qty, updated_at = now() where id = v_variant.id;
        insert into public.stock_movements (
          product_id, variant_id, variant_color_ar, variant_color_en, variant_size, delta, quantity_before, quantity_after,
          type, reason, notes, user_id, user_name,
          source_type, source_id, reference
        ) values (
          v_sale_item.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_qty, v_before, v_before + v_qty, 'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')', v_user_id, v_user_name,
          -- 0087: source_type/source_id let zz_stock_movement_branch_snapshot (0078)
          -- overwrite quantity_before/quantity_after with the EXACT branch shelf
          -- figures at insert time, fixing audit finding B2.
          'return', v_return_id, v_return_number
        );
      end if;
    else
      select * into v_product from public.products where id = v_sale_item.product_id for update;
      if found then
        v_before := v_product.stock_quantity;
        update public.products set stock_quantity = stock_quantity + v_qty, updated_at = now() where id = v_product.id;
        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name,
          source_type, source_id, reference
        ) values (
          v_product.id, v_qty, v_before, v_before + v_qty, 'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')', v_user_id, v_user_name,
          -- 0087: see the variant branch above — same branch-exact audit fix (B2).
          'return', v_return_id, v_return_number
        );
      end if;
    end if;
  end loop;

  insert into public.refund_records (
    refund_number, sale_id, sale_number, return_id, amount, payment_method, status, reason, user_id, user_name,
    settled_at, settled_by, settled_by_name
  ) values (
    v_refund_number, v_sale.id, v_sale.sale_number, v_return_id, v_refund_total,
    v_refund_method::public.refund_method, v_refund_status::public.refund_status, v_reason, v_user_id, v_user_name,
    case when v_refund_status = 'completed' then now() else null end,
    case when v_refund_status = 'completed' then v_user_id else null end,
    case when v_refund_status = 'completed' then v_user_name else null end
  ) returning id into v_refund_id;

  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_refund_id::text);
  end if;
  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id, 'refund_amount', v_refund_total);
end;
$$;

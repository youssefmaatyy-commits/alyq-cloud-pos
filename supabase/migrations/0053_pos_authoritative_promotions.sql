-- 0053 — authoritative POS automatic promotion pricing.
-- Reuses the existing POS completion RPC; official catalogue prices remain untouched.
-- POS manual line discounts. Existing rows and website promotion paths remain unchanged.
alter table public.sales add column if not exists item_discount_amount numeric(14,2) not null default 0;
alter table public.sales add column if not exists total_discount_amount numeric(14,2) not null default 0;
alter table public.sale_items add column if not exists gross_total numeric(14,2);
alter table public.sale_items add column if not exists discount_type public.discount_type not null default 'none';
alter table public.sale_items add column if not exists discount_value numeric(14,2) not null default 0;
alter table public.sale_items add column if not exists discount_amount numeric(14,2) not null default 0;

create or replace function public.pos_complete_sale(
  p_payload jsonb,
  -- Phase 24: the request that authorises an over-limit discount. Optional so
  -- every existing caller — resolve_online_order() included, which completes an
  -- online order with no discount — keeps working unchanged.
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
  v_user_id         text := p_payload->>'user_id';
  v_user_name       text := p_payload->>'user_name';
  v_source          text := coalesce(p_payload->>'source', 'pos');

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;
  -- Phase 43: the exact combination of a variant product, locked and priced
  -- from the catalogue — never from the payload.
  v_variant         public.product_variants%rowtype;
  v_variant_id      uuid;
  v_variant_label   text;

  v_subtotal        numeric(14,2) := 0;
  v_discount_percent numeric(8,2) := 0;
  v_approval_id      uuid;
  v_discount_amount numeric(14,2) := 0;
  v_item_discount_type text;
  v_item_discount_value numeric(14,2);
  v_item_discount_amount numeric(14,2);
  v_item_discount_total numeric(14,2) := 0;
  v_line_gross numeric(14,2);
  v_invoice_base numeric(14,2);
  v_total           numeric(14,2);
  v_pricing_lines   jsonb := '[]'::jsonb;
  v_priced_lines    jsonb := '[]'::jsonb;
  v_priced_line     jsonb;
  v_auto_id         uuid;
  v_auto_name       text;
  v_auto_discount   numeric(14,2) := 0;
  v_line_index      integer := 0;
  v_official_unit   numeric(14,2) := 0;

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
  -- This function is SECURITY DEFINER, so row level security does not apply
  -- inside it, and EXECUTE is granted to `authenticated`. Until this guard
  -- existed, the capability matrix was enforced only in the browser: any
  -- signed-in seat — including a read-only `viewer`, whose `can('sell')` is
  -- false — could call the RPC directly and write a sale, its items, its
  -- payments and a stock movement. Reproduced before the fix: a viewer created
  -- INV-000002 and moved stock 500 → 498.
  --
  -- `manage_online_orders` is accepted alongside `sell` because
  -- `resolve_online_order()` completes an order by calling this function with
  -- source = 'online'. That path must keep working for a seat that works the
  -- online queue. Every shipped role that resolves orders also holds `sell`;
  -- this widens the gate only for a custom role built to work orders without
  -- ringing up sales at the till.
  if not (public.can('sell') or public.can('manage_online_orders')) then
    raise exception 'Not permitted to complete a sale'
      using errcode = 'insufficient_privilege';
  end if;
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
  end if;

  if v_source not in ('pos', 'online') then
    raise exception 'Invalid source' using errcode = 'check_violation';
  end if;

  -- ── open-shift requirement (Phase 27) ────────────────────────────────────
  -- A till sale is drawer money: it must land inside an open shift's books or
  -- the close-out can never explain the cash. The store holds at most one open
  -- shift at a time (`shifts_enforce_invariants`, 0012), so the rule is
  -- "an open shift exists" and the sale stamps it — that is what makes the
  -- attribution a fact instead of a time-window guess, and what lets a sale
  -- be refused with zero rows written (the check runs before any counter is
  -- touched, so a refused sale burns no invoice number).
  --
  -- `source = 'online'` is deliberately exempt: the storefront is its own
  -- channel, and the shop's model keeps it independent of the till.
  --
  -- `for update` serialises against a concurrent close: whichever takes the
  -- row lock first wins — if the close commits first we see 'closed' and
  -- refuse; if we commit first the sale sits inside the shift's window.
  if v_source = 'pos' then
    select id into v_shift_id from public.shifts where status = 'open' for update;
    if not found then
      raise exception 'Cannot complete a sale: no open shift'
        using errcode = 'no_data_found';
    end if;
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
    -- ── Phase 43: the shelf is the EXACT combination's ────────────────────
    -- A product that sells by variant can only be sold by naming the colour and
    -- the size, and the units come off that combination. Nothing else
    -- authorises the line: not the product rollup, not a sibling size, not a
    -- sibling colour. The id is parsed defensively (variant_id_of returns null
    -- instead of letting a forged value become a 22P02 cast error) and the row
    -- is locked here so the check and the deduction agree.
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
      v_unit := coalesce(v_variant.price_override, v_product.selling_price);
    else
      if v_qty > v_product.stock_quantity then
        raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
      end if;
      v_unit := v_product.selling_price;
    end if;
    v_line_gross := round((v_unit * v_qty)::numeric, 2);
    v_pricing_lines := v_pricing_lines || jsonb_build_object('product_id', v_product.id, 'category_id', v_product.category_id, 'variant_id', v_variant_id, 'qty', v_qty, 'unit_price', v_unit, 'line_total', v_line_gross);
    v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
    v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
    if v_item_discount_type not in ('none', 'percent', 'fixed')
       or v_item_discount_value < 0
       or (v_item_discount_type = 'percent' and v_item_discount_value > 100) then
      raise exception 'Invalid item discount' using errcode = 'check_violation';
    end if;
    v_item_discount_amount := case
      when v_item_discount_type = 'percent' then round((v_line_gross * v_item_discount_value / 100)::numeric, 2)
      when v_item_discount_type = 'fixed' then least(v_line_gross, round(v_item_discount_value, 2))
      else 0 end;
    v_item_discount_total := v_item_discount_total + v_item_discount_amount;
    v_subtotal := v_subtotal + v_line_gross;
  end loop;

  -- Reprice the complete cart through the same channel-aware promotion engine used online.
  -- The catalogue price above is only the input; the client cannot forge the result.
  select coalesce(result->'lines', '[]'::jsonb), (result->>'auto_promotion_id')::uuid,
         result->>'auto_promotion_name', coalesce((result->>'auto_discount')::numeric, 0)
    into v_priced_lines, v_auto_id, v_auto_name, v_auto_discount
    from public.evaluate_order_pricing_channel(
      v_subtotal, v_pricing_lines, null, null, '{}'::jsonb, '{}'::jsonb, 'pickup', false,
      case when v_source = 'pos' then 'pos' else 'online' end
    ) result;
  v_subtotal := 0;
  v_item_discount_total := 0;
  v_line_index := 0;
  for v_line in select * from jsonb_array_elements(p_payload->'lines') loop
    v_priced_line := v_priced_lines -> v_line_index;
    v_qty := (v_line->>'qty')::integer;
    v_unit := round(coalesce((v_priced_line->>'discounted_unit_price')::numeric, 0), 2);
    v_line_gross := round((v_unit * v_qty)::numeric, 2);
    v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
    v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
    v_item_discount_amount := case when v_item_discount_type = 'percent' then round((v_line_gross * v_item_discount_value / 100)::numeric, 2)
      when v_item_discount_type = 'fixed' then least(v_line_gross, round(v_item_discount_value, 2)) else 0 end;
    v_item_discount_total := v_item_discount_total + v_item_discount_amount;
    v_subtotal := v_subtotal + v_line_gross;
    v_line_index := v_line_index + 1;
  end loop;

  -- 3. authoritative totals: item discounts precede the invoice discount.
  v_invoice_base := greatest(0, v_subtotal - v_item_discount_total);
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_invoice_base * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_invoice_base);
  end if;
  v_total := greatest(0, v_invoice_base - v_discount_amount);

  -- ── approval limits, enforced here and not in the browser (Phase 24) ──────
  -- Until now the only thing between a signed-in seat and an arbitrary discount
  -- was saleService.ts:146, which a direct call to this function never passes
  -- through. The percentage below is derived from numbers this function computed
  -- itself — the catalogue-priced subtotal and the discount it clamped — and not
  -- from anything the caller claims, so a fixed discount is measured the same
  -- way the till measures it: 8.00 off a 20.00 basket is the 40% act it is.
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
    -- Validates and returns the request without spending it: the sale does not
    -- exist yet, and a sale that fails below must not burn an approval.
    v_approval_id := public.approval_assert_satisfied(
      'discount', v_discount_percent, v_approval_id, '{}'::jsonb
    );
  end if;

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

  -- ── customer linkage (Phase 27) ─────────────────────────────────────────
  -- The till selects a customer (or a walk-in) and snapshots name/phone for
  -- the receipt. Until this existed the payload was read by no version of the
  -- function — every live sale lost its customer and read back as a guest,
  -- while demo mode (its own repository) kept it, so the drift was invisible
  -- in the suite. The rules here:
  --   · a well-formed id that is not in `customers` is dropped to NULL rather
  --     than failing the sale — the sale is real, the link is not;
  --   · a valid id takes the customer's current name/phone from the book
  --     (authoritative), a walk-in keeps the payload snapshot, blank → NULL.
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

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, item_discount_amount, total_discount_amount, automatic_discount_amount, automatic_promotion_id, automatic_promotion_name, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name,
    source, customer_id, customer_name, customer_phone, shift_id
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_item_discount_total, v_item_discount_total + v_discount_amount, v_auto_discount, v_auto_id, v_auto_name, v_total,
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

  -- Spend it now, inside the same transaction as the sale it produced, so a
  -- rolled-back sale leaves the approval unspent and it cannot be replayed
  -- against the next one.
  if v_approval_id is not null then
    perform public.mark_approval_applied(v_approval_id, v_sale_id::text);
  end if;

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

  v_line_index := 0;
  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    v_priced_line := v_priced_lines -> v_line_index;
    v_unit := round(coalesce((v_priced_line->>'discounted_unit_price')::numeric, 0), 2);
    v_line_gross := round((v_unit * v_qty)::numeric, 2);
    v_item_discount_type := coalesce(v_line->>'discount_type', 'none');
    v_item_discount_value := coalesce((v_line->>'discount_value')::numeric, 0);
    v_item_discount_amount := case when v_item_discount_type = 'percent' then round((v_line_gross * v_item_discount_value / 100)::numeric, 2)
      when v_item_discount_type = 'fixed' then least(v_line_gross, round(v_item_discount_value, 2)) else 0 end;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    if v_product.variants_enabled then
      -- Locked in the same order as the validation pass (product, then variant),
      -- so two tills selling the last ring serialise instead of deadlocking.
      v_variant_id := public.variant_id_of(v_line ->> 'variant_id');
      select * into v_variant from public.product_variants
       where id = v_variant_id and product_id = v_product.id
       for update;
      if not found then
        raise exception 'That colour and size does not belong to %', v_product.sku
          using errcode = 'check_violation';
      end if;
      v_official_unit := coalesce(v_variant.price_override, v_product.selling_price);
      v_variant_label := coalesce(public.variant_label(v_variant.color_en, v_variant.color_ar,
                                                      v_variant.size, v_variant.size_label), v_variant.sku);

      -- The invoice keeps WHO and WHAT: the combination's id, and the colour and
      -- size frozen as they read today. A later rename cannot rewrite this row.
      insert into public.sale_items (
        sale_id, product_id, variant_id,
        variant_color_ar, variant_color_en, variant_size, variant_size_label,
        name_ar, name_en, sku, barcode, unit_price, quantity, gross_total, line_total, discount_type, discount_value, discount_amount, automatic_promotion_id, automatic_promotion_name, automatic_discount_amount
      ) values (
        v_sale_id, v_product.id, v_variant.id,
        v_variant.color_ar, v_variant.color_en, v_variant.size, v_variant.size_label,
        v_product.name_ar, v_product.name_en, v_variant.sku, v_variant.barcode,
        v_unit, v_qty,
        v_line_gross, v_line_gross - v_item_discount_amount, v_item_discount_type::public.discount_type, v_item_discount_value, v_item_discount_amount, v_auto_id, v_auto_name, greatest(round((v_official_unit * v_qty)::numeric, 2) - v_line_gross, 0)
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
      insert into public.sale_items (sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, gross_total, line_total, discount_type, discount_value, discount_amount, automatic_promotion_id, automatic_promotion_name, automatic_discount_amount)
      values (v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
              v_product.barcode, v_unit, v_qty,
              v_line_gross, v_line_gross - v_item_discount_amount, v_item_discount_type::public.discount_type, v_item_discount_value, v_item_discount_amount, v_auto_id, v_auto_name, greatest(round((v_official_unit * v_qty)::numeric, 2) - v_line_gross, 0));

      v_before := v_product.stock_quantity;
      update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

      insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
      values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other',
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


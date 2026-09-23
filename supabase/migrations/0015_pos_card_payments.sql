-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0015
-- Production readiness — card (Visa) payments at the register.
--
-- The enum value already exists: 0012 added 'visa' to `public.payment_method`
-- because the expenses and refunds modules offered card payments while the enum
-- did not. What was still missing is the POS path — the database refused a card
-- sale in two places:
--
--   1. `sales_cash_received_covers_total` required `amount_received >= total`
--      for every method except InstaPay. A card sale carries no cash, so
--      `amount_received` is null and the constraint rejected the row.
--   2. `pos_complete_sale` validated its payments against ('cash','instapay'),
--      so a card payment was rejected with `Invalid payment` before the sale
--      was even written.
--
-- Both are fixed here, and nothing else about a sale changes:
--
--   * cash still requires a tendered amount that covers the total, and still
--     records its change;
--   * InstaPay still may be `pending` until the transfer is confirmed, and
--     `pos_confirm_payment` is untouched;
--   * card is captured immediately, so a `visa` payment is always `paid` and
--     cannot be parked in `pending`;
--   * the split rules are unchanged — payments must still sum to the total
--     exactly, stock is still re-checked, and totals are still recalculated
--     from catalog prices rather than trusted from the client.
--
-- `sales.payment_method` keeps recording the FIRST payment's method, which is
-- how a sale reports itself as "a card sale" in the sales list and the receipt.
--
-- This migration also grants the register's read privileges to `authenticated`.
-- It is a fix, not a convenience: see the note beside the grants at the end.
--
-- While writing this migration the scenario suite was pointed at the register
-- for the first time, and it found a defect the earlier static review had
-- missed: the 0009 function built its invoice number with
-- `lpad(next_value::text - 1, 6, '0')`, and because `::text` binds tighter than
-- `-`, Postgres parsed that as `text - integer` and raised
-- `operator does not exist: text - integer`. `pos_complete_sale` therefore
-- failed on EVERY completion, so no sale could ever be recorded against a real
-- database — the live POS path was dead on arrival, and only the demo
-- repository masked it. The third (marked) edit below fixes it. The same
-- spelling sits in 0010's return/refund numbering and is fixed in 0016.
--
-- The function below is the 0009 definition with exactly three edits, each
-- marked `0015:` in place. Reproducing it rather than abstracting it is
-- deliberate: a Postgres function body cannot be patched, and a full,
-- reviewable copy with a marked delta is safer than a clever one.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the cash-cover constraint ──────────────────────────────────────────
-- Re-stated, not weakened: a cash sale must still tender at least the total.
-- Card and InstaPay are the methods that do not put cash in the drawer.
alter table public.sales drop constraint if exists sales_cash_received_covers_total;

-- A little more than the card fix had to change here. The 0007 rule was
-- `amount_received >= total`, and because a sale is labelled by its FIRST
-- payment, it also silently outlawed every split that starts with cash: the
-- register's own smart split (`smartPaymentCalc` in `src/modules/pos/services/
-- posMath.ts`) always adds the cash leg first, so a cash+InstaPay sale was
-- rejected by this constraint even though the RPC had built it correctly. The
-- rule below admits it while keeping the property the constraint exists for.
--
-- What the table can prove: the tender is recorded, the change handed back is
-- never negative and never exceeds the tender, and the cash applied to the sale
-- (tender minus change) never exceeds the sale's own total.
--
-- What it cannot prove, and never could: that a cash-only sale was tendered in
-- full. `sales` holds one row and cannot see the payment rows, so "the cash leg
-- covered its share" is only knowable per payment — which is exactly where the
-- RPC enforces it (`Insufficient cash received` when tendered < the cash
-- amount), and the RPC is the only writer this table has: an explicit
-- `grant select` at the end of this file plus the `with check (false)` insert
-- policy leave no other way in.
--
-- Cash is therefore not weaker here, it is simply guarded one level down, where
-- the information actually lives.
alter table public.sales add constraint sales_cash_received_covers_total check (
  -- InstaPay and card put no cash in the drawer, so they carry no tender.
  payment_method in ('instapay', 'visa')
  or (
    amount_received is not null
    and coalesce(change, 0) >= 0
    and amount_received >= coalesce(change, 0)
    and (amount_received - coalesce(change, 0)) <= total
  )
);

comment on constraint sales_cash_received_covers_total on public.sales is
  'Cash bookkeeping on a sale row: tender recorded, change non-negative and no larger than the tender, and cash applied never above the total. InstaPay and card sales carry no cash. Per-payment coverage (cash tender >= cash amount) is enforced by pos_complete_sale, the only writer.';

-- ── 2. the completion RPC, with card accepted ─────────────────────────────
create or replace function public.pos_complete_sale(p_payload jsonb)
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

  v_line            jsonb;
  v_product         public.products%rowtype;
  v_qty             integer;
  v_unit            numeric(14,2);
  v_before          integer;

  v_subtotal        numeric(14,2) := 0;
  v_discount_amount numeric(14,2) := 0;
  v_total           numeric(14,2);

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

  v_sale_id         uuid;
  v_sale_number     text;
  v_sale_status     text;
  v_pay_status_enum public.payment_status;
begin
  -- 1. idempotency
  select id into v_sale_id from public.sales where client_ref = v_client_ref;
  if found then
    return jsonb_build_object('sale_id', v_sale_id);
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
    if v_qty > v_product.stock_quantity then
      raise exception 'Only % of % in stock', v_product.stock_quantity, v_product.sku using errcode = 'check_violation';
    end if;
    v_subtotal := v_subtotal + round((v_product.selling_price * v_qty)::numeric, 2);
  end loop;

  -- 3. authoritative totals
  if v_discount_type = 'percent' then
    v_discount_amount := round((v_subtotal * v_discount_value / 100)::numeric, 2);
  elsif v_discount_type = 'fixed' then
    v_discount_amount := least(round(v_discount_value::numeric, 2), v_subtotal);
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- 4. validate payments: each valid, sum equals the total exactly
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    -- 0015: 'visa' (card) added to the whitelist.
    if v_pay_method not in ('cash','instapay','visa') or v_pay_amount <= 0 then
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
      -- 0015: card money is captured at the terminal before the sale is
      -- recorded, so a `visa` payment is always paid and a client cannot park a
      -- card sale in `pending` (decision D2 of the readiness plan). InstaPay
      -- alone stays pending until the transfer is confirmed.
      v_pay_status := case
        when v_pay_method = 'visa' then 'paid'
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

  -- 5. sale number + sale row
  update public.sale_counters set next_value = next_value + 1 where id = 1
    -- 0015: `::text` binds tighter than `-`, so the 0009 spelling
    -- (`next_value::text - 1`) was parsed as `text - integer` and raised
    -- `operator does not exist` on every single completion — a live sale could
    -- never be recorded. Casting the difference instead restores it.
    returning 'INV-' || lpad((next_value - 1)::text, 6, '0') into v_sale_number;

  insert into public.sales (
    sale_number, client_ref, status, payment_method, payment_status,
    subtotal, discount_type, discount_value, discount_amount, total,
    amount_received, change, user_id, user_name, paid_at, paid_by, paid_by_name
  ) values (
    v_sale_number, v_client_ref, v_sale_status::public.sale_status,
    coalesce(v_first_method, 'cash'), case when v_all_paid then 'paid' else 'pending' end::public.payment_status,
    v_subtotal, v_discount_type::public.discount_type, v_discount_value, v_discount_amount, v_total,
    case when v_cash_received > 0 then v_cash_received else null end,
    case when v_cash_received > 0 then round((v_cash_received - v_cash_applied)::numeric, 2) else null end,
    v_user_id, v_user_name,
    case when v_all_paid then now() else null end,
    case when v_all_paid then v_user_id else null end,
    case when v_all_paid then v_user_name else null end
  ) returning id into v_sale_id;

  -- 6. payment rows + sale items + stock + movements
  for v_pay in select * from jsonb_array_elements(p_payload->'payments')
  loop
    v_pay_method := v_pay->>'method';
    v_pay_amount := round(coalesce((v_pay->>'amount')::numeric, 0), 2);
    if v_pay_method = 'instapay' then
      v_pay_status := case when coalesce(v_pay->>'status', 'paid') = 'pending' then 'pending' else 'paid' end;
    else
      v_pay_status := 'paid';
    end if;
    v_pay_status_enum := v_pay_status::public.payment_status;

    insert into public.sale_payments (sale_id, method, amount, status, paid_at, paid_by, paid_by_name)
    values (
      v_sale_id, v_pay_method::public.payment_method, v_pay_amount, v_pay_status_enum,
      case when v_pay_status_enum = 'paid' then now() else null end,
      case when v_pay_status_enum = 'paid' then v_user_id else null end,
      case when v_pay_status_enum = 'paid' then v_user_name else null end
    );
  end loop;

  for v_line in select * from jsonb_array_elements(p_payload->'lines')
  loop
    v_qty := (v_line->>'qty')::integer;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid for update;

    insert into public.sale_items (sale_id, product_id, name_ar, name_en, sku, barcode, unit_price, quantity, line_total)
    values (v_sale_id, v_product.id, v_product.name_ar, v_product.name_en, v_product.sku,
            v_product.barcode, v_product.selling_price, v_qty,
            round((v_product.selling_price * v_qty)::numeric, 2));

    v_before := v_product.stock_quantity;
    update public.products set stock_quantity = stock_quantity - v_qty, updated_at = now() where id = v_product.id;

    insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
    values (v_product.id, v_qty, v_before, v_before - v_qty, 'issue', 'other', 'Sale ' || v_sale_number, v_user_id, v_user_name);
  end loop;

  return jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number);
end;
$$;

grant execute on function public.pos_complete_sale(jsonb) to authenticated;

-- ── 3. make the register reachable through the API ────────────────────────
-- Supabase stopped granting privileges on new `public` tables to `authenticated`
-- on 2026-04-28: a table created without an explicit grant is no longer
-- reachable through the Data API, whatever its RLS policies say. The POS tables
-- were created back in 0007/0009 and never granted anything, so on a project
-- built from these migrations today the whole register read path answers
-- "permission denied" — the sale would be recorded and then be invisible to the
-- cashier who recorded it. (This is why the payment scenario below needs the
-- read grant: the shim has no default privileges, exactly like a current
-- project.)
--
-- SELECT only, on purpose: every write in this module goes through the
-- SECURITY DEFINER RPCs above, and the direct-write policies stay
-- `with check (false)`. A missing write grant is the second lock on that door.
--
-- The returns and refunds tables are granted in 0016, which owns that path.
grant select on public.products        to authenticated;
grant select on public.categories      to authenticated;
grant select on public.customers       to authenticated;
grant select on public.sales           to authenticated;
grant select on public.sale_items      to authenticated;
grant select on public.sale_payments   to authenticated;
grant select on public.stock_movements to authenticated;

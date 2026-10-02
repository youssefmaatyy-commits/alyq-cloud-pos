-- ─────────────────────────────────────────────────────────────────────────────
-- 0065 — refund ceilings and a safe 0062 upgrade path
--
-- `sale_items.line_total` is the net after item and promotion discounts.  Old
-- invoices did not keep the invoice-level discount on each line.  We MUST NOT
-- invent or rewrite that history.  For those rows this migration uses a
-- read-only, deterministic refund-ceiling allocation:
--
--   1. distribute the invoice's actual paid total over net sale-item totals
--      proportionally;
--   2. work in whole piastres; hand leftover piastres to the largest fractional
--      remainders, then stable sale_item.id order;
--   3. for a partial return, refund the difference between the allocated amount
--      at the cumulative returned quantity and the previous quantity.
--
-- The rule is used only to cap a refund. It never changes a historical invoice.
-- New sales get the resulting exact per-line `refundable_total` at commit time.
-- An operator can repair an anomalous old invoice explicitly with documented
-- evidence using `set_sale_refundable_totals`; this migration never overwrites
-- such rows blindly.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table public.sale_items
  add column if not exists refundable_total numeric(14,2);

alter table public.sale_items
  drop constraint if exists sale_items_refundable_total_nonnegative;
alter table public.sale_items
  add constraint sale_items_refundable_total_nonnegative
  check (refundable_total is null or refundable_total >= 0);

comment on column public.sale_items.refundable_total is
  'Exact refundable line ceiling for sales completed after 0065. Historical NULLs are allocated read-only by sale_refund_allocation; no historical invoice is rewritten automatically.';

-- Existing 0062 installations can contain valid discounted invoices with NULL
-- total_discount_amount (0062 added the column with default zero before its
-- old constraint). Fill only the new accounting column from already-recorded
-- invoice facts; no sale, payment or line amount is changed. The checks below
-- are NOT VALID so a genuinely anomalous historic row is reported, not made an
-- upgrade blocker.
update public.sales
   set total_discount_amount = round(greatest(subtotal - total, 0)::numeric, 2)
 where coalesce(total_discount_amount, 0) = 0
   and subtotal >= total
   and round(greatest(subtotal - total, 0)::numeric, 2) > 0;

alter table public.sales drop constraint if exists sales_total_matches;
alter table public.sales
  add constraint sales_total_matches
  check (total = round((subtotal - coalesce(total_discount_amount, discount_amount))::numeric, 2)) not valid;

alter table public.sales drop constraint if exists sales_discount_le_subtotal;
alter table public.sales
  add constraint sales_discount_le_subtotal
  check (coalesce(total_discount_amount, discount_amount) <= subtotal) not valid;

-- Returns every item on a sale, its non-destructive refund ceiling, and whether
-- the source invoice has enough line evidence to allocate safely.
create or replace function public.sale_refund_allocation(p_sale_id uuid)
returns table (
  sale_item_id uuid,
  refundable_total numeric(14,2),
  allocation_available boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with sale as (
    select id, round(total::numeric, 2) as paid_total
      from public.sales
     where id = p_sale_id
  ), lines as (
    select si.id,
           greatest(round(coalesce(si.line_total, si.unit_price * si.quantity, 0)::numeric, 2), 0) as line_total
      from public.sale_items si
     where si.sale_id = p_sale_id
  ), totals as (
    select s.paid_total,
           coalesce(sum(l.line_total), 0)::numeric(14,2) as line_base,
           count(l.id)::integer as line_count
      from sale s
      left join lines l on true
     group by s.paid_total
  ), readiness as (
    select paid_total, line_base, line_count,
           paid_total >= 0
             and (line_base > 0 or paid_total = 0)
             and paid_total <= line_base as available,
           round(paid_total * 100)::bigint as paid_cents,
           round(line_base * 100)::bigint as base_cents
      from totals
  ), shares as (
    select l.id,
           r.available,
           r.paid_cents,
           r.base_cents,
           round(l.line_total * 100)::bigint as line_cents,
           case when r.base_cents > 0 then (r.paid_cents * round(l.line_total * 100)::bigint) / r.base_cents else 0 end as floor_cents,
           case when r.base_cents > 0 then mod(r.paid_cents * round(l.line_total * 100)::bigint, r.base_cents) else 0 end as remainder_numerator
      from lines l
      cross join readiness r
  ), ranked as (
    select *,
           row_number() over (order by remainder_numerator desc, id) as remainder_rank,
           coalesce(sum(floor_cents) over (), 0) as floors_total
      from shares
  )
  select id,
         case when available
           then ((floor_cents + case when remainder_rank <= paid_cents - floors_total then 1 else 0 end)::numeric / 100)::numeric(14,2)
           else null end,
         available
    from ranked
   order by id;
$$;

revoke all on function public.sale_refund_allocation(uuid) from public, anon, authenticated;

-- A visible review queue for post-0062 installations. It reports rather than
-- mutating suspicious data: totals with no item evidence, totals above known
-- item nets, and a persisted ceiling that no longer sums to money paid.
create or replace view public.refund_allocation_anomalies as
with line_totals as (
  select s.id as sale_id,
         s.sale_number,
         s.total as paid_total,
         coalesce(sum(greatest(coalesce(si.line_total, si.unit_price * si.quantity, 0), 0)), 0)::numeric(14,2) as item_net_total,
         count(si.id)::integer as item_count,
         count(si.refundable_total) filter (where si.refundable_total is not null)::integer as persisted_count,
         coalesce(sum(si.refundable_total) filter (where si.refundable_total is not null), 0)::numeric(14,2) as persisted_total
    from public.sales s
    left join public.sale_items si on si.sale_id = s.id
   group by s.id, s.sale_number, s.total
)
select sale_id,
       sale_number,
       paid_total,
       item_net_total,
       case
         when paid_total < 0 then 'negative_sale_total'
         when item_count = 0 and paid_total <> 0 then 'missing_sale_items'
         when paid_total > item_net_total then 'paid_total_exceeds_known_item_net'
         when persisted_count > 0 and persisted_count <> item_count then 'partial_persisted_allocation'
         when persisted_count = item_count and persisted_total <> paid_total then 'persisted_allocation_mismatch'
         else 'unknown'
       end as anomaly
  from line_totals
 where paid_total < 0
    or (item_count = 0 and paid_total <> 0)
    or paid_total > item_net_total
    or (persisted_count > 0 and persisted_count <> item_count)
    or (persisted_count = item_count and persisted_total <> paid_total);

comment on view public.refund_allocation_anomalies is
  'Review queue only. 0065 never changes rows in this view; repair with set_sale_refundable_totals after reconciling the original invoice.';

-- Explicit, audited-by-caller repair route for a historic anomaly. It refuses a
-- sale with active/past returns because changing a ceiling after money or stock
-- moved would be unsafe. The caller must supply every sale item and values that
-- sum exactly to the recorded sale total.
create or replace function public.set_sale_refundable_totals(
  p_sale_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_count integer;
  v_input_count integer;
  v_sum numeric(14,2);
begin
  if not public.can('manage_settings') then
    raise exception 'Not permitted to repair refund allocations' using errcode = 'insufficient_privilege';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;
  if exists (
    select 1 from public.refund_records
     where sale_id = p_sale_id and status <> 'rejected'
  ) then
    raise exception 'Cannot repair a sale after a refund has been recorded' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from public.sale_items where sale_id = p_sale_id;
  select count(*) into v_input_count from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb));
  if v_count <> v_input_count or v_count = 0 then
    raise exception 'A refundable total is required for every sale item' using errcode = 'check_violation';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_lines) l(value)
      left join public.sale_items si
        on si.id = (l.value->>'sale_item_id')::uuid and si.sale_id = p_sale_id
     where si.id is null
        or coalesce((l.value->>'refundable_total')::numeric, -1) < 0
  ) or exists (
    select 1
      from jsonb_array_elements(p_lines) l(value)
     group by l.value->>'sale_item_id'
    having count(*) > 1
  ) then
    raise exception 'Invalid refundable allocation lines' using errcode = 'check_violation';
  end if;

  select round(coalesce(sum((value->>'refundable_total')::numeric), 0)::numeric, 2)
    into v_sum
    from jsonb_array_elements(p_lines);
  if v_sum <> round(v_sale.total::numeric, 2) then
    raise exception 'Refundable allocation must equal the sale total' using errcode = 'check_violation';
  end if;

  update public.sale_items si
     set refundable_total = round((l.value->>'refundable_total')::numeric, 2)
    from jsonb_array_elements(p_lines) l(value)
   where si.id = (l.value->>'sale_item_id')::uuid
     and si.sale_id = p_sale_id;
end;
$$;

revoke all on function public.set_sale_refundable_totals(uuid, jsonb) from public, anon;
grant execute on function public.set_sale_refundable_totals(uuid, jsonb) to authenticated;

-- Materialise the exact values for sales created after this migration. A
-- deferred trigger runs only when the complete sale transaction commits, so it
-- sees all its lines; legacy rows are untouched because they do not fire it.
create or replace function public.materialize_sale_refundable_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.sale_refund_allocation(new.sale_id)
     where not allocation_available
  ) then
    return new;
  end if;

  update public.sale_items si
     set refundable_total = a.refundable_total
    from public.sale_refund_allocation(new.sale_id) a
   where si.id = a.sale_item_id
     and si.sale_id = new.sale_id
     and si.refundable_total is null;
  return new;
end;
$$;

drop trigger if exists sale_items_materialize_refundable_totals on public.sale_items;
create constraint trigger sale_items_materialize_refundable_totals
  after insert or update of line_total, quantity on public.sale_items
  deferrable initially deferred
  for each row execute function public.materialize_sale_refundable_totals();

-- Live refund RPC. The stock and refund write remains one transaction and this
-- is still the authoritative path. See the header for the historic allocation
-- policy; one returned unit is never priced above the appropriate cumulative
-- share, so all partials add up exactly to the paid line ceiling.
create or replace function public.pos_process_return(p_payload jsonb)
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
begin
  if not public.can('process_return') then
    raise exception 'Not permitted to process a return' using errcode = 'insufficient_privilege';
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
    return_number, sale_id, sale_number, customer_id, customer_name,
    reason, refund_amount, refund_method, refund_status, user_id, user_name
  ) values (
    v_return_number, v_sale.id, v_sale.sale_number, v_sale.customer_id, v_sale.customer_name,
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
          type, reason, notes, user_id, user_name
        ) values (
          v_sale_item.product_id, v_variant.id, v_variant.color_ar, v_variant.color_en, v_variant.size,
          v_qty, v_before, v_before + v_qty, 'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')', v_user_id, v_user_name
        );
      end if;
    else
      select * into v_product from public.products where id = v_sale_item.product_id for update;
      if found then
        v_before := v_product.stock_quantity;
        update public.products set stock_quantity = stock_quantity + v_qty, updated_at = now() where id = v_product.id;
        insert into public.stock_movements (
          product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name
        ) values (
          v_product.id, v_qty, v_before, v_before + v_qty, 'adjustment_in', 'customer_return',
          'Customer Return: ' || v_return_number || ' (Sale ' || v_sale.sale_number || ')', v_user_id, v_user_name
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

commit;

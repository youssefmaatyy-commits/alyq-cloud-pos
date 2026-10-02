-- 0067 — replay-safe POS returns
-- A client_ref is an authoritative return-operation idempotency key.
begin;

alter table public.sales_returns
  add column if not exists client_ref text;

create unique index if not exists sales_returns_client_ref_unique
  on public.sales_returns (client_ref)
  where client_ref is not null;

comment on column public.sales_returns.client_ref is
  'Stable operation identifier for pos_process_return retries; duplicate requests return the original return/refund and never repeat stock or money movement.';

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

-- ═══════════════════════════════════════════════════════════════════════════
-- 0049 — DELIVERY ZONES + THE "MARK COMPLETED" CORRECTION
-- ═══════════════════════════════════════════════════════════════════════════
-- Two independent additions in one file (both are additive; nothing deployed
-- is rewritten):
--
--   1. DELIVERY ZONES. The global delivery fee in `website_settings` cannot say
--      "Ismailia 0, Cairo 70, Suez 50, anywhere else 80" — and the shop must be
--      able to change any of those numbers without a code change. Zones are
--      ordinary rows an admin owns (readable by the public storefront, writable
--      only behind `manage_website`), each with its own fee, minimum and free-
--      shipping threshold. Checkout names a zone id; the server prices from the
--      row and never trusts a browser-sent fee. The legacy settings fee stays
--      exactly as it is for shops that never create a zone.
--
--   2. THE "MARK COMPLETED" CORRECTION. `resolve_online_order` (0018, carried
--      forward byte-for-byte by 0043) casts the employee's ACTION word straight
--      into `online_order_status`:
--
--        set status = v_action::public.online_order_status   -- v_action = 'complete'
--
--      but `'complete'` is not an enum label — the label is `'completed'` — so
--      every live "Mark completed" dies with
--      `invalid input value for enum online_order_status: "complete"` (22P02),
--      which the UI then shows verbatim. Demo mode never saw it (it maps to
--      `"completed"` in TypeScript). This file re-states the function with one
--      mapping read once (`processing → processing`, `ready → ready`, anything
--      else in this branch → `completed`) and returns the STORED status, so no
--      caller can ever receive the action word as a status again. Everything
--      else in the body is 0043 verbatim — same guards, same sale path, same
--      events and audit rows, same note wording.
--
-- Also in this file, because 0050 needs it and PostgreSQL refuses to *use* an
-- enum label in the transaction that added it: the `'free_shipping'` value for
-- the coupon `discount_type`. Added here, referenced only from 0050 on.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. delivery zones ──────────────────────────────────────────────────────
create table if not exists public.delivery_zones (
  id                          uuid primary key default gen_random_uuid(),
  -- Stable slug so the seed below (and any re-apply) addresses a row without
  -- knowing its uuid. Never shown to customers; names are what they read.
  key                         text not null unique
    constraint delivery_zones_key_format
    check (key = lower(btrim(key)) and btrim(key) <> ''),
  name_en                     text not null
    constraint delivery_zones_name_en_not_blank check (btrim(name_en) <> ''),
  name_ar                     text not null
    constraint delivery_zones_name_ar_not_blank check (btrim(name_ar) <> ''),
  -- Optional city/governorate key for display and future matching. The server
  -- never guesses a zone from free text: checkout names the zone id.
  governorate_key             text,
  shipping_fee                numeric(14, 2) not null default 0
    constraint delivery_zones_fee_non_negative check (shipping_fee >= 0),
  minimum_order_amount        numeric(14, 2) not null default 0
    constraint delivery_zones_minimum_non_negative check (minimum_order_amount >= 0),
  -- Null means "no free-shipping threshold": the fee always applies.
  free_shipping_threshold     numeric(14, 2)
    constraint delivery_zones_threshold_non_negative
    check (free_shipping_threshold is null or free_shipping_threshold >= 0),
  estimated_delivery_text_en  text,
  estimated_delivery_text_ar  text,
  enabled                     boolean not null default true,
  sort_order                  integer not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.delivery_zones is
  'Per-governorate delivery pricing, owned by the admin. Checkout names a zone id; the server prices from the row — fee, minimum and free-shipping threshold — and never trusts a browser-sent fee. Readable by the public storefront (it renders the choices); writable only behind manage_website.';

create index if not exists delivery_zones_enabled_sort_idx
  on public.delivery_zones (enabled, sort_order);

drop trigger if exists delivery_zones_touch_updated_at
  on public.delivery_zones;
create trigger delivery_zones_touch_updated_at
  before update on public.delivery_zones
  for each row execute function public.set_updated_at();

alter table public.delivery_zones enable row level security;

drop policy if exists "delivery_zones_select_public"
  on public.delivery_zones;
create policy "delivery_zones_select_public"
  on public.delivery_zones for select
  to anon, authenticated
  using (true);

drop policy if exists "delivery_zones_insert_managers"
  on public.delivery_zones;
create policy "delivery_zones_insert_managers"
  on public.delivery_zones for insert
  to authenticated
  with check (public.can('manage_website'));

drop policy if exists "delivery_zones_update_managers"
  on public.delivery_zones;
create policy "delivery_zones_update_managers"
  on public.delivery_zones for update
  to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "delivery_zones_delete_managers"
  on public.delivery_zones;
create policy "delivery_zones_delete_managers"
  on public.delivery_zones for delete
  to authenticated
  using (public.can('manage_website'));

revoke all on public.delivery_zones from public, anon;
grant select on public.delivery_zones to anon, authenticated, service_role;
grant insert, update, delete on public.delivery_zones to authenticated, service_role;

-- ── 2. the shipped default zones ───────────────────────────────────────────
-- The house pricing, editable in the admin from the first login: Ismailia is
-- the shop's city (free), Cairo and Suez pay their courier rates, and "Other
-- governorates" is the safe fallback so no address ever ships free by
-- accident. Addressed by `key`, so re-applying changes nothing an admin set —
-- only a missing row is inserted, and no existing row is ever overwritten.
insert into public.delivery_zones
  (key, name_en, name_ar, governorate_key, shipping_fee, minimum_order_amount,
   free_shipping_threshold, estimated_delivery_text_en, estimated_delivery_text_ar,
   enabled, sort_order)
values
  ('ismailia', 'Ismailia', 'الإسماعيلية', 'ismailia', 0, 0, null,
   'Same-day delivery', 'توصيل في نفس اليوم', true, 10),
  ('cairo', 'Cairo', 'القاهرة', 'cairo', 70, 0, null,
   '1–2 business days', '١–٢ يوم عمل', true, 20),
  ('suez', 'Suez', 'السويس', 'suez', 50, 0, null,
   '1–2 business days', '١–٢ يوم عمل', true, 30),
  ('other', 'Other governorates', 'باقي المحافظات', null, 80, 0, null,
   '2–4 business days', '٢–٤ يوم عمل', true, 100)
on conflict (key) do nothing;

-- ── 3. the coupon free-shipping value (added here, used only from 0050) ────
-- PostgreSQL refuses to *use* an enum label in the transaction that added it,
-- and the migration check applies each file in its own transaction: a file
-- that adds a value must be followed by another that references it. 0049 adds
-- (idempotent — a second apply is a no-op); 0050 references.
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'discount_type' and e.enumlabel = 'free_shipping'
  ) then
    alter type public.discount_type add value 'free_shipping';
  end if;
end
$$;

-- ── 4. resolve_online_order: the action word is not the stored status ───────
-- 0018 wrote `set status = v_action::online_order_status`; 0043 carried it
-- forward. Only 'processing' and 'ready' are labels of both the action
-- vocabulary and the status enum — 'complete' is the verb, 'completed' the
-- label — so the cast raised 22P02 on every live completion. One mapping, read
-- once, used for the status, the event kind, the timestamp gate and the value
-- returned to the caller. The guards above it, the approve/cancel/payment
-- paths around it and the note wording are 0043 verbatim.
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
  v_user_id     text := coalesce(auth.uid()::text, p_payload->>'user_id', '');
  v_user_name   text := coalesce(nullif(btrim(coalesce(p_payload->>'user_name', '')), ''),
                                 (select p.name from public.profiles p where p.id = auth.uid()),
                                 'System');
  v_goods_total numeric(14,2);
  v_list_total  numeric(14,2);
  v_sale_discount numeric(14,2);
  v_result      jsonb;
  v_reservation record;
  -- The stored status a forward move produces. Never the action word: only
  -- 'processing' and 'ready' are labels of both vocabularies.
  v_status      public.online_order_status;
begin
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
    -- Unverified money must never become a sale.
    if v_order.payment_method = 'instapay' and v_order.payment_status <> 'paid' then
      raise exception 'Verify the InstaPay payment before approving this order'
        using errcode = 'check_violation';
    end if;

    -- The sale covers the merchandise; the delivery fee stays on the order
    -- (a POS sale has no delivery-fee column, by constraint).
    v_goods_total := v_order.subtotal - v_order.discount_amount;

    -- `pos_complete_sale` re-reads catalogue prices, so the sale's lines come out
    -- at LIST price. Whatever lowered them when the customer checked out — a
    -- flash sale, a coupon, both — has to be carried across as one fixed
    -- discount, or the register would book more revenue than the order took.
    -- The baseline the discount is measured against is what the till will
    -- charge: the combination's own price when it has one, otherwise the
    -- product's. Using the product price for a variant line would book a
    -- phantom discount equal to the override.
    select coalesce(sum(round((coalesce(v.price_override, p.selling_price) * i.quantity)::numeric, 2)), 0)
      into v_list_total
    from public.online_order_items i
    join public.products p on p.id = i.product_id
    left join public.product_variants v on v.id = i.variant_id
    where i.order_id = v_order.id;

    v_sale_discount := greatest(round((v_list_total - v_goods_total)::numeric, 2), 0);

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

    -- Reservations become the deduction the sale just made.
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

    -- An approved order already became a sale: unwind it, which is what puts
    -- the stock back. That is a void, so it needs the void capability.
    if v_order.sale_id is not null then
      if not public.can('void_sale') then
        raise exception 'This order was approved and became sale %; only a manager can cancel it',
          coalesce(v_order.sale_number, '') using errcode = '42501';
      end if;
      update public.sales
      set status = 'voided'::public.sale_status,
          voided_at = now(),
          void_reason = 'Online order ' || v_order.order_number || ' cancelled: ' || v_reason
      where id = v_order.sale_id
        and status <> 'voided';

      -- Restore the stock the voided sale took, one movement per line. Mirrors
      -- the void path in 0007 exactly: `delta` is a magnitude (the column
      -- checks delta > 0) and the sign is implied by `adjustment_in`.
      for v_reservation in
        select i.product_id, i.variant_id, i.quantity, p.stock_quantity,
               v.stock_quantity as variant_stock, v.color_ar, v.color_en, v.size
        from public.online_order_items i
        join public.products p on p.id = i.product_id
        left join public.product_variants v on v.id = i.variant_id
        where i.order_id = v_order.id
      loop
        if v_reservation.variant_id is not null then
          update public.product_variants
          set stock_quantity = stock_quantity + v_reservation.quantity, updated_at = now()
          where id = v_reservation.variant_id;

          insert into public.stock_movements
            (product_id, variant_id, variant_color_ar, variant_color_en, variant_size,
             delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
          values (v_reservation.product_id, v_reservation.variant_id,
                  v_reservation.color_ar, v_reservation.color_en, v_reservation.size,
                  v_reservation.quantity,
                  v_reservation.variant_stock,
                  v_reservation.variant_stock + v_reservation.quantity,
                  'adjustment_in', 'other',
                  'Cancelled online order ' || v_order.order_number, v_user_id, v_user_name);
        else
          update public.products
          set stock_quantity = stock_quantity + v_reservation.quantity, updated_at = now()
          where id = v_reservation.product_id;

          insert into public.stock_movements
            (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
          values (v_reservation.product_id, v_reservation.quantity,
                  v_reservation.stock_quantity,
                  v_reservation.stock_quantity + v_reservation.quantity,
                  'adjustment_in', 'other',
                  'Cancelled online order ' || v_order.order_number, v_user_id, v_user_name);
        end if;
      end loop;
    end if;

    -- Whatever was still held goes back to the pool.
    update public.stock_reservations
    set status = 'released'::public.reservation_status, resolved_at = now()
    where online_order_id = v_order.id and status = 'reserved';

    -- A coupon consumed by a cancelled order is given back.
    if v_order.discount_code is not null then
      update public.coupons
      set used_count = greatest(used_count - 1, 0), updated_at = now()
      where code = v_order.discount_code;
    end if;

    update public.online_orders
    set status = 'cancelled'::public.online_order_status,
        cancellation_reason = v_reason,
        cancelled_by = auth.uid(),
        cancelled_by_name = v_user_name,
        cancelled_at = now(),
        sale_id = null,
        sale_number = null,
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'cancelled'::public.order_event_kind,
            'Order cancelled: ' || v_reason, auth.uid(), v_user_name);

    insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
    values ('online_order.cancelled', v_order.id::text, v_order.order_number,
            jsonb_build_object('reason', v_reason, 'total', v_order.total,
                               'had_sale', v_order.sale_id is not null),
            v_user_id, v_user_name);

    return jsonb_build_object('order_number', v_order.order_number, 'status', 'cancelled');
  end if;

  -- ── forward moves: the action word is NOT the stored status ──────────────
  -- 0018/0043 wrote `set status = v_action::online_order_status` here. Only
  -- 'processing' and 'ready' are labels of both the action vocabulary and the
  -- status enum; 'complete' is the employee's verb for the 'completed' label,
  -- so the cast raised 22P02 on every live completion. `v_status` is the one
  -- mapping, read once and used for the status, the event kind, the timestamp
  -- gate and the value returned to the caller. Guards and note wording below
  -- are 0043 verbatim.
  if v_action in ('processing', 'ready', 'complete') then
    v_status := case v_action
      when 'processing' then 'processing'::public.online_order_status
      when 'ready' then 'ready'::public.online_order_status
      else 'completed'::public.online_order_status
    end;

    -- Forward-only: an order may not go backwards or skip approval.
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

-- ── 5. audit vocabulary: delivery zones ────────────────────────────────────
-- Creating a zone and changing one (fee, minimum, threshold, deactivation —
-- all of it is a change to what customers pay) are trail events. The service
-- writes them through the same website funnel that asserts `manage_website`.
insert into public.audit_actions (action, entity) values
  ('delivery_zone.created', 'delivery_zone'),
  ('delivery_zone.changed', 'delivery_zone')
on conflict (action) do nothing;

-- ── 6. backup covers the zones ─────────────────────────────────────────────
-- 0048's lesson, applied the same day: every table added after 0029 must join
-- `backup_table_order()` in the file that creates it, or live snapshots
-- silently drop it. Zones have no parents — they slot in with the
-- storefront's own documents. `promotion*` tables join in 0050, which
-- re-states both functions again carrying everything forward.
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
    'sale_items',
    'sale_payments',
    'stock_movements',
    'product_content',
    'storefront_category_content',
    'store_reviews',
    'online_order_items',
    'order_events',
    'stock_reservations',
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

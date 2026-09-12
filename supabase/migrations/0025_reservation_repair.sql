-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0025
-- Phase 15 — stock-hold reconciliation: the vocabulary for repairing a
--            reservation, and the one function allowed to do it.
--
-- A hold is written by `place_online_order` and resolved by
-- `resolve_online_order`: approving converts it (the POS sale takes the units),
-- cancelling releases it. When a transition misses its resolution — a crash
-- between the two statements, a hand-edited row, a product whose stock tracking
-- was switched on after the order was placed — the units stay out of the pool
-- and the website quietly understates what it can sell. Until now the only
-- answer was SQL by hand, which leaves no trail at all.
--
-- `stock_reservations` has no write policy for authenticated callers (0017:
-- insert `with check (false)`, delete `using (false)`, and no update policy), so
-- a repair has to be a definer function. This one:
--
--   * requires `public.can('adjust_stock')` — the same authority the stock ledger
--     itself asks for, because settling a hold changes what is available to
--     promise exactly as an adjustment changes what is on the shelf;
--   * requires a reason, and writes it to the order's own timeline as a `note`
--     event, so the repair is legible to whoever works that order next;
--   * is idempotent in one direction and refuses the other: releasing a hold that
--     was already converted would return units the sale has taken (an oversell
--     created by the repair tool), so it raises instead — the same shape as
--     `pos_settle_refund`;
--   * derives any corrected quantity from `online_order_items`, so a caller
--     cannot invent a hold of a size the order never asked for;
--   * **never writes `products.stock_quantity` and never writes
--     `stock_movements`.** The order's transition already had its stock effect —
--     the sale deducted, or the cancellation restored. A repair settles the hold's
--     own bookkeeping and nothing else; moving stock here would be the
--     double-count the reservation model exists to prevent.
--
-- What this file deliberately does NOT do
--   * it does not write `audit_log`. The app writes that row from
--     `reservationRepair.repairHold()` in demo and live mode alike, exactly like
--     `return.created` (0022) and the Phase 13 business events (0024), so the
--     trail reads identically whichever mode the shop runs. This file only adds
--     the *vocabulary* those rows need, because `audit_log.action` references
--     `public.audit_actions(action)` and the insert trigger derives `entity` from
--     that table.
--   * it does not create a second reservation table, a second hold mechanism, or
--     a parallel timeline. It repairs rows in the table 0017 created.
--   * it does not widen any read: `stock_reservations` stays staff-only (0017).
--   * it is idempotent, like every migration here: re-running it changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── audit vocabulary · stock holds ──────────────────────────────────────────
-- Four actions, because they answer four different questions: who gave the units
-- back, who marked them as already sold, who corrected a quantity, and who
-- restored a hold that had gone missing. All four are written by the app, in
-- both modes, against the new `reservation` entity.
insert into public.audit_actions (action, entity) values
  ('reservation.released',    'reservation'),
  ('reservation.converted',   'reservation'),
  ('reservation.reconciled',  'reservation'),
  ('reservation.held',        'reservation')
on conflict (action) do nothing;

-- ── the repair function ─────────────────────────────────────────────────────
create or replace function public.repair_stock_reservation(
  p_action         text,
  p_reservation_id uuid,
  p_order_id       uuid,
  p_product_id     uuid,
  p_quantity       integer,
  p_reason         text,
  p_user_id        text,
  p_user_name      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action       text := lower(btrim(coalesce(p_action, '')));
  v_reason       text := nullif(btrim(coalesce(p_reason, '')), '');
  v_user_id      text := coalesce(auth.uid()::text, p_user_id, '');
  v_user_name    text := coalesce(nullif(btrim(coalesce(p_user_name, '')), ''),
                                 (select p.name from public.profiles p where p.id = auth.uid()),
                                 'System');
  v_reservation  public.stock_reservations%rowtype;
  v_order        public.online_orders%rowtype;
  v_expected     integer;
  v_before       jsonb;
  v_note         text;
  -- Where a release or a convert is heading, computed once. It has to be a
  -- variable: plpgsql reads the first `then` it meets as the IF's own, so a CASE
  -- inline in a condition is a syntax error, not a value.
  v_wanted       text;
begin
  v_wanted := case when v_action = 'release' then 'released' else 'converted' end;
  -- Oversight, not till work: the same capability the stock ledger asks for.
  if not public.can('adjust_stock') then
    raise exception 'Only a manager or the inventory clerk can repair stock holds'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;

  if v_action not in ('release', 'convert', 'reconcile', 'hold') then
    raise exception 'Unknown repair action %', coalesce(p_action, '(none)')
      using errcode = 'check_violation';
  end if;

  -- ── 'hold': restore a hold a pending order should already have ────────────
  if v_action = 'hold' then
    select * into v_order from public.online_orders where id = p_order_id for update;
    if not found then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    if v_order.status <> 'pending' then
      raise exception 'A % order does not hold stock, so there is nothing to repair',
        v_order.status::text using errcode = 'check_violation';
    end if;

    select coalesce(sum(i.quantity), 0)::integer into v_expected
    from public.online_order_items i
    where i.order_id = v_order.id and i.product_id = p_product_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'The order has no line for this product' using errcode = 'check_violation';
    end if;
    if p_quantity is not null and p_quantity <> v_expected then
      raise exception 'The order asks for %; a repair cannot hold a different number', v_expected
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.products p
      where p.id = p_product_id and p.stock_tracking_enabled
    ) then
      raise exception 'This product does not track stock, so it holds nothing'
        using errcode = 'check_violation';
    end if;

    -- Two holds on one line would hide the same units twice.
    select * into v_reservation
    from public.stock_reservations
    where online_order_id = v_order.id and product_id = p_product_id and status = 'reserved'
    for update;
    if found then
      return jsonb_build_object(
        'reservation', to_jsonb(v_reservation),
        'before', jsonb_build_object('status', v_reservation.status,
                                     'quantity', v_reservation.quantity,
                                     'resolved_at', v_reservation.resolved_at),
        'already_resolved', true,
        'order_number', v_order.order_number);
    end if;

    insert into public.stock_reservations (online_order_id, product_id, quantity, status)
    values (v_order.id, p_product_id, v_expected, 'reserved'::public.reservation_status)
    returning * into v_reservation;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind,
            'Hold restored · ' || v_expected || ' unit(s) · ' || v_reason,
            auth.uid(), v_user_name);

    return jsonb_build_object(
      'reservation', to_jsonb(v_reservation),
      'before', jsonb_build_object('status', null, 'quantity', 0, 'resolved_at', null),
      'already_resolved', false,
      'order_number', v_order.order_number);
  end if;

  -- ── release / convert / reconcile: one existing row ───────────────────────
  if p_reservation_id is null then
    raise exception 'A reservation id is required' using errcode = 'check_violation';
  end if;

  select * into v_reservation
  from public.stock_reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception 'Reservation not found' using errcode = 'P0002';
  end if;

  v_before := jsonb_build_object('status', v_reservation.status,
                                 'quantity', v_reservation.quantity,
                                 'resolved_at', v_reservation.resolved_at);

  select * into v_order from public.online_orders where id = v_reservation.online_order_id for update;

  -- ── a resolved row: repeatable in its own direction, refused in the other ──
  if v_reservation.status <> 'reserved' then
    if v_action = 'reconcile' then
      -- The only thing a settled row can still be wrong about is its own
      -- timestamp, which the table's check constraint requires.
      if v_reservation.resolved_at is not null then
        return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                  'already_resolved', true,
                                  'order_number', v_order.order_number);
      end if;
      update public.stock_reservations
      set resolved_at = now()
      where id = v_reservation.id
      returning * into v_reservation;

      if found and v_order.id is not null then
        insert into public.order_events (order_id, kind, note, user_id, user_name)
        values (v_order.id, 'note'::public.order_event_kind,
                'Hold reconciled · resolved timestamp recorded · ' || v_reason,
                auth.uid(), v_user_name);
      end if;

      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', false,
                                'order_number', v_order.order_number);
    end if;

    if v_reservation.status::text = v_wanted then
      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', true,
                                'order_number', v_order.order_number);
    end if;

    raise exception 'This hold was already %; it cannot be %',
      v_reservation.status::text, v_wanted
      using errcode = 'check_violation';
  end if;

  -- ── reconcile an open hold: the quantity is the order's own ───────────────
  if v_action = 'reconcile' then
    if v_order.id is null then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    if v_order.status <> 'pending' then
      raise exception 'A % order does not hold stock — release or convert the hold instead',
        v_order.status::text using errcode = 'check_violation';
    end if;

    select coalesce(sum(i.quantity), 0)::integer into v_expected
    from public.online_order_items i
    where i.order_id = v_order.id and i.product_id = v_reservation.product_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'The order has no line for this product — release the hold instead'
        using errcode = 'check_violation';
    end if;
    if p_quantity is not null and p_quantity <> v_expected then
      raise exception 'The order asks for %; a repair cannot hold a different number', v_expected
        using errcode = 'check_violation';
    end if;
    if v_expected = v_reservation.quantity then
      return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                                'already_resolved', true,
                                'order_number', v_order.order_number);
    end if;

    update public.stock_reservations
    set quantity = v_expected
    where id = v_reservation.id
    returning * into v_reservation;

    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind,
            'Hold reconciled · ' || (v_before->>'quantity') || ' → ' || v_expected || ' units · ' || v_reason,
            auth.uid(), v_user_name);

    return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                              'already_resolved', false,
                              'order_number', v_order.order_number);
  end if;

  -- ── release / convert ─────────────────────────────────────────────────────
  update public.stock_reservations
  set status = v_wanted::public.reservation_status,
      resolved_at = now()
  where id = v_reservation.id
  returning * into v_reservation;

  v_note := 'Hold ' || v_reservation.status::text || ' during reconciliation · '
            || (v_before->>'quantity') || ' unit(s) · ' || v_reason;
  if v_order.id is not null then
    insert into public.order_events (order_id, kind, note, user_id, user_name)
    values (v_order.id, 'note'::public.order_event_kind, v_note, auth.uid(), v_user_name);
  end if;

  return jsonb_build_object('reservation', to_jsonb(v_reservation), 'before', v_before,
                            'already_resolved', false,
                            'order_number', v_order.order_number);
end;
$$;

grant execute on function public.repair_stock_reservation(
  text, uuid, uuid, uuid, integer, text, text, text
) to authenticated;

comment on function public.repair_stock_reservation(
  text, uuid, uuid, uuid, integer, text, text, text
) is
  'Repairs one stock hold: release or convert a hold whose order moved on, reconcile a hold whose quantity disagrees with its order line, or restore a hold a pending order lost. Requires adjust_stock, demands a reason, repeats a resolution as a no-op, refuses to reverse one, derives every quantity from the order lines, and never writes products.stock_quantity — the order''s own transition already had its stock effect. The audit row is written by the application, in demo and live mode alike.';

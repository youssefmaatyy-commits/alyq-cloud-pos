-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0008
-- Phase 6 — InstaPay payment confirmation workflow.
--
-- Adds the "who confirmed this InstaPay payment, and when" audit columns and a
-- dedicated, transactional `pos_confirm_payment` RPC. The RPC is idempotent,
-- only applies to InstaPay sales that are still pending, and touches nothing
-- but the payment fields — totals, items, stock and movements are unchanged,
-- and no duplicate sale is ever created.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── confirmation audit columns ────────────────────────────────────────────
alter table public.sales
  add column if not exists paid_at      timestamptz,
  add column if not exists paid_by      text,
  add column if not exists paid_by_name text;

comment on column public.sales.paid_at      is 'When an InstaPay payment was confirmed as paid. Cash is stamped at completion.';
comment on column public.sales.paid_by      is 'User id that confirmed the InstaPay payment.';
comment on column public.sales.paid_by_name is 'Snapshot name of the user that confirmed the InstaPay payment.';

-- Cash sales were paid the moment they completed; mark their audit columns.
-- Pending InstaPay rows are deliberately left null until confirmation.
update public.sales
   set paid_at = created_at, paid_by = user_id, paid_by_name = user_name
 where payment_method = 'cash'
   and payment_status  = 'paid'
   and paid_at is null;

-- ── RLS: staff may confirm a pending payment via the RPC only ─────────────
-- Direct table writes remain denied (migration 0007 disallows INSERT; confirm
-- actions are funnelled through pos_confirm_payment, which runs definer and
-- re-checks the row state inside the transaction).
drop policy if exists "sales_update_confirmation_authenticated" on public.sales;
create policy "sales_update_confirmation_authenticated"
  on public.sales for update
  to authenticated
  using (payment_method = 'instapay' and payment_status = 'pending')
  with check (payment_method = 'instapay' and payment_status in ('pending', 'paid'));

-- ── confirm payment (transactional, idempotent) ───────────────────────────
create or replace function public.pos_confirm_payment(
  p_sale_id   uuid,
  p_user_id   text,
  p_user_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent: an already-paid sale is returned unchanged (no new sale,
  -- no totals/stock change, no error on a double-clicked confirm).
  if v_sale.payment_status = 'paid' or v_sale.status = 'completed' then
    return jsonb_build_object('sale_id', v_sale.id, 'already_paid', true);
  end if;

  if v_sale.payment_method <> 'instapay' then
    raise exception 'Only InstaPay sales are confirmed here'
      using errcode = 'check_violation';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Cannot confirm a voided sale'
      using errcode = 'check_violation';
  end if;

  update public.sales
     set status         = 'completed',
         payment_status = 'paid',
         paid_at        = now(),
         paid_by        = p_user_id,
         paid_by_name   = p_user_name
   where id = p_sale_id;

  return jsonb_build_object('sale_id', p_sale_id, 'already_paid', false);
end;
$$;

grant execute on function public.pos_confirm_payment(uuid, text, text) to authenticated;

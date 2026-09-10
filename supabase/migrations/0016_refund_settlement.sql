-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0016
-- Production readiness — the refund lifecycle: owed, then settled, once.
--
-- Until now a refund had a `pending` state in the data model and no way out of
-- it. `pos_process_return` accepted `refund_status` from its payload, the enum
-- knew `pending`, and nothing in the database could move a refund on: the
-- cashier could record that money was owed and never hand it over. This
-- migration supplies the missing half.
--
--   pending ──(approve_refund)──► completed   money leaves the drawer
--                             └──► rejected    it never does, with a reason
--
-- The lifecycle is enforced in two places, on purpose:
--
--   * `pos_settle_refund()` is the RPC the application calls. It is
--     transactional, idempotent, checks the capability and writes the audit row
--     — the whole decision in one transaction.
--   * `enforce_refund_invariants()` is a trigger, so the same rules hold for a
--     writer that never calls the RPC at all (`service_role`, psql, a future
--     server-side job). RLS decides what a browser may do; the trigger decides
--     what the accounting permits. This is the pattern 0012 established for
--     shifts and expenses.
--
-- A refund is settled at most once. Re-settling in the same direction is
-- idempotent (the RPC reports `already_settled`); reversing a decision — a
-- completed refund "rejected", or the other way round — is refused outright,
-- because it would be a second movement of money wearing the first one's
-- paperwork. Corrections belong in a new refund.
--
-- ── Three defects fixed here on the way ───────────────────────────────────
-- 0015 found that `pos_complete_sale` built its invoice number with
-- `lpad(next_value::text - 1, …)`, which Postgres parses as `text - integer`
-- and refuses, so no sale could ever be recorded. The identical spelling sits
-- in this file's two number generators (`RET-` and `REF-`), which means no
-- return and no refund could ever be recorded either — the whole of 0010's
-- write path was dead in live mode. Both are fixed in the redefinition below.
--
-- The same migration also grants the tables 0010 created (they never had a
-- grant, and Supabase stopped granting new `public` tables in April 2026), and
-- treats a *rejected* refund as money that never left: it no longer consumes
-- the sale's refundable amount. A `pending` refund still does — it is a claim.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. settlement columns ─────────────────────────────────────────────────
-- `settled_at` is when the refund reached its final state (settled or
-- rejected), `settled_by`/`settled_by_name` who decided, and
-- `rejection_reason` why — mandatory for a rejection, meaningless otherwise.
alter table public.refund_records
  add column if not exists settled_at       timestamptz,
  add column if not exists settled_by       text,
  add column if not exists settled_by_name  text,
  add column if not exists rejection_reason text;

comment on column public.refund_records.settled_at is
  'When the refund reached its final state. Counts towards the shift that was open at this moment, falling back to created_at for counter-paid refunds recorded before 0016.';
comment on column public.refund_records.settled_by is
  'Who approved or rejected the refund.';
comment on column public.refund_records.rejection_reason is
  'Why a refund was rejected. Required when status = rejected, null otherwise.';

-- Backfill: every refund that was already `completed` was paid at the counter
-- when it was recorded, so it was settled then, by whoever recorded it. The
-- COALESCE keeps this idempotent and never overwrites a real settlement.
update public.refund_records
   set settled_at      = coalesce(settled_at, created_at),
       settled_by      = coalesce(settled_by, user_id),
       settled_by_name = coalesce(settled_by_name, user_name)
 where status = 'completed';

-- A refund in a final state must carry the stamp that proves it, and a rejected
-- one must carry a reason. Stated as a constraint so it cannot drift.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.refund_records'::regclass
       and conname = 'refund_records_settlement_consistent'
  ) then
    alter table public.refund_records
      add constraint refund_records_settlement_consistent check (
        -- `status::text`: a stored CHECK resolves the bare literals against the
        -- enum's own type otherwise, and Postgres then complains that
        -- `refund_status = text` has no operator.
        case status::text
          when 'pending'   then settled_at is null and rejection_reason is null
          when 'completed' then settled_at is not null and rejection_reason is null
          when 'rejected'  then settled_at is not null
                                 and rejection_reason is not null
                                 and btrim(rejection_reason) <> ''
        end
      );
  end if;
end
$$;

-- ── 2. the capability ─────────────────────────────────────────────────────
-- Settling is a manager's decision (plan D1): a cashier records the return and
-- the money is owed, but releasing it needs `approve_refund`. This mirrors
-- `ROLE_CAPABILITIES` in src/lib/permissions/roles.ts — `admin` and `manager`
-- hold every capability, and the capability list itself is extended there —
-- and the capability parity check fails if the two drift apart.
insert into public.role_capabilities (role, capability) values
  ('admin',   'approve_refund'),
  ('manager', 'approve_refund')
on conflict do nothing;

-- ── 3. the audit vocabulary ───────────────────────────────────────────────
-- A settlement is money moving, so it belongs in the trail. `refund.created`
-- is reserved for the record itself (WS6 wires the call site); the two below
-- are written by the RPC in this file.
insert into public.audit_actions (action, entity) values
  ('refund.created',  'refund'),
  ('refund.settled',  'refund'),
  ('refund.rejected', 'refund')
on conflict (action) do nothing;

-- ── 4. invariants, whatever the writer ────────────────────────────────────
/**
 * Keeps the refund lifecycle honest.
 *
 * INSERT — a refund created directly in a final state is stamped rather than
 *          refused (the counter case), a pending one may not carry a stamp,
 *          and a rejection must say why.
 * UPDATE — only `pending` may move, only to a final state, only with
 *          `approve_refund`, and the money itself (amount, sale, method,
 *          who recorded it) is immutable. Once a decision is taken it cannot be
 *          taken again.
 */
create or replace function public.enforce_refund_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := auth.uid()::text;
  v_name text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      new.settled_at       := null;
      new.settled_by       := null;
      new.settled_by_name  := null;
      new.rejection_reason := null;
    elsif new.status = 'rejected' then
      if new.rejection_reason is null or btrim(new.rejection_reason) = '' then
        raise exception 'A rejected refund needs a reason'
          using errcode = 'check_violation';
      end if;
      new.settled_at := coalesce(new.settled_at, now());
    else
      -- Completed at the counter: settled when it was recorded, by whoever
      -- recorded it.
      new.settled_at       := coalesce(new.settled_at, new.created_at, now());
      new.settled_by       := coalesce(new.settled_by, new.user_id);
      new.settled_by_name  := coalesce(new.settled_by_name, new.user_name);
      new.rejection_reason := null;
    end if;
    return new;
  end if;

  -- ── UPDATE ──
  if new.amount is distinct from old.amount
     or new.sale_id is distinct from old.sale_id
     or new.return_id is distinct from old.return_id
     or new.payment_method is distinct from old.payment_method
     or new.user_id is distinct from old.user_id
     or new.refund_number is distinct from old.refund_number
  then
    raise exception 'A refund record cannot be rewritten; the money is fixed'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'This refund was already settled as %', old.status
        using errcode = 'check_violation';
    end if;
    -- Cast explicitly: an `IN` list of bare literals is inferred as text[], and
    -- comparing an enum column to text has no operator.
    if new.status not in ('completed'::public.refund_status, 'rejected'::public.refund_status) then
      raise exception 'A refund may only be settled or rejected'
        using errcode = 'check_violation';
    end if;
    if not public.can('approve_refund') then
      raise exception 'Your role cannot settle a refund'
        using errcode = 'insufficient_privilege';
    end if;

    new.settled_at := coalesce(new.settled_at, now());
    if v_uid is not null then
      new.settled_by := v_uid;
      select p.name into v_name from public.profiles p where p.id = auth.uid();
      if v_name is not null then
        new.settled_by_name := v_name;
      end if;
    else
      new.settled_by      := coalesce(new.settled_by, old.user_id);
      new.settled_by_name := coalesce(new.settled_by_name, old.user_name);
    end if;

    if new.status = 'rejected' then
      if new.rejection_reason is null or btrim(new.rejection_reason) = '' then
        raise exception 'A rejected refund needs a reason'
          using errcode = 'check_violation';
      end if;
    else
      new.rejection_reason := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists refund_records_enforce_invariants on public.refund_records;
create trigger refund_records_enforce_invariants
  before insert or update on public.refund_records
  for each row execute function public.enforce_refund_invariants();

-- ── 5. pos_process_return, with three marked edits ────────────────────────
-- Same approach as 0015: a Postgres function body cannot be patched, so the
-- 0010 definition is reproduced with each change marked `0016:` in place.
--
--   (a) the counter read for `v_refunded_so_far` now ignores `rejected`
--       refunds — money that was refused never left the drawer and must not
--       consume the sale's refundable amount. `pending` still counts: it is a
--       claim on the money until someone decides.
--   (b) the return number and the refund number cast the difference instead of
--       the counter, fixing `operator does not exist: text - integer`.
--   (c) a refund recorded as `completed` is stamped as settled here and now,
--       so `settled_at` is always the moment the money actually moved. (The
--       trigger above would do this anyway; doing it explicitly keeps the
--       intent readable at the point the decision is made.)
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
begin
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

    select coalesce(sum(ri.quantity), 0) into v_already_returned
      from public.return_items ri
      join public.sales_returns r on r.id = ri.return_id
     where r.sale_id = v_sale.id and ri.sale_item_id = v_sale_item.id;

    if v_qty > (v_sale_item.quantity - v_already_returned) then
      raise exception 'Return quantity exceeds remaining returnable quantity for %', v_sale_item.sku
        using errcode = 'check_violation';
    end if;

    v_refund_total := v_refund_total + round((v_sale_item.unit_price * v_qty)::numeric, 2);
  end loop;

  if v_refund_total > (v_sale.total - v_refunded_so_far) then
    raise exception 'Refund exceeds remaining refundable amount for this sale'
      using errcode = 'check_violation';
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

    insert into public.return_items (
      return_id, sale_item_id, product_id, name_ar, name_en, sku, barcode,
      unit_price, quantity, line_total
    ) values (
      v_return_id, v_sale_item.id, v_sale_item.product_id, v_sale_item.name_ar,
      v_sale_item.name_en, v_sale_item.sku, v_sale_item.barcode,
      v_sale_item.unit_price, v_qty,
      round((v_sale_item.unit_price * v_qty)::numeric, 2)
    );

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

  return jsonb_build_object('return_id', v_return_id, 'refund_id', v_refund_id);
end;
$$;

grant execute on function public.pos_process_return(jsonb) to authenticated;

-- ── 6. the settlement RPC ─────────────────────────────────────────────────
/**
 * Approve or reject a refund that is waiting for approval.
 *
 * One transaction: the decision, the stamp, and the audit row. Calling it again
 * for the same refund is idempotent — it reports `already_settled` and writes
 * nothing. A refund that was already decided cannot be re-decided.
 *
 * `p_decision` is `completed` (default, money leaves) or `rejected` (it never
 * does, and `p_reason` is then required).
 *
 * Note on the signature: the readiness plan sketched
 * `pos_settle_refund(uuid, text, text)`. The two extra parameters are defaulted,
 * so a three-argument call still works exactly as sketched; rejection simply
 * needs somewhere to say why, and a second RPC for one word of input would be
 * worse. Both defaults keep the call site honest.
 *
 * The actor is stamped from the session when there is one (`auth.uid()`), which
 * is what the invariant trigger also does; the parameters are the fallback for
 * a server-side caller with no session.
 */
create or replace function public.pos_settle_refund(
  p_refund_id uuid,
  p_user_id   text,
  p_user_name text,
  p_decision  text default 'completed',
  p_reason    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund public.refund_records%rowtype;
  v_actor  text := coalesce(auth.uid()::text, p_user_id);
  v_name   text := p_user_name;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_decision not in ('completed', 'rejected') then
    raise exception 'A refund may only be settled or rejected, not %', p_decision
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'A rejected refund needs a reason'
      using errcode = 'check_violation';
  end if;
  if not public.can('approve_refund') then
    raise exception 'Your role cannot settle a refund'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_refund from public.refund_records where id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent in the same direction, refused in the other.
  if v_refund.status <> 'pending' then
    if v_refund.status = p_decision::public.refund_status then
      return jsonb_build_object(
        'refund_id', p_refund_id, 'status', v_refund.status, 'already_settled', true
      );
    end if;
    raise exception 'This refund was already settled as %', v_refund.status
      using errcode = 'check_violation';
  end if;

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    v_name := coalesce(v_name, p_user_name);
  end if;

  update public.refund_records
     set status           = p_decision::public.refund_status,
         settled_at       = now(),
         settled_by       = v_actor,
         settled_by_name  = v_name,
         rejection_reason = case when p_decision = 'rejected' then v_reason else null end
   where id = p_refund_id and status = 'pending';

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    case when p_decision = 'rejected' then 'refund.rejected' else 'refund.settled' end,
    'refund',
    p_refund_id::text,
    v_refund.refund_number,
    jsonb_build_object(
      'amount',   v_refund.amount,
      'method',   v_refund.payment_method::text,
      'sale',     v_refund.sale_number,
      'decision', p_decision,
      'reason',   v_reason
    ),
    coalesce(v_actor, v_refund.user_id),
    coalesce(v_name, v_refund.user_name)
  );

  return jsonb_build_object(
    'refund_id', p_refund_id, 'status', p_decision, 'already_settled', false
  );
end;
$$;

grant execute on function public.pos_settle_refund(uuid, text, text, text, text) to authenticated;

-- ── 7. make the returns path reachable through the API ───────────────────
-- Same gap as 0015 closed for the register: these three tables were created in
-- 0010 with policies but no grant, and Supabase stopped granting new `public`
-- tables to `authenticated` on 2026-04-28 — so a project built from these
-- migrations today answers `permission denied` on every returns screen.
--
-- SELECT only. Returns, refunds and stock movements are all written by the two
-- `security definer` RPCs above; the direct-write policies stay
-- `with check (false)`, and a missing write grant is the second lock.
grant select on public.sales_returns   to authenticated;
grant select on public.return_items    to authenticated;
grant select on public.refund_records  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0023
-- Phase 12 — approval limits: the rules, the requests they raise, and the
--            decisions an authorised user makes about them.
--
-- The business rule (requirement 2) is that some acts are fine below a
-- threshold and need a second person above it: a discount over a percentage, a
-- refund over an amount, an expense over an amount, and — if the shop wants it —
-- every price change. What this file builds is the *ledger* for that rule:
--
--   * `approval_rules`      one row, the thresholds, editable by whoever holds
--                           `manage_settings`. Readable by every signed-in staff
--                           member, because a cashier who cannot see the limit
--                           cannot work to it.
--   * `approval_requests`   one row per over-limit act: what was asked for, by
--                           whom, when, why, the value before and the value
--                           wanted, the threshold that was exceeded, and — once
--                           somebody decides — who decided, when, and what they
--                           wrote. Append-only in every way that matters: the
--                           money columns cannot be rewritten and a request is
--                           decided once.
--   * `submit_approval_request(jsonb)` / `decide_approval_request(uuid, text, text)`
--                           the only writers, both `security definer`, both
--                           capability-checked through `public.can()`, both
--                           writing to the one audit trail.
--
-- What this file DELIBERATELY DOES NOT DO
--   * it does not create expenses, sales, refunds or price changes. Approving a
--     request records the *decision* here; the deferred act is then performed by
--     the app's own service funnel (`expenseService.createExpense`,
--     `returnService.settleRefund`, `catalogService.saveProduct`,
--     `saleService.completeSale`), which re-checks the actor's capability for
--     that act and runs the one implementation of it that exists. `mark_approval_applied`
--     records what that produced, so a request cannot be applied twice. Keeping
--     the acts in the services rather than duplicating them in PL/pgSQL is what
--     stops the two from drifting — the same reason `pos_settle_refund` is the
--     only writer of a refund's status and the app calls it.
--   * it does not add a second audit trail, a second settings table or a second
--     numbering scheme. `audit_log` gets the vocabulary; the counters follow the
--     `return_counters` shape from 0010.
--   * it does not decide limits for the shop. The defaults below are a starting
--     position an admin edits on Settings → Approval Rules.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the capability that decides ──────────────────────────────────────────
-- Mirrors `approve_limit_request` in src/lib/permissions/roles.ts. The migration
-- check diffs the two row for row, so neither side can move alone.
--
-- One capability for every kind of request, on purpose: `change_price` cannot be
-- the gate for a price-change request because a cashier holds `change_price`, and
-- the person asking for the rise must not be the person signing it off.
insert into public.role_capabilities (role, capability) values
  ('admin',   'approve_limit_request'),
  ('manager', 'approve_limit_request')
on conflict (role, capability) do nothing;

-- ── 2. vocabularies ─────────────────────────────────────────────────────────
do $$ begin
  create type public.approval_request_kind as enum (
    'discount',      -- a sale discount above `discount_limit_percent`
    'refund',        -- a refund above `refund_limit_amount`
    'expense',       -- an expense above `expense_limit_amount`
    'price_change'   -- a selling price or cost move, when the rule is on
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.approval_request_status as enum (
    'pending',       -- waiting for somebody who may decide it
    'approved',      -- decided yes; the deferred act may now be performed
    'rejected',      -- decided no; a note is required
    'cancelled'      -- withdrawn by the requester before anybody decided
  );
exception when duplicate_object then null; end $$;

-- ── 3. the rules ────────────────────────────────────────────────────────────
create table if not exists public.approval_rules (
  id                            smallint primary key default 1 check (id = 1),
  discount_limit_enabled        boolean        not null default true,
  discount_limit_percent        numeric(5, 2)  not null default 10.00
    check (discount_limit_percent >= 0 and discount_limit_percent <= 100),
  refund_limit_enabled          boolean        not null default true,
  refund_limit_amount           numeric(12, 2) not null default 1000.00
    check (refund_limit_amount >= 0),
  expense_limit_enabled         boolean        not null default true,
  expense_limit_amount          numeric(12, 2) not null default 500.00
    check (expense_limit_amount >= 0),
  price_change_approval_enabled boolean        not null default false,
  updated_by                    text,
  updated_by_name               text,
  updated_at                    timestamptz    not null default now()
);

comment on table public.approval_rules is
  'Single-row approval thresholds (Phase 12). Read by every signed-in staff member, written only through public.set_approval_rules().';

insert into public.approval_rules (id) values (1) on conflict (id) do nothing;

-- ── 4. the requests ─────────────────────────────────────────────────────────
create table if not exists public.approval_counters (
  id         smallint primary key default 1 check (id = 1),
  next_value bigint not null default 1
);
insert into public.approval_counters (id, next_value) values (1, 1) on conflict do nothing;

create table if not exists public.approval_requests (
  id               uuid primary key default gen_random_uuid(),
  request_number   text not null unique,
  kind             public.approval_request_kind not null,

  -- What the request is about. `entity_id` is blank for a request raised before
  -- the record exists (an expense or a discounted sale that has not been written
  -- yet) and filled once it does.
  entity_type      text not null,
  entity_id        text not null default '',
  entity_label     text not null default '',
  branch           text,

  -- The value being asked for and the threshold it crossed. `amount` is a
  -- percentage for `discount` and money for the other three; the app renders it
  -- accordingly, and `limit_value` says which rule fired.
  amount           numeric(12, 2) not null default 0,
  limit_value      numeric(12, 2),

  -- Requirement 2 asks for the previous value and the new value, so a reader can
  -- see the move without opening the record: {"selling_price": 68} → {"selling_price": 82}.
  previous_value   jsonb not null default '{}'::jsonb,
  new_value        jsonb not null default '{}'::jsonb,
  -- The deferred act's arguments, exactly as the service funnel would take them.
  payload          jsonb not null default '{}'::jsonb,

  reason           text not null default '',
  status           public.approval_request_status not null default 'pending',

  requested_by     text not null,
  requested_by_name text not null,
  requested_at     timestamptz not null default now(),

  decided_by       text,
  decided_by_name  text,
  decided_at       timestamptz,
  decision_note    text,
  -- What approving produced (expense id / refund id / sale id), written once by
  -- `mark_approval_applied` so the same decision cannot be executed twice.
  result_entity_id text,

  created_at       timestamptz not null default now(),

  constraint approval_requests_reason_not_blank
    check (btrim(reason) <> ''),
  constraint approval_requests_amount_not_negative
    check (amount >= 0),
  constraint approval_requests_values_are_objects
    check (jsonb_typeof(previous_value) = 'object' and jsonb_typeof(new_value) = 'object'
           and jsonb_typeof(payload) = 'object'),
  constraint approval_requests_decided_once
    check (status in ('pending', 'cancelled') or decided_at is not null)
);

create index if not exists approval_requests_status_idx  on public.approval_requests (status, requested_at desc);
create index if not exists approval_requests_kind_idx    on public.approval_requests (kind, requested_at desc);
create index if not exists approval_requests_requester_idx on public.approval_requests (requested_by, requested_at desc);
create index if not exists approval_requests_entity_idx  on public.approval_requests (entity_type, entity_id);

comment on table public.approval_requests is
  'Over-limit acts waiting for, or given, a decision (Phase 12). Written only by submit_approval_request / decide_approval_request / mark_approval_applied.';

-- ── 5. invariants ───────────────────────────────────────────────────────────
/**
 * Stamps who really asked and who really decided, and refuses to let a decision
 * be revisited or a request be edited into a different one.
 *
 * The shape is the one 0016 uses for refunds, because the failure mode is the
 * same: an approval is evidence, so the columns that make it evidence
 * (`amount`, `limit_value`, `previous_value`, `new_value`, `requested_by`) are
 * frozen at insert, and the status may move once, forward, by somebody holding
 * the capability.
 */
create or replace function public.enforce_approval_request_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := auth.uid()::text;
  v_name text;
begin
  if tg_op = 'DELETE' then
    raise exception 'An approval request cannot be deleted; it is the record of a decision'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' then
    if new.amount          is distinct from old.amount
       or new.limit_value  is distinct from old.limit_value
       or new.previous_value is distinct from old.previous_value
       or new.new_value    is distinct from old.new_value
       or new.payload      is distinct from old.payload
       or new.kind         is distinct from old.kind
       or new.requested_by is distinct from old.requested_by
       or new.request_number is distinct from old.request_number
    then
      raise exception 'An approval request cannot be rewritten; the ask is fixed'
        using errcode = 'check_violation';
    end if;

    if new.status is distinct from old.status then
      if old.status <> 'pending' then
        raise exception 'This request was already %', old.status
          using errcode = 'check_violation';
      end if;

      -- Withdrawing your own request is not a decision and needs no capability.
      if new.status = 'cancelled' then
        if coalesce(v_uid, '') <> old.requested_by and not public.can('approve_limit_request') then
          raise exception 'Only the requester may withdraw a request'
            using errcode = 'insufficient_privilege';
        end if;
        new.decided_at := coalesce(new.decided_at, now());
        new.decided_by := coalesce(new.decided_by, v_uid, old.requested_by);
        if new.decided_by_name is null then
          select p.name into v_name from public.profiles p where p.id = auth.uid();
          new.decided_by_name := coalesce(v_name, old.requested_by_name);
        end if;
        return new;
      end if;

      if not public.can('approve_limit_request') then
        raise exception 'Your role cannot decide an approval request'
          using errcode = 'insufficient_privilege';
      end if;

      if new.status = 'rejected' and (new.decision_note is null or btrim(new.decision_note) = '') then
        raise exception 'A rejected request needs a note saying why'
          using errcode = 'check_violation';
      end if;

      new.decided_at := coalesce(new.decided_at, now());
      if v_uid is not null then
        new.decided_by := v_uid;
        select p.name into v_name from public.profiles p where p.id = auth.uid();
        if v_name is not null then
          new.decided_by_name := v_name;
        end if;
      else
        new.decided_by      := coalesce(new.decided_by, old.requested_by);
        new.decided_by_name := coalesce(new.decided_by_name, old.requested_by_name);
      end if;
    end if;

    return new;
  end if;

  -- INSERT
  new.requested_at := coalesce(new.requested_at, now());
  if v_uid is not null then
    new.requested_by := v_uid;
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    if v_name is not null and (new.requested_by_name is null or btrim(new.requested_by_name) = '') then
      new.requested_by_name := v_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists approval_requests_invariants on public.approval_requests;
create trigger approval_requests_invariants
  before insert or update or delete on public.approval_requests
  for each row execute function public.enforce_approval_request_invariants();

-- ── 6. row level security ───────────────────────────────────────────────────
alter table public.approval_rules    enable row level security;
alter table public.approval_requests enable row level security;
alter table public.approval_counters enable row level security;

-- The thresholds are a shop policy, not a secret: everybody signed in reads them,
-- and the till quotes them back when it refuses a discount.
drop policy if exists approval_rules_read on public.approval_rules;
create policy approval_rules_read on public.approval_rules
  for select to authenticated
  using (true);

-- Writing the rules goes through `set_approval_rules()`; no direct write.
drop policy if exists approval_rules_no_direct_write on public.approval_rules;
create policy approval_rules_no_direct_write on public.approval_rules
  for update to authenticated
  using (false) with check (false);

-- A request is visible to whoever may decide it and to whoever raised it.
drop policy if exists approval_requests_read on public.approval_requests;
create policy approval_requests_read on public.approval_requests
  for select to authenticated
  using (public.can('approve_limit_request') or requested_by = auth.uid()::text);

drop policy if exists approval_requests_no_direct_insert on public.approval_requests;
create policy approval_requests_no_direct_insert on public.approval_requests
  for insert to authenticated
  with check (false);

drop policy if exists approval_requests_no_direct_update on public.approval_requests;
create policy approval_requests_no_direct_update on public.approval_requests
  for update to authenticated
  using (false) with check (false);

drop policy if exists approval_requests_no_delete on public.approval_requests;
create policy approval_requests_no_delete on public.approval_requests
  for delete to authenticated
  using (false);

-- The counter is read by nobody and written by the definer functions only.
drop policy if exists approval_counters_no_access on public.approval_counters;
create policy approval_counters_no_access on public.approval_counters
  for select to authenticated
  using (false);

-- ── 7. audit vocabulary ─────────────────────────────────────────────────────
insert into public.audit_actions (action, entity) values
  ('approval.requested',       'approval_request'),
  ('approval.approved',        'approval_request'),
  ('approval.rejected',        'approval_request'),
  ('approval.cancelled',       'approval_request'),
  ('approval.applied',         'approval_request'),
  ('approval_rules.updated',   'approval_rules')
on conflict (action) do nothing;

-- ── 8. reading the rules ────────────────────────────────────────────────────
create or replace function public.get_approval_rules()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.approval_rules;
begin
  select * into v_row from public.approval_rules where id = 1;
  if v_row.id is null then
    insert into public.approval_rules (id) values (1) on conflict (id) do nothing;
    select * into v_row from public.approval_rules where id = 1;
  end if;

  return jsonb_build_object(
    'discount_limit_enabled',        v_row.discount_limit_enabled,
    'discount_limit_percent',        v_row.discount_limit_percent,
    'refund_limit_enabled',          v_row.refund_limit_enabled,
    'refund_limit_amount',           v_row.refund_limit_amount,
    'expense_limit_enabled',         v_row.expense_limit_enabled,
    'expense_limit_amount',          v_row.expense_limit_amount,
    'price_change_approval_enabled', v_row.price_change_approval_enabled,
    'updated_by_name',               v_row.updated_by_name,
    'updated_at',                    v_row.updated_at
  );
end;
$$;

-- ── 9. writing the rules ────────────────────────────────────────────────────
/**
 * `p_rules` carries any subset of the seven rule fields. Editing the thresholds
 * is `manage_settings` work — the same capability that owns every other
 * system-wide setting — and the change is audited with the before and after,
 * because a raised limit is how an over-limit act becomes an ordinary one.
 */
create or replace function public.set_approval_rules(p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.approval_rules;
  v_after  public.approval_rules;
  v_name   text;
begin
  if not public.can('manage_settings') then
    raise exception 'Only an administrator may change the approval rules'
      using errcode = 'insufficient_privilege';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then
    raise exception 'Approval rules must be an object'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.approval_rules where id = 1;
  if v_before.id is null then
    insert into public.approval_rules (id) values (1) on conflict (id) do nothing;
    select * into v_before from public.approval_rules where id = 1;
  end if;

  update public.approval_rules set
    discount_limit_enabled        = coalesce((p_rules ->> 'discount_limit_enabled')::boolean,        discount_limit_enabled),
    discount_limit_percent        = coalesce((p_rules ->> 'discount_limit_percent')::numeric,        discount_limit_percent),
    refund_limit_enabled          = coalesce((p_rules ->> 'refund_limit_enabled')::boolean,          refund_limit_enabled),
    refund_limit_amount           = coalesce((p_rules ->> 'refund_limit_amount')::numeric,           refund_limit_amount),
    expense_limit_enabled         = coalesce((p_rules ->> 'expense_limit_enabled')::boolean,         expense_limit_enabled),
    expense_limit_amount          = coalesce((p_rules ->> 'expense_limit_amount')::numeric,          expense_limit_amount),
    price_change_approval_enabled = coalesce((p_rules ->> 'price_change_approval_enabled')::boolean, price_change_approval_enabled),
    updated_by                    = coalesce(auth.uid()::text, updated_by),
    updated_at                    = now()
  where id = 1
  returning * into v_after;

  select p.name into v_name from public.profiles p where p.id = auth.uid();
  update public.approval_rules
     set updated_by_name = coalesce(v_name, updated_by_name)
   where id = 1;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'approval_rules.updated',
    'approval_rules',
    '1',
    'Approval rules',
    jsonb_build_object(
      'previous', jsonb_build_object(
        'discount_limit_enabled',        v_before.discount_limit_enabled,
        'discount_limit_percent',        v_before.discount_limit_percent,
        'refund_limit_enabled',          v_before.refund_limit_enabled,
        'refund_limit_amount',           v_before.refund_limit_amount,
        'expense_limit_enabled',         v_before.expense_limit_enabled,
        'expense_limit_amount',          v_before.expense_limit_amount,
        'price_change_approval_enabled', v_before.price_change_approval_enabled
      ),
      'new', jsonb_build_object(
        'discount_limit_enabled',        v_after.discount_limit_enabled,
        'discount_limit_percent',        v_after.discount_limit_percent,
        'refund_limit_enabled',          v_after.refund_limit_enabled,
        'refund_limit_amount',           v_after.refund_limit_amount,
        'expense_limit_enabled',         v_after.expense_limit_enabled,
        'expense_limit_amount',          v_after.expense_limit_amount,
        'price_change_approval_enabled', v_after.price_change_approval_enabled
      )
    ),
    coalesce(auth.uid()::text, 'system'),
    coalesce(v_name, 'System')
  );

  return public.get_approval_rules();
end;
$$;

-- ── 10. raising a request ───────────────────────────────────────────────────
/**
 * `p_request` = {
 *   kind, entity_type, entity_id?, entity_label?, branch?, amount, limit_value?,
 *   previous_value?, new_value?, payload?, reason, requested_by?, requested_by_name?
 * }
 *
 * Anybody signed in may raise one — being refused is the point of the request —
 * but the reason is mandatory, the actor is stamped from the session, and the
 * number comes from the counter so two requests can never share one.
 */
create or replace function public.submit_approval_request(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind   public.approval_request_kind;
  v_number text;
  v_id     uuid;
  v_uid    text := auth.uid()::text;
  v_name   text;
  v_reason text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to raise an approval request'
      using errcode = 'insufficient_privilege';
  end if;

  begin
    v_kind := (p_request ->> 'kind')::public.approval_request_kind;
  exception when others then
    raise exception 'Unknown approval request kind: %', coalesce(p_request ->> 'kind', '(none)')
      using errcode = 'check_violation';
  end;

  v_reason := btrim(coalesce(p_request ->> 'reason', ''));
  if v_reason = '' then
    raise exception 'An approval request needs a reason'
      using errcode = 'check_violation';
  end if;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  update public.approval_counters set next_value = next_value + 1 where id = 1
    returning 'APR-' || lpad(next_value::text - 1, 6, '0') into v_number;

  insert into public.approval_requests (
    request_number, kind, entity_type, entity_id, entity_label, branch,
    amount, limit_value, previous_value, new_value, payload, reason,
    requested_by, requested_by_name
  ) values (
    v_number,
    v_kind,
    coalesce(nullif(btrim(p_request ->> 'entity_type'), ''), v_kind::text),
    coalesce(p_request ->> 'entity_id', ''),
    coalesce(nullif(btrim(p_request ->> 'entity_label'), ''), v_number),
    nullif(btrim(p_request ->> 'branch'), ''),
    coalesce((p_request ->> 'amount')::numeric, 0),
    (p_request ->> 'limit_value')::numeric,
    coalesce(p_request -> 'previous_value', '{}'::jsonb),
    coalesce(p_request -> 'new_value', '{}'::jsonb),
    coalesce(p_request -> 'payload', '{}'::jsonb),
    v_reason,
    v_uid,
    coalesce(nullif(btrim(p_request ->> 'requested_by_name'), ''), v_name, 'Staff')
  )
  returning id into v_id;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'approval.requested',
    'approval_request',
    v_id::text,
    v_number,
    jsonb_build_object(
      'kind',   v_kind::text,
      'amount', coalesce((p_request ->> 'amount')::numeric, 0),
      'limit',  (p_request ->> 'limit_value')::numeric,
      'entity', coalesce(p_request ->> 'entity_label', ''),
      'reason', v_reason
    ),
    v_uid,
    coalesce(v_name, 'Staff')
  );

  return jsonb_build_object('request_id', v_id, 'request_number', v_number, 'status', 'pending');
end;
$$;

-- ── 11. deciding a request ──────────────────────────────────────────────────
create or replace function public.decide_approval_request(
  p_request_id uuid,
  p_decision   text,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests;
  v_status  public.approval_request_status;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_uid     text := auth.uid()::text;
  v_name    text;
begin
  if not public.can('approve_limit_request') then
    raise exception 'Your role cannot decide an approval request'
      using errcode = 'insufficient_privilege';
  end if;

  if p_decision not in ('approved', 'rejected', 'cancelled') then
    raise exception 'A request may be approved, rejected or cancelled'
      using errcode = 'check_violation';
  end if;
  if p_decision = 'rejected' and v_note is null then
    raise exception 'A rejected request needs a note saying why'
      using errcode = 'check_violation';
  end if;

  select * into v_request from public.approval_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'Approval request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  if v_request.status = p_decision::public.approval_request_status then
    return jsonb_build_object(
      'request_id', v_request.id, 'status', v_request.status, 'already_decided', true
    );
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request was already %', v_request.status
      using errcode = 'check_violation';
  end if;

  v_status := p_decision::public.approval_request_status;
  select p.name into v_name from public.profiles p where p.id = auth.uid();

  update public.approval_requests
     set status        = v_status,
         decided_at    = now(),
         decided_by    = coalesce(v_uid, v_request.requested_by),
         decided_by_name = coalesce(v_name, v_request.requested_by_name),
         decision_note = v_note
   where id = p_request_id and status = 'pending';

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    case v_status
      when 'approved'  then 'approval.approved'
      when 'rejected'  then 'approval.rejected'
      else 'approval.cancelled'
    end,
    'approval_request',
    p_request_id::text,
    v_request.request_number,
    jsonb_build_object(
      'kind',   v_request.kind::text,
      'amount', v_request.amount,
      'entity', v_request.entity_label,
      'reason', v_request.reason,
      'note',   v_note,
      'requested_by', v_request.requested_by_name
    ),
    coalesce(v_uid, v_request.requested_by),
    coalesce(v_name, v_request.requested_by_name)
  );

  return jsonb_build_object(
    'request_id', p_request_id, 'status', v_status::text, 'already_decided', false
  );
end;
$$;

-- ── 12. recording what an approval produced ─────────────────────────────────
/**
 * The app performs the deferred act through its own service funnel and reports
 * the record it created. Once written, `result_entity_id` is fixed, so the same
 * approved request cannot be executed twice.
 */
create or replace function public.mark_approval_applied(
  p_request_id uuid,
  p_entity_id  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests;
  v_name    text;
begin
  select * into v_request from public.approval_requests where id = p_request_id;
  if v_request.id is null then
    raise exception 'Approval request % not found', p_request_id
      using errcode = 'P0002';
  end if;
  if v_request.status <> 'approved' then
    raise exception 'Only an approved request can be applied (this one is %)', v_request.status
      using errcode = 'check_violation';
  end if;
  if v_request.result_entity_id is not null then
    return jsonb_build_object(
      'request_id', v_request.id,
      'result_entity_id', v_request.result_entity_id,
      'already_applied', true
    );
  end if;
  if nullif(btrim(coalesce(p_entity_id, '')), '') is null then
    raise exception 'Applying a request needs the record it produced'
      using errcode = 'check_violation';
  end if;

  update public.approval_requests
     set result_entity_id = btrim(p_entity_id),
         entity_id        = case when btrim(entity_id) = '' then btrim(p_entity_id) else entity_id end
   where id = p_request_id and result_entity_id is null;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values (
    'approval.applied',
    'approval_request',
    p_request_id::text,
    v_request.request_number,
    jsonb_build_object(
      'kind',        v_request.kind::text,
      'amount',      v_request.amount,
      'result',      btrim(p_entity_id),
      'decided_by',  v_request.decided_by_name
    ),
    coalesce(auth.uid()::text, v_request.requested_by),
    coalesce(v_name, v_request.requested_by_name)
  );

  return jsonb_build_object(
    'request_id', v_request.id, 'result_entity_id', btrim(p_entity_id), 'already_applied', false
  );
end;
$$;

-- ── 13. reachability ────────────────────────────────────────────────────────
-- The gap 0015 and 0020 closed for the tables before these: a policy alone is
-- not enough, because Supabase stopped granting privileges on new `public`
-- tables by default.
grant select on public.approval_rules    to authenticated;
grant select on public.approval_requests to authenticated;

grant execute on function public.get_approval_rules() to authenticated;
grant execute on function public.set_approval_rules(jsonb) to authenticated;
grant execute on function public.submit_approval_request(jsonb) to authenticated;
grant execute on function public.decide_approval_request(uuid, text, text) to authenticated;
grant execute on function public.mark_approval_applied(uuid, text) to authenticated;

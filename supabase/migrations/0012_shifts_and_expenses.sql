-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0012
-- Production readiness — cashier shifts and shift expenses.
--
-- Design:
--   * `shifts`   — the accounting window a cashier works inside one
--                  branch/register. Opens with a counted float, closes with a
--                  counted drawer. The Z-report summary is computed by the
--                  application and persisted as `summary` on close (a frozen
--                  snapshot); while open it is recomputed live.
--   * `expenses` — money paid out of the drawer during a shift. Cash expenses
--                  reduce the expected cash; InstaPay and card expenses are
--                  reported but never touch the drawer.
--
-- Both tables are written DIRECTLY by the application (no RPC), which is why
-- this migration carries the invariants in triggers rather than relying on the
-- client: numbering, "one open shift", frozen-closed-shift immutability, and a
-- capability check on every insert/update. RLS restricts which capability is
-- needed; the triggers mean a service_role or direct SQL writer cannot break
-- the accounting either.
--
-- Limits mirror the application's validation exactly
-- (src/modules/shifts/validation.ts, src/modules/expenses/validation.ts), so a
-- row that the database accepts is always a row the UI could have produced.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── card payments ─────────────────────────────────────────────────────────
-- The expenses (and refunds) modules already offer "visa" as a payment method;
-- `public.payment_method` only held cash and InstaPay, so a card expense could
-- not be stored. The label is added here and used by the column below; the POS
-- sale path that must also accept it (its CHECK constraint treats non-InstaPay
-- as cash) is a separate, later change.
alter type public.payment_method add value if not exists 'visa';

-- ── enums ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'shift_status') then
    create type public.shift_status as enum ('open', 'closed');
  end if;
end
$$;

-- ── numbering ─────────────────────────────────────────────────────────────
-- Sequences rather than counter tables: the client inserts without a number and
-- the defaults below allocate one atomically, so two tills opening at the same
-- moment cannot collide. Formats match the demo repository exactly
-- (`SH-000001`, `EXP-000001`) so both modes read the same.
create sequence if not exists public.shift_number_seq as bigint start 1;
create sequence if not exists public.expense_number_seq as bigint start 1;

create or replace function public.next_shift_number()
returns text
language sql
volatile
as $$
  select 'SH-' || lpad(nextval('public.shift_number_seq')::text, 6, '0')
$$;

create or replace function public.next_expense_number()
returns text
language sql
volatile
as $$
  select 'EXP-' || lpad(nextval('public.expense_number_seq')::text, 6, '0')
$$;

-- ── shifts ────────────────────────────────────────────────────────────────
create table if not exists public.shifts (
  id                          uuid primary key default gen_random_uuid(),
  shift_number                text not null unique default public.next_shift_number(),
  branch                      text not null,
  register                    text not null,
  status                      public.shift_status not null default 'open',
  opening_cash                numeric(14, 2) not null check (opening_cash >= 0),
  opening_at                  timestamptz not null default now(),
  opened_by                   text not null,
  opened_by_name              text not null,
  closing_cash                numeric(14, 2) check (closing_cash >= 0),
  closed_at                   timestamptz,
  closed_by                   text,
  closed_by_name              text,
  notes                       text,
  summary                     jsonb,
  adjustment_approved_by      text,
  adjustment_approved_by_name text,
  adjustment_approved_at      timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint shifts_branch_len        check (char_length(branch) between 1 and 80),
  constraint shifts_register_len      check (char_length(register) between 1 and 80),
  constraint shifts_branch_not_blank  check (btrim(branch) <> ''),
  constraint shifts_register_not_blank check (btrim(register) <> ''),
  constraint shifts_notes_len         check (notes is null or char_length(notes) <= 400),
  constraint shifts_opening_max       check (opening_cash <= 10000000),
  constraint shifts_closing_max       check (closing_cash is null or closing_cash <= 10000000),
  -- a closed shift carries the whole closing picture, an open one carries none
  constraint shifts_closed_is_complete check (
    (status = 'open'   and closing_cash is null and closed_at is null)
    or
    (status = 'closed' and closing_cash is not null and closed_at is not null and summary is not null)
  ),
  -- approval is all-or-nothing
  constraint shifts_approval_complete check (
    (adjustment_approved_by is null and adjustment_approved_at is null)
    or
    (adjustment_approved_by is not null and adjustment_approved_at is not null
     and adjustment_approved_by_name is not null)
  )
);

-- Exactly one open shift, installation-wide. `getOpenShift()` in the
-- application asks for one; two would make the drawer ambiguous.
create unique index if not exists shifts_one_open_idx
  on public.shifts ((status)) where status = 'open';

create index if not exists shifts_opening_at_idx on public.shifts (opening_at desc);
create index if not exists shifts_opened_by_idx  on public.shifts (opened_by, opening_at desc);
create index if not exists shifts_status_idx     on public.shifts (status);

comment on table public.shifts is
  'Cashier shift: opens with a counted float, closes with a counted drawer. summary is the frozen Z-report snapshot.';

-- ── expenses ──────────────────────────────────────────────────────────────
create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  expense_number  text not null unique default public.next_expense_number(),
  name            text not null,
  category        text not null,
  amount          numeric(14, 2) not null check (amount > 0),
  payment_method  public.payment_method not null,
  spent_at        timestamptz not null default now(),
  notes           text,
  attachment_url  text,
  attachment_name text,
  branch          text,
  shift_id        uuid references public.shifts (id) on delete set null,
  user_id         text not null,
  user_name       text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- the categories the UI offers (EXPENSE_CATEGORIES)
  constraint expenses_category_allowed check (
    category in ('transport', 'maintenance', 'supplies', 'utilities', 'other')
  ),
  constraint expenses_name_len    check (char_length(name) between 1 and 80),
  constraint expenses_name_blank  check (btrim(name) <> ''),
  constraint expenses_amount_max  check (amount <= 1000000),
  constraint expenses_notes_len   check (notes is null or char_length(notes) <= 300),
  constraint expenses_branch_len  check (branch is null or char_length(branch) <= 80)
);

create index if not exists expenses_spent_at_idx on public.expenses (spent_at desc);
create index if not exists expenses_shift_idx    on public.expenses (shift_id) where shift_id is not null;
create index if not exists expenses_category_idx on public.expenses (category);
create index if not exists expenses_user_idx     on public.expenses (user_id, spent_at desc);

comment on table public.expenses is
  'Money paid out during a shift. Cash expenses reduce the drawer; InstaPay and card expenses do not.';

-- ── updated_at ────────────────────────────────────────────────────────────
drop trigger if exists shifts_set_updated_at on public.shifts;
create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function public.set_updated_at();

-- ── shift invariants ──────────────────────────────────────────────────────
/**
 * Keeps the accounting honest whatever the writer:
 *   · opening requires `open_shift`, closing requires `close_shift`;
 *   · a closed shift is frozen — only the adjustment approval may touch it;
 *   · approving an adjustment requires `approve_shift_adjustment`;
 *   · only one shift may be open at a time (checked here so the message is
 *     useful rather than a raw unique-violation).
 */
create or replace function public.enforce_shift_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if not public.can('open_shift') then
      raise exception 'Your role cannot open a shift' using errcode = 'insufficient_privilege';
    end if;
    if new.status <> 'open' then
      raise exception 'A shift must be created open' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.shifts s where s.status = 'open') then
      raise exception 'An open shift already exists; close it before opening another'
        using errcode = 'unique_violation';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'closed' then
    -- The only permitted change to a closed shift is recording who approved
    -- the difference (and the approval must not be re-written once signed).
    if new.branch         is distinct from old.branch
       or new.register       is distinct from old.register
       or new.status         is distinct from old.status
       or new.opening_cash   is distinct from old.opening_cash
       or new.opening_at     is distinct from old.opening_at
       or new.closing_cash   is distinct from old.closing_cash
       or new.closed_at      is distinct from old.closed_at
       or new.summary        is distinct from old.summary
       or new.notes          is distinct from old.notes
    then
      raise exception 'A closed shift cannot be edited'
        using errcode = 'check_violation';
    end if;
    if new.adjustment_approved_at is distinct from old.adjustment_approved_at
       and old.adjustment_approved_at is not null then
      raise exception 'This adjustment has already been approved'
        using errcode = 'check_violation';
    end if;
    if new.adjustment_approved_by is distinct from old.adjustment_approved_by
       or new.adjustment_approved_at is distinct from old.adjustment_approved_at
    then
      if not public.can('approve_shift_adjustment') then
        raise exception 'Your role cannot approve a shift adjustment'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    return new;
  end if;

  -- open → closing
  if new.status = 'closed' then
    if not public.can('close_shift') then
      raise exception 'Your role cannot close a shift' using errcode = 'insufficient_privilege';
    end if;
  elsif not public.can('open_shift') then
    raise exception 'Your role cannot edit a shift' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists shifts_enforce_invariants on public.shifts;
create trigger shifts_enforce_invariants
  before insert or update on public.shifts
  for each row execute function public.enforce_shift_invariants();

-- ── expense invariants ────────────────────────────────────────────────────
/**
 * An expense may be attached to a shift that is either open, or was open when
 * the expense happened — never to an unrelated closed shift. Also stamps the
 * caller as the recorder when the identity is known, so the trail cannot be
 * forged by a client that lies about `user_id`.
 */
create or replace function public.enforce_expense_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := auth.uid()::text;
  v_role public.app_role := public.current_user_role();
begin
  if tg_op = 'INSERT' then
    if not public.can('add_expense') then
      raise exception 'Your role cannot record an expense' using errcode = 'insufficient_privilege';
    end if;
    -- Attribute to the authenticated caller, whatever the client sent.
    if v_uid is not null then
      new.user_id := v_uid;
      if v_role is not null then
        new.user_name := (select p.name from public.profiles p where p.id = auth.uid());
      end if;
    end if;
  else
    if not public.can('edit_expense') then
      raise exception 'Your role cannot edit an expense' using errcode = 'insufficient_privilege';
    end if;
    -- Attribution is immutable: editing must not re-attribute the record.
    new.user_id    := old.user_id;
    new.user_name  := old.user_name;
    new.created_at := old.created_at;
  end if;

  if new.shift_id is not null then
    if not exists (select 1 from public.shifts s where s.id = new.shift_id) then
      raise exception 'Shift % not found', new.shift_id using errcode = 'foreign_key_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists expenses_enforce_invariants on public.expenses;
create trigger expenses_enforce_invariants
  before insert or update on public.expenses
  for each row execute function public.enforce_expense_invariants();

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Which capability is needed is decided by `public.can()`, i.e. by the same
-- matrix the UI uses. The trigger above repeats the check so that a writer who
-- bypasses RLS (service_role, a migration, psql) cannot skip it either.
alter table public.shifts   enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "shifts_select_viewers" on public.shifts;
create policy "shifts_select_viewers"
  on public.shifts for select to authenticated
  using (public.can('view_shifts'));

drop policy if exists "shifts_insert_till_staff" on public.shifts;
create policy "shifts_insert_till_staff"
  on public.shifts for insert to authenticated
  with check (public.can('open_shift'));

drop policy if exists "shifts_update_till_staff_or_approver" on public.shifts;
create policy "shifts_update_till_staff_or_approver"
  on public.shifts for update to authenticated
  using (public.can('close_shift') or public.can('approve_shift_adjustment'))
  with check (public.can('close_shift') or public.can('approve_shift_adjustment'));

drop policy if exists "shifts_no_direct_delete" on public.shifts;
create policy "shifts_no_direct_delete"
  on public.shifts for delete to authenticated using (false);

drop policy if exists "expenses_select_viewers" on public.expenses;
create policy "expenses_select_viewers"
  on public.expenses for select to authenticated
  using (public.can('view_shifts'));

drop policy if exists "expenses_insert_till_staff" on public.expenses;
create policy "expenses_insert_till_staff"
  on public.expenses for insert to authenticated
  with check (public.can('add_expense'));

drop policy if exists "expenses_update_managers" on public.expenses;
create policy "expenses_update_managers"
  on public.expenses for update to authenticated
  using (public.can('edit_expense'))
  with check (public.can('edit_expense'));

drop policy if exists "expenses_delete_managers" on public.expenses;
create policy "expenses_delete_managers"
  on public.expenses for delete to authenticated
  using (public.can('delete_expense'));

-- Defence in depth — see the note in 0011.
revoke all on public.shifts from anon;
revoke all on public.expenses from anon;

grant select, insert, update on public.shifts to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant usage, select on sequence public.shift_number_seq to authenticated;
grant usage, select on sequence public.expense_number_seq to authenticated;
grant execute on function public.next_shift_number() to authenticated;
grant execute on function public.next_expense_number() to authenticated;

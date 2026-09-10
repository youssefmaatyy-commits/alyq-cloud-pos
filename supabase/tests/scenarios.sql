-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Role-scenario tests (test fixture — NOT a migration)
--
-- Applied by `scripts/migrations.check.mjs` after the migrations and after the
-- idempotency pass (local PGlite driver by default; a real server only with
-- `--scenarios`). These run against the real policies and triggers, so they are
-- what proves the DATABASE enforces the permission matrix, not just the UI.
--
-- How it works:
--   · fixtures (three staff profiles) are inserted as the table owner, which
--     bypasses RLS;
--   · `request.jwt.claim.sub` impersonates a user — that is what `auth.uid()`
--     reads (see supabase-shim.sql);
--   · phase A/B run as the owner (RLS bypassed) to prove the INVARIANT TRIGGERS
--     hold for service_role / psql / a migration;
--   · phase C onwards run as `authenticated` — the role the browser actually
--     gets — to prove the RLS POLICIES hold;
--   · the role is switched exactly once and never switched back, because a
--     transaction-scoped role change is one-way for a non-superuser: that is
--     the security model working, so the ordering below is deliberate.
--
-- Each scenario raises a NOTICE (printed by the check script) or an EXCEPTION,
-- and expected refusals are caught in a nested BEGIN … EXCEPTION block, which
-- creates a savepoint so a refused statement does not abort the run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── fixtures ──────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin@alyq.local'),
  ('00000000-0000-4000-8000-0000000000c1', 'cashier@alyq.local'),
  ('00000000-0000-4000-8000-0000000000e1', 'viewer@alyq.local')
on conflict (id) do nothing;

insert into public.profiles (id, username, name, role, active) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin',    'Amina Admin',   'admin',   true),
  ('00000000-0000-4000-8000-0000000000c1', 'cashier',  'Karim Cashier', 'cashier', true),
  ('00000000-0000-4000-8000-0000000000e1', 'viewer',   'Vera Viewer',   'viewer',  true)
on conflict (id) do nothing;

/** Impersonate a user: sets the identity claim, and optionally the role. */
create or replace function pg_temp.become(p_user uuid, p_role text default null)
returns void
language plpgsql
as $$
begin
  if p_role is not null then
    perform set_config('role', p_role, true);
  end if;
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase A — the capability resolver (as owner; identity comes from the claim)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  if public.current_user_role() is distinct from 'cashier' then
    raise exception 'current_user_role() should be cashier, got %', public.current_user_role();
  end if;
  if not public.can('open_shift') then
    raise exception 'a cashier should hold open_shift';
  end if;
  if public.can('edit_expense') or public.can('view_audit_log') or public.can('apply_discount') then
    raise exception 'a cashier holds a manager-only capability';
  end if;

  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  if public.can('sell') then
    raise exception 'a viewer must not hold sell';
  end if;
  if not public.can('view_shifts') or not public.can('view_inventory') then
    raise exception 'a viewer should still hold the read capabilities';
  end if;

  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  if not public.can('apply_discount') or not public.can('view_audit_log') then
    raise exception 'an admin should hold every capability';
  end if;

  -- no session at all → no role → no capability
  perform pg_temp.become(null);
  if public.current_user_role() is not null then
    raise exception 'an anonymous caller must resolve to no role';
  end if;
  if public.can('view_shifts') or public.can('sell') then
    raise exception 'an anonymous caller must hold no capability';
  end if;
  if public.role_can('cashier', 'sell') is not true then
    raise exception 'role_can() should answer for an explicit role';
  end if;

  raise notice 'capability resolution — cashier, viewer, admin, anonymous';
end
$$;

-- ── deactivating a profile revokes everything ─────────────────────────────
do $$
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  update public.profiles set active = false where username = 'cashier';
  if public.can('open_shift') or public.can('sell') then
    raise exception 'a deactivated profile must hold no capability';
  end if;
  if public.current_user_role() is not null then
    raise exception 'a deactivated profile must resolve to no role';
  end if;
  update public.profiles set active = true where username = 'cashier';
  if not public.can('open_shift') then
    raise exception 'reactivating the profile should restore its capabilities';
  end if;
  raise notice 'deactivation revokes every capability; reactivation restores them';
end
$$;

-- ── an unknown profile (auth user without a role row) fails closed ────────
do $$
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000ff');
  if public.can('sell') or public.can('view_shifts') then
    raise exception 'a user with no profile must hold no capability';
  end if;
  raise notice 'a signed-in user with no profile row holds no capability';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase B — invariant triggers, with RLS bypassed (owner)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_shift_id uuid;
begin
  -- a viewer cannot open a shift even with RLS out of the way
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  begin
    insert into public.shifts (branch, register, opening_cash, opened_by, opened_by_name)
    values ('Main', 'Register 1', 1000, '00000000-0000-4000-8000-0000000000e1', 'Vera Viewer');
    raise exception 'the invariant trigger let a viewer open a shift';
  exception when insufficient_privilege then
    null;
  end;

  -- a shift must be created open, whichever writer
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  begin
    insert into public.shifts (branch, register, status, opening_cash, opened_by, opened_by_name, closing_cash, closed_at, summary)
    values ('Main', 'Register 1', 'closed', 1000, 'x', 'x', 1000, now(), '{}'::jsonb);
    raise exception 'a shift was created already closed';
  exception when check_violation then
    null;
  end;

  -- an unknown category / non-positive amount is refused by the table itself
  begin
    insert into public.expenses (name, category, amount, payment_method, user_id, user_name)
    values ('Bad', 'crypto', 10, 'cash', 'x', 'x');
    raise exception 'an unknown expense category was accepted';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.expenses (name, category, amount, payment_method, user_id, user_name)
    values ('Bad', 'other', 0, 'cash', 'x', 'x');
    raise exception 'a zero-amount expense was accepted';
  exception when check_violation then
    null;
  end;
  -- a viewer claim cannot record an expense either — checked as the owner (so
  -- RLS is out of the way) to prove the trigger is what refuses it
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  begin
    insert into public.expenses (name, category, amount, payment_method, user_id, user_name)
    values ('Bad', 'transport', 10, 'cash', 'x', 'x');
    raise exception 'an expense by a viewer claim was accepted';
  exception when insufficient_privilege then
    null;
  end;

  -- a valid cash-category expense may be recorded by the till tier
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  insert into public.expenses (name, category, amount, payment_method, user_id, user_name)
  values ('Card expense probe', 'supplies', 5, 'visa', 'forged', 'Forged');

  if (select user_id from public.expenses where name = 'Card expense probe') <> '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'the expense was not attributed to the caller';
  end if;
  if (select expense_number from public.expenses where name = 'Card expense probe') !~ '^EXP-[0-9]{6}$' then
    raise exception 'expense_number is not in the EXP-000000 format';
  end if;

  -- and the payment method the app offers for expenses is storable (card)
  if (select payment_method::text from public.expenses where name = 'Card expense probe') <> 'visa' then
    raise exception 'a card expense was not stored as visa';
  end if;

  delete from public.expenses where name = 'Card expense probe';

  raise notice 'invariant triggers hold without RLS (viewer refused, constraints enforced)';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase C onwards — as `authenticated`, the role the browser gets.
-- The role is switched once here and never switched back.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.become(null, 'authenticated');
end
$$;

-- ── RLS: a viewer may read but not write ──────────────────────────────────
do $$
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');

  begin
    insert into public.shifts (branch, register, opening_cash, opened_by, opened_by_name)
    values ('Main', 'Register 1', 1000, '00000000-0000-4000-8000-0000000000e1', 'Vera Viewer');
    raise exception 'RLS let a viewer open a shift';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.expenses (name, category, amount, payment_method, user_id, user_name)
    values ('Fuel', 'transport', 100, 'cash', 'x', 'x');
    raise exception 'RLS let a viewer record an expense';
  exception when insufficient_privilege then
    null;
  end;

  -- but reading is allowed, because a viewer holds view_shifts / view_inventory
  perform 1 from public.shifts;
  perform 1 from public.expenses;

  raise notice 'RLS — viewer reads the shift and expense ledgers, writes nothing';
end
$$;

-- ── RLS: a cashier works the till and is stamped as the recorder ──────────
do $$
declare
  v_shift_id   uuid;
  v_expense_id uuid;
  v_created_at timestamptz;
  v_rows       integer;
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');

  insert into public.shifts (branch, register, opening_cash, opened_by, opened_by_name)
  values ('Main', 'Register 1', 1000, '00000000-0000-4000-8000-0000000000c1', 'Karim Cashier')
  returning id into v_shift_id;

  if (select shift_number from public.shifts where id = v_shift_id) !~ '^SH-[0-9]{6}$' then
    raise exception 'shift_number is not in the SH-000000 format';
  end if;

  begin
    insert into public.shifts (branch, register, opening_cash, opened_by, opened_by_name)
    values ('Main', 'Register 2', 0, '00000000-0000-4000-8000-0000000000c1', 'Karim Cashier');
    raise exception 'a second open shift was allowed';
  exception when unique_violation then
    null;
  end;

  insert into public.expenses (name, category, amount, payment_method, shift_id, user_id, user_name)
  values ('Delivery fuel', 'transport', 100, 'cash', v_shift_id, 'forged-id', 'Forged Name')
  returning id, created_at into v_expense_id, v_created_at;

  if (select user_id from public.expenses where id = v_expense_id) <> '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'the expense was attributed to the client-supplied id';
  end if;

  -- A cashier may not edit or delete an expense. RLS does not raise here: the
  -- USING clause filters every row out, so the statement succeeds having
  -- changed nothing. The assertion is therefore about the effect.
  update public.expenses set amount = 500 where id = v_expense_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a cashier edit an expense (% row(s))', v_rows;
  end if;
  if (select amount from public.expenses where id = v_expense_id) <> 100 then
    raise exception 'the cashier''s edit changed the amount';
  end if;

  delete from public.expenses where id = v_expense_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a cashier delete an expense (% row(s))', v_rows;
  end if;
  if not exists (select 1 from public.expenses where id = v_expense_id) then
    raise exception 'the cashier''s delete removed the expense';
  end if;

  raise notice 'RLS — cashier opens one shift, records an expense, cannot edit or delete it';
end
$$;

-- ── shifts close, then freeze ─────────────────────────────────────────────
do $$
declare
  v_shift_id uuid;
  v_rows     integer;
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  select id into v_shift_id from public.shifts where status = 'open';

  update public.shifts
     set status = 'closed',
         closing_cash = 1400,
         closed_at = now(),
         closed_by = '00000000-0000-4000-8000-0000000000c1',
         closed_by_name = 'Karim Cashier',
         summary = '{"expected_cash": 1400, "actual_cash": 1400, "difference": 0}'::jsonb
   where id = v_shift_id;

  -- a closed shift is frozen
  begin
    update public.shifts set closing_cash = 9999 where id = v_shift_id;
    raise exception 'a closed shift was edited';
  exception when check_violation then
    null;
  end;

  -- a cashier may not sign off the difference (RLS lets the UPDATE through;
  -- the trigger refuses the approval columns — which is the point)
  begin
    update public.shifts
       set adjustment_approved_by = '00000000-0000-4000-8000-0000000000c1',
           adjustment_approved_by_name = 'Karim Cashier',
           adjustment_approved_at = now()
     where id = v_shift_id;
    raise exception 'a cashier was allowed to approve an adjustment';
  exception when insufficient_privilege then
    null;
  end;

  -- a viewer cannot update a shift at all (RLS filters the row out)
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  update public.shifts set notes = 'viewer note' where id = v_shift_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a viewer update a shift (% row(s))', v_rows;
  end if;
  if (select notes from public.shifts where id = v_shift_id) is not null then
    raise exception 'the viewer''s note was written';
  end if;

  raise notice 'RLS — shift closes, freezes, and only a manager may approve the difference';
end
$$;

-- ── a manager approves once; expenses become editable ─────────────────────
do $$
declare
  v_shift_id   uuid;
  v_expense_id uuid;
begin
  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  select id into v_shift_id from public.shifts order by opening_at desc limit 1;
  select id into v_expense_id from public.expenses order by spent_at desc limit 1;

  update public.shifts
     set adjustment_approved_by = '00000000-0000-4000-8000-0000000000a1',
         adjustment_approved_by_name = 'Amina Admin',
         adjustment_approved_at = now()
   where id = v_shift_id;

  begin
    update public.shifts set adjustment_approved_at = now() + interval '1 hour' where id = v_shift_id;
    raise exception 'an adjustment was approved twice';
  exception when check_violation then
    null;
  end;

  -- the manager may edit an expense, but not re-attribute it or move its date
  update public.expenses set amount = 250, user_id = 'forged-again', user_name = 'Forged Again'
   where id = v_expense_id;

  if (select user_id from public.expenses where id = v_expense_id) <> '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'editing an expense re-attributed it';
  end if;

  -- and may delete it
  delete from public.expenses where id = v_expense_id;
  if exists (select 1 from public.expenses where id = v_expense_id) then
    raise exception 'a manager could not delete an expense';
  end if;

  raise notice 'RLS — manager approves the difference once, edits and deletes expenses';
end
$$;

-- ── profile writes are admin-only RPCs, never direct ──────────────────────
do $$
begin
  -- A viewer cannot promote anyone. Unlike `shifts`, `profiles` has no UPDATE
  -- grant at all, so this is a hard refusal (42501) rather than a filtered
  -- statement; both outcomes are acceptable as long as the role does not change.
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  begin
    update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000e1';
    if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000e1') <> 'viewer' then
      raise exception 'a viewer promoted itself to admin';
    end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.set_staff_role('00000000-0000-4000-8000-0000000000e1', 'admin');
    raise exception 'a non-admin ran set_staff_role';
  exception when insufficient_privilege then
    null;
  end;

  -- an admin can, but not on their own row
  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  perform public.set_staff_role('00000000-0000-4000-8000-0000000000e1', 'cashier');
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000e1') <> 'cashier' then
    raise exception 'the admin role change did not apply';
  end if;
  begin
    perform public.set_staff_role('00000000-0000-4000-8000-0000000000a1', 'viewer');
    raise exception 'an admin demoted itself';
  exception when check_violation then
    null;
  end;
  perform public.set_staff_role('00000000-0000-4000-8000-0000000000e1', 'viewer');

  raise notice 'RLS — only an admin changes roles, and never their own';
end
$$;

-- ── leave no session claim behind ─────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

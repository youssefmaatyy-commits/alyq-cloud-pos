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

-- The inserts above fire `handle_new_user()`, which creates a viewer profile
-- for any account without role metadata; the upsert below then states the test
-- identities outright.
insert into public.profiles (id, username, name, role, active) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin',    'Amina Admin',   'admin',   true),
  ('00000000-0000-4000-8000-0000000000c1', 'cashier',  'Karim Cashier', 'cashier', true),
  ('00000000-0000-4000-8000-0000000000e1', 'viewer',   'Vera Viewer',   'viewer',  true)
on conflict (id) do update
  set username = excluded.username,
      name     = excluded.name,
      role     = excluded.role,
      active   = excluded.active;

-- A catalog row for the POS payment scenarios: one item at 10.00, plenty of
-- stock, so a sale total is easy to reason about.
insert into public.categories (id, name_ar, name_en) values
  ('00000000-0000-4000-8000-0000000000f1', 'مشروبات', 'Beverages')
on conflict (id) do nothing;

insert into public.products (
  id, sku, barcode, name_ar, name_en, category_id,
  selling_price, cost_price, stock_quantity
) values (
  '00000000-0000-4000-8000-0000000000f2', 'SCN-001', '6291000000011', 'ماء', 'Water',
  '00000000-0000-4000-8000-0000000000f1', 10.00, 5.00, 500
)
on conflict (id) do update
  set selling_price  = excluded.selling_price,
      stock_quantity = excluded.stock_quantity;

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

  -- audit_log: an unknown action cannot be written at all (foreign key into
  -- the vocabulary), and the entity is derived from the action rather than
  -- believed
  begin
    insert into public.audit_log (action, entity, entity_id, entity_label, user_id, user_name)
    values ('sale.completed', 'sale', 'sale-1', 'INV-000001', 'x', 'x');
    raise exception 'an unknown audit action was accepted';
  exception when foreign_key_violation then
    null;
  end;

  insert into public.audit_log (action, entity, entity_id, entity_label, user_id, user_name)
  values ('shift.opened', 'expense', 'shift-probe', 'SH-000001', 'forged', 'Forged');

  if (select entity from public.audit_log where entity_id = 'shift-probe') <> 'shift' then
    raise exception 'the audit entity was taken from the payload instead of the action';
  end if;
  if (select user_id from public.audit_log where entity_id = 'shift-probe') <> '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'the audit row was attributed to the client-supplied user';
  end if;

  -- append-only, even for the owner: this is what protects service_role, psql
  -- and any future migration from rewriting history
  begin
    update public.audit_log set entity_label = 'tampered' where entity_id = 'shift-probe';
    raise exception 'the audit log allowed an UPDATE';
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.audit_log where entity_id = 'shift-probe';
    raise exception 'the audit log allowed a DELETE';
  exception when insufficient_privilege then
    null;
  end;
  if (select entity_label from public.audit_log where entity_id = 'shift-probe') <> 'SH-000001' then
    raise exception 'the audit row was modified';
  end if;

  -- ── staff onboarding (owner: this models Supabase creating the account) ──
  -- no metadata → viewer, inactive: the fail-closed default when public sign-up
  -- is left enabled by mistake
  insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'newbie@alyq.local');
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f1') <> 'viewer'
     or (select active from public.profiles where id = '00000000-0000-4000-8000-0000000000f1') is not false then
    raise exception 'an account without role metadata should become an inactive viewer';
  end if;
  if (select username from public.profiles where id = '00000000-0000-4000-8000-0000000000f1') <> 'newbie' then
    raise exception 'the username was not derived from the email';
  end if;

  -- role metadata (through an alias) → active with that role
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000f2', 'nadia@alyq.local', '{"role":"clerk","name":"Nadia Clerk","username":"nadia"}'::jsonb);
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') <> 'inventory_clerk' then
    raise exception 'the role alias "clerk" was not mapped to inventory_clerk';
  end if;
  if (select active from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') is not true then
    raise exception 'an account with role metadata should be active';
  end if;

  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000f3', 'boss@alyq.local', '{"role":"superadmin"}'::jsonb);
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f3') <> 'admin' then
    raise exception 'the role alias "superadmin" was not mapped to admin';
  end if;

  -- an account that predates the trigger (no profile) → backfilled later
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000f4', 'orphan@alyq.local', '{"role":"cashier"}'::jsonb);
  delete from public.profiles where id = '00000000-0000-4000-8000-0000000000f4';

  -- an audit row old enough to be purged
  insert into public.audit_log (action, entity, entity_id, entity_label, user_id, user_name, created_at)
  values ('shift.opened', 'shift', 'old-shift', 'SH-000001', 'x', 'x', now() - interval '3 years');

  raise notice 'invariant triggers hold without RLS (viewer refused, constraints enforced)';
  raise notice 'audit log is append-only and takes its entity from the action';
  raise notice 'staff onboarding — role metadata decides the role, absence means inactive viewer';
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

-- ── the audit trail is readable only with oversight rights ───────────────
do $$
declare
  v_visible integer;
begin
  -- a cashier may write an audit row (the app records what they just did)…
  perform pg_temp.become('00000000-0000-4000-8000-0000000000c1');
  insert into public.audit_log (action, entity, entity_id, entity_label, user_id, user_name)
  values ('expense.created', 'expense', 'exp-probe', 'EXP-000001', 'forged', 'Forged');

  select count(*) into v_visible from public.audit_log;
  if v_visible <> 0 then
    raise exception 'a cashier could read % audit row(s)', v_visible;
  end if;

  -- …and is stamped as the author regardless
  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  if (select user_id from public.audit_log where entity_id = 'exp-probe')
     <> '00000000-0000-4000-8000-0000000000c1' then
    raise exception 'the audit row was not attributed to the authenticated author';
  end if;
  -- the name comes from the AUTHOR's profile at insert time, not from the admin
  -- who is reading now, and not from the client
  if (select user_name from public.audit_log where entity_id = 'exp-probe') <> 'Karim Cashier' then
    raise exception 'the audit row kept the forged name (%)',
      (select user_name from public.audit_log where entity_id = 'exp-probe');
  end if;

  -- an admin reads everything
  select count(*) into v_visible from public.audit_log;
  if v_visible < 2 then
    raise exception 'an admin should read the whole trail, saw % row(s)', v_visible;
  end if;

  -- a viewer sees nothing
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  select count(*) into v_visible from public.audit_log;
  if v_visible <> 0 then
    raise exception 'a viewer could read % audit row(s)', v_visible;
  end if;

  raise notice 'the audit trail is oversight-only, append-only and correctly attributed';
end
$$;

-- ── admin maintenance: backfill, demo seed and retention ─────────────────
do $$
declare
  v_backfilled integer;
  v_seeded     integer;
  v_purged     integer;
  v_role       text;
begin
  -- these are admin-only
  perform pg_temp.become('00000000-0000-4000-8000-0000000000e1');
  begin
    perform public.backfill_staff_profiles();
    raise exception 'a non-admin ran backfill_staff_profiles';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.seed_demo_staff();
    raise exception 'a non-admin ran seed_demo_staff';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.purge_audit_log();
    raise exception 'a non-admin ran purge_audit_log';
  exception when insufficient_privilege then
    null;
  end;

  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');

  -- the orphaned account gets its profile back, with the role from its metadata
  v_backfilled := public.backfill_staff_profiles();
  if v_backfilled <> 1 then
    raise exception 'backfill_staff_profiles() created % profile(s), expected 1', v_backfilled;
  end if;
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f4') <> 'cashier' then
    raise exception 'the backfilled profile has the wrong role';
  end if;
  if public.backfill_staff_profiles() <> 0 then
    raise exception 'backfill_staff_profiles() is not idempotent';
  end if;

  -- three of the five demo accounts already exist as fixtures, so two are new
  v_seeded := public.seed_demo_staff('alyq1234');
  if v_seeded <> 2 then
    raise exception 'seed_demo_staff() created % account(s), expected 2', v_seeded;
  end if;
  if public.seed_demo_staff('alyq1234') <> 0 then
    raise exception 'seed_demo_staff() is not idempotent';
  end if;

  -- all five roles are reachable through the username the login screen sends
  for v_role in select unnest(array['admin', 'manager', 'cashier', 'inventory_clerk', 'viewer'])
  loop
    if not exists (
      select 1 from public.profiles p
       where p.username = v_role and p.role::text = v_role and p.active
    ) then
      raise exception 'the demo account for % is missing or wrong', v_role;
    end if;
  end loop;

  -- The password is a real bcrypt hash of the demo password — checked on an
  -- account the seed created in this run (manager), not on one of the fixture
  -- accounts, which the seed deliberately leaves alone.
  if not exists (
    select 1 from auth.users u
     where u.email = 'manager@alyq.local'
       and u.encrypted_password = crypt('alyq1234', u.encrypted_password)
  ) then
    raise exception 'the seeded password does not verify';
  end if;

  -- …and an existing account's credentials are not overwritten
  if (select encrypted_password from auth.users where email = 'admin@alyq.local') is not null then
    raise exception 'the seed overwrote an existing account''s credentials';
  end if;

  -- retention: exactly one row is old enough, and the purge reports it
  v_purged := public.purge_audit_log(now() - interval '24 months');
  if v_purged <> 1 then
    raise exception 'purge_audit_log() removed % row(s), expected 1', v_purged;
  end if;
  if exists (select 1 from public.audit_log where entity_id = 'old-shift') then
    raise exception 'the old audit row survived the purge';
  end if;
  if exists (select 1 from public.audit_log where entity_id in ('exp-probe', 'shift-probe')) = false then
    raise exception 'the purge removed more than it should have';
  end if;

  -- and a cut-off in the future is refused
  begin
    perform public.purge_audit_log(now() + interval '1 day');
    raise exception 'a future cut-off was accepted';
  exception when check_violation then
    null;
  end;

  raise notice 'admin maintenance — backfill, demo seed and retention purge';
end
$$;

-- ── pos_complete_sale: cash, InstaPay and card side by side ───────────────
-- 0015 accepts a card payment at the register without disturbing the two
-- methods that were already there. This block exercises all three, plus the
-- two ways a payment can still be refused.
do $$
declare
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_product   uuid := '00000000-0000-4000-8000-0000000000f2';
  v_sale      jsonb;
  v_sale_id   uuid;
  v_row       public.sales%rowtype;
  v_pay       public.sale_payments%rowtype;
  v_pay_count integer;
begin
  perform pg_temp.become(v_cashier);

  -- 1. a card sale: no cash in the drawer, captured at the terminal
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-card-1',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'visa', 'amount', 20.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;

  select * into v_row from public.sales where id = v_sale_id;
  if v_row.payment_method <> 'visa' then
    raise exception 'a card sale recorded payment_method %', v_row.payment_method;
  end if;
  if v_row.status <> 'completed' or v_row.payment_status <> 'paid' then
    raise exception 'a card sale was not completed and paid (% / %)', v_row.status, v_row.payment_status;
  end if;
  if v_row.amount_received is not null or v_row.change is not null then
    raise exception 'a card sale put cash in the drawer';
  end if;

  select * into v_pay from public.sale_payments where sale_id = v_sale_id;
  if v_pay.method <> 'visa' or v_pay.status <> 'paid' or v_pay.paid_at is null then
    raise exception 'the card payment row is wrong (% / % / %)', v_pay.method, v_pay.status, v_pay.paid_at;
  end if;

  -- card is money in hand: it never joins the pending InstaPay queue
  perform public.pos_confirm_payment(v_sale_id, v_cashier::text, 'Karim Cashier');
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.payment_status <> 'paid' then
    raise exception 'confirming a card sale changed its state';
  end if;

  -- 2. a client cannot park a card sale in `pending`
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-card-2',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'visa', 'amount', 10.00, 'status', 'pending')),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  select * into v_row from public.sales where id = (v_sale->>'sale_id')::uuid;
  if v_row.payment_status <> 'paid' then
    raise exception 'a card payment was accepted as pending';
  end if;

  -- 3. InstaPay is untouched: still pending, still confirmed by hand
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-instapay',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'instapay', 'amount', 10.00, 'status', 'pending')),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;

  select * into v_row from public.sales where id = v_sale_id;
  if v_row.status <> 'pending' or v_row.payment_status <> 'pending' then
    raise exception 'an awaiting InstaPay sale is no longer pending (% / %)', v_row.status, v_row.payment_status;
  end if;
  select * into v_pay from public.sale_payments where sale_id = v_sale_id;
  if v_pay.status <> 'pending' or v_pay.paid_at is not null then
    raise exception 'the InstaPay payment row is wrong (% / %)', v_pay.status, v_pay.paid_at;
  end if;

  perform public.pos_confirm_payment(v_sale_id, v_cashier::text, 'Karim Cashier');
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.status <> 'completed' or v_row.payment_status <> 'paid' then
    raise exception 'confirming an InstaPay sale failed (% / %)', v_row.status, v_row.payment_status;
  end if;

  -- 4. cash still records what was tendered and the change handed back
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-cash',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00, 'tendered', 30.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
  ));
  select * into v_row from public.sales where id = (v_sale->>'sale_id')::uuid;
  if v_row.amount_received <> 30.00 or v_row.change <> 10.00 then
    raise exception 'a cash sale lost its tender/change (% / %)', v_row.amount_received, v_row.change;
  end if;

  -- 5. cash short of the total is still refused, and writes nothing
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-cash-short',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00, 'tendered', 5.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
    ));
    raise exception 'a cash sale under the total was accepted';
  exception when check_violation then
    null;
  end;
  if exists (select 1 from public.sales where client_ref = 'scn-cash-short') then
    raise exception 'the refused cash sale was written anyway';
  end if;

  -- 6. an unknown method is still refused
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-bogus',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'crypto', 'amount', 20.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
    ));
    raise exception 'an unknown payment method was accepted';
  exception when check_violation then
    null;
  end;

  -- 7. a split of cash and card: the first method labels the sale, and the
  --    payment rows must still sum to the total, which is validated first
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-split',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(
                    jsonb_build_object('method', 'cash', 'amount', 5.00, 'tendered', 10.00),
                    jsonb_build_object('method', 'visa', 'amount', 15.00)
                  ),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.payment_method <> 'cash' or v_row.amount_received <> 10.00 or v_row.change <> 5.00 then
    raise exception 'a cash+card split is wrong (% / % / %)', v_row.payment_method, v_row.amount_received, v_row.change;
  end if;
  select count(*) into v_pay_count from public.sale_payments where sale_id = v_sale_id;
  if v_pay_count <> 2 then
    raise exception 'a cash+card split wrote % payment rows', v_pay_count;
  end if;
  if (select sum(amount) from public.sale_payments where sale_id = v_sale_id) <> v_row.total then
    raise exception 'the split payments no longer sum to the total';
  end if;

  -- and payments that do not sum to the total are still refused
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-mismatch',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'visa', 'amount', 19.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
    ));
    raise exception 'payments that do not sum to the total were accepted';
  exception when check_violation then
    null;
  end;

  raise notice 'pos payments — cash, InstaPay and card on one till';
end
$$;

-- ── leave no session claim behind ─────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

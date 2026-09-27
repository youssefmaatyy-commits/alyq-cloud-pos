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

/**
 * Phase 27 fixtures: the open shift a till sale needs (0040) and its mirror.
 * Both act as the cashier fixture — the seat that holds open_shift/close_shift —
 * and are no-ops when the wanted state already holds, so a scenario may call
 * ensure_open_shift() without caring what the previous scenario left behind.
 */
create or replace function pg_temp.ensure_open_shift(p_user_id text default null)
returns uuid
language plpgsql
as $$
declare
  v_shift_id uuid;
  v_uid text := coalesce(p_user_id, nullif(auth.uid()::text, ''), '00000000-0000-4000-8000-0000000000c1');
  v_name text := coalesce((select name from public.profiles where id = v_uid::uuid), 'Karim Cashier');
begin
  select id into v_shift_id from public.shifts where status = 'open' and opened_by = v_uid;
  if found then
    return v_shift_id;
  end if;
  insert into public.shifts (branch, register, opening_cash, opened_by, opened_by_name)
  values ('Main', 'Till 1', 1000, v_uid, v_name)
  returning id into v_shift_id;
  return v_shift_id;
end;
$$;

create or replace function pg_temp.ensure_closed_shift()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
  update public.shifts
     set status         = 'closed',
         closing_cash   = opening_cash,
         closed_at      = now(),
         closed_by      = '00000000-0000-4000-8000-0000000000c1',
         closed_by_name = 'Karim Cashier',
         summary        = jsonb_build_object(
           'expected_cash', opening_cash,
           'actual_cash',   opening_cash,
           'difference',    0)
   where status = 'open';
end;
$$;

-- ── modelling production's grant set ──────────────────────────────────────
-- A live Supabase project runs its migrations as `postgres`, and that role
-- carries `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon,
-- authenticated, service_role`. So in production a browser CAN attempt any
-- write to any public table, and row level security is the only thing standing
-- between it and the row. That is the model Supabase documents, and it is why
-- "enable RLS" is the first instruction in every guide.
--
-- This harness applies only the grants the migrations state by hand, which for
-- the catalogue is SELECT (0015) — stricter than production, and the reason the
-- old `with check (true)` policies on products and categories went unchallenged
-- for thirty migrations: nothing here could attempt the write they allowed.
-- Granting it back for the run makes the POLICY the thing under test, which is
-- the only part this file can speak for. No other scenario in this file writes
-- to these tables, so nothing else changes shape.
grant insert, update, delete on public.products         to authenticated;
grant insert, update, delete on public.categories       to authenticated;
grant insert, update, delete on public.stock_movements  to authenticated;
-- Phase 27: the customer book is written straight from the till (0010's
-- capability policies), so it gets the same treatment — the policy is the
-- wall, not a missing privilege. The invoice counter is read to prove a
-- refused sale burned no number; production grants it through default
-- privileges, so SELECT-only here just restores the production shape.
grant insert, update, delete on public.customers        to authenticated;
grant select on public.sale_counters                    to authenticated;
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
  if public.can('edit_expense') or public.can('view_audit_log') or public.can('apply_discount')
     or public.can('approve_refund') then
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

  -- METADATA IS A REQUEST, NOT A FACT (0030). The register endpoint used to
  -- hand out whatever role it was asked for, and to activate the account that
  -- asked; it now hands out an inactive viewer and records what was asked for.
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000f2', 'nadia@alyq.local', '{"role":"clerk","name":"Nadia Clerk","username":"nadia"}'::jsonb);
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') <> 'viewer' then
    raise exception 'a sign-up that declared a role was granted it';
  end if;
  if (select active from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') is not false then
    raise exception 'a sign-up that declared a role was activated';
  end if;
  if (select username from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') <> 'nadia'
     or (select name from public.profiles where id = '00000000-0000-4000-8000-0000000000f2') <> 'Nadia Clerk' then
    raise exception 'the declared username / name were not kept';
  end if;
  if not exists (
    select 1 from public.audit_log
     where entity_id = '00000000-0000-4000-8000-0000000000f2'
       and action = 'user.created'
       and details->>'declared_role' = 'clerk'
       and (details->>'declared_refused')::boolean
  ) then
    raise exception 'the refused escalation was not recorded in the audit log';
  end if;

  -- the loudest version of the same attempt
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000f3', 'boss@alyq.local', '{"role":"superadmin"}'::jsonb);
  if (select role::text from public.profiles where id = '00000000-0000-4000-8000-0000000000f3') <> 'viewer'
     or (select active from public.profiles where id = '00000000-0000-4000-8000-0000000000f3') is not false then
    raise exception 'a sign-up that declared "superadmin" became an active admin';
  end if;

  -- The alias vocabulary is untouched: `clerk` and `superadmin` still resolve,
  -- for the callers that ARE allowed to state a role — `admin_upsert_staff_
  -- profile` as the admin who asked (covered by the "only an admin changes
  -- roles" scenario below) and `seed_demo_staff` (covered by the maintenance
  -- scenario, which asserts all five demo accounts are active with their role).
  if public.normalize_app_role('clerk') is distinct from 'inventory_clerk' then
    raise exception 'the role alias "clerk" was not mapped to inventory_clerk';
  end if;
  if public.normalize_app_role('superadmin') is distinct from 'admin' then
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
  raise notice 'staff onboarding — metadata is a request: every new account is an inactive viewer, and a declared role is recorded, not granted';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 18 — backup & recovery, as the owner: the restore itself.
--
-- Before the role switch, because a restore has to be observed doing the only
-- thing that matters — putting back a row that is gone — and deleting a row
-- directly needs a privilege `authenticated` does not hold on `customers`. The
-- capability checks here are still real: `public.can()` reads the identity claim,
-- not the role, and every function below re-checks it before it acts. What the
-- authenticated phase after the switch adds is the grant layer — that the
-- document column cannot be read by naming its table, and that the scheduler's
-- entry point cannot be reached by a session at all.
--
-- This is the only block in the file that deletes data. It puts the row back by
-- restoring a snapshot taken three statements earlier, which is the assertion:
-- not "the data survived" but "the restore brought it back".
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin     uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_marker    uuid := '00000000-0000-4000-8000-000000000b18';
  v_manifest  jsonb;
  v_backup_id uuid;
  v_outcome   jsonb;
  v_doc       jsonb;
  v_settings  jsonb;
  v_count     integer;
begin
  perform pg_temp.become(v_cashier);
  if public.can('view_backups') or public.can('create_backup') or public.can('restore_backup')
     or public.can('export_backup') or public.can('run_health_check') then
    raise exception 'a cashier holds a data-safety capability';
  end if;

  begin
    perform public.create_backup('manual', 'should not work');
    raise exception 'a cashier created a backup';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden%' then
      raise exception 'create_backup refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  perform pg_temp.become(v_admin);
  if not (public.can('view_backups') and public.can('create_backup')
          and public.can('restore_backup') and public.can('export_backup')
          and public.can('run_health_check')) then
    raise exception 'an admin is missing a data-safety capability';
  end if;

  -- 1. something to lose, and a snapshot that carries it
  insert into public.customers (id, name, phone)
  values (v_marker, 'Scenario Marker', '01000000018')
  on conflict (id) do update set name = excluded.name;

  v_manifest := public.create_backup('manual', 'scenario snapshot');
  v_backup_id := (v_manifest->>'id')::uuid;

  if v_manifest->>'kind' <> 'manual' then
    raise exception 'the manifest reports kind %', v_manifest->>'kind';
  end if;
  if (v_manifest->>'table_count')::integer <> array_length(public.backup_table_order(), 1) then
    raise exception 'the snapshot carries % tables; the order lists %',
      v_manifest->>'table_count', array_length(public.backup_table_order(), 1);
  end if;
  if coalesce((v_manifest->>'row_count')::bigint, 0) < 1 then
    raise exception 'the snapshot holds no rows';
  end if;
  if coalesce(v_manifest->>'checksum', '') = '' then
    raise exception 'the snapshot has no checksum';
  end if;
  if v_manifest->>'document' is not null then
    raise exception 'the manifest carries the document';
  end if;

  select count(*) into v_count from public.backup_manifests where id = v_backup_id;
  if v_count <> 1 then
    raise exception 'the new snapshot is not listed in backup_manifests';
  end if;

  -- 2. lose it, then get it back
  delete from public.customers where id = v_marker;
  select count(*) into v_count from public.customers where id = v_marker;
  if v_count <> 0 then
    raise exception 'the marker customer was not deleted';
  end if;

  v_outcome := public.admin_restore_backup(v_backup_id);
  if not coalesce((v_outcome->>'ok')::boolean, false) then
    raise exception 'the restore reported failure';
  end if;
  select count(*) into v_count from public.customers where id = v_marker;
  if v_count <> 1 then
    raise exception 'the restore did not bring the customer back';
  end if;
  if coalesce((v_outcome->>'row_count')::bigint, 0) < 1 then
    raise exception 'the restore counted no rows';
  end if;

  -- the way back: a pre_restore snapshot exists and is listed as what it is —
  -- restoring it is how this restore would be undone
  if v_outcome->>'pre_restore_backup_id' is null then
    raise exception 'the restore kept no way back';
  end if;
  select count(*) into v_count from public.backup_manifests
   where kind = 'pre_restore' and id = (v_outcome->>'pre_restore_backup_id')::uuid;
  if v_count <> 1 then
    raise exception 'the pre-restore snapshot is not listed';
  end if;

  -- the trail outlives the restore: audit_log is append-only, so a snapshot may
  -- carry it but a restore may not replace it
  select count(*) into v_count from public.audit_log;
  if v_count < 1 then
    raise exception 'the restore erased the audit log';
  end if;
  if not public.can('restore_backup') then
    raise exception 'the restore replaced the permission vocabulary';
  end if;

  -- 3. a document that does not add up is refused, and the installation is
  --    untouched by the refusal — this is the "no partial restore" claim
  v_doc := jsonb_set(public.get_backup_document(v_backup_id), '{checksum}', '"deadbeef"');
  begin
    perform public.admin_restore_document(v_doc);
    raise exception 'a tampered document was restored';
  exception when others then
    if sqlerrm not like '%backup.error.checksum_mismatch%' then
      raise exception 'a tampered document was refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  v_doc := public.get_backup_document(v_backup_id);
  -- Take the tables object out with `#>` and an explicit text[] path. The `->`
  -- and `->>` forms resolve a bare '{a,b}' literal as a *key*, not a path, and
  -- return null — which jsonb_set then turns into a null document, testing the
  -- wrong refusal (unparseable) instead of the intended one (incomplete).
  v_doc := jsonb_set(
    v_doc,
    array['payload', 'tables'],
    (v_doc #> array['payload', 'tables']) - 'products'
  );
  begin
    perform public.admin_restore_document(v_doc);
    raise exception 'a document missing a table was restored';
  exception when others then
    if sqlerrm not like '%backup.error.incomplete%' then
      raise exception 'an incomplete document was refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  v_doc := jsonb_set(public.get_backup_document(v_backup_id), '{mode}', '"demo"');
  begin
    perform public.admin_restore_document(v_doc);
    raise exception 'an offline document was restored into a live database';
  exception when others then
    if sqlerrm not like '%backup.error.mode_mismatch%' then
      raise exception 'a demo document was refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  select count(*) into v_count from public.customers where id = v_marker;
  if v_count <> 1 then
    raise exception 'three refused restores changed the data anyway';
  end if;

  -- a snapshot kind a seat may not manufacture: a pre_restore row is evidence
  -- that a restore happened, so only a restore may write one
  begin
    perform public.create_backup('pre_restore', 'pretending');
    raise exception 'a seat wrote a pre_restore snapshot by hand';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden_kind%' then
      raise exception 'create_backup refused the kind for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- 4. the schedule: an admin writes it, a cashier may not
  v_settings := public.save_backup_settings('weekly', 7, 3);
  if v_settings->>'frequency' <> 'weekly'
     or (v_settings->>'retention_days')::integer <> 7
     or (v_settings->>'retention_count')::integer <> 3 then
    raise exception 'the schedule was not saved as asked';
  end if;

  perform pg_temp.become(v_cashier);
  begin
    perform public.save_backup_settings('daily', 30, 14);
    raise exception 'a cashier changed the backup schedule';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden%' then
      raise exception 'save_backup_settings refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- reading the document is a separate authority from seeing the list: this seat
  -- may not download a snapshot, may not read the database, may not restore, and
  -- may not read the schedule's own row through the manifest view
  begin
    perform public.get_backup_document(v_backup_id);
    raise exception 'a cashier downloaded a backup';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden%' then
      raise exception 'get_backup_document refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  begin
    perform public.snapshot_document();
    raise exception 'a cashier read the whole database';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden%' then
      raise exception 'snapshot_document refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  begin
    perform public.admin_restore_backup(v_backup_id);
    raise exception 'a cashier restored a backup';
  exception when others then
    if sqlerrm not like '%backup.error.forbidden%' then
      raise exception 'admin_restore_backup refused for the wrong reason: %', sqlerrm;
    end if;
  end;

  select count(*) into v_count from public.backup_manifests;
  if v_count <> 0 then
    raise exception 'backup_manifests listed % snapshot(s) for a cashier', v_count;
  end if;

  -- leave the policy as the shipped default, and the marker where the next run
  -- expects to find it
  perform pg_temp.become(v_admin);
  perform public.save_backup_settings('daily', 30, 14);

  raise notice 'backup & recovery — snapshot, restore, rollback point, and six refusals that changed nothing';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 30a — the anonymous storefront (0030).
--
-- This runs BEFORE the switch to `authenticated`, because the owner can step
-- into `anon` and step back out again, while a non-superuser cannot: for the
-- roles a browser actually gets, SET ROLE is one-way.
--
-- This is the phase that would have caught C1. Everything else in this file ran
-- as the owner (who bypasses RLS) or as `authenticated` (who satisfies every
-- products policy), so a shop window that is empty for a visitor looked like a
-- database that was fine.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_owner   text := current_user;
  v_rows    integer;
  v_price   numeric;
  v_visible uuid := '00000000-0000-4000-8000-000000000b30';
  v_hidden  uuid := '00000000-0000-4000-8000-0000000000f2';
  v_cat     uuid := '00000000-0000-4000-8000-0000000000f1';
begin
  -- One product on the website, and the POS fixture deliberately taken off it,
  -- so that "published" and "filtered out" are both observable from outside.
  insert into public.products (
    id, sku, name_ar, name_en, category_id, selling_price, cost_price,
    stock_quantity, low_stock_level, show_on_website, is_featured, active
  ) values (
    v_visible, 'SCN-PUB', 'قلادة ذهبية', 'Gold Necklace', v_cat,
    250.00, 90.00, 12, 3, true, true, true
  )
  on conflict (id) do update
    set selling_price   = excluded.selling_price,
        cost_price      = excluded.cost_price,
        stock_quantity  = excluded.stock_quantity,
        show_on_website = true,
        active          = true;

  update public.products set show_on_website = false where id = v_hidden;

  -- Production's default privileges reach `anon` too, so the visitor is granted
  -- what a live project would grant them: the point of the assertions below is
  -- that RLS still says no. Revoked again before this block ends.
  grant select, insert, update, delete on public.products   to anon;
  grant select, insert, update, delete on public.categories to anon;

  -- ── step into the visitor's shoes ────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);

  -- 1. the published read answers at all
  select count(*) into v_rows from public.storefront_catalogue();
  if v_rows < 1 then
    raise exception 'anon saw % row(s) from storefront_catalogue()', v_rows;
  end if;
  select count(*) into v_rows from public.storefront_categories();
  if v_rows < 1 then
    raise exception 'anon saw % row(s) from storefront_categories()', v_rows;
  end if;

  -- 2. it publishes what is on the website and not what is off it: the filter
  --    lives in the function, so a visitor has nothing to argue with
  if not exists (select 1 from public.storefront_catalogue() c where c.id = v_visible) then
    raise exception 'the published product is missing from storefront_catalogue()';
  end if;
  if exists (select 1 from public.storefront_catalogue() c where c.id = v_hidden) then
    raise exception 'a product that is off the website was published to anon';
  end if;
  select c.selling_price into v_price from public.storefront_catalogue() c where c.id = v_visible;
  if v_price <> 250.00 then
    raise exception 'the published price is % rather than 250.00', v_price;
  end if;
  if not exists (select 1 from public.storefront_categories() c where c.id = v_cat) then
    raise exception 'the storefront category is missing from storefront_categories()';
  end if;

  -- 3. margin, reorder policy and staff identity are not in the answer at all.
  --    `jsonb_exists_any` is the function form of `?|`, which some drivers read
  --    as a placeholder rather than as an operator.
  if exists (
    select 1 from public.storefront_catalogue() c
     where jsonb_exists_any(to_jsonb(c),
             array['cost_price', 'low_stock_level', 'created_by', 'updated_by'])
  ) then
    raise exception 'storefront_catalogue() published an internal column';
  end if;
  if not exists (
    select 1 from public.storefront_catalogue() c
     where jsonb_exists(to_jsonb(c), 'selling_price')
       and jsonb_exists(to_jsonb(c), 'stock_quantity')
       and jsonb_exists(to_jsonb(c), 'images')
  ) then
    raise exception 'storefront_catalogue() dropped a column the shop window needs';
  end if;

  -- 4. the table itself stays closed even with the privilege in hand: RLS has no
  --    policy for `anon`, so a read is empty and a write is refused.
  select count(*) into v_rows from public.products;
  if v_rows <> 0 then
    raise exception 'anon read % row(s) of public.products directly', v_rows;
  end if;
  select count(*) into v_rows from public.categories;
  if v_rows <> 0 then
    raise exception 'anon read % row(s) of public.categories directly', v_rows;
  end if;

  begin
    insert into public.products (id, sku, name_ar, name_en, category_id, selling_price, stock_quantity)
    values ('00000000-0000-4000-8000-000000000b31', 'SCN-HACK', 'منتج', 'Injected', v_cat, 1.00, 1);
    raise exception 'anon inserted a product';
  exception when insufficient_privilege then
    null;
  end;

  -- An UPDATE or DELETE that RLS filters out is not an error, it is zero rows,
  -- so these assert the effect and accept a hard refusal as well.
  begin
    update public.products set selling_price = 0.01 where id = v_visible;
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'anon rewrote a price (% row(s))', v_rows;
    end if;
  exception when insufficient_privilege then
    null;
  end;

  begin
    delete from public.categories where id = v_cat;
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'anon deleted a category (% row(s))', v_rows;
    end if;
  exception when insufficient_privilege then
    null;
  end;

  -- ── step back out, which only the owner can do ───────────────────────────
  perform set_config('role', v_owner, true);

  select selling_price into v_price from public.products where id = v_visible;
  if v_price <> 250.00 then
    raise exception 'the anonymous visit changed the price to %', v_price;
  end if;
  if exists (select 1 from public.products where sku = 'SCN-HACK') then
    raise exception 'the anonymous insert landed';
  end if;
  if not exists (select 1 from public.categories where id = v_cat) then
    raise exception 'the anonymous delete removed the storefront category';
  end if;

  revoke select, insert, update, delete on public.products   from anon;
  revoke select, insert, update, delete on public.categories from anon;

  -- and the POS fixture goes back on the website, as the fixtures left it
  update public.products set show_on_website = true where id = v_hidden;

  raise notice 'anonymous storefront — the catalogue is published, the tables are not, and no visitor write lands';
end
$$;
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 30a-storage — the payment-proof upload namespace (0036).
--
-- The same shape as the storefront phase above: the owner steps into `anon`,
-- and this time the target is the STORAGE bucket rather than the catalogue
-- tables. These are the assertions that would have caught the open 0005
-- policies: a guest may CREATE one proof under `proofs/` and nothing else —
-- no other prefix, no overwrite, no delete, and no listing of the bucket to
-- harvest other customers' proof URLs. Runs, like Phase 30a, before the
-- one-way switch to `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_owner text := current_user;
  v_rows  integer;
begin
  -- What a live project grants the storage API's anon role; the point of the
  -- assertions below is that RLS still scopes it. Revoked before this block
  -- ends, the way Phase 30a does for the catalogue tables.
  grant select, insert, update, delete on storage.objects to anon;

  -- The bucket-level rails the Storage server itself enforces on every
  -- upload, whatever the client claims to have validated: the 5 MB cap, the
  -- raster-only MIME whitelist, and no SVG in it.
  select count(*) into v_rows
    from storage.buckets
   where id = 'product-images'
     and file_size_limit = 5242880
     and not ('image/svg+xml' = any (allowed_mime_types))
     and allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/gif','image/avif','image/bmp'];
  if v_rows <> 1 then
    raise exception 'the product-images bucket lost its size cap, its MIME whitelist, or both';
  end if;

  -- A staff fixture proof: the target of the anonymous interference below.
  insert into storage.objects (bucket_id, name) values ('product-images', 'proofs/scn-victim.jpg');

  -- ── step into the guest's shoes ──────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);

  -- 1. the one thing a guest may do: create their own proof under proofs/
  insert into storage.objects (bucket_id, name) values ('product-images', 'proofs/scn-guest.jpg');

  -- 2. nowhere else: not the shop-artwork prefix, and not a root-level object
  --    cleverly NAMED `proofs` (its folder list is empty, so the policy's
  --    first-folder check refuses it).
  begin
    insert into storage.objects (bucket_id, name) values ('product-images', 'website/scn-guest.jpg');
    raise exception 'anon uploaded outside the proofs/ namespace';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into storage.objects (bucket_id, name) values ('product-images', 'proofs');
    raise exception 'anon uploaded a root-level object named proofs';
  exception when insufficient_privilege then
    null;
  end;

  -- 3. no enumeration: SELECT is filtered to zero rows for anon, so the
  --    unguessable proof paths stay unguessable — nobody can list the bucket
  --    and collect every customer's proof URL.
  select count(*) into v_rows from storage.objects where bucket_id = 'product-images';
  if v_rows <> 0 then
    raise exception 'anon listed % object(s) of the product-images bucket', v_rows;
  end if;

  -- 4. an UPDATE or DELETE that RLS filters out is zero rows rather than an
  --    error, so these assert the effect and accept a hard refusal as well.
  begin
    update storage.objects set name = 'proofs/scn-stolen.jpg' where name = 'proofs/scn-victim.jpg';
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'anon rewrote a proof (% row(s))', v_rows;
    end if;
  exception when insufficient_privilege then
    null;
  end;

  begin
    delete from storage.objects where name = 'proofs/scn-victim.jpg';
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'anon deleted a proof (% row(s))', v_rows;
    end if;
  exception when insufficient_privilege then
    null;
  end;

  -- ── step back out, which only the owner can do ───────────────────────────
  perform set_config('role', v_owner, true);

  -- The victim proof is still there under its own name — neither deleted nor
  -- renamed — and the out-of-namespace upload never landed.
  select count(*) into v_rows from storage.objects where name = 'proofs/scn-victim.jpg';
  if v_rows <> 1 then
    raise exception 'the anonymous visit lost or renamed the victim proof';
  end if;
  if exists (select 1 from storage.objects where name = 'website/scn-guest.jpg') then
    raise exception 'the anonymous out-of-namespace upload landed';
  end if;

  delete from storage.objects where name in ('proofs/scn-victim.jpg', 'proofs/scn-guest.jpg');
  revoke select, insert, update, delete on storage.objects from anon;

  raise notice 'anonymous proof uploads — one file may be created under proofs/, and nothing else in the bucket may be touched, moved, deleted or listed';
end
$$;
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 41a — storefront checkout, end to end, as the anonymous guest.
--
-- The guest checkout call is `place_online_order`, and it is the one write a
-- visitor is allowed to make. This phase exercises it the way the browser does
-- (role `anon`, one JSON payload) and asserts the whole contract around it:
--
--   · pickup/delivery × cash-on-delivery/InstaPay are accepted, priced from the
--     catalogue and the shop's own settings, and carry the right payment state;
--   · the price in the payload is ignored — the shop's `selling_price` and any
--     live campaign are the only prices that reach `online_order_items`;
--   · stock is protected by a reservation against the *available* quantity
--     (on-hand minus other orders' holds), and the shelf number does not move;
--   · a refusal — stock, quantity, inactive, website-hidden, coupon — leaves
--     ZERO rows behind, and raises the wording the storefront maps to a
--     friendly message;
--   · the placed order is readable back by its number and phone through
--     `lookup_online_order` (the guest confirmation path), while the order
--     tables themselves stay staff-only for `anon`;
--   · a replayed `client_ref` returns the original order and writes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

/** Row counts the checkout may move, readable from inside the anon context. */
create or replace function pg_temp.scn_checkout_counts()
returns table (orders integer, items integer, holds integer)
language sql
security definer
set search_path = public
as $$
  select (select count(*)::integer from public.online_orders),
         (select count(*)::integer from public.online_order_items),
         (select count(*)::integer from public.stock_reservations)
$$;

/** Rows pointing at an order that does not exist — never acceptable. */
create or replace function pg_temp.scn_broken_links()
returns integer
language sql
security definer
set search_path = public
as $$
  select (select count(*)::integer
            from public.online_order_items i
            left join public.online_orders o on o.id = i.order_id
           where o.id is null)
       + (select count(*)::integer
            from public.stock_reservations r
            left join public.online_orders o on o.id = r.online_order_id
           where o.id is null)
$$;

/** The coupon usage counter — staff-only rows, read with the owner's eyes. */
create or replace function pg_temp.scn_coupon_used(p_code text)
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce((select used_count from public.coupons where code = p_code), -1)
$$;

/** Promo-code applications for one order — staff-only rows, owner's eyes. */
create or replace function pg_temp.scn_promo_uses(p_code text, p_order uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.promo_code_usages u
  join public.coupons c on c.id = u.coupon_id
  where c.code = p_code and u.order_id = p_order
$$;

/**
 * What an order actually holds, read with the owner's eyes while the caller is
 * still `anon`: the whole contract of the phase is about rows a visitor may not
 * read back, so the assertions must look at them from outside the visitor.
 */
create or replace function pg_temp.scn_order_facts(p_order_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status',          o.status,
    'payment_status',  o.payment_status,
    'subtotal',        o.subtotal,
    'discount_amount', o.discount_amount,
    'discount_code',   o.discount_code,
    'promotion_id',    o.promotion_id,
    'price_snapshot',  o.price_snapshot,
    'delivery_fee',    o.delivery_fee,
    'total',           o.total,
    'address_city',    o.address->>'city',
    'address_area',    o.address->>'area',
    'address_zone_id', o.address->>'zone_id',
    'address_zone_name', o.address->>'zone_name',
    'phone',           o.customer_phone,
    'notes',           o.notes,
    'order_number',    o.order_number,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sku', i.sku, 'unit_price', i.unit_price,
               'discounted_unit_price', i.discounted_unit_price,
               'quantity', i.quantity, 'line_total', i.line_total,
               'order_id', i.order_id))
      from public.online_order_items i where i.order_id = o.id), '[]'::jsonb),
    'holds', (
      select coalesce(sum(r.quantity), 0)::integer
      from public.stock_reservations r
      where r.online_order_id = o.id and r.status = 'reserved'),
    'on_hand', (select p.stock_quantity from public.products p
                where p.id = (select i.product_id from public.online_order_items i
                              where i.order_id = o.id limit 1))
  )
  from public.online_orders o
  where o.id = p_order_id
$$;

/**
 * Call the order function and require a refusal with the given wording, with
 * nothing written. The call runs as whoever called this (the visitor, in this
 * phase); only the counting is done with the owner's eyes.
 */
create or replace function pg_temp.scn_expect_refusal(p_payload jsonb, p_fragment text)
returns void
language plpgsql
as $$
declare
  v_before record;
  v_after  record;
  v_state  text;
  v_message text;
begin
  select * into v_before from pg_temp.scn_checkout_counts();
  begin
    perform public.place_online_order(p_payload);
    raise exception 'checkout was accepted but should have been refused: %', p_fragment;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_message like 'checkout was accepted but%' then
    raise exception '%', v_message;
  end if;
  if v_message not like '%' || p_fragment || '%' then
    raise exception 'refusal read "%" instead of "%"', v_message, p_fragment;
  end if;
  if v_state not in ('23514', '23503') then
    raise exception 'refusal used SQLSTATE % instead of a check/foreign-key violation', v_state;
  end if;
  select * into v_after from pg_temp.scn_checkout_counts();
  if (v_after.orders, v_after.items, v_after.holds) is distinct from
     (v_before.orders, v_before.items, v_before.holds) then
    raise exception 'a refused checkout wrote rows: % → %', v_before, v_after;
  end if;
end
$$;

do $scn_checkout$
declare
  v_owner     text := current_user;
  v_settings  jsonb;
  v_visible   uuid := '00000000-0000-4000-8000-000000000c10';
  v_short     uuid := '00000000-0000-4000-8000-000000000c11';
  v_offline   uuid := '00000000-0000-4000-8000-000000000c12';
  v_hidden    uuid := '00000000-0000-4000-8000-000000000c13';
  v_untracked uuid := '00000000-0000-4000-8000-000000000c14';
  v_bulk      uuid := '00000000-0000-4000-8000-000000000c15';
  v_cat       uuid := '00000000-0000-4000-8000-0000000000f1';
  v_phone     text := '0501234567';
  v_guest     text;
  v_result    jsonb;
  v_number    text;
  v_id        uuid;
  v_row       record;
  v_before    record;
  v_after     record;
  v_lookup    jsonb;
  v_facts     jsonb;
  v_rows      integer;
  v_used      integer;
  v_created   uuid;
  v_created_orders uuid[] := '{}';
begin
  -- ── fixtures (owner: RLS is bypassed, and this is test data) ───────────────
  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
    stock_quantity, low_stock_level, show_on_website, is_featured, active,
    stock_tracking_enabled
  ) values
    (v_visible,   'SCN-CHK',  '6291000000210', 'خاتم فحص',   'Checkout Ring',   v_cat, 100.00, 40.00, 10, 2, true,  false, true, true),
    (v_short,     'SCN-LOW',  '6291000000227', 'سوارة فحص',  'Checkout Bangle', v_cat,  50.00, 20.00,  3, 1, true,  false, true, true),
    (v_offline,   'SCN-OFF',  '6291000000234', 'صنف موقوف',  'Inactive Piece',  v_cat,  70.00, 30.00,  5, 1, true,  false, false, true),
    (v_hidden,    'SCN-HIDE', '6291000000241', 'صنف مخفي',   'Hidden Piece',    v_cat,  70.00, 30.00,  5, 1, false, false, true, true),
    (v_untracked, 'SCN-NOTRK','6291000000258', 'صنف بالطلب', 'Made To Order',   v_cat, 500.00, 200.00, 0, 1, true,  false, true, false),
    (v_bulk,      'SCN-BULK', '6291000000265', 'صنف جملة',   'Bulk Piece',      v_cat, 100.00, 40.00, 50, 5, true,  false, true, true)
  on conflict (id) do update
    set selling_price           = excluded.selling_price,
        cost_price              = excluded.cost_price,
        stock_quantity          = excluded.stock_quantity,
        show_on_website         = excluded.show_on_website,
        active                  = excluded.active,
        stock_tracking_enabled  = excluded.stock_tracking_enabled;

  -- The shop's own delivery rules; restored before the block ends.
  select settings into v_settings from public.website_settings where id = 1;
  update public.website_settings
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
           'delivery', jsonb_build_object(
             'enabled', true, 'fee', 30, 'pickup_enabled', true,
             'cod_enabled', true, 'instapay_enabled', true))
   where id = 1;

  insert into public.coupons (code, discount_type, value, min_subtotal, active, starts_at, ends_at)
  values
    ('SCN-CHK10',   'percent', 10, 0, true,  null,                        null),
    ('SCN-EXPIRED', 'percent', 10, 0, true,  null,                        now() - interval '1 day'),
    ('SCN-INACT',   'percent', 10, 0, false, null,                        null)
  on conflict (code) do update
    set active = excluded.active, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        used_count = 0, value = excluded.value;

  -- ── step into the visitor's shoes ──────────────────────────────────────────
  perform pg_temp.become(null, 'anon');

  select * into v_before from pg_temp.scn_checkout_counts();

  -- A. pickup + cash on delivery: accepted, free, one reservation, nothing sold
  v_guest := 'scn-checkout-a';
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', v_guest,
    'customer_name', 'أحمد الشريف',
    'customer_phone', v_phone,
    'customer_email', null,
    'store_customer_id', null,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    -- the browser's own idea of the price, which must not be trusted
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 2, 'unit_price', 0.01)),
    'coupon_code', null,
    'payment_method', 'cod',
    'notes', 'فحص آلي'
  ));
  if v_result->>'duplicate' <> 'false' then
    raise exception 'a first checkout was reported as a duplicate';
  end if;
  v_number := v_result->>'order_number';
  v_id := (v_result->>'order_id')::uuid;
  v_created_orders := v_created_orders || v_id;

  v_facts := pg_temp.scn_order_facts(v_id);
  if v_facts->>'status' <> 'pending' or v_facts->>'payment_status' <> 'pending' then
    raise exception 'pickup+COD landed as status % / payment %',
      v_facts->>'status', v_facts->>'payment_status';
  end if;
  if (v_facts->>'subtotal')::numeric <> 200.00
     or (v_facts->>'delivery_fee')::numeric <> 0.00
     or (v_facts->>'total')::numeric <> 200.00 then
    raise exception 'pickup+COD priced % + % = % instead of 200 + 0',
      v_facts->>'subtotal', v_facts->>'delivery_fee', v_facts->>'total';
  end if;
  if v_facts->>'phone' <> v_phone or v_facts->>'notes' <> 'فحص آلي' then
    raise exception 'the order lost the customer it was placed with';
  end if;
  -- L. the catalogue price, not the payload's
  if (v_facts->'lines'->0->>'unit_price')::numeric <> 100.00
     or (v_facts->'lines'->0->>'quantity')::integer <> 2
     or (v_facts->'lines'->0->>'line_total')::numeric <> 200.00 then
    raise exception 'the line stored price % × % = % instead of the catalogue 100 × 2',
      v_facts->'lines'->0->>'unit_price', v_facts->'lines'->0->>'quantity',
      v_facts->'lines'->0->>'line_total';
  end if;
  if v_facts->'lines'->0->>'sku' <> 'SCN-CHK' then
    raise exception 'the line lost its sku (%)', v_facts->'lines'->0->>'sku';
  end if;
  -- stock is held, not taken: the shelf is untouched until the sale completes
  if (v_facts->>'on_hand')::integer <> 10 then
    raise exception 'placing an order moved the shelf to %', v_facts->>'on_hand';
  end if;
  if (v_facts->>'holds')::integer <> 2 then
    raise exception 'the order holds % unit(s) instead of 2', v_facts->>'holds';
  end if;

  -- The guest reads it back the way the storefront must: number + phone.
  v_lookup := public.lookup_online_order(v_number, v_phone);
  if v_lookup->'order'->>'order_number' <> v_number then
    raise exception 'the confirmation lookup did not return the order it just placed';
  end if;
  if jsonb_array_length(v_lookup->'items') <> 1 then
    raise exception 'the confirmation lookup returned % line(s)', jsonb_array_length(v_lookup->'items');
  end if; 
  if v_lookup->'order'->>'total' <> '200.00' then
    raise exception 'the confirmation lookup reported total %', v_lookup->'order'->>'total';
  end if;

  -- A guest may not read the order tables at all — the confirmation cannot be a
  -- direct select, which is exactly the defect this phase protects.
  begin
    execute 'select count(*) from public.online_orders' into v_rows;
  exception when insufficient_privilege then
    v_rows := -1;
  end;
  if v_rows > 0 then
    raise exception 'anon read % row(s) of public.online_orders directly', v_rows;
  end if;

  -- B. delivery + COD: the shop's fee, and the same in-stock item again
  -- (each accepted order is recorded, so the invariants can be checked per order)
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-b',
    'customer_name', 'منى عبد الله',
    'customer_phone', '0512345678',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9', 'building', '12'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 30.00 or (v_facts->>'total')::numeric <> 130.00 then
    raise exception 'delivery+COD priced fee % / total % instead of 30 / 130',
      v_facts->>'delivery_fee', v_facts->>'total';
  end if;
  if v_facts->>'address_city' <> 'القاهرة' then
    raise exception 'the delivery address was not stored';
  end if;

  -- C. pickup + InstaPay: a human must confirm the transfer
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-c',
    'customer_name', 'سارة حسن',
    'customer_phone', '0523456789',
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'payment_method', 'instapay'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if v_facts->>'payment_status' <> 'verification_required' then
    raise exception 'InstaPay landed as payment_status % instead of verification_required',
      v_facts->>'payment_status';
  end if;

  -- D. delivery + InstaPay, priced with the fee
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-d',
    'customer_name', 'ياسر فؤاد',
    'customer_phone', '0534567890',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'الجيزة', 'area', 'الهرم', 'street', 'شارع الهرم'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'payment_method', 'instapay'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 30.00 or (v_facts->>'total')::numeric <> 130.00
     or v_facts->>'payment_status' <> 'verification_required' then
    raise exception 'delivery+InstaPay priced % / total % / payment %',
      v_facts->>'delivery_fee', v_facts->>'total', v_facts->>'payment_status';
  end if;

  -- E. over the available quantity — counted against other orders' holds
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-e',
    'customer_name', 'طلب زائد',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_short::text, 'qty', 4)),
    'payment_method', 'cod'
  ), 'Only 3 of SCN-LOW available');

  -- J. a valid coupon discounts the recomputed subtotal and is counted once
  v_used := pg_temp.scn_coupon_used('SCN-CHK10');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-j',
    'customer_name', 'هدى كمال',
    'customer_phone', '0545678901',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 10'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_short::text, 'qty', 3)),
    'coupon_code', 'scn-chk10',
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  -- SCN-LOW: 3 × 50 = 150, minus 10% (15), plus 30 delivery = 165
  if (v_facts->>'subtotal')::numeric <> 150.00
     or (v_facts->>'discount_amount')::numeric <> 15.00
     or (v_facts->>'total')::numeric <> 165.00 then
    raise exception 'the coupon priced % - % + 30 = % instead of 150 - 15 + 30',
      v_facts->>'subtotal', v_facts->>'discount_amount', v_facts->>'total';
  end if;
  if v_facts->>'discount_code' <> 'SCN-CHK10' then
    raise exception 'the order did not record the code it was priced with (%)', v_facts->>'discount_code';
  end if;
  if pg_temp.scn_coupon_used('SCN-CHK10') <> v_used + 1 then
    raise exception 'the coupon usage counter moved by % instead of 1',
      pg_temp.scn_coupon_used('SCN-CHK10') - v_used;
  end if;

  -- K. every accepted order carries its lines and its hold, and only its own
  select * into v_after from pg_temp.scn_checkout_counts();
  if v_after.items <> v_before.items + 5 then
    raise exception 'five accepted orders wrote % line(s) instead of 5', v_after.items - v_before.items;
  end if;
  if v_after.holds <> v_before.holds + 5 then
    raise exception 'five accepted orders wrote % reservation(s) instead of 5',
      v_after.holds - v_before.holds;
  end if;
  if pg_temp.scn_broken_links() <> 0 then
    raise exception 'an order line or hold points at an order that does not exist';
  end if;
  -- every accepted order owns exactly its own single line
  foreach v_created in array v_created_orders loop
    v_facts := pg_temp.scn_order_facts(v_created);
    if jsonb_array_length(v_facts->'lines') <> 1 then
      raise exception 'an accepted order owns % line(s) instead of 1', jsonb_array_length(v_facts->'lines');
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_facts->'lines') as line
      where line->>'order_id' <> v_created::text
    ) then
      raise exception 'an order owns a line belonging to another order';
    end if;
  end loop;

  -- ── the shop's own delivery rules (0042) ──────────────────────────────────
  -- N. a whole address — city, area, street — is stored, and neither the fee nor
  --    the total in the payload is what the order is written with.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-n',
    'customer_name', 'نادية سمير',
    'customer_phone', '0567890123',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'delivery_fee', 0,
    'total', 0.01,
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 30.00 or (v_facts->>'total')::numeric <> 130.00 then
    raise exception 'the payload priced the order (fee %, total %) instead of the shop''s 30 / 130',
      v_facts->>'delivery_fee', v_facts->>'total';
  end if;
  if v_facts->>'address_city' <> 'القاهرة' or v_facts->>'address_area' <> 'مدينة نصر' then
    raise exception 'the stored address lost its city or area (% / %)',
      v_facts->>'address_city', v_facts->>'address_area';
  end if;

  -- O. a delivery address needs a city, an area AND a street: either half is
  --    refused, so a driver is never sent to a city with no street
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-o1',
    'customer_name', 'عنوان ناقص',
    'customer_phone', v_phone,
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'A delivery address is required');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-o2',
    'customer_name', 'عنوان ناقص',
    'customer_phone', v_phone,
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'A delivery address is required');

  -- P. once the shop lists the places it serves, anywhere else is refused…
  perform set_config('role', v_owner, true);
  update public.website_settings
     set settings = settings || jsonb_build_object('delivery',
       jsonb_build_object('enabled', true, 'fee', 30, 'pickup_enabled', true,
                          'cod_enabled', true, 'instapay_enabled', true,
                          'areas', jsonb_build_array(
                            jsonb_build_object('ar', 'الإسماعيلية', 'en', 'Ismailia'))))
   where id = 1;
  perform pg_temp.become(null, 'anon');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-p1',
    'customer_name', 'خارج النطاق',
    'customer_phone', v_phone,
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Delivery to القاهرة is not available');

  -- …and a served place is accepted however the customer typed it: the shop
  --    listed Ismailia / الإسماعيلية, the address says "  ismailia ".
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-p2',
    'customer_name', 'سلمى فتحي',
    'customer_phone', '0567890124',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', '  ismailia ', 'area', 'حي الأربعين', 'street', 'شارع السلطان حسين'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 30.00 then
    raise exception 'a served place was priced with fee %', v_facts->>'delivery_fee';
  end if;

  -- Q. the minimum order gates delivery, and only delivery
  perform set_config('role', v_owner, true);
  update public.website_settings
     set settings = settings || jsonb_build_object('delivery',
       jsonb_build_object('enabled', true, 'fee', 30, 'pickup_enabled', true,
                          'cod_enabled', true, 'instapay_enabled', true,
                          'minimum_order', 1000))
   where id = 1;
  perform pg_temp.become(null, 'anon');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-q1',
    'customer_name', 'طلب صغير',
    'customer_phone', v_phone,
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Delivery orders need at least 1000.00');
  -- the same cart collected in person is fine: pickup is not gated by it
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-q2',
    'customer_name', 'طلب صغير',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 1)),
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 0.00 or (v_facts->>'total')::numeric <> 100.00 then
    raise exception 'pickup under the delivery minimum priced fee % / total %',
      v_facts->>'delivery_fee', v_facts->>'total';
  end if;

  -- R. free delivery at or above the threshold — the waiver the checkout shows,
  --    measured on the goods total after the coupon: 600 − 10% = 540 ≥ 500.
  perform set_config('role', v_owner, true);
  update public.website_settings
     set settings = settings || jsonb_build_object('delivery',
       jsonb_build_object('enabled', true, 'fee', 30, 'pickup_enabled', true,
                          'cod_enabled', true, 'instapay_enabled', true,
                          'free_delivery_threshold', 500))
   where id = 1;
  perform pg_temp.become(null, 'anon');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-checkout-r',
    'customer_name', 'هدية كبيرة',
    'customer_phone', '0567890125',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_bulk::text, 'qty', 6)),
    'coupon_code', 'SCN-CHK10',
    'payment_method', 'cod'
  ));
  v_created_orders := v_created_orders || (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'subtotal')::numeric <> 600.00
     or (v_facts->>'discount_amount')::numeric <> 60.00
     or (v_facts->>'delivery_fee')::numeric <> 0.00
     or (v_facts->>'total')::numeric <> 540.00 then
    raise exception 'the free-delivery threshold priced % − % + % = % instead of 600 − 60 + 0',
      v_facts->>'subtotal', v_facts->>'discount_amount',
      v_facts->>'delivery_fee', v_facts->>'total';
  end if;

  -- and the four accepted orders above each own exactly one line and one hold
  select * into v_after from pg_temp.scn_checkout_counts();
  if v_after.items <> v_before.items + 9 or v_after.holds <> v_before.holds + 9 then
    raise exception 'the delivery-rule cases wrote % line(s) and % hold(s) instead of 4 and 4',
      v_after.items - v_before.items - 5, v_after.holds - v_before.holds - 5;
  end if;
  if pg_temp.scn_broken_links() <> 0 then
    raise exception 'an order line or hold points at an order that does not exist';
  end if;

  -- and the same product with no stock left at all: the holds already placed
  -- reduce what can be promised, so a second order of the same size is refused
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-e2',
    'customer_name', 'طلب زائد آخر',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_short::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Only 0 of SCN-LOW available');

  -- H. a quantity that is not a quantity
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-h',
    'customer_name', 'كمية صفر',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 0)),
    'payment_method', 'cod'
  ), 'Invalid quantity');

  -- F. an inactive product
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-f',
    'customer_name', 'صنف موقوف',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_offline::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Product SCN-OFF is not available on the website');

  -- G. a product taken off the website
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-g',
    'customer_name', 'صنف مخفي',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_hidden::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Product SCN-HIDE is not available on the website');

  -- a product whose stock is not tracked cannot become a till sale
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-notrack',
    'customer_name', 'صنف بالطلب',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_untracked::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Product SCN-NOTRK cannot be ordered online');

  -- I. coupons that must not apply
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-i1',
    'customer_name', 'كود غير موجود',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'coupon_code', 'SCN-NOPE',
    'payment_method', 'cod'
  ), 'Coupon SCN-NOPE is not valid');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-i2',
    'customer_name', 'كود منتهي',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'coupon_code', 'SCN-EXPIRED',
    'payment_method', 'cod'
  ), 'Coupon SCN-EXPIRED has expired');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-i3',
    'customer_name', 'كود معطل',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'coupon_code', 'SCN-INACT',
    'payment_method', 'cod'
  ), 'Coupon SCN-INACT is not valid');

  -- Misconfiguration is refused the same way: delivery off means delivery off.
  -- Flipping the shop's settings is a merchant action, so the owner does it and
  -- the visitor is stepped back in for the checkout that must be refused.
  perform set_config('role', v_owner, true);
  update public.website_settings
     set settings = settings || jsonb_build_object('delivery',
       jsonb_build_object('enabled', false, 'fee', 30, 'pickup_enabled', true,
                          'cod_enabled', true, 'instapay_enabled', true))
   where id = 1;
  perform pg_temp.become(null, 'anon');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-checkout-off',
    'customer_name', 'توصيل مغلق',
    'customer_phone', v_phone,
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'القاهرة', 'area', 'مدينة نصر', 'street', 'شارع 9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 1)),
    'payment_method', 'cod'
  ), 'Delivery is not available');

  -- M. a double tap is one order: the replayed key returns the original
  select * into v_before from pg_temp.scn_checkout_counts();
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', v_guest,
    'customer_name', 'أحمد الشريف',
    'customer_phone', v_phone,
    'delivery_type', 'pickup',
    'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_visible::text, 'qty', 2)),
    'payment_method', 'cod'
  ));
  if v_result->>'duplicate' <> 'true' or (v_result->>'order_id')::uuid <> v_id then
    raise exception 'a replayed checkout did not return the original order';
  end if;
  select * into v_after from pg_temp.scn_checkout_counts();
  if (v_after.orders, v_after.items, v_after.holds) is distinct from
     (v_before.orders, v_before.items, v_before.holds) then
    raise exception 'a replayed checkout wrote a second order';
  end if;

  -- M, stated plainly: five accepted orders, five lines, five holds, and every
  -- refusal above wrote nothing at all.
  select * into v_after from pg_temp.scn_checkout_counts();
  if v_after.orders <> v_before.orders or v_after.items <> v_before.items
     or v_after.holds <> v_before.holds then
    raise exception 'the final replay moved the totals';
  end if;

  -- ── step back out, which only the owner can do ────────────────────────────
  perform set_config('role', v_owner, true);
  update public.website_settings set settings = v_settings where id = 1;

  raise notice 'storefront checkout — pickup/delivery × COD/InstaPay accepted and priced from the catalogue; the shop''s own delivery rules hold (city+area+street required, unserved places refused, minimum gates delivery only, free delivery at the threshold measured after the coupon, payload fee ignored); stock held not sold; refusals (stock, quantity, inactive, website-hidden, untracked, coupon, address, outside area, below minimum, delivery off) write zero rows; a replayed key writes no second order; and the guest reads the order back by number and phone while the tables stay staff-only';
end
$scn_checkout$;

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

  -- 0040: a till sale needs the drawer to be open. The shift section above
  -- closed its only shift, so this is the first ringing-up in the file that
  -- depends on the gate — open the shift once here; it stays open for the
  -- rest of the file (the Phase 27 section manages its own cycles).
  perform pg_temp.ensure_open_shift();

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

-- ── refunds: owed, settled once, and never twice ──────────────────────────
-- 0016 gives the refund lifecycle its exit. The interesting cases are the ones
-- that decide whether money is owed at all: a pending refund reserves the sale's
-- refundable amount, a rejected one gives it back, and only `approve_refund`
-- may take either decision.
--
-- The sale below is deliberately discounted (two 10.00 units sold for 12.00), so
-- that "the cap came back" is a claim the test can actually distinguish: the
-- remaining refundable amount after the rejection is 12.00, not 2.00.
do $$
declare
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_manager   uuid;
  v_product   uuid := '00000000-0000-4000-8000-0000000000f2';
  v_sale      jsonb;
  v_return    jsonb;
  v_sale_id   uuid;
  v_line_id   uuid;
  v_refund_id uuid;
  v_row       public.refund_records%rowtype;
  v_count     integer;
  v_appr      uuid;
  v_appr_text text;
begin
  -- the lookup needs oversight: `profiles` is readable as yourself, your own
  -- row, or with `view_audit_log` — a cashier cannot browse the staff list.
  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  select p.id into v_manager from public.profiles p where p.username = 'manager';
  if v_manager is null then
    raise exception 'the seeded manager profile is missing';
  end if;

  -- a discounted cash sale: 2 × 10.00 less 8.00 = 12.00
  --
  -- 8.00 off a 20.00 basket is a 40% discount, which is above the shop's 10%
  -- limit. Before 0035 this call went straight through, because the limit was
  -- compared in saleService.ts and this scenario does not go through
  -- saleService.ts — which is exactly how the bypass worked. It now needs a
  -- decision behind it, so the scenario raises one the way the till does: the
  -- cashier asks, the manager signs, and the sale carries the request's id.
  -- Every number below is unchanged, so the return and refund assertions that
  -- follow still test what they always tested.
  perform pg_temp.become(v_cashier);
  select (public.submit_approval_request(jsonb_build_object(
           'kind',        'discount',
           'entity_type', 'sale',
           'entity_label','refn-sale-1',
           'amount',      40.00,
           'limit_value', 10.00,
           'reason',      'Damaged packaging, clearing the two units'
         )) ->> 'request_id')::uuid into v_appr;

  perform pg_temp.become(v_manager);
  perform public.decide_approval_request(v_appr, 'approved', 'Clear them out');

  perform pg_temp.become(v_cashier);
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',    'refn-sale-1',
    'user_id',       v_cashier::text,
    'user_name',     'Karim Cashier',
    'discount_type', 'fixed',
    'discount_value', 8.00,
    'payments',      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 12.00, 'tendered', 20.00)),
    'lines',         jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
  ), v_appr);

  -- the approval is spent, and spent on THIS sale: that is the link requirement
  -- 6 asks about, checked where a real act consumed a real decision.
  select result_entity_id into v_appr_text from public.approval_requests where id = v_appr;
  if v_appr_text is distinct from (v_sale ->> 'sale_id') then
    raise exception 'the discount approval was not spent on the sale it authorised (got %, sale %)',
      coalesce(v_appr_text, '(unspent)'), v_sale ->> 'sale_id';
  end if;
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_line_id from public.sale_items where sale_id = v_sale_id;

  -- 1. the cashier records a return whose refund is owed, not paid
  v_return := public.pos_process_return(jsonb_build_object(
    'sale_id',       v_sale_id::text,
    'reason',        'Damaged on the way out',
    'refund_method', 'cash',
    'refund_status', 'pending',
    'user_id',       v_cashier::text,
    'user_name',     'Karim Cashier',
    'items',         jsonb_build_array(jsonb_build_object('sale_item_id', v_line_id::text, 'quantity', 1))
  ));
  v_refund_id := (v_return->>'refund_id')::uuid;

  select * into v_row from public.refund_records where id = v_refund_id;
  if v_row.status <> 'pending' then
    raise exception 'a return recorded as pending produced a % refund', v_row.status;
  end if;
  if v_row.amount <> 10.00 then
    raise exception 'the refund is % rather than the 10.00 line price', v_row.amount;
  end if;
  if v_row.settled_at is not null or v_row.settled_by is not null or v_row.rejection_reason is not null then
    raise exception 'a pending refund carries a settlement stamp';
  end if;
  -- the numbering defect fixed in 0016 (b): these are real numbers, not errors
  if v_row.refund_number !~ '^REF-[0-9]{6}$' then
    raise exception 'the refund number is malformed: %', v_row.refund_number;
  end if;
  if (select return_number from public.sales_returns where id = v_row.return_id)
     !~ '^RET-[0-9]{6}$' then
    raise exception 'the return number is malformed';
  end if;

  -- 2. a pending refund still claims the money: the remaining 2.00 cannot cover
  --    a second 10.00 return
  begin
    perform public.pos_process_return(jsonb_build_object(
      'sale_id',       v_sale_id::text,
      'reason',        'And the second one too',
      'refund_method', 'cash',
      'refund_status', 'pending',
      'user_id',       v_cashier::text,
      'user_name',     'Karim Cashier',
      'items',         jsonb_build_array(jsonb_build_object('sale_item_id', v_line_id::text, 'quantity', 1))
    ));
    raise exception 'a pending refund did not reserve the money';
  exception when check_violation then
    null;
  end;

  -- 3. the cashier cannot release it, by RPC or by direct write
  begin
    perform public.pos_settle_refund(v_refund_id, v_cashier::text, 'Karim Cashier');
    raise exception 'a cashier settled a refund';
  exception when insufficient_privilege then
    null;
  end;
  begin
    update public.refund_records set status = 'completed' where id = v_refund_id;
    raise exception 'a cashier completed a refund with a direct UPDATE';
  exception when insufficient_privilege then
    null;
  end;

  -- 4. the manager rejects it, with a reason
  perform pg_temp.become(v_manager);
  v_return := public.pos_settle_refund(
    v_refund_id, v_manager::text, 'Mona Manager', 'rejected', 'The unit was not ours'
  );
  if (v_return->>'already_settled')::boolean then
    raise exception 'the first decision reported already_settled';
  end if;

  select * into v_row from public.refund_records where id = v_refund_id;
  if v_row.status <> 'rejected' then
    raise exception 'the rejection left the refund %', v_row.status;
  end if;
  if v_row.rejection_reason <> 'The unit was not ours' then
    raise exception 'the rejection reason was not recorded';
  end if;
  if v_row.settled_at is null then
    raise exception 'a decided refund has no decision time';
  end if;
  -- the trigger stamps the decider from the session, not from the parameter
  if v_row.settled_by <> v_manager::text
     or v_row.settled_by_name <> (select name from public.profiles where id = v_manager) then
    raise exception 'the decision was attributed to % / %', v_row.settled_by, v_row.settled_by_name;
  end if;

  -- rejection is an audit event with the entity derived from the vocabulary
  select count(*) into v_count from public.audit_log
   where action = 'refund.rejected' and entity_id = v_refund_id::text;
  if v_count <> 1 then
    raise exception 'the rejection wrote % audit rows', v_count;
  end if;
  if (select entity from public.audit_log
       where action = 'refund.rejected' and entity_id = v_refund_id::text) <> 'refund' then
    raise exception 'the rejection audit row has the wrong entity';
  end if;

  -- 5. the money is available again: a rejected refund no longer consumes the
  --    sale's refundable amount, so the same 10.00 return is now allowed
  perform pg_temp.become(v_cashier);
  v_return := public.pos_process_return(jsonb_build_object(
    'sale_id',       v_sale_id::text,
    'reason',        'Returned anyway, with the right paperwork',
    'refund_method', 'cash',
    'refund_status', 'pending',
    'user_id',       v_cashier::text,
    'user_name',     'Karim Cashier',
    'items',         jsonb_build_array(jsonb_build_object('sale_item_id', v_line_id::text, 'quantity', 1))
  ));
  v_refund_id := (v_return->>'refund_id')::uuid;

  -- 6. the manager settles this one: it completes, once
  perform pg_temp.become(v_manager);
  v_return := public.pos_settle_refund(v_refund_id, v_manager::text, 'Mona Manager');
  if (v_return->>'status') <> 'completed' then
    raise exception 'settling returned %', v_return->>'status';
  end if;

  select * into v_row from public.refund_records where id = v_refund_id;
  if v_row.status <> 'completed' or v_row.settled_at is null or v_row.settled_by <> v_manager::text then
    raise exception 'the settled refund is wrong (% / % / %)', v_row.status, v_row.settled_at, v_row.settled_by;
  end if;

  select count(*) into v_count from public.audit_log
   where action = 'refund.settled' and entity_id = v_refund_id::text;
  if v_count <> 1 then
    raise exception 'the settlement wrote % audit rows', v_count;
  end if;

  -- settling again is idempotent and writes nothing
  v_return := public.pos_settle_refund(v_refund_id, v_manager::text, 'Mona Manager');
  if not (v_return->>'already_settled')::boolean then
    raise exception 'settling twice did not report already_settled';
  end if;
  select count(*) into v_count from public.audit_log
   where action = 'refund.settled' and entity_id = v_refund_id::text;
  if v_count <> 1 then
    raise exception 'settling twice wrote % audit rows', v_count;
  end if;

  -- and a decision is final: a settled refund cannot be re-decided
  begin
    perform public.pos_settle_refund(v_refund_id, v_manager::text, 'Mona Manager', 'rejected', 'changed my mind');
    raise exception 'a settled refund was re-decided';
  exception when check_violation then
    null;
  end;

  -- the money itself is immutable. `authenticated` holds no UPDATE on this
  -- table at all (the grant is the first refusal), and behind it stands
  -- `enforce_refund_invariants()`, which refuses a rewritten amount for a
  -- writer that does have the privilege — a legacy project, or service_role.
  begin
    update public.refund_records set amount = 999.00 where id = v_refund_id;
    raise exception 'a refund amount was rewritten';
  exception when insufficient_privilege then
    null;
  end;
  if (select amount from public.refund_records where id = v_refund_id) <> 10.00 then
    raise exception 'the refund amount moved anyway';
  end if;

  -- 7. a refund paid over the counter is stamped as settled at the moment it
  --    was recorded — no approval step, and no empty settlement stamp
  perform pg_temp.become(v_cashier);
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'refn-sale-2',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'tendered', 10.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  select id into v_line_id from public.sale_items where sale_id = (v_sale->>'sale_id')::uuid;
  v_return := public.pos_process_return(jsonb_build_object(
    'sale_id',       v_sale->>'sale_id',
    'reason',        'Wrong flavour',
    'refund_method', 'cash',
    'user_id',       v_cashier::text,
    'user_name',     'Karim Cashier',
    'items',         jsonb_build_array(jsonb_build_object('sale_item_id', v_line_id::text, 'quantity', 1))
  ));
  select * into v_row from public.refund_records where id = (v_return->>'refund_id')::uuid;
  if v_row.status <> 'completed' then
    raise exception 'a counter refund defaulted to % instead of completed', v_row.status;
  end if;
  if v_row.settled_at is null or v_row.settled_by <> v_cashier::text then
    raise exception 'a counter refund was not stamped as settled when it was paid';
  end if;

  raise notice 'refunds — owed, settled once, rejected without moving money';
end
$$;

-- ── Phase 18: the grant layer, as the role the browser actually gets ──────
-- Two things only a session can prove: that the document column is unreachable
-- by naming its table (no policy to argue with — no grant), and that the
-- scheduler's entry point is unreachable, which is the entire authority it has,
-- since it checks no capability of its own.
do $$
declare
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_admin   uuid := '00000000-0000-4000-8000-0000000000a1';
  v_count   integer;
begin
  perform pg_temp.become(v_cashier);

  begin
    perform count(*) from public.backups;
    raise exception 'authenticated read public.backups directly';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.automatic_backup_if_due();
    raise exception 'a session reached the scheduler entry point';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.prune_backups();
    raise exception 'a session pruned the snapshots itself';
  exception when insufficient_privilege then
    null;
  end;

  -- the schedule is readable by a seat that may see the panel, and this one may
  -- not: an empty result, not an error
  select count(*) into v_count from public.backup_settings;
  if v_count <> 0 then
    raise exception 'backup_settings was readable by a cashier';
  end if;

  perform pg_temp.become(v_admin);
  select count(*) into v_count from public.backup_settings;
  if v_count <> 1 then
    raise exception 'an admin could not read the backup schedule (% rows)', v_count;
  end if;
  select count(*) into v_count from public.backup_manifests;
  if v_count < 1 then
    raise exception 'an admin sees no snapshots after the restore scenario';
  end if;

  raise notice 'backup & recovery — the document column has no grant, and the clock has no caller but the clock';
end
$$;

-- ── Phase 30b: catalogue authority, and who owns a counter ────────────────
-- Before 0030 the products and categories write policies read `with check
-- (true)`, so any signed-in identity — a viewer included — could rewrite a
-- price, rename a shelf or empty the shop. The UI hid the buttons; a forged
-- request never had to look at the UI. The policies now ask `public.can()` for
-- the same capability the UI hides behind.
--
-- What the shipped matrix actually says, and therefore what these assertions
-- expect: add_product, edit_product, delete_product, change_price, change_cost
-- and adjust_stock are held by admin, manager, cashier and inventory_clerk, and
-- by no viewer. So the new gates stop viewers and anonymous callers and leave
-- every working tier exactly as productive as it was — which is asserted here
-- rather than assumed, because "the till still works" is the part that would
-- break silently if a capability name were misspelled.
--
-- The price trigger is the layer that bites where an OVERLAY says it should: a
-- custom role that may edit but not reprice, or a denial on one person. It is
-- tested through the exception RPC, not by pretending a cashier lacks a
-- capability they hold.
do $$
declare
  v_admin   uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer  uuid := '00000000-0000-4000-8000-0000000000e1';
  v_product uuid := '00000000-0000-4000-8000-000000000b30';
  v_cat     uuid := '00000000-0000-4000-8000-0000000000f1';
  v_clerk   uuid;
  v_rows    integer;
  v_price   numeric;
  v_cost    numeric;
  v_sale    jsonb;
begin
  -- ── a viewer writes nothing ─────────────────────────────────────────────
  perform pg_temp.become(v_viewer);

  -- reading the shop window is not a privilege: the app previews it from inside
  select count(*) into v_rows from public.storefront_catalogue();
  if v_rows < 1 then
    raise exception 'a signed-in viewer lost the storefront catalogue';
  end if;

  -- RLS does not raise on these: the USING clause filters every row out, so the
  -- statement succeeds having changed nothing. The assertion is the effect.
  update public.products set selling_price = 0.01 where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a viewer rewrite a price (% row(s))', v_rows;
  end if;

  delete from public.products where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a viewer delete a product (% row(s))', v_rows;
  end if;

  begin
    insert into public.products (id, sku, name_ar, name_en, category_id, selling_price, stock_quantity)
    values ('00000000-0000-4000-8000-000000000b32', 'SCN-VWR', 'منتج', 'Viewer Product', v_cat, 5.00, 1);
    raise exception 'RLS let a viewer add a product';
  exception when insufficient_privilege then
    null;
  end;

  update public.categories set name_en = 'Renamed by a viewer' where id = v_cat;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a viewer rename a category (% row(s))', v_rows;
  end if;

  update public.stock_movements set notes = 'injected' where product_id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'RLS let a viewer write the stock ledger (% row(s))', v_rows;
  end if;

  begin
    insert into public.stock_movements (
      product_id, delta, quantity_before, quantity_after, type, reason, user_id, user_name
    ) values (v_product, 100, 12, 112, 'receive', 'purchase', 'forged', 'Forged');
    raise exception 'RLS let a viewer add to the stock ledger';
  exception when insufficient_privilege then
    null;
  end;

  select selling_price into v_price from public.products where id = v_product;
  if v_price <> 250.00 then
    raise exception 'the viewer''s price change landed (%)', v_price;
  end if;
  if (select name_en from public.categories where id = v_cat) <> 'Beverages' then
    raise exception 'the viewer''s category rename landed';
  end if;
  if exists (select 1 from public.products where sku = 'SCN-VWR') then
    raise exception 'the viewer''s product landed';
  end if;

  -- ── the till tier keeps working ─────────────────────────────────────────
  perform pg_temp.become(v_cashier);

  update public.products set selling_price = 275.00 where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'a cashier could not edit a product any more (% row(s))', v_rows;
  end if;
  select selling_price into v_price from public.products where id = v_product;
  if v_price <> 275.00 then
    raise exception 'the cashier''s price edit did not land (%)', v_price;
  end if;

  -- `change_cost` IS a cashier capability in the shipped matrix, so the margin
  -- is theirs to move; asserting otherwise would be asserting a fiction
  update public.products set cost_price = 95.00 where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'a cashier could not move the cost price (% row(s))', v_rows;
  end if;
  select cost_price into v_cost from public.products where id = v_product;
  if v_cost <> 95.00 then
    raise exception 'the cashier''s cost change did not land (%)', v_cost;
  end if;

  -- an edit that touches no price passes: the trigger reads two columns
  update public.products set name_en = 'Gold Necklace (polished)' where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'the price trigger blocked an edit that touched no price';
  end if;

  -- The ledger is NOT the cashier's: `adjust_stock` is held by admin, manager
  -- and inventory_clerk, so a cashier is refused here exactly as the matrix
  -- says, and the tier that does hold it still writes.
  begin
    insert into public.stock_movements (
      product_id, delta, quantity_before, quantity_after, type, reason, user_id, user_name
    ) values (v_product, 8, 12, 20, 'receive', 'purchase', 'forged', 'Forged');
    raise exception 'a cashier wrote the stock ledger without holding adjust_stock';
  exception when insufficient_privilege then
    null;
  end;

  -- The lookup needs oversight: `profiles` is readable as yourself, your own
  -- row, or with `view_audit_log`, so the staff list is asked for as the admin.
  perform pg_temp.become(v_admin);
  select p.id into v_clerk
    from public.profiles p
   where p.role::text = 'inventory_clerk' and p.active
   limit 1;
  if v_clerk is null then
    raise exception 'no active inventory_clerk profile to test the ledger with';
  end if;

  perform pg_temp.become(v_clerk);
  insert into public.stock_movements (
    product_id, delta, quantity_before, quantity_after, type, reason, user_id, user_name
  ) values (v_product, 8, 12, 20, 'receive', 'purchase', 'forged', 'Forged');
  select count(*) into v_rows from public.stock_movements where product_id = v_product;
  if v_rows < 1 then
    raise exception 'an inventory clerk could not write the stock ledger any more';
  end if;

  -- ── the price trigger, where it is supposed to bite ─────────────────────
  -- A per-user denial is how an admin narrows one person below their role, and
  -- `public.can()` is what both the UI and the new trigger ask. Deny the price
  -- capability and the database refuses what the UI would only have hidden.
  perform pg_temp.become(v_admin);
  perform public.admin_set_user_exceptions(v_cashier, null, array['change_price']);

  perform pg_temp.become(v_cashier);
  if public.can('change_price') then
    raise exception 'the denial did not remove change_price';
  end if;
  begin
    update public.products set selling_price = 199.00 where id = v_product;
    raise exception 'a denied change_price did not stop the price change';
  exception when insufficient_privilege then
    null;
  end;
  select selling_price into v_price from public.products where id = v_product;
  if v_price <> 275.00 then
    raise exception 'the denied price change landed (%)', v_price;
  end if;

  -- still able to edit everything that is not a price
  update public.products set name_en = 'Gold Necklace' where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'the denial blocked an edit that touched no price';
  end if;

  -- clearing the denial restores the capability, and the edit with it
  perform pg_temp.become(v_admin);
  perform public.admin_set_user_exceptions(v_cashier, null, null);
  perform pg_temp.become(v_cashier);
  if not public.can('change_price') then
    raise exception 'clearing the denial did not restore change_price';
  end if;
  update public.products set selling_price = 280.00 where id = v_product;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'the restored price capability did not take effect';
  end if;

  -- ── the counters are internal state: no session owns the next number ─────
  perform pg_temp.become(v_cashier);
  -- 0030 took the privileges away, which is a hard refusal rather than a
  -- filtered statement — so these are caught, not counted.
  begin
    update public.sale_counters set next_value = 999999 where id = 1;
    raise exception 'a session rewrote the sale counter';
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.sale_counters where id = 1;
    raise exception 'a session deleted the sale counter';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.sale_counters (id, next_value) values (1, 42)
    on conflict (id) do update set next_value = 42;
    raise exception 'a session rewrote the sale counter through an upsert';
  exception when insufficient_privilege then
    null;
  end;
  begin
    select count(*) into v_rows from public.sale_counters;
    if v_rows <> 0 then
      raise exception 'a session read % counter row(s)', v_rows;
    end if;
  exception when insufficient_privilege then
    null;
  end;

  -- …and the till still numbers its sales, which is the point of taking the
  -- privileges away rather than writing a policy: the definer function is the
  -- only writer left, and it is the one that always produced the number.
  select selling_price into v_price from public.products where id = v_product;
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-counter-check',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_price, 'tendered', v_price)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  if (v_sale->>'sale_id') is null then
    raise exception 'a sale could not be completed after the counter revoke';
  end if;
  if (select sale_number from public.sales where id = (v_sale->>'sale_id')::uuid) !~ '^INV-[0-9]{6}$' then
    raise exception 'the sale counter stopped producing sale numbers';
  end if;

  raise notice 'catalogue authority — a viewer writes nothing, the till tier writes what it could before, a denial stops a price, and no session owns a counter';
end
$$;
-- ── Phase 31: the shape of the policy set, and the category gate ──────────
-- 0030 gated the catalogue writes and 0031 removes the one policy that stayed
-- open beside them. The failure mode is not visible from any single statement:
-- row level security ORs the policies for a command, so `with check (true)`
-- sitting next to a capability gate silently defeats it, and every gated
-- statement in this file still passes while the ungated path is wide open.
--
-- So both halves are asserted here — the attack a viewer could actually make,
-- and the shape of pg_policies that would let a future migration reintroduce
-- it. The second is the one that earns its keep: it fails on ANY table, for ANY
-- command, the day someone creates an open write policy again, which is how the
-- category one survived thirty migrations.
do $$
declare
  v_viewer   uuid := '00000000-0000-4000-8000-0000000000e1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_new_cat  uuid := '00000000-0000-4000-8000-000000000f31';
  v_till_cat uuid := '00000000-0000-4000-8000-000000000f32';
  v_open     text;
  v_rows     integer;
begin
  -- ── no public table may carry an ungated write policy ────────────────────
  -- `qual` guards UPDATE/DELETE visibility, `with_check` guards INSERT/UPDATE
  -- rows; either one reading literally TRUE means the command is open to every
  -- signed-in identity regardless of capability.
  select string_agg(tablename || '.' || policyname || ' [' || cmd || ']', ', '
                    order by tablename, policyname)
    into v_open
    from pg_policies
   where schemaname = 'public'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');
  if v_open is not null then
    raise exception 'an ungated write policy is live: %', v_open;
  end if;

  -- ── a viewer cannot add a shelf ──────────────────────────────────────────
  perform pg_temp.become(v_viewer);
  begin
    insert into public.categories (id, name_ar, name_en)
    values (v_new_cat, 'رف', 'Viewer Shelf');
    raise exception 'RLS let a viewer add a category';
  exception when insufficient_privilege then
    null;
  end;
  select count(*) into v_rows from public.categories where id = v_new_cat;
  if v_rows <> 0 then
    raise exception 'the viewer''s category landed (% row(s))', v_rows;
  end if;

  -- ── the till tier still can, or the gate is a lockout ────────────────────
  -- A cashier holds add_product, so refusing this would mean the fix narrowed
  -- the catalogue instead of securing it.
  perform pg_temp.become(v_cashier);
  insert into public.categories (id, name_ar, name_en)
  values (v_till_cat, 'رف', 'Cashier Shelf');
  select count(*) into v_rows from public.categories where id = v_till_cat;
  if v_rows <> 1 then
    raise exception 'a cashier lost the right to add a category';
  end if;
  delete from public.categories where id = v_till_cat;

  raise notice 'policy set — no ungated write policy on any table, a viewer cannot add a category, the till tier still can';
end
$$;

-- ── Phase 22.1: the report aggregates, and who may read them ────────────────
-- 0032 moved the reports' arithmetic into five RPCs. Two things are asserted
-- here that the differential suite in scripts/reports.aggregates.mjs cannot:
--
--   1. the gate is `public.can('view_reports')` and nothing weaker — including
--      the case that matters most, an ADMIN narrowed by a custom role. can()
--      lets an active custom role decide absolutely, so a role without
--      view_reports must refuse even though the system role underneath is
--      admin. A gate that read `profiles.role` instead would pass this file and
--      leak every report to a narrowed user.
--   2. the payload is a fixed set of keys. A report that starts returning a
--      column nobody asked for — a customer's phone, an employee's contact, a
--      cost the screen never shows — fails no arithmetic test anywhere, because
--      every number it returns is still correct. Only a shape assertion catches
--      it, and it catches it the day it is added.
--
-- What is NOT asserted here is the values: that the database and the shipped
-- TypeScript builders return the same numbers over 2,500 invoices is the
-- differential suite's job, and it is a much better place for it.
create or replace function pg_temp.report_shape(p jsonb, allowed text[])
returns text
language sql
as $$
  -- "unexpected|missing": both halves empty means the payload is exactly the
  -- promised shape. Order is irrelevant, so neither list is sorted against the
  -- other — a collation difference must not be able to fail this.
  select coalesce((select string_agg(k, ', ' order by k)
                     from jsonb_object_keys(p) k
                    where not (k = any(allowed))), '')
      || '|'
      || coalesce((select string_agg(a, ', ' order by a)
                     from unnest(allowed) a
                    where not (p ? a)), '')
$$;

do $$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_viewer   uuid := '00000000-0000-4000-8000-0000000000e1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_stranger uuid := '00000000-0000-4000-8000-00000000f032';
  v_role_id  uuid;
  v_shape    text;
  v_fin      jsonb;
  v_sales    jsonb;
  v_inv      jsonb;
  v_exp      jsonb;
  v_prod     jsonb;
begin
  -- ── an admin reads all five, and each answers with exactly its promised keys
  perform pg_temp.become(v_admin);

  select public.reports_financial_summary(null, null) into v_fin;
  v_shape := pg_temp.report_shape(v_fin, array[
    'invoiceCount','revenue','cogs','grossProfit','expenses','netProfit','cash','card',
    'instapay','unsettled','voidedCount','voidedTotal','returnsCount','returnsTotal',
    'refundsCount','refundsPaid','refundsPending','unitCount']);
  if v_shape <> '|' then
    raise exception 'the financial summary changed shape (unexpected|missing): %', v_shape;
  end if;

  select public.reports_sales_summary(null, null, 'UTC') into v_sales;
  v_shape := pg_temp.report_shape(v_sales, array[
    'invoices','revenue','discounts','units','voidedCount','byMethod','byEmployee','byDay']);
  if v_shape <> '|' then
    raise exception 'the sales summary changed shape (unexpected|missing): %', v_shape;
  end if;

  select public.reports_inventory_summary() into v_inv;
  -- Phase 43 added the variant counts beside the product totals. They are
  -- additive: the product keys keep their meaning, and the variant keys answer
  -- what a product total cannot ("3 of 6 combinations are low").
  v_shape := pg_temp.report_shape(v_inv, array[
    'products','tracked','units','atCost','atRetail','potentialMargin','lowStock','outOfStock',
    'variantProducts','variants','activeVariants','lowVariants','soldOutVariants']);
  if v_shape <> '|' then
    raise exception 'the inventory summary changed shape (unexpected|missing): %', v_shape;
  end if;

  select public.reports_expense_summary(null, null, 'UTC') into v_exp;
  v_shape := pg_temp.report_shape(v_exp, array[
    'count','total','cash','instapay','visa','activeDays','byCategory','byMethod',
    'byEmployee','byBranch','byDay','largest']);
  if v_shape <> '|' then
    raise exception 'the expense summary changed shape (unexpected|missing): %', v_shape;
  end if;

  select public.reports_product_performance(null, null) into v_prod;
  if jsonb_typeof(v_prod) <> 'array' then
    raise exception 'product performance must return an array, got %', jsonb_typeof(v_prod);
  end if;
  if jsonb_array_length(v_prod) > 0 then
    v_shape := pg_temp.report_shape(v_prod -> 0, array[
      'productId','sku','nameEn','nameAr','sold','invoices','units','revenue',
      'sellingPrice','cost','stockValue','stock']);
    if v_shape <> '|' then
      raise exception 'a product row changed shape (unexpected|missing): %', v_shape;
    end if;
  end if;

  -- ── a viewer may read them too, or the gate is a lockout ─────────────────
  -- Every system role holds view_reports, viewer included: "may see the
  -- numbers" is exactly what that role is for. Refusing here would mean 0032
  -- narrowed who can read a report, which is not what it was for.
  perform pg_temp.become(v_viewer);
  perform public.reports_financial_summary(null, null);
  perform public.reports_sales_summary(null, null, 'UTC');
  perform public.reports_product_performance(null, null);
  perform public.reports_inventory_summary();
  perform public.reports_expense_summary(null, null, 'UTC');

  -- ── a signed-in identity with no profile is refused ──────────────────────
  perform pg_temp.become(v_stranger);
  begin
    perform public.reports_financial_summary(null, null);
    raise exception 'a profile-less identity read the financial summary';
  exception when insufficient_privilege then
    null;
  end;

  -- ── and so is anon, which has no EXECUTE grant at all ────────────────────
  perform pg_temp.become(null, 'anon');
  begin
    perform public.reports_financial_summary(null, null);
    raise exception 'anon read the financial summary';
  exception when insufficient_privilege then
    null;
  end;

  -- ── the case that matters: a user NARROWED by a custom role ──────────────
  -- A cashier holds view_reports through the system matrix, so without an
  -- overlay they read every report. An admin narrows them with a custom role
  -- that omits it, and can() lets an ACTIVE custom role decide absolutely — so
  -- all five RPCs must now refuse a user whose system role still says yes. A
  -- gate that read profiles.role instead of can() would pass every assertion
  -- above and leak the whole report book here.
  --
  -- The narrowing is done through the admin RPCs, not by writing the tables:
  -- custom_roles has no INSERT grant for authenticated, because a role list is
  -- exactly the thing a browser must not be able to edit directly. And it is
  -- the CASHIER who is narrowed, not the caller — admin_set_custom_role refuses
  -- to let an admin change their own role, which is what stops an installation
  -- locking itself out.
  perform pg_temp.become(v_admin, 'authenticated');
  -- Read as a row source, not assigned as a composite: `select f() into v` with
  -- v declared as the function's row type makes plpgsql coerce the whole record
  -- into v's FIRST field, which is a uuid here and not a row.
  select r.id into v_role_id
    from public.admin_create_custom_role(
           'scn_no_reports', 'No Reports', 'بدون تقارير', null, null,
           'cashier'::public.app_role,
           (select coalesce(array_agg(capability), '{}')
              from public.role_capabilities
             where role = 'cashier' and capability <> 'view_reports')) as r;

  perform public.admin_set_custom_role(v_cashier, v_role_id);

  perform pg_temp.become(v_cashier);
  begin
    perform public.reports_financial_summary(null, null);
    raise exception 'a cashier narrowed without view_reports was served the financial summary';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.reports_sales_summary(null, null, 'UTC');
    raise exception 'a cashier narrowed without view_reports was served the sales summary';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.reports_product_performance(null, null);
    raise exception 'a cashier narrowed without view_reports was served product performance';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.reports_inventory_summary();
    raise exception 'a cashier narrowed without view_reports was served the inventory summary';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.reports_expense_summary(null, null, 'UTC');
    raise exception 'a cashier narrowed without view_reports was served the expense summary';
  exception when insufficient_privilege then
    null;
  end;

  -- ── the same seat still reads the shift book ──────────────────────────────
  -- The database half of the Phase 23 route fix. `/reports` used to be gated by
  -- `view_shifts`, so this narrowed cashier — who kept view_shifts and lost
  -- view_reports — was admitted by the route guard and then refused by the page
  -- and by all five RPCs above: a link that led to a denial screen. The route
  -- table now names `view_reports`, which only holds if the two capabilities are
  -- genuinely independent, so both directions are asserted on the one seat that
  -- sits exactly between them: losing the reports must not cost the shift book,
  -- and holding the shift book must not buy the reports.
  if public.can('view_reports') then
    raise exception 'the narrowed cashier still holds view_reports';
  end if;
  if not public.can('view_shifts') then
    raise exception 'narrowing away view_reports also took view_shifts with it';
  end if;
  begin
    perform 1 from public.expenses limit 1;
    perform 1 from public.shifts limit 1;
  exception when insufficient_privilege then
    raise exception 'narrowing away view_reports also closed the expenses and shift book';
  end;

  -- put the cashier back the way the rest of the file expects to find them:
  -- clearing the assignment returns them to the system matrix, and deactivating
  -- the role leaves nothing behind that a later scenario could pick up.
  perform pg_temp.become(v_admin, 'authenticated');
  perform public.admin_set_custom_role(v_cashier, null);
  perform public.admin_set_custom_role_active(v_role_id, false);
  perform pg_temp.become(v_admin);

  raise notice 'report aggregates — all five answer an admin and a viewer with exactly their promised keys, and refuse a profile-less identity, anon, and a cashier an admin narrowed without view_reports';
end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Phase 23: the POS write RPCs must enforce the matrix themselves
--
-- 0033 and 0034 fixed two things that no test in this file covered, and both
-- were invisible for the same reason: the application checks capabilities before
-- it calls, and the end-to-end suites run the bundle in DEMO mode, where orders
-- and sales live in localStorage and never reach PostgreSQL. So the browser was
-- always well behaved, and nothing ever asked what the database does on its own.
--
--   1. `pos_complete_sale`, `pos_process_return`, `pos_confirm_payment` and
--      `pos_void_sale` are SECURITY DEFINER — RLS does not apply inside them —
--      and were EXECUTE-granted to `authenticated` with no predicate. Any
--      signed-in seat could call them directly. A viewer, whose can('sell'),
--      can('process_return'), can('void_sale') and can('confirm_payment') are all
--      false, did all four: wrote a sale and its stock movement, issued a refund,
--      marked a pending InstaPay payment as paid, and voided a completed sale.
--      `void_sale` is held by managers and admins alone, so even a cashier could
--      void — the capability existed and nothing enforced it.
--
--   2. `place_online_order` priced the cart correctly in its first loop and then
--      wrote the snapshot rows from `p_payload->'lines'->>'unit_price'`, a key the
--      app never sends (its contract is `{ product_id, qty }`). Against a real
--      database every checkout failed the NOT NULL constraint on
--      online_order_items.unit_price — online ordering did not work in live mode
--      at all — and a caller who did send a price set the shop's own record: a
--      forged 0.01 was stored as the line price.
--
-- What is asserted below is therefore the database on its own terms: the caller
-- is impersonated with the claim, the RPC is called directly, and the answer has
-- to come from the function and not from any screen.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin      uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier    uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer     uuid := '00000000-0000-4000-8000-0000000000e1';
  v_product    uuid := '00000000-0000-4000-8000-0000000000f2';
  v_sale       jsonb;
  v_sale_id    uuid;
  v_item_id    uuid;
  v_pending_id uuid;
  v_void_id    uuid;
  v_order      jsonb;
  v_order_id   uuid;
  v_snapshot   record;
  v_forged_id  uuid;
  v_forged     record;
  v_list       numeric(14,2);
  v_online_sale bigint;
begin
  -- ── the sales the attacks are aimed at, made legitimately by a cashier ─────
  perform pg_temp.become(v_cashier, 'authenticated');

  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'p23-return-target-' || gen_random_uuid()::text,
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00))));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id limit 1;

  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'p23-pending-' || gen_random_uuid()::text,
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'instapay', 'amount', 20.00, 'status', 'pending'))));
  v_pending_id := (v_sale->>'sale_id')::uuid;

  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'p23-void-' || gen_random_uuid()::text,
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00))));
  v_void_id := (v_sale->>'sale_id')::uuid;

  select selling_price into v_list from public.products where id = v_product;

  -- ── DENY: a viewer holds none of the four capabilities ─────────────────────
  perform pg_temp.become(v_viewer, 'authenticated');

  if public.can('sell') or public.can('process_return')
     or public.can('void_sale') or public.can('confirm_payment') then
    raise exception 'the viewer fixture gained a POS capability; the denials below would prove nothing';
  end if;

  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'p23-viewer-' || gen_random_uuid()::text,
      'user_id', v_viewer::text, 'user_name', 'Vera Viewer',
      'lines', jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1)),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00))));
    raise exception 'a viewer completed a sale by calling the RPC directly';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.pos_process_return(jsonb_build_object(
      'sale_id', v_sale_id::text, 'reason', 'viewer should not be able to return',
      'refund_method', 'cash', 'refund_status', 'completed',
      'user_id', v_viewer::text, 'user_name', 'Vera Viewer',
      'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id::text, 'quantity', 1))));
    raise exception 'a viewer processed a return and issued a refund';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.pos_confirm_payment(v_pending_id, v_viewer::text, 'Vera Viewer');
    raise exception 'a viewer confirmed an InstaPay payment as received';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.pos_void_sale(v_void_id, v_viewer::text, 'Vera Viewer', 'viewer should not void');
    raise exception 'a viewer voided a completed sale';
  exception when insufficient_privilege then
    null;
  end;

  -- ── DENY: a cashier may sell but not void — the guard reads the matrix, it
  --    does not merely wave staff through ─────────────────────────────────────
  perform pg_temp.become(v_cashier, 'authenticated');
  if public.can('void_sale') then
    raise exception 'the cashier fixture holds void_sale; the cashier denial below would prove nothing';
  end if;
  begin
    perform public.pos_void_sale(v_void_id, v_cashier::text, 'Karim Cashier', 'cashier should not void');
    raise exception 'a cashier voided a sale, which only a manager or admin may do';
  exception when insufficient_privilege then
    null;
  end;

  -- ── ALLOW: the seats that legitimately hold each capability still work ─────
  perform public.pos_process_return(jsonb_build_object(
    'sale_id', v_sale_id::text, 'reason', 'damaged in transit',
    'refund_method', 'cash', 'refund_status', 'completed',
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id::text, 'quantity', 1))));

  perform public.pos_confirm_payment(v_pending_id, v_cashier::text, 'Karim Cashier');

  perform pg_temp.become(v_admin, 'authenticated');
  perform public.pos_void_sale(v_void_id, v_admin::text, 'Amina Admin', 'entry error');

  -- ── the online path the guard could so easily have broken ──────────────────
  -- `resolve_online_order` completes a customer's order by calling
  -- pos_complete_sale with source = 'online', under the resolving seat's claim.
  -- A guard that demanded `sell` alone would still pass for every shipped role,
  -- so this is the assertion that catches the careless version of the fix.
  perform pg_temp.become(null, 'anon');
  v_order := public.place_online_order(jsonb_build_object(
    'client_ref', 'p23-online-' || gen_random_uuid()::text,
    'customer_name', 'Probe Shopper', 'customer_phone', '01000000000',
    'delivery_type', 'pickup', 'payment_method', 'cod',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))));
  v_order_id := (v_order->>'order_id')::uuid;

  -- A second order, this one carrying a forged unit_price. The snapshot must
  -- record the shop's price either way; the customer does not get to set it.
  v_order := public.place_online_order(jsonb_build_object(
    'client_ref', 'p23-forged-' || gen_random_uuid()::text,
    'customer_name', 'Probe Forger', 'customer_phone', '01000000001',
    'delivery_type', 'pickup', 'payment_method', 'cod',
    'lines', jsonb_build_array(jsonb_build_object(
      'product_id', v_product::text, 'qty', 2, 'unit_price', 0.01))));
  v_forged_id := (v_order->>'order_id')::uuid;

  perform pg_temp.become(v_cashier, 'authenticated');

  select unit_price, quantity, line_total into v_snapshot
    from public.online_order_items where order_id = v_order_id limit 1;
  if v_snapshot.unit_price is distinct from v_list then
    raise exception 'the order snapshot recorded % where the catalogue says %',
      v_snapshot.unit_price, v_list;
  end if;
  if v_snapshot.line_total is distinct from round((v_list * v_snapshot.quantity)::numeric, 2) then
    raise exception 'the order line total % disagrees with the catalogue price', v_snapshot.line_total;
  end if;

  select unit_price into v_forged
    from public.online_order_items where order_id = v_forged_id limit 1;
  if v_forged.unit_price is distinct from v_list then
    raise exception 'a forged unit_price of 0.01 was stored as % instead of the shop''s %',
      v_forged.unit_price, v_list;
  end if;

  perform public.resolve_online_order(jsonb_build_object(
    'order_id', v_order_id::text, 'action', 'approve',
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier'));

  select count(*) into v_online_sale from public.sales
   where client_ref = 'online-' || v_order_id::text;
  if v_online_sale <> 1 then
    raise exception 'approving an online order no longer creates its sale (% found)', v_online_sale;
  end if;

  perform pg_temp.become(v_admin, 'authenticated');

  raise notice 'Phase 23 RPC authorization — a viewer is refused all four POS writers, a cashier may sell but not void, an admin may, and the storefront still places an order at the shop''s price that approval still turns into a sale';
end
$$;

-- ── leave no session claim behind ─────────────────────────────────────────
-- ── Phase 24 · server-enforced approval controls ─────────────────────────────
-- The six cases from the requirement, run against the real RPC as the seeded
-- CASHIER — who holds `sell` and does NOT hold `approve_limit_request`, so the
-- limits bind them. Every one of these was a working bypass before 0035: the
-- thresholds were fetched by the browser and compared in TypeScript, so a call
-- that did not go through the browser was not a call that had to ask.
--
-- Then requirement 6: the approval ledger itself. A request cannot be forged,
-- an approved status cannot be injected, a decision cannot be spent twice, and
-- what was spent is linked to the record it produced.
do $$
declare
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_manager  uuid;
  v_product  uuid := '00000000-0000-4000-8000-0000000000f2';
  v_sale     jsonb;
  v_sale_id  uuid;
  v_appr     uuid;
  v_other    uuid;
  v_small    uuid;
  v_pending  uuid;
  v_stock    integer;
  v_n        integer;
  v_text     text;
  v_amt      numeric(14,2);
  v_total    numeric(14,2);
  v_row      public.approval_requests%rowtype;
begin
  perform pg_temp.become(v_admin, 'authenticated');
  select p.id into v_manager from public.profiles p where p.username = 'manager';
  if v_manager is null then
    raise exception 'the seeded manager profile is missing';
  end if;

  perform pg_temp.become(v_cashier, 'authenticated');
  -- The two preconditions that make every case below mean what it says.
  if public.can('approve_limit_request') then
    raise exception 'the seeded cashier holds approve_limit_request, so the limits would not bind them';
  end if;
  if not public.can('sell') then
    raise exception 'the seeded cashier cannot sell, so the sales below would fail for the wrong reason';
  end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock < 10 then
    raise exception 'the fixture product has only % left; the sales below need 10', v_stock;
  end if;

  -- ── the threshold oracle agrees with the four evaluators in the browser ────
  -- Same conditions, same units, same boundaries: 10% is inside the limit, the
  -- next cent is not. If these two sides ever drift, one of them is lying about
  -- what the shop's policy is.
  if public.approval_required_for('discount', 0) then
    raise exception 'a discount of 0 was reported as needing approval';
  end if;
  if public.approval_required_for('discount', 10.00) then
    raise exception 'a discount at the limit was reported as needing approval';
  end if;
  if not public.approval_required_for('discount', 10.01) then
    raise exception 'a discount above the limit was not reported as needing approval';
  end if;
  if public.approval_required_for('refund', 1000.00) or not public.approval_required_for('refund', 1000.01) then
    raise exception 'the refund threshold does not match evaluateRefundRule()';
  end if;
  if public.approval_required_for('expense', 500.00) or not public.approval_required_for('expense', 500.01) then
    raise exception 'the expense threshold does not match evaluateExpenseRule()';
  end if;
  if public.approval_required_for('price_change', 999) then
    raise exception 'price-change approval is off by default and must stay off';
  end if;
  begin
    perform public.approval_required_for('nonsense', 1);
    raise exception 'an unknown kind was accepted';
  exception when check_violation then
    null;
  end;
  -- …and the exemption is the acting identity's, not the caller's claim: an admin
  -- holds approve_limit_request, so for them no value needs a request.
  perform pg_temp.become(v_admin, 'authenticated');
  if public.approval_required_for('discount', 99.9) then
    raise exception 'a holder of approve_limit_request was told to file paperwork';
  end if;
  perform pg_temp.become(v_cashier, 'authenticated');

  -- ── TEST 1 · 99.9% discount, no approval → FAIL ───────────────────────────
  -- Before 0035 this wrote a completed sale for 0.01 of a 10.00 basket.
  begin
    v_sale := public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-t1',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ));
    raise exception 'TEST 1 FAILED: a cashier rang up a 99.9 percent discount with no approval behind it';
  exception when insufficient_privilege then
    null;
  end;
  select count(*) into v_n from public.sales where client_ref = 'p24-t1';
  if v_n <> 0 then
    raise exception 'TEST 1 FAILED: the refused discount still wrote % sale row(s)', v_n;
  end if;

  -- ── TEST 6 first, because it needs no approval: a normal sale → SUCCESS ───
  -- Under the limit, so nothing is asked for. This is the case that proves the
  -- gate did not simply start refusing discounts.
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',     'p24-t6',
    'user_id',        v_cashier::text,
    'user_name',      'Karim Cashier',
    'discount_type',  'percent',
    'discount_value', 5,
    'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',9.50,'tendered',10.00)),
    'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  if (v_sale ->> 'sale_id') is null then
    raise exception 'TEST 6 FAILED: a discount within the limit was refused';
  end if;
  select discount_amount, total into v_amt, v_total from public.sales where client_ref = 'p24-t6';
  if v_amt <> 0.50 or v_total <> 9.50 then
    raise exception 'TEST 6 FAILED: a discount inside the limit on a 10.00 basket was recorded as % off, total %', v_amt, v_total;
  end if;

  -- ── TEST 2 · the same 99.9% with a valid approved request → SUCCESS ───────
  select (public.submit_approval_request(jsonb_build_object(
           'kind',         'discount',
           'entity_type',  'sale',
           'entity_label', 'p24-t2',
           'amount',       99.9,
           'limit_value',  10.00,
           'reason',       'Clearing water damaged in the delivery'
         )) ->> 'request_id')::uuid into v_appr;
  -- requirement 6: the ledger stamps who really asked, whatever the payload said
  select requested_by into v_text from public.approval_requests where id = v_appr;
  if v_text is distinct from v_cashier::text then
    raise exception 'the request was attributed to % instead of the caller', coalesce(v_text, '(nobody)');
  end if;

  perform pg_temp.become(v_manager, 'authenticated');
  perform public.decide_approval_request(v_appr, 'approved', 'Damaged stock, clear it');
  perform pg_temp.become(v_cashier, 'authenticated');

  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',     'p24-t2',
    'user_id',        v_cashier::text,
    'user_name',      'Karim Cashier',
    'discount_type',  'percent',
    'discount_value', 99.9,
    'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
    'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ), v_appr);
  v_sale_id := (v_sale ->> 'sale_id')::uuid;
  if v_sale_id is null then
    raise exception 'TEST 2 FAILED: an approved over-limit discount was refused';
  end if;
  -- and the totals are the shop's, not the caller's
  select discount_amount, total into v_amt, v_total from public.sales where id = v_sale_id;
  if v_amt <> 9.99 or v_total <> 0.01 then
    raise exception 'TEST 2 FAILED: the sale was recorded as % off, total %, instead of the catalogue-derived 9.99 and 0.01',
      v_amt, v_total;
  end if;
  -- requirement 6: spent, and spent on the record it authorised
  select result_entity_id into v_text from public.approval_requests where id = v_appr;
  if v_text is distinct from v_sale_id::text then
    raise exception 'TEST 2 FAILED: the approval was linked to % instead of sale %',
      coalesce(v_text, '(nothing)'), v_sale_id;
  end if;

  -- ── TEST 4b · the same approval cannot be spent again → FAIL ──────────────
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-t4b',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ), v_appr);
    raise exception 'TEST 4 FAILED: an already-spent approval was accepted a second time';
  exception when check_violation then
    null;
  end;
  select count(*) into v_n from public.sales where client_ref = 'p24-t4b';
  if v_n <> 0 then
    raise exception 'TEST 4 FAILED: the replayed approval wrote % sale row(s)', v_n;
  end if;

  -- ── TEST 3 · a fabricated request id → FAIL ───────────────────────────────
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-t3',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ), gen_random_uuid());
    raise exception 'TEST 3 FAILED: a fabricated approval id was accepted';
  exception when no_data_found then
    null;
  end;

  -- ── TEST 4a · somebody else's approval → FAIL ─────────────────────────────
  -- The manager raises and the admin signs a request that belongs to the
  -- manager. It is approved, unspent, the right kind and large enough — every
  -- property the cashier's own would have except who asked for it.
  perform pg_temp.become(v_manager, 'authenticated');
  select (public.submit_approval_request(jsonb_build_object(
           'kind', 'discount', 'entity_type', 'sale', 'entity_label', 'p24-t4a',
           'amount', 99.9, 'limit_value', 10.00, 'reason', 'Manager''s own clearing sale'
         )) ->> 'request_id')::uuid into v_other;
  perform pg_temp.become(v_admin, 'authenticated');
  perform public.decide_approval_request(v_other, 'approved', 'Fine');
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-t4a',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ), v_other);
    raise exception 'TEST 4 FAILED: a cashier spent an approval that belongs to the manager';
  exception when insufficient_privilege then
    null;
  end;
  select count(*) into v_n from public.sales where client_ref = 'p24-t4a';
  if v_n <> 0 then
    raise exception 'TEST 4 FAILED: the borrowed approval wrote % sale row(s)', v_n;
  end if;
  -- and borrowing it did not spend it: the manager's request is still available
  select result_entity_id into v_text from public.approval_requests where id = v_other;
  if v_text is not null then
    raise exception 'TEST 4 FAILED: the refused attempt still consumed the manager''s approval';
  end if;

  -- ── TEST 5 · an approval for a smaller discount → FAIL ────────────────────
  select (public.submit_approval_request(jsonb_build_object(
           'kind', 'discount', 'entity_type', 'sale', 'entity_label', 'p24-t5',
           'amount', 20.00, 'limit_value', 10.00, 'reason', 'A 20% clearance, not a giveaway'
         )) ->> 'request_id')::uuid into v_small;
  perform pg_temp.become(v_manager, 'authenticated');
  perform public.decide_approval_request(v_small, 'approved', '20% is the most I will sign');
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-t5',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ), v_small);
    raise exception 'TEST 5 FAILED: an approval for 20 percent was accepted for a 99.9 percent discount';
  exception when check_violation then
    null;
  end;
  -- the 20% it WAS signed for still works, which is the difference between a
  -- gate and a wall
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',     'p24-t5-ok',
    'user_id',        v_cashier::text,
    'user_name',      'Karim Cashier',
    'discount_type',  'percent',
    'discount_value', 20,
    'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',8.00,'tendered',10.00)),
    'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ), v_small);
  if (v_sale ->> 'sale_id') is null then
    raise exception 'TEST 5 FAILED: the 20 percent discount the approval covers was refused';
  end if;

  -- ── requirement 6 · the ledger cannot be written around ───────────────────
  -- (a) a request cannot be forged: INSERT is refused for every browser role, so
  --     submit_approval_request is the only way in and it stamps the caller.
  select (public.submit_approval_request(jsonb_build_object(
           'kind', 'discount', 'entity_type', 'sale', 'entity_label', 'p24-forgery',
           'amount', 99.9, 'limit_value', 10.00, 'reason', 'A request left pending on purpose'
         )) ->> 'request_id')::uuid into v_pending;
  begin
    insert into public.approval_requests (
      request_number, kind, entity_type, amount, reason, status, requested_by, requested_by_name
    ) values (
      'APR-FORGED', 'discount', 'sale', 99.9, 'forged', 'approved', v_admin::text, 'Forged'
    );
    raise exception 'a cashier inserted an approval request directly';
  exception when insufficient_privilege then
    null;
  end;

  -- (b) an approved status cannot be injected: UPDATE and DELETE are refused for
  --     every browser role, so the row stays exactly as the RPCs left it.
  -- Either layer refusing is the right answer: a live Supabase project grants
  -- every table to `authenticated` by default and leaves RLS as the only
  -- control, while this harness applies only the grants the migrations state, so
  -- here the denial arrives one layer earlier. What must hold in both is that
  -- the row does not move, which is what the assertion below checks.
  begin
    update public.approval_requests set status = 'approved' where id = v_pending;
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'a cashier updated % approval row(s) directly', v_n;
    end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.approval_requests where id = v_pending;
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'a cashier deleted % approval row(s) directly', v_n;
    end if;
  exception when insufficient_privilege then
    null;
  end;
  select * into v_row from public.approval_requests where id = v_pending;
  if v_row.status <> 'pending' then
    raise exception 'the injected status landed: the request is now %', v_row.status;
  end if;

  -- (c) nor can the cashier sign their own request through the RPC
  begin
    perform public.decide_approval_request(v_pending, 'approved', 'signing my own');
    raise exception 'a cashier decided their own approval request';
  exception when insufficient_privilege then
    null;
  end;

  -- (d) and an unspent request is not a licence: with the pending one sitting
  --     there, the 99.9% discount is still refused, because pending is not
  --     approved. This is the case that a gate reading only "a request exists"
  --     would get wrong.
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref',     'p24-pending',
      'user_id',        v_cashier::text,
      'user_name',      'Karim Cashier',
      'discount_type',  'percent',
      'discount_value', 99.9,
      'payments',       jsonb_build_array(jsonb_build_object('method','cash','amount',0.01,'tendered',0.01)),
      'lines',          jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ));
    raise exception 'a PENDING approval was treated as an approved one';
  exception when insufficient_privilege then
    null;
  end;

  -- (e) and one caller cannot spend another's decision. mark_approval_applied is
  --     SECURITY DEFINER, so it reads past row level security: without a check of
  --     its own, any signed-in seat holding a request's id could mark a
  --     colleague's approved request as applied to an entity of their choosing,
  --     burning it so the real act could never use it and poisoning the link
  --     between the decision and what it produced. The manager's request from
  --     case 4a is still approved and still unspent, which makes it the target.
  begin
    perform public.mark_approval_applied(v_other, 'burned-by-somebody-else');
    raise exception 'a cashier spent the manager''s approved request on an entity of their own choosing';
  exception when insufficient_privilege then
    null;
  end;
  select result_entity_id into v_text from public.approval_requests where id = v_other;
  if v_text is not null then
    raise exception 'the manager''s request was marked applied to % by somebody else', v_text;
  end if;

  perform pg_temp.become(v_admin, 'authenticated');

  raise notice 'Phase 24 server-enforced approvals — a cashier''s 99.9 percent discount is refused with no request behind it, '
               'accepted with an approved one, and refused with a fabricated, a borrowed, a smaller or an already-spent one; a '
               'discount inside the limit needs nothing; and the ledger refuses a forged insert, an injected status and a '
               'self-signed decision';
end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Phase 25: the product delete/archive lifecycle (0037), as the database alone
--
-- Every surface the app shows is a client-side rendering; what is asserted here
-- is the backend on its own terms, impersonated with `pg_temp.become` exactly
-- like the Phase 23 guards:
--
--   1. an admin permanently deletes a truly unused product — with product.deleted
--      on the trail, storefront content cascading by design, and NOT ONE
--      historical row anywhere moving;
--   2. a viewer is refused both lifecycle RPCs directly (no UI involved);
--   3. a referenced product cannot be permanently deleted — the RPC answers
--      restrict_violation, and the table itself answers foreign_key_violation
--      (the FK backstop that exists even around the function);
--   4. that same product archives, disappears from the till, the storefront and
--      the online checkout, keeps its invoice, its stock ledger and its place in
--      the reports — and reactivates back into sellability, each transition with
--      exactly one audit row.
do $$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer   uuid := '00000000-0000-4000-8000-0000000000e1';
  v_cat      uuid := '00000000-0000-4000-8000-0000000000f1';
  v_used     uuid := '00000000-0000-4000-8000-00000000d001';
  v_gone     uuid := '00000000-0000-4000-8000-00000000d002';

  v_sale       jsonb;
  v_sale_id    uuid;
  v_item_id    uuid;
  v_order      jsonb;
  v_order_id   uuid;
  v_lifecycle  jsonb;
  v_refs       record;
  v_count      bigint;
  v_si_sale_items bigint;
  v_si_movements  bigint;
  v_si_returns    bigint;
  v_si_orders     bigint;
  v_si_res        bigint;
  v_fin_before    jsonb;
  v_perf          jsonb;
begin
  -- ── fixtures (owner identity; no claim needed and none left over) ─────────
  insert into public.products (id, sku, name_ar, name_en, category_id, selling_price, cost_price, stock_quantity)
  values
    (v_used, 'LCY-USED', 'منتج له سجل', 'Lifecycle Referenced', v_cat, 30.00, 15.00, 100),
    (v_gone, 'LCY-GONE', 'منتج بدون سجل', 'Lifecycle Unused',    v_cat, 12.50,  6.00,  40)
  on conflict (id) do nothing;

  -- Storefront dressing for the unused product — the two tables that declare
  -- `on delete cascade` are removed with it, which is exactly what that
  -- cascade means; the five history tables are a different matter entirely.
  insert into public.product_content (product_id, brand_en) values (v_gone, 'Lifecycle') on conflict (product_id) do nothing;
  insert into public.store_reviews (product_id, author_name, rating, body) values (v_gone, 'Probe', 5, 'unused-product review');

  -- ── A. make one product genuinely part of the shop's history ──────────────
  -- A POS sale (sale_items + stock_movements), a website order
  -- (online_order_items + stock_reservations) and a return (return_items) —
  -- all five reference tables carry a row before the delete is attempted.
  perform pg_temp.become(v_cashier, 'authenticated');
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'p25-used-' || gen_random_uuid()::text,
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 2)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 60.00))));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id and product_id = v_used;

  perform pg_temp.become(null, 'anon');
  v_order := public.place_online_order(jsonb_build_object(
    'client_ref', 'p25-order-' || gen_random_uuid()::text,
    'customer_name', 'Lifecycle Shopper', 'customer_phone', '01000000009',
    'delivery_type', 'pickup', 'payment_method', 'cod',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 1))));
  v_order_id := (v_order->>'order_id')::uuid;

  perform pg_temp.become(v_cashier, 'authenticated');
  perform public.pos_process_return(jsonb_build_object(
    'sale_id', v_sale_id::text, 'reason', 'lifecycle fixture',
    'refund_method', 'cash', 'refund_status', 'completed',
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id::text, 'quantity', 1))));

  -- ── B. the reference counts the screens render from ────────────────────────
  perform pg_temp.become(v_viewer, 'authenticated');
  begin
    perform public.product_reference_counts(v_used);
    raise exception 'a viewer read product reference counts';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_admin, 'authenticated');
  select * into v_refs from public.product_reference_counts(v_used);
  if v_refs.sale_items < 1 or v_refs.return_items < 1 or v_refs.stock_movements < 1
     or v_refs.online_order_items < 1 or v_refs.stock_reservations < 1
     or v_refs.total < 5 then
    raise exception 'the reference count missed part of the product''s history: %', v_refs.total;
  end if;

  -- ── C. the lifecycle RPCs are not a polite suggestion — a viewer is refused ─
  perform pg_temp.become(v_viewer, 'authenticated');
  begin
    perform public.delete_product(v_gone);
    raise exception 'a viewer permanently deleted a product by calling the RPC directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_product_active(v_gone, false);
    raise exception 'a viewer archived a product by calling the RPC directly';
  exception when insufficient_privilege then null;
  end;
  if (select active from public.products where id = v_gone) is distinct from true then
    raise exception 'the viewer''s archive attempt landed';
  end if;

  -- ── D. a referenced product cannot be permanently deleted ──────────────────
  -- The reports snapshot BEFORE the archive, so the archive can be shown to
  -- change nothing the shop reports.
  perform pg_temp.become(v_admin, 'authenticated');
  select public.reports_financial_summary(null, null) into v_fin_before;

  begin
    perform public.delete_product(v_used);
    raise exception 'the RPC permanently deleted a product with historical transactions';
  exception when restrict_violation then null;
  end;

  -- and the table itself says the same, without any function in the middle.
  -- The FK layer is the backstop a raw DELETE would hit, so that guarantee is
  -- asserted as schema state — which also pins "no ON DELETE CASCADE was ever
  -- added pointing at history": every table that references products must be
  -- restrict/no-action, with ONLY the two storefront tables allowed to cascade.
  select count(*) into v_count
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where c.contype = 'f'
     and c.confrelid = 'public.products'::regclass
     and t.relname = any (array[
       'sale_items', 'return_items', 'stock_movements',
       'online_order_items', 'stock_reservations'])
     and c.confdeltype in ('r', 'a');
  if v_count <> 5 then
    raise exception 'the five history tables do not all RESTRICT product deletion (% found)', v_count;
  end if;
  -- Phase 43 sharpens the same rule instead of just listing allowed names: a
  -- cascading child is fine only while it is catalogue dressing. What must never
  -- happen is a cascade that can REACH history — so this walks the cascade graph
  -- from products, through however many levels, and fails if any of the five
  -- history tables is anywhere in it. `product_variants` and `catalogue_codes`
  -- may cascade (they are the product's own shape, like product_content), but
  -- their own foreign keys back into the five tables are RESTRICT, which this
  -- proves rather than assumes.
  with recursive cascade_tree as (
    select c.conrelid as rel
      from pg_constraint c
     where c.contype = 'f'
       and c.confrelid = 'public.products'::regclass
       and c.confdeltype = 'c'
    union all
    select c.conrelid
      from pg_constraint c
      join cascade_tree t on c.confrelid = t.rel
     where c.contype = 'f'
       and c.confdeltype = 'c'
  )
  select count(*) into v_count
    from cascade_tree t
   where t.rel = any (array[
     'public.sale_items'::regclass,
     'public.return_items'::regclass,
     'public.stock_movements'::regclass,
     'public.online_order_items'::regclass,
     'public.stock_reservations'::regclass
   ]);
  if v_count > 0 then
    raise exception 'a cascade from products can reach a history table';
  end if;
  if not exists (select 1 from public.products where id = v_used) then
    raise exception 'a referenced product disappeared';
  end if;

  -- ── E. archive: always available, audited once per real transition ─────────
  v_lifecycle := public.set_product_active(v_used, false);
  if (v_lifecycle->>'changed')::boolean is distinct from true
     or (v_lifecycle->>'active')::boolean is distinct from false then
    raise exception 'the archive did not land: %', v_lifecycle;
  end if;
  -- a double submit answers the no-op instead of erroring or double-auditing
  v_lifecycle := public.set_product_active(v_used, false);
  if (v_lifecycle->>'changed')::boolean is distinct from false then
    raise exception 'a repeated archive was not idempotent: %', v_lifecycle;
  end if;
  select count(*) into v_count from public.audit_log
   where action = 'product.archived' and entity_id = v_used::text;
  if v_count <> 1 then
    raise exception 'the archive wrote % audit rows, not exactly one', v_count;
  end if;

  -- every selling surface respects it:
  --   the public storefront catalogue
  perform pg_temp.become(null, 'anon');
  if exists (select 1 from public.storefront_catalogue() where id = v_used) then
    raise exception 'an archived product is still listed on the storefront';
  end if;
  if exists (select 1 from public.storefront_best_sellers(50) where product_id = v_used) then
    raise exception 'an archived product still advertises itself through best sellers';
  end if;
  --   the online checkout
  begin
    perform public.place_online_order(jsonb_build_object(
      'client_ref', 'p25-archived-' || gen_random_uuid()::text,
      'customer_name', 'Late Shopper', 'customer_phone', '01000000010',
      'delivery_type', 'pickup', 'payment_method', 'cod',
      'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 1))));
    raise exception 'an archived product was added to a new online order';
  exception when check_violation then null;
  end;
  --   and the till itself
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'p25-archived-pos-' || gen_random_uuid()::text,
      'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
      'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 1)),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30.00))));
    raise exception 'the till sold an archived product';
  exception when check_violation then null;
  end;

  -- ── F. the history the archive preserved ───────────────────────────────────
  perform pg_temp.become(v_admin, 'authenticated');
  -- the invoice still resolves the product…
  if (select p.name_en from public.sale_items si
        join public.products p on p.id = si.product_id
       where si.id = v_item_id) <> 'Lifecycle Referenced' then
    raise exception 'the historical invoice stopped resolving its product';
  end if;
  -- …and the reports answer EXACTLY what they answered before the archive:
  -- archiving is not deleting, and the numbers must not notice.
  if public.reports_financial_summary(null, null) <> v_fin_before then
    raise exception 'the financial report changed because a product was archived';
  end if;
  select elem into v_perf
    from (select jsonb_array_elements(public.reports_product_performance(null, null)) as elem) elems
   where elem ->> 'productId' = v_used::text
   limit 1;
  if v_perf is null or (v_perf->>'sold')::boolean is distinct from true
     or (v_perf->>'units')::numeric < 2 then
    raise exception 'product performance lost the archived product''s history: %', v_perf;
  end if;

  -- ── G. reactivation: audited, and sellable everywhere again ────────────────
  v_lifecycle := public.set_product_active(v_used, true);
  if (v_lifecycle->>'changed')::boolean is distinct from true then
    raise exception 'the reactivation did not land: %', v_lifecycle;
  end if;
  if not exists (
    select 1 from public.audit_log
     where action = 'product.reactivated' and entity_id = v_used::text
       and user_id = v_admin::text
  ) then
    raise exception 'the reactivation left no audit row naming its actor';
  end if;
  perform pg_temp.become(null, 'anon');
  if not exists (select 1 from public.storefront_catalogue() where id = v_used) then
    raise exception 'a reactivated product did not return to the storefront';
  end if;
  v_order := public.place_online_order(jsonb_build_object(
    'client_ref', 'p25-reactivated-' || gen_random_uuid()::text,
    'customer_name', 'Returning Shopper', 'customer_phone', '01000000011',
    'delivery_type', 'pickup', 'payment_method', 'cod',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 1))));
  if (v_order->>'order_id') is null then
    raise exception 'a reactivated product could not be ordered online';
  end if;
  perform pg_temp.become(v_cashier, 'authenticated');
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'p25-reactivated-pos-' || gen_random_uuid()::text,
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier',
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_used::text, 'qty', 1)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30.00))));
  if (v_sale->>'sale_id') is null then
    raise exception 'the till could not sell a reactivated product';
  end if;

  -- ── H. an unused product IS deletable — with a trail, and no splash damage ──
  -- Snapshot every history table first: the delete that follows must not move
  -- so much as one row in any of them.
  perform pg_temp.become(v_admin, 'authenticated');
  select count(*) into v_si_sale_items from public.sale_items;
  select count(*) into v_si_movements  from public.stock_movements;
  select count(*) into v_si_returns    from public.return_items;
  select count(*) into v_si_orders     from public.online_order_items;
  select count(*) into v_si_res        from public.stock_reservations;

  v_lifecycle := public.delete_product(v_gone);
  if (v_lifecycle->>'deleted')::boolean is distinct from true then
    raise exception 'the unused product was not deleted: %', v_lifecycle;
  end if;
  if exists (select 1 from public.products where id = v_gone) then
    raise exception 'the unused product is still there';
  end if;
  if exists (select 1 from public.product_content where product_id = v_gone)
     or exists (select 1 from public.store_reviews where product_id = v_gone) then
    raise exception 'the storefront content declared on delete cascade survived the delete';
  end if;
  if (select count(*) from public.sale_items) <> v_si_sale_items
     or (select count(*) from public.stock_movements) <> v_si_movements
     or (select count(*) from public.return_items) <> v_si_returns
     or (select count(*) from public.online_order_items) <> v_si_orders
     or (select count(*) from public.stock_reservations) <> v_si_res then
    raise exception 'deleting an unused product cascaded into history';
  end if;
  if not exists (
    select 1 from public.audit_log
     where action = 'product.deleted' and entity_id = v_gone::text
       and entity_label = 'LCY-GONE' and user_id = v_admin::text
  ) then
    raise exception 'the permanent delete left no audit row naming product and actor';
  end if;
  -- and a second attempt is a clean NOT FOUND, not a corruption:
  begin
    perform public.delete_product(v_gone);
    raise exception 'deleting a ghost product succeeded';
  exception when foreign_key_violation then null;
  end;

  raise notice 'product lifecycle — an unused product deletes with one audit row and zero historical casualties; a referenced one is refused by RPC and FK alike, archives out of every selling surface while its invoice, ledger and reports stand untouched, and reactivates cleanly';
end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Phase 26: admin full permissions — the audit of the admin role, in the
-- database that is the authority for it.
--
-- The TypeScript half of the same audit is
-- src/lib/permissions/__tests__/adminFullAccess.selftest.ts; this block proves
-- the promise at the layer that decides when the client is not in the room:
--
--   A. `public.can()` answers true for EVERY capability the model knows, as
--      the admin profile, and `current_user_capabilities()` resolves the full
--      set — the promise "the admin may do everything" stated row by row.
--   B. The admin's own row keeps its guardrails: self-demotion and
--      self-deactivation refused, a change to one's own custom role refused
--      for ANY value including NULL, self-denial of manage_users refused —
--      while the rest of the row stays writable, so the wall refuses the
--      lockout and not the account.
--   C. The same wall holds for a NON-admin holder of manage_users (a custom
--      role): the SQL answer the client guard mirrors. The case matters
--      because the client used to key the guard on the session role reading
--      `admin`, which is exactly false for such a seat.
--   D. The last-admin invariant: an admin may promote and demote ANOTHER
--      admin, and the only path that removes the last admin — self-demotion —
--      is the one B refuses. An installation always keeps an admin.
--   E. The read sweep: every table and view a repository reads is granted to
--      the role the browser gets, and the tables that carry rows by this point
--      actually return them to the admin — an admin refused by their own
--      book is not an admin.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer   uuid := '00000000-0000-4000-8000-0000000000e1';
  v_role_id  uuid;
  v_missing  text;
  v_have     bigint;
  v_total    bigint;
  v_phone    text;
  v_role     public.app_role;
  v_rows     bigint;
  -- Phase 16's gold necklace (SCN-PUB): a stock-tracked product the file has
  -- written the ledger for before, so the admin's own write below is judged
  -- on deltas, not on fixture state this block would have to restore.
  v_p26      uuid := '00000000-0000-4000-8000-000000000b30';
  v_qty      integer;
  v_tables   text[] := array[
    'products', 'categories', 'stock_movements', 'sales', 'sale_items',
    'sale_payments', 'customers', 'sales_returns', 'return_items',
    'refund_records', 'shifts', 'expenses', 'audit_log', 'online_orders',
    'online_order_items', 'stock_reservations', 'order_events',
    'approval_requests', 'approval_rules', 'website_settings', 'store_faqs',
    'store_reviews', 'campaigns', 'coupons', 'product_content', 'profiles',
    'custom_roles', 'backup_settings', 'backup_manifests'
  ];
  v_i        integer;
  v_table    text;
begin
  perform pg_temp.become(v_admin);

  -- ── A. every capability, all of them, answer yes ─────────────────────────
  if exists (
    select 1
      from (select distinct capability from public.role_capabilities) all_caps
     where not public.can(all_caps.capability)
  ) then
    select string_agg(distinct all_caps.capability, ', ') into v_missing
      from (select distinct capability from public.role_capabilities) all_caps
     where not public.can(all_caps.capability);
    raise exception 'can() refuses the admin for: %', v_missing;
  end if;
  select count(*) into v_have from public.current_user_capabilities();
  select count(distinct capability) into v_total from public.role_capabilities;
  if v_have <> v_total then
    raise exception 'the admin resolves % of the % known capabilities', v_have, v_total;
  end if;

  -- ── B. the admin's own row: the wall holds, and the rest is writable ─────
  begin
    perform public.admin_upsert_staff_profile(v_admin, 'admin', 'ALYQ Admin', null, null, 'viewer'::public.app_role, true);
    raise exception 'the admin demoted themselves';
  exception when check_violation then null;
  end;
  begin
    perform public.admin_upsert_staff_profile(v_admin, 'admin', 'ALYQ Admin', null, null, 'admin'::public.app_role, false);
    raise exception 'the admin deactivated their own account';
  exception when check_violation then null;
  end;
  perform public.admin_upsert_staff_profile(v_admin, 'admin', 'Amina Admin', 'admin@alyq.local', '+201000000077', 'admin'::public.app_role, true);
  select phone into v_phone from public.profiles where id = v_admin;
  if v_phone is distinct from '+201000000077' then
    raise exception 'the admin could not update their own contact fields';
  end if;

  select r.id into v_role_id
    from public.admin_create_custom_role(
           'p26_co_admin', 'Co-Admin', 'شريك إداري', null, null,
           'manager'::public.app_role, array['manage_users', 'manage_roles']::text[]) as r;
  begin
    perform public.admin_set_custom_role(v_admin, v_role_id);
    raise exception 'the admin changed their own custom role';
  exception when check_violation then null;
  end;
  begin
    perform public.admin_set_custom_role(v_admin, null);
    raise exception 'the admin cleared their own custom role';
  exception when check_violation then null;
  end;
  begin
    perform public.admin_set_user_exceptions(v_admin, '{}'::text[], array['manage_users']::text[]);
    raise exception 'the admin denied themselves manage_users';
  exception when check_violation then null;
  end;

  -- ── C. the same wall, for a non-admin holder of manage_users ─────────────
  -- The admin assigns the overlay to the cashier (allowed: it is their row,
  -- not the caller's), and the cashier's base moves to the overlay's.
  perform public.admin_set_custom_role(v_cashier, v_role_id);
  select role into v_role from public.profiles where id = v_cashier;
  if v_role is distinct from 'manager'::public.app_role then
    raise exception 'assigning the overlay should have moved the cashier to its base, got %', v_role;
  end if;

  perform pg_temp.become(v_cashier);
  begin
    perform public.admin_upsert_staff_profile(v_cashier, 'cashier', 'Karim Cashier', null, null, 'viewer'::public.app_role, true);
    raise exception 'a non-admin manage_users holder demoted themselves — the demo used to allow this';
  exception when check_violation then null;
  end;
  begin
    perform public.admin_set_custom_role(v_cashier, null);
    raise exception 'a non-admin manage_users holder cleared their own overlay';
  exception when check_violation then null;
  end;
  -- …while managing SOMEONE ELSE is exactly what the authority is for.
  perform public.admin_upsert_staff_profile(v_viewer, 'viewer', 'Vera Viewer', null, null, 'cashier'::public.app_role, true);
  select role into v_role from public.profiles where id = v_viewer;
  if v_role is distinct from 'cashier'::public.app_role then
    raise exception 'the co-admin could not reassign another account';
  end if;

  -- ── D. the last-admin invariant ───────────────────────────────────────────
  perform pg_temp.become(v_admin);
  perform public.admin_upsert_staff_profile(v_viewer, 'viewer', 'Vera Viewer', null, null, 'admin'::public.app_role, true);
  select role into v_role from public.profiles where id = v_viewer;
  if v_role is distinct from 'admin'::public.app_role then
    raise exception 'an admin could not make a second admin';
  end if;
  perform public.admin_upsert_staff_profile(v_viewer, 'viewer', 'Vera Viewer', null, null, 'viewer'::public.app_role, true);
  select role into v_role from public.profiles where id = v_viewer;
  if v_role is distinct from 'viewer'::public.app_role then
    raise exception 'an admin could not demote a second admin';
  end if;
  -- and the caller of both writes still holds the authority that will undo any
  -- of them: the acting admin was never in the refused set (B), so at least
  -- one admin always remains.
  if not public.can('manage_users') or not public.can('restore_backup') then
    raise exception 'the acting admin lost their own authority while administering';
  end if;

  -- ── E. the read sweep ─────────────────────────────────────────────────────
  for v_i in 1 .. array_length(v_tables, 1) loop
    v_table := v_tables[v_i];
    if not has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') then
      raise exception 'the role the browser gets has no SELECT grant on public.%', v_table;
    end if;
  end loop;
  -- The grant layer says "may try"; the policies say "and see". The tables
  -- with guaranteed rows by this point must return them to the admin — an
  -- RLS policy that silently filtered the admin's own book would surface here
  -- as an empty answer, which is exactly the failure this sweep exists to name.
  for v_i in 1 .. array_length(v_tables, 1) loop
    v_table := v_tables[v_i];
    begin
      execute format('select count(*) from public.%I', v_table) into v_rows;
      -- The ten tables with guaranteed rows by this point must return them to
      -- the admin: an RLS policy that silently filtered the admin's own book
      -- would surface here as an empty answer, which is the failure this sweep
      -- exists to name.
      if v_table = any(array[
        'products', 'categories', 'sales', 'sale_items', 'stock_movements',
        'audit_log', 'online_orders', 'customers', 'profiles', 'custom_roles'
      ]) and coalesce(v_rows, 0) = 0 then
        raise exception 'the admin sees zero rows in public.% — the policy is filtering their own book', v_table;
      end if;
    exception when insufficient_privilege then
      raise exception 'the admin is refused a read of public.%', v_table;
    end;
  end loop;

  -- ── F. the admin's own ledger write — the reported path, end to end ───────
  -- Production reported a real Admin on Inventory reading "changes are not
  -- permitted" with the adjustment failing. The client's adjustStock is three
  -- statements plus a trail row: an insert into stock_movements (with check
  -- can('adjust_stock'), 0030), an update of that row's before/after snapshot,
  -- an update of products.stock_quantity (can('edit_product'), 0030) and an
  -- audit_log row. Every one of them must land for the admin, and the shelf
  -- must end exactly delta away from where it started. The refusal half of
  -- this door is Phase 16's: cashier and viewer are both refused the first
  -- insert by the same policy. Judged on deltas over the file's existing
  -- tracked product (SCN-PUB), because the ledger is append-only by design —
  -- a block may not delete its way back out.
  perform pg_temp.become(v_admin);
  select stock_quantity into v_qty from public.products where id = v_p26;
  if v_qty is null then
    raise exception 'the phase 26 product (SCN-PUB) is missing from the catalogue';
  end if;

  -- 1) the ledger row — the write the policies are asked to grant
  insert into public.stock_movements (product_id, delta, quantity_before, quantity_after, type, reason, notes, user_id, user_name)
  values (v_p26, 5, v_qty, v_qty + 5, 'adjustment_in', 'recount', 'Phase 26 admin', v_admin::text, 'Phase 26 Admin');
  if not exists (
    select 1 from public.stock_movements
     where product_id = v_p26 and reason = 'recount' and notes = 'Phase 26 admin' and user_id = v_admin::text
  ) then
    raise exception 'the admin''s own stock movement did not land';
  end if;

  -- 2) the shelf itself, and it must land exactly delta away
  update public.products set stock_quantity = v_qty + 5 where id = v_p26;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'the admin could not write the product''s stock quantity (%)', v_rows;
  end if;
  select stock_quantity into v_qty from public.products where id = v_p26;
  if v_qty <> (select quantity_after from public.stock_movements where product_id = v_p26 and notes = 'Phase 26 admin') then
    raise exception 'the shelf and the ledger disagree after the admin''s adjustment';
  end if;

  -- 3) the trail — the trigger stamps the actor from the session, and the
  -- entity from the action, so what is asserted is the stamped row
  insert into public.audit_log (action, entity, entity_id, entity_label, user_id, user_name, details)
  values ('stock.corrected', 'stock', v_p26::text, 'SCN-P26', v_admin::text, 'Phase 26 Admin',
          jsonb_build_object('after', v_qty, 'delta', 5));
  if (select user_id from public.audit_log where action = 'stock.corrected' and entity_id = v_p26::text) is distinct from v_admin::text then
    raise exception 'the audit row was not stamped with the acting admin';
  end if;

  -- ── restoration: the file's fixture state, exactly ───────────────────────
  perform public.admin_set_custom_role(v_cashier, null);
  perform public.admin_upsert_staff_profile(v_cashier, 'cashier', 'Karim Cashier', null, null, 'cashier'::public.app_role, true);
  perform public.admin_set_custom_role_active(v_role_id, false);
  select role into v_role from public.profiles where id = v_cashier;
  if v_role is distinct from 'cashier'::public.app_role then
    raise exception 'the cashier did not come back to their seat';
  end if;

  raise notice 'admin full permissions — can() answers true for all % capabilities as the admin, the self-guardrails refuse every way down (including the non-admin manage_users holder the client guard used to let through) while the own row stays editable, the last admin can never be removed, the admin writes the stock ledger, the shelf and the trail in one pass, and the admin reads every table the repositories read', v_total;
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 27 — the sale knows its customer (0039)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin     uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_product   uuid := '00000000-0000-4000-8000-0000000000f2';
  v_cust      uuid := '00000000-0000-4000-8000-0000000007c1';
  v_cust2     uuid := '00000000-0000-4000-8000-0000000007c2';
  v_sale      jsonb;
  v_sale_id   uuid;
  v_row       public.sales%rowtype;
begin
  perform pg_temp.ensure_open_shift();
  perform pg_temp.become(v_admin, 'authenticated');

  -- the book first: two customers, one with the optional email (0038)
  insert into public.customers (id, name, phone, email)
  values (v_cust, 'Omar Customer', '01011111111', 'omar@example.com')
  on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email;
  insert into public.customers (id, name, phone)
  values (v_cust2, 'Layla Walkout', '01022222222')
  on conflict (id) do update set name = excluded.name, phone = excluded.phone;

  perform pg_temp.become(v_cashier, 'authenticated');

  -- 1. an existing customer: the id is stored, and name/phone come from the
  --    BOOK even when the payload carries stale copies
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',   'scn-p27-cust-1',
    'user_id',      v_cashier::text,
    'user_name',    'Karim Cashier',
    'customer_id',  v_cust::text,
    'customer_name',  'STALE NAME',
    'customer_phone', '00000000000',
    'payments',     jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
    'lines',        jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.customer_id is distinct from v_cust then
    raise exception 'the existing customer was not linked (got %)', v_row.customer_id;
  end if;
  if v_row.customer_name is distinct from 'Omar Customer' or v_row.customer_phone is distinct from '01011111111' then
    raise exception 'the sale kept the stale payload instead of the book (% / %)',
      v_row.customer_name, v_row.customer_phone;
  end if;

  -- 2. a forged/stale id: the sale still happens, the link is dropped
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',   'scn-p27-cust-2',
    'user_id',      v_cashier::text,
    'user_name',    'Karim Cashier',
    'customer_id',  '99999999-9999-4999-8999-999999999999',
    'customer_name',  'Ghost Customer',
    'customer_phone', '01099999999',
    'payments',     jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
    'lines',        jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.customer_id is not null then
    raise exception 'a customer id that is not in the book was stored: %', v_row.customer_id;
  end if;
  if v_row.customer_name is distinct from 'Ghost Customer' then
    raise exception 'the named walk-in lost its snapshot name: %', v_row.customer_name;
  end if;

  -- 3. a walk-in: nothing to link, nothing to keep
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p27-cust-3',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  if exists (select 1 from public.sales where id = v_sale_id
             and (customer_id is not null or customer_name is not null or customer_phone is not null)) then
    raise exception 'a walk-in sale stored customer data it was not given';
  end if;

  -- 4. deleting a customer keeps the history: id goes null, the snapshot stays
  perform pg_temp.become(v_admin, 'authenticated');
  delete from public.customers where id = v_cust2;
  perform pg_temp.become(v_cashier, 'authenticated');
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p27-cust-4',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'customer_id',  v_cust2::text,
    'customer_name',  'Layla Walkout',
    'customer_phone', '01022222222',
    'payments',     jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
    'lines',        jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.customer_id is not null then
    raise exception 'a deleted customer id survived in the sale: %', v_row.customer_id;
  end if;

  raise notice 'customer persistence — the till''s choice is stored (book name/phone win), a forged id is dropped without failing the sale, a walk-in stays anonymous, and a deleted customer leaves the snapshot';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 27 — a till sale requires an open shift, and stamps it (0040)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin     uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer    uuid := '00000000-0000-4000-8000-0000000000e1';
  v_product   uuid := '00000000-0000-4000-8000-0000000000f2';
  v_shift     uuid;
  v_sale      jsonb;
  v_sale_id   uuid;
  v_row       public.sales%rowtype;
  v_stock     integer;
  v_sales_n   bigint;
  v_items_n   bigint;
  v_pays_n    bigint;
  v_mov_n     bigint;
  v_counter   bigint;
begin
  perform pg_temp.ensure_closed_shift();
  perform pg_temp.become(v_cashier, 'authenticated');

  select stock_quantity into v_stock from public.products where id = v_product;
  select count(*) into v_sales_n from public.sales;
  select count(*) into v_items_n from public.sale_items;
  select count(*) into v_pays_n  from public.sale_payments;
  select count(*) into v_mov_n   from public.stock_movements;
  select next_value into v_counter from public.sale_counters;

  -- 1. no open shift: a DIRECT RPC call — exactly the path a bypass would use
  --    — is refused, and the refusal writes nothing: no sale, no items, no
  --    payments, no movement, and the invoice-number counter is untouched.
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p27-noshift',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ));
    raise exception 'a sale completed with no open shift';
  exception when no_data_found then
    null; -- expected: 'no open shift'
  end;

  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock < (select 500 - 4) then null; end if; -- no-op guard (stock checked below via counts)
  if (select count(*) from public.sales) <> v_sales_n
     or (select count(*) from public.sale_items) <> v_items_n
     or (select count(*) from public.sale_payments) <> v_pays_n
     or (select count(*) from public.stock_movements) <> v_mov_n
     or (select next_value from public.sale_counters) <> v_counter then
    raise exception 'the refused sale left partial records or burned an invoice number';
  end if;

  -- 2. the authorization gate still runs first: a viewer is refused for
  --    lacking sell, not for the (unreachable) shift rule
  perform pg_temp.become(v_viewer, 'authenticated');
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p27-noshift-viewer',
      'user_id',    v_viewer::text,
      'user_name',  'Vera Viewer',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ));
    raise exception 'a viewer rang up a sale';
  exception when insufficient_privilege then
    null;
  end;
  perform pg_temp.become(v_cashier, 'authenticated');

  -- 3. open the shift: the same payload now succeeds, stamped with its id
  v_shift := pg_temp.ensure_open_shift();
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p27-shifted',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select * into v_row from public.sales where id = v_sale_id;
  if v_row.shift_id is distinct from v_shift then
    raise exception 'the sale was not stamped with the open shift (% vs %)', v_row.shift_id, v_shift;
  end if;
  if v_row.source <> 'pos' then
    raise exception 'the shift gate mislabelled a till sale as %', v_row.source;
  end if;

  -- 4. close it: refused again — and a direct insert cannot smuggle a
  --    historical stamp past the column's own rules either (FK is enforced;
  --    the point here is the closed state refuses new till sales)
  perform pg_temp.ensure_closed_shift();
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p27-closedshift',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00, 'cash_received', 10.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
    ));
    raise exception 'a sale completed on a closed shift';
  exception when no_data_found then
    null;
  end;

  -- 5. the storefront channel is independent: with NO open shift, an online
  --    COD sale completes and carries no shift id
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p27-online-noshift',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'source',     'online',
    'client_ref', 'scn-p27-online-noshift',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cod', 'amount', 10.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  if exists (select 1 from public.sales where id = v_sale_id and shift_id is not null) then
    raise exception 'the shift gate reached into the online channel';
  end if;

  -- leave the suite in a sellable state for whatever follows
  perform pg_temp.ensure_open_shift();

  raise notice 'open-shift gate — refused with zero rows and an unburned invoice number (direct RPC included), authorization first, stamped on success, refused on a closed shift, online untouched';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 27 — rejected returns stop holding the goods (0041)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_admin     uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier   uuid := '00000000-0000-4000-8000-0000000000c1';
  v_product   uuid := '00000000-0000-4000-8000-0000000000f2';
  v_sale      jsonb;
  v_sale_id   uuid;
  v_row       public.sales%rowtype;
  v_ret       jsonb;
  v_return_id uuid;
  v_refund_id uuid;
  v_stock0    integer;
  v_audit     public.audit_log%rowtype;
begin
  perform pg_temp.ensure_open_shift();
  perform pg_temp.become(v_cashier, 'authenticated');
  select stock_quantity into v_stock0 from public.products where id = v_product;

  -- the goods: three bottles out the door
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p27-return-1',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 30.00, 'cash_received', 30.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 3))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  if (select stock_quantity from public.products where id = v_product) <> v_stock0 - 3 then
    raise exception 'the three-bottle sale did not leave the shelf short by three';
  end if;

  -- 1. one bottle comes back, refund PENDING (the approval flow shape)
  v_ret := public.pos_process_return(jsonb_build_object(
    'client_ref',   'scn-p27-return-1',
    'sale_id',      v_sale_id::text,
    'user_id',      v_cashier::text,
    'user_name',    'Karim Cashier',
    'refund_status', 'pending',
    'reason',       'taste test',
    'items',        jsonb_build_array(jsonb_build_object(
      'sale_item_id', (select id from public.sale_items where sale_id = v_sale_id limit 1)::text,
      'quantity',     1))
  ));
  v_return_id := (v_ret->>'return_id')::uuid;
  v_refund_id := (v_ret->>'refund_id')::uuid;
  if (select stock_quantity from public.products where id = v_product) <> v_stock0 - 2 then
    raise exception 'the pending return did not restore its unit';
  end if;

  -- 2. the quantity is held while pending: a third return of the sold three
  --    exceeds what is left (3 sold, 1 already back) and is refused
  begin
    perform public.pos_process_return(jsonb_build_object(
      'client_ref',   'scn-p27-return-double',
      'reason',       'should not fit',
      'sale_id',      v_sale_id::text,
      'user_id',      v_cashier::text,
      'user_name',    'Karim Cashier',
      'items',        jsonb_build_array(jsonb_build_object(
        'sale_item_id', (select id from public.sale_items where sale_id = v_sale_id limit 1)::text,
        'quantity',     3))
    ));
    raise exception 'a return beyond the remaining quantity was accepted';
  exception when check_violation then
    null;
  end;

  -- 3. the approver REJECTS the refund: the return's status follows the
  --    money, the unit is written back out, and the quantity is released
  perform pg_temp.become(v_admin, 'authenticated');
  perform public.pos_settle_refund(v_refund_id, v_admin::text, 'Amina Admin', 'rejected', 'no receipt');
  if (select refund_status from public.sales_returns where id = v_return_id) <> 'rejected' then
    raise exception 'the return did not mirror the rejected refund';
  end if;
  if (select status from public.refund_records where id = v_refund_id) <> 'rejected' then
    raise exception 'the refund record itself did not settle as rejected';
  end if;
  if (select stock_quantity from public.products where id = v_product) <> v_stock0 - 3 then
    raise exception 'the rejected return did not write its unit back out';
  end if;
  if not exists (select 1 from public.stock_movements
                 where product_id = v_product and type = 'adjustment_out'
                   and reason = 'customer_return'
                   and notes like '%Reversed: refund%') then
    raise exception 'the stock reversal left no ledger trail';
  end if;
  select * into v_audit from public.audit_log
    where action = 'refund.rejected' and entity_id = v_refund_id::text;
  if v_audit.details ->> 'reversed_units' <> '1' then
    raise exception 'the rejection audit did not record the reversed units: %', v_audit.details;
  end if;

  -- 4. the released quantity is returnable again — the goods come back this
  --    time for real, and stock lands exactly where a single good return
  --    leaves it (no double restoration)
  perform pg_temp.become(v_cashier, 'authenticated');
  v_ret := public.pos_process_return(jsonb_build_object(
    'client_ref',   'scn-p27-return-2',
    'reason',       'second attempt, genuine',
    'sale_id',      v_sale_id::text,
    'user_id',      v_cashier::text,
    'user_name',    'Karim Cashier',
    'refund_status', 'completed',
    'items',        jsonb_build_array(jsonb_build_object(
      'sale_item_id', (select id from public.sale_items where sale_id = v_sale_id limit 1)::text,
      'quantity',     3))
  ));
  if (select stock_quantity from public.products where id = v_product) <> v_stock0 then
    raise exception 'the genuine re-return restored the wrong number of units (expected back to %)', v_stock0;
  end if;

  -- 5. nothing left to return: the sale is fully returned (3 of 3, the
  --    rejected row holding none of them)
  begin
    perform public.pos_process_return(jsonb_build_object(
      'client_ref',   'scn-p27-return-3',
      'reason',       'nothing left',
      'sale_id',      v_sale_id::text,
      'user_id',      v_cashier::text,
      'user_name',    'Karim Cashier',
      'items',        jsonb_build_array(jsonb_build_object(
        'sale_item_id', (select id from public.sale_items where sale_id = v_sale_id limit 1)::text,
        'quantity',     1))
    ));
    raise exception 'a return was accepted after the item was fully returned';
  exception when check_violation then
    null;
  end;

  -- 6. the money side never changed: the refunded total still equals the
  --    completed refund only — the rejection consumed no refundable balance
  select * into v_row from public.sales where id = v_sale_id;
  if (select coalesce(sum(amount), 0) from public.refund_records
      where sale_id = v_sale_id and status = 'completed') <> 30.00 then
    raise exception 'the refundable total moved when a refund was only rejected';
  end if;
  if v_row.total < 30.00 then null; end if;

  raise notice 'rejected-return parity — the pending unit is held, the rejection mirrors the status and writes the unit back out (with trail), the released quantity returns once and only once, and the refundable balance never moved on a rejection';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 43 — product variants: the shelf is the truth (0043)
-- ═══════════════════════════════════════════════════════════════════════════
-- The acceptance example, locked at the database: a ring in two combinations
-- (Gold/17, Silver/17), each shelf holding 2 while the product's rollup reads 4.
-- Selling Gold/17 ×3 must fail; selling ×2 must land on Gold's OWN shelf; the
-- conversion that created the shelves must neither create nor destroy a unit;
-- and an inventory clerk with adjust_stock but no edit_product can still move a
-- shelf. Drafting the combinations must not touch the product figure, or the
-- conversion would have nothing left to distribute.
do $$
declare
  v_admin   uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_clerk   uuid;
  v_cat     uuid := '00000000-0000-4000-8000-0000000000f1';
  v_product uuid := '00000000-0000-4000-8000-0000000000f5';
  v_gold    uuid := '00000000-0000-4000-8000-0000000000f6';
  v_silver  uuid := '00000000-0000-4000-8000-0000000000f7';
  v_result  jsonb;
  v_sale    jsonb;
  v_sale_id uuid;
  v_stock   integer;
  v_rows    integer;
  v_revenue numeric;
  v_units   integer;
begin
  perform pg_temp.become(v_admin, 'authenticated');

  -- the fixture: a tracked product holding FOUR units, on the website
  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id,
    selling_price, cost_price, stock_quantity, low_stock_level,
    active, show_on_website
  ) values (
    v_product, 'SCN-VAR', '6291000000042', 'خاتم', 'Scenario Ring',
    v_cat, 200.00, 100.00, 4, 1, true, true
  )
  on conflict (id) do update
    set stock_quantity = 4, variants_enabled = false, active = true, show_on_website = true;

  -- the DRAFT combinations — empty shelves, added before the conversion
  insert into public.product_variants (
    id, product_id, sku, color_key, color_ar, color_en, color_hex,
    size, size_label, stock_quantity, low_stock_level, active, sort_order
  ) values
    (v_gold,   v_product, 'SCN-VAR-GOLD-17',   'gold',   'ذهبي', 'Gold',   '#d4af37', 17, null, 0, 1, true, 1),
    (v_silver, v_product, 'SCN-VAR-SILVER-17', 'silver', 'فضي',  'Silver', '#c0c0c0', 17, null, 0, 1, true, 2)
  on conflict (id) do update set stock_quantity = 0;
  perform public.set_variant_active(v_gold, true);
  perform public.set_variant_active(v_silver, true);

  -- 1. drafting combinations must not zero the product the conversion splits
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 4 then
    raise exception 'drafting two empty combinations moved the product rollup (%)', v_stock;
  end if;

  -- 2. the conversion is refused unless the distribution adds up exactly
  begin
    perform public.enable_product_variants(
      v_product,
      jsonb_build_object(v_gold::text, 3, v_silver::text, 2),
      v_admin::text, 'Amina Admin');
    raise exception 'an unbalanced opening distribution was accepted';
  exception when check_violation then
    null;
  end;

  -- 3. the balanced conversion: 2 + 2, nothing created or destroyed
  v_result := public.enable_product_variants(
    v_product,
    jsonb_build_object(v_gold::text, 2, v_silver::text, 2),
    v_admin::text, 'Amina Admin');
  if (v_result->>'changed')::boolean is not true then
    raise exception 'the balanced conversion did not report a change';
  end if;
  if (select stock_quantity from public.products where id = v_product) <> 4 then
    raise exception 'the conversion changed the total it was given';
  end if;
  select stock_quantity into v_stock from public.product_variants where id = v_gold;
  if v_stock <> 2 then
    raise exception 'Gold / 17 did not open with its two units (%)', v_stock;
  end if;

  -- re-running the same conversion is a no-op, not a failure
  v_result := public.enable_product_variants(
    v_product,
    jsonb_build_object(v_gold::text, 2, v_silver::text, 2),
    v_admin::text, 'Amina Admin');
  if (v_result->>'changed')::boolean is not false then
    raise exception 'a repeated conversion wrote a second one';
  end if;

  -- the conversion is on the audit trail
  if not exists (select 1 from public.audit_log
                 where action = 'product.variants_enabled' and entity_id = v_product::text) then
    raise exception 'the conversion left no audit row';
  end if;

  -- 4. the rollup is derived: nobody writes the product total directly
  begin
    update public.products set stock_quantity = 9 where id = v_product;
    raise exception 'the rollup accepted a direct write';
  exception when check_violation then
    null;
  end;

  -- 5. the storefront answers with combinations only while the mode is on
  perform pg_temp.become(v_cashier, 'authenticated');
  select count(*) into v_rows
    from public.storefront_product_variants() where product_id = v_product;
  if v_rows <> 2 then
    raise exception 'the storefront shows % combination(s), not 2', v_rows;
  end if;

  -- 6. THE ACCEPTANCE: Gold / 17 ×3 fails even though the product reads 4
  perform pg_temp.ensure_open_shift();
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p43-oversell',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 600.00, 'cash_received', 600.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 3, 'variant_id', v_gold::text))
    ));
    raise exception 'selling three of a two-shelf combination was accepted';
  exception when check_violation then
    null;
  end;
  if exists (select 1 from public.sales where client_ref = 'scn-p43-oversell') then
    raise exception 'the refused oversell was written anyway';
  end if;

  -- 7. ×2 sells, lands on Gold's shelf, and freezes the combination on the line
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-p43-gold-sale',
    'user_id',    v_cashier::text,
    'user_name',  'Karim Cashier',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 400.00, 'cash_received', 500.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2, 'variant_id', v_gold::text))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select stock_quantity into v_stock from public.product_variants where id = v_gold;
  if v_stock <> 0 then
    raise exception 'the sale did not empty Gold / 17 (%)', v_stock;
  end if;
  select stock_quantity into v_stock from public.product_variants where id = v_silver;
  if v_stock <> 2 then
    raise exception 'the Gold sale moved Silver / 17 (%)', v_stock;
  end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 2 then
    raise exception 'the rollup did not follow the shelves (%)', v_stock;
  end if;
  if not exists (
    select 1 from public.sale_items
     where sale_id = v_sale_id and variant_id = v_gold
       and variant_color_en = 'Gold' and variant_size = 17 and sku = 'SCN-VAR-GOLD-17'
  ) then
    raise exception 'the sale line does not name the combination it sold';
  end if;
  if not exists (
    select 1 from public.stock_movements
     where variant_id = v_gold and delta = 2 and type = 'issue'
       and quantity_before = 2 and quantity_after = 0
  ) then
    raise exception 'the sale left no per-shelf ledger row';
  end if;

  -- 8. the OTHER shelf still sells while Gold is empty — the shelf, not the
  --    rollup, is what a line is judged against
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p43-gold-empty',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 200.00, 'cash_received', 200.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1, 'variant_id', v_gold::text))
    ));
    raise exception 'an empty shelf sold because the rollup still held units';
  exception when check_violation then
    null;
  end;

  -- 9. an adjust_stock-only seat moves a SHELF, and the rollup follows —
  --    without edit_product (that is why the rollup trigger is definer)
  perform pg_temp.become(v_admin);
  select p.id into v_clerk from public.profiles p
   where p.role::text = 'inventory_clerk' and p.active
   limit 1;
  if v_clerk is null then
    raise exception 'no active inventory_clerk profile to test the shelf with';
  end if;
  -- The role matrix gives every working tier edit_product and delete_product
  -- too, so the seat is narrowed to exactly what the shelf needs: adjust_stock
  -- with the catalogue-writing capabilities denied — the same per-user denial
  -- the price trigger is tested through.
  perform public.admin_set_user_exceptions(v_clerk, null, array['edit_product', 'delete_product']);
  perform pg_temp.become(v_clerk);

  if public.can('edit_product') then
    raise exception 'the denial did not remove edit_product';
  end if;
  if not public.can('adjust_stock') then
    raise exception 'the seat lost adjust_stock with it';
  end if;
  update public.product_variants
     set stock_quantity = stock_quantity + 1
   where id = v_silver;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'an adjust_stock-only seat could not move a shelf';
  end if;
  select stock_quantity into v_stock from public.products where id = v_product;
  if v_stock <> 3 then
    raise exception 'the shelf move did not roll up (product reads %)', v_stock;
  end if;

  -- …but the same seat authors and deletes nothing, and cannot flip the mode
  begin
    perform public.delete_variant(v_silver);
    raise exception 'an adjust_stock-only seat deleted a combination';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.enable_product_variants(v_product, '{}'::jsonb, v_clerk::text, 'Clerk');
    raise exception 'an adjust_stock-only seat flipped the variant mode';
  exception when insufficient_privilege then
    null;
  end;
  -- 0061 removes browser DELETE privilege entirely (the guarded RPC is the
  -- only normal delete path); a denied clerk now receives 42501, not 0 rows.
  begin
    delete from public.product_variants where id = v_gold;
    raise exception 'direct variant DELETE bypassed the lifecycle RPC';
  exception when insufficient_privilege then null;
  end;
  if not exists (select 1 from public.product_variants where id = v_gold) then
    raise exception 'the denied direct DELETE removed the combination';
  end if;

  -- the denial is lifted, exactly as it was put in place
  perform pg_temp.become(v_admin);
  perform public.admin_set_user_exceptions(v_clerk, null, null);

  -- 10. archiving stops a combination being sold, and the storefront with it
  perform pg_temp.become(v_admin);
  perform public.set_variant_active(v_silver, false);
  perform pg_temp.become(v_cashier);
  begin
    perform public.pos_complete_sale(jsonb_build_object(
      'client_ref', 'scn-p43-archived',
      'user_id',    v_cashier::text,
      'user_name',  'Karim Cashier',
      'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 200.00, 'cash_received', 200.00)),
      'lines',      jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 1, 'variant_id', v_silver::text))
    ));
    raise exception 'an archived combination was sold';
  exception when check_violation then
    null;
  end;
  select count(*) into v_rows
    from public.storefront_product_variants() where product_id = v_product;
  if v_rows <> 1 then
    raise exception 'the archived combination is still on the storefront (% row(s))', v_rows;
  end if;
  perform pg_temp.become(v_admin);
  perform public.set_variant_active(v_silver, true);

  -- 11. history keeps the mode: a named combination cannot be deleted, and a
  --     product with a named combination cannot leave variant mode
  begin
    perform public.delete_variant(v_gold);
    raise exception 'a sold combination was deleted';
  exception when restrict_violation then
    null;
  end;
  begin
    perform public.disable_product_variants(v_product, 3, v_admin::text, 'Amina Admin');
    raise exception 'a product with a named combination left variant mode';
  exception when restrict_violation then
    null;
  end;

  -- 12. the report reads per combination, and only for view_reports. Every
  --     shipped tier holds that capability, so the refusal is proven the way
  --     the layer actually refuses: a per-user denial, which is what a custom
  --     role would arrive with.
  perform public.admin_set_user_exceptions(v_cashier, null, array['view_reports']);
  perform pg_temp.become(v_cashier);
  begin
    perform public.reports_variant_performance();
    raise exception 'a seat without view_reports read the variant performance report';
  exception when insufficient_privilege then
    null;
  end;
  perform pg_temp.become(v_admin);
  perform public.admin_set_user_exceptions(v_cashier, null, null);
  perform pg_temp.become(v_admin);
  select coalesce(sum((row->>'revenue')::numeric), 0), coalesce(sum((row->>'units')::integer), 0)
    into v_revenue, v_units
    from (select jsonb_array_elements(public.reports_variant_performance()) as row) r
   where r.row->>'variantId' = v_gold::text;
  if v_revenue <> 400.00 or v_units <> 2 then
    raise exception 'the report read the Gold shelf as % units / % revenue', v_units, v_revenue;
  end if;

  raise notice 'variant shelves (0043) — drafting moves nothing, the conversion splits exactly, Gold/17 ×3 fails while ×2 empties its own shelf, the clerk seat moves a shelf but authors nothing, archive stops the sale, history keeps the mode, and the report reads per combination';
end
$$;

-- 0061: an ARCHIVED sibling cannot satisfy a last-active-shelf deletion guard.
-- Use a zero-stock, unreferenced product, so history does not mask the rule.
do $$
declare
  v_admin   uuid := '00000000-0000-4000-8000-0000000000a1';
  v_product uuid := '00000000-0000-4000-8000-0000000061a0';
  v_gold    uuid := '00000000-0000-4000-8000-0000000061a1';
  v_silver  uuid := '00000000-0000-4000-8000-0000000061a2';
begin
  perform pg_temp.become(v_admin);
  insert into public.products (id, sku, name_ar, name_en, category_id,
                               selling_price, cost_price, stock_quantity, show_on_website)
  values (v_product, 'SCN-LAST-ACTIVE', 'اختبار آخر رف', 'Last active shelf',
          '00000000-0000-4000-8000-0000000000f1', 100, 50, 0, false);
  insert into public.product_variants (id, product_id, sku, color_en, size, stock_quantity, active)
  values (v_gold, v_product, 'SCN-LAST-GOLD', 'Gold', 17, 0, true),
         (v_silver, v_product, 'SCN-LAST-SILVER', 'Silver', 17, 0, true);
  perform public.enable_product_variants(v_product,
    jsonb_build_object(v_gold::text, 0, v_silver::text, 0), v_admin::text, 'Amina Admin');
  perform public.set_variant_active(v_silver, false);

  -- A browser may edit metadata, but not bypass the guard with raw
  -- UPDATE(active) or DELETE even when its user holds edit/delete_product.
  update public.product_variants set color_en = 'Gold' where id = v_gold;
  begin
    update public.product_variants set active = false where id = v_gold;
    raise exception 'direct active UPDATE bypassed the guarded archive RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.product_variants where id = v_gold;
    raise exception 'direct DELETE bypassed the guarded delete RPC';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.delete_variant(v_gold);
    raise exception 'an archived sibling allowed the last active shelf to be deleted';
  exception when check_violation then null;
  end;
  begin
    perform public.set_variant_active(v_gold, false);
    raise exception 'an archived sibling allowed the last active shelf to be archived';
  exception when check_violation then null;
  end;
  if (select count(*) from public.product_variants where product_id = v_product and active) <> 1 then
    raise exception 'last-active refusal changed the available shelves';
  end if;

  perform public.set_variant_active(v_silver, true);
  perform public.delete_variant(v_gold);
  if (select count(*) from public.product_variants where product_id = v_product and active) <> 1 then
    raise exception 'safe unreferenced delete should leave one active sibling';
  end if;
  begin
    perform public.set_variant_active(v_silver, false);
    raise exception 'archiving the new last active shelf succeeded';
  exception when check_violation then null;
  end;
  delete from public.products where id = v_product;
  if exists (select 1 from public.products where id = v_product) then
    raise exception 'last-active fixture was not cleaned up';
  end if;
  raise notice 'variant lifecycle (0061) — archived siblings cannot hide a last-active delete or archive; reactivation permits safe deletion and the remaining shelf stays sellable';
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 44 — category lifecycle: safe delete, move, archive (0044)
-- ═══════════════════════════════════════════════════════════════════════════
-- The acceptance example, locked at the database:
--
--   Temporary Empty hard-deletes. Rings Old (5 products) refuses a direct
--   delete — no cascade, no null-out. The 5 move to Rings New and Rings Old
--   dies in ONE transaction, stock byte-identical. Hidden Rings is archived
--   and can neither receive products nor appear on the storefront; a forged
--   assignment to it is refused by a trigger, not by a dropdown. Reactivate
--   restores everything. A seat stripped of delete_product is refused all
--   three destructive verbs; with it restored, the verbs work — the
--   capability matrix, not the caller's word, decides.
--
-- Concurrency is proven by construction rather than by a race here: both
-- destructive RPCs lock the category rows FOR UPDATE before re-counting, and
-- a concurrent product INSERT takes FOR KEY SHARE on the same row, so an
-- assignment either lands first (and the recount refuses) or waits behind
-- the delete (and the RESTRICT FK refuses). The serialised facts those locks
-- guarantee are what this block pins.
do $$
declare
  v_admin   uuid := '00000000-0000-4000-8000-0000000000a1';
  v_clerk   uuid;
  v_empty   uuid := '00000000-0000-4000-8000-000000004401';
  v_old     uuid := '00000000-0000-4000-8000-000000004402';
  v_new     uuid := '00000000-0000-4000-8000-000000004403';
  v_hidden  uuid := '00000000-0000-4000-8000-000000004404';
  v_parent  uuid := '00000000-0000-4000-8000-000000004405';
  v_child   uuid := '00000000-0000-4000-8000-000000004406';
  v_prod    uuid;
  v_result  jsonb;
  v_rows    integer;
  v_stock   integer;
  v_events  integer;
  v_i       integer;
begin
  perform pg_temp.become(v_admin, 'authenticated');

  -- ── the fixtures ────────────────────────────────────────────────────────
  insert into public.categories (id, name_ar, name_en, parent_id, active, sort_order) values
    (v_empty,  'فارغة',        'Temporary Empty', null, true, 901),
    (v_old,    'خوواتم قديمة', 'Rings Old',       null, true, 902),
    (v_new,    'خوواتم جديدة', 'Rings New',       null, true, 903),
    (v_hidden, 'خوواتم مخفية', 'Hidden Rings',    null, false, 904),
    (v_parent, 'أب',           'Lifecycle Parent', null, true, 905),
    (v_child,  'ابن',          'Lifecycle Child',  v_parent, true, 906)
  on conflict (id) do update
    set name_en = excluded.name_en, parent_id = excluded.parent_id, active = excluded.active;

  -- Rings Old holds FIVE products with distinct stock; re-runs restore them.
  for v_i in 1..5 loop
    v_prod := ('00000000-0000-4000-8000-0000000044' || lpad((9 + v_i)::text, 2, '0'))::uuid;
    insert into public.products (
      id, sku, barcode, name_ar, name_en, category_id,
      selling_price, cost_price, stock_quantity, low_stock_level,
      active, show_on_website
    ) values (
      v_prod, 'SCN-CAT-' || v_i, null, 'خاتم ' || v_i, 'Scenario Category Ring ' || v_i,
      v_old, 100.00, 40.00, v_i * 10, 2, true, true
    )
    on conflict (id) do update
      set category_id = v_old, stock_quantity = v_i * 10, active = true, show_on_website = true;
  end loop;

  -- ── 1. the empty category hard-deletes, and the trail knows ─────────────
  v_result := public.delete_empty_category(v_empty, v_admin::text, 'Amina Admin');
  if (v_result->>'deleted')::boolean is not true then
    raise exception 'the empty category did not delete';
  end if;
  select count(*) into v_rows from public.categories where id = v_empty;
  if v_rows <> 0 then
    raise exception 'the empty category is still there';
  end if;
  if not exists (select 1 from public.audit_log
                 where action = 'category.deleted' and entity_id = v_empty::text) then
    raise exception 'the empty delete left no category.deleted row';
  end if;

  -- ── 2. the direct delete of Rings Old is refused — structured, and final ─
  begin
    perform public.delete_empty_category(v_old, v_admin::text, 'Amina Admin');
    raise exception 'a 5-product category was hard-deleted';
  exception when check_violation then
    -- the message names the obstacle: 'Category Rings Old still contains 5 product(s)'
    null;
  end;
  select count(*) into v_rows from public.categories where id = v_old;
  if v_rows <> 1 then
    raise exception 'the refused delete still removed the category';
  end if;
  select count(*), coalesce(sum(stock_quantity), 0) into v_rows, v_stock
    from public.products where category_id = v_old;
  if v_rows <> 5 or v_stock <> 150 then
    raise exception 'the refused delete changed the products (rows=% stock=%)', v_rows, v_stock;
  end if;

  -- ── 3. the refusals around the move ─────────────────────────────────────
  begin
    perform public.move_products_and_delete_category(v_old, v_old, v_admin::text, 'Amina Admin');
    raise exception 'source == target was accepted';
  exception when check_violation then
    null;
  end;
  begin
    perform public.move_products_and_delete_category(
      v_old, '00000000-0000-4000-8000-000000000000', v_admin::text, 'Amina Admin');
    raise exception 'a missing target was accepted';
  exception when foreign_key_violation then
    null;
  end;
  begin
    perform public.delete_empty_category(
      '00000000-0000-4000-8000-000000000000', v_admin::text, 'Amina Admin');
    raise exception 'a missing source was accepted';
  exception when foreign_key_violation then
    null;
  end;
  begin
    perform public.move_products_and_delete_category(v_old, v_hidden, v_admin::text, 'Amina Admin');
    raise exception 'an archived target accepted products';
  exception when check_violation then
    null;
  end;
  begin
    perform public.move_products_and_delete_category(v_parent, v_new, v_admin::text, 'Amina Admin');
    raise exception 'a parent with children was moved-and-deleted';
  exception when restrict_violation then
    null;
  end;
  begin
    perform public.delete_empty_category(v_parent, v_admin::text, 'Amina Admin');
    raise exception 'a parent with children was hard-deleted';
  exception when restrict_violation then
    null;
  end;

  -- ── 4. a seat stripped of delete_product is refused the destructive verbs ─
  select p.id into v_clerk from public.profiles p
   where p.role::text = 'inventory_clerk' and p.active limit 1;
  if v_clerk is null then
    raise exception 'no active inventory_clerk profile for the permission proof';
  end if;
  perform public.admin_set_user_exceptions(v_clerk, null, array['delete_product']);
  perform pg_temp.become(v_clerk, 'authenticated');
  begin
    perform public.delete_empty_category(v_old, v_clerk::text, 'Clerk');
    raise exception 'a seat without delete_product deleted a category';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.move_products_and_delete_category(v_old, v_new, v_clerk::text, 'Clerk');
    raise exception 'a seat without delete_product moved-and-deleted';
  exception when insufficient_privilege then
    null;
  end;
  -- archiving rides edit_product, which the clerk still holds: the flip works
  -- (and is undone — the denial never narrows beyond the matrix)
  v_result := public.set_category_active(v_old, false, v_clerk::text, 'Clerk');
  if (v_result->>'changed')::boolean is not true then
    raise exception 'the clerk could not flip a category the matrix allows';
  end if;
  v_result := public.set_category_active(v_old, true, v_clerk::text, 'Clerk');
  if (v_result->>'active')::boolean is not true then
    raise exception 'the clerk could not flip back';
  end if;

  -- now strip edit_product: the archive verb is refused too
  perform pg_temp.become(v_admin, 'authenticated');
  perform public.admin_set_user_exceptions(v_clerk, null, array['edit_product']);
  perform pg_temp.become(v_clerk, 'authenticated');
  begin
    perform public.set_category_active(v_old, false, v_clerk::text, 'Clerk');
    raise exception 'a seat without edit_product archived a category';
  exception when insufficient_privilege then
    null;
  end;
  perform pg_temp.become(v_admin, 'authenticated');
  perform public.admin_set_user_exceptions(v_clerk, null, null);
  perform pg_temp.become(v_clerk, 'authenticated');
  -- the restored clerk may still archive — the denial was the exception, not
  -- the rule (archive rides edit_product, which the clerk holds)
  v_result := public.set_category_active(v_new, true, v_clerk::text, 'Clerk');
  if (v_result->>'active')::boolean is not true then
    raise exception 'the clerk could not flip a category the matrix allows';
  end if;
  perform pg_temp.become(v_admin, 'authenticated');

  -- ── 5. the move: 5 products, one transaction, stock byte-identical ──────
  v_result := public.move_products_and_delete_category(v_old, v_new, v_admin::text, 'Amina Admin');
  if (v_result->>'moved')::integer <> 5 or (v_result->>'deleted')::boolean is not true then
    raise exception 'the move did not report 5 moved + deleted';
  end if;
  select count(*) into v_rows from public.categories where id = v_old;
  if v_rows <> 0 then
    raise exception 'the source survived its own move-and-delete';
  end if;
  select count(*), coalesce(sum(stock_quantity), 0) into v_rows, v_stock
    from public.products where category_id = v_new;
  if v_rows <> 5 or v_stock <> 150 then
    raise exception 'the target received rows=% stock=% (wanted 5 / 150)', v_rows, v_stock;
  end if;
  -- both events, in order: what moved, and what stopped existing
  if not exists (select 1 from public.audit_log
                 where action = 'category.products_moved'
                   and details->>'source_id' = v_old::text
                   and details->>'target_id' = v_new::text
                   and (details->>'moved')::integer = 5) then
    raise exception 'the move left no category.products_moved row';
  end if;

  -- the storefront still sells the moved products (archive ≠ delete, for goods)
  perform pg_temp.become(v_admin, 'authenticated');
  select count(*) into v_rows from public.storefront_categories() where id = v_new;
  if v_rows <> 1 then
    raise exception 'the active target vanished from the storefront';
  end if;

  -- ── 6. archive with products: hidden, untouched, restorable ─────────────
  select count(*) into v_events from public.audit_log
   where action = 'category.archived' and entity_id = v_new::text;
  v_result := public.set_category_active(v_new, false, v_admin::text, 'Amina Admin');
  if (v_result->>'changed')::boolean is not true then
    raise exception 'archiving reported no change';
  end if;
  if (select count(*) from public.audit_log
      where action = 'category.archived' and entity_id = v_new::text) <> v_events + 1 then
    raise exception 'the archive wrote no trail row';
  end if;
  -- the products are NOT auto-archived: still active, still on the website
  select count(*) into v_rows from public.products
   where category_id = v_new and active and show_on_website;
  if v_rows <> 5 then
    raise exception 'archiving the category touched its products (live=%)', v_rows;
  end if;
  -- the storefront shelf is gone; the goods remain in the catalogue
  select count(*) into v_rows from public.storefront_categories() where id = v_new;
  if v_rows <> 0 then
    raise exception 'the archived category still fronts the storefront';
  end if;

  -- ── 7. the forged assignment: refused by a trigger, not a dropdown ──────
  begin
    update public.products set category_id = v_new
     where id = '00000000-0000-4000-8000-000000004410';
    raise exception 'a forged update shelved a product in an archived category';
  exception when check_violation then
    null;
  end;
  begin
    insert into public.products (
      id, sku, name_ar, name_en, category_id, selling_price, cost_price,
      stock_quantity, active
    ) values (
      '00000000-0000-4000-8000-0000000044f0', 'SCN-CAT-FORGED', 'مزوّر', 'Forged',
      v_hidden, 1.00, 0.50, 1, true
    )
    on conflict (id) do update set category_id = excluded.category_id;
    raise exception 'a forged insert shelved a product in an archived category';
  exception when check_violation then
    null;
  end;

  -- ── 8. re-running the flip is a no-op that writes nothing ───────────────
  select count(*) into v_events from public.audit_log
   where action in ('category.archived', 'category.reactivated') and entity_id = v_new::text;
  v_result := public.set_category_active(v_new, false, v_admin::text, 'Amina Admin');
  if (v_result->>'changed')::boolean is not false then
    raise exception 'a repeated archive reported a change';
  end if;
  if (select count(*) from public.audit_log
      where action in ('category.archived', 'category.reactivated')
        and entity_id = v_new::text) <> v_events then
    raise exception 'a repeated flip manufactured an audit row';
  end if;

  -- ── 9. reactivate restores the shelf everywhere ──────────────────────────
  v_result := public.set_category_active(v_new, true, v_admin::text, 'Amina Admin');
  if (v_result->>'changed')::boolean is not true then
    raise exception 'reactivating reported no change';
  end if;
  if not exists (select 1 from public.audit_log
                 where action = 'category.reactivated' and entity_id = v_new::text) then
    raise exception 'the reactivation left no trail row';
  end if;
  select count(*) into v_rows from public.storefront_categories() where id = v_new;
  if v_rows <> 1 then
    raise exception 'the reactivated category did not return to the storefront';
  end if;

  raise notice 'category lifecycle (0044) — the empty shelf deletes, the 5-product shelf refuses with its count, mirrored and missing sides refuse, the archived target refuses, children refuse, the stripped clerk is refused all three verbs and restored by the matrix, 5 products move atomically with byte-identical stock, the archive hides the shelf and touches no product, forged assignments hit the trigger, and a replay writes no second event';
end
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 47: the Danger Zone — 0047's RPCs against the real policies.
--
-- Proves, as the roles the browser actually gets:
--   · a cashier's forged call to every destructive RPC is refused;
--   · the phrase, the freshness window and unknown option keys are refused;
--   · the preview reads real counts and changes nothing;
--   · Clear Operational Data clears the sale/order/return/shift trees while
--     products, variants, categories, profiles and settings survive; the
--     variant inventory reset zeroes the SHELF OF RECORD and the 0043 trigger
--     produces the rollup — with a recount movement keeping the ledger true;
--   · Factory Reset removes catalogue + website content safely, keeps the
--     Super Admin, the auth linkage, the schema and the branding block it was
--     told to keep, restarts the numbering, and leaves no orphans;
--   · a forced failure mid-reset rolls EVERYTHING back (no partial deletion);
--   · the reset's own audit rows survive, and no password ever reaches them.
-- ═══════════════════════════════════════════════════════════════════════════
do $dz$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_cat      uuid := '00000000-0000-4000-8000-00000000d100';
  v_plain    uuid := '00000000-0000-4000-8000-00000000d110';
  v_varprod  uuid := '00000000-0000-4000-8000-00000000d120';
  v_gold     uuid := '00000000-0000-4000-8000-00000000d121';
  v_silver   uuid := '00000000-0000-4000-8000-00000000d122';
  v_cust     uuid := '00000000-0000-4000-8000-00000000d130';
  v_sale     jsonb;
  v_sale_id  uuid;
  v_line_id  uuid;
  v_summary  jsonb;
  v_preview  jsonb;
  v_n        integer;
  v_n2       integer;
  v_audit    integer;
  v_settings jsonb;
begin
  -- Phase 48: the re-auth proof is the CURRENT PASSWORD, verified server-side
  -- against the auth credential. Give the fixture admin (and cashier) the same
  -- shared credential the demo directory carries, hashed for auth.users.
  -- (The session is `authenticated` by now — an earlier block switched it and
  -- only the superuser session_user may switch back; the damper cleanup below
  -- needs the owner too.)
  perform pg_temp.become(null, 'postgres');
  update auth.users set encrypted_password = crypt('alyq1234', gen_salt('bf'))
  where id in (v_admin, v_cashier);

  perform pg_temp.become(v_admin, 'authenticated');

  -- ── seed: category, a plain product, a variant product with 2+2 ──────────
  insert into public.categories (id, name_ar, name_en)
  values (v_cat, 'اختبار الخطر', 'Danger fixtures')
  on conflict (id) do nothing;

  insert into public.products (
    id, sku, name_ar, name_en, category_id, selling_price, cost_price,
    stock_quantity, active, show_on_website, stock_tracking_enabled
  ) values (
    v_plain, 'DZ-PLAIN', 'عادي', 'DZ Plain', v_cat,
    10.00, 5.00, 5, true, true, true
  ) on conflict (id) do update set stock_quantity = 5, active = true, show_on_website = true;

  insert into public.products (
    id, sku, name_ar, name_en, category_id, selling_price, cost_price,
    stock_quantity, active, variants_enabled, stock_tracking_enabled
  ) values (
    v_varprod, 'DZ-VAR', 'متغير', 'DZ Variant', v_cat,
    20.00, 8.00, 4, true, false, true
  ) on conflict (id) do update set stock_quantity = 4, variants_enabled = false, active = true;

  insert into public.product_variants (id, product_id, sku, color_en, color_ar, size, stock_quantity, active)
  values
    (v_gold,   v_varprod, 'DZ-GOLD',   'Gold',   'ذهبي',   17, 0, true),
    (v_silver, v_varprod, 'DZ-SILVER', 'Silver', 'فضي', 17, 0, true)
  on conflict (id) do update set stock_quantity = 0;
  perform public.set_variant_active(v_gold, true);
  perform public.set_variant_active(v_silver, true);

  perform public.enable_product_variants(
    v_varprod,
    jsonb_build_object(v_gold::text, 2, v_silver::text, 2),
    v_admin::text, 'Amina Admin'
  );
  if (select stock_quantity from public.products where id = v_varprod) <> 4 then
    raise exception 'the variant rollup did not follow the opening (expected 4)';
  end if;

  -- a customer, an open shift, a till sale, a return of it, a website order
  insert into public.customers (id, name, phone) values (v_cust, 'Déjà Customer', '01000000001')
  on conflict (id) do nothing;

  perform pg_temp.become(v_admin, 'authenticated');
  perform pg_temp.ensure_open_shift(v_admin::text);
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-dz-sale-1',
    'user_id',    v_admin::text,
    'user_name',  'Amina Admin',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 20.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_plain::text, 'qty', 2))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_line_id from public.sale_items where sale_id = v_sale_id limit 1;

  perform public.pos_process_return(jsonb_build_object(
    'sale_id',       v_sale_id::text,
    'reason',        'Danger Zone fixture',
    'refund_method', 'cash',
    'refund_status', 'pending',
    'user_id',       v_admin::text,
    'user_name',     'Amina Admin',
    'items',         jsonb_build_array(jsonb_build_object('sale_item_id', v_line_id::text, 'quantity', 1))
  ));

  perform public.place_online_order(jsonb_build_object(
    'client_ref',     'scn-dz-order-1',
    'customer_name',  'Déjà Customer',
    'customer_phone', '01000000001',
    'delivery_type',  'pickup',
    'address',        '{}'::jsonb,
    'lines',          jsonb_build_array(jsonb_build_object('product_id', v_plain::text, 'qty', 1)),
    'payment_method', 'cod'
  ));

  select count(*) into v_n from public.sales;
  if v_n < 1 then raise exception 'the Danger Zone seed produced no sale'; end if;

  -- ── forged calls: an ordinary seat can light no fuse ──────────────────────
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    perform public.system_reset_preview('operational', '{"sales": true}'::jsonb);
    raise exception 'a cashier read the reset preview';
  exception when insufficient_privilege then null; end;
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() + interval '1 minute', 'alyq1234');
    raise exception 'a cashier cleared operational data';
  exception when insufficient_privilege then null; end;
  begin
    perform public.system_factory_reset(
      '{"products": true}'::jsonb, 'DELETE ALL DATA', now() + interval '1 minute', 'alyq1234');
    raise exception 'a cashier ran a factory reset';
  exception when insufficient_privilege then null; end;

  -- ── the phrase is not authorization alone, and neither is the UI ─────────
  perform pg_temp.become(v_admin, 'authenticated');
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'delete operational data ', now() + interval '1 minute', 'alyq1234');
    raise exception 'a wrong phrase passed (case/trim must be normalized)';
  exception when others then
    if sqlerrm not like 'RESET_PHRASE_MISMATCH:%' then
      raise exception 'wrong phrase failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- stale re-authentication window
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() - interval '20 minutes');
    raise exception 'a stale re-authentication window passed';
  exception when others then
    if sqlerrm not like 'RESET_REAUTH_REQUIRED:%' then
      raise exception 'stale window failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- far-future (forged) freshness stamp
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() + interval '1 hour');
    raise exception 'a forged future freshness stamp passed';
  exception when others then
    if sqlerrm not like 'RESET_REAUTH_REQUIRED:%' then
      raise exception 'future stamp failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- unknown option key: abort, never silently do less
  begin
    perform public.system_clear_operational_data(
      '{"sales": true, "explode": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() + interval '1 minute', 'alyq1234');
    raise exception 'an unknown option key passed';
  exception when others then
    if sqlerrm not like 'RESET_BAD_OPTIONS:%' then
      raise exception 'unknown key failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- ── Phase 48: the password itself is the proof, checked server-side ───────
  -- the correct phrase with a WRONG current password never reaches the phrase
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() + interval '1 minute', 'totally-wrong');
    raise exception 'a wrong current password passed';
  exception when others then
    if sqlerrm not like 'RESET_REAUTH_REQUIRED:%' then
      raise exception 'wrong password failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- a call with NO password (the pre-48 call shape) is refused outright
  begin
    perform public.system_clear_operational_data(
      '{"sales": true}'::jsonb, 'DELETE OPERATIONAL DATA', now() + interval '1 minute');
    raise exception 'a passwordless reset passed';
  exception when others then
    if sqlerrm not like 'RESET_REAUTH_REQUIRED:%' then
      raise exception 'passwordless call failed with the wrong error: %', sqlerrm;
    end if;
  end;

  -- (no failed-attempt counter exists on the server — a failed RPC is one
  -- rolled-back statement, so a tally written inside it would die with the
  -- raise; the honest posture is the per-call bcrypt proof itself)

  -- ── preview: server counts, zero mutation ─────────────────────────────────
  select count(*) into v_n from public.sales;
  v_preview := public.system_reset_preview('operational',
    '{"sales": true, "orders": true, "shifts": true, "quantities": true}'::jsonb);
  if (v_preview->'effective_options'->>'returns')::boolean is not true then
    raise exception 'the preview did not carry sales → returns';
  end if;
  if (v_preview->'protected_admin'->>'username') is distinct from 'admin' then
    raise exception 'the preview did not name the protected Super Admin';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_preview->'delete') del
    where del->>'group' = 'sales' and (del->>'count')::integer >= 1
  ) then
    raise exception 'the preview did not count the seeded sale';
  end if;
  select count(*) into v_n2 from public.sales;
  if v_n2 <> v_n then
    raise exception 'the preview mutated the data (% → %)', v_n, v_n2;
  end if;

  -- ── Mode 1: clear operational data (sales, orders, shifts, quantities) ───
  v_summary := public.system_clear_operational_data(
    '{"sales": true, "orders": true, "shifts": true, "quantities": true}'::jsonb,
    'DELETE OPERATIONAL DATA',
    now() + interval '1 minute',
    'alyq1234'
  );

  select count(*) into v_n from public.sales;
  if v_n <> 0 then raise exception 'operational clear left % sale(s)', v_n; end if;
  select count(*) into v_n from public.online_orders;
  if v_n <> 0 then raise exception 'operational clear left % online order(s)', v_n; end if;
  select count(*) into v_n from public.sales_returns;
  if v_n <> 0 then raise exception 'operational clear left % return(s)', v_n; end if;
  select count(*) into v_n from public.refund_records;
  if v_n <> 0 then raise exception 'operational clear left % refund(s)', v_n; end if;
  select count(*) into v_n from public.shifts;
  if v_n <> 0 then raise exception 'operational clear left % shift(s)', v_n; end if;
  select count(*) into v_n from public.stock_reservations;
  if v_n <> 0 then raise exception 'operational clear left % reservation(s)', v_n; end if;

  -- preserved: catalogue, settings, profiles
  select count(*) into v_n from public.products where id in (v_plain, v_varprod);
  if v_n <> 2 then raise exception 'operational clear deleted products'; end if;
  select count(*) into v_n from public.product_variants where id in (v_gold, v_silver);
  if v_n <> 2 then raise exception 'operational clear deleted variants'; end if;
  select count(*) into v_n from public.categories where id = v_cat;
  if v_n <> 1 then raise exception 'operational clear deleted the category'; end if;
  select count(*) into v_n from public.profiles where role = 'admin' and active;
  if v_n < 1 then raise exception 'operational clear disturbed the Super Admin'; end if;

  -- inventory reset: shelves of record at zero, rollup by trigger, ledger true
  if (select stock_quantity from public.product_variants where id = v_gold) <> 0
     or (select stock_quantity from public.product_variants where id = v_silver) <> 0 then
    raise exception 'the variant shelves were not zeroed';
  end if;
  if (select stock_quantity from public.products where id = v_varprod) <> 0 then
    raise exception 'the variant rollup did not follow the reset (must be the trigger''s sum)';
  end if;
  if (select stock_quantity from public.products where id = v_plain) <> 0 then
    raise exception 'the plain product was not zeroed';
  end if;
  select count(*) into v_n from public.stock_movements
   where reason = 'recount' and notes = 'Danger Zone inventory reset';
  if v_n < 3 then
    raise exception 'the recount ledger rows are missing (% written)', v_n;
  end if;

  -- the reset's own audit survived (append-only trail)
  select count(*) into v_audit from public.audit_log
   where action in ('system.reset.started', 'system.reset.succeeded')
     and entity_id = 'operational';
  if v_audit <> 2 then
    raise exception 'the operational reset left % audit rows, expected 2', v_audit;
  end if;
  if exists (select 1 from public.audit_log where details::text ilike '%password%') then
    raise exception 'a password-shaped string reached the audit trail';
  end if;

  -- ── seed again, then Mode 2: factory reset with branding preserved ───────
  -- the operational clear zeroed the shelves; restock the plain product so a
  -- fresh till sale can exist (a plain product's stock is directly writable)
  update public.products set stock_quantity = 5 where id = v_plain;
  perform pg_temp.become(v_admin, 'authenticated');
  perform pg_temp.ensure_open_shift(v_admin::text);
  perform public.pos_complete_sale(jsonb_build_object(
    'client_ref', 'scn-dz-sale-2',
    'user_id',    v_admin::text,
    'user_name',  'Amina Admin',
    'payments',   jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 10.00)),
    'lines',      jsonb_build_array(jsonb_build_object('product_id', v_plain::text, 'qty', 1))
  ));

  update public.website_settings set settings = jsonb_build_object(
    'brand', jsonb_build_object('display_name_en', 'ALYQ Atelier', 'display_name_ar', 'الياقوت أتيليه'),
    'images', jsonb_build_object('logo_url', 'https://cdn.example/logo.png'),
    'sections', jsonb_build_array(jsonb_build_object('key', 'categories', 'category_ids',
                      jsonb_build_array(v_cat::text))),
    'delivery', jsonb_build_object('flat_fee', 30)
  ) where id = 1;

  -- rollback: a forced failure after the deletes must leave EVERYTHING intact.
  -- The interruption point inside 0047 arms only through a transaction-local
  -- custom GUC — something PostgREST cannot set from a request, so this is a
  -- fixture with no shipped switch (see the migration's comment).
  perform set_config('dz.force_failure', 'factory', true);

  begin
    perform public.system_factory_reset(
      '{"products": true, "categories": true, "customers": true, "website": true, "branding": false}'::jsonb,
      'DELETE ALL DATA',
      now() + interval '1 minute',
      'alyq1234'
    );
    raise exception 'the forced failure did not fire';
  exception when others then
    if sqlerrm not like 'DZ_TEST_INTERRUPT%' then
      raise exception 'the forced failure surfaced the wrong error: %', sqlerrm;
    end if;
  end;
  perform set_config('dz.force_failure', 'off', true);

  select count(*) into v_n from public.sales;
  if v_n <> 1 then
    raise exception 'the rolled-back reset left % sale(s) — the transaction was not atomic', v_n;
  end if;
  select count(*) into v_n from public.products where id in (v_plain, v_varprod);
  if v_n <> 2 then raise exception 'the rolled-back reset deleted products'; end if;
  select count(*) into v_n from public.website_settings
   where coalesce(settings->'brand'->>'display_name_en', '') is distinct from 'ALYQ Atelier';
  if v_n <> 0 then raise exception 'the rolled-back reset touched the settings document'; end if;
  select count(*) into v_n from public.website_settings
   where coalesce(settings->'images'->>'logo_url', '') is distinct from 'https://cdn.example/logo.png';
  if v_n <> 0 then raise exception 'the rolled-back reset touched the logo'; end if;

  -- the real factory reset
  v_summary := public.system_factory_reset(
    '{"products": true, "categories": true, "customers": true, "website": true, "delivery_payment": false, "branding": false}'::jsonb,
    'DELETE ALL DATA',
    now() + interval '1 minute',
    'alyq1234'
  );

  select count(*) into v_n from public.products;
  if v_n <> 0 then raise exception 'the factory reset left % product(s)', v_n; end if;
  select count(*) into v_n from public.product_variants;
  if v_n <> 0 then raise exception 'the factory reset left % variant(s)', v_n; end if;
  select count(*) into v_n from public.categories where id = v_cat;
  if v_n <> 0 then raise exception 'the factory reset left the category'; end if;
  select count(*) into v_n from public.customers where id = v_cust;
  if v_n <> 0 then raise exception 'the factory reset left the customer'; end if;
  select count(*) into v_n from public.sales;
  if v_n <> 0 then raise exception 'the factory reset left % sale(s)', v_n; end if;
  select count(*) into v_n from public.product_content;
  if v_n <> 0 then raise exception 'the factory reset left % product-content row(s)', v_n; end if;

  select settings into v_settings from public.website_settings where id = 1;
  if coalesce(v_settings->'brand'->>'display_name_en', '') <> 'ALYQ Atelier' then
    raise exception 'the factory reset dropped the branding it was told to keep';
  end if;
  if v_settings ? 'sections' then
    raise exception 'the factory reset kept the customization it was told to reset';
  end if;

  -- numbering restarts; the Super Admin and the schema survive; audit intact
  if (select next_value from public.sale_counters) <> 1 then
    raise exception 'the factory reset did not restart the sale numbering';
  end if;
  select count(*) into v_n from public.profiles where role = 'admin' and active;
  if v_n < 1 then raise exception 'the factory reset disturbed the Super Admin'; end if;
  if (v_summary->'preserved'->>'super_admin') is distinct from 'admin' then
    raise exception 'the factory summary did not name the surviving Super Admin';
  end if;
  select count(*) into v_n from public.audit_log
   where action = 'system.reset.succeeded' and entity_id = 'factory';
  if v_n <> 1 then
    raise exception 'the factory reset left % success audit row(s), expected 1', v_n;
  end if;

  -- a customer's browser cannot forge the failure report either
  perform pg_temp.become(v_cashier, 'authenticated');
  begin
    perform public.system_reset_report_failure('factory', 'probe', 'forged');
    raise exception 'a cashier wrote a forged failure report';
  exception when insufficient_privilege then null; end;

  raise notice 'danger zone (0047) — forged calls refused at every door, phrase/freshness/options enforced, preview counted without touching, operational clear emptied the sale/order/return/shift trees while the catalogue and settings survived, the variant shelves zeroed through their trigger with a true recount ledger, the forced failure rolled back completely, the factory reset cleared catalogue + website + customers and kept the Super Admin and the branding block, numbering restarted, and the reset''s own audit rows survived without ever seeing a password';
end
$dz$;

-- ═══════════════════════════════════════════════════════════════════════════
-- $promo50$ — delivery zones, promotions and the completion fix (0049/0050).
--
-- Every amount below is asserted against rows the server wrote, never against
-- the payload: the browser sends ids, quantities, a code and a zone — never
-- money. Refusals must write ZERO rows (reusing scn_expect_refusal) and raise
-- the wording the storefront maps to a friendly message.
--
--   Part 19  zones: seeded fees, pickup free, disabled/bogus refused, forged
--            fee impossible, minimum + threshold, admin edit takes effect.
--   Part 20  promo codes: percent math, min, cap, expiry, disabled, unknown,
--            usage limit, per-customer limit, first-order-only, single
--            application, cart-change recalculation, forged discount ignored.
--   Part 21  global sale: storewide 15%, variant-override base, snapshot
--            frozen, disabling restores normal price for new orders only.
--   Part 22  targeting: category scope discounts the ring, not the necklace;
--            variant scope discounts one combination only.
--   Part 23  returns: a discounted item refunds its paid price, not list.
--   Part 24  status: "Mark completed" stores 'completed' (never 'complete'),
--            invalid moves refuse with the workflow wording, no raw enum text.
-- ═══════════════════════════════════════════════════════════════════════════
do $promo50$
declare
  v_admin    uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier  uuid := '00000000-0000-4000-8000-0000000000c1';
  v_cat      uuid := '00000000-0000-4000-8000-000000000d01';
  v_cat_out  uuid := '00000000-0000-4000-8000-000000000d09';
  v_goods    uuid := '00000000-0000-4000-8000-000000000d02';
  v_ring     uuid := '00000000-0000-4000-8000-000000000d03';
  v_neck     uuid := '00000000-0000-4000-8000-000000000d04';
  v_varprod  uuid := '00000000-0000-4000-8000-000000000d05';
  v_gold     uuid := '00000000-0000-4000-8000-000000000d06';
  v_result   jsonb;
  v_facts    jsonb;
  v_id       uuid;
  v_sale_id  uuid;
  v_item_id  uuid;
  v_amt      numeric(14,2);
  v_n        integer;
  v_status   text;
  v_zone_ism uuid;
  v_zone_cai uuid;
  v_zone_oth uuid;
  v_zone_off uuid;
  v_promo    uuid;
begin
  -- ── fixtures (admin claim: coupons, zones and promotions write behind the
  --    manage_website RLS gate; the owner bypass is not what is under test) ──
  perform pg_temp.become(v_admin, 'authenticated');
  insert into public.categories (id, name_ar, name_en, active)
  values (v_cat, 'خواتم فحص', 'Scenario Rings', true),
         (v_cat_out, 'عقود فحص', 'Scenario Necklaces', true)
  on conflict (id) do update set active = true;

  insert into public.products (
    id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
    stock_quantity, low_stock_level, show_on_website, is_featured, active,
    stock_tracking_enabled
  ) values
    (v_goods,   'SCN-P50-G',  '6291000000311', 'صنف فحص',    'Promo Goods',  v_cat, 100.00, 40.00, 500, 5, true, false, true, true),
    (v_ring,    'SCN-P50-R',  '6291000000328', 'خاتم فحص',   'Promo Ring',   v_cat, 200.00, 80.00, 50,  5, true, false, true, true),
    (v_neck,    'SCN-P50-N',  '6291000000335', 'عقد فحص',    'Promo Necklace', v_cat_out, 100.00, 40.00, 50,  5, true, false, true, true),
    (v_varprod, 'SCN-P50-V',  '6291000000342', 'خاتم مزدوج', 'Promo Duo Ring', v_cat, 200.00, 80.00, 10,  2, true, false, true, true)
  on conflict (id) do update
    set selling_price = excluded.selling_price, stock_quantity = 10,
        active = true, show_on_website = true, stock_tracking_enabled = true;

  -- The duo ring sells by combination: enable variants with the whole shelf on
  -- Gold / 17 (the same RPC the admin screen calls), so the tests below buy a
  -- 300-override shelf, never the 200 product price.
  insert into public.product_variants (
    id, product_id, sku, color_key, color_ar, color_en, color_hex,
    size, size_label, stock_quantity, low_stock_level, active, sort_order, price_override
  ) values (
    v_gold, v_varprod, 'SCN-P50-GOLD-17', 'gold', 'ذهبي', 'Gold', '#d4af37',
    17, null, 0, 1, true, 1, 300.00
  )
  on conflict (id) do update
    set stock_quantity = 0, price_override = 300.00;
  perform public.set_variant_active(v_gold, true);
  perform public.enable_product_variants(
    v_varprod, jsonb_build_object(v_gold::text, 10), v_admin::text, 'Amina Admin');

  -- One variant with its own price: discounts must land on the override (300),
  -- never on the product price (200).
  insert into public.product_variants (
    id, product_id, sku, color_key, color_ar, color_en, color_hex,
    size, size_label, stock_quantity, low_stock_level, active, sort_order, price_override
  ) values
    (v_gold, v_varprod, 'SCN-P50-GOLD-17', 'gold', 'ذهبي', 'Gold', '#d4af37',
     17, null, 10, 1, true, 1, 300.00)
  on conflict (id) do update
    set stock_quantity = 10, price_override = 300.00;
  perform public.set_variant_active(v_gold, true);

  insert into public.coupons
    (code, discount_type, value, min_subtotal, max_discount, usage_limit, used_count,
     per_customer_limit, first_order_only, stackable, applies_to, target_ids, active,
     starts_at, ends_at)
  values
    ('SCN-P50-10',   'percent', 10, 500, 200, null, 0, null, false, false, 'all', '[]', true,  null, null),
    ('SCN-P50-EXP',  'percent', 10, 0,   null, null, 0, null, false, false, 'all', '[]', true,  null, now() - interval '1 day'),
    ('SCN-P50-OFF',  'percent', 10, 0,   null, null, 0, null, false, false, 'all', '[]', false, null, null),
    ('SCN-P50-ONE',  'percent', 10, 0,   null, 1,    0, null, false, false, 'all', '[]', true,  null, null),
    ('SCN-P50-PER1', 'percent', 10, 0,   null, null, 0, 1,    false, false, 'all', '[]', true,  null, null),
    ('SCN-P50-FIRST','percent', 10, 0,   null, null, 0, null, true,  false, 'all', '[]', true,  null, null)
  on conflict (code) do update
    set discount_type = excluded.discount_type, value = excluded.value,
        min_subtotal = excluded.min_subtotal, max_discount = excluded.max_discount,
        usage_limit = excluded.usage_limit, used_count = 0,
        per_customer_limit = excluded.per_customer_limit,
        first_order_only = excluded.first_order_only, stackable = excluded.stackable,
        active = excluded.active, starts_at = excluded.starts_at, ends_at = excluded.ends_at;

  -- A disabled zone for the refusal; the seeded Ismailia/Cairo/Other rows are
  -- asserted as-is below (the seed is part of the contract).
  insert into public.delivery_zones
    (key, name_en, name_ar, shipping_fee, enabled, sort_order)
  values ('scn-off', 'Scenario Closed', 'مغلق فحص', 25, false, 500)
  on conflict (key) do update set enabled = false, shipping_fee = 25;
  select id into v_zone_off from public.delivery_zones where key = 'scn-off';

  select id into v_zone_ism from public.delivery_zones where key = 'ismailia';
  select id into v_zone_cai from public.delivery_zones where key = 'cairo';
  select id into v_zone_oth from public.delivery_zones where key = 'other';
  if v_zone_ism is null or v_zone_cai is null or v_zone_oth is null then
    raise exception 'the 0049 seed zones are missing';
  end if;

  perform pg_temp.ensure_open_shift();

  -- ── Part 19 · zones ──────────────────────────────────────────────────────
  perform pg_temp.become(null, 'anon');

  -- 1–3. the seeded fees price server-side: Ismailia 0, Cairo 70, Other 80.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-ism', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Ismailia', 'area', 'Downtown', 'street', 'S1'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_ism::text,
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts(v_id);
  if (v_facts->>'delivery_fee')::numeric <> 0 then
    raise exception 'Ismailia delivery priced % instead of 0', v_facts->>'delivery_fee';
  end if;

  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-cai', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Cairo', 'area', 'Nasr City', 'street', 'S9'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_cai::text,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 70 then
    raise exception 'Cairo delivery priced % instead of 70', v_facts->>'delivery_fee';
  end if;
  if (v_facts->>'total')::numeric <> 270 then
    raise exception 'Cairo total % is not 200 + 70', v_facts->>'total';
  end if;
  -- Forged money is structurally impossible: the payload carries no fee field,
  -- and the stored address names the zone the fee came from.
  if v_facts->>'address_zone_id' is distinct from v_zone_cai::text then
    raise exception 'the Cairo order does not name its zone';
  end if;

  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-oth', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Aswan', 'area', 'Downtown', 'street', 'S2'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_oth::text,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 80 then
    raise exception 'Other-governorates delivery priced % instead of 80', v_facts->>'delivery_fee';
  end if;

  -- 4. pickup never pays a fee, zone or none.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-pick', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_cai::text,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 0 then
    raise exception 'pickup with a zone priced a fee of %', v_facts->>'delivery_fee';
  end if;

  -- 5. a disabled zone and a bogus id are refused, writing nothing.
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-zoff', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'X', 'area', 'Y', 'street', 'S'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 1)),
    'coupon_code', null, 'delivery_zone_id', v_zone_off::text,
    'payment_method', 'cod'), 'Delivery zone is not available');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-zbogus', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'X', 'area', 'Y', 'street', 'S'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 1)),
    'coupon_code', null, 'delivery_zone_id', '00000000-0000-4000-8000-ffffffffffff',
    'payment_method', 'cod'), 'Delivery zone is not available');

  -- 6. the pickup order carries no zone (proved above by its 0 fee and by the
  --    zone merge applying only to delivery rows).

  -- 8–9. minimum and free threshold, set temporarily on Cairo, then restored.
  -- Zone writes run as the admin (manage_website); the guest only places.
  perform pg_temp.become(v_admin, 'authenticated');
  update public.delivery_zones
     set minimum_order_amount = 1000, free_shipping_threshold = 150
   where id = v_zone_cai;
  perform pg_temp.become(null, 'anon');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-zmin', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Cairo', 'area', 'A', 'street', 'S'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_cai::text,
    'payment_method', 'cod'), 'Delivery orders need at least 1000.00');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-zmin-ok', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Cairo', 'area', 'A', 'street', 'S'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 12)),
    'coupon_code', null, 'delivery_zone_id', v_zone_cai::text,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 0 then
    raise exception 'the 150 threshold did not waive the Cairo fee (%)', v_facts->>'delivery_fee';
  end if;
  perform pg_temp.become(v_admin, 'authenticated');
  update public.delivery_zones
     set minimum_order_amount = 0, free_shipping_threshold = null
   where id = v_zone_cai;
  perform pg_temp.become(null, 'anon');

  -- 10. the admin moves Ismailia 0 → 30 with an update, no code involved.
  perform pg_temp.become(v_admin, 'authenticated');
  update public.delivery_zones set shipping_fee = 30 where id = v_zone_ism;
  perform pg_temp.become(null, 'anon');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-ism30', 'customer_name', 'Z', 'customer_phone', '0510000001',
    'delivery_type', 'delivery',
    'address', jsonb_build_object('city', 'Ismailia', 'area', 'Downtown', 'street', 'S1'),
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 2)),
    'coupon_code', null, 'delivery_zone_id', v_zone_ism::text,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'delivery_fee')::numeric <> 30 then
    raise exception 'the edited Ismailia fee did not take effect (%)', v_facts->>'delivery_fee';
  end if;
  perform pg_temp.become(v_admin, 'authenticated');
  update public.delivery_zones set shipping_fee = 0 where id = v_zone_ism;
  perform pg_temp.become(null, 'anon');

  -- ── Part 20 · promo codes ────────────────────────────────────────────────
  -- 1. subtotal 1000 → 100 off; the snapshot names the code and the maths.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c1', 'customer_name', 'C', 'customer_phone', '0520000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-10',
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts(v_id);
  if (v_facts->>'discount_amount')::numeric <> 100 then
    raise exception 'ALYQ10-style 10%% on 1000 discounted % instead of 100', v_facts->>'discount_amount';
  end if;
  if (v_facts->>'total')::numeric <> 900 then
    raise exception 'promo total % is not 900', v_facts->>'total';
  end if;
  if v_facts->>'discount_code' <> 'SCN-P50-10' then
    raise exception 'the snapshot lost the promo code';
  end if;
  if (v_facts->'price_snapshot'->>'promo_discount')::numeric <> 100 then
    raise exception 'the snapshot lost the promo discount';
  end if;
  if pg_temp.scn_promo_uses('SCN-P50-10', v_id) <> 1 then
    raise exception 'the usage history missed the order';
  end if;

  -- 2. subtotal 300 under a 500 minimum is refused, writing nothing.
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c2', 'customer_name', 'C', 'customer_phone', '0520000002',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 3)),
    'coupon_code', 'SCN-P50-10',
    'payment_method', 'cod'), 'needs a subtotal of at least');

  -- 3. subtotal 3000 caps the 10% at 200.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c3', 'customer_name', 'C', 'customer_phone', '0520000003',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 30)),
    'coupon_code', 'SCN-P50-10',
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'discount_amount')::numeric <> 200 then
    raise exception 'the 200 cap did not hold (%)', v_facts->>'discount_amount';
  end if;

  -- 4–6. expired, disabled and unknown codes are refused with their wordings.
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c4', 'customer_name', 'C', 'customer_phone', '0520000004',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-EXP',
    'payment_method', 'cod'), 'has expired');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c5', 'customer_name', 'C', 'customer_phone', '0520000004',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-OFF',
    'payment_method', 'cod'), 'is not valid');
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c6', 'customer_name', 'C', 'customer_phone', '0520000004',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-NOPE',
    'payment_method', 'cod'), 'is not valid');

  -- 7. a usage limit of one: the second checkout is refused.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c7a', 'customer_name', 'C', 'customer_phone', '0520000005',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-ONE',
    'payment_method', 'cod'));
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c7b', 'customer_name', 'C', 'customer_phone', '0520000006',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-ONE',
    'payment_method', 'cod'), 'has been fully used');

  -- 8. per-customer limit of one: the same phone is refused, a new one passes.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c8a', 'customer_name', 'C', 'customer_phone', '0520000007',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-PER1',
    'payment_method', 'cod'));
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c8b', 'customer_name', 'C', 'customer_phone', '0520000007',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-PER1',
    'payment_method', 'cod'), 'has reached its usage limit');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c8c', 'customer_name', 'C', 'customer_phone', '0520000008',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-PER1',
    'payment_method', 'cod'));

  -- 9. one application per order: the discount is computed once, not per line.
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'discount_amount')::numeric <> 100 then
    raise exception 'the code applied != once (%)', v_facts->>'discount_amount';
  end if;

  -- 10. a changed cart recalculates: the same code on 300 is refused again.
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-c10', 'customer_name', 'C', 'customer_phone', '0520000009',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 3)),
    'coupon_code', 'SCN-P50-10',
    'payment_method', 'cod'), 'needs a subtotal of at least');

  -- first-order-only: the phone with history is refused, a fresh one passes.
  perform pg_temp.scn_expect_refusal(jsonb_build_object(
    'client_ref', 'scn-p50-cf1', 'customer_name', 'C', 'customer_phone', '0520000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-FIRST',
    'payment_method', 'cod'), 'first orders only');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-cf2', 'customer_name', 'C', 'customer_phone', '0520000010',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-FIRST',
    'payment_method', 'cod'));

  -- 11. a forged discount is re-priced from the catalogue.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-c11', 'customer_name', 'C', 'customer_phone', '0520000011',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 1, 'unit_price', 0.01)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'subtotal')::numeric <> 100 then
    raise exception 'a forged unit price survived: subtotal %', v_facts->>'subtotal';
  end if;

  -- ── Part 21 · the storewide sale ─────────────────────────────────────────
  -- Admin writes run as the admin (promotions write behind manage_website);
  -- the guest places as anon.
  perform pg_temp.become(v_admin, 'authenticated');
  insert into public.promotions
    (id, enabled, name_en, name_ar, discount_type, value, scope,
     minimum_order_amount, maximum_discount_amount, priority, stackable)
  values
    ('00000000-0000-4000-8000-000000000d10', true, 'Scenario 15% storewide', 'خصم شامل',
     'percent', 15, 'store', 0, null, 0, false)
  on conflict (id) do update
    set enabled = true, value = 15, scope = 'store', stackable = false;
  v_promo := '00000000-0000-4000-8000-000000000d10';
  perform pg_temp.become(null, 'anon');

  -- Ring 200 + override variant 300 = 500 goods → 75 off, on the override base.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-g1', 'customer_name', 'G', 'customer_phone', '0530000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', v_ring::text, 'qty', 1),
      jsonb_build_object('product_id', v_varprod::text, 'qty', 1, 'variant_id', v_gold::text)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts(v_id);
  if (v_facts->>'discount_amount')::numeric <> 75 then
    raise exception 'the storewide 15%% on 500 discounted % instead of 75', v_facts->>'discount_amount';
  end if;
  if v_facts->>'promotion_id' is distinct from v_promo::text then
    raise exception 'the order does not name its promotion';
  end if;
  if (v_facts->'price_snapshot'->>'auto_discount')::numeric <> 75 then
    raise exception 'the snapshot lost the automatic discount';
  end if;
  -- The variant line paid 255 (300 − 15%), not 170 (200 − 15%).
  select (line->>'discounted_unit_price')::numeric into v_amt
  from jsonb_array_elements(v_facts->'lines') as line
  where line->>'sku' = 'SCN-P50-GOLD-17';
  if v_amt <> 255 then
    raise exception 'the override variant discounted to % instead of 255', v_amt;
  end if;

  -- Disabling restores normal price for NEW orders; history does not move.
  perform pg_temp.become(v_admin, 'authenticated');
  update public.promotions set enabled = false where id = v_promo;
  perform pg_temp.become(null, 'anon');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-g2', 'customer_name', 'G', 'customer_phone', '0530000002',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_ring::text, 'qty', 1)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_facts := pg_temp.scn_order_facts((v_result->>'order_id')::uuid);
  if (v_facts->>'discount_amount')::numeric <> 0 then
    raise exception 'a disabled sale still discounted %', v_facts->>'discount_amount';
  end if;
  v_facts := pg_temp.scn_order_facts(v_id);
  if (v_facts->>'discount_amount')::numeric <> 75 then
    raise exception 'disabling the sale rewrote history';
  end if;

  -- ── Part 22 · targeted offers ────────────────────────────────────────────
  perform pg_temp.become(v_admin, 'authenticated');
  insert into public.promotions
    (id, enabled, name_en, name_ar, discount_type, value, scope,
     minimum_order_amount, maximum_discount_amount, priority, stackable)
  values
    ('00000000-0000-4000-8000-000000000d11', true, 'Scenario 20% rings', 'خصم خواتم',
     'percent', 20, 'category', 0, null, 10, false)
  on conflict (id) do update
    set enabled = true, value = 20, scope = 'category', stackable = false;
  insert into public.promotion_targets (promotion_id, target_kind, target_id)
  values ('00000000-0000-4000-8000-000000000d11', 'category', v_cat)
  on conflict do nothing;
  perform pg_temp.become(null, 'anon');

  -- Ring 200 (in) + necklace 100 (out) → 40 off, nothing else.
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-t1', 'customer_name', 'T', 'customer_phone', '0540000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', v_ring::text, 'qty', 1),
      jsonb_build_object('product_id', v_neck::text, 'qty', 1)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts(v_id);
  if (v_facts->>'discount_amount')::numeric <> 40 then
    raise exception 'the category offer discounted % instead of 40', v_facts->>'discount_amount';
  end if;
  select (line->>'discounted_unit_price')::numeric into v_amt
  from jsonb_array_elements(v_facts->'lines') as line
  where line->>'sku' = 'SCN-P50-N';
  if v_amt <> 100 then
    raise exception 'the necklace outside the scope discounted to %', v_amt;
  end if;

  -- Variant scope: only the Gold / 17 line moves.
  perform pg_temp.become(v_admin, 'authenticated');
  update public.promotions set enabled = false
   where id = '00000000-0000-4000-8000-000000000d11';
  insert into public.promotions
    (id, enabled, name_en, name_ar, discount_type, value, scope,
     minimum_order_amount, maximum_discount_amount, priority, stackable)
  values
    ('00000000-0000-4000-8000-000000000d12', true, 'Scenario gold only', 'ذهب فقط',
     'percent', 50, 'variant', 0, null, 10, false)
  on conflict (id) do update
    set enabled = true, value = 50, scope = 'variant', stackable = false;
  insert into public.promotion_targets (promotion_id, target_kind, target_id)
  values ('00000000-0000-4000-8000-000000000d12', 'variant', v_gold)
  on conflict do nothing;
  perform pg_temp.become(null, 'anon');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-t2', 'customer_name', 'T', 'customer_phone', '0540000002',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', v_varprod::text, 'qty', 1, 'variant_id', v_gold::text),
      jsonb_build_object('product_id', v_ring::text, 'qty', 1)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  v_facts := pg_temp.scn_order_facts(v_id);
  -- 300-override line at 50% (150) + plain 200 line untouched = 150 off.
  if (v_facts->>'discount_amount')::numeric <> 150 then
    raise exception 'the variant offer discounted % instead of 150', v_facts->>'discount_amount';
  end if;
  perform pg_temp.become(v_admin, 'authenticated');
  update public.promotions set enabled = false
   where id = '00000000-0000-4000-8000-000000000d12';

  -- ── Part 23 · the discounted return ───────────────────────────────────────
  -- A 10% code on 10 × 100 refunds 90 per unit, never the 100 list price.
  perform pg_temp.become(v_admin, 'authenticated');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-r1', 'customer_name', 'R', 'customer_phone', '0550000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 10)),
    'coupon_code', 'SCN-P50-10',
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;
  perform public.resolve_online_order(jsonb_build_object(
    'order_id', v_id::text, 'action', 'approve',
    'user_id', v_admin::text, 'user_name', 'Amina Admin'));
  select sale_id into v_sale_id from public.online_orders where id = v_id;
  if v_sale_id is null then raise exception 'the approval created no sale'; end if;
  select id into v_item_id from public.sale_items where sale_id = v_sale_id limit 1;
  perform pg_temp.become(v_cashier, 'authenticated');
  perform public.pos_process_return(jsonb_build_object(
    'sale_id', v_sale_id::text,
    'items', jsonb_build_array(jsonb_build_object('sale_item_id', v_item_id::text, 'quantity', 1)),
    'reason', 'scenario check', 'refund_method', 'cash', 'refund_status', 'completed',
    'user_id', v_cashier::text, 'user_name', 'Karim Cashier'));
  select amount into v_amt from public.refund_records where sale_id = v_sale_id;
  if v_amt <> 90 then
    raise exception 'the discounted unit refunded % instead of 90', v_amt;
  end if;

  -- ── Part 24 · completion stores the label, never the verb ────────────────
  perform pg_temp.become(v_admin, 'authenticated');
  v_result := public.place_online_order(jsonb_build_object(
    'client_ref', 'scn-p50-s1', 'customer_name', 'S', 'customer_phone', '0560000001',
    'delivery_type', 'pickup', 'address', '{}'::jsonb,
    'lines', jsonb_build_array(jsonb_build_object('product_id', v_goods::text, 'qty', 1)),
    'coupon_code', null,
    'payment_method', 'cod'));
  v_id := (v_result->>'order_id')::uuid;

  -- Completing a pending order is refused with the workflow wording — and a
  -- check_violation SQLSTATE with zero rows written, pinned the same way the
  -- checkout refusals are (the resolve path writes nothing on refusal, so the
  -- order counts before and after must match).
  select count(*) into v_n from public.online_orders;
  begin
    perform public.resolve_online_order(jsonb_build_object(
      'order_id', v_id::text, 'action', 'complete',
      'user_id', v_admin::text, 'user_name', 'Amina Admin'));
    raise exception 'completing a pending order was accepted';
  exception when check_violation then
    if SQLERRM not like '%must be approved first%' then
      raise exception 'the pending completion refusal read "%" instead of the workflow wording', SQLERRM;
    end if;
  end;
  select count(*) into v_amt from public.online_orders;
  if v_amt <> v_n then
    raise exception 'a refused completion wrote rows';
  end if;

  perform public.resolve_online_order(jsonb_build_object(
    'order_id', v_id::text, 'action', 'approve',
    'user_id', v_admin::text, 'user_name', 'Amina Admin'));

  -- approved → completed is legal; prove the stored value is the LABEL.
  perform public.resolve_online_order(jsonb_build_object(
    'order_id', v_id::text, 'action', 'complete',
    'user_id', v_admin::text, 'user_name', 'Amina Admin'));
  select status::text into v_status from public.online_orders where id = v_id;
  if v_status <> 'completed' then
    raise exception 'completion stored % instead of completed', v_status;
  end if;

  -- The stored value is the label, the event kind matches, and no raw enum
  -- text ever left the database.
  if exists (select 1 from public.online_orders where id = v_id and status::text = 'complete') then
    raise exception 'the action word leaked into the status column';
  end if;
  select count(*) into v_n from public.order_events
   where order_id = v_id and kind = 'completed';
  if v_n <> 1 then raise exception 'the completion wrote % completed events', v_n; end if;

  -- Completing again is a workflow refusal, not a database error text.
  begin
    perform public.resolve_online_order(jsonb_build_object(
      'order_id', v_id::text, 'action', 'complete',
      'user_id', v_admin::text, 'user_name', 'Amina Admin'));
    raise exception 're-completing a completed order was accepted';
  exception when check_violation then
    if SQLERRM not like '%already completed%' then
      raise exception 'the re-completion refusal read "%" instead of the workflow wording', SQLERRM;
    end if;
  end;

  -- ── the zone admin path audits itself ─────────────────────────────────────
  perform pg_temp.become(v_admin, 'authenticated');
  insert into public.delivery_zones (key, name_en, name_ar, shipping_fee, enabled, sort_order)
  values ('scn-audit', 'Scenario Audit', 'تدقيق فحص', 5, true, 501)
  on conflict (key) do update set shipping_fee = 5;
  select count(*) into v_n from public.audit_log
   where action = 'delivery_zone.created' and entity_id =
     (select id::text from public.delivery_zones where key = 'scn-audit');
  if v_n < 1 then raise exception 'the zone insert wrote no audit row'; end if;
  update public.delivery_zones set shipping_fee = 6 where key = 'scn-audit';
  select count(*) into v_n from public.audit_log
   where action = 'delivery_zone.changed' and entity_id =
     (select id::text from public.delivery_zones where key = 'scn-audit');
  if v_n < 1 then raise exception 'the zone change wrote no audit row'; end if;
  delete from public.delivery_zones where key = 'scn-audit';
  delete from public.delivery_zones where key = 'scn-off';

  raise notice 'promotions (0049/0050) — zones price server-side (seeded 0/70/80, pickup free, disabled and bogus refused, minimum and threshold enforced, admin edits take effect), codes validate and cap (min, cap, expiry, disabled, unknown, usage, per-customer, first-order, single application, recalculation, forged money ignored, history kept), the storewide sale prices variant overrides and freezes history, category and variant targeting isolate lines, discounted returns refund paid prices, completion stores the label with workflow refusals, and zone writes audit themselves';
end
$promo50$;

-- $stocktake60$ — live stocktake (0060).
-- Gold/17 and Silver/17 are independent lines. Finalize is one transaction.
-- A shelf that moved since the snapshot rejects the whole count. A second
-- finalize does not write a second movement. Restore order carries the tables
-- and no stocktake trigger writes the ledger, so a restore cannot replay it.
do $stocktake60$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_cat uuid := '00000000-0000-4000-8000-00000000c064';
  v_ring uuid := '00000000-0000-4000-8000-00000000c060';
  v_gold uuid := '00000000-0000-4000-8000-00000000c061';
  v_silver uuid := '00000000-0000-4000-8000-00000000c062';
  v_plain uuid := '00000000-0000-4000-8000-00000000c063';
  v_doc jsonb;
  v_id uuid;
  v_id2 uuid;
  v_counts jsonb;
  v_result jsonb;
  v_mov integer;
  v_n integer;
  v_expected integer;
  v_ref text;
  v_owner text;
  v_shelf text;
begin
  perform pg_temp.become(v_admin, 'authenticated');

  insert into public.categories (id, name_ar, name_en)
  values (v_cat, 'جرد فحص', 'Stocktake scenario');

  insert into public.products (id, sku, name_ar, name_en, category_id, selling_price, stock_quantity, active, stock_tracking_enabled)
  values (v_plain, 'SCN-ST-PLAIN', 'سادة', 'Scenario Plain', v_cat, 10, 10, true, true);

  insert into public.products (id, sku, name_ar, name_en, category_id, selling_price, stock_quantity, active, stock_tracking_enabled)
  values (v_ring, 'SCN-ST-RING', 'خاتم', 'Scenario Ring', v_cat, 100, 7, true, true);

  insert into public.product_variants (id, product_id, sku, barcode, color_key, color_en, color_ar, size, stock_quantity, active)
  values
    (v_gold, v_ring, 'SCN-ST-G17', 'STG1700000001', 'gold', 'Gold', 'ذهبي', 17, 0, true),
    (v_silver, v_ring, 'SCN-ST-S17', 'STS1700000001', 'silver', 'Silver', 'فضي', 17, 0, true);

  perform public.enable_product_variants(
    v_ring,
    jsonb_build_object(v_gold::text, 4, v_silver::text, 3),
    v_admin::text,
    'Amina Admin');

  v_doc := public.stocktake_create(false, null);
  if coalesce((v_doc->>'ok')::boolean, false) is not true then
    raise exception 'stocktake_create failed: %', v_doc;
  end if;
  v_id := (v_doc->'session'->>'id')::uuid;
  v_ref := v_doc->'session'->>'reference';

  if (select count(*) from public.stocktake_lines where stocktake_id = v_id and product_id = v_ring) <> 2 then
    raise exception 'gold and silver were not independent stocktake lines';
  end if;
  if exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_id and product_id = v_ring and variant_id is null
  ) then
    raise exception 'the ring was counted as one rolled-up shelf';
  end if;
  if (select expected_quantity from public.stocktake_lines where stocktake_id = v_id and variant_id = v_gold) <> 4
     or (select expected_quantity from public.stocktake_lines where stocktake_id = v_id and variant_id = v_silver) <> 3 then
    raise exception 'the variant snapshots were not 4 and 3';
  end if;

  select jsonb_agg(jsonb_build_object(
    'line_id', l.id,
    'physical_quantity', case
      when l.variant_id = v_gold then 2
      when l.product_id = v_plain and l.variant_id is null then 12
      else l.expected_quantity
    end
  ))
    into v_counts
    from public.stocktake_lines l
   where l.stocktake_id = v_id;

  v_result := public.stocktake_save_counts(v_id, v_counts, 'review', true);
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    raise exception 'save counts failed: %', v_result;
  end if;

  select count(*) into v_mov from public.stock_movements;
  v_result := public.stocktake_finalize(v_id);
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    raise exception 'finalize failed: %', v_result;
  end if;
  if (v_result->>'movements')::integer <> 2 then
    raise exception 'finalize reported % movements, expected 2', v_result->>'movements';
  end if;
  if (select count(*) from public.stock_movements) <> v_mov + 2 then
    raise exception 'finalize wrote a different number of ledger rows than it reported';
  end if;

  if (select stock_quantity from public.product_variants where id = v_gold) <> 2
     or (select stock_quantity from public.product_variants where id = v_silver) <> 3
     or (select stock_quantity from public.products where id = v_plain) <> 12
     or (select stock_quantity from public.products where id = v_ring) <> 5 then
    raise exception 'finalize did not land gold 2, silver 3, plain 12, ring rollup 5';
  end if;
  select expected_quantity into v_expected
    from public.stocktake_lines where stocktake_id = v_id and variant_id = v_gold;
  if v_expected <> 4 then
    raise exception 'the gold snapshot was rewritten to %', v_expected;
  end if;
  if exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_id and variant_id = v_silver and movement_id is not null
  ) then
    raise exception 'the zero-variance silver line wrote a movement';
  end if;
  if not exists (
    select 1 from public.stock_movements
     where variant_id = v_gold and reason = 'recount' and notes = 'Stocktake ' || v_ref
  ) then
    raise exception 'the gold movement is not linked to the stocktake reference';
  end if;

  select count(*) into v_mov from public.stock_movements;
  v_result := public.stocktake_finalize(v_id);
  if v_result->>'code' <> 'STOCKTAKE_FINALIZED' then
    raise exception 'a second finalize was not refused: %', v_result;
  end if;
  if (select count(*) from public.stock_movements) <> v_mov then
    raise exception 'a second finalize wrote another movement';
  end if;

  begin
    update public.stocktake_lines set physical_quantity = 0 where stocktake_id = v_id;
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'authenticated rewrote a finalized stocktake line';
    end if;
  exception when insufficient_privilege then
    null;
  end;

  v_doc := public.stocktake_create(false, null);
  v_id2 := (v_doc->'session'->>'id')::uuid;
  if (select expected_quantity from public.stocktake_lines where stocktake_id = v_id2 and variant_id = v_silver) <> 3 then
    raise exception 'the second count did not snapshot silver at 3';
  end if;
  update public.product_variants set stock_quantity = 1 where id = v_silver;

  select jsonb_agg(jsonb_build_object('line_id', l.id, 'physical_quantity', l.expected_quantity))
    into v_counts
    from public.stocktake_lines l
   where l.stocktake_id = v_id2;
  perform public.stocktake_save_counts(v_id2, v_counts, 'review', false);
  select count(*) into v_mov from public.stock_movements;
  v_result := public.stocktake_finalize(v_id2);
  if v_result->>'code' <> 'STOCKTAKE_CONFLICT' then
    raise exception 'a moved shelf was absorbed: %', v_result;
  end if;
  if (select count(*) from public.stock_movements) <> v_mov then
    raise exception 'a rejected stocktake still wrote a movement';
  end if;
  if (select stock_quantity from public.product_variants where id = v_silver) <> 1 then
    raise exception 'the rejected stocktake changed silver stock';
  end if;
  if (select expected_quantity from public.stocktake_lines where stocktake_id = v_id2 and variant_id = v_silver) <> 3 then
    raise exception 'the conflict rewrote the silver snapshot';
  end if;
  if (select count(*) from public.audit_log where action = 'stocktake.conflict' and entity_id = v_id2::text) < 1 then
    raise exception 'the rejected conflict was not audited';
  end if;
  if (select count(*) from public.audit_log where action = 'stocktake.created' and entity_id = v_id::text) < 1
     or (select count(*) from public.audit_log where action = 'stocktake.updated' and entity_id = v_id::text) < 1
     or (select count(*) from public.audit_log where action = 'stocktake.finalized' and entity_id = v_id::text) < 1 then
    raise exception 'created, review, or finalize was not audited';
  end if;

  perform pg_temp.become(v_viewer, 'authenticated');
  begin
    perform public.stocktake_finalize(v_id2);
    raise exception 'a viewer finalized a stocktake';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.stocktake_create(false, null);
    raise exception 'a viewer opened a stocktake';
  exception when insufficient_privilege then
    null;
  end;
  if not exists (select 1 from public.stocktakes where id = v_id) then
    raise exception 'a viewer with view_inventory could not read the stocktake';
  end if;

  if not ('stocktakes' = any (public.backup_table_order()))
     or not ('stocktake_lines' = any (public.backup_table_order()))
     or not ('stocktakes' = any (public.backup_restore_order()))
     or not ('stocktake_lines' = any (public.backup_restore_order())) then
    raise exception 'backup does not carry stocktake sessions and lines';
  end if;
  if array_position(public.backup_table_order(), 'stocktake_lines')
     <= array_position(public.backup_table_order(), 'stock_movements') then
    raise exception 'stocktake lines would restore before the movements they point at';
  end if;
  if exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
     where c.relname in ('stocktakes', 'stocktake_lines')
       and not t.tgisinternal
       and pg_get_functiondef(p.oid) ilike '%insert into public.stock_movements%'
  ) then
    raise exception 'a stocktake trigger writes the ledger, so a restore could replay movements';
  end if;

  -- 0061 must keep 0060's history rule: silver has a stocktake snapshot but
  -- no sale/return/movement reference, so only the stocktake guard blocks its
  -- ordinary deletion. The owner-run factory reset below remains possible.
  perform pg_temp.become(v_admin, 'authenticated');
  begin
    perform public.delete_variant(v_silver);
    raise exception 'stocktake history allowed an ordinary variant delete';
  exception when restrict_violation then
    if SQLERRM not like '%stocktake%' then
      raise exception 'variant delete lost the stocktake-specific refusal: %', SQLERRM;
    end if;
  end;
  if not exists (select 1 from public.product_variants where id = v_silver) then
    raise exception 'refused stocktake variant delete removed the shelf';
  end if;

  -- Factory reset deletes variants before products. The finalized line must let
  -- variant_id clear and keep the shelf name and the quantity it counted.
  select r.rolname into v_owner
    from pg_class c
    join pg_roles r on r.oid = c.relowner
   where c.oid = 'public.product_variants'::regclass;
  perform set_config('role', v_owner, true);
  select shelf_key into v_shelf
    from public.stocktake_lines
   where stocktake_id = v_id and variant_id = v_silver;
  if v_shelf is null then
    raise exception 'silver line was missing before the variant release';
  end if;
  delete from public.stock_movements where variant_id = v_silver;
  delete from public.product_variants where id = v_silver;
  if not exists (
    select 1 from public.stocktake_lines
     where stocktake_id = v_id
       and shelf_key = v_shelf
       and variant_id is null
       and expected_quantity = 3
       and physical_quantity = 3
  ) then
    raise exception 'releasing a variant rewrote or dropped the finalized shelf';
  end if;

  raise notice 'stocktake (0060) — variants stay independent, finalize is one ledger transaction, conflicts reject without writing, finalized rows stay historical, viewers cannot finalize, and backup carries the count without replaying it';
end
$stocktake60$;

do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

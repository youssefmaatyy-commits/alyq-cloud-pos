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
-- to these three tables, so nothing else changes shape.
grant insert, update, delete on public.products         to authenticated;
grant insert, update, delete on public.categories       to authenticated;
grant insert, update, delete on public.stock_movements  to authenticated;
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
begin
  -- the lookup needs oversight: `profiles` is readable as yourself, your own
  -- row, or with `view_audit_log` — a cashier cannot browse the staff list.
  perform pg_temp.become('00000000-0000-4000-8000-0000000000a1');
  select p.id into v_manager from public.profiles p where p.username = 'manager';
  if v_manager is null then
    raise exception 'the seeded manager profile is missing';
  end if;

  -- a discounted cash sale: 2 × 10.00 less 8.00 = 12.00
  perform pg_temp.become(v_cashier);
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref',    'refn-sale-1',
    'user_id',       v_cashier::text,
    'user_name',     'Karim Cashier',
    'discount_type', 'fixed',
    'discount_value', 8.00,
    'payments',      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 12.00, 'tendered', 20.00)),
    'lines',         jsonb_build_array(jsonb_build_object('product_id', v_product::text, 'qty', 2))
  ));
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
-- ── leave no session claim behind ─────────────────────────────────────────
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
end
$$;

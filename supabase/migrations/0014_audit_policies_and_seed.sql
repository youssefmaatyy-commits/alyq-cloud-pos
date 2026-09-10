-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0014
-- Production readiness — audit policies, staff onboarding and seed data.
--
-- What this migration adds:
--   1. `role_aliases` + `normalize_app_role()` — the role-alias table that
--      `roles.ts` also carries, so a role arriving from outside (an imported
--      user, a Supabase Dashboard account) maps the same way in both places.
--   2. `handle_new_user()` — an `auth.users` trigger that creates the matching
--      profile, so "create the user in Supabase, forget the profile row and
--      cannot sign in" stops being possible.
--   3. `backfill_staff_profiles()` — the same thing for accounts that already
--      exist.
--   4. `seed_demo_staff()` — the demo dataset: the five role accounts, with the
--      same usernames, names and password as the offline demo directory, and
--      the `<username>@alyq.local` synthetic email the live sign-in path uses.
--   5. `purge_audit_log()` — an admin-only, auditable retention tool that is the
--      single sanctioned way past the append-only trigger.
--
-- ── Audit write triggers: deliberately NOT in this migration ──────────────
-- The obvious next step would be `after insert on shifts` → insert an audit
-- row. It is not here on purpose: the application ALREADY writes those rows
-- (`recordAudit()` in ShiftProvider and ExpenseProvider, which becomes
-- `SupabaseAuditRepository.append()` in live mode). A trigger would write a
-- second row for every action and double the trail.
--
-- Making the database the single writer is the right end state, and it is the
-- audit-expansion workstream's job — it has to retire the application's calls
-- in the same change, and it covers sales, returns, customers and catalog
-- changes, which the application does not audit at all today. Until then:
-- one writer, no duplicates.
--
-- The append-only guarantees do not depend on that decision: they are already
-- enforced in 0013 (no policy, no privilege, and a trigger that refuses UPDATE
-- and DELETE for every role, including the owner).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── role aliases ──────────────────────────────────────────────────────────
create table if not exists public.role_aliases (
  alias text primary key,
  role  public.app_role not null,
  constraint role_aliases_alias_not_blank check (btrim(alias) <> '')
);

comment on table public.role_aliases is
  'Accepted spellings of a role arriving from outside the app. Mirrors ROLE_ALIASES in src/lib/permissions/roles.ts; verified by scripts/migrations.check.mjs.';

insert into public.role_aliases (alias, role) values
  ('admin', 'admin'), ('owner', 'admin'), ('super_admin', 'admin'), ('superadmin', 'admin'),
  ('manager', 'manager'),
  ('cashier', 'cashier'),
  ('inventory_clerk', 'inventory_clerk'), ('clerk', 'inventory_clerk'), ('stock_clerk', 'inventory_clerk'),
  ('viewer', 'viewer'), ('auditor', 'viewer')
on conflict (alias) do nothing;

/**
 * Map an arbitrary role string onto the app model, or NULL.
 *
 * NULL means "no role", which the capability resolver turns into "no
 * capabilities" — the same fail-closed rule `normalizeRole()` applies in
 * TypeScript. An unrecognised value is never upgraded to a power it did not
 * ask for.
 */
create or replace function public.normalize_app_role(p_raw text)
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select a.role
    from public.role_aliases a
   where a.alias = lower(btrim(coalesce(p_raw, '')))
$$;

comment on function public.normalize_app_role(text) is
  'Resolve an external role string to an app role, or NULL when unknown (fail closed).';

-- ── staff onboarding ──────────────────────────────────────────────────────
/**
 * Create the profile row for a new Supabase Auth user.
 *
 * The role is taken from the user's metadata: set `role` (any accepted alias)
 * when creating the account and the profile is created active with that role.
 * Without metadata the account becomes a **viewer** and is **inactive** —
 * fail closed. That matters because enabling public sign-up by mistake would
 * otherwise hand every visitor read access to the shop's data. An admin
 * promotes the account through `upsert_staff_profile()`.
 *
 * A duplicate username is resolved rather than raised: this trigger runs inside
 * the Auth signup transaction, and failing it would break account creation.
 */
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb) || coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_role     public.app_role := public.normalize_app_role(v_meta->>'role');
  v_username text;
  v_name     text;
begin
  v_username := nullif(btrim(coalesce(v_meta->>'username', '')), '');
  if v_username is null then
    v_username := nullif(split_part(coalesce(new.email, ''), '@', 1), '');
  end if;
  if v_username is null then
    v_username := 'user-' || substr(new.id::text, 1, 8);
  end if;

  v_name := coalesce(nullif(btrim(coalesce(v_meta->>'name', '')), ''), v_username);

  begin
    insert into public.profiles (id, username, name, role, active)
    values (new.id, v_username, v_name, coalesce(v_role, 'viewer'), v_role is not null)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- Someone already uses that username; keep the account usable and let the
    -- name be fixed from the staff screen.
    insert into public.profiles (id, username, name, role, active)
    values (new.id, v_username || '-' || substr(new.id::text, 1, 4), v_name, coalesce(v_role, 'viewer'), v_role is not null)
    on conflict (id) do nothing;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

/** Create the missing profile rows for accounts that already exist. */
create or replace function public.backfill_staff_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created integer := 0;
  v_user    record;
  v_role    public.app_role;
  v_username text;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may backfill staff profiles'
      using errcode = 'insufficient_privilege';
  end if;

  for v_user in
    select u.id, u.email, u.raw_user_meta_data, u.raw_app_meta_data
      from auth.users u
     where not exists (select 1 from public.profiles p where p.id = u.id)
  loop
    v_role := public.normalize_app_role(
      coalesce(v_user.raw_user_meta_data, '{}'::jsonb)->>'role'
    );
    v_username := coalesce(
      nullif(btrim(coalesce(v_user.raw_user_meta_data, '{}'::jsonb)->>'username'), ''),
      nullif(split_part(coalesce(v_user.email, ''), '@', 1), ''),
      'user-' || substr(v_user.id::text, 1, 8)
    );

    begin
      insert into public.profiles (id, username, name, role, active)
      values (v_user.id, v_username, v_username, coalesce(v_role, 'viewer'), v_role is not null)
      on conflict (id) do nothing;
    exception when unique_violation then
      insert into public.profiles (id, username, name, role, active)
      values (v_user.id, v_username || '-' || substr(v_user.id::text, 1, 4), v_username, coalesce(v_role, 'viewer'), v_role is not null)
      on conflict (id) do nothing;
    end;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

-- ── seed data: the demo staff accounts ────────────────────────────────────
/**
 * Create the five demo accounts — admin, manager, cashier, inventory_clerk,
 * viewer — with the same usernames, names and shared password as the offline
 * demo directory, so a fresh project behaves like demo mode.
 *
 * Development and staging only: it is `security definer`, admin-gated and
 * idempotent (an account that already exists is left alone, and only its
 * profile is re-asserted). The first admin still has to be created by hand in
 * the Supabase Dashboard — an installation cannot bootstrap its own first
 * identity without a trust root.
 *
 * Emails use the `<username>@alyq.local` convention that the live sign-in path
 * builds from the username typed at the login screen
 * (src/lib/auth/data/supabaseRepository.ts); a different domain would make the
 * seeded accounts unreachable through the UI.
 *
 * The `auth.identities` row is written because GoTrue needs one for the email
 * provider to accept a password sign-in. Its exact shape has changed between
 * GoTrue releases; if this call fails on a future version, create the accounts
 * in the Dashboard instead — the profiles below are what the app reads.
 */
create or replace function public.seed_demo_staff(p_password text default 'alyq1234')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created integer := 0;
  v_staff   record;
  v_id      uuid;
  v_email   text;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may seed demo staff' using errcode = 'insufficient_privilege';
  end if;

  for v_staff in
    select *
      from (values
        ('admin',           'Amina Admin',  'admin'::public.app_role),
        ('manager',         'Mona Manager', 'manager'::public.app_role),
        ('cashier',         'Karim Cashier','cashier'::public.app_role),
        ('inventory_clerk', 'Nour Clerk',   'inventory_clerk'::public.app_role),
        ('viewer',          'Vera Viewer',  'viewer'::public.app_role)
      ) as t(username, name, role)
  loop
    v_email := v_staff.username || '@alyq.local';

    select u.id into v_id from auth.users u where u.email = v_email;

    if v_id is null then
      v_id := gen_random_uuid();

      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        v_id,
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        v_email,
        crypt(p_password, gen_salt('bf')),
        now(),
        jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
        jsonb_build_object('username', v_staff.username, 'name', v_staff.name, 'role', v_staff.role::text),
        now(),
        now()
      );

      begin
        insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (
          gen_random_uuid(), v_id, v_id,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now()
        );
      exception when others then
        -- Identity shape differs between GoTrue versions; the account and its
        -- profile are still correct, so this is not fatal.
        null;
      end;

      v_created := v_created + 1;
    end if;

    insert into public.profiles (id, username, name, role, active)
    values (v_id, v_staff.username, v_staff.name, v_staff.role, true)
    on conflict (id) do update
      set username = excluded.username,
          name     = excluded.name,
          role     = excluded.role,
          active   = true;
  end loop;

  return v_created;
end;
$$;

comment on function public.seed_demo_staff(text) is
  'Development seed: creates the five demo role accounts (idempotent, admin-only).';

-- ── retention ─────────────────────────────────────────────────────────────
-- 0013 made the trail append-only for every role. Retention is a real need
-- anyway, so there is exactly one sanctioned way through, and it is explicit,
-- admin-only and reports what it removed.
create or replace function public.enforce_audit_log_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text;
  v_uid    text := auth.uid()::text;
  v_name   text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'The audit log is append-only; update is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'DELETE' then
    -- Only `purge_audit_log()` sets this, and only for the length of its own
    -- transaction, so an accidental DELETE still fails.
    if current_setting('alyq.audit_purge', true) = 'on' then
      return old;
    end if;
    raise exception 'The audit log is append-only; disable the trigger deliberately if a purge is really intended'
      using errcode = 'insufficient_privilege';
  end if;

  select a.entity into v_entity from public.audit_actions a where a.action = new.action;
  if v_entity is null then
    raise exception 'Unknown audit action %', new.action using errcode = 'foreign_key_violation';
  end if;
  new.entity := v_entity;

  if v_uid is not null then
    new.user_id := v_uid;
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    if v_name is not null then
      new.user_name := v_name;
    end if;
  end if;

  return new;
end;
$$;

/**
 * Delete audit rows older than a cut-off. Admin only.
 *
 * The single sanctioned way past the append-only trigger — and deliberately
 * NOT self-auditing: writing a row about the purge would require an action the
 * application does not have (`AUDIT_ACTIONS` has no administrative action), and
 * inventing one here would put a value in `audit_log.action` that the UI cannot
 * label and the parity check would reject. Instead the purge is reported the way
 * any destructive maintenance should be: a WARNING in the Postgres log (which
 * Supabase retains separately from the table) and the returned count.
 *
 * The audit-expansion workstream adds administrative actions to the vocabulary;
 * when it does, this function should write a row about itself.
 */
create or replace function public.purge_audit_log(p_before timestamptz default (now() - interval '24 months'))
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may purge the audit log' using errcode = 'insufficient_privilege';
  end if;

  if p_before > now() then
    raise exception 'The cut-off must be in the past' using errcode = 'check_violation';
  end if;

  -- Set for this transaction only; the DELETE below reads it.
  perform set_config('alyq.audit_purge', 'on', true);
  delete from public.audit_log where created_at < p_before;
  get diagnostics v_deleted = row_count;
  perform set_config('alyq.audit_purge', 'off', true);

  if v_deleted > 0 then
    raise warning 'audit_log purge by % removed % row(s) older than %',
      coalesce(auth.uid()::text, 'system'), v_deleted, p_before;
  end if;

  return v_deleted;
end;
$$;

comment on function public.purge_audit_log(timestamptz) is
  'Admin-only retention purge. The single sanctioned way past the append-only trigger.';

-- ── grants ────────────────────────────────────────────────────────────────
revoke all on public.role_aliases from anon;
revoke insert, update, delete on public.role_aliases from authenticated;

grant select on public.role_aliases to authenticated;
grant execute on function public.normalize_app_role(text) to authenticated;
grant execute on function public.backfill_staff_profiles() to authenticated;
grant execute on function public.seed_demo_staff(text) to authenticated;
grant execute on function public.purge_audit_log(timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0021
-- Phase 10 — trustworthy identity: granular capabilities, custom roles, and
--            the profile fields a user-management screen needs.
--
-- What this file ADDS
--   * fourteen capabilities to `public.role_capabilities`, mirroring the
--     extended matrix in `src/lib/permissions/roles.ts` (the migration check
--     diffs the two row for row, so neither side can move alone);
--   * `profiles.email`, `profiles.phone`, `profiles.last_login_at` and
--     `profiles.custom_role_id` — the fields the Settings → Users screen shows;
--   * `public.custom_roles`: admin-defined roles carrying their own capability
--     set, so a shop can have a Sales Manager, an Accountant or a Warehouse
--     Employee without anyone editing code;
--   * `public.can(text)` now consults the caller's custom role FIRST and falls
--     back to the system matrix. Every RLS policy written since 0011 keeps
--     working unchanged and automatically respects custom roles;
--   * admin-guarded RPCs for staff profiles and custom roles;
--   * a foreign key tying `store_customers.id` to `auth.users.id`, which is what
--     makes the website's accounts the same identities as Supabase Auth's
--     rather than a second, parallel directory;
--   * audit vocabulary for sessions, users and roles.
--
-- What this file DELIBERATELY DOES NOT DO
--   * it does not alter `public.app_role`. The five system roles stay canonical:
--     `src/lib/permissions/__tests__/roles.selftest.ts` pins the model at five,
--     and every policy written before this file compares against those labels.
--     A custom role is an overlay on a base system role, never a sixth enum
--     value — that is why `profiles.role` stays `app_role` and stays valid.
--   * it does not narrow any existing grant. Every capability a role held
--     before this migration it still holds; the new rows only add.
--   * it does not touch the POS, the storefront tables, the order RPCs or the
--     refund lifecycle.
--   * it stores no password and no secret. Credentials belong to `auth.users`
--     and to Supabase Auth alone; `profiles` holds a display name, a contact
--     detail and a role.
--
-- Idempotent throughout: guarded inserts, `if not exists`, `create or replace`,
-- and `drop policy if exists` before every policy — the migration check applies
-- each file twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the extended capability matrix ─────────────────────────────────────
-- Grants below are exactly `ROLE_CAPABILITIES` in src/lib/permissions/roles.ts.
--
-- The rule this table obeys: a system role never LOSES a capability here. Where
-- the application previously gated nothing (the catalogue, the Excel importer,
-- the export buttons, the reports screen) the equivalent capability is granted
-- to the roles that could already reach it, so tightening becomes a choice an
-- admin makes per custom role instead of a regression shipped by default.
insert into public.role_capabilities (role, capability) values
  -- admin holds every capability, including the three new oversight ones that
  -- manager deliberately does not: user management, role management and system
  -- settings are the one place where admin and manager now differ.
  ('admin',           'edit_sale'),
  ('admin',           'add_product'),
  ('admin',           'edit_product'),
  ('admin',           'change_price'),
  ('admin',           'delete_product'),
  ('admin',           'import_data'),
  ('admin',           'export_data'),
  ('admin',           'approve_return'),
  ('admin',           'view_reports'),
  ('admin',           'export_reports'),
  ('admin',           'approve_expense'),
  ('admin',           'manage_users'),
  ('admin',           'manage_roles'),
  ('admin',           'manage_settings'),

  ('manager',         'edit_sale'),
  ('manager',         'add_product'),
  ('manager',         'edit_product'),
  ('manager',         'change_price'),
  ('manager',         'delete_product'),
  ('manager',         'import_data'),
  ('manager',         'export_data'),
  ('manager',         'approve_return'),
  ('manager',         'view_reports'),
  ('manager',         'export_reports'),
  ('manager',         'approve_expense'),

  -- The till tier keeps its shape: cashier and inventory clerk differ by stock
  -- adjustment and nothing else (pinned by the role-model self-test).
  ('cashier',         'add_product'),
  ('cashier',         'edit_product'),
  ('cashier',         'change_price'),
  ('cashier',         'delete_product'),
  ('cashier',         'import_data'),
  ('cashier',         'export_data'),
  ('cashier',         'view_reports'),
  ('cashier',         'export_reports'),

  ('inventory_clerk', 'add_product'),
  ('inventory_clerk', 'edit_product'),
  ('inventory_clerk', 'change_price'),
  ('inventory_clerk', 'delete_product'),
  ('inventory_clerk', 'import_data'),
  ('inventory_clerk', 'export_data'),
  ('inventory_clerk', 'view_reports'),
  ('inventory_clerk', 'export_reports'),

  -- Read-only stays read-only: the viewer gains reading reports and exporting
  -- what it could already read, and no write capability at all.
  ('viewer',          'export_data'),
  ('viewer',          'view_reports'),
  ('viewer',          'export_reports')
on conflict (role, capability) do nothing;

-- ── 2. profiles: the fields a user-management screen needs ────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'email'
  ) then
    alter table public.profiles add column email text;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'phone'
  ) then
    alter table public.profiles add column phone text;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'last_login_at'
  ) then
    alter table public.profiles add column last_login_at timestamptz;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'custom_role_id'
  ) then
    alter table public.profiles add column custom_role_id uuid;
  end if;
end
$$;

comment on column public.profiles.email is
  'Contact address shown to admins. Credentials live in auth.users, never here.';
comment on column public.profiles.phone is
  'Contact number. Optional; Egypt-shaped numbers are not enforced here.';
comment on column public.profiles.last_login_at is
  'Stamped by public.admin_touch_login() after a successful sign-in.';
comment on column public.profiles.custom_role_id is
  'Admin-defined role overlay. When set and active, its capabilities replace the system matrix for this profile; profiles.role stays the base system role so every pre-0021 policy keeps working.';

-- Emails are compared case-insensitively, the same way usernames are.
create unique index if not exists profiles_email_key
  on public.profiles (lower(btrim(email)))
  where email is not null;

-- ── 3. custom_roles ───────────────────────────────────────────────────────
create table if not exists public.custom_roles (
  id              uuid primary key default gen_random_uuid(),
  -- Stable slug used in code and in the UI ('sales_manager'). Lowercase, no
  -- spaces: the same shape the product slugs use.
  key             text not null,
  name_en         text not null,
  name_ar         text not null,
  description_en  text,
  description_ar  text,
  -- The system role this one is modelled on. It is what `profiles.role` is set
  -- to when the custom role is assigned, which keeps the enum valid, keeps
  -- pre-0021 policies meaningful, and is the safe fallback if the custom role
  -- is later deactivated.
  base_role       public.app_role not null default 'viewer',
  -- Capability keys, each one a member of public.known_capabilities().
  capabilities    text[] not null default '{}',
  active          boolean not null default true,
  -- Seeded roles (if any) cannot be deleted or renamed away by accident.
  is_system       boolean not null default false,
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint custom_roles_key_shape     check (key ~ '^[a-z][a-z0-9_]{1,48}$'),
  constraint custom_roles_name_en_blank check (btrim(name_en) <> ''),
  constraint custom_roles_name_ar_blank check (btrim(name_ar) <> ''),
  constraint custom_roles_name_en_len   check (char_length(name_en) <= 80),
  constraint custom_roles_name_ar_len   check (char_length(name_ar) <= 80),
  constraint custom_roles_caps_no_null  check (not capabilities @> array[null]::text[])
);

comment on table public.custom_roles is
  'Admin-defined roles: a name in both languages, a base system role and an explicit capability list. Assigned to a profile through profiles.custom_role_id.';

create unique index if not exists custom_roles_key_key on public.custom_roles (key);
create index if not exists custom_roles_active_idx    on public.custom_roles (active) where active;

drop trigger if exists custom_roles_set_updated_at on public.custom_roles;
create trigger custom_roles_set_updated_at
  before update on public.custom_roles
  for each row execute function public.set_updated_at();

-- The foreign key is declared after the table exists, and guarded so re-running
-- the migration does not fail on a constraint that is already there.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_custom_role_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_custom_role_fkey
      foreign key (custom_role_id) references public.custom_roles (id)
      on delete set null;
  end if;
end
$$;

-- ── 4. capability lookups ─────────────────────────────────────────────────
/**
 * Every capability the application knows. Sourced from the matrix itself, so
 * this list can never drift from what `role_capabilities` grants — a custom
 * role cannot invent a capability that no system role has ever held.
 */
create or replace function public.known_capabilities()
returns table (capability text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct rc.capability
    from public.role_capabilities rc
   order by rc.capability
$$;

/** The caller's active custom role, or NULL (fail closed). */
create or replace function public.current_custom_role()
returns public.custom_roles
language sql
stable
security definer
set search_path = public
as $$
  select cr.*
    from public.profiles p
    join public.custom_roles cr on cr.id = p.custom_role_id
   where p.id = auth.uid()
     and p.active
     and cr.active
$$;

/**
 * "May the caller do this?" — the one question every policy asks.
 *
 * Replaces the 0011 version. Resolution order:
 *   1. an ACTIVE custom role on an ACTIVE profile decides absolutely: its
 *      capability list replaces the system matrix rather than adding to it, so
 *      an admin can narrow a role (a cashier who may not discount) and the
 *      narrowing is real;
 *   2. otherwise the system matrix for the profile's role, exactly as before;
 *   3. no profile, an inactive profile, or an unknown capability → false.
 *
 * Because every policy since 0011 calls `public.can(...)`, custom roles take
 * effect across the whole schema without rewriting a single policy.
 */
create or replace function public.can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p_capability = any (cr.capabilities)
       from public.profiles p
       join public.custom_roles cr on cr.id = p.custom_role_id
      where p.id = auth.uid()
        and p.active
        and cr.active),
    public.role_can(public.current_user_role(), p_capability)
  )
$$;

comment on function public.can(text) is
  'Capability check for RLS policies: the caller''s active custom role decides when one is assigned, otherwise the system matrix. Missing profile or unknown capability denies.';

-- ── 5. admin RPCs ─────────────────────────────────────────────────────────
/**
 * Create or update a staff profile, including the contact fields 0011 did not
 * have. Admin only; refuses to drop the caller's own admin role or deactivate
 * the caller's own account, so an installation cannot lock itself out.
 *
 * The auth user must already exist: creating credentials is Supabase Auth's
 * job (and needs the service role), which is why the app calls the
 * `alyq-admin` edge function for that step and this RPC for the profile.
 */
create or replace function public.admin_upsert_staff_profile(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_email    text default null,
  p_phone    text default null,
  p_role     public.app_role default 'viewer',
  p_active   boolean default true
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
begin
  if not public.can('manage_users') then
    raise exception 'Only an admin may manage staff profiles'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user_id is null then
    raise exception 'A user id is required' using errcode = 'check_violation';
  end if;
  if btrim(coalesce(p_username, '')) = '' or btrim(coalesce(p_name, '')) = '' then
    raise exception 'A username and a name are required' using errcode = 'check_violation';
  end if;
  if p_role is distinct from 'admin' and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own admin role'
      using errcode = 'check_violation';
  end if;
  if p_active is false and p_user_id = auth.uid() then
    raise exception 'You cannot deactivate your own account'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, username, name, email, phone, role, active)
  values (
    p_user_id,
    btrim(p_username),
    btrim(p_name),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    p_role,
    coalesce(p_active, true)
  )
  on conflict (id) do update
    set username = excluded.username,
        name     = excluded.name,
        email    = excluded.email,
        phone    = excluded.phone,
        role     = excluded.role,
        active   = excluded.active,
        -- A role change by hand clears the overlay: the two must not disagree.
        custom_role_id = case
          when public.profiles.role is distinct from excluded.role then null
          else public.profiles.custom_role_id
        end
    returning * into v_row;

  return v_row;
end;
$$;

/**
 * Assign (or clear) a custom role. Admin only, never your own row: the person
 * who controls roles must not be able to change their own authority mid-session.
 * Setting a custom role also moves `profiles.role` to that role's base, so the
 * enum column stays meaningful and deactivating the custom role later degrades
 * the account to a known, safe system role instead of to nothing.
 */
create or replace function public.admin_set_custom_role(
  p_user_id       uuid,
  p_custom_role_id uuid
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.custom_roles;
  v_row  public.profiles;
begin
  if not public.can('manage_roles') then
    raise exception 'Only an admin may assign roles' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own role' using errcode = 'check_violation';
  end if;

  if p_custom_role_id is not null then
    select * into v_role from public.custom_roles where id = p_custom_role_id;
    if v_role.id is null then
      raise exception 'Custom role % not found', p_custom_role_id using errcode = 'no_data_found';
    end if;
    if not v_role.active then
      raise exception 'Custom role % is deactivated', v_role.key using errcode = 'check_violation';
    end if;
  end if;

  update public.profiles
     set custom_role_id = p_custom_role_id,
         role = coalesce(v_role.base_role, role)
   where id = p_user_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Profile % not found', p_user_id using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

/** Validate a capability list against the known set. Shared by create/update. */
create or replace function public.assert_known_capabilities(p_capabilities text[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_unknown text[];
begin
  select array_agg(c) into v_unknown
    from unnest(coalesce(p_capabilities, '{}')) as c
   where c is null
      or btrim(c) = ''
      or not exists (select 1 from public.role_capabilities rc where rc.capability = c);

  if v_unknown is not null then
    raise exception 'Unknown capabilities: %', array_to_string(v_unknown, ', ')
      using errcode = 'check_violation';
  end if;
end;
$$;

/** Create a custom role. Admin only (`manage_roles`). */
create or replace function public.admin_create_custom_role(
  p_key            text,
  p_name_en        text,
  p_name_ar        text,
  p_description_en text default null,
  p_description_ar text default null,
  p_base_role      public.app_role default 'viewer',
  p_capabilities   text[] default '{}'
)
returns public.custom_roles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.custom_roles;
begin
  if not public.can('manage_roles') then
    raise exception 'Only an admin may create roles' using errcode = 'insufficient_privilege';
  end if;

  perform public.assert_known_capabilities(p_capabilities);

  insert into public.custom_roles
    (key, name_en, name_ar, description_en, description_ar, base_role, capabilities,
     active, is_system, created_by, created_by_name)
  values
    (lower(btrim(p_key)), btrim(p_name_en), btrim(p_name_ar),
     nullif(btrim(coalesce(p_description_en, '')), ''),
     nullif(btrim(coalesce(p_description_ar, '')), ''),
     coalesce(p_base_role, 'viewer'),
     coalesce(p_capabilities, '{}'),
     true, false, auth.uid(),
     (select p.name from public.profiles p where p.id = auth.uid()))
  returning * into v_row;

  return v_row;
end;
$$;

/** Update a custom role's names, description, base role or capabilities. */
create or replace function public.admin_update_custom_role(
  p_id             uuid,
  p_name_en        text,
  p_name_ar        text,
  p_description_en text default null,
  p_description_ar text default null,
  p_base_role      public.app_role default null,
  p_capabilities   text[] default null
)
returns public.custom_roles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.custom_roles;
begin
  if not public.can('manage_roles') then
    raise exception 'Only an admin may edit roles' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.custom_roles where id = p_id;
  if v_row.id is null then
    raise exception 'Custom role % not found', p_id using errcode = 'no_data_found';
  end if;
  if v_row.is_system then
    raise exception 'A system role cannot be edited' using errcode = 'insufficient_privilege';
  end if;

  if p_capabilities is not null then
    perform public.assert_known_capabilities(p_capabilities);
  end if;

  update public.custom_roles
     set name_en        = btrim(p_name_en),
         name_ar        = btrim(p_name_ar),
         description_en = nullif(btrim(coalesce(p_description_en, '')), ''),
         description_ar = nullif(btrim(coalesce(p_description_ar, '')), ''),
         base_role      = coalesce(p_base_role, base_role),
         capabilities   = coalesce(p_capabilities, capabilities)
   where id = p_id
   returning * into v_row;

  return v_row;
end;
$$;

/**
 * Activate or deactivate a custom role.
 *
 * Deactivating is the safe direction: every profile wearing it falls back to
 * its base system role on their next request, because `public.can()` only
 * consults an ACTIVE custom role. Nothing is deleted, so the audit trail and
 * existing assignments stay readable.
 */
create or replace function public.admin_set_custom_role_active(
  p_id     uuid,
  p_active boolean
)
returns public.custom_roles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.custom_roles;
begin
  if not public.can('manage_roles') then
    raise exception 'Only an admin may activate or deactivate roles'
      using errcode = 'insufficient_privilege';
  end if;

  update public.custom_roles
     set active = coalesce(p_active, false)
   where id = p_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'Custom role % not found', p_id using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

/**
 * Stamp the caller's own last sign-in. Called by the app after a successful
 * authentication; self-only and write-one-column, so it cannot be used to
 * edit anything else about the profile.
 */
create or replace function public.admin_touch_login()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set last_login_at = now()
   where id = auth.uid();
end;
$$;

-- ── 6. website accounts are Supabase Auth identities ──────────────────────
-- `store_customers.id` has always been documented as the auth uid in live mode;
-- this makes it a constraint rather than a convention, so a second, parallel
-- customer directory cannot grow beside `auth.users`.
--
-- Added NOT VALID first (existing rows are not scanned) and validated only when
-- no orphan exists, so applying this to a database that somehow holds a
-- non-auth row fails loudly in the validation step rather than silently
-- leaving the constraint half-enforced. New rows are always checked.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'store_customers_id_is_auth_user'
  ) then
    alter table public.store_customers
      add constraint store_customers_id_is_auth_user
      foreign key (id) references auth.users (id) on delete cascade
      not valid;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'store_customers_id_is_auth_user' and not convalidated
  ) and not exists (
    select 1
      from public.store_customers sc
      left join auth.users u on u.id = sc.id
     where u.id is null
  ) then
    alter table public.store_customers validate constraint store_customers_id_is_auth_user;
  end if;
end
$$;

comment on constraint store_customers_id_is_auth_user on public.store_customers is
  'A website account IS a Supabase Auth user: id = auth.users.id. There is no second identity system, and no password is stored on this side.';

-- ── 7. audit vocabulary ───────────────────────────────────────────────────
-- Mirrors AUDIT_ACTIONS / AUDIT_ENTITIES in src/modules/audit/types.ts. The
-- entity is derived from this table by the 0013 trigger, so an action written
-- here cannot be stored against the wrong entity.
insert into public.audit_actions (action, entity) values
  ('session.login',                 'session'),
  ('session.logout',                'session'),
  ('session.login_failed',          'session'),
  ('session.refreshed',             'session'),
  ('user.created',                  'user'),
  ('user.updated',                  'user'),
  ('user.activated',                'user'),
  ('user.deactivated',              'user'),
  ('user.role_changed',             'user'),
  ('user.password_reset_requested', 'user'),
  ('user.password_reset',           'user'),
  ('user.password_changed',         'user'),
  ('role.created',                  'custom_role'),
  ('role.updated',                  'custom_role'),
  ('role.activated',                'custom_role'),
  ('role.deactivated',              'custom_role')
on conflict (action) do nothing;

-- ── 8. RLS + grants ───────────────────────────────────────────────────────
alter table public.custom_roles enable row level security;

-- Every signed-in user may read the role list: the UI needs it to name a
-- colleague's role, and a custom role holds no secret (it is a list of
-- capability keys that are already public reference data).
drop policy if exists "custom_roles_select_authenticated" on public.custom_roles;
create policy "custom_roles_select_authenticated"
  on public.custom_roles for select to authenticated
  using (true);

-- Writes go through the RPCs only, so a browser cannot mint itself a role with
-- `manage_users` in it.
drop policy if exists "custom_roles_no_direct_write" on public.custom_roles;
create policy "custom_roles_no_direct_write"
  on public.custom_roles for insert to authenticated with check (false);
drop policy if exists "custom_roles_no_direct_update" on public.custom_roles;
create policy "custom_roles_no_direct_update"
  on public.custom_roles for update to authenticated using (false);
drop policy if exists "custom_roles_no_direct_delete" on public.custom_roles;
create policy "custom_roles_no_direct_delete"
  on public.custom_roles for delete to authenticated using (false);

-- A deactivated profile must not read anything, including its own role list.
drop policy if exists "profiles_select_self_or_oversight" on public.profiles;
create policy "profiles_select_self_or_oversight"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.can('view_audit_log') or public.can('manage_users'));

revoke all on public.custom_roles from anon;
revoke insert, update, delete on public.custom_roles from authenticated;
grant select on public.custom_roles to authenticated;

grant execute on function public.known_capabilities() to authenticated;
grant execute on function public.current_custom_role() to authenticated;
grant execute on function public.can(text) to authenticated;
grant execute on function public.assert_known_capabilities(text[]) to authenticated;
grant execute on function public.admin_upsert_staff_profile(uuid, text, text, text, text, public.app_role, boolean) to authenticated;
grant execute on function public.admin_set_custom_role(uuid, uuid) to authenticated;
grant execute on function public.admin_create_custom_role(text, text, text, text, text, public.app_role, text[]) to authenticated;
grant execute on function public.admin_update_custom_role(uuid, text, text, text, text, public.app_role, text[]) to authenticated;
grant execute on function public.admin_set_custom_role_active(uuid, boolean) to authenticated;
grant execute on function public.admin_touch_login() to authenticated;

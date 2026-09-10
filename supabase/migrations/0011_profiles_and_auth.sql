-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0011
-- Production readiness — staff identity, roles and the capability model.
--
-- Design:
--   * `app_role`      — the five roles the app recognises, exactly as
--                       `src/lib/permissions/roles.ts` defines them;
--   * `profiles`      — one row per Supabase Auth user: the display name, the
--                       username used at the sign-in screen and the role. The
--                       id IS the `auth.users` id, so `auth.uid()` identifies
--                       a row without a second lookup.
--   * `role_capabilities` — the role → capability matrix, in the database.
--                       Every RLS policy below asks `public.can('…')` rather
--                       than listing roles, so authorisation has ONE definition
--                       and the policies cannot drift from the UI matrix.
--                       `scripts/migrations.check.mjs` compares this table
--                       against `ROLE_CAPABILITIES` in TypeScript and fails on
--                       any difference.
--
-- Fail-closed by construction: an unknown role, a missing profile or a
-- deactivated profile yields no capabilities, so a policy denies. There is no
-- "default allow" path.
--
-- Writes to `profiles` are deny-all through RLS; the only writers are the
-- SECURITY DEFINER RPCs at the end of this file (admin-guarded) and the
-- new-user trigger in 0014.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── app_role enum ─────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'manager', 'cashier', 'inventory_clerk', 'viewer');
  end if;
end
$$;

-- ── profiles ──────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  name       text not null,
  role       public.app_role not null default 'viewer',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_username_not_blank check (btrim(username) <> ''),
  constraint profiles_username_len       check (char_length(username) <= 64),
  constraint profiles_name_not_blank     check (btrim(name) <> ''),
  constraint profiles_name_len           check (char_length(name) <= 120)
);

-- Usernames are compared case- and whitespace-insensitively: the sign-in screen
-- takes a username, and two accounts differing only in case would be a trap.
create unique index if not exists profiles_username_key
  on public.profiles (lower(btrim(username)));

create index if not exists profiles_role_idx   on public.profiles (role);
create index if not exists profiles_active_idx on public.profiles (active) where active;

comment on table public.profiles is
  'One row per Supabase Auth user: display name, sign-in username and app role. id = auth.users.id.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ── capability matrix ─────────────────────────────────────────────────────
-- Mirrors ROLE_CAPABILITIES in src/lib/permissions/roles.ts. Keeping it in a
-- table (rather than inlined in each policy) means the mapping is data: it can
-- be reviewed in one place, and the migration check can diff it against the
-- TypeScript that the UI actually uses.
create table if not exists public.role_capabilities (
  role       public.app_role not null,
  capability text not null,
  primary key (role, capability)
);

comment on table public.role_capabilities is
  'role → capability grants. Mirrors ROLE_CAPABILITIES in src/lib/permissions/roles.ts; verified by scripts/migrations.check.mjs.';

-- Idempotent seed of the matrix as it stands today.
insert into public.role_capabilities (role, capability) values
  -- admin and manager hold every capability
  ('admin',   'view_inventory'),
  ('admin',   'adjust_stock'),
  ('admin',   'sell'),
  ('admin',   'apply_discount'),
  ('admin',   'void_sale'),
  ('admin',   'confirm_payment'),
  ('admin',   'process_return'),
  ('admin',   'process_refund'),
  ('admin',   'open_shift'),
  ('admin',   'close_shift'),
  ('admin',   'add_expense'),
  ('admin',   'edit_expense'),
  ('admin',   'delete_expense'),
  ('admin',   'view_shifts'),
  ('admin',   'approve_shift_adjustment'),
  ('admin',   'view_audit_log'),
  ('manager', 'view_inventory'),
  ('manager', 'adjust_stock'),
  ('manager', 'sell'),
  ('manager', 'apply_discount'),
  ('manager', 'void_sale'),
  ('manager', 'confirm_payment'),
  ('manager', 'process_return'),
  ('manager', 'process_refund'),
  ('manager', 'open_shift'),
  ('manager', 'close_shift'),
  ('manager', 'add_expense'),
  ('manager', 'edit_expense'),
  ('manager', 'delete_expense'),
  ('manager', 'view_shifts'),
  ('manager', 'approve_shift_adjustment'),
  ('manager', 'view_audit_log'),
  -- cashier runs the till: no discount, no void, no stock, no audit, no
  -- expense editing or deletion
  ('cashier', 'view_inventory'),
  ('cashier', 'sell'),
  ('cashier', 'confirm_payment'),
  ('cashier', 'process_return'),
  ('cashier', 'process_refund'),
  ('cashier', 'open_shift'),
  ('cashier', 'close_shift'),
  ('cashier', 'add_expense'),
  ('cashier', 'view_shifts'),
  -- inventory clerk adds stock authority on top of the till
  ('inventory_clerk', 'view_inventory'),
  ('inventory_clerk', 'adjust_stock'),
  ('inventory_clerk', 'sell'),
  ('inventory_clerk', 'confirm_payment'),
  ('inventory_clerk', 'process_return'),
  ('inventory_clerk', 'process_refund'),
  ('inventory_clerk', 'open_shift'),
  ('inventory_clerk', 'close_shift'),
  ('inventory_clerk', 'add_expense'),
  ('inventory_clerk', 'view_shifts'),
  -- viewer is read-only
  ('viewer', 'view_inventory'),
  ('viewer', 'view_shifts')
on conflict (role, capability) do nothing;

-- ── role resolution ───────────────────────────────────────────────────────
-- SECURITY DEFINER so a policy can call it without recursing into the
-- profiles RLS policies, and so the caller's own row is always readable —
-- including while RLS is evaluating another table.
create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
    from public.profiles p
   where p.id = auth.uid()
     and p.active
$$;

comment on function public.current_user_role() is
  'Role of the authenticated caller, or NULL when there is no active profile (fail closed).';

create or replace function public.current_user_profile()
returns table (id uuid, username text, name text, role public.app_role)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.name, p.role
    from public.profiles p
   where p.id = auth.uid()
     and p.active
$$;

/** Pure lookup — "does this role hold this capability?" */
create or replace function public.role_can(p_role public.app_role, p_capability text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.role_capabilities rc
     where rc.role = p_role
       and rc.capability = p_capability
  )
$$;

/**
 * The one question every policy asks: "may the caller do this?"
 * NULL role (no profile / inactive / anonymous) → false.
 */
create or replace function public.can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.role_can(public.current_user_role(), p_capability)
$$;

comment on function public.can(text) is
  'Capability check for RLS policies. Unknown capability or missing profile denies.';

-- ── RLS: read your own profile (or everyone's, with oversight rights) ─────
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_self_or_oversight" on public.profiles;
create policy "profiles_select_self_or_oversight"
  on public.profiles for select to authenticated
  using (id = auth.uid() or public.can('view_audit_log'));

-- No insert / update / delete policy: direct writes are refused. Everything
-- goes through the RPCs below, so a browser cannot promote itself.
drop policy if exists "profiles_no_direct_write" on public.profiles;
create policy "profiles_no_direct_write"
  on public.profiles for insert to authenticated with check (false);
drop policy if exists "profiles_no_direct_update" on public.profiles;
create policy "profiles_no_direct_update"
  on public.profiles for update to authenticated using (false);
drop policy if exists "profiles_no_direct_delete" on public.profiles;
create policy "profiles_no_direct_delete"
  on public.profiles for delete to authenticated using (false);

alter table public.role_capabilities enable row level security;

-- The matrix is read-only reference data: readable by any signed-in user (the
-- UI uses it to decide what to hide), writable by nobody through the API.
drop policy if exists "role_capabilities_select_authenticated" on public.role_capabilities;
create policy "role_capabilities_select_authenticated"
  on public.role_capabilities for select to authenticated using (true);
drop policy if exists "role_capabilities_no_direct_write" on public.role_capabilities;
create policy "role_capabilities_no_direct_write"
  on public.role_capabilities for insert to authenticated with check (false);
drop policy if exists "role_capabilities_no_direct_update" on public.role_capabilities;
create policy "role_capabilities_no_direct_update"
  on public.role_capabilities for update to authenticated using (false);

-- ── RPCs: the only way to write a profile ─────────────────────────────────
/**
 * Create or update a staff profile. Admin only, and refused for the caller's
 * own row when the change would drop admin — an installation cannot lock
 * itself out of role management.
 */
create or replace function public.upsert_staff_profile(
  p_user_id  uuid,
  p_username text,
  p_name     text,
  p_role     public.app_role,
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
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may manage staff profiles'
      using errcode = 'insufficient_privilege';
  end if;

  if p_user_id is null then
    raise exception 'A user id is required' using errcode = 'check_violation';
  end if;

  if p_role is distinct from 'admin' and p_user_id = auth.uid() then
    raise exception 'You cannot remove your own admin role'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, username, name, role, active)
  values (p_user_id, btrim(p_username), btrim(p_name), p_role, coalesce(p_active, true))
  on conflict (id) do update
    set username = excluded.username,
        name     = excluded.name,
        role     = excluded.role,
        active   = excluded.active
  returning * into v_row;

  return v_row;
end;
$$;

/** Change one profile's role. Admin only, never your own. */
create or replace function public.set_staff_role(p_user_id uuid, p_role public.app_role)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may change roles' using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own role' using errcode = 'check_violation';
  end if;

  update public.profiles set role = p_role where id = p_user_id returning * into v_row;
  if v_row.id is null then
    raise exception 'Profile % not found', p_user_id using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

/** Activate / deactivate a profile. Admin only, never your own. */
create or replace function public.set_staff_active(p_user_id uuid, p_active boolean)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.profiles;
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Only an admin may activate or deactivate staff'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot deactivate your own account' using errcode = 'check_violation';
  end if;

  update public.profiles set active = p_active where id = p_user_id returning * into v_row;
  if v_row.id is null then
    raise exception 'Profile % not found', p_user_id using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;

-- ── grants ────────────────────────────────────────────────────────────────
-- Defence in depth: Supabase grants broad default privileges on new tables in
-- `public`, so the grants are stated explicitly rather than assumed, and the
-- write privileges are removed here as well as blocked by RLS.
revoke all on public.profiles from anon;
revoke all on public.role_capabilities from anon;
revoke insert, update, delete on public.profiles from authenticated;
revoke insert, update, delete on public.role_capabilities from authenticated;

grant select on public.profiles to authenticated;
grant select on public.role_capabilities to authenticated;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_user_profile() to authenticated;
grant execute on function public.role_can(public.app_role, text) to authenticated;
grant execute on function public.can(text) to authenticated;
grant execute on function public.upsert_staff_profile(uuid, text, text, public.app_role, boolean) to authenticated;
grant execute on function public.set_staff_role(uuid, public.app_role) to authenticated;
grant execute on function public.set_staff_active(uuid, boolean) to authenticated;

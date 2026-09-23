-- 0059 — last effective manage_users holder.
--
-- Phase 58. Not deployed. Migrations through 0058 are unchanged.
--
-- 0021 already refuses a caller who would lock *themselves* out. This adds the
-- other half: a write that would leave the installation with nobody who holds
-- manage_users, counted the same way public.can() counts it (deny first, extra
-- grant, active custom role absolute, otherwise the shipped matrix).
--
-- The check is deferred so a restore that deletes every row and inserts the
-- snapshot back in the same transaction is judged on the restored directory,
-- not on the empty moment in the middle. It does not grant a backdoor account.

create or replace function public.profile_holds_capability(p_user_id uuid, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_active boolean;
  v_role public.app_role;
  v_extra text[];
  v_denied text[];
  v_custom uuid;
  v_role_active boolean;
  v_caps text[];
begin
  select p.active, p.role, p.extra_capabilities, p.denied_capabilities, p.custom_role_id
    into v_active, v_role, v_extra, v_denied, v_custom
    from public.profiles p
   where p.id = p_user_id;

  if not found or not coalesce(v_active, false) then
    return false;
  end if;
  if p_capability = any (coalesce(v_denied, '{}')) then
    return false;
  end if;
  if p_capability = any (coalesce(v_extra, '{}')) then
    return true;
  end if;

  if v_custom is not null then
    select cr.active, cr.capabilities
      into v_role_active, v_caps
      from public.custom_roles cr
     where cr.id = v_custom;
    if found and coalesce(v_role_active, false) then
      return p_capability = any (coalesce(v_caps, '{}'));
    end if;
  end if;

  return exists (
    select 1
      from public.role_capabilities rc
     where rc.role = v_role
       and rc.capability = p_capability
  );
end;
$$;

create or replace function public.count_capability_holders(p_capability text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.profiles p
   where public.profile_holds_capability(p.id, p_capability);
$$;

create or replace function public.assert_manage_users_remains()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.count_capability_holders('manage_users') < 1 then
    raise exception 'This change would leave nobody able to manage users'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_keep_manage_users on public.profiles;
create constraint trigger profiles_keep_manage_users
  after insert or update or delete on public.profiles
  deferrable initially deferred
  for each row
  execute function public.assert_manage_users_remains();

drop trigger if exists custom_roles_keep_manage_users on public.custom_roles;
create constraint trigger custom_roles_keep_manage_users
  after update or delete on public.custom_roles
  deferrable initially deferred
  for each row
  execute function public.assert_manage_users_remains();

revoke all on function public.profile_holds_capability(uuid, text) from public, anon, authenticated;
revoke all on function public.count_capability_holders(text) from public, anon, authenticated;
revoke all on function public.assert_manage_users_remains() from public, anon, authenticated;

comment on function public.profile_holds_capability(uuid, text) is
  'Phase 58: does this profile hold the capability, using the same precedence as public.can()? Not a grant.';
comment on function public.assert_manage_users_remains() is
  'Phase 58: deferred refusal when a write would leave zero manage_users holders. Not a backdoor.';

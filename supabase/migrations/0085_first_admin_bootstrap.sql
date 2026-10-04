-- 0085 — Safely bootstrap the first production admin.
--
-- A fresh production project has a chicken-and-egg problem that development
-- never meets, because every development path runs `seed.sql` (which creates
-- an active admin) before anybody signs in:
--
--   · an account created without role metadata becomes an INACTIVE VIEWER
--     (0014, fail closed) — correct, but on a brand-new directory the 0059
--     last-manage_users-holder guard then refuses that very INSERT, because
--     the transaction commits with zero manage_users holders. The operator
--     cannot even create the account they meant to promote.
--   · and if such an account does exist, nothing can promote it: every staff
--     RPC is admin-gated, and there is no admin yet.
--
-- Two changes, both closed the moment the installation is managed:
--
--   1. `assert_manage_users_remains()` ignores INSERTs. Inserting a profile
--      can only ever ADD a capability holder; it cannot take `manage_users`
--      away from anyone. The guard still refuses any UPDATE or DELETE that
--      would leave nobody able to manage users — the 0059 promise is intact,
--      including the deferred restore-from-backup path.
--
--   2. `bootstrap_first_admin()` promotes the CALLER to an active admin,
--      exactly once, and only on a directory that has never been managed: it
--      refuses while any admin profile row exists (active or not — the
--      reactivation of a parked admin is an admin decision, not a bootstrap)
--      or while anyone currently holds `manage_users`. Concurrent callers are
--      serialized with a transaction-scoped advisory lock so two sessions
--      cannot both observe the empty directory and both leave as admins, and
--      the promotion is written to the audit trail (`user.role_changed`, an
--      action the vocabulary already carries).
--
-- No historical migration file is modified; both functions are redefined
-- here. Nothing in this migration touches data on an installation that
-- already has an administrator.

begin;

-- ── 1. the 0059 guard learns that an INSERT removes nothing ───────────────
create or replace function public.assert_manage_users_remains()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- An INSERT can only add a capability holder; it can never take
  -- `manage_users` away from anybody. Guarding it blocked the FIRST account
  -- on a fresh production project (the fail-closed inactive viewer of 0014).
  if tg_op = 'INSERT' then
    return null;
  end if;

  if public.count_capability_holders('manage_users') < 1 then
    raise exception 'This change would leave nobody able to manage users'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

comment on function public.assert_manage_users_remains() is
  'Deferred guard (0059, relaxed for INSERT in 0085): refuses any UPDATE or DELETE that would leave the installation with nobody who effectively holds manage_users. INSERTs pass — a new row cannot remove a capability from anyone.';

-- ── 2. the one sanctioned way to the first admin seat ─────────────────────
create or replace function public.bootstrap_first_admin()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text;
  v_meta     jsonb;
  v_username text;
  v_name     text;
  v_prev     public.app_role;
  v_row      public.profiles;
begin
  if v_uid is null then
    raise exception 'Sign in before claiming the first admin seat'
      using errcode = 'insufficient_privilege';
  end if;

  -- One caller at a time: without this, two concurrent sessions could both
  -- observe the never-managed directory and both leave as admins.
  perform pg_advisory_xact_lock(hashtext('public.bootstrap_first_admin')::bigint);

  -- Closed the moment the installation is managed. Any admin row — even a
  -- deactivated one — or any current manage_users holder means the normal,
  -- admin-gated path exists and must be used instead.
  if exists (select 1 from public.profiles p where p.role = 'admin')
     or public.count_capability_holders('manage_users') > 0 then
    raise exception 'This installation already has an administrator; bootstrap is closed'
      using errcode = 'check_violation';
  end if;

  select u.email,
         coalesce(u.raw_user_meta_data, '{}'::jsonb) || coalesce(u.raw_app_meta_data, '{}'::jsonb)
    into v_email, v_meta
    from auth.users u
   where u.id = v_uid;
  if not found then
    raise exception 'No auth account exists for this session'
      using errcode = 'no_data_found';
  end if;

  select p.role into v_prev from public.profiles p where p.id = v_uid;

  if found then
    update public.profiles
       set role = 'admin', active = true
     where id = v_uid
    returning * into v_row;
  else
    -- The same resolution 0014 uses, so the row looks as if the signup
    -- trigger had made it — metadata first, e-mail local part, then the id.
    v_username := nullif(btrim(coalesce(v_meta->>'username', '')), '');
    if v_username is null then
      v_username := nullif(split_part(coalesce(v_email, ''), '@', 1), '');
    end if;
    if v_username is null then
      v_username := 'user-' || substr(v_uid::text, 1, 8);
    end if;
    v_name := coalesce(nullif(btrim(coalesce(v_meta->>'name', '')), ''), v_username);

    begin
      insert into public.profiles (id, username, name, role, active)
      values (v_uid, v_username, v_name, 'admin', true)
      returning * into v_row;
    exception when unique_violation then
      insert into public.profiles (id, username, name, role, active)
      values (v_uid, v_username || '-' || substr(v_uid::text, 1, 4), v_name, 'admin', true)
      returning * into v_row;
    end;
  end if;

  -- The seat-claiming is on the record, with the action the vocabulary
  -- already knows; the 0013/0071 trigger stamps identity and branch context.
  insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
  values (
    'user.role_changed',
    v_uid::text,
    v_row.username,
    jsonb_build_object(
      'via',           'bootstrap_first_admin',
      'previous_role', v_prev,
      'new_role',      'admin'
    ),
    v_uid::text,
    v_row.name
  );

  return v_row;
end;
$$;

comment on function public.bootstrap_first_admin() is
  'Claim the first admin seat on a never-managed installation: promotes the caller to an active admin exactly once. Refuses while any admin profile row exists or anyone holds manage_users, serializes concurrent callers with an advisory lock, and writes the promotion to the audit trail.';

revoke all on function public.bootstrap_first_admin() from public;
revoke all on function public.bootstrap_first_admin() from anon;
grant execute on function public.bootstrap_first_admin() to authenticated;

commit;

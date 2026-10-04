-- ═══════════════════════════════════════════════════════════════════════════
-- 0071 · Branch-scoped identity, authorization and audit context
-- ═══════════════════════════════════════════════════════════════════════════
-- One authenticated identity may wear a different existing role/custom-role at
-- each branch.  public.can() remains the only authorization question: it now
-- resolves the active branch membership before applying the existing absolute
-- custom-role overlay and per-user grant/deny precedence.
--
-- Existing installations are migrated to one deterministic Main Branch with a
-- membership equivalent to every active profile's current authority.  No
-- existing account is locked out.  Operational/financial rows gain a real
-- branch key and RLS compares that key with the server-resolved active branch;
-- a browser-supplied branch id is never authoritative.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.branches (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  name_en     text not null,
  name_ar     text not null,
  active      boolean not null default true,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint branches_code_shape check (code ~ '^[a-z][a-z0-9_-]{1,30}$'),
  constraint branches_name_en_not_blank check (btrim(name_en) <> ''),
  constraint branches_name_ar_not_blank check (btrim(name_ar) <> '')
);
create unique index if not exists branches_code_key on public.branches (lower(code));
create unique index if not exists branches_one_default on public.branches ((is_default)) where is_default;
drop trigger if exists branches_set_updated_at on public.branches;
create trigger branches_set_updated_at before update on public.branches
  for each row execute function public.set_updated_at();

insert into public.branches (id, code, name_en, name_ar, active, is_default)
values ('00000000-0000-4000-8000-0000000000b1', 'main', 'Main Branch', 'الفرع الرئيسي', true, true)
on conflict (id) do update set is_default = true, active = true;

alter table public.profiles
  add column if not exists active_branch_id uuid references public.branches(id) on delete restrict;

create table if not exists public.branch_memberships (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,
  branch_id             uuid not null references public.branches(id) on delete cascade,
  role                   public.app_role not null,
  custom_role_id         uuid references public.custom_roles(id) on delete set null,
  extra_capabilities     text[] not null default '{}',
  denied_capabilities    text[] not null default '{}',
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint branch_membership_unique unique (user_id, branch_id),
  constraint branch_membership_exceptions_disjoint
    check (not (extra_capabilities && denied_capabilities))
);
create index if not exists branch_memberships_branch_idx
  on public.branch_memberships(branch_id, active, user_id);
create index if not exists branch_memberships_user_idx
  on public.branch_memberships(user_id, active, branch_id);
drop trigger if exists branch_memberships_set_updated_at on public.branch_memberships;
create trigger branch_memberships_set_updated_at before update on public.branch_memberships
  for each row execute function public.set_updated_at();

-- Preserve every current profile exactly at Main Branch.
insert into public.branch_memberships (
  user_id, branch_id, role, custom_role_id, extra_capabilities, denied_capabilities, active
)
select p.id, '00000000-0000-4000-8000-0000000000b1'::uuid, p.role,
       p.custom_role_id, p.extra_capabilities, p.denied_capabilities, p.active
  from public.profiles p
on conflict (user_id, branch_id) do nothing;

update public.profiles
   set active_branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid
 where active_branch_id is null;

-- New profiles inherit their existing global/default authority at Main Branch.
create or replace function public.sync_default_branch_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default uuid;
begin
  select id into v_default from public.branches where is_default limit 1;
  if v_default is null then return new; end if;

  insert into public.branch_memberships (
    user_id, branch_id, role, custom_role_id, extra_capabilities, denied_capabilities, active
  ) values (
    new.id, v_default, new.role, new.custom_role_id,
    coalesce(new.extra_capabilities, '{}'), coalesce(new.denied_capabilities, '{}'), new.active
  )
  on conflict (user_id, branch_id) do update set
    role = excluded.role,
    custom_role_id = excluded.custom_role_id,
    extra_capabilities = excluded.extra_capabilities,
    denied_capabilities = excluded.denied_capabilities,
    active = excluded.active;

  if new.active_branch_id is null then
    update public.profiles set active_branch_id = v_default where id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_sync_default_branch on public.profiles;
create trigger profiles_sync_default_branch
  after insert or update of role, custom_role_id, extra_capabilities, denied_capabilities, active
  on public.profiles for each row execute function public.sync_default_branch_membership();

-- ── Branch-aware authority: same public.can(), no parallel permission model ─
create or replace function public.current_branch_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.active_branch_id
    from public.profiles p
    join public.branches b on b.id = p.active_branch_id and b.active
    join public.branch_memberships m
      on m.user_id = p.id and m.branch_id = b.id and m.active
   where p.id = auth.uid() and p.active
$$;

create or replace function public.branch_member_can(
  p_user_id uuid,
  p_branch_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with member as (
    select m.role, m.extra_capabilities, m.denied_capabilities,
           cr.capabilities as custom_capabilities
      from public.branch_memberships m
      join public.profiles p on p.id = m.user_id and p.active
      join public.branches b on b.id = m.branch_id and b.active
      left join public.custom_roles cr on cr.id = m.custom_role_id and cr.active
     where m.user_id = p_user_id and m.branch_id = p_branch_id and m.active
  )
  select coalesce((
    select case
      when p_capability = any(coalesce(denied_capabilities, '{}')) then false
      when p_capability = any(coalesce(extra_capabilities, '{}')) then true
      when custom_capabilities is not null then p_capability = any(custom_capabilities)
      else public.role_can(role, p_capability)
    end
    from member
  ), false)
$$;

-- Safe RLS predicates bound to auth.uid(). Unlike the internal
-- branch_member_can(user, branch, capability) helper, callers cannot use these
-- to probe another person's authority.
create or replace function public.can_access_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.branch_memberships m
    join public.profiles p on p.id=m.user_id and p.active
    join public.branches b on b.id=m.branch_id and b.active
    where m.user_id=auth.uid() and m.branch_id=p_branch_id and m.active
  )
$$;

create or replace function public.can_manage_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.branch_member_can(auth.uid(), p_branch_id, 'manage_users')
$$;

create or replace function public.current_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select m.role
    from public.profiles p
    join public.branch_memberships m
      on m.user_id = p.id and m.branch_id = p.active_branch_id and m.active
    join public.branches b on b.id = m.branch_id and b.active
   where p.id = auth.uid() and p.active
$$;

create or replace function public.current_user_profile()
returns table (id uuid, username text, name text, role public.app_role)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.name, m.role
    from public.profiles p
    join public.branch_memberships m
      on m.user_id = p.id and m.branch_id = p.active_branch_id and m.active
    join public.branches b on b.id = m.branch_id and b.active
   where p.id = auth.uid() and p.active
$$;

create or replace function public.current_user_capabilities()
returns table (capability text)
language sql
stable
security definer
set search_path = public
as $$
  with member as (
    select m.role, m.extra_capabilities, m.denied_capabilities,
           cr.capabilities as custom_capabilities
      from public.profiles p
      join public.branch_memberships m
        on m.user_id = p.id and m.branch_id = p.active_branch_id and m.active
      join public.branches b on b.id = m.branch_id and b.active
      left join public.custom_roles cr on cr.id = m.custom_role_id and cr.active
     where p.id = auth.uid() and p.active
  ), base as (
    select case when custom_capabilities is not null then custom_capabilities
      else coalesce((select array_agg(rc.capability)
                       from public.role_capabilities rc
                      where rc.role = member.role), '{}') end as caps,
           extra_capabilities, denied_capabilities
      from member
  )
  select c.capability
    from base
    cross join lateral (
      select unnest(base.caps) as capability
      union select unnest(base.extra_capabilities)
      except select unnest(base.denied_capabilities)
    ) c
$$;

create or replace function public.can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.branch_member_can(auth.uid(), public.current_branch_id(), p_capability)
$$;

-- A compact trusted identity document for the client after login/branch switch.
create or replace function public.get_active_branch_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'branch_id', b.id,
    'branch_code', b.code,
    'branch_name_en', b.name_en,
    'branch_name_ar', b.name_ar,
    'role', m.role,
    'custom_role_id', m.custom_role_id,
    'custom_role_name', coalesce(cr.name_en, cr.name_ar),
    'capabilities', coalesce((select jsonb_agg(c.capability order by c.capability)
                                from public.current_user_capabilities() c), '[]'::jsonb)
  ) into v_result
  from public.profiles p
  join public.branch_memberships m
    on m.user_id = p.id and m.branch_id = p.active_branch_id and m.active
  join public.branches b on b.id = m.branch_id and b.active
  left join public.custom_roles cr on cr.id = m.custom_role_id and cr.active
  where p.id = auth.uid() and p.active;
  return v_result;
end;
$$;

create or replace function public.get_my_branches()
returns table (
  id uuid, code text, name_en text, name_ar text, role public.app_role,
  custom_role_id uuid, custom_role_name text, active boolean, is_current boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select b.id, b.code, b.name_en, b.name_ar, m.role, m.custom_role_id,
         coalesce(cr.name_en, cr.name_ar), b.active and m.active,
         p.active_branch_id = b.id
    from public.profiles p
    join public.branch_memberships m on m.user_id = p.id and m.active
    join public.branches b on b.id = m.branch_id and b.active
    left join public.custom_roles cr on cr.id = m.custom_role_id and cr.active
   where p.id = auth.uid() and p.active
   order by b.is_default desc, b.name_en
$$;

create or replace function public.switch_active_branch(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.branch_memberships m
    join public.branches b on b.id = m.branch_id and b.active
    join public.profiles p on p.id = m.user_id and p.active
    where m.user_id = auth.uid() and m.branch_id = p_branch_id and m.active
  ) then
    raise exception 'You do not have access to this branch'
      using errcode = 'insufficient_privilege';
  end if;
  update public.profiles set active_branch_id = p_branch_id where id = auth.uid();
  return public.get_active_branch_context();
end;
$$;

-- ── Structured, secret-safe audit context ─────────────────────────────────
alter table public.audit_log
  add column if not exists approver_id text,
  add column if not exists approver_name text,
  add column if not exists branch_id uuid references public.branches(id) on delete restrict,
  add column if not exists branch_name text,
  add column if not exists module text,
  add column if not exists correlation_id text,
  add column if not exists before_state jsonb,
  add column if not exists after_state jsonb,
  add column if not exists reason text;
create index if not exists audit_log_branch_idx on public.audit_log(branch_id, created_at desc);
create index if not exists audit_log_approver_idx on public.audit_log(approver_id, created_at desc);
create index if not exists audit_log_correlation_idx on public.audit_log(correlation_id) where correlation_id is not null;

create or replace function public.audit_sanitize(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value)='object' then
    select coalesce(jsonb_object_agg(e.key,public.audit_sanitize(e.value)),'{}'::jsonb)
      into v_result from jsonb_each(p_value) e
     where lower(e.key) not in(
       'password','password_hash','pin','manager_pin','pin_hash','manager_pin_hash',
       'access_token','refresh_token','token','secret','payment_credentials');
    return v_result;
  elsif jsonb_typeof(p_value)='array' then
    select coalesce(jsonb_agg(public.audit_sanitize(e.value)),'[]'::jsonb)
      into v_result from jsonb_array_elements(p_value) e;
    return v_result;
  end if;
  return p_value;
end;
$$;

create or replace function public.enforce_audit_log_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text;
  v_uid text := auth.uid()::text;
  v_name text;
  v_branch uuid;
  v_branch_name text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'The audit log is append-only; update is not permitted'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then
    -- Preserve the pre-existing, capability-checked retention purge. Selective
    -- cleanup never sets this transaction-local flag and can never delete audit.
    if current_setting('alyq.audit_purge', true) = 'on' then return old; end if;
    raise exception 'The audit log is append-only; delete is not permitted'
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
    new.user_name := coalesce(v_name, new.user_name);
    v_branch := public.current_branch_id();
    if new.branch_id is null then new.branch_id := v_branch; end if;
  end if;
  if new.branch_id is not null then
    select coalesce(b.name_en, b.name_ar) into v_branch_name from public.branches b where b.id = new.branch_id;
    new.branch_name := coalesce(new.branch_name, v_branch_name);
  end if;
  new.details := coalesce(public.audit_sanitize(new.details), '{}'::jsonb);
  new.before_state := public.audit_sanitize(new.before_state);
  new.after_state := public.audit_sanitize(new.after_state);
  return new;
end;
$$;

insert into public.audit_actions(action, entity) values
  ('branch.created', 'branch'),
  ('branch.access_changed', 'branch_membership'),
  ('branch.switched', 'branch')
on conflict (action) do nothing;

-- Branch switch auditing is separate so get_active_branch_context stays stable.
create or replace function public.switch_active_branch_with_audit(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before uuid := public.current_branch_id();
  v_context jsonb;
  v_name text;
begin
  v_context := public.switch_active_branch(p_branch_id);
  select name into v_name from public.profiles where id = auth.uid();
  insert into public.audit_log(
    action, entity, entity_id, entity_label, details, user_id, user_name,
    branch_id, module, correlation_id, before_state, after_state
  ) values (
    'branch.switched', 'branch', p_branch_id::text,
    coalesce(v_context->>'branch_name_en', v_context->>'branch_name_ar', p_branch_id::text),
    '{}'::jsonb, auth.uid()::text, coalesce(v_name, 'Staff'), p_branch_id, 'identity',
    gen_random_uuid()::text,
    jsonb_build_object('branch_id', v_before), jsonb_build_object('branch_id', p_branch_id)
  );
  return v_context;
end;
$$;

create or replace function public.admin_create_branch(
  p_code text, p_name_en text, p_name_ar text
)
returns public.branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch public.branches;
  v_member public.branch_memberships;
  v_name text;
begin
  if not public.can('manage_settings') or not public.can('manage_users') then
    raise exception 'You may not create branches' using errcode = 'insufficient_privilege';
  end if;
  insert into public.branches(code, name_en, name_ar)
  values (lower(btrim(p_code)), btrim(p_name_en), btrim(p_name_ar))
  returning * into v_branch;

  select * into v_member from public.branch_memberships
   where user_id = auth.uid() and branch_id = public.current_branch_id();
  insert into public.branch_memberships(
    user_id, branch_id, role, custom_role_id, extra_capabilities, denied_capabilities, active
  ) values (
    auth.uid(), v_branch.id, v_member.role, v_member.custom_role_id,
    v_member.extra_capabilities, v_member.denied_capabilities, true
  );
  select name into v_name from public.profiles where id = auth.uid();
  insert into public.audit_log(action, entity, entity_id, entity_label, details, user_id, user_name, branch_id, module)
  values ('branch.created', 'branch', v_branch.id::text, v_branch.name_en,
          jsonb_build_object('code', v_branch.code), auth.uid()::text, coalesce(v_name,'Staff'),
          v_branch.id, 'identity');
  return v_branch;
end;
$$;

create or replace function public.admin_set_branch_membership(
  p_user_id uuid,
  p_branch_id uuid,
  p_role public.app_role,
  p_custom_role_id uuid default null,
  p_extra text[] default '{}',
  p_denied text[] default '{}',
  p_active boolean default true
)
returns public.branch_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.branch_memberships;
  v_before public.branch_memberships;
  v_custom public.custom_roles;
  v_extra text[];
  v_denied text[];
  v_actor_name text;
  v_target_name text;
  v_new_can_manage boolean;
begin
  if not public.branch_member_can(auth.uid(), p_branch_id, 'manage_users') then
    raise exception 'You may not manage access to this branch' using errcode = 'insufficient_privilege';
  end if;
  if not exists(select 1 from public.profiles where id = p_user_id) then
    raise exception 'No such user' using errcode = 'no_data_found';
  end if;
  if not exists(select 1 from public.branches where id = p_branch_id and active) then
    raise exception 'No such active branch' using errcode = 'no_data_found';
  end if;
  if p_custom_role_id is not null then
    select * into v_custom from public.custom_roles where id = p_custom_role_id and active;
    if v_custom.id is null then raise exception 'No such active custom role' using errcode = 'no_data_found'; end if;
    p_role := v_custom.base_role;
  end if;
  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}') into v_extra
    from unnest(coalesce(p_extra,'{}')) x where btrim(x) <> '';
  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}') into v_denied
    from unnest(coalesce(p_denied,'{}')) x where btrim(x) <> '';
  perform public.assert_known_capabilities(v_extra);
  perform public.assert_known_capabilities(v_denied);
  select coalesce(array_agg(x order by x), '{}') into v_extra
    from unnest(v_extra) x where not (x = any(v_denied));

  v_new_can_manage := p_active
    and not ('manage_users' = any(v_denied))
    and (
      'manage_users' = any(v_extra)
      or (v_custom.id is not null and 'manage_users' = any(coalesce(v_custom.capabilities,'{}')))
      or (v_custom.id is null and public.role_can(p_role,'manage_users'))
    );

  if p_user_id = auth.uid() and p_branch_id = public.current_branch_id()
     and not v_new_can_manage then
    raise exception 'You cannot remove your own current branch administration'
      using errcode = 'check_violation';
  end if;

  -- Keep every branch recoverable. This is the branch-scoped equivalent of the
  -- existing last-manage_users-holder guard: another administrator cannot
  -- deactivate or demote the final effective access manager either.
  if public.branch_member_can(p_user_id,p_branch_id,'manage_users')
     and not v_new_can_manage
     and not exists (
       select 1 from public.branch_memberships m
        where m.branch_id=p_branch_id and m.user_id<>p_user_id and m.active
          and public.branch_member_can(m.user_id,p_branch_id,'manage_users')
     ) then
    raise exception 'Every branch must keep at least one active access manager'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.branch_memberships
   where user_id = p_user_id and branch_id = p_branch_id;
  insert into public.branch_memberships(
    user_id, branch_id, role, custom_role_id, extra_capabilities, denied_capabilities, active
  ) values (p_user_id, p_branch_id, p_role, p_custom_role_id, v_extra, v_denied, p_active)
  on conflict(user_id, branch_id) do update set
    role = excluded.role, custom_role_id = excluded.custom_role_id,
    extra_capabilities = excluded.extra_capabilities,
    denied_capabilities = excluded.denied_capabilities, active = excluded.active
  returning * into v_row;

  -- If access to the user's active branch was removed, move them to their first
  -- remaining active branch. With none, current_branch_id() fails closed.
  update public.profiles p
     set active_branch_id = (
       select m.branch_id from public.branch_memberships m
       join public.branches b on b.id = m.branch_id and b.active
       where m.user_id = p.id and m.active order by b.is_default desc, b.name_en limit 1
     )
   where p.id = p_user_id and p.active_branch_id = p_branch_id and not p_active;

  select name into v_actor_name from public.profiles where id = auth.uid();
  select name into v_target_name from public.profiles where id = p_user_id;
  insert into public.audit_log(
    action, entity, entity_id, entity_label, details, user_id, user_name,
    branch_id, module, correlation_id, before_state, after_state
  ) values (
    'branch.access_changed', 'branch_membership', v_row.id::text, coalesce(v_target_name,p_user_id::text),
    jsonb_build_object('target_user_id', p_user_id), auth.uid()::text, coalesce(v_actor_name,'Staff'),
    p_branch_id, 'identity', gen_random_uuid()::text,
    case when v_before.id is null then null else jsonb_build_object(
      'role',v_before.role,'custom_role_id',v_before.custom_role_id,'active',v_before.active,
      'extra_capabilities',v_before.extra_capabilities,'denied_capabilities',v_before.denied_capabilities) end,
    jsonb_build_object('role',v_row.role,'custom_role_id',v_row.custom_role_id,'active',v_row.active,
      'extra_capabilities',v_row.extra_capabilities,'denied_capabilities',v_row.denied_capabilities)
  );
  return v_row;
end;
$$;

-- ── Operational rows carry branch_id, backfilled without changing history ──
do $$
declare
  t text;
begin
  foreach t in array array[
    'sales','sale_items','sale_payments','sales_returns','return_items','refund_records',
    'shifts','expenses','stock_movements','approval_requests','customers','online_orders',
    'order_events','stock_reservations','stocktakes'
  ] loop
    execute format('alter table public.%I add column if not exists branch_id uuid references public.branches(id) on delete restrict', t);
    execute format('update public.%I set branch_id = %L::uuid where branch_id is null', t, '00000000-0000-4000-8000-0000000000b1');
    execute format('alter table public.%I alter column branch_id set default %L::uuid', t, '00000000-0000-4000-8000-0000000000b1');
    execute format('alter table public.%I alter column branch_id set not null', t);
    execute format('create index if not exists %I on public.%I(branch_id)', t || '_branch_idx', t);
  end loop;
end $$;

-- One open drawer per branch, rather than one for the entire installation.
drop index if exists public.shifts_one_open_idx;
create unique index if not exists shifts_one_open_per_branch_idx
  on public.shifts(branch_id) where status = 'open';

-- Definer RPCs do not obey RLS, so inserts are stamped/derived by trigger too.
create or replace function public.stamp_branch_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := public.current_branch_id();
begin
  if tg_table_name in ('sale_items','sale_payments') then
    select branch_id into new.branch_id from public.sales where id = new.sale_id;
  elsif tg_table_name in ('sales_returns','refund_records') then
    select branch_id into new.branch_id from public.sales where id = new.sale_id;
    if v_branch is not null and new.branch_id <> v_branch then
      raise exception 'Cross-branch financial write rejected' using errcode = 'insufficient_privilege';
    end if;
  elsif tg_table_name = 'return_items' then
    select branch_id into new.branch_id from public.sales_returns where id = new.return_id;
  elsif tg_table_name = 'order_events' then
    select branch_id into new.branch_id from public.online_orders where id = new.order_id;
  elsif tg_table_name = 'stock_reservations' then
    select branch_id into new.branch_id from public.online_orders where id = new.online_order_id;
  elsif v_branch is not null then
    -- Ignore browser-supplied branch ids. The authenticated active membership is
    -- the authority for all staff-created rows.
    new.branch_id := v_branch;
  end if;
  if new.branch_id is null then
    new.branch_id := '00000000-0000-4000-8000-0000000000b1'::uuid;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'sales','sale_items','sale_payments','sales_returns','return_items','refund_records',
    'shifts','expenses','stock_movements','approval_requests','customers','online_orders',
    'order_events','stock_reservations','stocktakes'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_stamp_branch', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.stamp_branch_scope()', t || '_stamp_branch', t);
  end loop;
end $$;

-- Branch-selective policies. Existing capability checks remain in every clause.
drop policy if exists "sales_select_authenticated" on public.sales;
create policy "sales_select_authenticated" on public.sales for select to authenticated
  using (branch_id = public.current_branch_id() and (
    public.can('view_sales') or public.can('sell') or public.can('edit_sale') or public.can('void_sale')
    or public.can('confirm_payment') or public.can('process_return') or public.can('process_refund')
    or public.can('view_shifts') or public.can('view_reports') or public.can('view_audit_log')));
drop policy if exists "sale_items_select_authenticated" on public.sale_items;
create policy "sale_items_select_authenticated" on public.sale_items for select to authenticated
  using (branch_id = public.current_branch_id() and exists(select 1 from public.sales s where s.id = sale_id));
drop policy if exists "sale_payments_select_authenticated" on public.sale_payments;
create policy "sale_payments_select_authenticated" on public.sale_payments for select to authenticated
  using (branch_id = public.current_branch_id() and exists(select 1 from public.sales s where s.id = sale_id));

drop policy if exists "sales_returns_select_authenticated" on public.sales_returns;
create policy "sales_returns_select_authenticated" on public.sales_returns for select to authenticated
  using (branch_id = public.current_branch_id() and (public.can('process_return') or public.can('view_reports') or public.can('view_sales')));
drop policy if exists "return_items_select_authenticated" on public.return_items;
create policy "return_items_select_authenticated" on public.return_items for select to authenticated
  using (branch_id = public.current_branch_id() and (public.can('process_return') or public.can('view_reports') or public.can('view_sales')));
drop policy if exists "refund_records_select_authenticated" on public.refund_records;
create policy "refund_records_select_authenticated" on public.refund_records for select to authenticated
  using (branch_id = public.current_branch_id() and (public.can('process_refund') or public.can('view_reports') or public.can('view_sales')));

drop policy if exists "shifts_select_viewers" on public.shifts;
create policy "shifts_select_viewers" on public.shifts for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('view_shifts'));
drop policy if exists "shifts_insert_till_staff" on public.shifts;
create policy "shifts_insert_till_staff" on public.shifts for insert to authenticated
  with check (branch_id = public.current_branch_id() and public.can('open_shift'));
drop policy if exists "shifts_update_till_staff_or_approver" on public.shifts;
create policy "shifts_update_till_staff_or_approver" on public.shifts for update to authenticated
  using (branch_id = public.current_branch_id() and (public.can('close_shift') or public.can('approve_shift_adjustment')))
  with check (branch_id = public.current_branch_id() and (public.can('close_shift') or public.can('approve_shift_adjustment')));

drop policy if exists "expenses_select_viewers" on public.expenses;
create policy "expenses_select_viewers" on public.expenses for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('view_shifts'));
drop policy if exists "expenses_insert_till_staff" on public.expenses;
create policy "expenses_insert_till_staff" on public.expenses for insert to authenticated
  with check (branch_id = public.current_branch_id() and public.can('add_expense'));
drop policy if exists "expenses_update_managers" on public.expenses;
create policy "expenses_update_managers" on public.expenses for update to authenticated
  using (branch_id = public.current_branch_id() and public.can('edit_expense'))
  with check (branch_id = public.current_branch_id() and public.can('edit_expense'));
drop policy if exists "expenses_delete_managers" on public.expenses;
create policy "expenses_delete_managers" on public.expenses for delete to authenticated
  using (branch_id = public.current_branch_id() and public.can('delete_expense'));

drop policy if exists "stock_movements_select_authenticated" on public.stock_movements;
create policy "stock_movements_select_authenticated" on public.stock_movements for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('view_inventory'));
drop policy if exists "stock_movements_insert_authenticated" on public.stock_movements;
create policy "stock_movements_insert_authenticated" on public.stock_movements for insert to authenticated
  with check (branch_id = public.current_branch_id() and public.can('adjust_stock'));
drop policy if exists "stock_movements_update_authenticated" on public.stock_movements;
create policy "stock_movements_update_authenticated" on public.stock_movements for update to authenticated
  using (false) with check (false);

drop policy if exists "customers_select_authenticated" on public.customers;
create policy "customers_select_authenticated" on public.customers for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('view_customers'));
drop policy if exists "customers_write_authenticated" on public.customers;
create policy "customers_write_authenticated" on public.customers for insert to authenticated
  with check (branch_id = public.current_branch_id() and public.can('add_customer'));
drop policy if exists "customers_update_authenticated" on public.customers;
create policy "customers_update_authenticated" on public.customers for update to authenticated
  using (branch_id = public.current_branch_id() and public.can('edit_customer'))
  with check (branch_id = public.current_branch_id() and public.can('edit_customer'));
drop policy if exists "customers_delete_authenticated" on public.customers;
create policy "customers_delete_authenticated" on public.customers for delete to authenticated
  using (branch_id = public.current_branch_id() and public.can('delete_customer'));

drop policy if exists "online_orders_select_staff" on public.online_orders;
create policy "online_orders_select_staff" on public.online_orders for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('manage_online_orders'));
drop policy if exists "online_orders_update_staff" on public.online_orders;
create policy "online_orders_update_staff" on public.online_orders for update to authenticated
  using (branch_id = public.current_branch_id() and public.can('manage_online_orders'))
  with check (branch_id = public.current_branch_id() and public.can('manage_online_orders'));
drop policy if exists "stock_reservations_select_staff" on public.stock_reservations;
create policy "stock_reservations_select_staff" on public.stock_reservations for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('manage_online_orders'));
drop policy if exists "order_events_select_staff" on public.order_events;
create policy "order_events_select_staff" on public.order_events for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('manage_online_orders'));

drop policy if exists stocktakes_select on public.stocktakes;
create policy stocktakes_select on public.stocktakes for select to authenticated
  using (branch_id = public.current_branch_id() and public.can('view_inventory'));

-- Audit viewers only see the active branch (legacy nulls were backfilled above).
update public.audit_log set branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid where branch_id is null;
drop policy if exists "audit_log_select_oversight" on public.audit_log;
create policy "audit_log_select_oversight" on public.audit_log for select to authenticated
  using (public.can('view_audit_log') and branch_id = public.current_branch_id());

-- Branch directory/membership RLS and grants.
alter table public.branches enable row level security;
alter table public.branch_memberships enable row level security;
drop policy if exists branches_read_members on public.branches;
create policy branches_read_members on public.branches for select to authenticated
  using (public.can_access_branch(id));
drop policy if exists branches_no_direct_write on public.branches;
create policy branches_no_direct_write on public.branches for all to authenticated using(false) with check(false);
drop policy if exists branch_memberships_read on public.branch_memberships;
create policy branch_memberships_read on public.branch_memberships for select to authenticated
  using (user_id = auth.uid() or public.can_manage_branch(branch_id));
drop policy if exists branch_memberships_no_direct_write on public.branch_memberships;
create policy branch_memberships_no_direct_write on public.branch_memberships for all to authenticated using(false) with check(false);

revoke all on public.branches, public.branch_memberships from anon;
grant select on public.branches, public.branch_memberships to authenticated;
grant execute on function public.current_branch_id() to authenticated;
grant execute on function public.get_active_branch_context() to authenticated;
grant execute on function public.get_my_branches() to authenticated;
revoke all on function public.can_access_branch(uuid) from public,anon;
revoke all on function public.can_manage_branch(uuid) from public,anon;
grant execute on function public.can_access_branch(uuid) to authenticated;
grant execute on function public.can_manage_branch(uuid) to authenticated;
-- The raw switch is an internal primitive. Browser switches must pass through
-- the audited wrapper so changing tenancy context can never be invisible.
revoke all on function public.switch_active_branch(uuid) from public,anon,authenticated;
grant execute on function public.switch_active_branch_with_audit(uuid) to authenticated;
grant execute on function public.admin_create_branch(text,text,text) to authenticated;
grant execute on function public.admin_set_branch_membership(uuid,uuid,public.app_role,uuid,text[],text[],boolean) to authenticated;
revoke all on function public.current_branch_id() from anon;
revoke all on function public.get_active_branch_context() from anon;
revoke all on function public.get_my_branches() from anon;
revoke all on function public.switch_active_branch(uuid) from anon;
revoke all on function public.switch_active_branch_with_audit(uuid) from anon;
revoke all on function public.admin_create_branch(text,text,text) from anon;
revoke all on function public.admin_set_branch_membership(uuid,uuid,public.app_role,uuid,text[],text[],boolean) from anon;

-- Trigger/helper definers are deliberately not API surface. Revoking their
-- default PUBLIC execute privilege prevents callers from supplying arbitrary
-- user/branch ids or invoking trigger logic outside its table event.
revoke all on function public.sync_default_branch_membership() from public,anon,authenticated;
revoke all on function public.branch_member_can(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.audit_sanitize(jsonb) from public,anon,authenticated;
revoke all on function public.enforce_audit_log_invariants() from public,anon,authenticated;
revoke all on function public.stamp_branch_scope() from public,anon,authenticated;

-- 0083 — Mobile management installation and push-token custody
--
-- A management phone is NOT a cashier register. Tokens are stored behind a
-- deny-all authenticated table boundary and are available only to trusted
-- delivery infrastructure (service_role). Client RPCs can register/deactivate
-- the caller's own stable installation and never list or return raw tokens.

begin;

insert into public.audit_actions(action,entity) values
  ('mobile.installation_registered','mobile_installation'),
  ('mobile.installation_deactivated','mobile_installation')
on conflict(action) do update set entity=excluded.entity;

create table if not exists public.mobile_installations(
  id uuid primary key default gen_random_uuid(),
  installation_id uuid not null unique,
  user_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  platform text not null,
  app_version text not null,
  push_token text,
  push_token_hash text,
  push_registered boolean not null default false,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mobile_platform_check check(platform in('android','ios','web')),
  constraint mobile_version_length check(char_length(app_version) between 1 and 64),
  constraint mobile_push_token_length check(push_token is null or char_length(push_token) between 16 and 4096),
  constraint mobile_push_pair check((push_token is null and push_token_hash is null and not push_registered) or (push_token is not null and push_token_hash ~ '^[0-9a-f]{64}$' and push_registered))
);
create index if not exists mobile_installations_user_idx on public.mobile_installations(user_id,active);
create index if not exists mobile_installations_branch_idx on public.mobile_installations(branch_id,active);
create unique index if not exists mobile_installations_token_hash_key on public.mobile_installations(push_token_hash) where push_token_hash is not null;
drop trigger if exists mobile_installations_set_updated_at on public.mobile_installations;
create trigger mobile_installations_set_updated_at before update on public.mobile_installations
for each row execute function public.set_updated_at();

alter table public.mobile_installations enable row level security;
drop policy if exists mobile_installations_no_select on public.mobile_installations;
create policy mobile_installations_no_select on public.mobile_installations for select to authenticated using(false);
drop policy if exists mobile_installations_no_insert on public.mobile_installations;
create policy mobile_installations_no_insert on public.mobile_installations for insert to authenticated with check(false);
drop policy if exists mobile_installations_no_update on public.mobile_installations;
create policy mobile_installations_no_update on public.mobile_installations for update to authenticated using(false) with check(false);
drop policy if exists mobile_installations_no_delete on public.mobile_installations;
create policy mobile_installations_no_delete on public.mobile_installations for delete to authenticated using(false);
revoke all on public.mobile_installations from anon,authenticated;
grant select on public.mobile_installations to service_role;

comment on table public.mobile_installations is 'Management-app installation registry. Not a cashier register. Raw push tokens are service-role delivery custody and never client-readable.';
comment on column public.mobile_installations.push_token is 'Provider routing token. Never expose through authenticated reads, diagnostics, audit, notifications, or RPC return values.';

create or replace function public.mobile_installation_register(
  p_installation_id uuid,
  p_platform text,
  p_app_version text,
  p_push_token text
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_existing public.mobile_installations;
  v_branch uuid;
  v_profile_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_installation_id is null or p_platform not in('android','ios','web')
     or char_length(btrim(coalesce(p_app_version,''))) not between 1 and 64
     or char_length(coalesce(p_push_token,'')) not between 16 and 4096 then
    raise exception 'Invalid mobile registration' using errcode='23514';
  end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Active user required' using errcode='42501';
  end if;
  v_branch:=public.current_branch_id();
  select * into v_existing from public.mobile_installations where installation_id=p_installation_id for update;
  if v_existing.id is not null and v_existing.user_id<>auth.uid() then
    raise exception 'Installation belongs to another user' using errcode='42501';
  end if;
  -- A provider may rotate/reuse a token. It may not leave that routing token on
  -- another installation and deliver one notification to two identities.
  update public.mobile_installations set push_token=null,push_token_hash=null,push_registered=false
   where push_token_hash=encode(digest(p_push_token,'sha256'),'hex')
     and installation_id<>p_installation_id;
  insert into public.mobile_installations(
    installation_id,user_id,branch_id,platform,app_version,push_token,push_token_hash,push_registered,active,last_seen_at
  ) values(
    p_installation_id,auth.uid(),v_branch,p_platform,btrim(p_app_version),p_push_token,
    encode(digest(p_push_token,'sha256'),'hex'),true,true,now()
  )
  on conflict(installation_id) do update set
    branch_id=excluded.branch_id,platform=excluded.platform,app_version=excluded.app_version,
    push_token=excluded.push_token,push_token_hash=excluded.push_token_hash,
    push_registered=true,active=true,last_seen_at=now();
  select name into v_profile_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
  values('mobile.installation_registered','mobile_installation',p_installation_id::text,'ALYQ Mobile',
    jsonb_build_object('platform',p_platform,'app_version',btrim(p_app_version),'push_registered',true),
    auth.uid()::text,coalesce(v_profile_name,'Staff'),v_branch,'mobile');
  return jsonb_build_object('installation_id',p_installation_id,'active',true,'push_registered',true,'branch_id',v_branch);
end
$function$;
revoke all on function public.mobile_installation_register(uuid,text,text,text) from public,anon;
grant execute on function public.mobile_installation_register(uuid,text,text,text) to authenticated,service_role;

create or replace function public.mobile_installation_deactivate(p_installation_id uuid)
returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_changed boolean; v_branch uuid; v_profile_name text;
begin
  if auth.uid() is null or p_installation_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  update public.mobile_installations
     set active=false,push_registered=false,push_token=null,push_token_hash=null,last_seen_at=now()
   where installation_id=p_installation_id and user_id=auth.uid() and active
   returning true,branch_id into v_changed,v_branch;
  if coalesce(v_changed,false) then
    select name into v_profile_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
    values('mobile.installation_deactivated','mobile_installation',p_installation_id::text,'ALYQ Mobile',
      jsonb_build_object('push_registered',false),auth.uid()::text,coalesce(v_profile_name,'Staff'),v_branch,'mobile');
  end if;
  return coalesce(v_changed,false);
end
$function$;
revoke all on function public.mobile_installation_deactivate(uuid) from public,anon;
grant execute on function public.mobile_installation_deactivate(uuid) to authenticated,service_role;

commit;

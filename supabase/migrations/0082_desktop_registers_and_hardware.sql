-- 0082 — Authoritative desktop registers, device binding and hardware audit
--
-- A register is a branch-bound device record, not a user, branch or shift.
-- Desktop credentials prove one installation binding; public register ids from
-- payloads are evidence only and never authority. Web POS remains compatible
-- with nullable register evidence.

begin;

-- ── Permission vocabulary ──────────────────────────────────────────────────
insert into public.role_capabilities(role,capability) values
  ('admin','manage_registers'),('manager','manage_registers'),
  ('admin','configure_hardware'),('manager','configure_hardware'),
  ('admin','open_cash_drawer'),('manager','open_cash_drawer')
on conflict(role,capability) do nothing;

-- ── Audit vocabulary ───────────────────────────────────────────────────────
insert into public.audit_actions(action,entity) values
  ('register.created','register'),
  ('register.activated','register'),
  ('register.deactivated','register'),
  ('register.renamed','register'),
  ('register.reassigned','register'),
  ('hardware.configured','hardware'),
  ('hardware.printer_tested','hardware'),
  ('drawer.open_authorized','hardware')
on conflict(action) do update set entity=excluded.entity;

-- ── Register authority ─────────────────────────────────────────────────────
create table if not exists public.registers(
  id                         uuid primary key default gen_random_uuid(),
  code                       text not null,
  name                       text not null,
  branch_id                  uuid not null references public.branches(id) on delete restrict,
  active                     boolean not null default true,
  installation_id            uuid not null unique,
  credential_hash            text not null,
  last_seen_at               timestamptz,
  app_version                text,
  platform                   text,
  hardware_metadata          jsonb not null default '{}'::jsonb,
  pending_offline_count      integer not null default 0,
  unresolved_conflict_count  integer not null default 0,
  created_by                 uuid not null references public.profiles(id) on delete restrict,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint registers_code_shape check(code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  constraint registers_name_length check(char_length(btrim(name)) between 1 and 80),
  constraint registers_credential_hash check(credential_hash ~ '^[0-9a-f]{64}$'),
  constraint registers_app_version_length check(app_version is null or char_length(app_version)<=64),
  constraint registers_platform_length check(platform is null or char_length(platform)<=80),
  constraint registers_hardware_object check(jsonb_typeof(hardware_metadata)='object' and octet_length(hardware_metadata::text)<=4096),
  constraint registers_pending_range check(pending_offline_count between 0 and 999999),
  constraint registers_conflict_range check(unresolved_conflict_count between 0 and 999999)
);
create unique index if not exists registers_code_key on public.registers(lower(code));
create index if not exists registers_branch_idx on public.registers(branch_id,active,name);
create index if not exists registers_last_seen_idx on public.registers(last_seen_at desc nulls last);
drop trigger if exists registers_set_updated_at on public.registers;
create trigger registers_set_updated_at before update on public.registers
for each row execute function public.set_updated_at();
comment on table public.registers is
  'Branch-bound physical/logical till installation. credential_hash proves the stable local installation without storing its credential.';
comment on column public.registers.hardware_metadata is
  'Safe capability/configuration summary only. No device credential, token, key, PIN, payment data or customer data.';

alter table public.registers enable row level security;
drop policy if exists registers_no_direct_select on public.registers;
create policy registers_no_direct_select on public.registers for select to authenticated using(false);
drop policy if exists registers_no_direct_insert on public.registers;
create policy registers_no_direct_insert on public.registers for insert to authenticated with check(false);
drop policy if exists registers_no_direct_update on public.registers;
create policy registers_no_direct_update on public.registers for update to authenticated using(false) with check(false);
drop policy if exists registers_no_direct_delete on public.registers;
create policy registers_no_direct_delete on public.registers for delete to authenticated using(false);
revoke all on public.registers from anon,authenticated;

create or replace function public.register_safe_json(p_register public.registers)
returns jsonb
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select jsonb_build_object(
    'id',p_register.id,'code',p_register.code,'name',p_register.name,
    'branch_id',p_register.branch_id,
    'branch_name',(select b.name_en from public.branches b where b.id=p_register.branch_id),
    'active',p_register.active,'installation_id',p_register.installation_id,
    'last_seen_at',p_register.last_seen_at,'app_version',p_register.app_version,
    'platform',p_register.platform,'hardware_metadata',p_register.hardware_metadata,
    'pending_offline_count',p_register.pending_offline_count,
    'unresolved_conflict_count',p_register.unresolved_conflict_count,
    'created_at',p_register.created_at,'updated_at',p_register.updated_at)
$function$;
revoke all on function public.register_safe_json(public.registers) from public,anon,authenticated;

create or replace function public.register_resolve_private(p_installation_id uuid,p_credential text,p_require_active boolean default true)
returns public.registers
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers;
begin
  if auth.uid() is null or p_installation_id is null or coalesce(char_length(p_credential),0) not between 32 and 160 then
    raise exception 'Valid register binding required' using errcode='42501';
  end if;
  select * into v_register from public.registers where installation_id=p_installation_id;
  if v_register.id is null
     or v_register.credential_hash<>encode(digest(p_credential,'sha256'),'hex')
     or (p_require_active and not v_register.active)
     or not public.can_access_branch(v_register.branch_id) then
    raise exception 'Register binding is invalid, inactive or outside the user branch' using errcode='42501';
  end if;
  return v_register;
end
$function$;
revoke all on function public.register_resolve_private(uuid,text,boolean) from public,anon,authenticated;

create or replace function public.register_context(p_installation_id uuid,p_credential text)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers;
begin
  v_register:=public.register_resolve_private(p_installation_id,p_credential,false);
  return public.register_safe_json(v_register);
end
$function$;
revoke all on function public.register_context(uuid,text) from public,anon;
grant execute on function public.register_context(uuid,text) to authenticated,service_role;

create or replace function public.register_list()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
begin
  if auth.uid() is null or not public.can('manage_registers') then
    raise exception 'Register management is not permitted' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(public.register_safe_json(r) order by r.name,r.id)
    from public.registers r where public.can_access_branch(r.branch_id)),'[]'::jsonb);
end
$function$;
revoke all on function public.register_list() from public,anon;
grant execute on function public.register_list() to authenticated,service_role;

create or replace function public.register_create(
  p_code text,p_name text,p_branch_id uuid,p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_credential text:=encode(gen_random_bytes(32),'hex'); v_user_name text;
begin
  if auth.uid() is null or not public.can('manage_registers') or not public.can_access_branch(p_branch_id) then
    raise exception 'Register creation is not permitted for this branch' using errcode='42501';
  end if;
  if not exists(select 1 from public.branches where id=p_branch_id and active) then
    raise exception 'Register branch is inactive' using errcode='23514';
  end if;
  if upper(btrim(coalesce(p_code,''))) !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
     or char_length(btrim(coalesce(p_name,''))) not between 1 and 80
     or p_installation_id is null then
    raise exception 'Invalid register details' using errcode='23514';
  end if;
  insert into public.registers(code,name,branch_id,installation_id,credential_hash,created_by)
  values(upper(btrim(p_code)),btrim(p_name),p_branch_id,p_installation_id,
    encode(digest(v_credential,'sha256'),'hex'),auth.uid()) returning * into v_register;
  select name into v_user_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module,register_id)
  values('register.created','register',v_register.id::text,v_register.name,
    jsonb_build_object('code',v_register.code,'branch_id',v_register.branch_id,'installation_id',v_register.installation_id),
    auth.uid()::text,coalesce(v_user_name,'Staff'),v_register.branch_id,'registers',v_register.id);
  return jsonb_build_object('register',public.register_safe_json(v_register),'credential',v_credential);
exception when unique_violation then
  raise exception 'Register code or installation is already registered' using errcode='23505';
end
$function$;

create or replace function public.register_manage(
  p_register_id uuid,p_action text,p_name text default null,p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_before public.registers; v_user_name text; v_action text;
begin
  if auth.uid() is null or not public.can('manage_registers') then
    raise exception 'Register management is not permitted' using errcode='42501';
  end if;
  select * into v_register from public.registers where id=p_register_id for update;
  if v_register.id is null or not public.can_access_branch(v_register.branch_id) then
    raise exception 'Register is unavailable' using errcode='42501';
  end if;
  v_before:=v_register;
  if p_action in('deactivate','reassign') and (
       exists(select 1 from public.shifts where register_id=v_register.id and status='open')
       or v_register.pending_offline_count>0 or v_register.unresolved_conflict_count>0) then
    raise exception 'Close the register shift and resolve every offline operation before this change' using errcode='23514';
  end if;
  if p_action='rename' then
    if char_length(btrim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Invalid register name' using errcode='23514'; end if;
    update public.registers set name=btrim(p_name) where id=v_register.id returning * into v_register;
    v_action:='register.renamed';
  elsif p_action='activate' then
    if not exists(select 1 from public.branches where id=v_register.branch_id and active) then raise exception 'Register branch is inactive' using errcode='23514'; end if;
    update public.registers set active=true where id=v_register.id returning * into v_register;
    v_action:='register.activated';
  elsif p_action='deactivate' then
    update public.registers set active=false where id=v_register.id returning * into v_register;
    v_action:='register.deactivated';
  elsif p_action='reassign' then
    if p_branch_id is null or p_branch_id=v_register.branch_id or not public.can_access_branch(p_branch_id)
       or not exists(select 1 from public.branches where id=p_branch_id and active) then
      raise exception 'Valid accessible target branch required' using errcode='23514';
    end if;
    update public.registers set branch_id=p_branch_id where id=v_register.id returning * into v_register;
    v_action:='register.reassigned';
  else
    raise exception 'Unsupported register action' using errcode='23514';
  end if;
  select name into v_user_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module,register_id,before_state,after_state)
  values(v_action,'register',v_register.id::text,v_register.name,
    jsonb_build_object('action',p_action,'from_branch_id',v_before.branch_id,'to_branch_id',v_register.branch_id),
    auth.uid()::text,coalesce(v_user_name,'Staff'),v_register.branch_id,'registers',v_register.id,
    public.register_safe_json(v_before)-'hardware_metadata',public.register_safe_json(v_register)-'hardware_metadata');
  return public.register_safe_json(v_register);
end
$function$;
revoke all on function public.register_create(text,text,uuid,uuid) from public,anon;
grant execute on function public.register_create(text,text,uuid,uuid) to authenticated,service_role;
revoke all on function public.register_manage(uuid,text,text,uuid) from public,anon;
grant execute on function public.register_manage(uuid,text,text,uuid) to authenticated,service_role;

create or replace function public.register_heartbeat(
  p_installation_id uuid,p_credential text,p_app_version text,p_platform text,
  p_hardware_metadata jsonb,p_pending integer,p_conflicts integer
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers;
begin
  v_register:=public.register_resolve_private(p_installation_id,p_credential,true);
  if char_length(coalesce(p_app_version,''))>64 or char_length(coalesce(p_platform,''))>80
     or jsonb_typeof(coalesce(p_hardware_metadata,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_hardware_metadata,'{}'::jsonb)::text)>4096
     or coalesce(p_pending,-1) not between 0 and 999999 or coalesce(p_conflicts,-1) not between 0 and 999999 then
    raise exception 'Invalid register heartbeat' using errcode='23514';
  end if;
  update public.registers set last_seen_at=now(),app_version=nullif(btrim(p_app_version),''),
    platform=nullif(btrim(p_platform),''),hardware_metadata=coalesce(p_hardware_metadata,'{}'::jsonb),
    pending_offline_count=p_pending,unresolved_conflict_count=p_conflicts
   where id=v_register.id returning * into v_register;
  return public.register_safe_json(v_register);
end
$function$;
revoke all on function public.register_heartbeat(uuid,text,text,text,jsonb,integer,integer) from public,anon;
grant execute on function public.register_heartbeat(uuid,text,text,text,jsonb,integer,integer) to authenticated,service_role;

-- ── Immutable register evidence on money records ───────────────────────────
alter table public.sales add column if not exists register_id uuid references public.registers(id) on delete set null;
alter table public.sales add column if not exists register_name text;
alter table public.sales add column if not exists branch_name text;
alter table public.shifts add column if not exists register_id uuid references public.registers(id) on delete set null;
alter table public.cash_movements add column if not exists register_id uuid references public.registers(id) on delete set null;
alter table public.audit_log add column if not exists register_id uuid references public.registers(id) on delete set null;
create index if not exists sales_register_idx on public.sales(register_id,created_at desc) where register_id is not null;
create index if not exists shifts_register_id_idx on public.shifts(register_id,opening_at desc) where register_id is not null;
create index if not exists cash_movements_register_idx on public.cash_movements(register_id,created_at desc) where register_id is not null;
create index if not exists audit_log_register_idx on public.audit_log(register_id,created_at desc) where register_id is not null;

create or replace function public.stamp_register_evidence()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid; v_register public.registers;
begin
  begin v_id:=nullif(current_setting('alyq.register_id',true),'')::uuid;
  exception when invalid_text_representation then v_id:=null; end;
  if tg_table_name='sales' then
    -- Freeze the human branch label for historical receipts; authority remains
    -- the existing branch_id foreign key and branch-scoped sale RPC.
    select b.name_en into new.branch_name from public.branches b where b.id=new.branch_id;
    if new.source='pos' and v_id is not null then
      select * into v_register from public.registers where id=v_id and active;
      if v_register.id is null or v_register.branch_id is distinct from new.branch_id then
        raise exception 'Sale register does not match its authoritative branch' using errcode='42501';
      end if;
      new.register_id:=v_register.id; new.register_name:=v_register.name;
    else new.register_id:=null; new.register_name:=null;
    end if;
  elsif tg_table_name='shifts' then
    if v_id is not null then
      select * into v_register from public.registers where id=v_id and active;
      if v_register.id is null then raise exception 'Active register required' using errcode='42501'; end if;
      new.register_id:=v_register.id; new.register:=v_register.name;
    else new.register_id:=null;
    end if;
  elsif tg_table_name='cash_movements' then
    select register_id into new.register_id from public.shifts where id=new.shift_id;
  end if;
  return new;
end
$function$;
drop trigger if exists sales_stamp_register on public.sales;
create trigger sales_stamp_register before insert on public.sales
for each row execute function public.stamp_register_evidence();
drop trigger if exists register_stamp_shift on public.shifts;
create trigger register_stamp_shift before insert on public.shifts
for each row execute function public.stamp_register_evidence();
drop trigger if exists register_stamp_cash_movement on public.cash_movements;
create trigger register_stamp_cash_movement before insert on public.cash_movements
for each row execute function public.stamp_register_evidence();
revoke all on function public.stamp_register_evidence() from public,anon,authenticated;

create or replace function public.register_set_context(p_installation_id uuid,p_credential text,p_expected_register uuid default null)
returns public.registers
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers;
begin
  v_register:=public.register_resolve_private(p_installation_id,p_credential,true);
  if v_register.branch_id is distinct from public.current_branch_id()
     or (p_expected_register is not null and p_expected_register is distinct from v_register.id) then
    raise exception 'Register does not match the active branch or original operation' using errcode='42501';
  end if;
  perform set_config('alyq.register_id',v_register.id::text,true);
  return v_register;
end
$function$;
revoke all on function public.register_set_context(uuid,text,uuid) from public,anon,authenticated;

create or replace function public.pos_complete_registered_sale(
  p_payload jsonb,p_approval_request_id uuid,p_installation_id uuid,p_credential text,p_register_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_existing public.sales;
begin
  v_register:=public.register_set_context(p_installation_id,p_credential,p_register_id);
  select * into v_existing from public.sales
   where branch_id=v_register.branch_id and client_ref=nullif(btrim(p_payload->>'client_ref'),'');
  if v_existing.id is not null and v_existing.register_id is distinct from v_register.id then
    raise exception 'Idempotent sale belongs to another register' using errcode='23514';
  end if;
  return public.pos_complete_sale(p_payload,p_approval_request_id);
end
$function$;

create or replace function public.pos_sync_registered_offline_sale(
  p_payload jsonb,p_evidence jsonb,p_installation_id uuid,p_credential text,p_register_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_existing public.sales;
begin
  v_register:=public.register_set_context(p_installation_id,p_credential,p_register_id);
  if nullif(p_evidence->>'register_id','')::uuid is distinct from v_register.id
     or nullif(p_evidence->>'installation_id','')::uuid is distinct from v_register.installation_id then
    raise exception 'Offline sale register evidence conflict' using errcode='23514';
  end if;
  select * into v_existing from public.sales
   where branch_id=v_register.branch_id and client_ref=nullif(btrim(p_payload->>'client_ref'),'');
  if v_existing.id is not null and v_existing.register_id is distinct from v_register.id then
    raise exception 'Idempotent offline sale belongs to another register' using errcode='23514';
  end if;
  return public.pos_sync_offline_sale(p_payload,p_evidence);
end
$function$;
revoke all on function public.pos_complete_registered_sale(jsonb,uuid,uuid,text,uuid) from public,anon;
grant execute on function public.pos_complete_registered_sale(jsonb,uuid,uuid,text,uuid) to authenticated,service_role;
revoke all on function public.pos_sync_registered_offline_sale(jsonb,jsonb,uuid,text,uuid) from public,anon;
grant execute on function public.pos_sync_registered_offline_sale(jsonb,jsonb,uuid,text,uuid) to authenticated,service_role;

create or replace function public.open_registered_shift(
  p_opening_cash numeric,p_installation_id uuid,p_credential text
)
returns public.shifts
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_shift public.shifts;
begin
  if p_opening_cash<0 or p_opening_cash>10000000 then raise exception 'Invalid opening cash' using errcode='23514'; end if;
  v_register:=public.register_set_context(p_installation_id,p_credential,null);
  insert into public.shifts(branch,register,status,opening_cash,opened_by,opened_by_name)
  values('authoritative',v_register.name,'open',round(p_opening_cash,2),auth.uid()::text,'Staff')
  returning * into v_shift;
  return v_shift;
end
$function$;
revoke all on function public.open_registered_shift(numeric,uuid,text) from public,anon;
grant execute on function public.open_registered_shift(numeric,uuid,text) to authenticated,service_role;

-- ── Hardware authorization and truthful audit ──────────────────────────────
create or replace function public.register_hardware_event(
  p_installation_id uuid,p_credential text,p_event text,p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_user_name text; v_action text;
begin
  if not public.can('configure_hardware') then raise exception 'Hardware configuration is not permitted' using errcode='42501'; end if;
  v_register:=public.register_set_context(p_installation_id,p_credential,null);
  if p_event='configured' then v_action:='hardware.configured';
  elsif p_event='printer_tested' then v_action:='hardware.printer_tested';
  else raise exception 'Unsupported hardware event' using errcode='23514'; end if;
  if jsonb_typeof(coalesce(p_details,'{}'::jsonb))<>'object' or octet_length(coalesce(p_details,'{}'::jsonb)::text)>2048 then
    raise exception 'Invalid hardware details' using errcode='23514';
  end if;
  select name into v_user_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module,register_id)
  values(v_action,'hardware',v_register.id::text,v_register.name,coalesce(p_details,'{}'::jsonb),auth.uid()::text,
    coalesce(v_user_name,'Staff'),v_register.branch_id,'hardware',v_register.id);
  return jsonb_build_object('recorded',true,'register_id',v_register.id);
end
$function$;

create or replace function public.register_authorize_drawer_open(
  p_installation_id uuid,p_credential text,p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_shift public.shifts; v_user_name text; v_auth uuid:=gen_random_uuid();
begin
  if not public.can('open_cash_drawer') then raise exception 'Manual drawer opening is not permitted' using errcode='42501'; end if;
  if char_length(btrim(coalesce(p_reason,''))) not between 3 and 160 then raise exception 'Drawer reason is required' using errcode='23514'; end if;
  v_register:=public.register_set_context(p_installation_id,p_credential,null);
  select * into v_shift from public.shifts where register_id=v_register.id and branch_id=v_register.branch_id and status='open' for update;
  if v_shift.id is null then raise exception 'An open shift on this register is required' using errcode='23514'; end if;
  select name into v_user_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module,register_id,reason,correlation_id)
  values('drawer.open_authorized','hardware',v_auth::text,v_register.name,
    jsonb_build_object('register_id',v_register.id,'shift_id',v_shift.id,'shift_number',v_shift.shift_number,'state','command_authorized'),
    auth.uid()::text,coalesce(v_user_name,'Staff'),v_register.branch_id,'hardware',v_register.id,btrim(p_reason),v_auth::text);
  return jsonb_build_object('authorization_ref',v_auth,'register_id',v_register.id,'shift_id',v_shift.id,'drawer_state','unknown');
end
$function$;
revoke all on function public.register_hardware_event(uuid,text,text,jsonb) from public,anon;
grant execute on function public.register_hardware_event(uuid,text,text,jsonb) to authenticated,service_role;
revoke all on function public.register_authorize_drawer_open(uuid,text,text) from public,anon;
grant execute on function public.register_authorize_drawer_open(uuid,text,text) to authenticated,service_role;

-- Health contract moves forward without claiming device readiness.
create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=public.current_branch_id();
begin
  if auth.uid() is null then raise exception 'Authenticated health check required' using errcode='42501'; end if;
  return jsonb_build_object(
    'authenticated',true,'server_time',now(),
    'migration','0082_desktop_registers_and_hardware.sql','migration_count',82,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;
revoke all on function public.system_health_probe() from public,anon;
grant execute on function public.system_health_probe() to authenticated,service_role;

commit;

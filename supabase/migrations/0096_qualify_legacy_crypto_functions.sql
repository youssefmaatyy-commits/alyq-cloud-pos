-- 0096 — Qualify legacy pgcrypto calls in SECURITY DEFINER functions
--
-- Hosted Supabase installs pgcrypto in the `extensions` schema (`extensions.digest`,
-- `extensions.gen_random_bytes`, `extensions.crypt`, `extensions.gen_salt`), while
-- `encode` and `gen_random_uuid` live in `pg_catalog`.
--
-- Migration 0095 repaired the three Web Push functions from 0094, but seven
-- earlier SECURITY DEFINER functions with narrow search_paths (`public` or
-- `pg_catalog,public`) still contained unqualified calls to `digest(...)`,
-- `gen_random_bytes(...)`, `crypt(...)`, or `gen_salt(...)`:
--   1. public.seed_demo_staff(text)                                [0014]
--   2. public.preview_selective_cleanup(text,jsonb)                [0073]
--   3. public.execute_selective_cleanup(uuid,text,text,text,uuid)  [0073]
--   4. public.register_resolve_private(uuid,text,boolean)          [0082]
--   5. public.register_create(text,text,uuid,uuid)                 [0082]
--   6. public.mobile_installation_register(uuid,text,text,text)    [0083]
--   7. public.mobile_installation_register_v2(uuid,text,text,text,text) [0092]
--
-- This migration binds those pgcrypto calls explicitly to `extensions.*` while
-- preserving each function's exact signature, SECURITY DEFINER attribute,
-- hardened search_path, REVOKE/GRANT privileges, and business logic.

begin;

-- ── 1. public.seed_demo_staff (from 0014_audit_policies_and_seed.sql) ─────
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
        extensions.crypt(p_password, extensions.gen_salt('bf')),
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
grant execute on function public.seed_demo_staff(text) to authenticated;

-- ── 2. public.preview_selective_cleanup (from 0073_selective_cleanup.sql) ─
create or replace function public.preview_selective_cleanup(p_category text,p_filters jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_branch uuid:=public.current_branch_id(); v_state jsonb; v_nonce text;
  v_fingerprint text; v_token text; v_id uuid; v_total int; v_name text; v_exp timestamptz:=now()+interval '5 minutes';
begin
  if not public.can('preview_data_cleanup') then
    raise exception 'Not permitted to preview cleanup' using errcode='insufficient_privilege';
  end if;
  -- Reject unknown keys as well as unknown categories. This is a closed filter
  -- vocabulary, not an arbitrary SQL predicate tunnel.
  if exists(
    select 1 from jsonb_object_keys(coalesce(p_filters,'{}')) k
     where k not in('from','before','record_id','reference')
  ) then
    raise exception 'Unsupported cleanup filter' using errcode='check_violation';
  end if;
  v_state:=public.cleanup_preview_state(p_category,p_filters,v_branch);
  v_total:=coalesce((v_state->>'delete_count')::int,0)+coalesce((v_state->>'anonymize_count')::int,0)+coalesce((v_state->>'archive_count')::int,0);
  v_nonce:=encode(extensions.gen_random_bytes(32),'hex');
  v_fingerprint:=encode(extensions.digest(v_branch::text||'|'||p_category||'|'||p_filters::text||'|'||v_state::text||'|'||v_exp::text||'|'||v_nonce,'sha256'),'hex');
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.cleanup_previews(branch_id,requested_by,category,filters,preview_state,
    fingerprint,token_hash,confirmation_phrase,expires_at)
  values(v_branch,auth.uid(),p_category,p_filters,v_state,v_fingerprint,
    encode(extensions.digest(v_token,'sha256'),'hex'),'CLEAN '||v_total,v_exp)
  returning id into v_id;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    branch_id,module,correlation_id)
  values('cleanup.previewed','cleanup_preview',v_id::text,p_category,
    jsonb_build_object('counts',v_state-array['delete_ids','anonymize_ids','archive_ids','protected_ids'],
      'filters',p_filters,'fingerprint',v_fingerprint),auth.uid()::text,coalesce(v_name,'Staff'),
    v_branch,'settings',(select correlation_id::text from public.cleanup_previews where id=v_id));
  return jsonb_build_object('preview_id',v_id,'category',p_category,'state',v_state,
    'fingerprint',v_fingerprint,'preview_token',v_token,'confirmation_phrase','CLEAN '||v_total,'expires_at',v_exp);
end;
$$;

grant execute on function public.preview_selective_cleanup(text,jsonb) to authenticated;
revoke all on function public.preview_selective_cleanup(text,jsonb) from anon;

-- ── 3. public.execute_selective_cleanup (from 0073_selective_cleanup.sql) ─
create or replace function public.execute_selective_cleanup(
  p_preview_id uuid,p_preview_token text,p_fingerprint text,p_confirmation text,p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_preview public.cleanup_previews; v_recomputed jsonb; v_decision jsonb; v_request public.approval_requests;
  v_result jsonb; v_name text; v_deleted int:=0; v_anonymized int:=0; v_archived int:=0; v_id uuid;
begin
  select * into v_preview from public.cleanup_previews where id=p_preview_id for update;
  if v_preview.id is null or v_preview.requested_by<>auth.uid() or v_preview.branch_id<>public.current_branch_id() then
    raise exception 'Cleanup preview not found' using errcode='no_data_found';
  end if;
  if not public.can('execute_data_cleanup') then raise exception 'Not permitted to execute cleanup' using errcode='insufficient_privilege'; end if;
  if v_preview.executed_at is not null then raise exception 'Cleanup preview already used' using errcode='check_violation'; end if;
  if v_preview.expires_at<=now() then raise exception 'Cleanup preview expired' using errcode='check_violation'; end if;
  if encode(extensions.digest(coalesce(p_preview_token,''),'sha256'),'hex')<>v_preview.token_hash
     or p_fingerprint<>v_preview.fingerprint
     or p_confirmation<>v_preview.confirmation_phrase then
    raise exception 'Cleanup confirmation does not match the preview' using errcode='insufficient_privilege';
  end if;
  v_recomputed:=public.cleanup_preview_state(v_preview.category,v_preview.filters,v_preview.branch_id);
  if v_recomputed<>v_preview.preview_state then
    raise exception 'Cleanup data changed; generate a new preview' using errcode='serialization_failure';
  end if;
  v_decision:=public.operation_decision('selective_cleanup',null,
    coalesce((v_recomputed->>'delete_count')::numeric,0)+coalesce((v_recomputed->>'anonymize_count')::numeric,0)+coalesce((v_recomputed->>'archive_count')::numeric,0));
  if v_decision->>'decision'='forbidden' then raise exception 'Cleanup exceeds configured authority' using errcode='insufficient_privilege'; end if;
  if v_decision->>'decision'='approval' then
    if p_approval_request_id is null then raise exception 'Manager approval required' using errcode='insufficient_privilege'; end if;
    select * into v_request from public.approval_request_matches(p_approval_request_id,'selective_cleanup',
      p_preview_id::text,null,((v_recomputed->>'delete_count')::numeric+(v_recomputed->>'anonymize_count')::numeric+(v_recomputed->>'archive_count')::numeric),
      jsonb_build_object('preview_id',p_preview_id,'fingerprint',p_fingerprint,'category',v_preview.category));
  end if;

  if v_preview.category='customers' then
    for v_id in select (jsonb_array_elements_text(v_recomputed->'anonymize_ids'))::uuid loop
      update public.customers set name='Anonymized customer',
        phone='anon-'||left(replace(v_id::text,'-',''),25),address=null,notes=null
       where id=v_id and branch_id=v_preview.branch_id;
      update public.sales set customer_name='Anonymized customer',customer_phone=null where customer_id=v_id and branch_id=v_preview.branch_id;
      v_anonymized:=v_anonymized+1;
    end loop;
    delete from public.customers where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid) and branch_id=v_preview.branch_id;
    get diagnostics v_deleted=row_count;
  elsif v_preview.category='cancelled_online_orders' then
    delete from public.online_orders where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid)
      and branch_id=v_preview.branch_id and status='cancelled' and sale_id is null;
    get diagnostics v_deleted=row_count;
  elsif v_preview.category='expired_promotions' then
    update public.promotions set enabled=false where id in(select (jsonb_array_elements_text(v_recomputed->'archive_ids'))::uuid) and enabled;
    get diagnostics v_archived=row_count;
  elsif v_preview.category='unfinished_stocktakes' then
    delete from public.stocktakes where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid)
      and branch_id=v_preview.branch_id and status in('draft','counting','review');
    get diagnostics v_deleted=row_count;
  else raise exception 'Unsupported cleanup category' using errcode='check_violation'; end if;

  v_result:=jsonb_build_object('preview_id',p_preview_id,'category',v_preview.category,
    'deleted',v_deleted,'anonymized',v_anonymized,'archived',v_archived,
    'protected',(v_recomputed->>'protected_count')::int,'completed_at',now());
  update public.cleanup_previews set executed_at=now(),execution_result=v_result,approval_request_id=v_request.id where id=p_preview_id;
  if v_request.id is not null then perform public.mark_approval_applied(v_request.id,p_preview_id::text); end if;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id,reason,before_state,after_state)
  values('cleanup.executed','cleanup_execution',p_preview_id::text,v_preview.category,
    v_result,auth.uid()::text,coalesce(v_name,'Staff'),v_request.decided_by,v_request.decided_by_name,
    v_preview.branch_id,'settings',v_preview.correlation_id::text,'Confirmed selective cleanup',
    jsonb_build_object('filters',v_preview.filters,'counts',v_preview.preview_state-array['delete_ids','anonymize_ids','archive_ids','protected_ids']),v_result);
  return v_result;
end;
$$;

grant execute on function public.execute_selective_cleanup(uuid,text,text,text,uuid) to authenticated;
revoke all on function public.execute_selective_cleanup(uuid,text,text,text,uuid) from anon;

-- ── 4. public.register_resolve_private (from 0082_desktop_registers_and_hardware.sql) ──
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
     or v_register.credential_hash<>encode(extensions.digest(p_credential,'sha256'),'hex')
     or (p_require_active and not v_register.active)
     or not public.can_access_branch(v_register.branch_id) then
    raise exception 'Register binding is invalid, inactive or outside the user branch' using errcode='42501';
  end if;
  return v_register;
end
$function$;
revoke all on function public.register_resolve_private(uuid,text,boolean) from public,anon,authenticated;

-- ── 5. public.register_create (from 0082_desktop_registers_and_hardware.sql) ──────────
create or replace function public.register_create(
  p_code text,p_name text,p_branch_id uuid,p_installation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_register public.registers; v_credential text:=encode(extensions.gen_random_bytes(32),'hex'); v_user_name text;
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
    encode(extensions.digest(v_credential,'sha256'),'hex'),auth.uid()) returning * into v_register;
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
revoke all on function public.register_create(text,text,uuid,uuid) from public,anon;
grant execute on function public.register_create(text,text,uuid,uuid) to authenticated,service_role;

-- ── 6. public.mobile_installation_register (from 0083_mobile_installations_and_push.sql) ──
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
   where push_token_hash=encode(extensions.digest(p_push_token,'sha256'),'hex')
     and installation_id<>p_installation_id;
  insert into public.mobile_installations(
    installation_id,user_id,branch_id,platform,app_version,push_token,push_token_hash,push_registered,active,last_seen_at
  ) values(
    p_installation_id,auth.uid(),v_branch,p_platform,btrim(p_app_version),p_push_token,
    encode(extensions.digest(p_push_token,'sha256'),'hex'),true,true,now()
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

-- ── 7. public.mobile_installation_register_v2 (from 0092_mobile_push_and_notification_center.sql) ──
create or replace function public.mobile_installation_register_v2(
  p_installation_id uuid,
  p_platform text,
  p_app_version text,
  p_push_token text,
  p_locale text default 'en'
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
  v_hash text;
  v_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_installation_id is null or p_platform not in('android','ios')
     or char_length(btrim(coalesce(p_app_version,''))) not between 1 and 64
     or char_length(coalesce(p_push_token,'')) not between 16 and 4096
     or p_locale not in('en','ar') then
    raise exception 'Invalid mobile registration' using errcode='23514';
  end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Active user required' using errcode='42501';
  end if;

  v_branch:=public.current_branch_id();
  if v_branch is null then raise exception 'Active branch required' using errcode='42501'; end if;
  v_hash:=encode(extensions.digest(p_push_token,'sha256'),'hex');
  select * into v_existing from public.mobile_installations
   where installation_id=p_installation_id for update;
  if v_existing.id is not null and v_existing.user_id<>auth.uid() and v_existing.active then
    raise exception 'Installation belongs to another active user' using errcode='42501';
  end if;

  v_changed:=v_existing.id is null
    or v_existing.user_id<>auth.uid()
    or not v_existing.active
    or not v_existing.push_registered
    or v_existing.push_token_hash is distinct from v_hash
    or v_existing.platform is distinct from p_platform
    or v_existing.app_version is distinct from btrim(p_app_version)
    or v_existing.locale is distinct from p_locale;

  -- Provider token rotation/reinstall may move one token to a new installation.
  -- The old row is terminally deactivated so one token cannot target two users.
  update public.mobile_installations
     set push_token=null,push_token_hash=null,push_registered=false,active=false,
         deactivated_at=now(),last_seen_at=now()
   where push_token_hash=v_hash and installation_id<>p_installation_id;

  insert into public.mobile_installations(
    installation_id,user_id,branch_id,platform,app_version,locale,
    push_token,push_token_hash,push_registered,active,last_seen_at,
    deactivated_at,invalidated_at
  ) values(
    p_installation_id,auth.uid(),v_branch,p_platform,btrim(p_app_version),p_locale,
    p_push_token,v_hash,true,true,now(),null,null
  )
  on conflict(installation_id) do update set
    user_id=excluded.user_id,branch_id=excluded.branch_id,platform=excluded.platform,
    app_version=excluded.app_version,locale=excluded.locale,
    push_token=excluded.push_token,push_token_hash=excluded.push_token_hash,
    push_registered=true,active=true,last_seen_at=now(),
    deactivated_at=null,invalidated_at=null;

  if v_changed then
    select name into v_profile_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
    values('mobile.installation_registered','mobile_installation',p_installation_id::text,'ALYQ Mobile',
      jsonb_build_object('platform',p_platform,'app_version',btrim(p_app_version),'locale',p_locale,'push_registered',true),
      auth.uid()::text,coalesce(v_profile_name,'Staff'),v_branch,'mobile');
  end if;
  return jsonb_build_object('installation_id',p_installation_id,'active',true,
    'push_registered',true,'branch_id',v_branch,'locale',p_locale);
end
$function$;
revoke all on function public.mobile_installation_register_v2(uuid,text,text,text,text) from public,anon;
grant execute on function public.mobile_installation_register_v2(uuid,text,text,text,text) to authenticated,service_role;

-- Keep the application/database compatibility contract aligned with migration 0096.
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
    'migration','0096_qualify_legacy_crypto_functions.sql','migration_count',96,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0096_qualify_legacy_crypto_functions.sql (count 96).';

commit;

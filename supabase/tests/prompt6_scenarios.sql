-- Prompt 6 focused scenarios: management installation custody, branch context,
-- token non-disclosure, ownership, logout deactivation and audit.

do $prompt6_mobile$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_install uuid := '00000000-0000-4000-8000-000000006001';
  v_token text := 'provider-token-prompt6-abcdefghijklmnopqrstuvwxyz';
  v_result jsonb;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  v_result:=public.mobile_installation_register(v_install,'android','6.0.0',v_token);
  if (v_result->>'installation_id')::uuid<>v_install
     or (v_result->>'branch_id')::uuid<>v_main
     or v_result::text like '%'||v_token||'%' then
    raise exception 'mobile registration returned unsafe or incorrect identity';
  end if;
  if exists(select 1 from public.mobile_installations) then
    raise exception 'authenticated caller read token-custody table';
  end if;

  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.mobile_installation_register(v_install,'android','6.0.0','another-provider-token-abcdefghijklmnopqrstuvwxyz');
    raise exception 'another user claimed a mobile installation';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_admin,'authenticated');
  if not public.mobile_installation_deactivate(v_install) then
    raise exception 'own installation did not deactivate';
  end if;
  if public.mobile_installation_deactivate(v_install) then
    raise exception 'deactivation was not idempotent';
  end if;

  perform pg_temp.become(null,'service_role');
  if exists(select 1 from public.mobile_installations where installation_id=v_install and
    (active or push_registered or push_token is not null or push_token_hash is not null)) then
    raise exception 'logout retained sensitive push routing';
  end if;
  if (select branch_id from public.mobile_installations where installation_id=v_install)<>v_main then
    raise exception 'registration did not preserve authoritative branch context';
  end if;
  if (select count(*) from public.audit_log where entity_id=v_install::text and action in('mobile.installation_registered','mobile.installation_deactivated'))<>2 then
    raise exception 'mobile installation lifecycle audit missing';
  end if;
  if exists(select 1 from public.audit_log where entity_id=v_install::text and details::text like '%'||v_token||'%') then
    raise exception 'audit exposed a push token';
  end if;
  raise notice 'Prompt 6 mobile installation security scenarios passed';
end
$prompt6_mobile$;

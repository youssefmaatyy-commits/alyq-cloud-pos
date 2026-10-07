-- 0095 focused regression — hosted Supabase keeps pgcrypto in `extensions`,
-- without a public.digest forwarding function. Prove subscription lifecycle,
-- deny-by-default custody, rotation and deduplication in that exact namespace.

do $web_push_0095$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_client_1 uuid := '00000000-0000-4000-8000-000000009501';
  v_client_2 uuid := '00000000-0000-4000-8000-000000009502';
  v_client_3 uuid := '00000000-0000-4000-8000-000000009503';
  v_endpoint_1 text := 'https://push.example.test/subscription/repair-one-v1';
  v_endpoint_1_rotated text := 'https://push.example.test/subscription/repair-one-v2';
  v_endpoint_2 text := 'https://push.example.test/subscription/repair-two';
  v_result jsonb;
  v_hash_before text;
  v_hash_after text;
  v_definition text;
  v_signature text;
  v_count integer;
begin
  -- The old shim mirrored digest into public and hid 0094's production failure.
  -- Remove only that test-only forwarding function before exercising repaired
  -- RPCs. The extension itself remains in Supabase's production schema.
  perform pg_temp.become(null,'postgres');
  drop function if exists public.digest(text,text);
  if to_regprocedure('public.digest(text,text)') is not null
     or to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'test environment does not match hosted pgcrypto namespace';
  end if;

  -- All three installed 0094 functions that hash data must bind the extension
  -- explicitly while retaining their hardened pg_catalog,public search_path.
  foreach v_signature in array array[
    'public.web_push_subscription_register(uuid,text,text,text,text,timestamptz)',
    'public.notification_claim_push_batch(text,integer,integer)',
    'public.notification_record_push_result(uuid,text,text,integer,text,text,integer)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure::oid) into v_definition;
    if strpos(v_definition,'extensions.digest')=0
       or strpos(v_definition,'SET search_path TO ''pg_catalog'', ''public''')=0 then
      raise exception '0095 digest/search_path repair missing from %',v_signature;
    end if;
  end loop;

  -- Preserve the exact 0094 custody boundary: RLS enabled, no policies, no
  -- ordinary-client table grant, service_role read-only, and narrow RPC grants.
  if not (select relrowsecurity from pg_class
           where oid='public.web_push_subscriptions'::regclass)
     or exists(select 1 from pg_policies
                where schemaname='public' and tablename='web_push_subscriptions')
     or has_table_privilege('anon','public.web_push_subscriptions','select')
     or has_table_privilege('authenticated','public.web_push_subscriptions','select')
     or not has_table_privilege('service_role','public.web_push_subscriptions','select')
     or has_table_privilege('service_role','public.web_push_subscriptions','insert')
     or has_table_privilege('service_role','public.web_push_subscriptions','update')
     or has_table_privilege('service_role','public.web_push_subscriptions','delete') then
    raise exception '0095 changed Web Push table RLS or grants';
  end if;
  if not has_function_privilege('authenticated',
       'public.web_push_subscription_register(uuid,text,text,text,text,timestamptz)','execute')
     or not has_function_privilege('authenticated',
       'public.web_push_subscription_deactivate(uuid)','execute')
     or not has_function_privilege('authenticated',
       'public.web_push_subscriptions_deactivate_all()','execute')
     or has_function_privilege('anon',
       'public.web_push_subscription_register(uuid,text,text,text,text,timestamptz)','execute')
     or has_function_privilege('authenticated',
       'public.notification_claim_push_batch(text,integer,integer)','execute')
     or has_function_privilege('authenticated',
       'public.notification_record_push_result(uuid,text,text,integer,text,text,integer)','execute')
     or not has_function_privilege('service_role',
       'public.notification_claim_push_batch(text,integer,integer)','execute')
     or not has_function_privilege('service_role',
       'public.notification_record_push_result(uuid,text,text,integer,text,text,integer)','execute') then
    raise exception '0095 changed Web Push lifecycle or worker RPC grants';
  end if;

  delete from public.web_push_subscriptions
   where client_id in(v_client_1,v_client_2,v_client_3);
  update public.profiles set active=true,active_branch_id=v_main where id=v_admin;
  update public.branch_memberships set active=true
   where user_id=v_admin and branch_id=v_main;

  -- Authenticated registration must now hash and insert without public.digest.
  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.web_push_subscription_register(
    v_client_1,v_endpoint_1,repeat('A',87),repeat('B',22),'en',null);
  if v_result->>'active'<>'true'
     or v_result ?| array['endpoint','endpoint_hash','p256dh','auth','auth_secret'] then
    raise exception 'registration failed or returned private subscription material';
  end if;
  begin
    perform endpoint,p256dh,auth_secret from public.web_push_subscriptions
     where client_id=v_client_1;
    raise exception 'ordinary user read raw Web Push subscription material';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(null,'postgres');
  select endpoint_hash into v_hash_before from public.web_push_subscriptions
   where client_id=v_client_1 and active;
  if v_hash_before is null or char_length(v_hash_before)<>64
     or v_hash_before<>encode(extensions.digest(v_endpoint_1,'sha256'),'hex') then
    raise exception 'endpoint hash was not populated by extensions.digest';
  end if;

  -- Re-registering is idempotent, rotation stays in place, and two distinct
  -- browser subscriptions remain active for the same user.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.web_push_subscription_register(
    v_client_1,v_endpoint_1,repeat('A',87),repeat('B',22),'en',null);
  perform public.web_push_subscription_register(
    v_client_1,v_endpoint_1_rotated,repeat('C',87),repeat('D',22),'ar',null);
  perform public.web_push_subscription_register(
    v_client_2,v_endpoint_2,repeat('E',87),repeat('F',22),'en',null);

  perform pg_temp.become(null,'postgres');
  select endpoint_hash into v_hash_after from public.web_push_subscriptions
   where client_id=v_client_1 and active;
  if (select count(*) from public.web_push_subscriptions where client_id=v_client_1)<>1
     or (select count(*) from public.web_push_subscriptions where user_id=v_admin and active)<>2
     or v_hash_after=v_hash_before
     or v_hash_after<>encode(extensions.digest(v_endpoint_1_rotated,'sha256'),'hex') then
    raise exception 'idempotent registration, rotation or multiple browsers regressed';
  end if;

  -- A reset browser identity presenting the same endpoint retires the stale
  -- same-user row, rather than creating two active deliveries for one endpoint.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.web_push_subscription_register(
    v_client_3,v_endpoint_2,repeat('G',87),repeat('H',22),'en',null);
  perform pg_temp.become(null,'postgres');
  select count(*) into v_count from public.web_push_subscriptions
   where user_id=v_admin and active;
  if v_count<>2
     or exists(select 1 from public.web_push_subscriptions
                where client_id=v_client_2
                  and (active or endpoint is not null or endpoint_hash is not null
                       or p256dh is not null or auth_secret is not null))
     or (select count(*) from public.web_push_subscriptions
          where endpoint_hash=encode(extensions.digest(v_endpoint_2,'sha256'),'hex'))<>1 then
    raise exception 'same-endpoint duplicate retirement regressed';
  end if;

  -- Per-browser and all-browser deactivation still clear every raw secret.
  perform pg_temp.become(v_admin,'authenticated');
  if not public.web_push_subscription_deactivate(v_client_1)
     or public.web_push_subscription_deactivate(v_client_1) then
    raise exception 'per-browser deactivation is not effective and idempotent';
  end if;
  if public.web_push_subscriptions_deactivate_all()<>1 then
    raise exception 'all-browser deactivation count regressed';
  end if;

  perform pg_temp.become(null,'postgres');
  if exists(select 1 from public.web_push_subscriptions
             where client_id in(v_client_1,v_client_2,v_client_3)
               and (active or endpoint is not null or endpoint_hash is not null
                    or p256dh is not null or auth_secret is not null)) then
    raise exception 'deactivation retained Web Push subscription material';
  end if;
  delete from public.web_push_subscriptions
   where client_id in(v_client_1,v_client_2,v_client_3);

  raise notice '0095 — extensions.digest registration, endpoint hashing, deny-by-default custody, rotation, multiple browsers, duplicate retirement, deactivation and unchanged RLS/grants passed';
end
$web_push_0095$;

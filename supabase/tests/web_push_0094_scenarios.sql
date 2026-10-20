-- 0094 focused scenarios — secure subscription custody, rotation, multiple
-- browsers, shared outbox/inbox delivery, retry, invalidation and logout.

do $web_push_0094$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_client_1 uuid := '00000000-0000-4000-8000-000000009401';
  v_client_2 uuid := '00000000-0000-4000-8000-000000009402';
  v_outbox uuid;
  v_delivery_1 uuid;
  v_delivery_2 uuid;
  v_notification uuid;
  v_result jsonb;
  v_health jsonb;
  v_count integer;
begin
  perform pg_temp.become(null,'postgres');
  delete from public.notification_outbox where dedupe_key like 'test-0094:%';
  delete from public.web_push_subscriptions where client_id in(v_client_1,v_client_2);
  update public.profiles set active=true,active_branch_id=v_main where id in(v_admin,v_cashier);
  update public.branch_memberships set active=true where user_id in(v_admin,v_cashier) and branch_id=v_main;

  -- Two browser/Home Screen installations for one user. Re-registering client 1
  -- rotates endpoint and encryption material in place instead of duplicating it.
  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.web_push_subscription_register(
    v_client_1,'https://push.example.test/subscription/admin-one-v1',repeat('A',87),repeat('B',22),'en',null);
  if v_result->>'active'<>'true' then raise exception 'web subscription 1 did not activate'; end if;
  perform public.web_push_subscription_register(
    v_client_2,'https://push.example.test/subscription/admin-two',repeat('C',87),repeat('D',22),'ar',null);
  perform public.web_push_subscription_register(
    v_client_1,'https://push.example.test/subscription/admin-one-v2',repeat('E',87),repeat('F',22),'en',null);

  perform pg_temp.become(null,'postgres');
  if (select count(*) from public.web_push_subscriptions where user_id=v_admin and active)<>2
     or (select endpoint from public.web_push_subscriptions where client_id=v_client_1)
        <>'https://push.example.test/subscription/admin-one-v2'
     or (select p256dh from public.web_push_subscriptions where client_id=v_client_1)<>repeat('E',87) then
    raise exception 'multiple-browser registration or subscription rotation failed';
  end if;

  -- An active browser identity cannot be claimed by another signed-in user.
  perform pg_temp.become(v_cashier,'authenticated');
  begin
    perform public.web_push_subscription_register(
      v_client_1,'https://push.example.test/subscription/attacker',repeat('G',87),repeat('H',22),'en',null);
    raise exception 'active browser subscription ownership was bypassed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform endpoint from public.web_push_subscriptions where client_id=v_client_1;
    raise exception 'ordinary user read raw Web Push subscription material';
  exception when insufficient_privilege then null;
  end;

  -- One existing business fact/inbox expands to two Web Push deliveries. No
  -- second outbox or notification-center system is introduced.
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_outbox:=public.notification_enqueue(
    'test-0094:approval','manager_approval',v_main,'approval_request',
    '00000000-0000-4000-8000-0000000094a1','health','',array['approve_limit_request'],
    'Approval required','موافقة مطلوبة','Safe in-app detail','تفاصيل آمنة داخل التطبيق');
  select count(*),min(delivery_id::text)::uuid,max(delivery_id::text)::uuid,
         min(notification_id::text)::uuid
    into v_count,v_delivery_1,v_delivery_2,v_notification
    from public.notification_claim_push_batch('worker-0094-first',20,10)
   where platform='web' and (push_token::jsonb ?& array['endpoint','p256dh','auth']);
  if v_count<>2 or v_delivery_1=v_delivery_2 then
    raise exception 'expected two bounded Web Push deliveries, got %',v_count;
  end if;
  if (select count(*) from public.user_notification_inbox where outbox_id=v_outbox and user_id=v_admin)<>1
     or (select count(*) from public.notification_push_deliveries
          where outbox_id=v_outbox and provider='web_push')<>2 then
    raise exception 'Web Push duplicated the business inbox or lost a browser delivery';
  end if;

  select d.id into v_delivery_1
    from public.notification_push_deliveries d
    join public.web_push_subscriptions s on s.id=d.web_push_subscription_id
   where d.outbox_id=v_outbox and s.client_id=v_client_1;
  select d.id into v_delivery_2
    from public.notification_push_deliveries d
    join public.web_push_subscriptions s on s.id=d.web_push_subscription_id
   where d.outbox_id=v_outbox and s.client_id=v_client_2;

  -- Transient Web Push failure shares the bounded retry schedule; a 410-style
  -- invalid subscription clears only the exact endpoint/key material.
  v_result:=public.notification_record_push_result(
    v_delivery_1,'worker-0094-first','retry',503,'web_push_unavailable',null,30);
  if v_result->>'status'<>'retry' then raise exception 'Web Push transient retry was not scheduled'; end if;
  v_result:=public.notification_record_push_result(
    v_delivery_2,'worker-0094-first','invalid_token',410,'web_push_gone',null,null);
  if v_result->>'status'<>'permanent_failure' then raise exception 'invalid Web Push endpoint was not terminal'; end if;
  perform pg_temp.become(null,'postgres');
  if exists(select 1 from public.web_push_subscriptions where client_id=v_client_2
             and (active or endpoint is not null or endpoint_hash is not null
                  or p256dh is not null or auth_secret is not null)) then
    raise exception 'invalid Web Push subscription material was retained';
  end if;
  update public.notification_push_deliveries set next_attempt_at=now() where id=v_delivery_1;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  select delivery_id into v_delivery_1
    from public.notification_claim_push_batch('worker-0094-retry',20,10)
   where platform='web' limit 1;
  v_result:=public.notification_record_push_result(
    v_delivery_1,'worker-0094-retry','delivered',201,null,null,null);
  if v_result->>'status'<>'delivered'
     or (select count(*) from public.notification_delivery_attempts where delivery_id=v_delivery_1)<>2
     or (select state from public.notification_outbox where id=v_outbox)<>'completed' then
    raise exception 'Web Push retry/delivery evidence or outbox completion failed';
  end if;

  -- Server-side expiration cleanup removes material even if a browser never
  -- returns to unregister itself.
  perform pg_temp.become(null,'postgres');
  update public.web_push_subscriptions set expiration_time=now()-interval '1 second'
   where client_id=v_client_1;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.notification_claim_push_batch('worker-0094-expiry',20,10);
  perform pg_temp.become(null,'postgres');
  if exists(select 1 from public.web_push_subscriptions where client_id=v_client_1
             and (active or endpoint is not null or endpoint_hash is not null
                  or p256dh is not null or auth_secret is not null)) then
    raise exception 'expired Web Push subscription material was retained';
  end if;

  -- Client logout removes only this browser's material. Registration can then
  -- refresh it, while logout-all clears every browser before Auth revocation.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.web_push_subscription_register(
    v_client_1,'https://push.example.test/subscription/admin-one-after-expiry',repeat('K',87),repeat('L',22),'en',null);
  if not public.web_push_subscription_deactivate(v_client_1) then
    raise exception 'current-browser Web Push logout did not deactivate';
  end if;
  perform public.web_push_subscription_register(
    v_client_1,'https://push.example.test/subscription/admin-one-v3',repeat('I',87),repeat('J',22),'en',null);
  if public.web_push_subscriptions_deactivate_all()<>1 then
    raise exception 'logout-all did not deactivate every remaining Web Push browser';
  end if;
  perform pg_temp.become(null,'postgres');
  if exists(select 1 from public.web_push_subscriptions where user_id=v_admin
             and (active or endpoint is not null or endpoint_hash is not null
                  or p256dh is not null or auth_secret is not null)) then
    raise exception 'logout-all retained Web Push routing material';
  end if;

  -- Existing server-authorized Notification Center remains authoritative even
  -- after provider failure/deactivation.
  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.notification_center_resolve_route(v_notification);
  if v_result->>'ok'<>'true' or v_result->>'route_key'<>'health' then
    raise exception 'Notification Center stopped resolving after Web Push lifecycle: %',v_result;
  end if;
  v_health:=public.system_health_probe();
  if v_health->>'migration'<>'0096_qualify_legacy_crypto_functions.sql'
     or (v_health->>'migration_count')::integer<>96 then
    raise exception 'current health contract mismatch after Web Push lifecycle: %',v_health;
  end if;

  perform pg_temp.become(null,'postgres');
  delete from public.notification_outbox where dedupe_key like 'test-0094:%';
  delete from public.web_push_subscriptions where client_id in(v_client_1,v_client_2);
  raise notice '0094 — Web Push subscription creation/rotation, multiple browsers, protected key custody, shared inbox/outbox deduplication, retry, invalid cleanup, local/global logout and Notification Center fallback passed';
end
$web_push_0094$;

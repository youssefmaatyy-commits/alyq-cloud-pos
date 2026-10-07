-- 0092 focused scenarios — recipient authority, idempotency, bounded delivery,
-- invalid-token custody, notification-center read state and installation lifecycle.

do $push_0092$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_other uuid := '00000000-0000-4000-8000-0000000092b2';
  v_admin_install_1 uuid := '00000000-0000-4000-8000-000000009201';
  v_admin_install_2 uuid := '00000000-0000-4000-8000-000000009202';
  v_cashier_install uuid := '00000000-0000-4000-8000-000000009203';
  v_viewer_install uuid := '00000000-0000-4000-8000-000000009204';
  v_outbox uuid;
  v_duplicate uuid;
  v_dead_outbox uuid;
  v_dead_delivery uuid;
  v_delivery_1 uuid;
  v_delivery_2 uuid;
  v_notification uuid;
  v_stale_notification uuid;
  v_before timestamptz;
  v_result jsonb;
  v_count integer;
begin
  -- Clean only this scenario's deterministic keys/installations.
  perform pg_temp.become(null,'postgres');
  delete from public.notification_outbox where dedupe_key like 'test-0092:%';
  delete from public.mobile_installations where installation_id in(
    v_admin_install_1,v_admin_install_2,v_cashier_install,v_viewer_install);
  insert into public.branches(id,code,name_en,name_ar,active,is_default)
  values(v_other,'push92','Push test branch','فرع اختبار الإشعارات',true,false)
  on conflict(id) do update set active=true;
  insert into public.branch_memberships(user_id,branch_id,role,active)
  values(v_admin,v_other,'admin',true)
  on conflict(user_id,branch_id) do update set role='admin',active=true;
  update public.profiles set active=true,active_branch_id=v_main where id in(v_admin,v_cashier,v_viewer);
  update public.branch_memberships set active=true where user_id in(v_admin,v_cashier,v_viewer) and branch_id=v_main;

  -- Multiple devices, rotation and ownership-safe registration.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.mobile_installation_register_v2(v_admin_install_1,'android','6.0.0',
    'fcm-admin-one-0092-abcdefghijklmnopqrstuvwxyz','en');
  perform public.mobile_installation_register_v2(v_admin_install_2,'ios','6.0.0',
    'apns-admin-two-0092-abcdefghijklmnopqrstuvwxyz','ar');
  perform public.mobile_installation_register_v2(v_admin_install_1,'android','6.0.1',
    'fcm-admin-one-rotated-0092-abcdefghijklmnopqrstuvwxyz','en');
  perform pg_temp.become(null,'service_role');
  if (select app_version from public.mobile_installations where installation_id=v_admin_install_1)<>'6.0.1'
     or (select push_token_hash from public.mobile_installations where installation_id=v_admin_install_1)
        <>encode(digest('fcm-admin-one-rotated-0092-abcdefghijklmnopqrstuvwxyz','sha256'),'hex') then
    raise exception 'token rotation/app update was not persisted';
  end if;

  perform pg_temp.become(v_cashier,'authenticated');
  perform public.mobile_installation_register_v2(v_cashier_install,'android','6.0.0',
    'fcm-cashier-0092-abcdefghijklmnopqrstuvwxyz','en');
  perform pg_temp.become(v_viewer,'authenticated');
  perform public.mobile_installation_register_v2(v_viewer_install,'ios','6.0.0',
    'apns-viewer-0092-abcdefghijklmnopqrstuvwxyz','en');

  -- One deterministic fact remains one outbox row even when enqueued twice.
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_outbox:=public.notification_enqueue(
    'test-0092:approval','manager_approval',v_main,'approval_request',
    '00000000-0000-4000-8000-0000000092a1','health',
    '',array['approve_limit_request'],
    'Approval required','موافقة مطلوبة','Safe body','نص آمن');
  v_duplicate:=public.notification_enqueue(
    'test-0092:approval','manager_approval',v_main,'approval_request',
    '00000000-0000-4000-8000-0000000092a1','health',
    '',array['approve_limit_request'],
    'Approval required','موافقة مطلوبة','Safe body','نص آمن');
  if v_duplicate<>v_outbox or (select count(*) from public.notification_outbox where dedupe_key='test-0092:approval')<>1 then
    raise exception 'outbox deduplication failed';
  end if;

  -- Current permission and active-branch authority are resolved now, not from
  -- installation.branch_id. Only the admin's two devices are eligible.
  select count(*),min(delivery_id::text)::uuid,max(delivery_id::text)::uuid,min(notification_id::text)::uuid
    into v_count,v_delivery_1,v_delivery_2,v_notification
    from public.notification_claim_push_batch('worker-0092-a',20,10);
  if v_count<>2 or v_delivery_1=v_delivery_2 then
    raise exception 'permission/multiple-device filtering expected two admin deliveries, got %',v_count;
  end if;
  if exists(select 1 from public.notification_push_deliveries where outbox_id=v_outbox and user_id in(v_cashier,v_viewer)) then
    raise exception 'unauthorized cashier/viewer received approval delivery';
  end if;

  -- Inbox state is durable and user-scoped.
  perform pg_temp.become(v_admin,'authenticated');
  if public.notification_center_unread_count()<>1
     or (select count(*) from public.notification_center_list(100,null))<>1 then
    raise exception 'notification center unread/list contract failed';
  end if;
  if not public.notification_center_mark_read(v_notification) then
    raise exception 'mark-read refused notification %',v_notification;
  end if;
  if public.notification_center_unread_count()<>0 then
    raise exception 'mark-read did not clear unread count for %',v_notification;
  end if;
  perform pg_temp.become(null,'postgres');
  update public.user_notification_inbox set read_at=null where id=v_notification;
  perform pg_temp.become(v_admin,'authenticated');
  if public.notification_center_mark_all_read()<>1 then
    raise exception 'mark-all-read did not update the unread row';
  end if;
  if public.notification_center_unread_count()<>0 then
    raise exception 'mark-all-read did not clear the unread count';
  end if;
  v_result:=public.notification_center_resolve_route(v_notification);
  if v_result->>'ok'<>'true' or v_result->>'route_key'<>'health' then
    raise exception 'authorized notification route was not resolved: %',v_result;
  end if;
  perform pg_temp.become(null,'postgres');
  update public.branch_memberships set active=false where user_id=v_admin and branch_id=v_main;
  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.notification_center_resolve_route(v_notification);
  if v_result->>'ok'<>'false'
     or (select count(*) from public.notification_center_list(100,null))<>0 then
    raise exception 'revoked current membership retained inbox/route access: %',v_result;
  end if;
  perform pg_temp.become(null,'postgres');
  update public.branch_memberships set active=true where user_id=v_admin and branch_id=v_main;
  perform pg_temp.become(v_viewer,'authenticated');
  if (select count(*) from public.notification_center_list(100,null))<>0 then
    raise exception 'viewer read another user notification';
  end if;

  -- Retry is bounded and scheduled in the future; invalid-token is permanent
  -- and clears only the exact token snapshot that failed.
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_before:=clock_timestamp();
  v_result:=public.notification_record_push_result(
    v_delivery_1,'worker-0092-a','retry',503,'provider_unavailable',null,30);
  if v_result->>'status'<>'retry'
     or (select next_attempt_at from public.notification_push_deliveries where id=v_delivery_1)<v_before+interval '15 seconds' then
    raise exception 'bounded retry/backoff failed: %',v_result;
  end if;
  v_result:=public.notification_record_push_result(
    v_delivery_2,'worker-0092-a','invalid_token',410,'unregistered',null,null);
  if v_result->>'status'<>'permanent_failure'
     or exists(select 1 from public.mobile_installations m
                join public.notification_push_deliveries d on d.installation_id=m.id
               where d.id=v_delivery_2 and (m.active or m.push_registered or m.push_token is not null)) then
    raise exception 'invalid provider token did not deactivate installation';
  end if;
  perform pg_temp.become(null,'postgres');
  update public.notification_push_deliveries set next_attempt_at=now() where id=v_delivery_1;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  select claimed.delivery_id into v_delivery_1
    from public.notification_claim_push_batch('worker-0092-b',20,10) claimed
   limit 1;
  v_result:=public.notification_record_push_result(
    v_delivery_1,'worker-0092-b','delivered',200,null,'provider-message-0092',null);
  if v_result->>'status'<>'delivered'
     or (select state from public.notification_outbox where id=v_outbox)<>'completed'
     or (select count(*) from public.notification_delivery_attempts where delivery_id=v_delivery_1)<>2
     or not exists(select 1 from public.notification_delivery_attempts
                    where delivery_id=v_delivery_1
                      and provider_reference_hash=encode(digest('provider-message-0092','sha256'),'hex')) then
    raise exception 'successful retry/attempt evidence failed';
  end if;

  -- A retry at its attempt cap becomes terminal and dead-letters the fact.
  v_dead_outbox:=public.notification_enqueue(
    'test-0092:dead-letter','offline_sync_failure',v_main,'register',
    '00000000-0000-4000-8000-0000000092d1','health','',array['approve_limit_request'],
    'Sync alert','تنبيه مزامنة','Safe body','نص آمن');
  select claimed.delivery_id into v_dead_delivery
    from public.notification_claim_push_batch('worker-0092-dead',20,10) claimed
   limit 1;
  if v_dead_delivery is null then raise exception 'dead-letter scenario claimed no delivery'; end if;
  perform pg_temp.become(null,'postgres');
  update public.notification_push_deliveries set max_attempts=1 where id=v_dead_delivery;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_result:=public.notification_record_push_result(
    v_dead_delivery,'worker-0092-dead','retry',503,'provider_unavailable',null,15);
  if v_result->>'status'<>'permanent_failure'
     or (select state from public.notification_outbox where id=v_dead_outbox)<>'dead'
     or (select dead_letter_at from public.notification_outbox where id=v_dead_outbox) is null then
    raise exception 'attempt cap/dead-letter aggregation failed: %',v_result;
  end if;

  -- Entity access is rechecked at send/open time. A stale opaque target remains
  -- visible in history but cannot produce a provider send or a deep link.
  perform public.notification_enqueue(
    'test-0092:stale-entity','critical_stock',v_main,'branch_stock_balance',
    '00000000-0000-4000-8000-0000000092a4','product',
    '00000000-0000-4000-8000-0000000092f4',array['view_inventory'],
    'Stock alert','تنبيه مخزون','Safe body','نص آمن');
  perform public.notification_claim_push_batch('worker-0092-stale',20,10);
  select i.id into v_stale_notification from public.user_notification_inbox i
    join public.notification_outbox o on o.id=i.outbox_id
   where o.dedupe_key='test-0092:stale-entity' and i.user_id=v_admin;
  if v_stale_notification is null
     or exists(select 1 from public.notification_push_deliveries d
                join public.notification_outbox o on o.id=d.outbox_id
               where o.dedupe_key='test-0092:stale-entity') then
    raise exception 'stale entity was not isolated from provider delivery';
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.notification_center_resolve_route(v_stale_notification);
  if v_result->>'reason'<>'entity_unavailable' then
    raise exception 'stale route was not safely refused: %',v_result;
  end if;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);

  -- Current active branch is mandatory. A membership in another branch does not
  -- target a user who is presently operating Main Branch.
  perform public.notification_enqueue(
    'test-0092:other-branch','critical_stock',v_other,'branch_stock_balance',
    '00000000-0000-4000-8000-0000000092a2','product',
    '00000000-0000-4000-8000-0000000000f2',array['view_inventory'],
    'Stock alert','تنبيه مخزون','Safe body','نص آمن');
  perform public.notification_claim_push_batch('worker-0092-c',20,10);
  if exists(select 1 from public.user_notification_inbox i
             join public.notification_outbox o on o.id=i.outbox_id
            where o.dedupe_key='test-0092:other-branch') then
    raise exception 'inactive branch context received a notification';
  end if;

  -- Inactive users are excluded even when an installation remains registered.
  perform pg_temp.become(null,'postgres');
  update public.profiles set active=false where id=v_cashier;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.notification_enqueue(
    'test-0092:inactive','online_order',v_main,'online_order',
    '00000000-0000-4000-8000-0000000092a3','order',
    '00000000-0000-4000-8000-0000000092a3',array['manage_online_orders'],
    'Order','طلب','Safe body','نص آمن');
  perform public.notification_claim_push_batch('worker-0092-d',20,10);
  if exists(select 1 from public.user_notification_inbox i
             join public.notification_outbox o on o.id=i.outbox_id
            where o.dedupe_key='test-0092:inactive' and i.user_id=v_cashier) then
    raise exception 'inactive user received a notification';
  end if;

  -- Global logout deactivates every installation without exposing a raw token.
  perform pg_temp.become(null,'postgres');
  update public.profiles set active=true where id=v_cashier;
  update public.branch_memberships set active=true where user_id=v_cashier and branch_id=v_main;
  perform pg_temp.become(v_admin,'authenticated');
  if public.mobile_installations_deactivate_all()<1 then
    raise exception 'logout-all did not deactivate remaining installations';
  end if;
  perform pg_temp.become(null,'service_role');
  if exists(select 1 from public.mobile_installations where user_id=v_admin
             and (active or push_registered or push_token is not null or push_token_hash is not null)) then
    raise exception 'logout-all retained provider routing custody';
  end if;
  if exists(select 1 from public.notification_outbox
             where title_en like '%@%' or body_en ~ '[0-9]{8,}' or title_en ilike '%token%') then
    raise exception 'privacy-unsafe notification copy detected';
  end if;

  perform pg_temp.become(null,'postgres');
  update public.profiles set active=true,active_branch_id=v_main where id in(v_admin,v_cashier,v_viewer);
  delete from public.notification_outbox where dedupe_key like 'test-0092:%';
  delete from public.mobile_installations where installation_id in(
    v_admin_install_1,v_admin_install_2,v_cashier_install,v_viewer_install);
  delete from public.branch_memberships where user_id=v_admin and branch_id=v_other;
  delete from public.branches where id=v_other;
  raise notice '0092 — current recipient/entity authorization, stale-route refusal, outbox idempotency, multiple devices, token rotation, retry/backoff, capped dead-letter, permanent rejection, invalid-token deactivation, durable read state and logout-all passed';
end
$push_0092$;

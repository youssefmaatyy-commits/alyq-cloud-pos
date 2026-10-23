-- 0099 focused scenarios — immediate Inbox, idempotent fallback, per-kind Push
-- preferences, order/payment identity, current stock and genuine sync failures.
-- This file uses the isolated migration-check fixtures and never calls a provider.

do $notification_0099$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_client uuid := '00000000-0000-4000-8000-000000009901';
  v_category uuid := '00000000-0000-4000-8000-0000000099f1';
  v_product uuid := '00000000-0000-4000-8000-0000000099f2';
  v_balance uuid := '00000000-0000-4000-8000-0000000099f3';
  v_register uuid := '00000000-0000-4000-8000-0000000099f4';
  v_installation uuid := '00000000-0000-4000-8000-0000000099f7';
  v_order uuid := '00000000-0000-4000-8000-0000000099f5';
  v_failed_order uuid := '00000000-0000-4000-8000-0000000099f6';
  v_outbox uuid;
  v_second uuid;
  v_delivery uuid;
  v_notification uuid;
  v_result jsonb;
  v_count integer;
begin
  perform pg_temp.become(null,'postgres');
  delete from public.notification_outbox where dedupe_key like 'test-0099:%'
     or entity_id in(v_order::text,v_failed_order::text,v_balance::text,v_register::text);
  delete from public.web_push_subscriptions where client_id=v_client;
  delete from public.branch_stock_balances where id=v_balance;
  delete from public.registers where id=v_register;
  delete from public.online_orders where id in(v_order,v_failed_order);
  delete from public.products where id=v_product;
  delete from public.categories where id=v_category;
  delete from public.notification_preferences where profile_id=v_admin;
  update public.profiles set active=true,active_branch_id=v_main where id=v_admin;
  update public.branch_memberships set active=true where user_id=v_admin and branch_id=v_main;

  -- A live browser makes the immediate Inbox/delivery split observable without
  -- invoking the worker. Registration still contains test-only material.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.web_push_subscription_register(
    v_client,'https://push.example.test/subscription/0099',repeat('Q',87),repeat('R',22),'en',null);
  v_result:=public.notification_preferences_set(true,true,true);
  if (v_result->>'online_orders')::boolean is not true then
    raise exception 'default preference write/read failed: %',v_result;
  end if;
  begin
    perform profile_id from public.notification_preferences where profile_id=v_admin;
    raise exception 'ordinary user read the deny-all preference table directly';
  exception when insufficient_privilege then null;
  end;
  if jsonb_typeof(public.notification_web_push_public_config())<>'object' then
    raise exception 'public Web Push configuration did not return a safe object';
  end if;

  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_outbox:=public.notification_enqueue(
    'test-0099:immediate','online_order',v_main,'online_order',
    '00000000-0000-4000-8000-0000000099a1','health','',array['manage_online_orders'],
    'Order TEST-0099 needs review','الطلب TEST-0099 يحتاج إلى مراجعة',
    'Safe staff attention copy','نص متابعة آمن للموظف');

  -- No claim or scheduler has run: the AFTER INSERT path already durably
  -- created exactly one authorized Inbox and one current browser delivery.
  if (select count(*) from public.user_notification_inbox where outbox_id=v_outbox and user_id=v_admin)<>1
     or (select count(*) from public.notification_push_deliveries where outbox_id=v_outbox)<>1
     or (select state from public.notification_outbox where id=v_outbox)<>'expanded' then
    raise exception 'Inbox/delivery was still dispatcher-coupled: inbox=%, admin_inbox=%, deliveries=%, state=%',
      (select count(*) from public.user_notification_inbox where outbox_id=v_outbox),
      (select count(*) from public.user_notification_inbox where outbox_id=v_outbox and user_id=v_admin),
      (select count(*) from public.notification_push_deliveries where outbox_id=v_outbox),
      (select state from public.notification_outbox where id=v_outbox);
  end if;
  select count(*) into v_count from public.user_notification_inbox where outbox_id=v_outbox;
  select id into v_notification from public.user_notification_inbox where outbox_id=v_outbox and user_id=v_admin;
  select id into v_delivery from public.notification_push_deliveries where outbox_id=v_outbox;
  if public.notification_process_outbox(20)<>0
     or (select count(*) from public.user_notification_inbox where outbox_id=v_outbox)<>v_count
     or (select count(*) from public.notification_push_deliveries where outbox_id=v_outbox)<>1 then
    raise exception 'idempotent fallback duplicated an expanded fact';
  end if;
  v_second:=public.notification_enqueue(
    'test-0099:immediate','online_order',v_main,'online_order',
    '00000000-0000-4000-8000-0000000099a1','health','',array['manage_online_orders'],
    'Order TEST-0099 needs review','الطلب TEST-0099 يحتاج إلى مراجعة',
    'Safe staff attention copy','نص متابعة آمن للموظف');
  if v_second<>v_outbox or (select count(*) from public.notification_outbox where dedupe_key='test-0099:immediate')<>1 then
    raise exception 'stable event identity did not deduplicate a retry';
  end if;

  -- Temporary provider failure retains the same delivery identity through a
  -- bounded retry; success completes it without another Inbox or Outbox row.
  select claimed.delivery_id into v_second
    from public.notification_claim_push_batch('worker-0099-first',20,20) claimed
   where claimed.notification_id=v_notification;
  if v_second<>v_delivery then raise exception 'immediate delivery was not claimable'; end if;
  v_result:=public.notification_record_push_result(v_delivery,'worker-0099-first','retry',503,'test_outage',null,30);
  if v_result->>'status'<>'retry' then raise exception 'temporary outage did not retain retry'; end if;
  perform pg_temp.become(null,'postgres');
  update public.notification_push_deliveries set next_attempt_at=now() where id=v_delivery;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  select claimed.delivery_id into v_second
    from public.notification_claim_push_batch('worker-0099-retry',20,20) claimed
   where claimed.notification_id=v_notification;
  if v_second<>v_delivery then raise exception 'retry changed delivery identity'; end if;
  v_result:=public.notification_record_push_result(v_delivery,'worker-0099-retry','delivered',201,null,null,null);
  if v_result->>'status'<>'delivered'
     or (select count(*) from public.notification_delivery_attempts where delivery_id=v_delivery)<>2 then
    raise exception 'retry completion/evidence failed';
  end if;

  -- A disabled kind remains in Notification Center but creates no device
  -- delivery. Re-enabling cannot release the old suppressed event.
  perform pg_temp.become(v_admin,'authenticated');
  perform public.notification_preferences_set(false,true,true);
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  v_outbox:=public.notification_enqueue(
    'test-0099:preference','online_order',v_main,'online_order',
    '00000000-0000-4000-8000-0000000099a2','health','',array['manage_online_orders'],
    'Order TEST-0099-PREF needs review','الطلب TEST-0099-PREF يحتاج إلى مراجعة',
    'Safe staff attention copy','نص متابعة آمن للموظف');
  if (select count(*) from public.user_notification_inbox where outbox_id=v_outbox and user_id=v_admin)<>1
     or (select count(*) from public.notification_push_deliveries where outbox_id=v_outbox)<>0
     or (select state from public.notification_outbox where id=v_outbox)<>'completed' then
    raise exception 'per-kind Push preference filtered Inbox or failed to suppress Push';
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  perform public.notification_preferences_set(true,true,true);
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.notification_process_outbox(20);
  if (select count(*) from public.notification_push_deliveries where outbox_id=v_outbox)<>0 then
    raise exception 're-enabling a kind released an old suppressed notification';
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  perform public.web_push_subscription_deactivate(v_client);

  -- A real online-order INSERT creates one order-number alert. Initial InstaPay
  -- verification is copy on that alert, not a duplicate payment event.
  perform pg_temp.become(null,'postgres');
  insert into public.online_orders(
    id,order_number,client_ref,branch_id,customer_name,customer_phone,delivery_type,address,
    subtotal,discount_amount,delivery_fee,total,payment_method,payment_status,status
  ) values(
    v_order,'TEST-0099','test-0099-order',v_main,'Synthetic Customer','01000000099','pickup','{}',
    25,0,0,25,'instapay','verification_required','pending');
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>1
     or (select count(*) from public.notification_outbox where entity_id=v_order::text
          and dedupe_key='online_order:'||v_order::text)<>1
     or not exists(select 1 from public.notification_outbox where entity_id=v_order::text
          and title_en like '%TEST-0099%' and body_en like '%payment verification%') then
    raise exception 'new InstaPay order did not create exactly one order-number alert';
  end if;
  if exists(select 1 from public.notification_outbox where entity_id=v_order::text
             and ((title_en||body_en||title_ar||body_ar) like '%Synthetic Customer%'
               or (title_en||body_en||title_ar||body_ar) like '%01000000099%')) then
    raise exception 'customer PII entered online-order notification copy';
  end if;

  -- Proof submission, a changed reference and failed -> resubmission are
  -- staff-attention transitions. Retrying identical proof adds nothing even
  -- when the official RPC refreshes payment_submitted_at.
  update public.online_orders set payment_reference='synthetic-private-reference',
    payment_submitted_at=now() where id=v_order;
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>2
     or (select count(*) from public.notification_outbox where entity_id=v_order::text
          and dedupe_key like 'online_order_payment:%')<>1 then
    raise exception 'first payment proof transition was not exactly once';
  end if;
  update public.online_orders set payment_submitted_at=now(),payment_reference=payment_reference
   where id=v_order;
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>2 then
    raise exception 'identical payment RPC retry duplicated an alert';
  end if;
  update public.online_orders set payment_reference='synthetic-private-reference-2',
    payment_submitted_at=now() where id=v_order;
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>3
     or (select count(*) from public.notification_outbox where entity_id=v_order::text
          and dedupe_key like 'online_order_payment:%')<>2 then
    raise exception 'changed payment reference did not alert exactly once';
  end if;
  update public.online_orders set payment_status='failed' where id=v_order;
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>3 then
    raise exception 'payment rejection created a staff-attention alert';
  end if;
  update public.online_orders set payment_status='verification_required',payment_submitted_at=now()
   where id=v_order;
  if (select count(*) from public.notification_outbox where entity_id=v_order::text)<>4
     or (select count(*) from public.notification_outbox where entity_id=v_order::text
          and dedupe_key like 'online_order_payment:%')<>3 then
    raise exception 'proof resubmission without status change was lost or duplicated';
  end if;
  if exists(select 1 from public.notification_outbox where entity_id=v_order::text
             and ((title_en||body_en||title_ar||body_ar) like '%synthetic-private-reference%'
               or (title_en||body_en||title_ar||body_ar) like '%synthetic-private-reference-2%')) then
    raise exception 'payment reference entered notification copy';
  end if;

  -- A failed order INSERT is rolled back with its would-be notification fact.
  begin
    insert into public.online_orders(
      id,order_number,client_ref,branch_id,customer_name,customer_phone,delivery_type,address,
      subtotal,discount_amount,delivery_fee,total,payment_method
    ) values(
      v_failed_order,'TEST-0099-FAIL','test-0099-failed',v_main,'Synthetic Failure','01000000098','pickup','{}',
      25,0,0,24,'cod');
    raise exception 'invalid synthetic order unexpectedly succeeded';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.notification_outbox where entity_id=v_failed_order::text) then
    raise exception 'failed order creation left a notification event';
  end if;

  -- Current critical stock expands immediately; a deferred stale fact is
  -- quarantined, and a resolved balance is discarded instead of notified.
  insert into public.categories(id,name_ar,name_en,active)
  values(v_category,'اختبار 0099','0099 Test',true);
  insert into public.products(id,sku,barcode,name_ar,name_en,category_id,selling_price,cost_price,active)
  values(v_product,'PUSH99','PUSH99-BARCODE','اختبار 0099','0099 Test',v_category,10,5,true);
  -- Product creation maintains an empty default shelf; replace only this
  -- synthetic shelf with the exact critical-stock fixture identity.
  delete from public.branch_stock_balances where product_id=v_product and variant_id is null;
  insert into public.branch_stock_balances(id,branch_id,product_id,variant_id,quantity,reorder_level)
  values(v_balance,v_main,v_product,null,1,1);
  select id into v_outbox from public.notification_outbox
   where kind='critical_stock' and entity_id=v_balance::text;
  if v_outbox is null or not exists(select 1 from public.user_notification_inbox where outbox_id=v_outbox) then
    raise exception 'fresh critical stock did not expand immediately';
  end if;
  delete from public.user_notification_inbox where outbox_id=v_outbox;
  update public.notification_outbox set state='pending',created_at=now()-interval '1 hour',
    expanded_at=null,completed_at=null,dead_letter_at=null,last_error_code=null where id=v_outbox;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.notification_process_outbox(20);
  if (select state from public.notification_outbox where id=v_outbox)<>'dead'
     or (select last_error_code from public.notification_outbox where id=v_outbox)<>'stale_stock_quarantined_0099'
     or exists(select 1 from public.user_notification_inbox where outbox_id=v_outbox) then
    raise exception 'stale critical stock was not safely quarantined';
  end if;

  perform pg_temp.become(null,'postgres');
  update public.branch_stock_balances set quantity=10 where id=v_balance;
  alter table public.notification_outbox disable trigger notification_outbox_expand_immediately;
  update public.branch_stock_balances set quantity=1 where id=v_balance;
  select id into v_outbox from public.notification_outbox
   where kind='critical_stock' and entity_id=v_balance::text and state='pending';
  update public.branch_stock_balances set quantity=10 where id=v_balance;
  alter table public.notification_outbox enable trigger notification_outbox_expand_immediately;
  perform pg_temp.become(null,'service_role');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.notification_process_outbox(20);
  if v_outbox is null or (select state from public.notification_outbox where id=v_outbox)<>'dead'
     or (select last_error_code from public.notification_outbox where id=v_outbox)<>'critical_stock_not_current'
     or exists(select 1 from public.user_notification_inbox where outbox_id=v_outbox) then
    raise exception 'resolved critical stock was not discarded';
  end if;

  -- Pending offline operations alone are not failures. Only 0 -> positive
  -- unresolved conflicts alert; a repeated heartbeat and a second real cycle
  -- have exactly the right event counts.
  perform pg_temp.become(null,'postgres');
  insert into public.registers(
    id,code,name,branch_id,installation_id,credential_hash,created_by,pending_offline_count,unresolved_conflict_count
  ) values(v_register,'PUSH99','0099 Test Register',v_main,v_installation,repeat('a',64),v_admin,1,0);
  if exists(select 1 from public.notification_outbox where entity_id=v_register::text) then
    raise exception 'pending offline work was misreported as a sync failure';
  end if;
  update public.registers set pending_offline_count=2 where id=v_register;
  if exists(select 1 from public.notification_outbox where entity_id=v_register::text) then
    raise exception 'pending-only heartbeat created a sync alert';
  end if;
  update public.registers set unresolved_conflict_count=1 where id=v_register;
  update public.registers set unresolved_conflict_count=1 where id=v_register;
  if (select count(*) from public.notification_outbox where entity_id=v_register::text)<>1 then
    raise exception 'genuine conflict did not alert exactly once';
  end if;
  update public.registers set unresolved_conflict_count=0 where id=v_register;
  update public.registers set unresolved_conflict_count=1 where id=v_register;
  if (select count(*) from public.notification_outbox where entity_id=v_register::text)<>2 then
    raise exception 'second genuine conflict transition was collapsed into the first';
  end if;

  perform pg_temp.become(v_admin,'authenticated');
  v_result:=public.system_health_probe();
  if v_result->>'migration'<>'0099_notification_reliability_and_dispatch.sql'
     or (v_result->>'migration_count')::integer<>99 then
    raise exception '0099 health contract mismatch: %',v_result;
  end if;

  perform pg_temp.become(null,'postgres');
  delete from public.notification_outbox where dedupe_key like 'test-0099:%'
     or entity_id in(v_order::text,v_failed_order::text,v_balance::text,v_register::text);
  delete from public.web_push_subscriptions where client_id=v_client;
  delete from public.branch_stock_balances where id=v_balance;
  delete from public.registers where id=v_register;
  delete from public.online_orders where id in(v_order,v_failed_order);
  delete from public.products where id=v_product;
  delete from public.categories where id=v_category;
  delete from public.notification_preferences where profile_id=v_admin;
  raise notice '0099 — immediate Inbox, fallback/retry identity, per-kind Push controls, order/payment transitions, failed-create atomicity, current stock and genuine sync alerts passed';
end
$notification_0099$;

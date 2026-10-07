-- 0091 contract + 0093 repair scenarios — guarded DELETEs, notification cleanup,
-- current-schema Factory Reset, health and terminal rollback.
-- Runs after every earlier scenario and before development seed reapplication.

create or replace function public.test_0091_fail_terminal_reset_audit()
returns trigger
language plpgsql
as $$
begin
  if current_setting('alyq.test_0091_terminal_failure', true) = 'on'
     and new.action = 'system.reset.succeeded'
     and new.entity_id = 'factory' then
    raise exception 'RESET_TEST_TERMINAL_AUDIT_FAILURE'
      using errcode = 'raise_exception';
  end if;
  return new;
end
$$;

drop trigger if exists zz_test_0091_fail_terminal_reset_audit on public.audit_log;
create trigger zz_test_0091_fail_terminal_reset_audit
before insert on public.audit_log
for each row execute function public.test_0091_fail_terminal_reset_audit();

do $phase91$
declare
  v_admin             uuid := '00000000-0000-4000-8000-0000000000a1';
  v_main              uuid := '00000000-0000-4000-8000-0000000000b1';
  v_destination       uuid := '00000000-0000-4000-8000-0000000091b2';
  v_category          uuid := '00000000-0000-4000-8000-0000000091c1';
  v_product           uuid := '00000000-0000-4000-8000-0000000091d1';
  v_variant           uuid := '00000000-0000-4000-8000-0000000091d2';
  v_stocktake         uuid := '00000000-0000-4000-8000-0000000091e1';
  v_stocktake_line    uuid := '00000000-0000-4000-8000-0000000091e2';
  v_sale              jsonb;
  v_return            jsonb;
  v_sale_id           uuid;
  v_sale_item_id      uuid;
  v_return_id         uuid;
  v_shift_id          uuid;
  v_register_id       uuid;
  v_preview           jsonb;
  v_summary           jsonb;
  v_health            jsonb;
  v_before_settings   jsonb;
  v_preview_delete    jsonb;
  v_preview_preserve  jsonb;
  v_count             integer;
  v_stock             integer;
  v_profiles          integer;
  v_custom_roles      integer;
  v_memberships       integer;
  v_approvals         integer;
  v_manager_creds     integer;
  v_manager_attempts  integer;
  v_backups           integer;
  v_import_batches    integer;
  v_stocktakes        integer;
  v_stocktake_lines   integer;
  v_mobile_installs   integer;
  v_audits            integer;
  v_started           integer;
  v_succeeded         integer;
  v_outbox_rows       integer;
  v_inbox_rows        integer;
  v_delivery_rows     integer;
  v_attempt_rows      integer;
  v_key               text;
  v_value             jsonb;
  v_function_source   text;
  v_delete_statement  text;
begin
  perform pg_temp.become(null, 'postgres');

  -- PGlite does not preload Production's pg-safeupdate post-parse hook. Inspect
  -- the installed functions to model the hook's exact relevant condition:
  -- every DELETE must have a qualification, and this repair forbids WHERE TRUE.
  for v_function_source in
    select p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname in('notification_factory_reset_cleanup','system_factory_reset')
  loop
    for v_delete_statement in
      select m[1]
        from regexp_matches(v_function_source,'(delete[[:space:]]+from[^;]*;)','gi') m
    loop
      v_delete_statement := regexp_replace(lower(v_delete_statement),'[[:space:]]+',' ','g');
      if strpos(v_delete_statement,' where ')=0 then
        raise exception '0093 pg-safeupdate contract found DELETE without WHERE: %',v_delete_statement;
      end if;
      if v_delete_statement ~ ' where [( ]*true([ );]|$)' then
        raise exception '0093 pg-safeupdate contract found arbitrary WHERE TRUE: %',v_delete_statement;
      end if;
    end loop;
  end loop;
  select p.prosrc into strict v_function_source
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='notification_factory_reset_cleanup';
  if strpos(v_function_source,'notification_delivery_attempts')=0
     or strpos(v_function_source,'notification_delivery_attempts') >= strpos(v_function_source,'notification_push_deliveries')
     or strpos(v_function_source,'notification_push_deliveries') >= strpos(v_function_source,'user_notification_inbox')
     or strpos(v_function_source,'user_notification_inbox') >= strpos(v_function_source,'notification_outbox') then
    raise exception '0093 notification cleanup is not installed in child-first order';
  end if;

  -- Regression for the production pg-safeupdate path: begin with exactly zero
  -- notification facts, then fire the same reset-start audit trigger used by
  -- system_factory_reset(). The installed cleanup must accept the empty case.
  delete from public.notification_delivery_attempts where id is not null;
  delete from public.notification_push_deliveries where id is not null;
  delete from public.user_notification_inbox where id is not null;
  delete from public.notification_outbox where id is not null;
  insert into public.audit_log(
    action,entity,entity_id,entity_label,details,user_id,user_name,module,branch_id
  ) values(
    'system.reset.started','system','factory','Factory Reset zero-notification proof',
    '{"scenario":"zero-notifications"}'::jsonb,v_admin::text,'Amina Admin','settings',v_main
  );
  if exists(select 1 from public.notification_outbox)
     or exists(select 1 from public.user_notification_inbox)
     or exists(select 1 from public.notification_push_deliveries)
     or exists(select 1 from public.notification_delivery_attempts) then
    raise exception '0093 zero-notification cleanup did not remain empty';
  end if;

  -- Exercise exactly one complete outbox -> inbox -> delivery -> attempt graph.
  -- mobile_installations is intentionally outside the cleanup contract.
  insert into public.mobile_installations(
    id,installation_id,user_id,branch_id,platform,app_version,push_token,
    push_token_hash,push_registered,active,locale
  ) values(
    '00000000-0000-4000-8000-000000009201',
    '00000000-0000-4000-8000-000000009202',v_admin,v_main,'android','9.3.0',
    'phase91-notification-token',repeat('a',64),true,true,'en'
  ) on conflict(installation_id) do update set
    user_id=excluded.user_id,branch_id=excluded.branch_id,push_token=excluded.push_token,
    push_token_hash=excluded.push_token_hash,push_registered=true,active=true;
  insert into public.notification_outbox(
    id,dedupe_key,kind,branch_id,entity_type,entity_id,route_key,route_entity_id,
    required_capabilities,title_en,title_ar,body_en,body_ar,state
  ) values(
    '00000000-0000-4000-8000-000000009291','phase91-single-notification',
    'offline_sync_failure',v_main,'register','single','health','',
    array['run_health_check'],'Single reset fixture','اختبار إعادة الضبط',
    'Single notification cleanup fixture.','اختبار تنظيف إشعار واحد.','expanded'
  );
  insert into public.user_notification_inbox(
    id,outbox_id,user_id,branch_id,kind,entity_type,entity_id,route_key,
    route_entity_id,required_capabilities,title_en,title_ar,body_en,body_ar
  ) values(
    '00000000-0000-4000-8000-000000009292',
    '00000000-0000-4000-8000-000000009291',v_admin,v_main,
    'offline_sync_failure','register','single','health','',array['run_health_check'],
    'Single reset fixture','اختبار إعادة الضبط',
    'Single notification cleanup fixture.','اختبار تنظيف إشعار واحد.'
  );
  insert into public.notification_push_deliveries(
    id,outbox_id,inbox_id,installation_id,user_id,token_hash,provider,status,
    attempt_count,max_attempts
  ) values(
    '00000000-0000-4000-8000-000000009293',
    '00000000-0000-4000-8000-000000009291',
    '00000000-0000-4000-8000-000000009292',
    '00000000-0000-4000-8000-000000009201',v_admin,repeat('a',64),
    'fcm','delivered',1,5
  );
  insert into public.notification_delivery_attempts(
    id,delivery_id,attempt_number,outcome,http_status
  ) values(
    '00000000-0000-4000-8000-000000009294',
    '00000000-0000-4000-8000-000000009293',1,'delivered',200
  );
  insert into public.audit_log(
    action,entity,entity_id,entity_label,details,user_id,user_name,module,branch_id
  ) values(
    'system.reset.started','system','factory','Factory Reset one-notification proof',
    '{"scenario":"one-notification"}'::jsonb,v_admin::text,'Amina Admin','settings',v_main
  );
  if exists(select 1 from public.notification_outbox)
     or exists(select 1 from public.user_notification_inbox)
     or exists(select 1 from public.notification_push_deliveries)
     or exists(select 1 from public.notification_delivery_attempts) then
    raise exception '0093 one-notification cleanup left notification facts';
  end if;
  if not exists(select 1 from public.mobile_installations
                where id='00000000-0000-4000-8000-000000009201') then
    raise exception '0093 notification cleanup deleted a mobile installation';
  end if;

  -- Security/branch/register state is retained by contract. Add one second
  -- branch so a real current-schema transfer can exist.
  insert into public.branches(id,code,name_en,name_ar,active,is_default)
  values(v_destination,'phase91','0091 destination','فرع 0091',true,false)
  on conflict(id) do update set active=true;
  insert into public.branch_memberships(user_id,branch_id,role,active)
  values(v_admin,v_destination,'admin',true)
  on conflict(user_id,branch_id) do update set role='admin',active=true;

  insert into public.categories(id,name_ar,name_en)
  values(v_category,'فئة 0091','0091 category')
  on conflict(id) do nothing;
  insert into public.products(
    id,sku,name_ar,name_en,category_id,selling_price,cost_price,stock_quantity,
    active,show_on_website,stock_tracking_enabled,variants_enabled
  ) values(
    v_product,'P91-PRODUCT','منتج 0091','0091 product',v_category,25,10,6,
    true,true,true,true
  ) on conflict(id) do nothing;
  insert into public.product_variants(
    id,product_id,sku,color_ar,color_en,size,stock_quantity,active
  ) values
    (v_variant,v_product,'P91-VARIANT','ذهبي','Gold',18,6,true),
    ('00000000-0000-4000-8000-0000000091d3',v_product,'P91-VARIANT-2','فضي','Silver',20,0,true),
    ('00000000-0000-4000-8000-0000000091d4',v_product,'P91-VARIANT-3','أسود','Black',22,0,true)
  on conflict(id) do nothing;

  -- Accepted offline replay has no separate queue table: its durable record is
  -- an ordinary idempotent sale carrying the offline client reference.
  perform pg_temp.become(v_admin, 'authenticated');
  perform pg_temp.ensure_open_shift(v_admin::text);
  select id into v_shift_id from public.shifts
   where branch_id=v_main and status='open' order by opening_at desc limit 1;
  perform pg_temp.become(null, 'postgres');
  select id into v_register_id from public.registers
   where branch_id=v_main order by created_at limit 1;
  perform pg_temp.become(v_admin, 'authenticated');
  v_sale := public.pos_complete_sale(jsonb_build_object(
    'client_ref','offline-phase91-accepted',
    'user_id',v_admin::text,
    'user_name','Amina Admin',
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',25)),
    'lines',jsonb_build_array(jsonb_build_object(
      'product_id',v_product::text,'variant_id',v_variant::text,'qty',1
    ))
  ));
  v_sale_id := (v_sale->>'sale_id')::uuid;
  select id into v_sale_item_id from public.sale_items where sale_id=v_sale_id;

  v_return := public.pos_process_return(jsonb_build_object(
    'client_ref','phase91-linked-return',
    'sale_id',v_sale_id::text,
    'reason','0091 linked return proof',
    'refund_method','cash',
    'refund_status','pending',
    'user_id',v_admin::text,
    'user_name','Amina Admin',
    'items',jsonb_build_array(jsonb_build_object('sale_item_id',v_sale_item_id::text,'quantity',1))
  ));
  v_return_id := (v_return->>'return_id')::uuid;

  perform public.record_cash_movement('cash_in',5,'0091 reset dependency',null,null);

  -- Create transfer + two branch-exact movement rows through the authoritative
  -- current-schema path, rather than manufacturing foreign-key fixtures.
  perform public.inventory_transfer_stock(
    'phase91-transfer',v_destination,v_product,v_variant,1,'0091 reset dependency'
  );

  perform pg_temp.become(null, 'postgres');
  insert into public.stocktakes(
    id,reference,status,blind,note,created_by,created_by_name,
    finalized_at,finalized_by,finalized_by_name
  ) values(
    v_stocktake,'ST-0091-PRESERVE','finalized',false,'0091 immutable snapshot',
    v_admin::text,'Amina Admin',now(),v_admin::text,'Amina Admin'
  );
  select quantity into v_stock from public.branch_stock_balances
   where branch_id=v_main and product_id=v_product and variant_id=v_variant;
  insert into public.stocktake_lines(
    id,stocktake_id,product_id,variant_id,shelf_key,sku,product_name_ar,
    product_name_en,variant_label,expected_quantity,physical_quantity,variance,
    movement_reference
  ) values(
    v_stocktake_line,v_stocktake,v_product,v_variant,v_variant::text,'P91-VARIANT',
    'منتج 0091','0091 product','Gold / 18',v_stock,v_stock,0,'P91-SNAPSHOT'
  );
  insert into public.stocktakes(
    id,reference,status,blind,note,created_by,created_by_name,
    finalized_at,finalized_by,finalized_by_name
  ) values
    ('00000000-0000-4000-8000-0000000091e3','ST-0091-PRESERVE-2','finalized',false,
     '0091 second immutable snapshot',v_admin::text,'Amina Admin',now(),v_admin::text,'Amina Admin'),
    ('00000000-0000-4000-8000-0000000091e4','ST-0091-PRESERVE-3','finalized',false,
     '0091 third immutable snapshot',v_admin::text,'Amina Admin',now(),v_admin::text,'Amina Admin');
  insert into public.stocktake_lines(
    id,stocktake_id,product_id,variant_id,shelf_key,sku,product_name_ar,
    product_name_en,variant_label,expected_quantity,physical_quantity,variance,
    movement_reference
  ) values
    ('00000000-0000-4000-8000-0000000091e5','00000000-0000-4000-8000-0000000091e3',
     v_product,v_variant,v_variant::text,'P91-VARIANT','منتج 0091','0091 product',
     'Gold / 18',v_stock,v_stock,0,'P91-SNAPSHOT-2'),
    ('00000000-0000-4000-8000-0000000091e6','00000000-0000-4000-8000-0000000091e4',
     v_product,v_variant,v_variant::text,'P91-VARIANT','منتج 0091','0091 product',
     'Gold / 18',v_stock,v_stock,0,'P91-SNAPSHOT-3');

  insert into public.import_batches(
    batch_id,kind,mode,status,filename,total_rows,written_count,branch_id,user_id,user_name,summary
  ) values
    ('phase91-preserved-import','catalogue','all-or-nothing','completed','phase91.xlsx',
     1,1,v_main::text,v_admin,'Amina Admin','{"proof":"0091"}'::jsonb),
    ('phase91-preserved-import-2','catalogue','all-or-nothing','completed','phase91-2.xlsx',
     2,2,v_main::text,v_admin,'Amina Admin','{"proof":"0091-2"}'::jsonb),
    ('phase91-preserved-import-3','catalogue','all-or-nothing','completed','phase91-3.xlsx',
     3,3,v_main::text,v_admin,'Amina Admin','{"proof":"0091-3"}'::jsonb)
  on conflict(batch_id) do update set status='completed',summary=excluded.summary;

  -- Preserve an explicit audit trace for the accepted offline operation. It is
  -- history, not an operational queue row, and must survive the sale deletion.
  perform pg_temp.become(v_admin, 'authenticated');
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,module,branch_id)
  values(
    'register.created','register',coalesce(v_register_id::text,'web-register'),
    'Accepted offline replay',jsonb_build_object('client_ref','offline-phase91-accepted'),
    v_admin::text,'Amina Admin','offline_sync',v_main
  );

  perform pg_temp.become(null, 'postgres');

  -- Production-shaped notification state: several outbox facts, inbox rows,
  -- per-installation deliveries and multiple immutable attempts. The reset's
  -- started-audit trigger must clear all of them set-wise, and rollback must
  -- restore every row when the terminal success audit is forced to fail.
  insert into public.mobile_installations(
    id,installation_id,user_id,branch_id,platform,app_version,push_token,
    push_token_hash,push_registered,active,locale
  ) values(
    '00000000-0000-4000-8000-000000009201',
    '00000000-0000-4000-8000-000000009202',v_admin,v_main,'android','9.2.0',
    'phase91-notification-token',repeat('a',64),true,true,'en'
  ) on conflict(installation_id) do update set
    user_id=excluded.user_id,branch_id=excluded.branch_id,push_token=excluded.push_token,
    push_token_hash=excluded.push_token_hash,push_registered=true,active=true;

  insert into public.notification_outbox(
    id,dedupe_key,kind,branch_id,entity_type,entity_id,route_key,route_entity_id,
    required_capabilities,title_en,title_ar,body_en,body_ar,state
  )
  select ('00000000-0000-4000-8000-00000000921'||n)::uuid,
    'phase91-reset-notification-'||n,'offline_sync_failure',v_main,'register',
    v_register_id::text,'health','',array['run_health_check'],
    'Reset fixture '||n,'اختبار إعادة الضبط '||n,
    'Production-shaped notification fixture.','اختبار إشعار متعدد الصفوف.','expanded'
  from generate_series(1,3) n;

  insert into public.user_notification_inbox(
    id,outbox_id,user_id,branch_id,kind,entity_type,entity_id,route_key,
    route_entity_id,required_capabilities,title_en,title_ar,body_en,body_ar
  )
  select ('00000000-0000-4000-8000-00000000922'||row_number() over(order by o.id))::uuid,
    o.id,v_admin,v_main,o.kind,o.entity_type,o.entity_id,o.route_key,o.route_entity_id,
    o.required_capabilities,o.title_en,o.title_ar,o.body_en,o.body_ar
  from public.notification_outbox o
  where o.dedupe_key like 'phase91-reset-notification-%';

  insert into public.notification_push_deliveries(
    id,outbox_id,inbox_id,installation_id,user_id,token_hash,provider,status,
    attempt_count,max_attempts
  )
  select ('00000000-0000-4000-8000-00000000923'||row_number() over(order by i.id))::uuid,
    i.outbox_id,i.id,'00000000-0000-4000-8000-000000009201',v_admin,repeat('a',64),
    'fcm','delivered',2,5
  from public.user_notification_inbox i
  where i.outbox_id in(
    select id from public.notification_outbox where dedupe_key like 'phase91-reset-notification-%'
  );

  insert into public.notification_delivery_attempts(
    id,delivery_id,attempt_number,outcome,http_status,error_code
  )
  select gen_random_uuid(),d.id,n,
    case when n=1 then 'retry' else 'delivered' end,
    case when n=1 then 503 else 200 end,
    case when n=1 then 'unavailable' else null end
  from public.notification_push_deliveries d
  cross join generate_series(1,2) n
  where d.outbox_id in(
    select id from public.notification_outbox where dedupe_key like 'phase91-reset-notification-%'
  );

  select count(*)::integer into v_outbox_rows from public.notification_outbox;
  select count(*)::integer into v_inbox_rows from public.user_notification_inbox;
  select count(*)::integer into v_delivery_rows from public.notification_push_deliveries;
  select count(*)::integer into v_attempt_rows from public.notification_delivery_attempts;
  if v_outbox_rows < 3 or v_inbox_rows < 3 or v_delivery_rows < 3 or v_attempt_rows < 6 then
    raise exception 'notification reset fixture did not create production-shaped multi-row state';
  end if;

  update public.website_settings
     set settings=jsonb_build_object(
       'phase91_marker','must-roll-back',
       'brand',jsonb_build_object('display_name_en','0091 retained brand'),
       'delivery',jsonb_build_object('fee',91),
       'checkout_copy',jsonb_build_object('free_delivery_progress_en','0091 {{amount}}')
     ), updated_at=now()
   where id=1;
  select settings into v_before_settings from public.website_settings where id=1;
  update public.sale_counters set next_value=911 where id=1;
  update public.return_counters set next_value=912 where id=1;
  update public.refund_counters set next_value=913 where id=1;

  select count(*)::integer into v_profiles from public.profiles;
  select count(*)::integer into v_custom_roles from public.custom_roles;
  select count(*)::integer into v_memberships from public.branch_memberships;
  select count(*)::integer into v_approvals from public.approval_requests;
  select count(*)::integer into v_manager_creds from public.manager_credentials;
  select count(*)::integer into v_manager_attempts from public.manager_pin_attempts;
  select count(*)::integer into v_backups from public.backups;
  select count(*)::integer into v_import_batches from public.import_batches;
  select count(*)::integer into v_stocktakes from public.stocktakes;
  select count(*)::integer into v_stocktake_lines from public.stocktake_lines;
  select count(*)::integer into v_mobile_installs from public.mobile_installations;
  select count(*)::integer into v_audits from public.audit_log;
  select count(*)::integer into v_started from public.audit_log
   where action='system.reset.started' and entity_id='factory';
  select count(*)::integer into v_succeeded from public.audit_log
   where action='system.reset.succeeded' and entity_id='factory';

  perform pg_temp.become(v_admin, 'authenticated');
  v_health := public.system_health_probe();
  if v_health->>'migration' <> '0095_web_push_digest_repair.sql'
     or (v_health->>'migration_count')::integer <> 95
     or (v_health->>'authenticated')::boolean is not true
     or (v_health->>'branch_context_valid')::boolean is not true then
    raise exception '0091 health contract mismatch: %',v_health;
  end if;

  -- Categories imply products; website implies delivery/payment reset. Preview
  -- exposes both effective choices and the exact count groups returned later.
  v_preview := public.system_reset_preview('factory',jsonb_build_object(
    'products',false,'categories',true,'customers',true,
    'website',true,'branding',false,'delivery_payment',false
  ));
  if (v_preview->'effective_options'->>'products')::boolean is not true
     or (v_preview->'effective_options'->>'delivery_payment')::boolean is not true then
    raise exception 'factory preview lost implied effective options: %',v_preview->'effective_options';
  end if;
  select coalesce(jsonb_object_agg(item->>'group',(item->>'count')::integer),'{}'::jsonb)
    into v_preview_delete from jsonb_array_elements(v_preview->'delete') item;
  select coalesce(jsonb_object_agg(item->>'group',(item->>'count')::integer),'{}'::jsonb)
    into v_preview_preserve from jsonb_array_elements(v_preview->'preserve') item;
  if coalesce((v_preview_delete->>'returns')::integer,0) < 2
     or coalesce((v_preview_delete->>'stock_transfers')::integer,0) < 1
     or coalesce((v_preview_delete->>'movements')::integer,0) < 2
     or coalesce((v_preview_preserve->>'stocktake_lines')::integer,0) < 1
     or coalesce((v_preview_preserve->>'import_batches')::integer,0) < 1 then
    raise exception '0091 preview did not cover current dependencies/preservation: %',v_preview;
  end if;

  -- Terminal failure proof: reject the FINAL succeeded-audit insert, after all
  -- deletes/settings/counters. PostgreSQL must restore every touched class and
  -- both reset-audit rows because the RPC is one atomic statement/transaction.
  perform set_config('alyq.test_0091_terminal_failure','on',true);
  begin
    perform public.system_factory_reset(
      jsonb_build_object(
        'products',false,'categories',true,'customers',true,
        'website',true,'branding',false,'delivery_payment',false
      ),
      'DELETE ALL DATA',now()+interval '1 minute','alyq1234'
    );
    raise exception '0091 terminal audit failure did not fire';
  exception when others then
    if sqlerrm not like 'RESET_TEST_TERMINAL_AUDIT_FAILURE%' then
      raise exception '0091 terminal rollback surfaced the wrong error: %',sqlerrm;
    end if;
  end;
  perform set_config('alyq.test_0091_terminal_failure','off',true);
  perform pg_temp.become(null, 'postgres');

  if not exists(select 1 from public.sales where id=v_sale_id)
     or not exists(select 1 from public.sales_returns where id=v_return_id)
     or not exists(select 1 from public.products where id=v_product)
     or not exists(select 1 from public.product_variants where id=v_variant) then
    raise exception 'terminal rollback lost sale/return/product/variant fixtures';
  end if;
  if (select quantity from public.branch_stock_balances
       where branch_id=v_main and product_id=v_product and variant_id=v_variant) is distinct from v_stock then
    raise exception 'terminal rollback changed authoritative stock';
  end if;
  if (select settings from public.website_settings where id=1) is distinct from v_before_settings then
    raise exception 'terminal rollback changed website settings';
  end if;
  if (select next_value from public.sale_counters where id=1) <> 911
     or (select next_value from public.return_counters where id=1) <> 912
     or (select next_value from public.refund_counters where id=1) <> 913 then
    raise exception 'terminal rollback changed numbering counters';
  end if;
  if (select count(*) from public.audit_log) <> v_audits
     or (select count(*) from public.audit_log where action='system.reset.started' and entity_id='factory') <> v_started
     or (select count(*) from public.audit_log where action='system.reset.succeeded' and entity_id='factory') <> v_succeeded then
    raise exception 'terminal rollback changed reset/audit evidence';
  end if;
  if (select count(*) from public.notification_outbox) <> v_outbox_rows
     or (select count(*) from public.user_notification_inbox) <> v_inbox_rows
     or (select count(*) from public.notification_push_deliveries) <> v_delivery_rows
     or (select count(*) from public.notification_delivery_attempts) <> v_attempt_rows then
    raise exception 'terminal rollback changed notification outbox/inbox/delivery evidence';
  end if;
  if (select count(*) from public.profiles) <> v_profiles
     or (select count(*) from public.custom_roles) <> v_custom_roles
     or (select count(*) from public.branch_memberships) <> v_memberships
     or (select count(*) from public.approval_requests) <> v_approvals
     or (select count(*) from public.manager_credentials) <> v_manager_creds
     or (select count(*) from public.manager_pin_attempts) <> v_manager_attempts
     or (select count(*) from public.backups) <> v_backups
     or (select count(*) from public.import_batches) <> v_import_batches
     or (select count(*) from public.stocktakes) <> v_stocktakes
     or (select count(*) from public.stocktake_lines) <> v_stocktake_lines
     or (select count(*) from public.mobile_installations) <> v_mobile_installs then
    raise exception 'terminal rollback changed protected admin/security/history state';
  end if;
  if (select product_id from public.stocktake_lines where id=v_stocktake_line) is distinct from v_product
     or (select variant_id from public.stocktake_lines where id=v_stocktake_line) is distinct from v_variant then
    raise exception 'terminal rollback detached the stocktake snapshot';
  end if;

  -- Successful run over exactly the previewed state.
  perform pg_temp.become(v_admin, 'authenticated');
  v_summary := public.system_factory_reset(
    jsonb_build_object(
      'products',false,'categories',true,'customers',true,
      'website',true,'branding',false,'delivery_payment',false
    ),
    'DELETE ALL DATA',now()+interval '1 minute','alyq1234'
  );
  perform pg_temp.become(null, 'postgres');

  for v_key,v_value in select key,value from jsonb_each(v_summary->'deleted') loop
    if not (v_preview_delete ? v_key)
       or (v_preview_delete->>v_key)::integer <> (v_value#>>'{}')::integer then
      raise exception 'preview/result delete count mismatch for %: preview %, result %',
        v_key,v_preview_delete->v_key,v_value;
    end if;
  end loop;
  for v_key,v_value in select key,value from jsonb_each(v_summary->'preserved') loop
    if jsonb_typeof(v_value)='number' and (v_preview_preserve ? v_key)
       and (v_preview_preserve->>v_key)::integer <> (v_value#>>'{}')::integer then
      raise exception 'preview/result preserve count mismatch for %: preview %, result %',
        v_key,v_preview_preserve->v_key,v_value;
    end if;
  end loop;

  if exists(select 1 from public.sales)
     or exists(select 1 from public.sales_returns)
     or exists(select 1 from public.refund_records)
     or exists(select 1 from public.cash_movements)
     or exists(select 1 from public.shifts)
     or exists(select 1 from public.stock_transfers)
     or exists(select 1 from public.stock_movements)
     or exists(select 1 from public.product_variants)
     or exists(select 1 from public.products)
     or exists(select 1 from public.categories)
     or exists(select 1 from public.notification_outbox)
     or exists(select 1 from public.user_notification_inbox)
     or exists(select 1 from public.notification_push_deliveries)
     or exists(select 1 from public.notification_delivery_attempts) then
    raise exception 'successful 0091 factory reset left operational/catalogue/notification rows';
  end if;
  if not exists(select 1 from public.stocktakes where id=v_stocktake)
     or not exists(select 1 from public.stocktake_lines where id=v_stocktake_line)
     or (select product_id from public.stocktake_lines where id=v_stocktake_line) is not null
     or (select variant_id from public.stocktake_lines where id=v_stocktake_line) is not null
     or (select sku from public.stocktake_lines where id=v_stocktake_line) <> 'P91-VARIANT' then
    raise exception 'successful reset did not preserve/detach the immutable stocktake snapshot';
  end if;
  if not exists(select 1 from public.import_batches where batch_id='phase91-preserved-import') then
    raise exception 'successful reset deleted import history';
  end if;
  if not exists(select 1 from public.audit_log
                where module='offline_sync' and details->>'client_ref'='offline-phase91-accepted') then
    raise exception 'successful reset deleted accepted-offline audit evidence';
  end if;
  if (select count(*) from public.profiles) <> v_profiles
     or (select count(*) from public.custom_roles) <> v_custom_roles
     or (select count(*) from public.branch_memberships) <> v_memberships
     or (select count(*) from public.approval_requests) <> v_approvals
     or (select count(*) from public.manager_credentials) <> v_manager_creds
     or (select count(*) from public.manager_pin_attempts) <> v_manager_attempts
     or (select count(*) from public.backups) <> v_backups
     or (select count(*) from public.import_batches) <> v_import_batches
     or (select count(*) from public.stocktakes) <> v_stocktakes
     or (select count(*) from public.stocktake_lines) <> v_stocktake_lines
     or (select count(*) from public.mobile_installations) <> v_mobile_installs
     or not exists(select 1 from public.mobile_installations
                   where id='00000000-0000-4000-8000-000000009201')
     or not exists(select 1 from public.branches where id=v_destination)
     or (v_register_id is not null and not exists(select 1 from public.registers where id=v_register_id)) then
    raise exception 'successful reset changed protected admin/security/history state';
  end if;
  if (select next_value from public.sale_counters where id=1) <> 1
     or (select next_value from public.return_counters where id=1) <> 1
     or (select next_value from public.refund_counters where id=1) <> 1 then
    raise exception 'successful reset did not restart operational counters';
  end if;
  if (select count(*) from public.audit_log) < v_audits+2
     or (select count(*) from public.audit_log where action='system.reset.started' and entity_id='factory') <> v_started+1
     or (select count(*) from public.audit_log where action='system.reset.succeeded' and entity_id='factory') <> v_succeeded+1 then
    raise exception 'successful reset did not append exactly one start and one success record';
  end if;

  raise notice '0091 reset contract repaired by 0093 — health reports 95; guarded zero/one/many notification cleanup passes; effective preview counts match the result; linked returns, cash/shift, transfer/movement and catalogue rows delete child-first; protected admin/security/history survives; and a forced FINAL success-audit failure restores notifications, business rows, settings, counters and reset audits';
end
$phase91$;

drop trigger if exists zz_test_0091_fail_terminal_reset_audit on public.audit_log;
drop function if exists public.test_0091_fail_terminal_reset_audit();

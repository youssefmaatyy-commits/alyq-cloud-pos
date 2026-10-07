-- 0091 focused scenarios — current-schema Factory Reset, health and terminal rollback.
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
  v_audits            integer;
  v_started           integer;
  v_succeeded         integer;
  v_key               text;
  v_value             jsonb;
begin
  perform pg_temp.become(null, 'postgres');

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
  ) values(v_variant,v_product,'P91-VARIANT','ذهبي','Gold',18,6,true)
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

  insert into public.import_batches(
    batch_id,kind,mode,status,filename,total_rows,written_count,branch_id,user_id,user_name,summary
  ) values(
    'phase91-preserved-import','catalogue','all-or-nothing','completed','phase91.xlsx',
    1,1,v_main::text,v_admin,'Amina Admin','{"proof":"0091"}'::jsonb
  ) on conflict(batch_id) do update set status='completed',summary=excluded.summary;

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
  select count(*)::integer into v_audits from public.audit_log;
  select count(*)::integer into v_started from public.audit_log
   where action='system.reset.started' and entity_id='factory';
  select count(*)::integer into v_succeeded from public.audit_log
   where action='system.reset.succeeded' and entity_id='factory';

  perform pg_temp.become(v_admin, 'authenticated');
  v_health := public.system_health_probe();
  if v_health->>'migration' <> '0092_mobile_push_and_notification_center.sql'
     or (v_health->>'migration_count')::integer <> 92
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
     or exists(select 1 from public.categories) then
    raise exception 'successful 0091 factory reset left operational/catalogue rows';
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
     or not exists(select 1 from public.branches where id=v_destination)
     or (v_register_id is not null and not exists(select 1 from public.registers where id=v_register_id)) then
    raise exception 'successful reset changed profiles/branches/register security state';
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

  raise notice '0091 reset contract under latest schema — health reports 92; effective preview counts match the result; linked returns, cash/shift, transfer/movement and catalogue rows delete child-first; stocktakes/imports/offline audit/security survive; and a forced FINAL success-audit failure rolls back sales, returns, products, variants, branch stock, settings, counters and reset audits';
end
$phase91$;

drop trigger if exists zz_test_0091_fail_terminal_reset_audit on public.audit_log;
drop function if exists public.test_0091_fail_terminal_reset_audit();

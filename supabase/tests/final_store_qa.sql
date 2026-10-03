-- Final Store Simulation QA — deterministic, local-only fashion-store integration.
-- Runs after Prompt 1–6 scenarios in the disposable PGlite database.

do $final_store_qa$
declare
  v_owner uuid := '00000000-0000-4000-8000-00000000aa11';
  v_manager_main uuid := '00000000-0000-4000-8000-00000000aa12';
  v_cashier_main uuid := '00000000-0000-4000-8000-00000000aa13';
  v_manager_b uuid := '00000000-0000-4000-8000-00000000aa14';
  v_cashier_b uuid := '00000000-0000-4000-8000-00000000aa15';
  v_restricted uuid := '00000000-0000-4000-8000-00000000aa16';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_branch_b uuid := '00000000-0000-4000-8000-00000000aab2';
  v_category uuid := '00000000-0000-4000-8000-00000000aac1';
  v_tshirt uuid := '00000000-0000-4000-8000-00000000a101';
  v_shoes uuid := '00000000-0000-4000-8000-00000000a102';
  v_cap uuid := '00000000-0000-4000-8000-00000000a103';
  v_pants uuid := '00000000-0000-4000-8000-00000000a104';
  v_color_only uuid := '00000000-0000-4000-8000-00000000a105';
  v_archived uuid := '00000000-0000-4000-8000-00000000a106';
  v_black_42 uuid := '00000000-0000-4000-8000-00000000b142';
  v_disabled uuid := '00000000-0000-4000-8000-00000000b018';
  v_result jsonb;
  v_sale_id uuid;
  v_sale_item uuid;
  v_return jsonb;
  v_register_main_1 uuid;
  v_register_main_2 uuid;
  v_register_b_1 uuid;
  v_install_main_1 uuid := '00000000-0000-4000-8000-00000000aa31';
  v_install_main_2 uuid := '00000000-0000-4000-8000-00000000aa32';
  v_install_b_1 uuid := '00000000-0000-4000-8000-00000000aa33';
  v_credential text;
  v_before_main integer;
  v_before_b integer;
begin
  -- Fixture setup is owner-only; every authority assertion below impersonates
  -- the relevant authenticated identity.
  perform pg_temp.become(null,'postgres');
  insert into auth.users(id,email) values
    (v_owner,'qa-owner@alyq.invalid'),
    (v_manager_main,'qa-manager-main@alyq.invalid'),
    (v_cashier_main,'qa-cashier-main@alyq.invalid'),
    (v_manager_b,'qa-manager-b@alyq.invalid'),
    (v_cashier_b,'qa-cashier-b@alyq.invalid'),
    (v_restricted,'qa-restricted@alyq.invalid')
  on conflict(id) do nothing;
  insert into public.profiles(id,username,name,role,active) values
    (v_owner,'qa_owner','Owner','admin',true),
    (v_manager_main,'qa_manager_main','Manager Main','manager',true),
    (v_cashier_main,'qa_cashier_main','Cashier Main','cashier',true),
    (v_manager_b,'qa_manager_b','Manager B','manager',true),
    (v_cashier_b,'qa_cashier_b','Cashier B','cashier',true),
    (v_restricted,'qa_restricted','Restricted Employee','viewer',true)
  on conflict(id) do update set username=excluded.username,name=excluded.name,role=excluded.role,active=true;
  insert into public.branches(id,code,name_en,name_ar,active,is_default) values
    (v_branch_b,'qa-branch-b','Branch B','الفرع ب',true,false)
  on conflict(id) do update set name_en=excluded.name_en,name_ar=excluded.name_ar,active=true;
  insert into public.branch_memberships(user_id,branch_id,role,active) values
    (v_owner,v_main,'admin',true),(v_owner,v_branch_b,'admin',true),
    (v_manager_main,v_main,'manager',true),(v_cashier_main,v_main,'cashier',true),
    (v_manager_b,v_branch_b,'manager',true),(v_cashier_b,v_branch_b,'cashier',true),
    (v_restricted,v_main,'viewer',true)
  on conflict(user_id,branch_id) do update set role=excluded.role,active=true;

  perform pg_temp.become(v_owner,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.categories(id,name_ar,name_en) values(v_category,'أزياء اختبار الجودة','Final QA Fashion');
  insert into public.products(id,sku,name_ar,name_en,category_id,selling_price,cost_price,stock_quantity,low_stock_level,active,show_on_website,stock_tracking_enabled) values
    (v_tshirt,'ALYQ-QA-01','تي شيرت أليق','ALYQ T-Shirt',v_category,350,180,7,2,true,true,true),
    (v_shoes,'ALYQ-QA-02','حذاء أليق','ALYQ Shoes',v_category,750,430,11,2,true,true,true),
    (v_cap,'ALYQ-QA-03','كاب أليق','ALYQ Cap',v_category,220,90,2,1,true,true,true),
    (v_pants,'ALYQ-QA-04','بنطال أليق','ALYQ Pants',v_category,500,250,3,1,true,true,true),
    (v_color_only,'ALYQ-QA-05','منتج ألوان','ALYQ Color Only',v_category,150,70,2,1,true,true,true),
    (v_archived,'ALYQ-QA-ARCHIVE','منتج مؤرشف','Archived QA Product',v_category,100,40,0,0,false,false,true);

  -- ALYQ-01: Black/White × S/M/L/XL.
  insert into public.product_variants(id,product_id,sku,barcode,color_key,color_en,color_ar,color_hex,size_value,size_sort_order,stock_quantity,low_stock_level,active,sort_order) values
    ('00000000-0000-4000-8000-00000000b011',v_tshirt,'ALYQ-01-BLK-S','629QA01011','black','Black','أسود','#000000','S',0,0,2,true,0),
    ('00000000-0000-4000-8000-00000000b012',v_tshirt,'ALYQ-01-BLK-M','629QA01012','black','Black','أسود','#000000','M',1,0,2,true,1),
    ('00000000-0000-4000-8000-00000000b013',v_tshirt,'ALYQ-01-BLK-L','629QA01013','black','Black','أسود','#000000','L',2,0,2,true,2),
    ('00000000-0000-4000-8000-00000000b014',v_tshirt,'ALYQ-01-BLK-XL','629QA01014','black','Black','أسود','#000000','XL',3,0,2,true,3),
    ('00000000-0000-4000-8000-00000000b015',v_tshirt,'ALYQ-01-WHT-S','629QA01015','white','White','أبيض','#ffffff','S',0,0,2,true,4),
    ('00000000-0000-4000-8000-00000000b016',v_tshirt,'ALYQ-01-WHT-M','629QA01016','white','White','أبيض','#ffffff','M',1,0,2,true,5),
    ('00000000-0000-4000-8000-00000000b017',v_tshirt,'ALYQ-01-WHT-L','629QA01017','white','White','أبيض','#ffffff','L',2,0,2,true,6),
    (v_disabled,v_tshirt,'ALYQ-01-WHT-XL','629QA01018','white','White','أبيض','#ffffff','XL',3,0,2,true,7);
  perform public.enable_product_variants(v_tshirt,
    (select jsonb_object_agg(id::text,case when id=v_disabled then 0 else 1 end) from public.product_variants where product_id=v_tshirt),v_owner::text,'Owner');
  perform public.set_variant_active(v_disabled,false);

  -- ALYQ-02: Black/White × 40/41/42/43; Black 42 starts 11 then transfers 3.
  insert into public.product_variants(id,product_id,sku,barcode,color_key,color_en,color_ar,color_hex,size_value,size_sort_order,stock_quantity,low_stock_level,active,sort_order) values
    ('00000000-0000-4000-8000-00000000b140',v_shoes,'ALYQ-02-BLK-40','629QA02140','black','Black','أسود','#000000','40',0,0,2,true,0),
    ('00000000-0000-4000-8000-00000000b141',v_shoes,'ALYQ-02-BLK-41','629QA02141','black','Black','أسود','#000000','41',1,0,2,true,1),
    (v_black_42,v_shoes,'ALYQ-02-BLK-42','629QA02142','black','Black','أسود','#000000','42',2,0,2,true,2),
    ('00000000-0000-4000-8000-00000000b143',v_shoes,'ALYQ-02-BLK-43','629QA02143','black','Black','أسود','#000000','43',3,0,2,true,3),
    ('00000000-0000-4000-8000-00000000b240',v_shoes,'ALYQ-02-WHT-40','629QA02240','white','White','أبيض','#ffffff','40',0,0,2,true,4),
    ('00000000-0000-4000-8000-00000000b241',v_shoes,'ALYQ-02-WHT-41','629QA02241','white','White','أبيض','#ffffff','41',1,0,2,true,5),
    ('00000000-0000-4000-8000-00000000b242',v_shoes,'ALYQ-02-WHT-42','629QA02242','white','White','أبيض','#ffffff','42',2,0,2,true,6),
    ('00000000-0000-4000-8000-00000000b243',v_shoes,'ALYQ-02-WHT-43','629QA02243','white','White','أبيض','#ffffff','43',3,0,2,true,7);
  perform public.enable_product_variants(v_shoes,
    (select jsonb_object_agg(id::text,case when id=v_black_42 then 11 else 0 end) from public.product_variants where product_id=v_shoes),v_owner::text,'Owner');

  -- One Size, size-only, and colour-only models.
  insert into public.product_variants(id,product_id,sku,barcode,color_key,color_en,color_ar,color_hex,size_value,size_sort_order,stock_quantity,low_stock_level,active,sort_order) values
    ('00000000-0000-4000-8000-00000000b301',v_cap,'ALYQ-03-BLK-OS','629QA03001','black','Black','أسود','#000000','One Size',0,0,1,true,0),
    ('00000000-0000-4000-8000-00000000b302',v_cap,'ALYQ-03-BGE-OS','629QA03002','beige','Beige','بيج','#d6c2a1','One Size',0,0,1,true,1);
  perform public.enable_product_variants(v_cap,
    (select jsonb_object_agg(id::text,case when sku='ALYQ-03-BLK-OS' then 1 else 1 end) from public.product_variants where product_id=v_cap),v_owner::text,'Owner');
  insert into public.product_variants(id,product_id,sku,barcode,color_key,size_value,size_sort_order,stock_quantity,low_stock_level,active,sort_order) values
    ('00000000-0000-4000-8000-00000000b430',v_pants,'ALYQ-04-30','629QA04030','', '30',0,0,1,true,0),
    ('00000000-0000-4000-8000-00000000b432',v_pants,'ALYQ-04-32','629QA04032','', '32',1,0,1,true,1),
    ('00000000-0000-4000-8000-00000000b434',v_pants,'ALYQ-04-34','629QA04034','', '34',2,0,1,true,2);
  perform public.enable_product_variants(v_pants,
    (select jsonb_object_agg(id::text,1) from public.product_variants where product_id=v_pants),v_owner::text,'Owner');
  insert into public.product_variants(id,product_id,sku,barcode,color_key,color_en,color_ar,color_hex,size_value,size_sort_order,stock_quantity,low_stock_level,active,sort_order) values
    ('00000000-0000-4000-8000-00000000b501',v_color_only,'ALYQ-05-BLK','629QA05001','black','Black','أسود','#000000',null,0,0,1,true,0),
    ('00000000-0000-4000-8000-00000000b502',v_color_only,'ALYQ-05-WHT','629QA05002','white','White','أبيض','#ffffff',null,0,0,1,true,1);
  perform public.enable_product_variants(v_color_only,
    (select jsonb_object_agg(id::text,1) from public.product_variants where product_id=v_color_only),v_owner::text,'Owner');

  perform public.replace_product_color_images(v_tshirt,jsonb_build_array(
    jsonb_build_object('color_key','black','image_url','https://qa.invalid/alyq-01-black-front.jpg','is_primary',true),
    jsonb_build_object('color_key','black','image_url','https://qa.invalid/alyq-01-black-back.jpg'),
    jsonb_build_object('color_key','white','image_url','https://qa.invalid/alyq-01-white-front.jpg','is_primary',true)));
  if (select count(*) from public.product_color_images where product_id=v_tshirt and color_key='black')<>2
     or (select count(*) from public.product_color_images where product_id=v_tshirt and color_key='white')<>1
     or exists(select 1 from public.product_color_images where product_id=v_tshirt and color_key='black' and image_url like '%white%') then
    raise exception 'colour galleries mixed identities';
  end if;

  -- Exact shelf split required by the acceptance scenario: Main 8, Branch B 3.
  perform public.inventory_transfer_stock('final-qa-shoe-black-42-split',v_branch_b,v_shoes,v_black_42,3,'Final QA opening allocation');
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_black_42)<>8
     or (select quantity from public.branch_stock_balances where branch_id=v_branch_b and variant_id=v_black_42)<>3 then
    raise exception 'Black / 42 branch quantities are not Main=8 and B=3';
  end if;
  if (select count(distinct sku) from public.product_variants where product_id in(v_tshirt,v_shoes,v_cap,v_pants,v_color_only))<>23
     or (select count(distinct barcode) from public.product_variants where product_id in(v_tshirt,v_shoes,v_cap,v_pants,v_color_only))<>23 then
    raise exception 'variant SKU/barcode identities are not unique';
  end if;
  if (select sku from public.product_variants where barcode='629QA02142')<>'ALYQ-02-BLK-42' then
    raise exception 'exact barcode did not resolve Black / 42';
  end if;

  -- Named register fixtures remain separate from user/branch/shift identity.
  v_result:=public.register_create('MAIN-01','Main Register 01',v_main,v_install_main_1);
  v_register_main_1:=(v_result->'register'->>'id')::uuid; v_credential:=v_result->>'credential';
  v_result:=public.register_create('MAIN-02','Main Register 02',v_main,v_install_main_2);
  v_register_main_2:=(v_result->'register'->>'id')::uuid;
  perform public.switch_active_branch_with_audit(v_branch_b);
  v_result:=public.register_create('BRANCH-B-01','Branch B Register 01',v_branch_b,v_install_b_1);
  v_register_b_1:=(v_result->'register'->>'id')::uuid;
  perform public.switch_active_branch_with_audit(v_main);
  if v_register_main_1=v_register_main_2 or v_register_main_1=v_register_b_1 then raise exception 'register identity collapsed'; end if;

  -- A direct exact-variant cash sale and return proves invoice snapshots and
  -- stock effects use the origin branch, not aggregate/global stock.
  perform pg_temp.ensure_open_shift(v_owner::text);
  select quantity into v_before_main from public.branch_stock_balances where branch_id=v_main and variant_id=v_black_42;
  select quantity into v_before_b from public.branch_stock_balances where branch_id=v_branch_b and variant_id=v_black_42;
  v_result:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','final-qa-black-42-cash-sale','source','pos','user_id',v_owner::text,'user_name','Owner',
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',750,'status','paid','tendered',1000)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_shoes::text,'variant_id',v_black_42::text,'qty',1))));
  v_sale_id:=(v_result->>'sale_id')::uuid;
  select id into v_sale_item from public.sale_items where sale_id=v_sale_id and variant_id=v_black_42;
  if v_sale_item is null
     or not exists(select 1 from public.sale_items where id=v_sale_item and sku='ALYQ-02-BLK-42' and barcode='629QA02142' and variant_size_label='42')
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_black_42)<>v_before_main-1
     or (select quantity from public.branch_stock_balances where branch_id=v_branch_b and variant_id=v_black_42)<>v_before_b
     or (select sum(amount) from public.sale_payments where sale_id=v_sale_id)<>750 then
    raise exception 'exact cash sale lost identity, payment, or branch stock atomicity';
  end if;
  perform public.pos_complete_sale(jsonb_build_object(
    'client_ref','final-qa-black-42-cash-sale','source','pos','user_id',v_owner::text,'user_name','Owner',
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',750,'status','paid','tendered',1000)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_shoes::text,'variant_id',v_black_42::text,'qty',1))));
  if (select count(*) from public.sales where client_ref='final-qa-black-42-cash-sale')<>1
     or (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_black_42)<>v_before_main-1 then
    raise exception 'lost-response retry duplicated sale or stock';
  end if;
  v_return:=public.pos_process_return(jsonb_build_object(
    'client_ref','final-qa-black-42-return','sale_id',v_sale_id::text,'reason','Final QA exact return',
    'refund_method','cash','refund_status','completed','user_id',v_owner::text,'user_name','Owner',
    'items',jsonb_build_array(jsonb_build_object('sale_item_id',v_sale_item::text,'quantity',1))));
  if (select quantity from public.branch_stock_balances where branch_id=v_main and variant_id=v_black_42)<>v_before_main
     or (select quantity from public.branch_stock_balances where branch_id=v_branch_b and variant_id=v_black_42)<>v_before_b
     or not exists(select 1 from public.return_items where return_id=(v_return->>'return_id')::uuid and variant_id=v_black_42 and sku='ALYQ-02-BLK-42') then
    raise exception 'exact return did not restore only the originating shelf';
  end if;

  -- Main-only manager and restricted employee cannot widen branch/action scope.
  perform pg_temp.become(v_manager_main,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.switch_active_branch_with_audit(v_branch_b);
    raise exception 'Main-only manager switched into Branch B';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.inventory_branch_stock(v_branch_b);
    raise exception 'Main-only manager read Branch B stock';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.become(v_restricted,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.inventory_transfer_stock('final-qa-forged-transfer',v_branch_b,v_shoes,v_black_42,1,'forged');
    raise exception 'restricted employee transferred stock';
  exception when insufficient_privilege then null;
  end;

  -- Cross-prompt evidence must coexist in one DB: offline replay, registered
  -- sale, mobile lifecycle, approval/branch/audit and exact return/transfer.
  perform pg_temp.become(null,'postgres');
  if not exists(select 1 from public.sales where client_ref='prompt5-offline-register-sale')
     or not exists(select 1 from public.stock_transfers where client_ref='alyq-01-black-42-a-to-b')
     or not exists(select 1 from public.audit_log where action='mobile.installation_deactivated')
     or not exists(select 1 from public.audit_log where action='branch.switched')
     or exists(select 1 from public.audit_log where details::text ~* '(provider-token-prompt6|manager_pin|credential_hash)') then
    raise exception 'cross-prompt evidence is missing or audit contains secret material';
  end if;

  raise notice 'Final Store QA dataset: six safe test users, Main/Branch B, three registers, five fashion variant models, galleries, exact branch stock, cash sale/idempotency/return, cross-branch denial and cross-prompt audit evidence passed';
end
$final_store_qa$;

reset role;

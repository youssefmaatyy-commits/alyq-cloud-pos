-- Prompt 5 focused scenarios: register credential authority, immutable evidence,
-- offline replay identity and drawer/register safety.

do $prompt5_registers$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_other uuid := '00000000-0000-4000-8000-0000000035b2';
  v_product uuid := '00000000-0000-4000-8000-0000000035a1';
  v_variant uuid := '00000000-0000-4000-8000-000000003542';
  v_install uuid := '00000000-0000-4000-8000-000000005001';
  v_install_two uuid := '00000000-0000-4000-8000-000000005002';
  v_created jsonb; v_created_two jsonb; v_context jsonb; v_managed jsonb;
  v_register uuid; v_register_two uuid; v_credential text; v_credential_two text;
  v_payload jsonb; v_evidence jsonb; v_first jsonb; v_second jsonb;
  v_before integer; v_after integer;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  perform pg_temp.ensure_open_shift(v_admin::text);
  v_created:=public.register_create('TILL-01','Front Till',v_main,v_install);
  v_register:=(v_created->'register'->>'id')::uuid;
  v_credential:=v_created->>'credential';
  if v_register is null or char_length(v_credential)<32 then raise exception 'register setup did not return one-time binding proof'; end if;
  v_context:=public.register_context(v_install,v_credential);
  if (v_context->>'id')::uuid<>v_register or v_context ? 'credential_hash' or v_context::text like '%'||v_credential||'%' then
    raise exception 'safe register context missing identity or exposed credential material';
  end if;

  -- A payload register id is not authority: the credential-derived record must
  -- equal it, and a changed id is refused before any transaction is written.
  v_payload:=jsonb_build_object(
    'client_ref','prompt5-register-sale','user_id',v_admin::text,'user_name','Amina Admin','source','pos',
    'discount_type','none','discount_value',0,
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',105,'status','paid','tendered',105)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product::text,'variant_id',v_variant::text,'qty',1,'discount_type','none','discount_value',0)));
  begin
    perform public.pos_complete_registered_sale(v_payload,null,v_install,v_credential,gen_random_uuid());
    raise exception 'client register id controlled registered sale authority';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from public.sales where client_ref='prompt5-register-sale') then raise exception 'forged register refusal still wrote a sale'; end if;

  select quantity into v_before from public.branch_stock_balances where branch_id=v_main and variant_id=v_variant;
  v_first:=public.pos_complete_registered_sale(v_payload,null,v_install,v_credential,v_register);
  v_second:=public.pos_complete_registered_sale(v_payload,null,v_install,v_credential,v_register);
  select quantity into v_after from public.branch_stock_balances where branch_id=v_main and variant_id=v_variant;
  if v_first->>'sale_id' is distinct from v_second->>'sale_id' or v_after<>v_before-1
     or (select register_id from public.sales where id=(v_first->>'sale_id')::uuid)<>v_register
     or (select register_name from public.sales where id=(v_first->>'sale_id')::uuid)<>'Front Till'
     or (select branch_name from public.sales where id=(v_first->>'sale_id')::uuid) is distinct from (select name_en from public.branches where id=v_main) then
    raise exception 'registered sale lost evidence or idempotency';
  end if;

  v_created_two:=public.register_create('TILL-02','Back Till',v_main,v_install_two);
  v_register_two:=(v_created_two->'register'->>'id')::uuid;
  v_credential_two:=v_created_two->>'credential';
  begin
    perform public.pos_complete_registered_sale(v_payload,null,v_install_two,v_credential_two,v_register_two);
    raise exception 'another register claimed an idempotent sale';
  exception when check_violation then null;
  end;

  -- Registered offline evidence retains both original installation and register;
  -- replay twice decrements only Black / 42 once.
  v_payload:=v_payload||jsonb_build_object('client_ref','prompt5-offline-register-sale');
  v_evidence:=jsonb_build_object(
    'schema_version',1,'branch_id',v_main::text,'register_id',v_register::text,'installation_id',v_install::text,
    'captured_at',now(),'subtotal',105,'discount_amount',0,'total',105,
    'lines',jsonb_build_array(jsonb_build_object(
      'product_id',v_product::text,'variant_id',v_variant::text,'sku','ALYQ-01-BLK-42','barcode','629ALYQ0142',
      'color_ar','أسود','color_en','Black','size_value','42','qty',1,'unit_price',105)));
  select quantity into v_before from public.branch_stock_balances where branch_id=v_main and variant_id=v_variant;
  v_first:=public.pos_sync_registered_offline_sale(v_payload,v_evidence,v_install,v_credential,v_register);
  v_second:=public.pos_sync_registered_offline_sale(v_payload,v_evidence,v_install,v_credential,v_register);
  select quantity into v_after from public.branch_stock_balances where branch_id=v_main and variant_id=v_variant;
  if v_first->>'sale_id' is distinct from v_second->>'sale_id' or v_after<>v_before-1
     or (select register_id from public.sales where id=(v_first->>'sale_id')::uuid)<>v_register then
    raise exception 'registered offline replay lost identity or duplicated exact stock';
  end if;
  begin
    perform public.pos_sync_registered_offline_sale(
      v_payload||jsonb_build_object('client_ref','prompt5-offline-forged-register'),
      v_evidence||jsonb_build_object('register_id',v_register_two),v_install,v_credential,v_register);
    raise exception 'changed offline register evidence was accepted';
  exception when check_violation then null;
  end;

  -- Heartbeat queue facts block silent reassignment even for an authorized admin.
  perform public.register_heartbeat(v_install,v_credential,'5.0.0','win32/x64',
    '{"printer_configured":true,"paper_width_mm":80,"drawer_mode":"printer-driver"}'::jsonb,1,0);
  begin
    perform public.register_manage(v_register,'reassign',null,v_other);
    raise exception 'register moved with a pending offline operation';
  exception when check_violation then null;
  end;
  perform public.register_heartbeat(v_install,v_credential,'5.0.0','win32/x64','{}'::jsonb,0,0);
  v_managed:=public.register_manage(v_register,'reassign',null,v_other);
  if (v_managed->>'branch_id')::uuid<>v_other then raise exception 'safe register reassignment failed'; end if;
  v_managed:=public.register_manage(v_register,'reassign',null,v_main);
  v_managed:=public.register_manage(v_register,'deactivate',null,null);
  if (v_managed->>'active')::boolean then raise exception 'register deactivation failed'; end if;
  begin
    perform public.pos_complete_registered_sale(v_payload||jsonb_build_object('client_ref','prompt5-inactive'),null,v_install,v_credential,v_register);
    raise exception 'inactive register sold';
  exception when insufficient_privilege then null;
  end;
  perform public.register_manage(v_register,'activate',null,null);

  -- Manual drawer authority is separate from transaction success. This register
  -- has no open shift, so authorization is refused and no drawer audit is forged.
  begin
    perform public.register_authorize_drawer_open(v_install,v_credential,'cash count');
    raise exception 'manual drawer open succeeded without its register shift';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.audit_log where action='drawer.open_authorized' and register_id=v_register) then
    raise exception 'refused drawer command wrote a success audit';
  end if;

  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.register_create('FORGED','Forged',v_main,gen_random_uuid());
    raise exception 'cashier created a register';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  if (select count(*) from public.audit_log where register_id=v_register and action in(
      'register.created','register.reassigned','register.deactivated','register.activated'))<4 then
    raise exception 'register lifecycle did not retain audit evidence';
  end if;
  raise notice 'Prompt 5 register authority scenarios passed';
end
$prompt5_registers$;

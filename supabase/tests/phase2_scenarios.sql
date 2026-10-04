-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 focused security/accounting scenarios
-- Runs after scenarios.sql in the same disposable database/session.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Branch membership, switching, hidden branches and forged scope ─────────
do $phase2_branch$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_branch uuid;
  v_customer uuid := '00000000-0000-4000-8000-00000000b201';
  v_n integer;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  select id into v_branch from public.admin_create_branch('phase2','Phase 2 Branch','فرع المرحلة الثانية');
  if v_branch is null then raise exception 'phase2 branch was not created'; end if;
  perform public.admin_set_branch_membership(v_cashier,v_branch,'viewer',null,'{}','{}',true);

  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  if not public.can('sell') or public.current_user_role()<>'cashier' then
    raise exception 'main-branch cashier authority was not preserved';
  end if;
  perform public.switch_active_branch_with_audit(v_branch);
  if public.can('sell') or public.current_user_role()<>'viewer' then
    raise exception 'branch switch did not recalculate the effective role/permissions';
  end if;
  select count(*) into v_n from public.get_my_branches();
  if v_n<>2 then raise exception 'cashier RPC exposed % branches instead of 2',v_n; end if;
  select count(*) into v_n from public.branches;
  if v_n<>2 then raise exception 'cashier direct RLS exposed % branches instead of 2',v_n; end if;
  begin
    perform public.switch_active_branch(v_main);
    raise exception 'raw unaudited branch switching remained executable';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_viewer,'authenticated');
  select count(*) into v_n from public.get_my_branches() where id=v_branch;
  if v_n<>0
     or exists(select 1 from public.branches where id=v_branch)
     or exists(select 1 from public.branch_memberships where branch_id=v_branch) then
    raise exception 'a no-access branch or membership was disclosed';
  end if;
  begin
    perform public.switch_active_branch_with_audit(v_branch);
    raise exception 'a forged no-membership branch switch succeeded';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_branch);
  if (select count(*) from public.operation_policies where branch_id=v_branch and scope_type='branch')<>7 then
    raise exception 'a runtime-created branch did not inherit all operation controls';
  end if;
  if not exists(select 1 from public.audit_log where action='branch.switched' and branch_id=v_branch) then
    raise exception 'branch switching was not audited';
  end if;
  insert into public.customers(id,name,phone,branch_id,created_at)
  values(v_customer,'Phase 2 scoped customer','01000000201',v_main,now());
  if (select branch_id from public.customers where id=v_customer)<>v_branch then
    raise exception 'a forged branch id was not replaced by authoritative scope';
  end if;
  perform public.switch_active_branch_with_audit(v_main);
  if exists(select 1 from public.customers where id=v_customer) then
    raise exception 'RLS exposed a customer from another active branch';
  end if;
  begin
    perform public.admin_set_branch_membership(v_admin,v_branch,'viewer',null,'{}','{}',true);
    raise exception 'the final branch access manager was demoted';
  exception when check_violation then null;
  end;
  raise notice 'Phase 2 branch security — per-branch roles recalculate, inaccessible branches stay hidden, forged scope is stamped/rejected, runtime branches inherit controls, and the final manager is protected';
end
$phase2_branch$;

reset role;

-- Test-only expired fixture factory: created while the migration runner is the
-- database owner, then callable through a temporary SECURITY DEFINER wrapper.
-- It INSERTS an already-expired copy; production exposes no way to mutate the
-- immutable expiry of a submitted request.
create or replace function pg_temp.clone_expired_approval(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid:=gen_random_uuid();
begin
  insert into public.approval_requests
  select (jsonb_populate_record(
    null::public.approval_requests,
    to_jsonb(r)||jsonb_build_object(
      'id',v_id,
      'request_number',r.request_number||'-EXPIRED',
      'correlation_id',gen_random_uuid(),
      'expires_at',now()-interval '1 second'
    )
  )).*
  from public.approval_requests r where r.id=p_request_id;
  return v_id;
end
$$;

-- ── Exact approval, PIN secrecy/authority, tamper and replay ───────────────
do $phase2_approval$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_manager uuid;
  v_wrong_manager uuid;
  v_other_branch uuid;
  v_product uuid := '00000000-0000-4000-8000-0000000f0067';
  v_request uuid;
  v_expired uuid;
  v_secret_request uuid;
  v_forbidden uuid;
  v_self uuid;
  v_payload jsonb;
  v_out jsonb;
  v_sale jsonb;
  v_stored jsonb;
  v_step text:='base setup';
begin
  perform pg_temp.become(v_admin,'authenticated');
  v_step:='switch main branch';
  perform public.switch_active_branch_with_audit(v_main);
  v_step:='load fixtures';
  select id into v_manager from public.profiles where username='manager';
  select id into v_wrong_manager from public.profiles where username='viewer';
  select id into v_other_branch from public.branches where code='phase2';
  if v_manager is null or v_wrong_manager is null or v_other_branch is null then
    raise exception 'approval fixtures missing';
  end if;
  v_step:='main manager PIN';
  perform public.set_manager_pin(v_manager,v_main,'2468');
  v_step:='wrong-branch manager fixture';
  perform public.admin_set_branch_membership(
    v_wrong_manager,v_other_branch,'manager',null,'{}','{}',true
  );
  perform public.set_manager_pin(v_wrong_manager,v_other_branch,'1357');
  begin
    perform pin_hash from public.manager_credentials where user_id=v_manager;
    raise exception 'a PIN hash was readable by a browser role';
  exception when insufficient_privilege then null;
  end;

  -- The manager role is deliberately too weak for this value first.
  perform public.set_operation_policy(jsonb_build_object(
    'branch_id',v_main,'operation','invoice_discount','scope_type','role','scope_role','manager',
    'permission_required','apply_discount','enabled',true,'allow_approval',true,
    'allow_permission_escalation',false,'normal_max_percent',10,'approval_max_percent',10));

  -- Equality is inside the normal limit: exactly 10% executes without an
  -- approval, while the 10.1% request below must enter the approval path.
  -- Restore the cashier's context after the branch-switch scenario so the
  -- fixture helper can authoritatively hand off any existing main drawer.
  v_step:='threshold equality';
  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  perform pg_temp.become(v_manager,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  perform pg_temp.ensure_open_shift(v_manager::text);
  v_sale:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','phase2-threshold-equality','user_id',v_manager::text,'user_name','Mona Manager',
    'discount_type','percent','discount_value',10,
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',9,'tendered',9)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1))));
  if (v_sale->>'sale_id') is null then raise exception 'exact normal-limit equality required approval'; end if;

  v_step:='just-over request';
  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  perform pg_temp.ensure_open_shift(v_cashier::text);
  v_payload:=jsonb_build_object(
    'client_ref','phase2-approved-sale','user_id',v_cashier::text,'user_name','Karim Cashier',
    'discount_type','percent','discount_value',10.1,
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',8.99,'tendered',8.99)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1)));
  select (public.submit_approval_request(jsonb_build_object(
    'kind','discount','operation_type','sale_discount','entity_type','sale',
    'entity_label','phase2-approved-sale','amount',10.1,'limit_value',10,
    'payload',v_payload,'reason','Phase 2 exact approval'))->>'request_id')::uuid into v_request;

  v_step:='wrong-branch refusal';
  v_out:=public.approve_with_manager_pin(v_request,'viewer','1357');
  if coalesce((v_out->>'ok')::boolean,true) or v_out->>'code'<>'INVALID_APPROVER' then
    raise exception 'a manager credential from another branch approved the request: %',v_out;
  end if;
  v_step:='expired fixture/refusal';
  v_expired:=pg_temp.clone_expired_approval(v_request);
  v_out:=public.approve_with_manager_pin(v_expired,'manager','2468');
  if coalesce((v_out->>'ok')::boolean,true) or v_out->>'code'<>'EXPIRED' then
    raise exception 'an expired approval request was accepted: %',v_out;
  end if;

  v_out:=public.approve_with_manager_pin(v_request,'manager','0000');
  if coalesce((v_out->>'ok')::boolean,true) or v_out->>'code'<>'INVALID_CREDENTIALS' then
    raise exception 'wrong manager PIN was not refused generically: %',v_out;
  end if;
  perform pg_temp.become(v_admin,'authenticated');
  if not exists(select 1 from public.audit_log where action='approval.verification_failed' and entity_id=v_request::text) then
    raise exception 'failed PIN verification was not committed to audit';
  end if;
  perform pg_temp.become(v_cashier,'authenticated');
  v_out:=public.approve_with_manager_pin(v_request,'manager','2468');
  if coalesce((v_out->>'ok')::boolean,true) or v_out->>'code'<>'INSUFFICIENT_AUTHORITY' then
    raise exception 'manager ceiling was not enforced: %',v_out;
  end if;

  perform pg_temp.become(v_admin,'authenticated');
  perform public.set_operation_policy(jsonb_build_object(
    'branch_id',v_main,'operation','invoice_discount','scope_type','role','scope_role','manager',
    'permission_required','apply_discount','enabled',true,'allow_approval',true,
    'allow_permission_escalation',false,'normal_max_percent',10,'approval_max_percent',100));
  perform pg_temp.become(v_cashier,'authenticated');
  v_out:=public.approve_with_manager_pin(v_request,'manager','2468');
  if not coalesce((v_out->>'ok')::boolean,false) then raise exception 'sufficient manager approval failed: %',v_out; end if;

  begin
    perform public.pos_complete_sale(v_payload||jsonb_build_object('client_ref','phase2-tampered-sale'),v_request);
    raise exception 'an approval authorised a different operation fingerprint';
  exception when insufficient_privilege then null;
  end;
  if exists(select 1 from public.approval_requests where id=v_request and consumed_at is not null) then
    raise exception 'a refused fingerprint attempt consumed the approval';
  end if;
  v_sale:=public.pos_complete_sale(v_payload,v_request);
  if (v_sale->>'sale_id') is null then raise exception 'exact approved operation did not execute'; end if;
  begin
    perform public.pos_complete_sale(v_payload,v_request);
    raise exception 'a consumed approval replayed';
  exception when check_violation then null;
  end;

  -- Recursive secret stripping applies to approval payloads as well as audit.
  select (public.submit_approval_request(jsonb_build_object(
    'kind','expense','operation_type','cash_out','entity_type','cash_movement',
    'entity_id','secret-fixture','entity_label','secret-fixture','amount',1,
    'payload',jsonb_build_object('manager_pin','2468','nested',jsonb_build_array(
      jsonb_build_object('password','never-store-me','safe','retained'))),
    'reason','Secret sanitization fixture'))->>'request_id')::uuid into v_secret_request;
  select payload into v_stored from public.approval_requests where id=v_secret_request;
  if v_stored ? 'manager_pin' or (v_stored#>'{nested,0}') ? 'password'
     or v_stored#>>'{nested,0,safe}'<>'retained' then
    raise exception 'approval payload secret sanitization failed: %',v_stored;
  end if;

  -- Void is permission-only by default. A manager credential cannot turn an
  -- explicitly non-escalatable operation into an approval.
  select (public.submit_approval_request(jsonb_build_object(
    'kind','expense','operation_type','void','entity_type','sale','entity_id','forbidden',
    'entity_label','forbidden','amount',10,'payload',jsonb_build_object('sale_id','forbidden'),
    'reason','Must remain forbidden'))->>'request_id')::uuid into v_forbidden;
  v_out:=public.approve_with_manager_pin(v_forbidden,'manager','2468');
  if coalesce((v_out->>'ok')::boolean,true) or v_out->>'code'<>'INSUFFICIENT_AUTHORITY' then
    raise exception 'a forbidden operation was escalated: %',v_out;
  end if;

  perform pg_temp.become(v_manager,'authenticated');
  select (public.submit_approval_request(jsonb_build_object(
    'kind','expense','operation_type','cash_out','entity_type','cash_movement','entity_id','self',
    'entity_label','self','amount',1,'payload',jsonb_build_object('target','self'),
    'reason','Self approval must fail'))->>'request_id')::uuid into v_self;
  begin
    perform public.decide_approval_request(v_self,'approved','self');
    raise exception 'an approver approved their own operation';
  exception when insufficient_privilege then null;
  end;

  if exists(select 1 from public.audit_log
    where coalesce(details::text,'')||coalesce(before_state::text,'')||coalesce(after_state::text,'')
      ilike '%2468%' or coalesce(details::text,'') ilike '%never-store-me%') then
    raise exception 'a PIN or nested secret reached the audit trail';
  end if;
  raise notice 'Phase 2 approval security — threshold equality/just-over escalation, wrong-branch and expired refusal, PIN verification, authority ceilings, exact fingerprints, single use, self-approval refusal, forbidden-operation refusal and recursive secret stripping all hold';
exception when others then
  raise exception 'Phase 2 approval block [%]: %',v_step,sqlerrm using errcode=sqlstate;
end
$phase2_approval$;

-- ── Payment-derived reconciliation, cash movements and duplicate close ─────
do $phase2_shift$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_product uuid := '00000000-0000-4000-8000-0000000f0067';
  v_old_shift uuid;
  v_shift uuid;
  v_prior jsonb;
  v_prior_id uuid;
  v_item uuid;
  v_sale jsonb;
  v_insta_id uuid;
  v_return jsonb;
  v_closed public.shifts;
  v_payment_sum numeric;
begin
  perform pg_temp.become(v_cashier,'authenticated');
  v_old_shift:=pg_temp.ensure_open_shift(v_cashier::text);
  v_prior:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','phase2-prior-shift-sale','user_id',v_cashier::text,'user_name','Karim Cashier',
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',10,'tendered',10)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1))));
  v_prior_id:=(v_prior->>'sale_id')::uuid;
  select id into v_item from public.sale_items where sale_id=v_prior_id;
  perform public.close_shift_authoritative(v_old_shift,(select opening_cash from public.shifts where id=v_old_shift),'Phase 2 fixture hand-off');

  insert into public.shifts(branch,register,opening_cash,opened_by,opened_by_name)
  values('forged branch','P2 Till',100,'forged','forged') returning id into v_shift;
  if (select opened_by from public.shifts where id=v_shift)<>v_cashier::text then
    raise exception 'shift ownership trusted caller fields';
  end if;
  begin
    update public.shifts set status='closed' where id=v_shift;
    raise exception 'direct shift close bypassed reconciliation';
  exception when insufficient_privilege then null;
  end;

  v_sale:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','phase2-split-sale','user_id',v_cashier::text,'user_name','Karim Cashier',
    'payments',jsonb_build_array(
      jsonb_build_object('method','cash','amount',4,'tendered',4),
      jsonb_build_object('method','visa','amount',6)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1))));
  v_sale:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','phase2-instapay-sale','user_id',v_cashier::text,'user_name','Karim Cashier',
    'payments',jsonb_build_array(jsonb_build_object('method','instapay','amount',10,'status','pending')),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1))));
  v_insta_id:=(v_sale->>'sale_id')::uuid;
  perform public.pos_confirm_payment(v_insta_id,v_cashier::text,'Karim Cashier');

  v_return:=public.pos_process_return(jsonb_build_object(
    'sale_id',v_prior_id::text,'reason','Cross-shift refund','refund_method','cash',
    'refund_status','completed','user_id',v_cashier::text,'user_name','Karim Cashier',
    'items',jsonb_build_array(jsonb_build_object('sale_item_id',v_item::text,'quantity',1))));
  if (select settlement_shift_id from public.refund_records where id=(v_return->>'refund_id')::uuid)<>v_shift then
    raise exception 'refund was attributed to the sale shift instead of settlement shift';
  end if;
  perform public.record_cash_movement('cash_in',20,'Float top-up',null,null);
  perform public.record_cash_movement('cash_out',5,'Petty drawer payment',null,null);

  v_closed:=public.close_shift_authoritative(v_shift,108,'Phase 2 short count');
  if (v_closed.summary->>'expected_cash')::numeric<>109
     or (v_closed.summary->>'actual_cash')::numeric<>108
     or (v_closed.summary->>'difference')::numeric<>-1
     or (v_closed.summary->>'cash_sales')::numeric<>4
     or (v_closed.summary->>'cash_refunds')::numeric<>10
     or (v_closed.summary->>'cash_in')::numeric<>20
     or (v_closed.summary->>'cash_out')::numeric<>5
     or (v_closed.summary->>'mixed_count')::int<>1
     or v_closed.notes<>'Phase 2 short count' then
    raise exception 'authoritative close summary/reason is wrong: %',v_closed.summary;
  end if;
  select coalesce(sum((p->>'amount')::numeric),0) into v_payment_sum
    from jsonb_array_elements(v_closed.summary->'payments_breakdown') p;
  if v_payment_sum<>20 then
    raise exception 'split/payment allocations were double-counted or omitted: %',v_closed.summary->'payments_breakdown';
  end if;
  begin
    perform public.close_shift_authoritative(v_shift,108,'duplicate');
    raise exception 'duplicate close succeeded';
  exception when check_violation then null;
  end;
  perform pg_temp.become(v_admin,'authenticated');
  if (select count(*) from public.audit_log where action='shift.closed' and entity_id=v_shift::text)<>1 then
    raise exception 'authoritative close did not write exactly one audit event';
  end if;
  raise notice 'Phase 2 reconciliation — split/card/InstaPay allocations count once, cross-shift cash refunds follow settlement, cash in/out enter the drawer formula, over/short and reason stay separate, and duplicate/direct close are refused';
exception when others then
  raise exception 'Phase 2 reconciliation block: %',sqlerrm using errcode=sqlstate;
end
$phase2_shift$;

-- ── Cleanup protocol, dependency preservation, stale token and replay ──────
do $phase2_cleanup$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_cashier uuid := '00000000-0000-4000-8000-0000000000c1';
  v_manager uuid;
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_hist uuid := '00000000-0000-4000-8000-00000000c203';
  v_product uuid := '00000000-0000-4000-8000-0000000f0067';
  v_sale jsonb;
  v_delete1 uuid := '00000000-0000-4000-8000-00000000c201';
  v_delete2 uuid := '00000000-0000-4000-8000-00000000c202';
  v_preview jsonb;
  v_fresh jsonb;
  v_preview_only jsonb;
  v_result jsonb;
  v_audit_before bigint;
  v_step text:='cashier preview refusal';
begin
  -- Preview and execution are distinct capabilities. A cashier gets neither;
  -- a manager may inspect real counts but cannot consume the one-shot token.
  perform pg_temp.become(v_admin,'authenticated');
  select id into v_manager from public.profiles where username='manager';
  if v_manager is null then raise exception 'manager fixture missing'; end if;
  perform pg_temp.become(v_cashier,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  begin
    perform public.preview_selective_cleanup('customers',jsonb_build_object('before',now()-interval '1 day'));
    raise exception 'an unauthorized cleanup preview succeeded';
  exception when insufficient_privilege then null;
  end;
  v_step:='manager preview-only refusal';
  perform pg_temp.become(v_manager,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  v_preview_only:=public.preview_selective_cleanup(
    'customers',jsonb_build_object('before',now()-interval '1 day')
  );
  begin
    perform public.execute_selective_cleanup(
      (v_preview_only->>'preview_id')::uuid,v_preview_only->>'preview_token',
      v_preview_only->>'fingerprint',v_preview_only->>'confirmation_phrase',null
    );
    raise exception 'a preview-only user executed cleanup';
  exception when insufficient_privilege then null;
  end;

  v_step:='admin cleanup fixture';
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);
  insert into public.customers(id,name,phone,created_at)
  values(v_hist,'Historical PII','01099999201',now()-interval '100 days');
  perform pg_temp.ensure_open_shift(v_admin::text);
  v_sale:=public.pos_complete_sale(jsonb_build_object(
    'client_ref','phase2-cleanup-history','user_id',v_admin::text,'user_name','Amina Admin',
    'customer_id',v_hist::text,
    'payments',jsonb_build_array(jsonb_build_object('method','cash','amount',10,'tendered',10)),
    'lines',jsonb_build_array(jsonb_build_object('product_id',v_product,'qty',1))));
  if (v_sale->>'sale_id') is null then raise exception 'cleanup dependency sale was not created'; end if;
  insert into public.customers(id,name,phone,created_at)
  values(v_delete1,'Disposable one','01099999202',now()-interval '100 days');

  v_preview_only:=public.preview_selective_cleanup('customers',jsonb_build_object(
    'from',now()-interval '200 days','before',now()-interval '1 day',
    'record_id',v_delete1,'reference','01099999202'
  ));
  if (v_preview_only#>>'{state,delete_count}')::int<>1
     or (v_preview_only#>>'{state,anonymize_count}')::int<>0 then
    raise exception 'specific record/date/reference filters were not exact: %',v_preview_only->'state';
  end if;
  begin
    perform public.preview_selective_cleanup('customers',jsonb_build_object(
      'before',now()-interval '1 day','table','sales'
    ));
    raise exception 'an arbitrary cleanup filter was accepted';
  exception when check_violation then null;
  end;

  v_preview:=public.preview_selective_cleanup('customers',jsonb_build_object('before',now()-interval '1 day'));
  if (v_preview#>>'{state,delete_count}')::int<1 or (v_preview#>>'{state,anonymize_count}')::int<1 then
    raise exception 'cleanup preview did not expose real delete/anonymize dependencies: %',v_preview->'state';
  end if;
  insert into public.customers(id,name,phone,created_at)
  values(v_delete2,'Disposable two','01099999203',now()-interval '100 days');
  begin
    perform public.execute_selective_cleanup(
      (v_preview->>'preview_id')::uuid,v_preview->>'preview_token',v_preview->>'fingerprint',
      v_preview->>'confirmation_phrase',null);
    raise exception 'a stale cleanup preview executed';
  exception when serialization_failure then null;
  end;

  v_fresh:=public.preview_selective_cleanup('customers',jsonb_build_object('before',now()-interval '1 day'));
  begin
    perform public.execute_selective_cleanup(
      (v_fresh->>'preview_id')::uuid,'wrong-token',v_fresh->>'fingerprint',
      v_fresh->>'confirmation_phrase',null);
    raise exception 'a forged cleanup token executed';
  exception when insufficient_privilege then null;
  end;
  select count(*) into v_audit_before from public.audit_log;
  v_result:=public.execute_selective_cleanup(
    (v_fresh->>'preview_id')::uuid,v_fresh->>'preview_token',v_fresh->>'fingerprint',
    v_fresh->>'confirmation_phrase',null);
  if (v_result->>'deleted')::int<2 or (v_result->>'anonymized')::int<1 then
    raise exception 'cleanup execution did not match its real preview: %',v_result;
  end if;
  if exists(select 1 from public.customers where id in(v_delete1,v_delete2)) then
    raise exception 'eligible disposable customers survived cleanup';
  end if;
  if not exists(select 1 from public.customers where id=v_hist and name='Anonymized customer')
     or not exists(select 1 from public.sales where customer_id=v_hist) then
    raise exception 'cleanup orphaned/deleted finalized sale history instead of anonymizing PII';
  end if;
  if (select count(*) from public.audit_log)<=v_audit_before then
    raise exception 'cleanup did not append audit evidence';
  end if;
  begin
    perform public.execute_selective_cleanup(
      (v_fresh->>'preview_id')::uuid,v_fresh->>'preview_token',v_fresh->>'fingerprint',
      v_fresh->>'confirmation_phrase',null);
    raise exception 'cleanup preview replayed';
  exception when check_violation then null;
  end;
  begin
    perform public.preview_selective_cleanup('audit_log',jsonb_build_object('before',now()-interval '1 day'));
    raise exception 'arbitrary cleanup category was accepted';
  exception when check_violation then null;
  end;
  begin
    perform count(*) from public.cleanup_previews;
    raise exception 'cleanup token hashes were browser-readable';
  exception when insufficient_privilege then null;
  end;
  raise notice 'Phase 2 cleanup — unauthorized preview/execute refusal, exact safe date/record/reference filters, real dependency counts, stale-preview/token refusal, anonymize-vs-delete preservation, one-shot execution, audit survival and closed categories all hold';
exception when others then
  raise exception 'Phase 2 cleanup block [%]: %',v_step,sqlerrm using errcode=sqlstate;
end
$phase2_cleanup$;

-- ── Recursive audit sanitization and append-only evidence ──────────────────
do $phase2_audit$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_id uuid;
  v_details jsonb;
begin
  perform pg_temp.become(v_admin,'authenticated');
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,before_state,after_state,module)
  values('health.check_run','health_check','phase2-sanitize','Phase 2 sanitize',
    jsonb_build_object('safe','kept','nested',jsonb_build_object('pin','1234','deep',jsonb_build_array(
      jsonb_build_object('password_hash','hash-secret','value','kept-too'))),'token','token-secret'),
    v_admin::text,'forged',jsonb_build_object('manager_pin','9999','safe_before',true),
    jsonb_build_object('refresh_token','refresh-secret','safe_after',true),'audit')
  returning id,details into v_id,v_details;
  if v_details->>'safe'<>'kept' or v_details#>>'{nested,deep,0,value}'<>'kept-too'
     or v_details::text ilike '%1234%' or v_details::text ilike '%hash-secret%'
     or v_details::text ilike '%token-secret%' then
    raise exception 'recursive audit sanitization failed: %',v_details;
  end if;
  if exists(select 1 from public.audit_log where id=v_id
    and (before_state ? 'manager_pin' or after_state ? 'refresh_token')) then
    raise exception 'before/after audit states retained credentials';
  end if;
  begin
    update public.audit_log set entity_label='rewritten' where id=v_id;
    raise exception 'audit update succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.audit_log where id=v_id;
    raise exception 'audit delete succeeded';
  exception when insufficient_privilege then null;
  end;
  raise notice 'Phase 2 audit — nested object/array credentials are stripped, safe evidence remains, actor identity is authoritative, and append-only history resists update/delete';
end
$phase2_audit$;

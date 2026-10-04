-- ═══════════════════════════════════════════════════════════════════════════
-- 0072 · Configurable operation authority, secure manager approval and cash
-- ═══════════════════════════════════════════════════════════════════════════
-- Extends (does not replace) approval_rules/approval_requests and shifts.
-- Policies are branch scoped and may be narrowed for a role or one user.
-- Manager credentials are bcrypt hashes in a table with no client SELECT grant.
-- Inline approval leaves auth.uid() as the cashier: the approver is evidence,
-- never an impersonated session. Approval fingerprints bind one short-lived,
-- single-use decision to one canonical operation payload.
-- ═══════════════════════════════════════════════════════════════════════════

-- Genuinely new business acts. Existing capabilities are reused everywhere else.
insert into public.role_capabilities(role, capability) values
  ('admin','cash_in'), ('manager','cash_in'), ('cashier','cash_in'), ('inventory_clerk','cash_in'),
  ('admin','cash_out'), ('manager','cash_out'), ('cashier','cash_out'), ('inventory_clerk','cash_out'),
  ('admin','preview_data_cleanup'), ('manager','preview_data_cleanup'),
  ('admin','execute_data_cleanup')
on conflict(role, capability) do nothing;

-- Existing absolute custom roles retain only access that was formerly implicit
-- for working till roles. Cleanup remains an explicit administrative grant.
update public.custom_roles
   set capabilities = array_append(capabilities, 'cash_in')
 where ('open_shift' = any(capabilities) or 'close_shift' = any(capabilities))
   and not ('cash_in' = any(capabilities));
update public.custom_roles
   set capabilities = array_append(capabilities, 'cash_out')
 where ('open_shift' = any(capabilities) or 'close_shift' = any(capabilities))
   and not ('cash_out' = any(capabilities));

create table if not exists public.operation_policies (
  id                          uuid primary key default extensions.gen_random_uuid(),
  branch_id                   uuid not null references public.branches(id) on delete cascade,
  operation                   text not null check (operation in (
    'item_discount','invoice_discount','price_override','void','refund','cash_out','selective_cleanup'
  )),
  scope_type                  text not null default 'branch' check (scope_type in ('branch','role','user')),
  scope_role                  public.app_role,
  scope_user_id               uuid references public.profiles(id) on delete cascade,
  permission_required         text not null,
  enabled                     boolean not null default true,
  allow_approval              boolean not null default false,
  allow_permission_escalation boolean not null default false,
  normal_max_percent          numeric(7,2) check (normal_max_percent is null or normal_max_percent between 0 and 100),
  normal_max_amount           numeric(14,2) check (normal_max_amount is null or normal_max_amount >= 0),
  approval_max_percent        numeric(7,2) check (approval_max_percent is null or approval_max_percent between 0 and 100),
  approval_max_amount         numeric(14,2) check (approval_max_amount is null or approval_max_amount >= 0),
  updated_by                  uuid,
  updated_at                  timestamptz not null default now(),
  constraint operation_policy_scope_shape check (
    (scope_type='branch' and scope_role is null and scope_user_id is null)
    or (scope_type='role' and scope_role is not null and scope_user_id is null)
    or (scope_type='user' and scope_role is null and scope_user_id is not null)
  )
);
create unique index if not exists operation_policies_branch_key
  on public.operation_policies(branch_id,operation) where scope_type='branch';
create unique index if not exists operation_policies_role_key
  on public.operation_policies(branch_id,operation,scope_role) where scope_type='role';
create unique index if not exists operation_policies_user_key
  on public.operation_policies(branch_id,operation,scope_user_id) where scope_type='user';
create index if not exists operation_policies_branch_idx on public.operation_policies(branch_id, operation);
drop trigger if exists operation_policies_set_updated_at on public.operation_policies;
create trigger operation_policies_set_updated_at before update on public.operation_policies
  for each row execute function public.set_updated_at();

-- Migrate the configured legacy limits into every branch. No new arbitrary
-- business threshold is introduced: null means permission-only/unlimited.
insert into public.operation_policies(
  branch_id, operation, scope_type, permission_required, enabled, allow_approval,
  allow_permission_escalation,
  normal_max_percent, normal_max_amount, approval_max_percent, approval_max_amount
)
select b.id, x.operation, 'branch', x.permission_required, true, x.allow_approval,
       x.operation in ('item_discount','invoice_discount'),
       x.normal_percent, x.normal_amount, x.approval_percent, x.approval_amount
from public.branches b
cross join lateral (
  select 'item_discount'::text operation, 'apply_discount'::text permission_required,
         coalesce(r.discount_limit_enabled,true) allow_approval,
         case when coalesce(r.discount_limit_enabled,true) then r.discount_limit_percent else null end normal_percent,
         null::numeric normal_amount, 100::numeric approval_percent, null::numeric approval_amount
    from public.approval_rules r where r.id=1
  union all
  select 'invoice_discount','apply_discount',coalesce(r.discount_limit_enabled,true),
         case when coalesce(r.discount_limit_enabled,true) then r.discount_limit_percent else null end,
         null,100,null from public.approval_rules r where r.id=1
  union all
  select 'price_override','change_price',coalesce(r.price_change_approval_enabled,false),
         null,case when coalesce(r.price_change_approval_enabled,false) then 0 else null end,
         null,null from public.approval_rules r where r.id=1
  union all
  select 'void','void_sale',false,null,null,null,null
  union all
  select 'refund','process_refund',coalesce(r.refund_limit_enabled,true),null,
         case when coalesce(r.refund_limit_enabled,true) then r.refund_limit_amount else null end,
         null,null from public.approval_rules r where r.id=1
  union all
  select 'cash_out','cash_out',coalesce(r.expense_limit_enabled,true),null,
         case when coalesce(r.expense_limit_enabled,true) then r.expense_limit_amount else null end,
         null,null from public.approval_rules r where r.id=1
  union all
  select 'selective_cleanup','execute_data_cleanup',false,null,null,null,null
) x
on conflict do nothing;

-- Branches created after this migration inherit only the branch-level defaults.
-- Role/user exceptions are intentionally local decisions and are never copied.
create or replace function public.seed_branch_operation_policies()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.operation_policies(
    branch_id,operation,scope_type,permission_required,enabled,allow_approval,
    allow_permission_escalation,normal_max_percent,normal_max_amount,
    approval_max_percent,approval_max_amount,updated_by
  )
  select new.id,op.operation,'branch',op.permission_required,op.enabled,op.allow_approval,
    op.allow_permission_escalation,op.normal_max_percent,op.normal_max_amount,
    op.approval_max_percent,op.approval_max_amount,auth.uid()
    from public.operation_policies op
    join public.branches b on b.id=op.branch_id and b.is_default
   where op.scope_type='branch'
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists branches_seed_operation_policies on public.branches;
create trigger branches_seed_operation_policies
  after insert on public.branches for each row execute function public.seed_branch_operation_policies();

create or replace function public.operation_policy_for(
  p_operation text, p_user_id uuid default auth.uid(), p_branch_id uuid default public.current_branch_id()
)
returns public.operation_policies
language sql
stable
security definer
set search_path = public
as $$
  select op.*
    from public.operation_policies op
    join public.branch_memberships m on m.user_id=p_user_id and m.branch_id=p_branch_id and m.active
   where op.branch_id=p_branch_id and op.operation=p_operation
     and (
       op.scope_type='branch'
       or (op.scope_type='role' and op.scope_role=m.role)
       or (op.scope_type='user' and op.scope_user_id=p_user_id)
     )
   order by case op.scope_type when 'user' then 3 when 'role' then 2 else 1 end desc
   limit 1
$$;

create or replace function public.operation_decision(
  p_operation text,
  p_percent numeric default null,
  p_amount numeric default null,
  p_user_id uuid default auth.uid(),
  p_branch_id uuid default public.current_branch_id()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_policy public.operation_policies;
  v_has_permission boolean;
  v_over_normal boolean := false;
  v_over_approval boolean := false;
begin
  select * into v_policy from public.operation_policy_for(p_operation,p_user_id,p_branch_id);
  if v_policy.id is null then
    raise exception 'No operation policy for %', p_operation using errcode='check_violation';
  end if;
  if not v_policy.enabled then
    return jsonb_build_object('decision','forbidden','reason','disabled','policy_id',v_policy.id);
  end if;
  v_has_permission := public.branch_member_can(p_user_id,p_branch_id,v_policy.permission_required);
  if not v_has_permission and not v_policy.allow_permission_escalation then
    return jsonb_build_object('decision','forbidden','reason','permission','policy_id',v_policy.id);
  end if;

  if p_percent is not null and v_policy.normal_max_percent is not null
     and p_percent > v_policy.normal_max_percent then v_over_normal := true; end if;
  if p_amount is not null and v_policy.normal_max_amount is not null
     and p_amount > v_policy.normal_max_amount then v_over_normal := true; end if;
  if not v_has_permission then v_over_normal := true; end if;

  if not v_over_normal then
    return jsonb_build_object('decision','allowed','policy_id',v_policy.id,
      'permission',v_policy.permission_required);
  end if;
  if not v_policy.allow_approval then
    return jsonb_build_object('decision','forbidden','reason','above_limit','policy_id',v_policy.id);
  end if;
  if p_percent is not null and v_policy.approval_max_percent is not null
     and p_percent > v_policy.approval_max_percent then v_over_approval := true; end if;
  if p_amount is not null and v_policy.approval_max_amount is not null
     and p_amount > v_policy.approval_max_amount then v_over_approval := true; end if;
  if v_over_approval then
    return jsonb_build_object('decision','forbidden','reason','above_approval_limit','policy_id',v_policy.id);
  end if;
  -- A branch approver may act within their configured approval ceiling without
  -- asking a second person. Other actors need a decision.
  if public.branch_member_can(p_user_id,p_branch_id,'approve_limit_request') and v_has_permission then
    return jsonb_build_object('decision','allowed','policy_id',v_policy.id,'self_approved',true);
  end if;
  return jsonb_build_object('decision','approval','policy_id',v_policy.id,
    'normal_max_percent',v_policy.normal_max_percent,'normal_max_amount',v_policy.normal_max_amount,
    'approval_max_percent',v_policy.approval_max_percent,'approval_max_amount',v_policy.approval_max_amount);
end;
$$;

create or replace function public.set_operation_policy(p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := coalesce(nullif(p_policy->>'branch_id','')::uuid, public.current_branch_id());
  v_before public.operation_policies;
  v_after public.operation_policies;
  v_scope text := coalesce(nullif(p_policy->>'scope_type',''),'branch');
  v_role public.app_role := nullif(p_policy->>'scope_role','')::public.app_role;
  v_user uuid := nullif(p_policy->>'scope_user_id','')::uuid;
  v_name text;
begin
  if not public.branch_member_can(auth.uid(),v_branch,'manage_settings') then
    raise exception 'You may not change operation controls for this branch' using errcode='insufficient_privilege';
  end if;
  perform public.assert_known_capabilities(array[p_policy->>'permission_required']);
  if v_scope='user' and not exists(
    select 1 from public.branch_memberships m
     where m.user_id=v_user and m.branch_id=v_branch and m.active
  ) then
    raise exception 'A user-scoped policy requires an active branch member' using errcode='check_violation';
  end if;
  if nullif(p_policy->>'normal_max_percent','')::numeric
       > nullif(p_policy->>'approval_max_percent','')::numeric
     or nullif(p_policy->>'normal_max_amount','')::numeric
       > nullif(p_policy->>'approval_max_amount','')::numeric then
    raise exception 'Approval ceilings cannot be below normal ceilings' using errcode='check_violation';
  end if;
  if not coalesce((p_policy->>'allow_approval')::boolean,false)
     and (nullif(p_policy->>'approval_max_percent','') is not null
       or nullif(p_policy->>'approval_max_amount','') is not null
       or coalesce((p_policy->>'allow_permission_escalation')::boolean,false)) then
    raise exception 'Approval ceilings/escalation require allow_approval' using errcode='check_violation';
  end if;
  select * into v_before from public.operation_policies op
   where op.branch_id=v_branch and op.operation=p_policy->>'operation'
     and op.scope_type=v_scope
     and coalesce(op.scope_role::text,'')=coalesce(v_role::text,'')
     and coalesce(op.scope_user_id::text,'')=coalesce(v_user::text,'');
  if v_before.id is null then
    insert into public.operation_policies(
      branch_id,operation,scope_type,scope_role,scope_user_id,permission_required,
      enabled,allow_approval,allow_permission_escalation,
      normal_max_percent,normal_max_amount,approval_max_percent,approval_max_amount,updated_by
    ) values (
      v_branch,p_policy->>'operation',v_scope,v_role,v_user,p_policy->>'permission_required',
      coalesce((p_policy->>'enabled')::boolean,true),coalesce((p_policy->>'allow_approval')::boolean,false),
      coalesce((p_policy->>'allow_permission_escalation')::boolean,false),
      nullif(p_policy->>'normal_max_percent','')::numeric,nullif(p_policy->>'normal_max_amount','')::numeric,
      nullif(p_policy->>'approval_max_percent','')::numeric,nullif(p_policy->>'approval_max_amount','')::numeric,
      auth.uid()
    ) returning * into v_after;
  else
    update public.operation_policies set
      permission_required=p_policy->>'permission_required',
      enabled=coalesce((p_policy->>'enabled')::boolean,true),
      allow_approval=coalesce((p_policy->>'allow_approval')::boolean,false),
      allow_permission_escalation=coalesce((p_policy->>'allow_permission_escalation')::boolean,false),
      normal_max_percent=nullif(p_policy->>'normal_max_percent','')::numeric,
      normal_max_amount=nullif(p_policy->>'normal_max_amount','')::numeric,
      approval_max_percent=nullif(p_policy->>'approval_max_percent','')::numeric,
      approval_max_amount=nullif(p_policy->>'approval_max_amount','')::numeric,
      updated_by=auth.uid(),updated_at=now()
    where id=v_before.id returning * into v_after;
  end if;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    branch_id,module,correlation_id,before_state,after_state)
  values('operation_policy.updated','operation_policy',v_after.id::text,v_after.operation,'{}',
    auth.uid()::text,coalesce(v_name,'Staff'),v_branch,'approvals',extensions.gen_random_uuid()::text,
    case when v_before.id is null then null else to_jsonb(v_before)-array['updated_by','updated_at'] end,
    to_jsonb(v_after)-array['updated_by','updated_at']);
  return to_jsonb(v_after);
end;
$$;

insert into public.audit_actions(action,entity) values
  ('operation_policy.updated','operation_policy'),
  ('approval.verification_failed','approval_request'),
  ('manager_pin.changed','branch_membership'),
  ('cash.in','cash_movement'),
  ('cash.out','cash_movement')
on conflict(action) do nothing;

-- ── Manager credentials: hash only, not readable through PostgREST ─────────
create table if not exists public.manager_credentials(
  user_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  pin_hash text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  primary key(user_id,branch_id)
);
create table if not exists public.manager_pin_attempts(
  requester_id uuid not null,
  approver_id uuid not null,
  branch_id uuid not null,
  window_started timestamptz not null default now(),
  failed_count integer not null default 0,
  locked_until timestamptz,
  primary key(requester_id,approver_id,branch_id)
);
alter table public.manager_credentials enable row level security;
alter table public.manager_pin_attempts enable row level security;
revoke all on public.manager_credentials,public.manager_pin_attempts from public,anon,authenticated;

create or replace function public.set_manager_pin(
  p_user_id uuid, p_branch_id uuid, p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_name text; v_target text;
begin
  if p_pin !~ '^[0-9]{4,12}$' then
    raise exception 'Manager PIN must contain 4 to 12 digits' using errcode='check_violation';
  end if;
  if p_user_id <> auth.uid() then
    if not public.branch_member_can(auth.uid(),p_branch_id,'manage_users') then
      raise exception 'You may not reset this manager credential' using errcode='insufficient_privilege';
    end if;
  elsif not public.branch_member_can(auth.uid(),p_branch_id,'approve_limit_request') then
    raise exception 'Only a branch approver may set an approval PIN' using errcode='insufficient_privilege';
  end if;
  if not public.branch_member_can(p_user_id,p_branch_id,'approve_limit_request') then
    raise exception 'This user is not an approver at the branch' using errcode='check_violation';
  end if;
  insert into public.manager_credentials(user_id,branch_id,pin_hash,changed_by)
  values(p_user_id,p_branch_id,extensions.crypt(p_pin,extensions.gen_salt('bf',10)),auth.uid())
  on conflict(user_id,branch_id) do update set pin_hash=excluded.pin_hash,changed_at=now(),changed_by=auth.uid();
  delete from public.manager_pin_attempts where approver_id=p_user_id and branch_id=p_branch_id;
  select name into v_name from public.profiles where id=auth.uid();
  select name into v_target from public.profiles where id=p_user_id;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
  values('manager_pin.changed','branch_membership',p_user_id::text,coalesce(v_target,p_user_id::text),
    jsonb_build_object('target_user_id',p_user_id),auth.uid()::text,coalesce(v_name,'Staff'),p_branch_id,'approvals');
  return jsonb_build_object('ok',true,'user_id',p_user_id,'branch_id',p_branch_id);
end;
$$;

-- Approval evidence extensions. Secrets are never stored here.
alter table public.approval_requests
  add column if not exists operation_type text,
  add column if not exists operation_fingerprint text,
  add column if not exists correlation_id uuid default extensions.gen_random_uuid(),
  add column if not exists expires_at timestamptz,
  add column if not exists consumed_at timestamptz,
  add column if not exists approver_user_id uuid,
  add column if not exists approver_branch_id uuid references public.branches(id) on delete restrict;
create unique index if not exists approval_requests_correlation_key on public.approval_requests(correlation_id);
create index if not exists approval_requests_expiry_idx on public.approval_requests(expires_at) where result_entity_id is null;

-- Preserve the original append-only request invariant while allowing the one
-- PIN-verification function to stamp a distinct approver without impersonating
-- that manager. The transaction-local marker is useless to direct callers: RLS
-- grants no approval_requests UPDATE, and the trigger also binds request+manager.
create or replace function public.enforce_approval_request_invariants()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_uid text:=auth.uid()::text;
  v_name text;
  v_inline text;
  v_inline_expected text;
begin
  if tg_op='DELETE' then
    raise exception 'An approval request cannot be deleted; it is the record of a decision' using errcode='insufficient_privilege';
  end if;
  if tg_op='UPDATE' then
    if new.amount is distinct from old.amount or new.limit_value is distinct from old.limit_value
       or new.previous_value is distinct from old.previous_value or new.new_value is distinct from old.new_value
       or new.payload is distinct from old.payload or new.kind is distinct from old.kind
       or new.requested_by is distinct from old.requested_by or new.request_number is distinct from old.request_number
       or new.branch_id is distinct from old.branch_id or new.operation_type is distinct from old.operation_type
       or new.operation_fingerprint is distinct from old.operation_fingerprint
       or new.correlation_id is distinct from old.correlation_id or new.expires_at is distinct from old.expires_at then
      raise exception 'An approval request cannot be rewritten; the ask is fixed' using errcode='check_violation';
    end if;
    if new.status is distinct from old.status then
      if old.status<>'pending' then raise exception 'This request was already %',old.status using errcode='check_violation'; end if;
      if new.status='cancelled' then
        if coalesce(v_uid,'')<>old.requested_by and not public.can('approve_limit_request') then
          raise exception 'Only the requester may withdraw a request' using errcode='insufficient_privilege';
        end if;
        new.decided_at:=coalesce(new.decided_at,now());
        new.decided_by:=coalesce(new.decided_by,v_uid,old.requested_by);
        if new.decided_by_name is null then
          select name into v_name from public.profiles where id=auth.uid();
          new.decided_by_name:=coalesce(v_name,old.requested_by_name);
        end if;
        return new;
      end if;
      v_inline:=current_setting('alyq.manager_approval',true);
      v_inline_expected:=old.id::text||':'||coalesce(new.approver_user_id::text,'');
      if not public.can('approve_limit_request') and v_inline is distinct from v_inline_expected then
        raise exception 'Your role cannot decide an approval request' using errcode='insufficient_privilege';
      end if;
      if new.status='rejected' and nullif(btrim(coalesce(new.decision_note,'')),'') is null then
        raise exception 'A rejected request needs a note saying why' using errcode='check_violation';
      end if;
      new.decided_at:=coalesce(new.decided_at,now());
      if v_inline=v_inline_expected then
        new.decided_by:=new.approver_user_id::text;
        select name into v_name from public.profiles where id=new.approver_user_id;
        new.decided_by_name:=v_name;
      elsif v_uid is not null then
        new.decided_by:=v_uid;
        select name into v_name from public.profiles where id=auth.uid();
        new.decided_by_name:=coalesce(v_name,new.decided_by_name);
      end if;
    end if;
    return new;
  end if;
  new.requested_at:=coalesce(new.requested_at,now());
  if v_uid is not null then
    new.requested_by:=v_uid;
    select name into v_name from public.profiles where id=auth.uid();
    new.requested_by_name:=coalesce(v_name,new.requested_by_name);
  end if;
  return new;
end;
$$;

create or replace function public.operation_fingerprint(
  p_operation text,p_branch_id uuid,p_target text,p_percent numeric,p_amount numeric,p_payload jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(extensions.digest(
    concat_ws('|',p_operation,coalesce(p_branch_id::text,''),coalesce(p_target,''),
      coalesce(round(p_percent,4)::text,''),coalesce(round(p_amount,2)::text,''),
      coalesce(jsonb_strip_nulls(coalesce(p_payload,'{}') - 'approval_request_id')::text,'{}')),
    'sha256'),'hex')
$$;

-- Restate request submission to bind payload + branch and give every request a
-- short validity window. Existing callers keep the same JSON contract.
create or replace function public.submit_approval_request(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind public.approval_request_kind;
  v_number text; v_id uuid; v_uid uuid:=auth.uid(); v_name text; v_reason text;
  v_branch uuid:=public.current_branch_id(); v_operation text; v_target text;
  v_amount numeric:=coalesce((p_request->>'amount')::numeric,0);
  v_percent numeric;
  v_payload jsonb:=coalesce(public.audit_sanitize(p_request->'payload'),'{}');
  v_previous jsonb:=coalesce(public.audit_sanitize(p_request->'previous_value'),'{}');
  v_new jsonb:=coalesce(public.audit_sanitize(p_request->'new_value'),'{}');
  v_fingerprint text;
begin
  if v_uid is null or v_branch is null then raise exception 'An active branch session is required' using errcode='insufficient_privilege'; end if;
  begin v_kind:=(p_request->>'kind')::public.approval_request_kind;
  exception when others then raise exception 'Unknown approval request kind' using errcode='check_violation'; end;
  v_reason:=btrim(coalesce(p_request->>'reason',''));
  if v_reason='' then raise exception 'An approval request needs a reason' using errcode='check_violation'; end if;
  v_operation:=coalesce(nullif(p_request->>'operation_type',''),case v_kind::text
    when 'discount' then 'sale_discount' when 'price_change' then 'price_override'
    else v_kind::text end);
  if v_operation not in ('sale_discount','refund','expense','price_override','void','cash_out','selective_cleanup')
     or v_amount<0
     or (v_kind::text='discount' and v_operation<>'sale_discount')
     or (v_kind::text='refund' and v_operation<>'refund')
     or (v_kind::text='price_change' and v_operation<>'price_override')
     or (v_kind::text='expense' and v_operation not in ('expense','cash_out','void','selective_cleanup')) then
    raise exception 'Unsupported approval operation or value' using errcode='check_violation';
  end if;
  v_target:=coalesce(
    case v_kind::text
      when 'discount' then nullif(v_payload->>'client_ref','')
      when 'price_change' then nullif(v_payload->>'product_id','')
      when 'refund' then coalesce(nullif(v_payload->>'refund_id',''),nullif(v_payload->>'sale_id',''))
      else null
    end,
    nullif(p_request->>'entity_id',''),nullif(p_request->>'entity_label',''),v_kind::text);
  if v_kind::text='discount' then v_percent:=v_amount; end if;
  v_fingerprint:=public.operation_fingerprint(v_operation,v_branch,v_target,v_percent,
    case when v_percent is null then v_amount else null end,v_payload);
  select name into v_name from public.profiles where id=v_uid;
  update public.approval_counters set next_value=next_value+1 where id=1
    returning 'APR-'||lpad((next_value-1)::text,6,'0') into v_number;
  insert into public.approval_requests(
    request_number,kind,entity_type,entity_id,entity_label,branch,branch_id,
    amount,limit_value,previous_value,new_value,payload,reason,requested_by,requested_by_name,
    operation_type,operation_fingerprint,expires_at
  ) values(
    v_number,v_kind,coalesce(nullif(btrim(p_request->>'entity_type'),''),v_kind::text),
    coalesce(p_request->>'entity_id',''),coalesce(nullif(btrim(p_request->>'entity_label'),''),v_number),
    (select name_en from public.branches where id=v_branch),v_branch,v_amount,
    (p_request->>'limit_value')::numeric,v_previous,
    v_new,v_payload,v_reason,v_uid::text,coalesce(v_name,'Staff'),
    v_operation,v_fingerprint,now()+interval '5 minutes'
  ) returning id into v_id;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    branch_id,module,correlation_id,reason)
  values('approval.requested','approval_request',v_id::text,v_number,
    jsonb_build_object('kind',v_kind,'operation',v_operation,'amount',v_amount,'target',v_target),
    v_uid::text,coalesce(v_name,'Staff'),v_branch,'approvals',
    (select correlation_id::text from public.approval_requests where id=v_id),v_reason);
  return jsonb_build_object('request_id',v_id,'request_number',v_number,'status','pending','expires_at',now()+interval '5 minutes');
end;
$$;

create or replace function public.approval_request_matches(
  p_request_id uuid,p_operation text,p_target text,p_percent numeric,p_amount numeric,p_payload jsonb
)
returns public.approval_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_request public.approval_requests; v_expected text;
begin
  select * into v_request from public.approval_requests where id=p_request_id for update;
  if v_request.id is null then raise exception 'Approval request not found' using errcode='no_data_found'; end if;
  if v_request.status<>'approved' then raise exception 'Approval is not approved' using errcode='insufficient_privilege'; end if;
  if v_request.requested_by<>auth.uid()::text then raise exception 'Approval belongs to another actor' using errcode='insufficient_privilege'; end if;
  if v_request.branch_id<>public.current_branch_id() then raise exception 'Approval belongs to another branch' using errcode='insufficient_privilege'; end if;
  if v_request.expires_at is null or v_request.expires_at<=now() then raise exception 'Approval expired' using errcode='insufficient_privilege'; end if;
  if v_request.result_entity_id is not null or v_request.consumed_at is not null then raise exception 'Approval already used' using errcode='check_violation'; end if;
  v_expected:=public.operation_fingerprint(p_operation,v_request.branch_id,p_target,p_percent,p_amount,p_payload);
  if v_request.operation_type is distinct from p_operation or v_request.operation_fingerprint is distinct from v_expected then
    raise exception 'Approval does not match this operation' using errcode='insufficient_privilege';
  end if;
  return v_request;
end;
$$;

-- One authority test shared by PIN approval and the signed-in approval inbox.
-- It checks the requester's explicit escalation policy as well as the
-- approver's same-branch operation permission and configured ceiling.
create or replace function public.approver_has_authority(
  p_request_id uuid,p_approver_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_request public.approval_requests;
  v_requester uuid;
  v_operation text;
  v_requester_policy public.operation_policies;
  v_approver_policy public.operation_policies;
  v_percent numeric;
  v_amount numeric;
begin
  select * into v_request from public.approval_requests where id=p_request_id;
  if v_request.id is null or v_request.requested_by !~
     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  v_requester:=v_request.requested_by::uuid;
  if p_approver_id=v_requester
     or not public.branch_member_can(p_approver_id,v_request.branch_id,'approve_limit_request') then
    return false;
  end if;
  if v_request.operation_type='expense' then
    return public.branch_member_can(v_requester,v_request.branch_id,'add_expense')
       and public.branch_member_can(p_approver_id,v_request.branch_id,'add_expense');
  end if;
  v_operation:=case v_request.operation_type
    when 'sale_discount' then 'invoice_discount'
    else v_request.operation_type end;
  if v_operation not in ('invoice_discount','price_override','void','refund','cash_out','selective_cleanup') then
    return false;
  end if;
  if v_request.operation_type='sale_discount' then v_percent:=v_request.amount;
  else v_amount:=v_request.amount; end if;

  select * into v_requester_policy from public.operation_policy_for(v_operation,v_requester,v_request.branch_id);
  select * into v_approver_policy from public.operation_policy_for(v_operation,p_approver_id,v_request.branch_id);
  if v_requester_policy.id is null or not v_requester_policy.enabled or not v_requester_policy.allow_approval
     or (not public.branch_member_can(v_requester,v_request.branch_id,v_requester_policy.permission_required)
         and not v_requester_policy.allow_permission_escalation)
     or (v_percent is not null and v_requester_policy.approval_max_percent is not null
         and v_percent>v_requester_policy.approval_max_percent)
     or (v_amount is not null and v_requester_policy.approval_max_amount is not null
         and v_amount>v_requester_policy.approval_max_amount) then
    return false;
  end if;
  if v_approver_policy.id is null or not v_approver_policy.enabled
     or not public.branch_member_can(p_approver_id,v_request.branch_id,v_approver_policy.permission_required)
     or (v_percent is not null and v_approver_policy.approval_max_percent is not null
         and v_percent>v_approver_policy.approval_max_percent)
     or (v_amount is not null and v_approver_policy.approval_max_amount is not null
         and v_amount>v_approver_policy.approval_max_amount) then
    return false;
  end if;
  return true;
end;
$$;

-- Inline manager verification. Wrong PIN returns {ok:false}; raising would roll
-- back the rate-limit/audit evidence. No response ever contains a PIN or hash.
create or replace function public.approve_with_manager_pin(
  p_request_id uuid,p_manager_username text,p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests; v_manager public.profiles; v_cred public.manager_credentials;
  v_attempt public.manager_pin_attempts; v_policy public.operation_policies;
  v_name text; v_ok boolean:=false; v_percent numeric; v_amount numeric;
begin
  select * into v_request from public.approval_requests where id=p_request_id for update;
  if v_request.id is null or v_request.requested_by<>auth.uid()::text or v_request.status<>'pending' then
    return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
  end if;
  if v_request.expires_at<=now() then return jsonb_build_object('ok',false,'code','EXPIRED'); end if;
  select * into v_manager from public.profiles
   where lower(btrim(username))=lower(btrim(p_manager_username)) and active;
  if v_manager.id is null or v_manager.id=auth.uid() then
    return jsonb_build_object('ok',false,'code','INVALID_APPROVER');
  end if;
  if not public.branch_member_can(v_manager.id,v_request.branch_id,'approve_limit_request') then
    return jsonb_build_object('ok',false,'code','INVALID_APPROVER');
  end if;
  select * into v_attempt from public.manager_pin_attempts
   where requester_id=auth.uid() and approver_id=v_manager.id and branch_id=v_request.branch_id;
  if v_attempt.locked_until>now() then return jsonb_build_object('ok',false,'code','RATE_LIMITED'); end if;
  select * into v_cred from public.manager_credentials
   where user_id=v_manager.id and branch_id=v_request.branch_id;
  v_ok:=v_cred.pin_hash is not null and extensions.crypt(coalesce(p_pin,''),v_cred.pin_hash)=v_cred.pin_hash;
  if not v_ok then
    insert into public.manager_pin_attempts(requester_id,approver_id,branch_id,window_started,failed_count,locked_until)
    values(auth.uid(),v_manager.id,v_request.branch_id,now(),1,null)
    on conflict(requester_id,approver_id,branch_id) do update set
      window_started=case when manager_pin_attempts.window_started<now()-interval '15 minutes' then now() else manager_pin_attempts.window_started end,
      failed_count=case when manager_pin_attempts.window_started<now()-interval '15 minutes' then 1 else manager_pin_attempts.failed_count+1 end,
      locked_until=case when (case when manager_pin_attempts.window_started<now()-interval '15 minutes' then 1 else manager_pin_attempts.failed_count+1 end)>=5
                        then now()+interval '15 minutes' else manager_pin_attempts.locked_until end;
    select name into v_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
      branch_id,module,correlation_id,reason)
    values('approval.verification_failed','approval_request',v_request.id::text,v_request.request_number,
      jsonb_build_object('manager_user_id',v_manager.id,'code','INVALID_PIN'),auth.uid()::text,
      coalesce(v_name,'Staff'),v_request.branch_id,'approvals',v_request.correlation_id::text,'Invalid manager credential');
    return jsonb_build_object('ok',false,'code','INVALID_CREDENTIALS');
  end if;
  delete from public.manager_pin_attempts where requester_id=auth.uid() and approver_id=v_manager.id and branch_id=v_request.branch_id;

  if not public.approver_has_authority(v_request.id,v_manager.id) then
    return jsonb_build_object('ok',false,'code','INSUFFICIENT_AUTHORITY');
  end if;
  perform set_config('alyq.manager_approval',v_request.id::text||':'||v_manager.id::text,true);
  update public.approval_requests set status='approved',decided_by=v_manager.id::text,
    decided_by_name=v_manager.name,decided_at=now(),approver_user_id=v_manager.id,
    approver_branch_id=v_request.branch_id
   where id=v_request.id and status='pending';
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id,reason)
  values('approval.approved','approval_request',v_request.id::text,v_request.request_number,
    jsonb_build_object('kind',v_request.kind,'operation',v_request.operation_type,'amount',v_request.amount),
    auth.uid()::text,coalesce(v_name,'Staff'),v_manager.id::text,v_manager.name,
    v_request.branch_id,'approvals',v_request.correlation_id::text,v_request.reason);
  return jsonb_build_object('ok',true,'request_id',v_request.id,'status','approved',
    'approver_name',v_manager.name,'expires_at',v_request.expires_at);
end;
$$;

-- Logged-in inbox decisions are also branch-bound and authority-checked.
create or replace function public.decide_approval_request(
  p_request_id uuid,p_decision text,p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_request public.approval_requests; v_name text; v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
  select * into v_request from public.approval_requests where id=p_request_id for update;
  if v_request.id is null then raise exception 'Approval request not found' using errcode='no_data_found'; end if;
  if v_request.branch_id<>public.current_branch_id() then raise exception 'Wrong branch' using errcode='insufficient_privilege'; end if;
  if not public.can('approve_limit_request') then raise exception 'Not permitted to decide approvals' using errcode='insufficient_privilege'; end if;
  if v_request.status<>'pending' then raise exception 'Request already decided' using errcode='check_violation'; end if;
  if p_decision not in ('approved','rejected','cancelled') then raise exception 'Invalid decision' using errcode='check_violation'; end if;
  if v_request.expires_at is null or v_request.expires_at<=now() then
    raise exception 'Request expired' using errcode='insufficient_privilege';
  end if;
  if p_decision='approved' and not public.approver_has_authority(v_request.id,auth.uid()) then
    raise exception 'Approver lacks sufficient operation authority' using errcode='insufficient_privilege';
  end if;
  if p_decision='rejected' and v_note is null then raise exception 'A rejection needs a note' using errcode='check_violation'; end if;
  select name into v_name from public.profiles where id=auth.uid();
  update public.approval_requests set status=p_decision::public.approval_request_status,
    decided_by=auth.uid()::text,decided_by_name=coalesce(v_name,'Staff'),decided_at=now(),decision_note=v_note,
    approver_user_id=case when p_decision='approved' then auth.uid() else null end,
    approver_branch_id=case when p_decision='approved' then v_request.branch_id else null end
   where id=p_request_id;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id,reason)
  values(case p_decision when 'approved' then 'approval.approved' when 'rejected' then 'approval.rejected' else 'approval.cancelled' end,
    'approval_request',p_request_id::text,v_request.request_number,
    jsonb_build_object('kind',v_request.kind,'operation',v_request.operation_type,'amount',v_request.amount,'note',v_note),
    auth.uid()::text,coalesce(v_name,'Staff'),case when p_decision='approved' then auth.uid()::text else null end,
    case when p_decision='approved' then coalesce(v_name,'Staff') else null end,v_request.branch_id,'approvals',
    v_request.correlation_id::text,coalesce(v_note,v_request.reason));
  return jsonb_build_object('request_id',p_request_id,'status',p_decision,'already_decided',false);
end;
$$;

-- Consume once. Restates the existing function with requester/branch/expiry checks.
create or replace function public.mark_approval_applied(p_request_id uuid,p_entity_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_request public.approval_requests; v_name text;
begin
  select * into v_request from public.approval_requests where id=p_request_id for update;
  if v_request.id is null then raise exception 'Approval request not found' using errcode='no_data_found'; end if;
  if v_request.status<>'approved' or v_request.requested_by<>auth.uid()::text
     or v_request.branch_id<>public.current_branch_id() or v_request.expires_at<=now() then
    raise exception 'Approval is not applicable to this actor/branch/time' using errcode='insufficient_privilege';
  end if;
  if v_request.result_entity_id is not null or v_request.consumed_at is not null then
    return jsonb_build_object('request_id',v_request.id,'result_entity_id',v_request.result_entity_id,'already_applied',true);
  end if;
  if nullif(btrim(coalesce(p_entity_id,'')),'') is null then raise exception 'A result id is required' using errcode='check_violation'; end if;
  update public.approval_requests set result_entity_id=btrim(p_entity_id),consumed_at=now(),
    entity_id=case when btrim(entity_id)='' then btrim(p_entity_id) else entity_id end where id=p_request_id;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id)
  values('approval.applied','approval_request',v_request.id::text,v_request.request_number,
    jsonb_build_object('operation',v_request.operation_type,'result',btrim(p_entity_id)),auth.uid()::text,
    coalesce(v_name,'Staff'),v_request.decided_by,v_request.decided_by_name,v_request.branch_id,'approvals',v_request.correlation_id::text);
  return jsonb_build_object('request_id',v_request.id,'result_entity_id',btrim(p_entity_id),'already_applied',false);
end;
$$;

-- Compatibility verifier used inside the existing sale/refund/price funnels.
-- It now refuses cross-branch, expired and consumed decisions and keeps exact
-- field matching for trigger-driven price changes.
create or replace function public.approval_assert_satisfied(
  p_kind text,p_value numeric,p_request_id uuid,p_match jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path=public
as $$
declare v_request public.approval_requests; v_key text; v_operation text;
begin
  v_operation:=case p_kind when 'discount' then 'sale_discount' when 'price_change' then 'price_override' else p_kind end;
  if auth.uid() is null then raise exception 'Signed-in identity required' using errcode='insufficient_privilege'; end if;
  if p_request_id is not null then
    select * into v_request from public.approval_requests where id=p_request_id for update;
  else
    select * into v_request from public.approval_requests r
     where r.kind::text=p_kind and r.operation_type=v_operation and r.status='approved'
       and r.result_entity_id is null and r.consumed_at is null
       and r.requested_by=auth.uid()::text and r.branch_id=public.current_branch_id()
       and r.expires_at>now() and r.amount=round(coalesce(p_value,0),2)
     order by r.requested_at limit 1 for update;
  end if;
  if v_request.id is null then raise exception 'No exact active approval for this operation' using errcode='insufficient_privilege'; end if;
  if v_request.status<>'approved' or v_request.kind::text<>p_kind or v_request.operation_type<>v_operation
     or v_request.requested_by<>auth.uid()::text or v_request.branch_id<>public.current_branch_id()
     or v_request.expires_at<=now() then
    raise exception 'Approval is not applicable to this actor, branch, operation or time' using errcode='insufficient_privilege';
  end if;
  if v_request.result_entity_id is not null or v_request.consumed_at is not null then
    raise exception 'Approval already used' using errcode='check_violation';
  end if;
  if round(v_request.amount,2)<>round(coalesce(p_value,0),2) then
    raise exception 'Approval value does not exactly match this operation' using errcode='check_violation';
  end if;
  for v_key in select * from jsonb_object_keys(coalesce(p_match,'{}')) loop
    if (case when v_key='product_id' then v_request.entity_id else v_request.new_value->>v_key end)
       is distinct from p_match->>v_key then
      raise exception 'Approval field % does not match',v_key using errcode='check_violation';
    end if;
  end loop;
  if p_kind='price_change' and v_request.entity_id<>coalesce(nullif(v_request.payload->>'product_id',''),v_request.entity_id) then
    raise exception 'Approval target does not match' using errcode='check_violation';
  end if;
  return v_request.id;
end;
$$;
revoke execute on function public.approval_assert_satisfied(text,numeric,uuid,jsonb) from public,anon,authenticated;

create or replace function public.enforce_price_authority()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_approval uuid; v_match jsonb:=jsonb_build_object('product_id',new.id);
begin
  if coalesce(nullif(current_setting('role',true),''),'postgres')<>'authenticated' then return new; end if;
  if new.selling_price is distinct from old.selling_price and not public.can('change_price') then
    raise exception 'Changing a selling price requires the change_price capability' using errcode='insufficient_privilege';
  end if;
  if new.cost_price is distinct from old.cost_price and not public.can('change_cost') then
    raise exception 'Changing a cost price requires the change_cost capability' using errcode='insufficient_privilege';
  end if;
  if (new.selling_price is distinct from old.selling_price or new.cost_price is distinct from old.cost_price)
     and public.approval_required_for('price_change',new.selling_price) then
    if new.selling_price is distinct from old.selling_price then v_match:=v_match||jsonb_build_object('selling_price',new.selling_price); end if;
    if new.cost_price is distinct from old.cost_price then v_match:=v_match||jsonb_build_object('cost_price',new.cost_price); end if;
    v_approval:=public.approval_assert_satisfied('price_change',new.selling_price,null,v_match);
    perform public.mark_approval_applied(v_approval,new.id::text);
  end if;
  return new;
end;
$$;

-- Legacy authority oracle now delegates to configurable branch policies.
create or replace function public.approval_required_for(p_kind text,p_value numeric)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare v_decision jsonb; v_operation text;
begin
  if p_kind='discount' then
    -- A zero discount is not an operation. Returning before the permission
    -- decision keeps ordinary full-price sales usable by till staff while every
    -- positive discount still requires either authority or explicit escalation.
    if coalesce(p_value,0) <= 0 then return false; end if;
    v_operation:='invoice_discount';
  elsif p_kind='refund' then v_operation:='refund';
  elsif p_kind='price_change' then v_operation:='price_override';
  elsif p_kind='expense' then
    -- Existing expenses retain their configured legacy rule. Drawer Cash Out is
    -- a distinct operation and is enforced by record_cash_movement().
    return exists(select 1 from public.approval_rules r where r.id=1 and r.expense_limit_enabled and p_value>r.expense_limit_amount)
      and not public.can('approve_limit_request');
  else raise exception 'Unknown approval kind' using errcode='check_violation'; end if;
  v_decision:=case when p_kind='discount'
    then public.operation_decision(v_operation,p_value,null)
    else public.operation_decision(v_operation,null,p_value) end;
  if v_decision->>'decision'='forbidden' then raise exception 'Operation exceeds configured authority' using errcode='insufficient_privilege'; end if;
  return v_decision->>'decision'='approval';
end;
$$;

-- Exact sale-discount authorization wrapper around the battle-tested pricing RPC.
do $$ begin
  if to_regprocedure('public.pos_complete_sale_core_0072(jsonb,uuid)') is null
     and to_regprocedure('public.pos_complete_sale(jsonb,uuid)') is not null then
    alter function public.pos_complete_sale(jsonb,uuid) rename to pos_complete_sale_core_0072;
  end if;
end $$;
revoke all on function public.pos_complete_sale_core_0072(jsonb,uuid) from public,anon,authenticated;

create or replace function public.pos_complete_sale(p_payload jsonb,p_approval_request_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_line jsonb; v_item_percent numeric; v_item_amount numeric; v_invoice_percent numeric; v_invoice_amount numeric;
  v_decision jsonb; v_needs boolean:=false; v_target text:=coalesce(p_payload->>'client_ref','sale');
  v_request public.approval_requests; v_result jsonb; v_overall numeric:=0;
begin
  if exists(select 1 from public.sales s where s.client_ref=p_payload->>'client_ref' and s.branch_id<>public.current_branch_id()) then
    raise exception 'Sale reference belongs to another branch' using errcode='insufficient_privilege';
  end if;
  if coalesce(p_payload->>'discount_type','none')='percent' then v_invoice_percent:=coalesce((p_payload->>'discount_value')::numeric,0);
  elsif coalesce(p_payload->>'discount_type','none')='fixed' then v_invoice_amount:=coalesce((p_payload->>'discount_value')::numeric,0); end if;
  if coalesce(v_invoice_percent,0)>0 or coalesce(v_invoice_amount,0)>0 then
    v_decision:=public.operation_decision('invoice_discount',v_invoice_percent,v_invoice_amount);
    if v_decision->>'decision'='forbidden' then raise exception 'Invoice discount exceeds configured authority' using errcode='insufficient_privilege'; end if;
    v_needs:=v_needs or v_decision->>'decision'='approval';
    v_overall:=greatest(v_overall,coalesce(v_invoice_percent,0));
  end if;
  for v_line in select * from jsonb_array_elements(coalesce(p_payload->'lines','[]')) loop
    v_item_percent:=null; v_item_amount:=null;
    if coalesce(v_line->>'discount_type','none')='percent' then v_item_percent:=coalesce((v_line->>'discount_value')::numeric,0);
    elsif coalesce(v_line->>'discount_type','none')='fixed' then v_item_amount:=coalesce((v_line->>'discount_value')::numeric,0); end if;
    if coalesce(v_item_percent,0)>0 or coalesce(v_item_amount,0)>0 then
      v_decision:=public.operation_decision('item_discount',v_item_percent,v_item_amount);
      if v_decision->>'decision'='forbidden' then raise exception 'Item discount exceeds configured authority' using errcode='insufficient_privilege'; end if;
      v_needs:=v_needs or v_decision->>'decision'='approval';
      v_overall:=greatest(v_overall,coalesce(v_item_percent,0));
    end if;
  end loop;
  if v_needs then
    if p_approval_request_id is null then raise exception 'Manager approval required' using errcode='insufficient_privilege'; end if;
    select * into v_request from public.approval_requests where id=p_approval_request_id;
    select * into v_request from public.approval_request_matches(
      p_approval_request_id,'sale_discount',v_target,v_request.amount,null,p_payload);
  end if;
  v_result:=public.pos_complete_sale_core_0072(p_payload,p_approval_request_id);
  if v_needs then perform public.mark_approval_applied(p_approval_request_id,v_result->>'sale_id'); end if;
  return v_result;
end;
$$;

-- Return wrapper binds the approval to the exact sale/items/refund method. The
-- existing core still computes the authoritative refund amount and asks the
-- configurable oracle above whether it needs approval.
do $$ begin
  if to_regprocedure('public.pos_process_return_core_0072(jsonb)') is null
     and to_regprocedure('public.pos_process_return(jsonb)') is not null then
    alter function public.pos_process_return(jsonb) rename to pos_process_return_core_0072;
  end if;
end $$;
revoke all on function public.pos_process_return_core_0072(jsonb) from public,anon,authenticated;
create or replace function public.pos_process_return(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_id uuid:=nullif(p_payload->>'approval_request_id','')::uuid; v_request public.approval_requests; v_result jsonb;
begin
  if not exists(select 1 from public.sales where id=nullif(p_payload->>'sale_id','')::uuid and branch_id=public.current_branch_id()) then
    raise exception 'Sale not found in active branch' using errcode='no_data_found';
  end if;
  if v_id is not null then
    select * into v_request from public.approval_requests where id=v_id;
    if v_request.id is null or v_request.operation_fingerprint is distinct from
      public.operation_fingerprint('refund',public.current_branch_id(),p_payload->>'sale_id',null,v_request.amount,p_payload) then
      raise exception 'Approval does not match this refund' using errcode='insufficient_privilege';
    end if;
  end if;
  v_result:=public.pos_process_return_core_0072(p_payload);
  return v_result;
end;
$$;

-- Void wrapper: permission-only by default; policy may require a distinct exact approval.
do $$ begin
  if to_regprocedure('public.pos_void_sale_core_0072(uuid,text,text,text)') is null
     and to_regprocedure('public.pos_void_sale(uuid,text,text,text)') is not null then
    alter function public.pos_void_sale(uuid,text,text,text) rename to pos_void_sale_core_0072;
  elsif to_regprocedure('public.pos_void_sale_core_0072(uuid,text,text,text)') is not null
     and to_regprocedure('public.pos_void_sale(uuid,text,text,text)') is not null then
    -- Earlier idempotency-pass migrations recreate the legacy overload. The
    -- five-argument wrapper below already preserves four-argument callers via
    -- defaults, so retaining both would make calls with NULL/text literals
    -- ambiguous.
    drop function public.pos_void_sale(uuid,text,text,text);
  end if;
end $$;
revoke all on function public.pos_void_sale_core_0072(uuid,text,text,text) from public,anon,authenticated;
create or replace function public.pos_void_sale(
  p_sale_id uuid,p_user_id text,p_user_name text,p_reason text default null,p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_sale public.sales; v_decision jsonb; v_request public.approval_requests; v_result jsonb; v_payload jsonb;
begin
  select * into v_sale from public.sales where id=p_sale_id;
  if v_sale.id is null or v_sale.branch_id<>public.current_branch_id() then raise exception 'Sale not found' using errcode='no_data_found'; end if;
  v_decision:=public.operation_decision('void',null,v_sale.total);
  if v_decision->>'decision'='forbidden' then raise exception 'Void exceeds configured authority' using errcode='insufficient_privilege'; end if;
  v_payload:=jsonb_build_object('sale_id',p_sale_id,'reason',p_reason);
  if v_decision->>'decision'='approval' then
    if p_approval_request_id is null then raise exception 'Manager approval required' using errcode='insufficient_privilege'; end if;
    select * into v_request from public.approval_request_matches(p_approval_request_id,'void',p_sale_id::text,null,v_sale.total,v_payload);
  end if;
  v_result:=public.pos_void_sale_core_0072(p_sale_id,p_user_id,p_user_name,p_reason);
  if v_decision->>'decision'='approval' then perform public.mark_approval_applied(p_approval_request_id,p_sale_id::text); end if;
  return v_result;
end;
$$;

-- A completed refund is a drawer event at settlement time, which may be in a
-- later shift than the original sale. Persist that authoritative shift instead
-- of inferring it from the sale and thereby losing cross-shift cash refunds.
alter table public.refund_records
  add column if not exists settlement_shift_id uuid references public.shifts(id) on delete restrict;
create index if not exists refund_records_settlement_shift_idx
  on public.refund_records(settlement_shift_id,settled_at) where settlement_shift_id is not null;
create or replace function public.stamp_refund_settlement_shift()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_shift uuid; v_branch uuid:=public.current_branch_id();
begin
  if tg_op='UPDATE' then
    if old.status='completed' then
      new.settlement_shift_id:=old.settlement_shift_id;
      return new;
    end if;
    if new.status<>'completed' then
      new.settlement_shift_id:=old.settlement_shift_id;
      return new;
    end if;
  elsif new.status<>'completed' then
    new.settlement_shift_id:=null;
    return new;
  end if;
  select id into v_shift from public.shifts
   where branch_id=v_branch and status='open' for update;
  if v_shift is null and new.payment_method='cash' then
    raise exception 'A completed cash refund requires an open branch shift' using errcode='no_data_found';
  end if;
  new.settlement_shift_id:=v_shift;
  return new;
end;
$$;
drop trigger if exists refund_records_stamp_settlement_shift on public.refund_records;
create trigger refund_records_stamp_settlement_shift
  before insert or update of status on public.refund_records
  for each row execute function public.stamp_refund_settlement_shift();

-- ── Drawer cash movements ─────────────────────────────────────────────────
do $$ begin
  create type public.cash_movement_kind as enum('cash_in','cash_out');
exception when duplicate_object then null; end $$;
create sequence if not exists public.cash_movement_number_seq start 1;
create or replace function public.next_cash_movement_number() returns text language sql volatile
as $$ select 'CM-'||lpad(nextval('public.cash_movement_number_seq')::text,6,'0') $$;
create table if not exists public.cash_movements(
  id uuid primary key default extensions.gen_random_uuid(),
  movement_number text not null unique default public.next_cash_movement_number(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  kind public.cash_movement_kind not null,
  amount numeric(14,2) not null check(amount>0 and amount<=10000000),
  reason text not null check(char_length(btrim(reason)) between 1 and 120),
  note text check(note is null or char_length(note)<=400),
  user_id uuid not null references public.profiles(id) on delete restrict,
  user_name text not null,
  approver_id uuid references public.profiles(id) on delete restrict,
  approver_name text,
  approval_request_id uuid references public.approval_requests(id) on delete restrict,
  correlation_id uuid not null default extensions.gen_random_uuid(),
  created_at timestamptz not null default now(),
  constraint cash_movement_approval_complete check(
    (approver_id is null and approver_name is null and approval_request_id is null)
    or (approver_id is not null and approver_name is not null and approval_request_id is not null))
);
create index if not exists cash_movements_shift_idx on public.cash_movements(shift_id,created_at);
create index if not exists cash_movements_branch_idx on public.cash_movements(branch_id,created_at desc);
alter table public.cash_movements enable row level security;
drop policy if exists cash_movements_select on public.cash_movements;
create policy cash_movements_select on public.cash_movements for select to authenticated
  using(branch_id=public.current_branch_id() and public.can('view_shifts'));
revoke all on public.cash_movements from anon;
grant select on public.cash_movements to authenticated;
grant usage,select on sequence public.cash_movement_number_seq to authenticated;

create or replace function public.record_cash_movement(
  p_kind text,p_amount numeric,p_reason text,p_note text default null,p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_branch uuid:=public.current_branch_id(); v_shift public.shifts; v_decision jsonb;
  v_request public.approval_requests; v_id uuid; v_number text; v_name text; v_operation text;
  v_payload jsonb; v_cap text;
begin
  if p_kind not in('cash_in','cash_out') or p_amount<=0 then raise exception 'Invalid cash movement' using errcode='check_violation'; end if;
  v_cap:=p_kind; v_operation:=p_kind;
  if not public.can(v_cap) then raise exception 'Not permitted to move drawer cash' using errcode='insufficient_privilege'; end if;
  select * into v_shift from public.shifts where branch_id=v_branch and status='open' for update;
  if v_shift.id is null then raise exception 'No open shift' using errcode='no_data_found'; end if;
  if v_shift.opened_by<>auth.uid()::text and not public.can('approve_shift_adjustment') then
    raise exception 'The open shift belongs to another cashier' using errcode='insufficient_privilege';
  end if;
  v_payload:=jsonb_build_object('kind',p_kind,'amount',round(p_amount,2),'reason',btrim(p_reason),'note',nullif(btrim(coalesce(p_note,'')),''),'shift_id',v_shift.id);
  if p_kind='cash_out' then
    v_decision:=public.operation_decision('cash_out',null,p_amount);
    if v_decision->>'decision'='forbidden' then raise exception 'Cash out exceeds configured authority' using errcode='insufficient_privilege'; end if;
    if v_decision->>'decision'='approval' then
      if p_approval_request_id is null then raise exception 'Manager approval required' using errcode='insufficient_privilege'; end if;
      select * into v_request from public.approval_request_matches(p_approval_request_id,'cash_out',v_shift.id::text,null,p_amount,v_payload);
    end if;
  end if;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.cash_movements(branch_id,shift_id,kind,amount,reason,note,user_id,user_name,
    approver_id,approver_name,approval_request_id)
  values(v_branch,v_shift.id,p_kind::public.cash_movement_kind,round(p_amount,2),btrim(p_reason),
    nullif(btrim(coalesce(p_note,'')),''),auth.uid(),coalesce(v_name,'Staff'),
    v_request.approver_user_id,v_request.decided_by_name,case when v_request.id is null then null else v_request.id end)
  returning id,movement_number into v_id,v_number;
  if v_request.id is not null then perform public.mark_approval_applied(v_request.id,v_id::text); end if;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id,reason)
  values(case p_kind when 'cash_in' then 'cash.in' else 'cash.out' end,'cash_movement',v_id::text,v_number,
    jsonb_build_object('amount',round(p_amount,2),'shift_id',v_shift.id,'shift_number',v_shift.shift_number),
    auth.uid()::text,coalesce(v_name,'Staff'),v_request.decided_by,v_request.decided_by_name,
    v_branch,'shifts',(select correlation_id::text from public.cash_movements where id=v_id),btrim(p_reason));
  return jsonb_build_object('id',v_id,'movement_number',v_number,'shift_id',v_shift.id);
end;
$$;

-- Opening/closing invariants become branch-aware; only the authoritative close
-- RPC may freeze the accounting snapshot.
create or replace function public.enforce_shift_invariants()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare v_branch uuid:=public.current_branch_id(); v_name text;
begin
  if tg_op='INSERT' then
    if new.status<>'open' then raise exception 'A shift cannot be created already closed' using errcode='check_violation'; end if;
    if not public.can('open_shift') then raise exception 'Not permitted to open shift' using errcode='insufficient_privilege'; end if;
    if v_branch is null then raise exception 'Active branch required' using errcode='insufficient_privilege'; end if;
    new.branch_id:=v_branch;
    select name_en into new.branch from public.branches where id=v_branch;
    new.opened_by:=auth.uid()::text;
    select name into v_name from public.profiles where id=auth.uid(); new.opened_by_name:=coalesce(v_name,new.opened_by_name);
    if exists(select 1 from public.shifts where branch_id=v_branch and status='open') then
      raise exception 'An open shift already exists in this branch' using errcode='unique_violation';
    end if;
    return new;
  end if;
  if old.branch_id<>v_branch then raise exception 'Cross-branch shift write rejected' using errcode='insufficient_privilege'; end if;
  if old.status='closed' then
    if new.adjustment_approved_at is distinct from old.adjustment_approved_at then
      if old.adjustment_approved_at is not null then
        raise exception 'A shift adjustment can only be approved once' using errcode='check_violation';
      end if;
      if not public.can('approve_shift_adjustment') then
        raise exception 'Closed shift adjustment is not permitted' using errcode='insufficient_privilege';
      end if;
      return new;
    end if;
    if new is distinct from old then raise exception 'A closed shift cannot be edited' using errcode='check_violation'; end if;
    return new;
  end if;
  if new.status='closed' then
    if current_setting('alyq.shift_closing',true) is distinct from old.id::text then
      raise exception 'Use the authoritative close-shift operation' using errcode='insufficient_privilege';
    end if;
    if not public.can('close_shift') then raise exception 'Not permitted to close shift' using errcode='insufficient_privilege'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.close_shift_authoritative(
  p_shift_id uuid,p_actual_cash numeric,p_reason text default null
)
returns public.shifts
language plpgsql
security definer
set search_path=public
as $$
declare
  v_shift public.shifts; v_branch uuid:=public.current_branch_id(); v_name text;
  v_cash_sales numeric:=0; v_visa numeric:=0; v_insta numeric:=0; v_other numeric:=0;
  v_cash_refunds numeric:=0; v_visa_refunds numeric:=0; v_insta_refunds numeric:=0; v_other_refunds numeric:=0;
  v_in numeric:=0; v_out numeric:=0; v_cash_expenses numeric:=0;
  v_sales_total numeric:=0; v_sales_count int:=0; v_refunds numeric:=0; v_refund_count int:=0;
  v_returns_count int:=0; v_mixed_count int:=0; v_mixed_total numeric:=0; v_pending_refunds int:=0;
  v_payment_breakdown jsonb:='[]'::jsonb; v_refund_breakdown jsonb:='[]'::jsonb;
  v_expected numeric; v_diff numeric; v_summary jsonb;
begin
  if p_actual_cash<0 then raise exception 'Actual cash cannot be negative' using errcode='check_violation'; end if;
  select * into v_shift from public.shifts where id=p_shift_id for update;
  if v_shift.id is null or v_shift.branch_id<>v_branch then raise exception 'Shift not found' using errcode='no_data_found'; end if;
  if v_shift.status<>'open' then raise exception 'Shift is already closed' using errcode='check_violation'; end if;
  if v_shift.opened_by<>auth.uid()::text and not public.can('approve_shift_adjustment') then
    raise exception 'Only the cashier or branch manager may close this shift' using errcode='insufficient_privilege';
  end if;
  select count(*),coalesce(sum(s.total),0) into v_sales_count,v_sales_total
    from public.sales s where s.shift_id=v_shift.id and s.status<>'voided';
  select
    coalesce(sum(case when sp.method='cash' and sp.status='paid' then sp.amount else 0 end),0),
    coalesce(sum(case when sp.method='visa' and sp.status='paid' then sp.amount else 0 end),0),
    coalesce(sum(case when sp.method='instapay' and sp.status='paid' then sp.amount else 0 end),0),
    coalesce(sum(case when sp.method::text not in('cash','visa','instapay') and sp.status='paid' then sp.amount else 0 end),0)
  into v_cash_sales,v_visa,v_insta,v_other
  from public.sale_payments sp join public.sales s on s.id=sp.sale_id
  where s.shift_id=v_shift.id and s.status<>'voided';
  select coalesce(jsonb_agg(jsonb_build_object(
           'method',p.method,'amount',round(p.amount,2),'count',p.payment_count)
           order by p.method),'[]'::jsonb)
    into v_payment_breakdown
    from (
      select sp.method::text method,sum(sp.amount) amount,count(*) payment_count
        from public.sale_payments sp join public.sales s on s.id=sp.sale_id
       where s.shift_id=v_shift.id and s.status<>'voided' and sp.status='paid'
       group by sp.method::text
    ) p;
  select count(*),coalesce(sum(total),0) into v_mixed_count,v_mixed_total
    from (
      select s.id,s.total from public.sales s join public.sale_payments sp on sp.sale_id=s.id
       where s.shift_id=v_shift.id and s.status<>'voided' and sp.status='paid'
       group by s.id,s.total having count(*)>1
    ) mixed;

  -- Settlement shift, not sale shift, owns the refund movement. This includes a
  -- cash refund today for a sale made on an earlier drawer without double count.
  select count(*),coalesce(sum(r.amount),0),
         coalesce(sum(case when r.payment_method='cash' then r.amount else 0 end),0),
         coalesce(sum(case when r.payment_method='visa' then r.amount else 0 end),0),
         coalesce(sum(case when r.payment_method='instapay' then r.amount else 0 end),0),
         coalesce(sum(case when r.payment_method::text not in('cash','visa','instapay') then r.amount else 0 end),0)
    into v_refund_count,v_refunds,v_cash_refunds,v_visa_refunds,v_insta_refunds,v_other_refunds
    from public.refund_records r
   where r.settlement_shift_id=v_shift.id and r.status='completed';
  select coalesce(jsonb_agg(jsonb_build_object(
           'method',r.payment_method,'amount',round(r.amount,2),'count',r.refund_count)
           order by r.payment_method),'[]'::jsonb)
    into v_refund_breakdown
    from (
      select rr.payment_method::text payment_method,sum(rr.amount) amount,count(*) refund_count
        from public.refund_records rr
       where rr.settlement_shift_id=v_shift.id and rr.status='completed'
       group by rr.payment_method::text
    ) r;
  select count(*) into v_returns_count from public.sales_returns r
   where r.branch_id=v_branch and r.created_at>=v_shift.opening_at and r.created_at<=now();
  select count(*) into v_pending_refunds from public.refund_records r
   where r.branch_id=v_branch and r.status='pending'
     and r.created_at>=v_shift.opening_at and r.created_at<=now();
  select coalesce(sum(case when kind='cash_in' then amount else 0 end),0),
         coalesce(sum(case when kind='cash_out' then amount else 0 end),0)
    into v_in,v_out from public.cash_movements where shift_id=v_shift.id;
  -- Legacy cash expenses were drawer withdrawals before dedicated movements;
  -- retain them as a separate compatibility component and subtract them once.
  select coalesce(sum(amount),0) into v_cash_expenses from public.expenses
   where shift_id=v_shift.id and payment_method='cash';
  v_expected:=round(v_shift.opening_cash+v_cash_sales+v_in-v_cash_refunds-v_out-v_cash_expenses,2);
  v_diff:=round(p_actual_cash-v_expected,2);
  if v_diff<>0 and nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A cash discrepancy requires a reason' using errcode='check_violation';
  end if;
  v_summary:=jsonb_build_object(
    'sales_count',v_sales_count,'sales_total',round(v_sales_total,2),'gross_sales',round(v_sales_total,2),
    'net_sales',round(v_sales_total,2),'voided_count',0,'voided_total',0,
    'discounts_automatic',0,'discounts_promo',0,'discounts_manual_item',0,'discounts_invoice',0,'discounts_total',0,
    'cash_sales',round(v_cash_sales,2),'instapay_sales',round(v_insta,2),'visa_sales',round(v_visa,2),'other_sales',round(v_other,2),
    'instapay_pending',0,'mixed_count',v_mixed_count,'mixed_total',round(v_mixed_total,2),
    'payments_breakdown',v_payment_breakdown,
    'returns_count',v_returns_count,'returns_total',round(v_refunds,2),'refunds_count',v_refund_count,'refunds_total',round(v_refunds,2),
    'cash_refunds',round(v_cash_refunds,2),'instapay_refunds',round(v_insta_refunds,2),
    'visa_refunds',round(v_visa_refunds,2),'other_refunds',round(v_other_refunds,2),
    'refunds_breakdown',v_refund_breakdown,'pending_refunds',v_pending_refunds,
    'expenses_count',0,'expenses_total',round(v_cash_expenses,2),'cash_expenses',round(v_cash_expenses,2),
    'instapay_expenses',0,'visa_expenses',0,'cash_in',round(v_in,2),'cash_out',round(v_out,2),
    'expected_cash',v_expected,'actual_cash',round(p_actual_cash,2),'difference',v_diff);
  perform set_config('alyq.shift_closing',v_shift.id::text,true);
  select name into v_name from public.profiles where id=auth.uid();
  update public.shifts set status='closed',closing_cash=round(p_actual_cash,2),closed_at=now(),
    closed_by=auth.uid()::text,closed_by_name=coalesce(v_name,'Staff'),notes=nullif(btrim(coalesce(p_reason,'')),''),summary=v_summary
   where id=v_shift.id returning * into v_shift;
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    branch_id,module,correlation_id,reason,after_state)
  values('shift.closed','shift',v_shift.id::text,v_shift.shift_number,
    jsonb_build_object('opening_cash',v_shift.opening_cash,'cash_sales',v_cash_sales,'cash_in',v_in,
      'cash_refunds',v_cash_refunds,'cash_out',v_out,'legacy_cash_expenses',v_cash_expenses,
      'expected_cash',v_expected,'actual_cash',p_actual_cash,'difference',v_diff),
    auth.uid()::text,coalesce(v_name,'Staff'),v_branch,'shifts',extensions.gen_random_uuid()::text,
    nullif(btrim(coalesce(p_reason,'')),''),v_summary);
  return v_shift;
end;
$$;

-- ── Cross-branch guards for legacy SECURITY DEFINER operations ────────────
do $$ begin
  if to_regprocedure('public.pos_confirm_payment_core_0072(uuid,text,text)') is null then
    alter function public.pos_confirm_payment(uuid,text,text) rename to pos_confirm_payment_core_0072;
  end if;
end $$;
revoke all on function public.pos_confirm_payment_core_0072(uuid,text,text) from public,anon,authenticated;
create or replace function public.pos_confirm_payment(p_sale_id uuid,p_user_id text,p_user_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.sales where id=p_sale_id and branch_id=public.current_branch_id()) then
    raise exception 'Sale not found in active branch' using errcode='no_data_found';
  end if;
  return public.pos_confirm_payment_core_0072(p_sale_id,p_user_id,p_user_name);
end; $$;

do $$ begin
  if to_regprocedure('public.pos_settle_refund_core_0072(uuid,text,text,text,text)') is null then
    alter function public.pos_settle_refund(uuid,text,text,text,text) rename to pos_settle_refund_core_0072;
  end if;
end $$;
revoke all on function public.pos_settle_refund_core_0072(uuid,text,text,text,text) from public,anon,authenticated;
create or replace function public.pos_settle_refund(p_refund_id uuid,p_user_id text,p_user_name text,p_decision text default 'completed',p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.refund_records where id=p_refund_id and branch_id=public.current_branch_id()) then
    raise exception 'Refund not found in active branch' using errcode='no_data_found';
  end if;
  return public.pos_settle_refund_core_0072(p_refund_id,p_user_id,p_user_name,p_decision,p_reason);
end; $$;

do $$ begin
  if to_regprocedure('public.resolve_online_order_core_0072(jsonb)') is null then
    alter function public.resolve_online_order(jsonb) rename to resolve_online_order_core_0072;
  end if;
end $$;
revoke all on function public.resolve_online_order_core_0072(jsonb) from public,anon,authenticated;
create or replace function public.resolve_online_order(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order uuid:=nullif(p_payload->>'order_id','')::uuid;
begin
  if not exists(select 1 from public.online_orders where id=v_order and branch_id=public.current_branch_id()) then
    raise exception 'Order not found in active branch' using errcode='no_data_found';
  end if;
  return public.resolve_online_order_core_0072(p_payload);
end; $$;

do $$ begin
  if to_regprocedure('public.stocktake_save_counts_core_0072(uuid,jsonb,text,boolean)') is null then
    alter function public.stocktake_save_counts(uuid,jsonb,text,boolean) rename to stocktake_save_counts_core_0072;
  end if;
  if to_regprocedure('public.stocktake_finalize_core_0072(uuid)') is null then
    alter function public.stocktake_finalize(uuid) rename to stocktake_finalize_core_0072;
  end if;
end $$;
revoke all on function public.stocktake_save_counts_core_0072(uuid,jsonb,text,boolean) from public,anon,authenticated;
revoke all on function public.stocktake_finalize_core_0072(uuid) from public,anon,authenticated;
create or replace function public.stocktake_save_counts(p_stocktake_id uuid,p_counts jsonb,p_status text default null,p_audit boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.stocktakes where id=p_stocktake_id and branch_id=public.current_branch_id()) then
    raise exception 'Stocktake not found in active branch' using errcode='no_data_found';
  end if;
  return public.stocktake_save_counts_core_0072(p_stocktake_id,p_counts,p_status,p_audit);
end; $$;
create or replace function public.stocktake_finalize(p_stocktake_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from public.stocktakes where id=p_stocktake_id and branch_id=public.current_branch_id()) then
    raise exception 'Stocktake not found in active branch' using errcode='no_data_found';
  end if;
  return public.stocktake_finalize_core_0072(p_stocktake_id);
end; $$;

-- The till core expects at most one open shift for the actor. Keep that invariant
-- across branches so branch switching cannot attach a sale to another drawer.
-- Different cashiers may still operate simultaneously in different branches.
create or replace function public.enforce_shift_invariants()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_branch uuid:=public.current_branch_id(); v_name text;
begin
  if tg_op='INSERT' then
    if new.status<>'open' then raise exception 'A shift cannot be created already closed' using errcode='check_violation'; end if;
    if not public.can('open_shift') then raise exception 'Not permitted to open shift' using errcode='insufficient_privilege'; end if;
    if v_branch is null then raise exception 'Active branch required' using errcode='insufficient_privilege'; end if;
    new.branch_id:=v_branch; select name_en into new.branch from public.branches where id=v_branch;
    new.opened_by:=auth.uid()::text; select name into v_name from public.profiles where id=auth.uid(); new.opened_by_name:=coalesce(v_name,new.opened_by_name);
    if exists(select 1 from public.shifts where status='open' and opened_by=auth.uid()::text) then
      raise exception 'This cashier already has an open shift' using errcode='unique_violation';
    end if;
    if exists(select 1 from public.shifts where branch_id=v_branch and status='open') then
      raise exception 'An open shift already exists in this branch' using errcode='unique_violation';
    end if;
    return new;
  end if;
  if old.branch_id<>v_branch then raise exception 'Cross-branch shift write rejected' using errcode='insufficient_privilege'; end if;
  if old.status='closed' then
    if new.adjustment_approved_at is distinct from old.adjustment_approved_at then
      if old.adjustment_approved_at is not null then raise exception 'A shift adjustment can only be approved once' using errcode='check_violation'; end if;
      if not public.can('approve_shift_adjustment') then raise exception 'Closed shift adjustment is not permitted' using errcode='insufficient_privilege'; end if;
      return new;
    end if;
    if new is distinct from old then raise exception 'A closed shift cannot be edited' using errcode='check_violation'; end if;
    return new;
  end if;
  if new.status='closed' then
    if current_setting('alyq.shift_closing',true) is distinct from old.id::text then raise exception 'Use the authoritative close-shift operation' using errcode='insufficient_privilege'; end if;
    if not public.can('close_shift') then raise exception 'Not permitted to close shift' using errcode='insufficient_privilege'; end if;
  end if;
  return new;
end; $$;

alter table public.operation_policies enable row level security;
drop policy if exists operation_policies_read on public.operation_policies;
create policy operation_policies_read on public.operation_policies for select to authenticated
  using(branch_id=public.current_branch_id());
drop policy if exists operation_policies_no_direct_write on public.operation_policies;
create policy operation_policies_no_direct_write on public.operation_policies for all to authenticated using(false) with check(false);
grant select on public.operation_policies to authenticated;
revoke all on function public.operation_decision(text,numeric,numeric,uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_operation_policy(jsonb) to authenticated;
grant execute on function public.set_manager_pin(uuid,uuid,text) to authenticated;
grant execute on function public.approve_with_manager_pin(uuid,text,text) to authenticated;
grant execute on function public.record_cash_movement(text,numeric,text,text,uuid) to authenticated;
grant execute on function public.close_shift_authoritative(uuid,numeric,text) to authenticated;
grant execute on function public.pos_complete_sale(jsonb,uuid) to authenticated;
grant execute on function public.pos_process_return(jsonb) to authenticated;
grant execute on function public.pos_void_sale(uuid,text,text,text,uuid) to authenticated;
revoke all on function public.set_manager_pin(uuid,uuid,text) from anon;
revoke all on function public.approve_with_manager_pin(uuid,text,text) from anon;
revoke all on function public.record_cash_movement(text,numeric,text,text,uuid) from anon;
revoke all on function public.close_shift_authoritative(uuid,numeric,text) from anon;

-- Internal policy, fingerprint and trigger definers are not callable endpoints.
revoke all on function public.seed_branch_operation_policies() from public,anon,authenticated;
revoke all on function public.operation_policy_for(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.operation_fingerprint(text,uuid,text,numeric,numeric,jsonb) from public,anon,authenticated;
revoke all on function public.approval_request_matches(uuid,text,text,numeric,numeric,jsonb) from public,anon,authenticated;
revoke all on function public.approver_has_authority(uuid,uuid) from public,anon,authenticated;
revoke all on function public.stamp_refund_settlement_shift() from public,anon,authenticated;
revoke all on function public.enforce_approval_request_invariants() from public,anon,authenticated;
revoke all on function public.next_cash_movement_number() from public,anon,authenticated;
revoke all on function public.enforce_shift_invariants() from public,anon,authenticated;

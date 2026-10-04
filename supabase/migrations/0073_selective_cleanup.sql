-- ═══════════════════════════════════════════════════════════════════════════
-- 0073 · Safe selective cleanup (SELECT → PREVIEW → CONFIRM → EXECUTE → AUDIT)
-- ═══════════════════════════════════════════════════════════════════════════
-- There is intentionally no generic table name or predicate parameter. Every
-- category below owns one reviewed schema operation and a dependency policy.
-- Final financial, audit, finalized stocktake and reconciliation records are
-- never deletion candidates.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.cleanup_previews(
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  category text not null check(category in(
    'customers','cancelled_online_orders','expired_promotions','unfinished_stocktakes'
  )),
  filters jsonb not null,
  preview_state jsonb not null,
  fingerprint text not null,
  token_hash text not null unique,
  confirmation_phrase text not null,
  expires_at timestamptz not null,
  executed_at timestamptz,
  execution_result jsonb,
  approval_request_id uuid references public.approval_requests(id) on delete restrict,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create index if not exists cleanup_previews_active_idx
  on public.cleanup_previews(requested_by,branch_id,expires_at) where executed_at is null;
alter table public.cleanup_previews enable row level security;
revoke all on public.cleanup_previews from public,anon,authenticated;

insert into public.audit_actions(action,entity) values
  ('cleanup.previewed','cleanup_preview'),
  ('cleanup.executed','cleanup_execution'),
  ('cleanup.refused','cleanup_preview')
on conflict(action) do nothing;

create or replace function public.cleanup_cutoff(p_filters jsonb)
returns timestamptz
language plpgsql
stable
set search_path=public
as $$
declare v_cutoff timestamptz;
begin
  if jsonb_typeof(coalesce(p_filters,'{}'))<>'object' then
    raise exception 'Cleanup filters must be an object' using errcode='check_violation';
  end if;
  begin v_cutoff:=(p_filters->>'before')::timestamptz;
  exception when others then raise exception 'A valid before date is required' using errcode='check_violation'; end;
  if v_cutoff is null or v_cutoff>now() then
    raise exception 'The before date must be in the past' using errcode='check_violation';
  end if;
  return v_cutoff;
end;
$$;

-- Exact ordered id sets are part of the preview state. Execution recomputes
-- this state under locks; count-only previews are deliberately insufficient.
create or replace function public.cleanup_preview_state(
  p_category text,p_filters jsonb,p_branch_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_cutoff timestamptz:=public.cleanup_cutoff(p_filters);
  v_from timestamptz;
  v_record_id uuid;
  v_reference text:=nullif(btrim(coalesce(p_filters->>'reference','')),'');
  v_delete jsonb:='[]'; v_anonymize jsonb:='[]'; v_archive jsonb:='[]'; v_protected jsonb:='[]';
begin
  begin
    v_from:=nullif(p_filters->>'from','')::timestamptz;
  exception when others then
    raise exception 'The from date is invalid' using errcode='check_violation';
  end;
  if v_from is not null and v_from>=v_cutoff then
    raise exception 'The cleanup date range is invalid' using errcode='check_violation';
  end if;
  begin
    v_record_id:=nullif(p_filters->>'record_id','')::uuid;
  exception when others then
    raise exception 'The record id must be a UUID' using errcode='check_violation';
  end;
  if v_reference is not null and char_length(v_reference)>120 then
    raise exception 'The reference is too long' using errcode='check_violation';
  end if;

  if p_category='customers' then
    select coalesce(jsonb_agg(id order by id),'[]') into v_delete
      from public.customers c where c.branch_id=p_branch_id and c.created_at<v_cutoff
       and (v_from is null or c.created_at>=v_from)
       and (v_record_id is null or c.id=v_record_id)
       and (v_reference is null or c.phone=v_reference)
       and not exists(select 1 from public.sales s where s.customer_id=c.id);
    select coalesce(jsonb_agg(id order by id),'[]') into v_anonymize
      from public.customers c where c.branch_id=p_branch_id and c.created_at<v_cutoff
       and (v_from is null or c.created_at>=v_from)
       and (v_record_id is null or c.id=v_record_id)
       and (v_reference is null or c.phone=v_reference)
       and exists(select 1 from public.sales s where s.customer_id=c.id)
       and (c.name<>'Anonymized customer' or c.phone not like 'anon-%');
    return jsonb_build_object(
      'category',p_category,'from',v_from,'before',v_cutoff,'record_id',v_record_id,'reference',v_reference,'delete_ids',v_delete,'anonymize_ids',v_anonymize,
      'archive_ids','[]'::jsonb,'protected_ids','[]'::jsonb,
      'delete_count',jsonb_array_length(v_delete),'anonymize_count',jsonb_array_length(v_anonymize),
      'archive_count',0,'protected_count',0,
      'dependencies',jsonb_build_object('historical_sales','anonymize customer PII; retain financial records'));

  elsif p_category='cancelled_online_orders' then
    select coalesce(jsonb_agg(id order by id),'[]') into v_delete
      from public.online_orders o where o.branch_id=p_branch_id and o.status='cancelled'
       and o.sale_id is null and o.created_at<v_cutoff
       and (v_from is null or o.created_at>=v_from)
       and (v_record_id is null or o.id=v_record_id)
       and (v_reference is null or v_reference in(o.order_number,o.client_ref));
    select coalesce(jsonb_agg(id order by id),'[]') into v_protected
      from public.online_orders o where o.branch_id=p_branch_id and o.created_at<v_cutoff
       and (v_from is null or o.created_at>=v_from)
       and (v_record_id is null or o.id=v_record_id)
       and (v_reference is null or v_reference in(o.order_number,o.client_ref))
       and (o.status<>'cancelled' or o.sale_id is not null);
    return jsonb_build_object(
      'category',p_category,'from',v_from,'before',v_cutoff,'record_id',v_record_id,'reference',v_reference,'delete_ids',v_delete,'anonymize_ids','[]'::jsonb,
      'archive_ids','[]'::jsonb,'protected_ids',v_protected,
      'delete_count',jsonb_array_length(v_delete),'anonymize_count',0,'archive_count',0,
      'protected_count',jsonb_array_length(v_protected),
      'dependencies',jsonb_build_object('order_items','cascade','events','cascade','reservations','cascade','sale_linked','protected'));

  elsif p_category='expired_promotions' then
    -- Promotions are branch-neutral legacy configuration. We archive only ones
    -- whose snapped usage belongs solely to this branch (or has no usage).
    select coalesce(jsonb_agg(p.id order by p.id),'[]') into v_archive
      from public.promotions p
     where p.enabled and p.ends_at is not null and p.ends_at<v_cutoff
       and (v_from is null or p.ends_at>=v_from)
       and (v_record_id is null or p.id=v_record_id)
       and (v_reference is null or lower(v_reference) in(lower(p.name_en),lower(p.name_ar)))
       -- Promotions predate branch tenancy and remain global configuration.
       -- Only the migrated default branch may archive one, and never when a
       -- different branch has snapped usage.
       and exists(select 1 from public.branches b where b.id=p_branch_id and b.is_default)
       and not exists(
         select 1 from public.sales s where (s.promotion_id=p.id or s.automatic_promotion_id=p.id)
           and s.branch_id<>p_branch_id
       );
    select coalesce(jsonb_agg(p.id order by p.id),'[]') into v_protected
      from public.promotions p
     where p.enabled
       and (v_from is null or (p.ends_at is not null and p.ends_at>=v_from))
       and (v_record_id is null or p.id=v_record_id)
       and (v_reference is null or lower(v_reference) in(lower(p.name_en),lower(p.name_ar)))
       and (
       not exists(select 1 from public.branches b where b.id=p_branch_id and b.is_default)
       or p.ends_at is null or p.ends_at>=v_cutoff
       or exists(select 1 from public.sales s where (s.promotion_id=p.id or s.automatic_promotion_id=p.id)
           and s.branch_id<>p_branch_id));
    return jsonb_build_object(
      'category',p_category,'from',v_from,'before',v_cutoff,'record_id',v_record_id,'reference',v_reference,'delete_ids','[]'::jsonb,'anonymize_ids','[]'::jsonb,
      'archive_ids',v_archive,'protected_ids',v_protected,
      'delete_count',0,'anonymize_count',0,'archive_count',jsonb_array_length(v_archive),
      'protected_count',jsonb_array_length(v_protected),
      'dependencies',jsonb_build_object('historical_order_and_sale_snapshots','retained','operation','disable only'));

  elsif p_category='unfinished_stocktakes' then
    select coalesce(jsonb_agg(st.id order by st.id),'[]') into v_delete
      from public.stocktakes st where st.branch_id=p_branch_id and st.status in('draft','counting','review')
       and st.created_at<v_cutoff
       and (v_from is null or st.created_at>=v_from)
       and (v_record_id is null or st.id=v_record_id)
       and (v_reference is null or st.reference=v_reference)
       and not exists(select 1 from public.stocktake_lines l where l.stocktake_id=st.id and l.movement_id is not null);
    select coalesce(jsonb_agg(st.id order by st.id),'[]') into v_protected
      from public.stocktakes st where st.branch_id=p_branch_id and st.created_at<v_cutoff
       and (v_from is null or st.created_at>=v_from)
       and (v_record_id is null or st.id=v_record_id)
       and (v_reference is null or st.reference=v_reference)
       and (st.status='finalized' or exists(select 1 from public.stocktake_lines l where l.stocktake_id=st.id and l.movement_id is not null));
    return jsonb_build_object(
      'category',p_category,'from',v_from,'before',v_cutoff,'record_id',v_record_id,'reference',v_reference,'delete_ids',v_delete,'anonymize_ids','[]'::jsonb,
      'archive_ids','[]'::jsonb,'protected_ids',v_protected,
      'delete_count',jsonb_array_length(v_delete),'anonymize_count',0,'archive_count',0,
      'protected_count',jsonb_array_length(v_protected),
      'dependencies',jsonb_build_object('draft_lines','cascade','finalized_or_movement_linked','protected'));
  else
    raise exception 'Unsupported cleanup category' using errcode='check_violation';
  end if;
end;
$$;

create or replace function public.preview_selective_cleanup(p_category text,p_filters jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_branch uuid:=public.current_branch_id(); v_state jsonb; v_nonce text;
  v_fingerprint text; v_token text; v_id uuid; v_total int; v_name text; v_exp timestamptz:=now()+interval '5 minutes';
begin
  if not public.can('preview_data_cleanup') then
    raise exception 'Not permitted to preview cleanup' using errcode='insufficient_privilege';
  end if;
  -- Reject unknown keys as well as unknown categories. This is a closed filter
  -- vocabulary, not an arbitrary SQL predicate tunnel.
  if exists(
    select 1 from jsonb_object_keys(coalesce(p_filters,'{}')) k
     where k not in('from','before','record_id','reference')
  ) then
    raise exception 'Unsupported cleanup filter' using errcode='check_violation';
  end if;
  v_state:=public.cleanup_preview_state(p_category,p_filters,v_branch);
  v_total:=coalesce((v_state->>'delete_count')::int,0)+coalesce((v_state->>'anonymize_count')::int,0)+coalesce((v_state->>'archive_count')::int,0);
  v_nonce:=encode(gen_random_bytes(32),'hex');
  v_fingerprint:=encode(digest(v_branch::text||'|'||p_category||'|'||p_filters::text||'|'||v_state::text||'|'||v_exp::text||'|'||v_nonce,'sha256'),'hex');
  v_token:=encode(gen_random_bytes(32),'hex');
  insert into public.cleanup_previews(branch_id,requested_by,category,filters,preview_state,
    fingerprint,token_hash,confirmation_phrase,expires_at)
  values(v_branch,auth.uid(),p_category,p_filters,v_state,v_fingerprint,
    encode(digest(v_token,'sha256'),'hex'),'CLEAN '||v_total,v_exp)
  returning id into v_id;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    branch_id,module,correlation_id)
  values('cleanup.previewed','cleanup_preview',v_id::text,p_category,
    jsonb_build_object('counts',v_state-array['delete_ids','anonymize_ids','archive_ids','protected_ids'],
      'filters',p_filters,'fingerprint',v_fingerprint),auth.uid()::text,coalesce(v_name,'Staff'),
    v_branch,'settings',(select correlation_id::text from public.cleanup_previews where id=v_id));
  return jsonb_build_object('preview_id',v_id,'category',p_category,'state',v_state,
    'fingerprint',v_fingerprint,'preview_token',v_token,'confirmation_phrase','CLEAN '||v_total,'expires_at',v_exp);
end;
$$;

create or replace function public.execute_selective_cleanup(
  p_preview_id uuid,p_preview_token text,p_fingerprint text,p_confirmation text,p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_preview public.cleanup_previews; v_recomputed jsonb; v_decision jsonb; v_request public.approval_requests;
  v_result jsonb; v_name text; v_deleted int:=0; v_anonymized int:=0; v_archived int:=0; v_id uuid;
begin
  select * into v_preview from public.cleanup_previews where id=p_preview_id for update;
  if v_preview.id is null or v_preview.requested_by<>auth.uid() or v_preview.branch_id<>public.current_branch_id() then
    raise exception 'Cleanup preview not found' using errcode='no_data_found';
  end if;
  if not public.can('execute_data_cleanup') then raise exception 'Not permitted to execute cleanup' using errcode='insufficient_privilege'; end if;
  if v_preview.executed_at is not null then raise exception 'Cleanup preview already used' using errcode='check_violation'; end if;
  if v_preview.expires_at<=now() then raise exception 'Cleanup preview expired' using errcode='check_violation'; end if;
  if encode(digest(coalesce(p_preview_token,''),'sha256'),'hex')<>v_preview.token_hash
     or p_fingerprint<>v_preview.fingerprint
     or p_confirmation<>v_preview.confirmation_phrase then
    raise exception 'Cleanup confirmation does not match the preview' using errcode='insufficient_privilege';
  end if;
  v_recomputed:=public.cleanup_preview_state(v_preview.category,v_preview.filters,v_preview.branch_id);
  if v_recomputed<>v_preview.preview_state then
    raise exception 'Cleanup data changed; generate a new preview' using errcode='serialization_failure';
  end if;
  v_decision:=public.operation_decision('selective_cleanup',null,
    coalesce((v_recomputed->>'delete_count')::numeric,0)+coalesce((v_recomputed->>'anonymize_count')::numeric,0)+coalesce((v_recomputed->>'archive_count')::numeric,0));
  if v_decision->>'decision'='forbidden' then raise exception 'Cleanup exceeds configured authority' using errcode='insufficient_privilege'; end if;
  if v_decision->>'decision'='approval' then
    if p_approval_request_id is null then raise exception 'Manager approval required' using errcode='insufficient_privilege'; end if;
    select * into v_request from public.approval_request_matches(p_approval_request_id,'selective_cleanup',
      p_preview_id::text,null,((v_recomputed->>'delete_count')::numeric+(v_recomputed->>'anonymize_count')::numeric+(v_recomputed->>'archive_count')::numeric),
      jsonb_build_object('preview_id',p_preview_id,'fingerprint',p_fingerprint,'category',v_preview.category));
  end if;

  if v_preview.category='customers' then
    for v_id in select (jsonb_array_elements_text(v_recomputed->'anonymize_ids'))::uuid loop
      update public.customers set name='Anonymized customer',
        phone='anon-'||left(replace(v_id::text,'-',''),25),address=null,notes=null
       where id=v_id and branch_id=v_preview.branch_id;
      update public.sales set customer_name='Anonymized customer',customer_phone=null where customer_id=v_id and branch_id=v_preview.branch_id;
      v_anonymized:=v_anonymized+1;
    end loop;
    delete from public.customers where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid) and branch_id=v_preview.branch_id;
    get diagnostics v_deleted=row_count;
  elsif v_preview.category='cancelled_online_orders' then
    delete from public.online_orders where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid)
      and branch_id=v_preview.branch_id and status='cancelled' and sale_id is null;
    get diagnostics v_deleted=row_count;
  elsif v_preview.category='expired_promotions' then
    update public.promotions set enabled=false where id in(select (jsonb_array_elements_text(v_recomputed->'archive_ids'))::uuid) and enabled;
    get diagnostics v_archived=row_count;
  elsif v_preview.category='unfinished_stocktakes' then
    delete from public.stocktakes where id in(select (jsonb_array_elements_text(v_recomputed->'delete_ids'))::uuid)
      and branch_id=v_preview.branch_id and status in('draft','counting','review');
    get diagnostics v_deleted=row_count;
  else raise exception 'Unsupported cleanup category' using errcode='check_violation'; end if;

  v_result:=jsonb_build_object('preview_id',p_preview_id,'category',v_preview.category,
    'deleted',v_deleted,'anonymized',v_anonymized,'archived',v_archived,
    'protected',(v_recomputed->>'protected_count')::int,'completed_at',now());
  update public.cleanup_previews set executed_at=now(),execution_result=v_result,approval_request_id=v_request.id where id=p_preview_id;
  if v_request.id is not null then perform public.mark_approval_applied(v_request.id,p_preview_id::text); end if;
  select name into v_name from public.profiles where id=auth.uid();
  insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,
    approver_id,approver_name,branch_id,module,correlation_id,reason,before_state,after_state)
  values('cleanup.executed','cleanup_execution',p_preview_id::text,v_preview.category,
    v_result,auth.uid()::text,coalesce(v_name,'Staff'),v_request.decided_by,v_request.decided_by_name,
    v_preview.branch_id,'settings',v_preview.correlation_id::text,'Confirmed selective cleanup',
    jsonb_build_object('filters',v_preview.filters,'counts',v_preview.preview_state-array['delete_ids','anonymize_ids','archive_ids','protected_ids']),v_result);
  return v_result;
end;
$$;

grant execute on function public.preview_selective_cleanup(text,jsonb) to authenticated;
grant execute on function public.execute_selective_cleanup(uuid,text,text,text,uuid) to authenticated;
revoke all on function public.preview_selective_cleanup(text,jsonb) from anon;
revoke all on function public.execute_selective_cleanup(uuid,text,text,text,uuid) from anon;
revoke all on function public.cleanup_cutoff(jsonb) from public,anon,authenticated;
revoke all on function public.cleanup_preview_state(text,jsonb,uuid) from public,anon,authenticated;

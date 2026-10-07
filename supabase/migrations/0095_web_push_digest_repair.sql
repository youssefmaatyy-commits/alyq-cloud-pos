-- 0095 — Repair pgcrypto resolution in the installed Web Push functions
--
-- Hosted Supabase installs pgcrypto in the `extensions` schema. Migration 0094
-- installed SECURITY DEFINER functions with a deliberately narrow search_path
-- of pg_catalog,public, so unqualified digest(...) calls cannot resolve there.
-- Keep that hardened search_path and bind only the required pgcrypto calls to
-- extensions.digest(...). Function signatures, authorization, grants, RLS,
-- subscription custody, delivery state, and payload behavior remain unchanged.

begin;

create or replace function public.web_push_subscription_register(
  p_client_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_locale text default 'en',
  p_expiration_time timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_uid uuid:=auth.uid();
  v_endpoint text:=btrim(coalesce(p_endpoint,''));
  v_hash text;
  v_row public.web_push_subscriptions;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=v_uid and active) then
    raise exception 'Active user required' using errcode='42501';
  end if;
  if p_client_id is null or p_locale not in('en','ar')
     or char_length(v_endpoint) not between 16 and 2048
     or v_endpoint !~ '^https://[^[:space:]]+$'
     or char_length(coalesce(p_p256dh,'')) not between 80 and 120
     or coalesce(p_p256dh,'') !~ '^[A-Za-z0-9_-]+$'
     or char_length(coalesce(p_auth,'')) not between 16 and 64
     or coalesce(p_auth,'') !~ '^[A-Za-z0-9_-]+$'
     or (p_expiration_time is not null and p_expiration_time<=now()) then
    raise exception 'Invalid Web Push subscription' using errcode='23514';
  end if;
  v_hash:=encode(extensions.digest(v_endpoint,'sha256'),'hex');

  -- A browser identity cannot silently take over an active subscription owned
  -- by another user. An inactive browser identity may be reused only after the
  -- previous session explicitly deactivated it.
  if exists(select 1 from public.web_push_subscriptions
             where client_id=p_client_id and active and user_id<>v_uid) then
    raise exception 'Browser subscription belongs to another active user' using errcode='42501';
  end if;
  if exists(select 1 from public.web_push_subscriptions
             where endpoint_hash=v_hash and active and user_id<>v_uid) then
    raise exception 'Push endpoint belongs to another active user' using errcode='42501';
  end if;

  -- Local-storage reset can assign a new client id to the same endpoint. Retire
  -- only same-user/inactive duplicates before the unique endpoint snapshot is
  -- assigned. Historical delivery attempts remain immutable.
  update public.web_push_subscriptions
     set active=false,endpoint=null,endpoint_hash=null,p256dh=null,auth_secret=null,
         deactivated_at=coalesce(deactivated_at,now()),last_seen_at=now()
   where endpoint_hash=v_hash and client_id<>p_client_id
     and (user_id=v_uid or not active);

  insert into public.web_push_subscriptions(
    client_id,user_id,endpoint,endpoint_hash,p256dh,auth_secret,locale,active,
    expiration_time,last_seen_at,deactivated_at,invalidated_at
  ) values(
    p_client_id,v_uid,v_endpoint,v_hash,p_p256dh,p_auth,p_locale,true,
    p_expiration_time,now(),null,null
  )
  on conflict(client_id) do update set
    user_id=excluded.user_id,endpoint=excluded.endpoint,endpoint_hash=excluded.endpoint_hash,
    p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,locale=excluded.locale,
    active=true,expiration_time=excluded.expiration_time,last_seen_at=now(),
    deactivated_at=null,invalidated_at=null
  returning * into v_row;

  -- Endpoint/key rotation updates only unsent work for this same browser. The
  -- notification and recipient remain server-selected and are re-authorized at
  -- claim time; request data still cannot create or redirect a delivery.
  update public.notification_push_deliveries
     set token_hash=v_hash,next_attempt_at=least(next_attempt_at,now())
   where web_push_subscription_id=v_row.id and status in('pending','retry');

  return jsonb_build_object('id',v_row.id,'active',v_row.active,'locale',v_row.locale);
end
$function$;

create or replace function public.notification_claim_push_batch(
  p_worker text,p_limit integer default 50,p_event_limit integer default 20
)
returns table(
  delivery_id uuid,notification_id uuid,platform text,locale text,push_token text,
  kind text,title text,body text,route_key text,entity_id text,collapse_key text,
  attempt_number integer
)
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
#variable_conflict use_column
declare v_event public.notification_outbox; v_limit integer; v_event_limit integer;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if char_length(btrim(coalesce(p_worker,''))) not between 8 and 120 then
    raise exception 'Worker identity required' using errcode='22023';
  end if;
  v_limit:=least(greatest(coalesce(p_limit,50),1),100);
  v_event_limit:=least(greatest(coalesce(p_event_limit,20),1),25);

  insert into public.notification_delivery_attempts(
    delivery_id,attempt_number,outcome,http_status,error_code
  )
  select d.id,d.attempt_count,
         case when d.attempt_count>=d.max_attempts then 'permanent_failure' else 'retry' end,
         null,'worker_timeout'
    from public.notification_push_deliveries d
   where d.status='sending' and d.locked_at<now()-interval '5 minutes'
  on conflict(delivery_id,attempt_number) do nothing;
  update public.notification_push_deliveries d
     set status=case when d.attempt_count>=d.max_attempts then 'permanent_failure' else 'retry' end,
         next_attempt_at=now(),locked_at=null,locked_by=null,last_error_code='worker_timeout'
   where d.status='sending' and d.locked_at<now()-interval '5 minutes';

  -- Expired browser subscriptions are server-cleaned even when the browser never
  -- returns. Provider 404/410 cleanup is handled by record_push_result below.
  update public.web_push_subscriptions
     set active=false,endpoint=null,endpoint_hash=null,p256dh=null,auth_secret=null,
         deactivated_at=coalesce(deactivated_at,now()),updated_at=now()
   where active and expiration_time is not null and expiration_time<=now();

  update public.notification_push_deliveries d
     set status='permanent_failure',locked_at=null,locked_by=null,
         last_error_code='invalid_subscription'
    from public.web_push_subscriptions s
   where d.web_push_subscription_id=s.id and d.provider='web_push'
     and d.status in('pending','retry')
     and (not s.active or s.endpoint is null or s.p256dh is null or s.auth_secret is null);

  -- Current recipient, branch, capability and entity authority is rechecked at
  -- claim time. A revoked delivery remains in Notification Center but is never
  -- sent or left cycling through the provider queue.
  update public.notification_push_deliveries d
     set status='permanent_failure',locked_at=null,locked_by=null,
         last_error_code='authorization_changed'
    from public.user_notification_inbox i
   where d.inbox_id=i.id and d.status in('pending','retry')
     and (not public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       or not public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id));

  for v_event in
    select o.* from public.notification_outbox o
     where o.state='pending' and o.available_at<=now()
     order by o.created_at,o.id
     for update skip locked limit v_event_limit
  loop
    update public.notification_outbox set state='processing' where id=v_event.id;
    insert into public.user_notification_inbox(
      outbox_id,user_id,branch_id,kind,entity_type,entity_id,route_key,route_entity_id,
      required_capabilities,title_en,title_ar,body_en,body_ar,created_at
    )
    select v_event.id,p.id,v_event.branch_id,v_event.kind,v_event.entity_type,v_event.entity_id,
      v_event.route_key,v_event.route_entity_id,v_event.required_capabilities,
      v_event.title_en,v_event.title_ar,v_event.body_en,v_event.body_ar,v_event.created_at
      from public.profiles p
     where public.notification_user_eligible(p.id,v_event.branch_id,v_event.required_capabilities)
    on conflict(outbox_id,user_id) do nothing;

    insert into public.notification_push_deliveries(
      outbox_id,inbox_id,installation_id,web_push_subscription_id,user_id,token_hash,provider,max_attempts
    )
    select v_event.id,i.id,m.id,null,i.user_id,m.push_token_hash,
      case when m.platform='android' then 'fcm' else 'apns' end,v_event.max_attempts
      from public.user_notification_inbox i
      join public.mobile_installations m on m.user_id=i.user_id
     where i.outbox_id=v_event.id and m.active and m.push_registered
       and m.push_token is not null and m.push_token_hash is not null
       and m.platform in('android','ios')
       and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
    on conflict(outbox_id,installation_id) do nothing;

    insert into public.notification_push_deliveries(
      outbox_id,inbox_id,installation_id,web_push_subscription_id,user_id,token_hash,provider,max_attempts
    )
    select v_event.id,i.id,null,s.id,i.user_id,s.endpoint_hash,'web_push',v_event.max_attempts
      from public.user_notification_inbox i
      join public.web_push_subscriptions s on s.user_id=i.user_id
     where i.outbox_id=v_event.id and s.active and s.endpoint is not null
       and s.endpoint_hash is not null and s.p256dh is not null and s.auth_secret is not null
       and (s.expiration_time is null or s.expiration_time>now())
       and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
    on conflict(outbox_id,web_push_subscription_id)
      where web_push_subscription_id is not null do nothing;

    update public.notification_outbox o
       set state=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                      then 'expanded' else 'completed' end,
           expanded_at=now(),
           completed_at=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                             then null else now() end
     where o.id=v_event.id;
  end loop;

  update public.notification_push_deliveries d
     set status='permanent_failure',last_error_code='recipient_or_installation_ineligible',
         locked_at=null,locked_by=null
    from public.user_notification_inbox i,public.mobile_installations m
   where d.inbox_id=i.id and d.installation_id=m.id and d.provider in('fcm','apns')
     and d.status in('pending','retry')
     and (not public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       or not public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
       or not m.active or not m.push_registered or m.push_token is null
       or m.push_token_hash is distinct from d.token_hash);

  update public.notification_push_deliveries d
     set status='permanent_failure',last_error_code='recipient_or_subscription_ineligible',
         locked_at=null,locked_by=null
    from public.user_notification_inbox i,public.web_push_subscriptions s
   where d.inbox_id=i.id and d.web_push_subscription_id=s.id and d.provider='web_push'
     and d.status in('pending','retry')
     and (not public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       or not public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
       or not s.active or s.endpoint is null or s.p256dh is null or s.auth_secret is null
       or s.endpoint_hash is distinct from d.token_hash
       or (s.expiration_time is not null and s.expiration_time<=now()));

  update public.notification_outbox o
     set state=case when exists(select 1 from public.notification_push_deliveries d
                                where d.outbox_id=o.id and d.status='delivered')
                    then 'completed' else 'dead' end,
         completed_at=case when exists(select 1 from public.notification_push_deliveries d
                                       where d.outbox_id=o.id and d.status='delivered') then now() else null end,
         dead_letter_at=case when exists(select 1 from public.notification_push_deliveries d
                                         where d.outbox_id=o.id and d.status='delivered') then null else now() end,
         last_error_code=case when exists(select 1 from public.notification_push_deliveries d
                                          where d.outbox_id=o.id and d.status='delivered') then null
                              else 'all_deliveries_failed' end
   where o.state in('processing','expanded')
     and exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
     and not exists(select 1 from public.notification_push_deliveries d
                     where d.outbox_id=o.id and d.status in('pending','sending','retry'));

  return query
  with candidates as (
    select d.id from public.notification_push_deliveries d
     where d.status in('pending','retry') and d.next_attempt_at<=now()
     order by d.next_attempt_at,d.created_at,d.id
     for update skip locked limit v_limit
  ), claimed as (
    update public.notification_push_deliveries d
       set status='sending',attempt_count=d.attempt_count+1,locked_at=now(),locked_by=p_worker
      from candidates c where d.id=c.id
    returning d.*
  )
  select d.id,i.id,coalesce(m.platform,'web'),coalesce(m.locale,s.locale),
    case when d.provider='web_push' then jsonb_build_object(
      'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth_secret
    )::text else m.push_token end,
    o.kind,
    case when coalesce(m.locale,s.locale)='ar' then o.title_ar else o.title_en end,
    case when coalesce(m.locale,s.locale)='ar' then o.body_ar else o.body_en end,
    o.route_key,o.route_entity_id,encode(extensions.digest(o.dedupe_key,'sha256'),'hex'),d.attempt_count
    from claimed d
    join public.notification_outbox o on o.id=d.outbox_id
    join public.user_notification_inbox i on i.id=d.inbox_id
    left join public.mobile_installations m on m.id=d.installation_id
    left join public.web_push_subscriptions s on s.id=d.web_push_subscription_id
   where public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
     and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
     and ((d.provider in('fcm','apns') and m.active and m.push_registered
           and m.push_token is not null and m.push_token_hash=d.token_hash)
       or (d.provider='web_push' and s.active and s.endpoint is not null
           and s.p256dh is not null and s.auth_secret is not null
           and s.endpoint_hash=d.token_hash
           and (s.expiration_time is null or s.expiration_time>now())));
end
$function$;

create or replace function public.notification_record_push_result(
  p_delivery_id uuid,p_worker text,p_outcome text,p_http_status integer default null,
  p_error_code text default null,p_provider_reference text default null,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_delivery public.notification_push_deliveries;
  v_status text;
  v_retry integer;
  v_ref_hash text;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if p_outcome not in('delivered','retry','invalid_token','permanent_failure') then
    raise exception 'Invalid delivery outcome' using errcode='22023';
  end if;
  select * into v_delivery from public.notification_push_deliveries
   where id=p_delivery_id for update;
  if v_delivery.id is null then raise exception 'Delivery not found' using errcode='P0002'; end if;
  if exists(select 1 from public.notification_delivery_attempts
             where delivery_id=v_delivery.id and attempt_number=v_delivery.attempt_count) then
    return jsonb_build_object('id',v_delivery.id,'status',v_delivery.status,'replayed',true);
  end if;
  if v_delivery.status<>'sending' or v_delivery.locked_by is distinct from p_worker then
    raise exception 'Delivery is not owned by this worker' using errcode='42501';
  end if;

  v_ref_hash:=case when nullif(p_provider_reference,'') is null then null
    else encode(extensions.digest(p_provider_reference,'sha256'),'hex') end;
  insert into public.notification_delivery_attempts(
    delivery_id,attempt_number,outcome,http_status,error_code,provider_reference_hash
  ) values(v_delivery.id,v_delivery.attempt_count,p_outcome,p_http_status,
    left(nullif(p_error_code,''),120),v_ref_hash);

  if p_outcome='delivered' then
    v_status:='delivered';
    update public.notification_push_deliveries set status=v_status,delivered_at=now(),
      locked_at=null,locked_by=null,last_error_code=null where id=v_delivery.id;
  elsif p_outcome='retry' and v_delivery.attempt_count<v_delivery.max_attempts then
    v_status:='retry';
    v_retry:=least(greatest(coalesce(p_retry_after_seconds,
      (30*power(2,greatest(v_delivery.attempt_count-1,0)))::integer),15),3600);
    update public.notification_push_deliveries set status=v_status,
      next_attempt_at=now()+make_interval(secs=>v_retry),locked_at=null,locked_by=null,
      last_error_code=left(coalesce(nullif(p_error_code,''),'transient_provider_error'),120)
     where id=v_delivery.id;
  else
    v_status:='permanent_failure';
    update public.notification_push_deliveries set status=v_status,locked_at=null,locked_by=null,
      last_error_code=left(coalesce(nullif(p_error_code,''),
        case when p_outcome='invalid_token' then 'invalid_token' else 'permanent_provider_error' end),120)
     where id=v_delivery.id;
    if p_outcome='invalid_token' then
      if v_delivery.installation_id is not null then
        update public.mobile_installations set active=false,push_registered=false,
          push_token=null,push_token_hash=null,invalidated_at=now(),deactivated_at=now()
         where id=v_delivery.installation_id and push_token_hash=v_delivery.token_hash;
      elsif v_delivery.web_push_subscription_id is not null then
        update public.web_push_subscriptions
           set active=false,endpoint=null,endpoint_hash=null,p256dh=null,auth_secret=null,
               expiration_time=null,invalidated_at=now(),deactivated_at=now(),last_seen_at=now()
         where id=v_delivery.web_push_subscription_id and endpoint_hash=v_delivery.token_hash;
      end if;
    end if;
  end if;

  update public.notification_outbox o
     set attempt_count=greatest(o.attempt_count,v_delivery.attempt_count),
         available_at=case when v_status='retry' then
           (select next_attempt_at from public.notification_push_deliveries where id=v_delivery.id)
           else o.available_at end
   where o.id=v_delivery.outbox_id;

  if not exists(select 1 from public.notification_push_deliveries d
                 where d.outbox_id=v_delivery.outbox_id and d.status in('pending','sending','retry')) then
    update public.notification_outbox o
       set state=case when exists(select 1 from public.notification_push_deliveries d
                                  where d.outbox_id=o.id and d.status='delivered')
                      then 'completed' else 'dead' end,
           completed_at=case when exists(select 1 from public.notification_push_deliveries d
                                         where d.outbox_id=o.id and d.status='delivered') then now() else null end,
           dead_letter_at=case when exists(select 1 from public.notification_push_deliveries d
                                           where d.outbox_id=o.id and d.status='delivered') then null else now() end,
           last_error_code=case when exists(select 1 from public.notification_push_deliveries d
                                            where d.outbox_id=o.id and d.status='delivered') then null
                                else 'all_deliveries_failed' end
     where o.id=v_delivery.outbox_id;
  end if;
  return jsonb_build_object('id',v_delivery.id,'status',v_status,'attempt',v_delivery.attempt_count);
end
$function$;

-- Keep the application/database compatibility contract aligned with the new
-- migration without changing any health authorization behavior.
create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=public.current_branch_id();
begin
  if auth.uid() is null then raise exception 'Authenticated health check required' using errcode='42501'; end if;
  return jsonb_build_object(
    'authenticated',true,'server_time',now(),
    'migration','0095_web_push_digest_repair.sql','migration_count',95,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0095_web_push_digest_repair.sql (count 95).';

commit;

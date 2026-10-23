-- 0099 — Durable notification expansion, staff-attention transitions,
-- per-kind Push preferences and opt-in Vault/pg_net dispatcher configuration.
--
-- Applying this migration does NOT install pg_net, create a cron job or send a
-- notification. The rollout runbook enables those Staging/Production operations
-- separately. Existing Production Edge-secret configuration remains supported.

begin;

-- Historical stock facts must never become an automatic backlog when a worker
-- starts. A reviewed fresh stock transition can create a new event later; these
-- old facts remain as dead-letter evidence and are never expanded or delivered.
update public.notification_outbox
   set state='dead',dead_letter_at=coalesce(dead_letter_at,now()),
       completed_at=null,last_error_code='stale_stock_quarantined_0099',updated_at=now()
 where kind='critical_stock' and state='pending'
   and created_at<now()-interval '15 minutes';

-- Per-user, per-kind controls affect device Push only. Notification Center is
-- deliberately independent: disabling a kind never deletes or hides its Inbox.
create table if not exists public.notification_preferences(
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  online_orders boolean not null default true,
  critical_stock boolean not null default true,
  sync_failures boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from public,anon,authenticated;
grant select on table public.notification_preferences to service_role;

create or replace function public.notification_preferences_get()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_row public.notification_preferences;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into v_row from public.notification_preferences where profile_id=auth.uid();
  return jsonb_build_object(
    'online_orders',coalesce(v_row.online_orders,true),
    'critical_stock',coalesce(v_row.critical_stock,true),
    'sync_failures',coalesce(v_row.sync_failures,true)
  );
end
$function$;

create or replace function public.notification_preferences_set(
  p_online_orders boolean,p_critical_stock boolean,p_sync_failures boolean
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Active user required' using errcode='42501';
  end if;
  if p_online_orders is null or p_critical_stock is null or p_sync_failures is null then
    raise exception 'Every notification preference is required' using errcode='22023';
  end if;
  insert into public.notification_preferences(profile_id,online_orders,critical_stock,sync_failures)
  values(auth.uid(),p_online_orders,p_critical_stock,p_sync_failures)
  on conflict(profile_id) do update set
    online_orders=excluded.online_orders,critical_stock=excluded.critical_stock,
    sync_failures=excluded.sync_failures,updated_at=now();
  return public.notification_preferences_get();
end
$function$;

revoke all on function public.notification_preferences_get(),
  public.notification_preferences_set(boolean,boolean,boolean) from public,anon;
grant execute on function public.notification_preferences_get(),
  public.notification_preferences_set(boolean,boolean,boolean) to authenticated,service_role;

create or replace function public.notification_push_kind_enabled(p_user_id uuid,p_kind text)
returns boolean
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select coalesce((
    select case p_kind
      when 'online_order' then n.online_orders
      when 'critical_stock' then n.critical_stock
      when 'offline_sync_failure' then n.sync_failures
      else true end
    from public.notification_preferences n where n.profile_id=p_user_id
  ),true)
$function$;
revoke all on function public.notification_push_kind_enabled(uuid,text) from public,anon,authenticated;
grant execute on function public.notification_push_kind_enabled(uuid,text) to service_role;

-- Expand one durable business fact into its permission-filtered Inbox and
-- current device deliveries. Unique identities make trigger and worker fallback
-- idempotent. No provider network call occurs in this database transaction.
create or replace function public.notification_expand_outbox(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
#variable_conflict use_column
declare
  v_event public.notification_outbox;
  v_stock_deliverable boolean:=true;
begin
  select * into v_event from public.notification_outbox where id=p_outbox_id for update;
  if v_event.id is null or v_event.state not in('pending','processing') then return false; end if;

  -- A deferred stock fact is useful only while it is fresh and still true.
  -- Existing deliveries are unaffected: a genuine temporary Push outage still
  -- follows the bounded retry state machine after a valid expansion.
  if v_event.kind='critical_stock' then
    if v_event.created_at<now()-interval '15 minutes' then
      update public.notification_outbox set state='dead',dead_letter_at=now(),completed_at=null,
        last_error_code='stale_stock_quarantined_0099',updated_at=now() where id=v_event.id;
      return true;
    end if;
    if v_event.entity_id!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      -- Preserve the 0092 historical Inbox contract for an opaque/deleted
      -- target, but never turn that history into a provider delivery.
      v_stock_deliverable:=false;
    elsif not exists(
      select 1 from public.branch_stock_balances b
       where b.id=v_event.entity_id::uuid and b.branch_id=v_event.branch_id
    ) then
      v_stock_deliverable:=false;
    elsif not exists(
      select 1 from public.branch_stock_balances b
       where b.id=v_event.entity_id::uuid and b.branch_id=v_event.branch_id
         and b.reorder_level>0 and b.quantity<=b.reorder_level
    ) then
      update public.notification_outbox set state='dead',dead_letter_at=now(),completed_at=null,
        last_error_code='critical_stock_not_current',updated_at=now() where id=v_event.id;
      return true;
    end if;
  end if;

  update public.notification_outbox set state='processing',updated_at=now() where id=v_event.id;

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
     and m.platform in('android','ios') and v_stock_deliverable
     and public.notification_push_kind_enabled(i.user_id,v_event.kind)
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
     and (s.expiration_time is null or s.expiration_time>now()) and v_stock_deliverable
     and public.notification_push_kind_enabled(i.user_id,v_event.kind)
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
     and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
  on conflict(outbox_id,web_push_subscription_id)
    where web_push_subscription_id is not null do nothing;

  update public.notification_outbox o
     set state=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                    then 'expanded' else 'completed' end,
         expanded_at=now(),
         completed_at=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                           then null else now() end,
         last_error_code=null,updated_at=now()
   where o.id=v_event.id;
  return true;
end
$function$;
revoke all on function public.notification_expand_outbox(uuid) from public,anon,authenticated;
grant execute on function public.notification_expand_outbox(uuid) to service_role;

-- The AFTER INSERT trigger makes Inbox independent of dispatcher availability.
-- Its private exception subtransaction leaves the durable Outbox row pending if
-- expansion faults; notification_enqueue_safe/business writes still succeed.
create or replace function public.notification_expand_after_insert()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  perform public.notification_expand_outbox(new.id);
  return new;
exception when others then
  return new;
end
$function$;
revoke all on function public.notification_expand_after_insert() from public,anon,authenticated;

drop trigger if exists notification_outbox_expand_immediately on public.notification_outbox;
create trigger notification_outbox_expand_immediately
after insert on public.notification_outbox
for each row execute function public.notification_expand_after_insert();

-- Bounded, service-role retry for a pending fact whose immediate expansion was
-- deferred. Claiming remains a fallback, not the source of Notification Center.
create or replace function public.notification_process_outbox(p_event_limit integer default 20)
returns integer
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_event_id uuid; v_limit integer; v_count integer:=0;
begin
  -- Edge uses a service-role JWT; pg_cron uses the database-owner session.
  -- Execute is revoked from browser roles, so neither path is a public API.
  if coalesce(auth.role(),'')<>'service_role' and session_user not in('postgres','supabase_admin') then
    raise exception 'Service role required' using errcode='42501';
  end if;
  v_limit:=least(greatest(coalesce(p_event_limit,20),1),25);
  for v_event_id in
    select o.id from public.notification_outbox o
     where o.state='pending' and o.available_at<=now()
     order by o.created_at,o.id
     for update skip locked limit v_limit
  loop
    begin
      perform public.notification_expand_outbox(v_event_id);
      v_count:=v_count+1;
    exception when others then
      update public.notification_outbox set state='pending',available_at=now()+interval '30 seconds',
        last_error_code='expansion_retry',updated_at=now() where id=v_event_id and state='processing';
    end;
  end loop;
  return v_count;
end
$function$;
revoke all on function public.notification_process_outbox(integer) from public,anon,authenticated;
grant execute on function public.notification_process_outbox(integer) to service_role;

-- Online-order copy contains only order number and attention type. Creation is
-- one event; payment proof/resubmission has a separate stable transition key.
create or replace function public.notify_new_online_order()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare
  v_number text:=left(coalesce(nullif(btrim(new.order_number),''),'Pending number'),40);
begin
  if tg_op='INSERT' then
    if new.status='pending' then
      perform public.notification_enqueue_safe(
        'online_order:'||new.id::text,'online_order',new.branch_id,'online_order',new.id::text,
        'order',new.id::text,array['manage_online_orders'],
        'New online order '||v_number,'طلب إلكتروني جديد '||v_number,
        case when new.payment_status='verification_required'
          then 'Order '||v_number||' needs payment verification and staff review.'
          else 'Order '||v_number||' is waiting for staff review.' end,
        case when new.payment_status='verification_required'
          then 'الطلب '||v_number||' يحتاج إلى التحقق من الدفع ومراجعة الموظف.'
          else 'الطلب '||v_number||' في انتظار مراجعة الموظف.' end);
    end if;
    return new;
  end if;

  if new.status<>'cancelled' and new.payment_status='verification_required'
     and new.payment_submitted_at is not null
     and (old.payment_status is distinct from new.payment_status
       or (old.payment_submitted_at is null and new.payment_submitted_at is not null)
       or (new.payment_reference is not null
         and old.payment_reference is distinct from new.payment_reference)) then
    perform public.notification_enqueue_safe(
      -- xmin + ctid identify this exact stored transition, even when two real
      -- transitions share a transaction timestamp. They remain internal only.
      'online_order_payment:'||new.id::text||':'||new.xmin::text||':'||new.ctid::text,
      'online_order',new.branch_id,'online_order',new.id::text,
      'order',new.id::text,array['manage_online_orders'],
      'Payment review for '||v_number,'مراجعة دفع الطلب '||v_number,
      'Order '||v_number||' has payment proof requiring staff attention.',
      'الطلب '||v_number||' لديه إثبات دفع يحتاج إلى متابعة الموظف.');
  end if;
  return new;
end
$function$;
revoke all on function public.notify_new_online_order() from public,anon,authenticated;
drop trigger if exists online_orders_notify_insert on public.online_orders;
create trigger online_orders_notify_insert
after insert or update of status,payment_status,payment_submitted_at on public.online_orders
for each row execute function public.notify_new_online_order();

-- A fresh threshold crossing has one exact row-version identity. Expansion
-- re-checks the current balance before any Inbox or device delivery is created.
create or replace function public.notify_critical_stock()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.reorder_level>0 and new.quantity<=new.reorder_level
     and (tg_op='INSERT' or old.quantity>old.reorder_level or old.reorder_level=0) then
    perform public.notification_enqueue_safe(
      'critical_stock:'||new.id::text||':'||new.xmin::text||':'||new.ctid::text,
      'critical_stock',new.branch_id,'branch_stock_balance',new.id::text,
      'product',new.product_id::text,array['view_inventory'],
      'Critical stock level','مخزون عند المستوى الحرج',
      'A branch stock item reached its reorder threshold.','وصل مخزون أحد الأصناف في الفرع إلى حد إعادة الطلب.');
  end if;
  return new;
end
$function$;
revoke all on function public.notify_critical_stock() from public,anon,authenticated;
drop trigger if exists branch_stock_notify_critical on public.branch_stock_balances;
create trigger branch_stock_notify_critical after insert or update of quantity,reorder_level
on public.branch_stock_balances for each row execute function public.notify_critical_stock();

-- Pending offline work is not a failure. Only a positive unresolved-conflict
-- transition creates one stable event; repeated heartbeats do not re-alert.
create or replace function public.notify_offline_sync_failure()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.unresolved_conflict_count>0 and old.unresolved_conflict_count=0 then
    perform public.notification_enqueue_safe(
      'offline_sync_failure:'||new.id::text||':'||new.xmin::text||':'||new.ctid::text,
      'offline_sync_failure',new.branch_id,'register',new.id::text,'health','',
      array['run_health_check'],
      'Offline sync needs attention','مزامنة دون اتصال تحتاج إلى المتابعة',
      'A register reported an unresolved offline synchronization conflict.',
      'أبلغت نقطة بيع عن تعارض غير محلول في المزامنة دون اتصال.');
  end if;
  return new;
end
$function$;
revoke all on function public.notify_offline_sync_failure() from public,anon,authenticated;
drop trigger if exists registers_notify_sync_failure on public.registers;
create trigger registers_notify_sync_failure after update of unresolved_conflict_count
on public.registers for each row execute function public.notify_offline_sync_failure();

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
declare v_limit integer; v_event_limit integer;
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

  -- Immediate AFTER INSERT expansion is authoritative; this bounded pass is
  -- only an idempotent fallback for facts deferred by a transient fault.
  perform public.notification_process_outbox(v_event_limit);

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

  -- A kind switched off while work is queued becomes a terminal, audited
  -- suppression. Re-enabling later must never release an old notification.
  update public.notification_push_deliveries d
     set status='permanent_failure',last_error_code='preference_disabled',
         locked_at=null,locked_by=null,updated_at=now()
    from public.user_notification_inbox i,public.notification_outbox o
   where d.inbox_id=i.id and d.outbox_id=o.id and d.status in('pending','retry')
     and not public.notification_push_kind_enabled(d.user_id,o.kind);

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

-- Browser-safe public configuration. Only the P-256 public key can cross this
-- RPC; dispatch secrets and private/provider keys never appear in its result.
create or replace function public.notification_web_push_public_config()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_public_key text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if to_regclass('vault.decrypted_secrets') is null then
    return jsonb_build_object('public_key',null);
  end if;
  select d.decrypted_secret into v_public_key from vault.decrypted_secrets d
   where d.name='ALYQ_WEB_PUSH_VAPID_PUBLIC_KEY';
  return jsonb_build_object('public_key',v_public_key);
end
$function$;
revoke all on function public.notification_web_push_public_config() from public,anon;
grant execute on function public.notification_web_push_public_config() to authenticated,service_role;

-- Internal worker-only Vault adapter. The function returns sensitive material
-- to the service-role Edge worker, never to authenticated/anon browser roles.
create or replace function public.notification_dispatcher_config()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_config jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Vault is not configured' using errcode='55000';
  end if;
  select jsonb_object_agg(d.name,d.decrypted_secret) into v_config
    from vault.decrypted_secrets d
   where d.name in(
     'ALYQ_PUSH_DISPATCH_URL','ALYQ_PUSH_DISPATCH_SECRET',
     'ALYQ_WEB_PUSH_VAPID_PUBLIC_KEY','ALYQ_WEB_PUSH_VAPID_PRIVATE_KEY','ALYQ_WEB_PUSH_SUBJECT');
  return coalesce(v_config,'{}'::jsonb);
end
$function$;
revoke all on function public.notification_dispatcher_config() from public,anon,authenticated;
grant execute on function public.notification_dispatcher_config() to service_role;

-- One-time, compare-before-install VAPID bootstrap. Existing keys are never
-- rotated by this RPC; an identical retry is safe, a different value is refused.
create or replace function public.notification_dispatcher_install_vapid(
  p_public_key text,p_private_key text,p_subject text
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_existing jsonb; v_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'Service role required' using errcode='42501'; end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Vault is not configured' using errcode='55000';
  end if;
  if coalesce(p_public_key,'')!~'^[A-Za-z0-9_-]{87}$'
     or coalesce(p_private_key,'')!~'^[A-Za-z0-9_-]{43}$'
     or coalesce(p_subject,'')!~*'^(mailto:|https://).{1,240}$' then
    raise exception 'Invalid VAPID bootstrap material' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('alyq-web-push-vapid-bootstrap'));
  select jsonb_object_agg(d.name,d.decrypted_secret) into v_existing
    from vault.decrypted_secrets d
   where d.name in(
     'ALYQ_WEB_PUSH_VAPID_PUBLIC_KEY','ALYQ_WEB_PUSH_VAPID_PRIVATE_KEY','ALYQ_WEB_PUSH_SUBJECT');
  v_existing:=coalesce(v_existing,'{}'::jsonb);
  select count(*) into v_count from jsonb_object_keys(v_existing);
  if v_count>0 then
    if v_count=3 and v_existing->>'ALYQ_WEB_PUSH_VAPID_PUBLIC_KEY'=p_public_key
       and v_existing->>'ALYQ_WEB_PUSH_VAPID_PRIVATE_KEY'=p_private_key
       and v_existing->>'ALYQ_WEB_PUSH_SUBJECT'=p_subject then
      return jsonb_build_object('installed',false,'already_configured',true);
    end if;
    raise exception 'VAPID configuration already exists; rotation requires a reviewed operation' using errcode='23505';
  end if;
  perform vault.create_secret(p_public_key,'ALYQ_WEB_PUSH_VAPID_PUBLIC_KEY','ALYQ Web Push public application-server key');
  perform vault.create_secret(p_private_key,'ALYQ_WEB_PUSH_VAPID_PRIVATE_KEY','ALYQ Web Push private VAPID key');
  perform vault.create_secret(p_subject,'ALYQ_WEB_PUSH_SUBJECT','ALYQ Web Push operator subject');
  return jsonb_build_object('installed',true,'already_configured',false);
end
$function$;
revoke all on function public.notification_dispatcher_install_vapid(text,text,text) from public,anon,authenticated;
grant execute on function public.notification_dispatcher_install_vapid(text,text,text) to service_role;

-- Optional cron entry point. Scheduling is a separate reviewed operation. The
-- return payload contains counts/request identity only, never URL or secrets.
create or replace function public.notification_push_dispatch()
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
  v_expanded integer;
begin
  v_expanded:=public.notification_process_outbox(20);
  if to_regclass('vault.decrypted_secrets') is null or to_regclass('net.http_request_queue') is null then
    return jsonb_build_object('ok',false,'code','not_configured','expanded',v_expanded);
  end if;
  select max(case when d.name='ALYQ_PUSH_DISPATCH_URL' then d.decrypted_secret end),
         max(case when d.name='ALYQ_PUSH_DISPATCH_SECRET' then d.decrypted_secret end)
    into v_url,v_secret from vault.decrypted_secrets d
   where d.name in('ALYQ_PUSH_DISPATCH_URL','ALYQ_PUSH_DISPATCH_SECRET');
  if char_length(coalesce(v_url,'')) not between 9 and 2008
     or coalesce(v_url,'')!~'^https://.'
     or char_length(coalesce(v_secret,'')) not between 32 and 256 then
    return jsonb_build_object('ok',false,'code','not_configured','expanded',v_expanded);
  end if;
  select net.http_post(
    url:=v_url,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
    body:=jsonb_build_object('limit',50,'event_limit',20),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return jsonb_build_object('ok',true,'request_id',v_request_id,'expanded',v_expanded);
end
$function$;
revoke all on function public.notification_push_dispatch() from public,anon,authenticated;
grant execute on function public.notification_push_dispatch() to service_role;

-- Publish only the user-scoped Inbox. Realtime evaluates its authenticated
-- SELECT policy; clients receive a re-read hint, never trusted payload routing.
do $$
declare
  wanted text[] := array['user_notification_inbox'];
  table_name text;
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    raise warning 'publication supabase_realtime does not exist; Notification Center keeps its reconnect refresh';
    return;
  end if;
  foreach table_name in array wanted loop
    if exists(
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname=table_name and c.relkind='r'
    ) and not exists(
      select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename=table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I',table_name);
    end if;
  end loop;
end
$$;

-- Keep application/database compatibility aligned without changing health auth.
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
    'migration','0099_notification_reliability_and_dispatch.sql','migration_count',99,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;
revoke all on function public.system_health_probe() from public,anon;
grant execute on function public.system_health_probe() to authenticated,service_role;
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0099_notification_reliability_and_dispatch.sql (count 99).';

commit;

-- 0092 — Production mobile push outbox, delivery custody and notification center
--
-- Business facts enter one deduplicated outbox. A service-role Edge worker
-- expands each fact into a permission-filtered user inbox and device deliveries,
-- then claims only a bounded number of sends. Recipient authority is resolved
-- from CURRENT profile, active branch membership and effective capabilities;
-- mobile_installations.branch_id is metadata and is never delivery authority.
-- Raw provider tokens remain in the deny-all installation table and are exposed
-- only by the service-role claim RPC. Provider credentials never enter Postgres.

begin;

-- ── Installation lifecycle v2 ─────────────────────────────────────────────
alter table public.mobile_installations
  add column if not exists locale text not null default 'en',
  add column if not exists deactivated_at timestamptz,
  add column if not exists invalidated_at timestamptz;

do $$ begin
  alter table public.mobile_installations
    add constraint mobile_installations_locale_check check(locale in ('en','ar'));
exception when duplicate_object then null; end $$;
create or replace function public.mobile_installation_register_v2(
  p_installation_id uuid,
  p_platform text,
  p_app_version text,
  p_push_token text,
  p_locale text default 'en'
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_existing public.mobile_installations;
  v_branch uuid;
  v_profile_name text;
  v_hash text;
  v_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_installation_id is null or p_platform not in('android','ios')
     or char_length(btrim(coalesce(p_app_version,''))) not between 1 and 64
     or char_length(coalesce(p_push_token,'')) not between 16 and 4096
     or p_locale not in('en','ar') then
    raise exception 'Invalid mobile registration' using errcode='23514';
  end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Active user required' using errcode='42501';
  end if;

  v_branch:=public.current_branch_id();
  if v_branch is null then raise exception 'Active branch required' using errcode='42501'; end if;
  v_hash:=encode(digest(p_push_token,'sha256'),'hex');
  select * into v_existing from public.mobile_installations
   where installation_id=p_installation_id for update;
  if v_existing.id is not null and v_existing.user_id<>auth.uid() and v_existing.active then
    raise exception 'Installation belongs to another active user' using errcode='42501';
  end if;

  v_changed:=v_existing.id is null
    or v_existing.user_id<>auth.uid()
    or not v_existing.active
    or not v_existing.push_registered
    or v_existing.push_token_hash is distinct from v_hash
    or v_existing.platform is distinct from p_platform
    or v_existing.app_version is distinct from btrim(p_app_version)
    or v_existing.locale is distinct from p_locale;

  -- Provider token rotation/reinstall may move one token to a new installation.
  -- The old row is terminally deactivated so one token cannot target two users.
  update public.mobile_installations
     set push_token=null,push_token_hash=null,push_registered=false,active=false,
         deactivated_at=now(),last_seen_at=now()
   where push_token_hash=v_hash and installation_id<>p_installation_id;

  insert into public.mobile_installations(
    installation_id,user_id,branch_id,platform,app_version,locale,
    push_token,push_token_hash,push_registered,active,last_seen_at,
    deactivated_at,invalidated_at
  ) values(
    p_installation_id,auth.uid(),v_branch,p_platform,btrim(p_app_version),p_locale,
    p_push_token,v_hash,true,true,now(),null,null
  )
  on conflict(installation_id) do update set
    user_id=excluded.user_id,branch_id=excluded.branch_id,platform=excluded.platform,
    app_version=excluded.app_version,locale=excluded.locale,
    push_token=excluded.push_token,push_token_hash=excluded.push_token_hash,
    push_registered=true,active=true,last_seen_at=now(),
    deactivated_at=null,invalidated_at=null;

  if v_changed then
    select name into v_profile_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
    values('mobile.installation_registered','mobile_installation',p_installation_id::text,'ALYQ Mobile',
      jsonb_build_object('platform',p_platform,'app_version',btrim(p_app_version),'locale',p_locale,'push_registered',true),
      auth.uid()::text,coalesce(v_profile_name,'Staff'),v_branch,'mobile');
  end if;
  return jsonb_build_object('installation_id',p_installation_id,'active',true,
    'push_registered',true,'branch_id',v_branch,'locale',p_locale);
end
$function$;
revoke all on function public.mobile_installation_register_v2(uuid,text,text,text,text) from public,anon;
grant execute on function public.mobile_installation_register_v2(uuid,text,text,text,text) to authenticated,service_role;

create or replace function public.mobile_installations_deactivate_all()
returns integer
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_count integer:=0; v_name text; v_branch uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_branch:=public.current_branch_id();
  update public.mobile_installations
     set active=false,push_registered=false,push_token=null,push_token_hash=null,
         deactivated_at=now(),last_seen_at=now()
   where user_id=auth.uid() and (active or push_registered or push_token is not null);
  get diagnostics v_count=row_count;
  if v_count>0 then
    select name into v_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
    values('mobile.installation_deactivated','mobile_installation',auth.uid()::text,'All ALYQ Mobile installations',
      jsonb_build_object('installation_count',v_count,'everywhere',true),auth.uid()::text,
      coalesce(v_name,'Staff'),v_branch,'mobile');
  end if;
  return v_count;
end
$function$;
revoke all on function public.mobile_installations_deactivate_all() from public,anon;
grant execute on function public.mobile_installations_deactivate_all() to authenticated,service_role;

-- Keep the original single-device RPC but stamp the terminal time introduced by
-- this migration. Its ownership and token-clearing rules remain unchanged.
create or replace function public.mobile_installation_deactivate(p_installation_id uuid)
returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_changed boolean; v_branch uuid; v_profile_name text;
begin
  if auth.uid() is null or p_installation_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  update public.mobile_installations
     set active=false,push_registered=false,push_token=null,push_token_hash=null,
         deactivated_at=now(),last_seen_at=now()
   where installation_id=p_installation_id and user_id=auth.uid()
     and (active or push_registered or push_token is not null)
   returning true,branch_id into v_changed,v_branch;
  if coalesce(v_changed,false) then
    select name into v_profile_name from public.profiles where id=auth.uid();
    insert into public.audit_log(action,entity,entity_id,entity_label,details,user_id,user_name,branch_id,module)
    values('mobile.installation_deactivated','mobile_installation',p_installation_id::text,'ALYQ Mobile',
      jsonb_build_object('push_registered',false),auth.uid()::text,coalesce(v_profile_name,'Staff'),v_branch,'mobile');
  end if;
  return coalesce(v_changed,false);
end
$function$;
revoke all on function public.mobile_installation_deactivate(uuid) from public,anon;
grant execute on function public.mobile_installation_deactivate(uuid) to authenticated,service_role;

-- ── Durable outbox, inbox and delivery evidence ───────────────────────────
create table if not exists public.notification_outbox(
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  kind text not null,
  branch_id uuid not null references public.branches(id) on delete cascade,
  entity_type text not null,
  entity_id text not null,
  route_key text not null,
  route_entity_id text not null default '',
  required_capabilities text[] not null default '{}',
  title_en text not null,
  title_ar text not null,
  body_en text not null,
  body_ar text not null,
  state text not null default 'pending',
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  expanded_at timestamptz,
  completed_at timestamptz,
  dead_letter_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_outbox_kind check(kind in(
    'online_order','manager_approval','critical_stock','stock_transfer_attention',
    'return_refund_attention','offline_sync_failure')),
  constraint notification_outbox_route check(route_key in('order','approval','product','invoice','health')),
  constraint notification_outbox_state check(state in('pending','processing','expanded','completed','dead')),
  constraint notification_outbox_lengths check(
    char_length(dedupe_key) between 1 and 240 and char_length(entity_type) between 1 and 60
    and char_length(entity_id) between 1 and 120 and char_length(route_entity_id)<=120
    and char_length(title_en) between 1 and 120 and char_length(title_ar) between 1 and 120
    and char_length(body_en) between 1 and 240 and char_length(body_ar) between 1 and 240),
  constraint notification_outbox_attempts check(attempt_count>=0 and max_attempts between 1 and 10),
  constraint notification_outbox_caps check(cardinality(required_capabilities) between 1 and 8)
);
create index if not exists notification_outbox_work_idx
  on public.notification_outbox(state,available_at,created_at);
create index if not exists notification_outbox_branch_idx
  on public.notification_outbox(branch_id,created_at desc);
drop trigger if exists notification_outbox_updated_at on public.notification_outbox;
create trigger notification_outbox_updated_at before update on public.notification_outbox
for each row execute function public.set_updated_at();

create table if not exists public.user_notification_inbox(
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  kind text not null,
  entity_type text not null,
  entity_id text not null,
  route_key text not null,
  route_entity_id text not null default '',
  required_capabilities text[] not null,
  title_en text not null,
  title_ar text not null,
  body_en text not null,
  body_ar text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint user_notification_once unique(outbox_id,user_id)
);
create index if not exists user_notification_inbox_user_idx
  on public.user_notification_inbox(user_id,branch_id,created_at desc);
create index if not exists user_notification_inbox_unread_idx
  on public.user_notification_inbox(user_id,branch_id,created_at desc) where read_at is null;

create table if not exists public.notification_push_deliveries(
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  inbox_id uuid not null references public.user_notification_inbox(id) on delete cascade,
  installation_id uuid not null references public.mobile_installations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null,
  provider text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_push_once unique(outbox_id,installation_id),
  constraint notification_push_provider check(provider in('fcm','apns')),
  constraint notification_push_status check(status in('pending','sending','retry','delivered','permanent_failure')),
  constraint notification_push_token_hash check(token_hash ~ '^[0-9a-f]{64}$'),
  constraint notification_push_attempts check(attempt_count>=0 and max_attempts between 1 and 10)
);
create index if not exists notification_push_work_idx
  on public.notification_push_deliveries(status,next_attempt_at,created_at);
create index if not exists notification_push_outbox_idx
  on public.notification_push_deliveries(outbox_id,status);
drop trigger if exists notification_push_updated_at on public.notification_push_deliveries;
create trigger notification_push_updated_at before update on public.notification_push_deliveries
for each row execute function public.set_updated_at();

create table if not exists public.notification_delivery_attempts(
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_push_deliveries(id) on delete cascade,
  attempt_number integer not null,
  outcome text not null,
  http_status integer,
  error_code text,
  provider_reference_hash text,
  created_at timestamptz not null default now(),
  constraint notification_attempt_once unique(delivery_id,attempt_number),
  constraint notification_attempt_outcome check(outcome in('delivered','retry','invalid_token','permanent_failure')),
  constraint notification_attempt_number check(attempt_number between 1 and 10),
  constraint notification_attempt_http check(http_status is null or http_status between 100 and 599),
  constraint notification_attempt_ref_hash check(provider_reference_hash is null or provider_reference_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists notification_delivery_attempts_delivery_idx
  on public.notification_delivery_attempts(delivery_id,created_at desc);

comment on table public.notification_outbox is
  'Deduplicated business notification facts. Contains safe bilingual copy and opaque routing references, never provider credentials or customer/payment detail.';
comment on table public.user_notification_inbox is
  'Durable per-user notification center. Visibility is recalculated from current branch authority and capabilities.';
comment on table public.notification_push_deliveries is
  'Per-installation bounded delivery state. Raw tokens remain exclusively in mobile_installations.';
comment on table public.notification_delivery_attempts is
  'Immutable provider-safe attempt evidence. Response bodies and raw provider identifiers are never stored.';

-- Every table is deny-by-default. Authenticated users see inbox rows only through
-- current authority; all worker custody remains service_role-only.
alter table public.notification_outbox enable row level security;
alter table public.user_notification_inbox enable row level security;
alter table public.notification_push_deliveries enable row level security;
alter table public.notification_delivery_attempts enable row level security;

revoke all on public.notification_outbox,public.user_notification_inbox,
  public.notification_push_deliveries,public.notification_delivery_attempts
  from anon,authenticated,service_role;
-- The worker mutates only through the security-definer state machine below.
-- Direct service reads support diagnostics; immutable attempt evidence has no
-- UPDATE/DELETE grant, and no client role receives any table write grant.
grant select on public.notification_outbox,public.user_notification_inbox,
  public.notification_push_deliveries,public.notification_delivery_attempts to service_role;

create or replace function public.notification_user_eligible(
  p_user_id uuid,p_branch_id uuid,p_required_capabilities text[]
)
returns boolean
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select exists(
    select 1
      from public.profiles p
      join public.branches b on b.id=p_branch_id and b.active
      join public.branch_memberships m
        on m.user_id=p.id and m.branch_id=p_branch_id and m.active
     where p.id=p_user_id and p.active and p.active_branch_id=p_branch_id
       and not exists(
         select 1 from unnest(coalesce(p_required_capabilities,'{}'::text[])) capability
          where not public.branch_member_can(p_user_id,p_branch_id,capability)
       )
  )
$function$;
revoke all on function public.notification_user_eligible(uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.notification_user_eligible(uuid,uuid,text[]) to service_role;

create or replace function public.notification_route_accessible(
  p_branch_id uuid,p_route_key text,p_route_entity_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_exists boolean:=false;
begin
  if p_route_key='health' then return true; end if;
  if p_route_entity_id is null
     or p_route_entity_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then return false; end if;
  if p_route_key='order' then
    select exists(select 1 from public.online_orders where id=p_route_entity_id::uuid and branch_id=p_branch_id) into v_exists;
  elsif p_route_key='approval' then
    select exists(select 1 from public.approval_requests where id=p_route_entity_id::uuid and branch_id=p_branch_id) into v_exists;
  elsif p_route_key='product' then
    select exists(select 1 from public.products where id=p_route_entity_id::uuid and active) into v_exists;
  elsif p_route_key='invoice' then
    select exists(select 1 from public.sales where id=p_route_entity_id::uuid and branch_id=p_branch_id) into v_exists;
  end if;
  return v_exists;
end
$function$;
revoke all on function public.notification_route_accessible(uuid,text,text) from public,anon,authenticated;
grant execute on function public.notification_route_accessible(uuid,text,text) to service_role;

drop policy if exists user_notification_inbox_read on public.user_notification_inbox;
create policy user_notification_inbox_read on public.user_notification_inbox
for select to authenticated using(
  user_id=auth.uid()
  and public.notification_user_eligible(user_id,branch_id,required_capabilities)
);

-- ── Internal enqueue contract ─────────────────────────────────────────────
create or replace function public.notification_enqueue(
  p_dedupe_key text,p_kind text,p_branch_id uuid,p_entity_type text,p_entity_id text,
  p_route_key text,p_route_entity_id text,p_required_capabilities text[],
  p_title_en text,p_title_ar text,p_body_en text,p_body_ar text
)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid;
begin
  if p_branch_id is null or p_dedupe_key is null or p_kind is null or p_entity_id is null then
    raise exception 'Notification identity is required' using errcode='23514';
  end if;
  insert into public.notification_outbox(
    dedupe_key,kind,branch_id,entity_type,entity_id,route_key,route_entity_id,
    required_capabilities,title_en,title_ar,body_en,body_ar
  ) values(
    p_dedupe_key,p_kind,p_branch_id,p_entity_type,p_entity_id,p_route_key,
    coalesce(p_route_entity_id,''),p_required_capabilities,
    p_title_en,p_title_ar,p_body_en,p_body_ar
  ) on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function public.notification_enqueue(text,text,uuid,text,text,text,text,text[],text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.notification_enqueue(text,text,uuid,text,text,text,text,text[],text,text,text,text)
  to service_role;

-- Business writes must survive an isolated notification-subsystem fault. The
-- durable fact is attempted in the business transaction, but provider/push
-- plumbing can never become a new reason an order, approval or stock write fails.
create or replace function public.notification_enqueue_safe(
  p_dedupe_key text,p_kind text,p_branch_id uuid,p_entity_type text,p_entity_id text,
  p_route_key text,p_route_entity_id text,p_required_capabilities text[],
  p_title_en text,p_title_ar text,p_body_en text,p_body_ar text
)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  return public.notification_enqueue(
    p_dedupe_key,p_kind,p_branch_id,p_entity_type,p_entity_id,p_route_key,
    p_route_entity_id,p_required_capabilities,p_title_en,p_title_ar,p_body_en,p_body_ar);
exception when others then
  return null;
end
$function$;
revoke all on function public.notification_enqueue_safe(text,text,uuid,text,text,text,text,text[],text,text,text,text)
  from public,anon,authenticated;

-- ── Initial event set: transition-based and deduplicated ──────────────────
create or replace function public.notify_new_online_order()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform public.notification_enqueue_safe(
      'online_order:'||new.id::text,'online_order',new.branch_id,'online_order',new.id::text,
      'order',new.id::text,array['manage_online_orders'],
      'New online order','طلب إلكتروني جديد',
      'A new online order is waiting for review.','طلب إلكتروني جديد في انتظار المراجعة.');
  end if;
  return new;
end $function$;
drop trigger if exists online_orders_notify_insert on public.online_orders;
create trigger online_orders_notify_insert after insert or update of status on public.online_orders
for each row execute function public.notify_new_online_order();

create or replace function public.notify_manager_approval()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform public.notification_enqueue_safe(
      'manager_approval:'||new.id::text,'manager_approval',new.branch_id,'approval_request',new.id::text,
      'approval',new.id::text,array['approve_limit_request'],
      'Manager approval required','موافقة المدير مطلوبة',
      'An operational request is waiting for an authorized decision.','طلب تشغيلي في انتظار قرار مخوّل.');
  end if;
  return new;
end $function$;
drop trigger if exists approval_requests_notify_insert on public.approval_requests;
create trigger approval_requests_notify_insert after insert or update of status on public.approval_requests
for each row execute function public.notify_manager_approval();

create or replace function public.notify_critical_stock()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.reorder_level>0 and new.quantity<=new.reorder_level
     and (tg_op='INSERT' or old.quantity>old.reorder_level or old.reorder_level=0) then
    perform public.notification_enqueue_safe(
      'critical_stock:'||new.id::text||':'||(extract(epoch from new.updated_at)*1000000)::bigint::text,
      'critical_stock',new.branch_id,'branch_stock_balance',new.id::text,
      'product',new.product_id::text,array['view_inventory'],
      'Critical stock level','مخزون عند المستوى الحرج',
      'A branch stock item reached its reorder threshold.','وصل مخزون أحد الأصناف في الفرع إلى حد إعادة الطلب.');
  end if;
  return new;
end $function$;
drop trigger if exists branch_stock_notify_critical on public.branch_stock_balances;
create trigger branch_stock_notify_critical after insert or update of quantity,reorder_level
on public.branch_stock_balances for each row execute function public.notify_critical_stock();

create or replace function public.notify_stock_transfer_attention()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  perform public.notification_enqueue_safe(
    'stock_transfer_attention:'||new.id::text,'stock_transfer_attention',new.destination_branch_id,
    'stock_transfer',new.id::text,'product',new.product_id::text,array['view_inventory'],
    'Stock transfer received','تم استلام تحويل مخزون',
    'A stock transfer into this branch requires attention.','تحويل مخزون إلى هذا الفرع يحتاج إلى المتابعة.');
  return new;
end $function$;
drop trigger if exists stock_transfers_notify_insert on public.stock_transfers;
create trigger stock_transfers_notify_insert after insert on public.stock_transfers
for each row execute function public.notify_stock_transfer_attention();

create or replace function public.notify_return_refund_attention()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.status='pending' and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform public.notification_enqueue_safe(
      'return_refund_attention:'||new.id::text,'return_refund_attention',new.branch_id,
      'refund_record',new.id::text,'invoice',new.sale_id::text,
      array['approve_refund','view_sales'],
      'Refund requires attention','مسترد يحتاج إلى المتابعة',
      'A pending return refund requires an authorized decision.','مسترد مرتجع معلّق يحتاج إلى قرار مخوّل.');
  end if;
  return new;
end $function$;
drop trigger if exists refund_records_notify_insert on public.refund_records;
create trigger refund_records_notify_insert after insert or update of status on public.refund_records
for each row execute function public.notify_return_refund_attention();

create or replace function public.notify_offline_sync_failure()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.unresolved_conflict_count>0 and old.unresolved_conflict_count=0 then
    perform public.notification_enqueue_safe(
      'offline_sync_failure:'||new.id::text||':'||(extract(epoch from new.updated_at)*1000000)::bigint::text,
      'offline_sync_failure',new.branch_id,'register',new.id::text,'health','',
      array['run_health_check'],
      'Offline sync needs attention','مزامنة دون اتصال تحتاج إلى المتابعة',
      'A register reported an unresolved offline synchronization conflict.','أبلغت نقطة بيع عن تعارض غير محلول في المزامنة دون اتصال.');
  end if;
  return new;
end $function$;
drop trigger if exists registers_notify_sync_failure on public.registers;
create trigger registers_notify_sync_failure after update of unresolved_conflict_count
on public.registers for each row execute function public.notify_offline_sync_failure();

-- Trigger functions are not client APIs.
revoke all on function public.notify_new_online_order(),public.notify_manager_approval(),
  public.notify_critical_stock(),public.notify_stock_transfer_attention(),
  public.notify_return_refund_attention(),public.notify_offline_sync_failure()
  from public,anon,authenticated;

-- ── Notification Center RPCs ──────────────────────────────────────────────
create or replace function public.notification_center_list(
  p_limit integer default 100,p_before timestamptz default null
)
returns table(
  id uuid,kind text,branch_id uuid,entity_type text,entity_id text,
  route_key text,route_entity_id text,title_en text,title_ar text,
  body_en text,body_ar text,read_at timestamptz,created_at timestamptz
)
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select i.id,i.kind,i.branch_id,i.entity_type,i.entity_id,i.route_key,i.route_entity_id,
         i.title_en,i.title_ar,i.body_en,i.body_ar,i.read_at,i.created_at
    from public.user_notification_inbox i
   where auth.uid() is not null and i.user_id=auth.uid()
     and i.branch_id=public.current_branch_id()
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
     and (p_before is null or i.created_at<p_before)
   order by i.created_at desc,i.id desc
   limit least(greatest(coalesce(p_limit,100),1),100)
$function$;

create or replace function public.notification_center_unread_count()
returns integer
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select count(*)::integer from public.user_notification_inbox i
   where auth.uid() is not null and i.user_id=auth.uid() and i.read_at is null
     and i.branch_id=public.current_branch_id()
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
$function$;

create or replace function public.notification_center_mark_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_changed boolean;
begin
  if auth.uid() is null or p_notification_id is null then return false; end if;
  update public.user_notification_inbox i set read_at=coalesce(i.read_at,now())
   where i.id=p_notification_id and i.user_id=auth.uid()
     and i.branch_id=public.current_branch_id()
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
   returning true into v_changed;
  return coalesce(v_changed,false);
end
$function$;

create or replace function public.notification_center_mark_all_read()
returns integer
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_count integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.user_notification_inbox i set read_at=now()
   where i.user_id=auth.uid() and i.read_at is null
     and i.branch_id=public.current_branch_id()
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities);
  get diagnostics v_count=row_count;
  return v_count;
end
$function$;

create or replace function public.notification_center_resolve_route(p_notification_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_note public.user_notification_inbox; v_exists boolean:=false;
begin
  if auth.uid() is null or p_notification_id is null then
    return jsonb_build_object('ok',false,'reason','unavailable');
  end if;
  select * into v_note from public.user_notification_inbox i
   where i.id=p_notification_id and i.user_id=auth.uid()
     and i.branch_id=public.current_branch_id()
     and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities);
  if v_note.id is null then return jsonb_build_object('ok',false,'reason','unauthorized_or_stale'); end if;
  v_exists:=public.notification_route_accessible(
    v_note.branch_id,v_note.route_key,v_note.route_entity_id);
  if not v_exists then return jsonb_build_object('ok',false,'reason','entity_unavailable'); end if;
  return jsonb_build_object('ok',true,'notification_id',v_note.id,'route_key',v_note.route_key,
    'entity_id',v_note.route_entity_id,'branch_id',v_note.branch_id);
end
$function$;

revoke all on function public.notification_center_list(integer,timestamptz),
  public.notification_center_unread_count(),public.notification_center_mark_read(uuid),
  public.notification_center_mark_all_read(),public.notification_center_resolve_route(uuid)
  from public,anon;
grant execute on function public.notification_center_list(integer,timestamptz),
  public.notification_center_unread_count(),public.notification_center_mark_read(uuid),
  public.notification_center_mark_all_read(),public.notification_center_resolve_route(uuid)
  to authenticated,service_role;

-- ── Bounded service-role worker contract ──────────────────────────────────
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

  -- A crashed invocation cannot own work forever. Preserve immutable timeout
  -- evidence before releasing the lock; attempts remain bounded.
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
      outbox_id,inbox_id,installation_id,user_id,token_hash,provider,max_attempts
    )
    select v_event.id,i.id,m.id,i.user_id,m.push_token_hash,
      case when m.platform='android' then 'fcm' else 'apns' end,v_event.max_attempts
      from public.user_notification_inbox i
      join public.mobile_installations m on m.user_id=i.user_id
     where i.outbox_id=v_event.id and m.active and m.push_registered
       and m.push_token is not null and m.push_token_hash is not null
       and m.platform in('android','ios')
       and public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
    on conflict(outbox_id,installation_id) do nothing;

    update public.notification_outbox o
       set state=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                      then 'expanded' else 'completed' end,
           expanded_at=now(),
           completed_at=case when exists(select 1 from public.notification_push_deliveries d where d.outbox_id=o.id)
                             then null else now() end
     where o.id=v_event.id;
  end loop;

  -- Re-check authority and the exact token snapshot immediately before send.
  update public.notification_push_deliveries d
     set status='permanent_failure',last_error_code='recipient_or_installation_ineligible',
         locked_at=null,locked_by=null
    from public.user_notification_inbox i,public.mobile_installations m
   where d.inbox_id=i.id and d.installation_id=m.id
     and d.status in('pending','retry')
     and (not public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
       or not public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
       or not m.active or not m.push_registered or m.push_token is null
       or m.push_token_hash is distinct from d.token_hash);

  -- Terminal states can also arise during stale-lock recovery or current-
  -- authority rechecks, not only through record_push_result. Aggregate them so
  -- no outbox fact is stranded in `expanded` forever.
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
  select d.id,i.id,m.platform,m.locale,m.push_token,o.kind,
    case when m.locale='ar' then o.title_ar else o.title_en end,
    case when m.locale='ar' then o.body_ar else o.body_en end,
    o.route_key,o.route_entity_id,encode(digest(o.dedupe_key,'sha256'),'hex'),d.attempt_count
    from claimed d
    join public.notification_outbox o on o.id=d.outbox_id
    join public.user_notification_inbox i on i.id=d.inbox_id
    join public.mobile_installations m on m.id=d.installation_id
   where public.notification_user_eligible(i.user_id,i.branch_id,i.required_capabilities)
     and public.notification_route_accessible(i.branch_id,i.route_key,i.route_entity_id)
     and m.active and m.push_registered and m.push_token_hash=d.token_hash;
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
    else encode(digest(p_provider_reference,'sha256'),'hex') end;
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
      update public.mobile_installations set active=false,push_registered=false,
        push_token=null,push_token_hash=null,invalidated_at=now(),deactivated_at=now()
       where id=v_delivery.installation_id and push_token_hash=v_delivery.token_hash;
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

revoke all on function public.notification_claim_push_batch(text,integer,integer),
  public.notification_record_push_result(uuid,text,text,integer,text,text,integer)
  from public,anon,authenticated;
grant execute on function public.notification_claim_push_batch(text,integer,integer),
  public.notification_record_push_result(uuid,text,text,integer,text,text,integer)
  to service_role;

-- Notification facts are operational data. A factory reset clears them in the
-- same transaction when its immutable reset-start audit row is created.
create or replace function public.notification_factory_reset_cleanup()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $function$ begin
  if new.action='system.reset.started' and new.entity_id='factory' then
    delete from public.notification_outbox;
  end if;
  return new;
end $function$;
drop trigger if exists audit_notification_factory_reset_cleanup on public.audit_log;
create trigger audit_notification_factory_reset_cleanup after insert on public.audit_log
for each row execute function public.notification_factory_reset_cleanup();
revoke all on function public.notification_factory_reset_cleanup() from public,anon,authenticated;

-- Health contract advances with the forward-only migration.
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
    'migration','0092_mobile_push_and_notification_center.sql','migration_count',92,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch));
end
$function$;
revoke all on function public.system_health_probe() from public,anon;
grant execute on function public.system_health_probe() to authenticated,service_role;
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0092_mobile_push_and_notification_center.sql (count 92).';

commit;

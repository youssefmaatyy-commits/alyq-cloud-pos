-- 0054 — Phase 50: governorate delivery controls and order snapshots.
-- Extends the existing delivery_zones architecture; no second shipping table.

alter table public.delivery_zones
  add column if not exists show_estimated_delivery boolean not null default true;

alter table public.online_orders
  add column if not exists delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  add column if not exists delivery_zone_name_en text,
  add column if not exists delivery_zone_name_ar text,
  add column if not exists delivery_free_shipping boolean not null default false;

-- The existing place_online_order RPC already validates the selected zone and
-- calculates the fee/minimum/threshold server-side. It records the selected
-- zone in address.zone_id/zone_name. This trigger turns that authoritative
-- result into explicit, rename-proof order snapshot columns without duplicating
-- checkout pricing logic or trusting a client fee.
create or replace function public.online_order_delivery_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone public.delivery_zones%rowtype;
  v_zone_id uuid;
begin
  if new.delivery_type = 'delivery'
     and nullif(new.address->>'zone_id', '') is not null then
    begin
      v_zone_id := (new.address->>'zone_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invalid delivery zone' using errcode = 'check_violation';
    end;
    select * into v_zone from public.delivery_zones where id = v_zone_id;
    if not found then
      raise exception 'Delivery zone is not available' using errcode = 'check_violation';
    end if;
    new.delivery_zone_id := v_zone.id;
    new.delivery_zone_name_en := v_zone.name_en;
    new.delivery_zone_name_ar := v_zone.name_ar;
    new.delivery_free_shipping := coalesce(new.delivery_fee, 0) = 0;
  elsif new.delivery_type = 'pickup' then
    new.delivery_zone_id := null;
    new.delivery_zone_name_en := null;
    new.delivery_zone_name_ar := null;
    new.delivery_free_shipping := false;
  end if;
  return new;
end;
$$;

drop trigger if exists online_order_delivery_snapshot on public.online_orders;
create trigger online_order_delivery_snapshot
  before insert or update of delivery_type, address, delivery_fee
  on public.online_orders
  for each row execute function public.online_order_delivery_snapshot();

comment on column public.delivery_zones.show_estimated_delivery is
  'Whether the configured localized delivery estimate is shown to shoppers.';
comment on column public.online_orders.delivery_zone_id is
  'Authoritative governorate/zone identity captured at order time.';
comment on column public.online_orders.delivery_free_shipping is
  'Whether this order actually received free zone shipping; historical snapshot.';

revoke execute on function public.online_order_delivery_snapshot() from public, anon, authenticated;

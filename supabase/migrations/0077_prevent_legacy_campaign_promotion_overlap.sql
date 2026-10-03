-- 0077 — Make the central promotion engine the single automatic-discount
-- authority wherever legacy storefront campaigns would otherwise overlap it.
--
-- Legacy campaigns and central automatic promotions are both still retained:
-- old campaign presentation remains readable and historical invoices remain
-- immutable.  An active campaign may coexist with POS-only promotions and with
-- non-overlapping online targets.  It may not cover the same product/window as
-- an enabled online automatic promotion, because the old checkout path could
-- otherwise discount that merchandise twice.

begin;

create or replace function public.assert_campaign_has_no_central_promotion_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if new.active and exists (
    select 1
      from public.promotions p
     where p.enabled
       and coalesce(p.mode, 'automatic') = 'automatic'
       and p.channel in ('online', 'both')
       and coalesce(p.ends_at, 'infinity'::timestamptz) >= new.starts_at
       and coalesce(p.starts_at, '-infinity'::timestamptz) <= new.ends_at
       and (
         jsonb_array_length(new.product_ids) = 0
         or p.scope = 'store'
         or exists (
           select 1
             from public.promotion_targets pt
            where pt.promotion_id = p.id
              and (
                (pt.target_kind = 'product' and new.product_ids ? pt.target_id::text)
                or (pt.target_kind = 'category' and exists (
                  select 1 from public.products product
                   where product.category_id = pt.target_id
                     and new.product_ids ? product.id::text
                ))
                or (pt.target_kind = 'variant' and exists (
                  select 1 from public.product_variants variant
                   where variant.id = pt.target_id
                     and new.product_ids ? variant.product_id::text
                ))
              )
         )
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'legacy campaign overlaps an enabled central automatic promotion',
      hint = 'Use the central Promotions module for this product and window, or disable/scope one offer so the discounts cannot overlap.';
  end if;
  return new;
end
$function$;

create or replace function public.assert_central_promotion_has_no_campaign_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if new.enabled
     and coalesce(new.mode, 'automatic') = 'automatic'
     and new.channel in ('online', 'both')
     and exists (
       select 1
         from public.campaigns c
        where c.active
          and c.ends_at >= coalesce(new.starts_at, '-infinity'::timestamptz)
          and c.starts_at <= coalesce(new.ends_at, 'infinity'::timestamptz)
          and (
            jsonb_array_length(c.product_ids) = 0
            or new.scope = 'store'
            or exists (
              select 1
                from public.promotion_targets pt
               where pt.promotion_id = new.id
                 and (
                   (pt.target_kind = 'product' and c.product_ids ? pt.target_id::text)
                   or (pt.target_kind = 'category' and exists (
                     select 1 from public.products product
                      where product.category_id = pt.target_id
                        and c.product_ids ? product.id::text
                   ))
                   or (pt.target_kind = 'variant' and exists (
                     select 1 from public.product_variants variant
                      where variant.id = pt.target_id
                        and c.product_ids ? variant.product_id::text
                   ))
                 )
            )
          )
     ) then
    raise exception using
      errcode = '23514',
      message = 'central automatic promotion overlaps an active legacy campaign',
      hint = 'Disable the legacy campaign and keep the offer in the central Promotions module.';
  end if;
  return new;
end
$function$;

create or replace function public.assert_promotion_target_has_no_campaign_overlap()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  if exists (
    select 1
      from public.promotions p
      join public.campaigns c
        on c.active
       and c.ends_at >= coalesce(p.starts_at, '-infinity'::timestamptz)
       and c.starts_at <= coalesce(p.ends_at, 'infinity'::timestamptz)
     where p.id = new.promotion_id
       and p.enabled
       and coalesce(p.mode, 'automatic') = 'automatic'
       and p.channel in ('online', 'both')
       and (
         jsonb_array_length(c.product_ids) = 0
         or (new.target_kind = 'product' and c.product_ids ? new.target_id::text)
         or (new.target_kind = 'category' and exists (
           select 1 from public.products product
            where product.category_id = new.target_id
              and c.product_ids ? product.id::text
         ))
         or (new.target_kind = 'variant' and exists (
           select 1 from public.product_variants variant
            where variant.id = new.target_id
              and c.product_ids ? variant.product_id::text
         ))
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'promotion target overlaps an active legacy campaign',
      hint = 'Disable the legacy campaign and keep the offer in the central Promotions module.';
  end if;
  return new;
end
$function$;

-- Resolve a pre-existing ambiguity in favour of the newer central engine.  This
-- is configuration only: no historical order, sale, campaign or snapshot is
-- deleted or repriced.
update public.campaigns c
   set active = false,
       updated_at = now()
 where c.active
   and exists (
     select 1
       from public.promotions p
      where p.enabled
        and coalesce(p.mode, 'automatic') = 'automatic'
        and p.channel in ('online', 'both')
        and coalesce(p.ends_at, 'infinity'::timestamptz) >= c.starts_at
        and coalesce(p.starts_at, '-infinity'::timestamptz) <= c.ends_at
        and (
          jsonb_array_length(c.product_ids) = 0
          or p.scope = 'store'
          or exists (
            select 1
              from public.promotion_targets pt
             where pt.promotion_id = p.id
               and (
                 (pt.target_kind = 'product' and c.product_ids ? pt.target_id::text)
                 or (pt.target_kind = 'category' and exists (
                   select 1 from public.products product
                    where product.category_id = pt.target_id
                      and c.product_ids ? product.id::text
                 ))
                 or (pt.target_kind = 'variant' and exists (
                   select 1 from public.product_variants variant
                    where variant.id = pt.target_id
                      and c.product_ids ? variant.product_id::text
                 ))
               )
          )
        )
   );

drop trigger if exists campaigns_reject_central_overlap on public.campaigns;
create trigger campaigns_reject_central_overlap
before insert or update of active, starts_at, ends_at, product_ids
on public.campaigns
for each row execute function public.assert_campaign_has_no_central_promotion_overlap();

drop trigger if exists promotions_reject_campaign_overlap on public.promotions;
create trigger promotions_reject_campaign_overlap
before insert or update of enabled, mode, channel, scope, starts_at, ends_at
on public.promotions
for each row execute function public.assert_central_promotion_has_no_campaign_overlap();

drop trigger if exists promotion_targets_reject_campaign_overlap on public.promotion_targets;
create trigger promotion_targets_reject_campaign_overlap
before insert or update of promotion_id, target_kind, target_id
on public.promotion_targets
for each row execute function public.assert_promotion_target_has_no_campaign_overlap();

comment on function public.assert_campaign_has_no_central_promotion_overlap() is
  'Fail-closed guard preventing a legacy storefront campaign and central online automatic promotion from discounting the same merchandise in the same window.';
comment on function public.assert_central_promotion_has_no_campaign_overlap() is
  'Reciprocal overlap guard for central automatic promotion writes. POS-only promotions are deliberately outside the legacy storefront campaign domain.';
comment on function public.assert_promotion_target_has_no_campaign_overlap() is
  'Guards target changes made after a targeted central automatic promotion has been enabled.';

commit;

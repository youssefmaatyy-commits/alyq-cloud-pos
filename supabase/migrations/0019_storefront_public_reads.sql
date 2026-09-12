-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — Public storefront reads: what is actually selling.
--
-- The homepage's "Best sellers" row is derived from real demand: units sold at
-- the till plus units ordered on the website. Neither `sale_items` nor
-- `online_order_items` is readable by an anonymous visitor — staff see them
-- through `manage_online_orders` / the sales policies, and a shopper must not be
-- able to read the shop's revenue line by line.
--
-- So the derivation happens server-side and only the *answer* is published:
-- product ids and a unit count, for products that are on the website anyway.
-- No money, no customer, no order number leaves the database, and there is
-- nothing for a client to mis-aggregate or cache stale.
--
-- `security definer` + `stable` + a fixed `search_path`: the same shape the
-- checkout functions use, and the reason an anonymous caller can run it at all.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.storefront_best_sellers(p_limit integer default 8)
returns table (product_id uuid, units bigint)
language sql
stable
security definer
set search_path = public
as $$
  select demand.product_id, sum(demand.units) as units
  from (
    -- The till: a voided sale is a reversal, not demand.
    select si.product_id, si.quantity::bigint as units
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.status <> 'voided'

    union all

    -- The website: a cancelled order is not demand either. A *pending* one is —
    -- somebody wanted it, and waiting for approval would make this list lag by
    -- however long the queue takes.
    select oi.product_id, oi.quantity::bigint as units
    from public.online_order_items oi
    join public.online_orders o on o.id = oi.order_id
    where o.status <> 'cancelled'
  ) demand
  -- Only products a visitor could click through to: publishing the rank of a
  -- product that is off the website would advertise something unbuyable.
  join public.products p
    on p.id = demand.product_id
   and p.active
   and p.show_on_website
  group by demand.product_id
  order by sum(demand.units) desc, demand.product_id
  limit greatest(coalesce(p_limit, 8), 1);
$$;

-- Guests read the homepage: that is the whole point of publishing it.
grant execute on function public.storefront_best_sellers(integer) to anon, authenticated;

comment on function public.storefront_best_sellers(integer) is
  'Top-selling website products by units (POS sales excluding voids + online orders excluding cancellations). Publishes ids and counts only.';

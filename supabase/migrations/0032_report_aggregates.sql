-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0032 — report aggregation in the database
--
-- Phase 22 made report reads bounded, date-filtered in SQL, paged, counted and
-- honest about truncation. It could not make them COMPLETE: aggregation still
-- happened in the browser over at most SALES_ROW_CAP (1,000) invoices, so a
-- period wider than the cap showed correct-looking numbers for the most recent
-- thousand sales and said so in a coverage line. Honest, but not right — a shop
-- with three years of history cannot read its own year.
--
-- This moves SUM / COUNT / GROUP BY / day-bucketing into PostgreSQL, so a total
-- is computed over every row in the period and the browser receives a handful of
-- numbers instead of a thousand invoices.
--
-- FOUR RULES THIS FILE OBEYS, each because breaking it changes a number:
--
--   1. SECURITY INVOKER, not definer. `sales`, `sale_items`, `sale_payments` and
--      `products` are already `for select to authenticated using (true)`, and
--      `expenses` is gated by `can('view_shifts')`. Running as the caller means
--      row level security keeps applying exactly as it does today, so these
--      functions cannot widen what anybody sees — a definer aggregate could, and
--      "the report RPC leaked rows the screen never showed" is not a risk worth
--      taking for no benefit. Each function still refuses a caller without
--      `view_reports`, which is the capability `reportAccess.ts` already names as
--      "may this person see the numbers", so the database and the UI answer the
--      same question with the same word.
--
--   2. Return the ADDITIVE parts only — counts, integer units, money sums. No
--      percentages, no averages. `salesAnalytics.ts` computes a share with
--      `roundMoney(part / whole * 100)` and answers 0 when the denominator is 0;
--      re-expressing that in SQL would give the same figure two definitions and
--      one of them would eventually drift. The client keeps the derived
--      arithmetic, the database keeps the aggregation.
--
--   3. Mirror the existing semantics exactly, including the awkward ones, because
--      each is a decision somebody already made and tested:
--        · a voided invoice is not a sale (`revenueSales`);
--        · cost of goods is units × the product's CURRENT cost, and a product
--          deleted since the sale costs 0 (`costOfGoodsSold`);
--        · a sale with no payment rows attributes its whole total to
--          `payment_method`, or cash, and takes paid/pending from
--          `payment_status` (`paymentTotals`) — hence the left join and coalesce;
--        · product "invoices" counts ITEM LINES, not distinct invoices, because
--          that is what `productPerformance` increments;
--        · `stockValue` uses raw stock_quantity even for an untracked product,
--          while `stock` is 0 for one — the two columns answer different
--          questions and the difference is deliberate;
--        · expenses filter on `spent_at`, returns and refunds on `created_at`,
--          sales on `created_at`, matching ReportsPage's own filters.
--
--   4. The caller owns "what a day is". `dayKeyOf` buckets by the BROWSER's local
--      calendar day, and Phase 22 already pushed inclusive local-day bounds down
--      as timestamps. So the bounds arrive as timestamptz from the existing
--      `toTimestampBounds()`, and day bucketing takes the caller's IANA ZONE NAME
--      rather than trusting the server's TimeZone — a shop in Cairo and its
--      database in UTC would otherwise disagree about which day a 23:30 sale
--      belongs to.
--      A name and not a UTC offset, which is the subtler half of the point:
--      Egypt observes daylight saving, so a window spanning April or October
--      contains TWO offsets, and any single number moves every late-evening
--      invoice of the other season into the wrong day. Nothing throws; the day
--      series simply disagrees with the one the browser drew. The first draft of
--      this migration took an offset in minutes and was wrong for half the year —
--      the differential suite (scripts/reports.aggregates.mjs §6) caught it.
--
-- Money columns are numeric(14,2), so every sum here is exact at two decimals
-- and no rounding rule is needed — which is why the client's `money()` and this
-- file cannot disagree about a total.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the financial report, and the dashboard's headline numbers ─────────
-- Mirrors computeFinancialTotals() field for field.
create or replace function public.reports_financial_summary(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  with live as (
    select s.id, s.total
      from public.sales s
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
  ),
  -- paymentTotals(): one row per payment, or one synthetic row for an invoice
  -- that has none, carrying the invoice's own method/status and full total.
  pay as (
    select coalesce(p.method, s.payment_method)::text as method,
           coalesce(p.amount, s.total)                as amount,
           coalesce(p.status, s.payment_status)::text as status
      from public.sales s
      left join public.sale_payments p on p.sale_id = s.id
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
  ),
  lines as (
    select coalesce(sum(si.quantity), 0)                            as units,
           coalesce(sum(si.quantity * coalesce(pr.cost_price, 0)), 0) as cogs
      from public.sale_items si
      join public.sales s   on s.id  = si.sale_id
      left join public.products pr on pr.id = si.product_id
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
  ),
  spent as (
    select coalesce(sum(e.amount), 0) as total
      from public.expenses e
     where (p_from is null or e.spent_at >= p_from)
       and (p_to   is null or e.spent_at <= p_to)
  ),
  gone as (
    select count(*) as n, coalesce(sum(s.total), 0) as total
      from public.sales s
     where s.status = 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
  ),
  rets as (
    select count(*) as n, coalesce(sum(r.refund_amount), 0) as total
      from public.sales_returns r
     where (p_from is null or r.created_at >= p_from)
       and (p_to   is null or r.created_at <= p_to)
  ),
  refunds as (
    select count(*) as n,
           coalesce(sum(r.amount) filter (where r.status = 'completed'), 0) as paid,
           coalesce(sum(r.amount) filter (where r.status = 'pending'),   0) as pending
      from public.refund_records r
     where (p_from is null or r.created_at >= p_from)
       and (p_to   is null or r.created_at <= p_to)
  ),
  totals as (
    select (select count(*)                 from live) as invoice_count,
           (select coalesce(sum(total), 0)  from live) as revenue,
           (select cogs                     from lines) as cogs,
           (select units                    from lines) as units,
           (select total                    from spent) as expenses
  )
  select jsonb_build_object(
    'invoiceCount',   t.invoice_count,
    'revenue',        t.revenue,
    'cogs',           t.cogs,
    'grossProfit',    t.revenue - t.cogs,
    'expenses',       t.expenses,
    'netProfit',      t.revenue - t.cogs - t.expenses,
    'cash',           (select coalesce(sum(amount), 0) from pay where method = 'cash'),
    'card',           (select coalesce(sum(amount), 0) from pay where method = 'visa'),
    'instapay',       (select coalesce(sum(amount), 0) from pay where method = 'instapay'),
    'unsettled',      (select coalesce(sum(amount), 0) from pay where status <> 'paid'),
    'voidedCount',    (select n     from gone),
    'voidedTotal',    (select total from gone),
    'returnsCount',   (select n     from rets),
    'returnsTotal',   (select total from rets),
    'refundsCount',   (select n       from refunds),
    'refundsPaid',    (select paid    from refunds),
    'refundsPending', (select pending from refunds),
    'unitCount',      t.units
  )
  into v
  from totals t;

  return v;
end
$$;

comment on function public.reports_financial_summary(timestamptz, timestamptz) is
  'Financial totals for a period, computed over every invoice in it rather than '
  'the most recent 1,000. Mirrors computeFinancialTotals() exactly. SECURITY '
  'INVOKER: RLS still decides which rows the caller may aggregate. Returns the '
  'additive parts only; percentages and averages stay in the client so no figure '
  'has two definitions.';

-- ── 2. the sales report: totals, payment mix, per employee, per day ───────
-- Mirrors salesByPaymentMethod(), salesByEmployee() and salesTrend().
create or replace function public.reports_sales_summary(
  p_from              timestamptz default null,
  p_to                timestamptz default null,
  p_timezone          text        default 'UTC'
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v    jsonb;
  v_tz text;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  -- The caller NAMES its timezone instead of sending an offset, because an
  -- offset is only true for one instant. Egypt observes daylight saving, so a
  -- window spanning April or October contains two different offsets, and a
  -- single number quietly moves every late-evening invoice into the wrong day —
  -- the same silent failure dateRanges.ts warns about, one layer down. Given
  -- the zone name, Postgres applies the correct offset to each timestamp.
  -- An unrecognised name degrades to UTC rather than failing the whole report.
  v_tz := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;

  with live as (
    select s.id, s.total, s.discount_amount, s.user_id, s.user_name,
           -- the caller's local calendar day, not the server's
           to_char(s.created_at AT TIME ZONE v_tz, 'YYYY-MM-DD') as day
      from public.sales s
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
  ),
  units as (
    select l.id, coalesce(sum(si.quantity), 0) as units
      from live l
      left join public.sale_items si on si.sale_id = l.id
     group by l.id
  ),
  by_method as (
    select coalesce(p.method, s.payment_method)::text as method,
           -- "invoices that used this method at all": a split payment counts in
           -- both, so this is a distinct count of invoices, not of payments.
           count(distinct s.id)                       as invoices,
           coalesce(sum(coalesce(p.amount, s.total)), 0) as amount,
           coalesce(sum(coalesce(p.amount, s.total))
                      filter (where coalesce(p.status, s.payment_status)::text = 'paid'), 0) as paid,
           coalesce(sum(coalesce(p.amount, s.total))
                      filter (where coalesce(p.status, s.payment_status)::text <> 'paid'), 0) as pending
      from public.sales s
      left join public.sale_payments p on p.sale_id = s.id
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
     group by 1
  ),
  by_employee as (
    select l.user_id, l.user_name,
           count(*)               as invoices,
           coalesce(sum(u.units), 0)          as units,
           coalesce(sum(l.total), 0)          as revenue,
           coalesce(sum(l.discount_amount), 0) as discounts
      from live l
      left join units u on u.id = l.id
     group by l.user_id, l.user_name
  ),
  -- salesTrend() FILLS the series when both bounds are known: a quiet day is a
  -- zero, not a gap, because a trend line that skips quiet days draws a shop
  -- that never has any. With an open bound only days that happened are returned.
  days as (
    select to_char(d.day, 'YYYY-MM-DD') as date
      from generate_series(
             (p_from AT TIME ZONE v_tz)::date,
             (p_to   AT TIME ZONE v_tz)::date,
             interval '1 day') as d(day)
     where p_from is not null and p_to is not null
  ),
  happened as (
    select l.day as date,
           count(*)                        as invoices,
           coalesce(sum(u.units), 0)       as units,
           coalesce(sum(l.total), 0)       as revenue,
           coalesce(sum(l.discount_amount), 0) as discounts
      from live l
      left join units u on u.id = l.id
     group by l.day
  ),
  by_day as (
    select coalesce(d.date, h.date)          as date,
           coalesce(h.invoices, 0)           as invoices,
           coalesce(h.units, 0)              as units,
           coalesce(h.revenue, 0)            as revenue,
           coalesce(h.discounts, 0)          as discounts
      from days d
      full outer join happened h on h.date = d.date
  )
  select jsonb_build_object(
    'invoices',  (select count(*)                from live),
    'revenue',   (select coalesce(sum(total), 0) from live),
    'discounts', (select coalesce(sum(discount_amount), 0) from live),
    'units',     (select coalesce(sum(units), 0) from units),
    'voidedCount', (select count(*) from public.sales s
                     where s.status = 'voided'
                       and (p_from is null or s.created_at >= p_from)
                       and (p_to   is null or s.created_at <= p_to)),
    'byMethod',   coalesce((select jsonb_agg(jsonb_build_object(
                     'method', m.method, 'invoices', m.invoices, 'amount', m.amount,
                     'paid', m.paid, 'pending', m.pending)
                     -- salesByPaymentMethod() sorts by PAYMENT_METHODS order, not by
                     -- size: cash, instapay, visa, cod. `payment_method` is an enum
                     -- declared in exactly that order, so the enum's own ordering is
                     -- the app's ordering and the rows land where the screen expects.
                     order by m.method)
                   from by_method m), '[]'::jsonb),
    'byEmployee', coalesce((select jsonb_agg(jsonb_build_object(
                     'userId', e.user_id, 'userName', e.user_name, 'invoices', e.invoices,
                     'units', e.units, 'revenue', e.revenue, 'discounts', e.discounts)
                     order by e.revenue desc, e.invoices desc, e.user_name)
                   from by_employee e), '[]'::jsonb),
    'byDay',      coalesce((select jsonb_agg(jsonb_build_object(
                     'date', d.date, 'invoices', d.invoices, 'units', d.units,
                     'revenue', d.revenue, 'discounts', d.discounts) order by d.date)
                   from by_day d), '[]'::jsonb)
  )
  into v;

  return v;
end
$$;

comment on function public.reports_sales_summary(timestamptz, timestamptz, text) is
  'Sales totals, payment mix, per-employee and per-day aggregates for a period. '
  'p_timezone is the CALLER''s IANA zone name, because dayKeyOf() buckets by the '
  'browser''s local day and the server may be in another zone. A name rather than '
  'an offset: a zone that observes daylight saving has two offsets inside one '
  'report window, and only Postgres knows which applies to a given instant. The '
  'day series is filled with zeros across the range when both bounds are given, '
  'exactly as salesTrend() does.';

-- ── 3. product performance ────────────────────────────────────────────────
-- Mirrors productPerformance(). Every catalogue product gets a row, sold or
-- not: "slow mover" is only meaningful against the things that did not move.
create or replace function public.reports_product_performance(
  p_from timestamptz default null,
  p_to   timestamptz default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  with sold as (
    select si.product_id,
           count(*)                        as invoices,  -- item LINES, as the client counts them
           coalesce(sum(si.quantity), 0)   as units,
           coalesce(sum(si.line_total), 0) as revenue
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
     where s.status <> 'voided'
       and (p_from is null or s.created_at >= p_from)
       and (p_to   is null or s.created_at <= p_to)
     group by si.product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'productId',    p.id,
           'sku',          p.sku,
           'nameEn',       p.name_en,
           'nameAr',       p.name_ar,
           'sold',         s.product_id is not null,
           'invoices',     coalesce(s.invoices, 0),
           'units',        coalesce(s.units, 0),
           'revenue',      coalesce(s.revenue, 0),
           'sellingPrice', p.selling_price,
           -- units × the CURRENT cost: costOfGoodsSold's convention
           'cost',         coalesce(s.units, 0) * coalesce(p.cost_price, 0),
           -- raw stock, deliberately NOT gated on tracking, because stockValue
           -- and `stock` answer different questions in the client too
           'stockValue',   coalesce(p.stock_quantity, 0) * coalesce(p.cost_price, 0),
           'stock',        case when p.stock_tracking_enabled
                                then coalesce(p.stock_quantity, 0) else 0 end
         ) order by coalesce(s.revenue, 0) desc, p.name_en), '[]'::jsonb)
    into v
    from public.products p
    left join sold s on s.product_id = p.id;

  return v;
end
$$;

comment on function public.reports_product_performance(timestamptz, timestamptz) is
  'Per-product units, revenue and cost for a period, one row per catalogue '
  'product whether or not it sold. Profit and margin are NOT returned: they are '
  'revenue - cost and share(profit, revenue), and the client already has one '
  'definition of each.';

-- ── 4. inventory: the whole shelf, valued ─────────────────────────────────
-- Mirrors stockValueTotals(). No period: it is a snapshot of now.
create or replace function public.reports_inventory_summary()
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'products',  count(*),
    'tracked',   count(*) filter (where p.stock_tracking_enabled),
    'units',     coalesce(sum(p.stock_quantity) filter (where p.stock_tracking_enabled), 0),
    'atCost',    coalesce(sum(p.stock_quantity * p.cost_price)
                          filter (where p.stock_tracking_enabled), 0),
    'atRetail',  coalesce(sum(p.stock_quantity * p.selling_price)
                          filter (where p.stock_tracking_enabled), 0),
    'potentialMargin',
                 coalesce(sum(p.stock_quantity * p.selling_price)
                          filter (where p.stock_tracking_enabled), 0)
               - coalesce(sum(p.stock_quantity * p.cost_price)
                          filter (where p.stock_tracking_enabled), 0),
    'outOfStock', count(*) filter (where p.stock_tracking_enabled
                                     and p.stock_quantity <= 0),
    'lowStock',   count(*) filter (where p.stock_tracking_enabled
                                     and p.stock_quantity > 0
                                     and p.stock_quantity <= p.low_stock_level)
  )
  into v
  from public.products p;

  return v;
end
$$;

comment on function public.reports_inventory_summary() is
  'Stock valuation snapshot, mirroring stockValueTotals(): units and values count '
  'tracked products only, out-of-stock is <= 0, and low stock is above zero but at '
  'or under the product''s own threshold. Cost figures are returned because the '
  'products table is already readable by this caller; the UI keeps gating their '
  'display behind view_cost exactly as it does today.';

-- ── 5. expenses ───────────────────────────────────────────────────────────
-- Mirrors summarizeExpenses() and the byCategory / byMethod / byEmployee /
-- byDay breakdowns of buildExpenseReport(). byBranch stays in the client: its
-- key rule was not verified in this pass and inventing one is how two
-- definitions of the same number begin.
create or replace function public.reports_expense_summary(
  p_from              timestamptz default null,
  p_to                timestamptz default null,
  p_timezone          text        default 'UTC'
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v    jsonb;
  v_tz text;
begin
  if not public.can('view_reports') then
    raise exception 'Reading reports requires the view_reports capability'
      using errcode = 'insufficient_privilege';
  end if;

  -- The caller NAMES its timezone instead of sending an offset, because an
  -- offset is only true for one instant. Egypt observes daylight saving, so a
  -- window spanning April or October contains two different offsets, and a
  -- single number quietly moves every late-evening invoice into the wrong day —
  -- the same silent failure dateRanges.ts warns about, one layer down. Given
  -- the zone name, Postgres applies the correct offset to each timestamp.
  -- An unrecognised name degrades to UTC rather than failing the whole report.
  v_tz := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    v_tz := 'UTC';
  end if;

  with scoped as (
    select e.id, e.expense_number, e.name, e.amount, e.category, e.spent_at,
           e.payment_method::text                        as method,
           -- expensesInRange() filters on spent_at, not created_at
           coalesce(nullif(e.user_id, ''),   'unknown')  as employee_key,
           coalesce(nullif(e.user_name, ''), '—')        as employee_label,
           coalesce(nullif(e.branch, ''),    '__none__') as branch_key,
           coalesce(e.branch, '')                        as branch_label,
           to_char(e.spent_at AT TIME ZONE v_tz, 'YYYY-MM-DD') as day
      from public.expenses e
     where (p_from is null or e.spent_at >= p_from)
       and (p_to   is null or e.spent_at <= p_to)
  ),
  -- The two closed vocabularies. byCategoryRows() zero-fills every category the
  -- app knows, so a quiet category still shows a zero rather than vanishing,
  -- and both vocabularies read in the app's own order rather than biggest
  -- first. breakdown() reserves biggest-first for the open-ended keys — an
  -- employee, a branch — where "who spent most" IS the question being asked.
  known_category(k, ord) as (
    values ('transport', 1), ('maintenance', 2), ('supplies', 3), ('utilities', 4), ('other', 5)
  ),
  known_method(k, ord) as (
    values ('cash', 1), ('instapay', 2), ('visa', 3)
  ),
  -- Each breakdown is grouped in its own CTE and folded into one array, because
  -- a scalar subquery that both groups and aggregates returns a row per group,
  -- not the single array the caller needs.
  cat as (
    select s.category as key, count(*) as n, sum(s.amount) as total,
           coalesce(sum(s.amount) filter (where s.method = 'cash'),     0) as cash,
           coalesce(sum(s.amount) filter (where s.method = 'instapay'), 0) as instapay,
           coalesce(sum(s.amount) filter (where s.method = 'visa'),     0) as visa
      from scoped s group by s.category
  ),
  meth as (
    select s.method as key, count(*) as n, sum(s.amount) as total
      from scoped s group by s.method
  ),
  emp as (
    select s.employee_key as key, s.employee_label as label, count(*) as n, sum(s.amount) as total,
           coalesce(sum(s.amount) filter (where s.method = 'cash'),     0) as cash,
           coalesce(sum(s.amount) filter (where s.method = 'instapay'), 0) as instapay,
           coalesce(sum(s.amount) filter (where s.method = 'visa'),     0) as visa
      from scoped s group by s.employee_key, s.employee_label
  ),
  br as (
    select s.branch_key as key, s.branch_label as label, count(*) as n, sum(s.amount) as total,
           coalesce(sum(s.amount) filter (where s.method = 'cash'),     0) as cash,
           coalesce(sum(s.amount) filter (where s.method = 'instapay'), 0) as instapay,
           coalesce(sum(s.amount) filter (where s.method = 'visa'),     0) as visa
      from scoped s group by s.branch_key, s.branch_label
  ),
  day as (
    select s.day as date, count(*) as n, sum(s.amount) as total,
           max(s.amount) as largest,
           (array_agg(s.name order by s.amount desc, s.id))[1] as largest_name
      from scoped s group by s.day
  )
  select jsonb_build_object(
    -- the tiles: summarizeExpenses()'s own five numbers
    'count',      (select count(*)                 from scoped),
    'total',      (select coalesce(sum(amount), 0) from scoped),
    'cash',       (select coalesce(sum(amount), 0) from scoped where method = 'cash'),
    'instapay',   (select coalesce(sum(amount), 0) from scoped where method = 'instapay'),
    'visa',       (select coalesce(sum(amount), 0) from scoped where method = 'visa'),
    'activeDays', (select count(*) from day),
    -- `share`, `avg` and `avgPerActiveDay` are deliberately absent: they are
    -- total ÷ the report total, total ÷ count and total ÷ activeDays, and the
    -- client already holds one definition of each. Returning them here would
    -- create a second, and two definitions of a percentage is how a report
    -- starts disagreeing with itself.
    'byCategory', (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', k.k, 'label', '', 'count', coalesce(c.n, 0),
                     'total', coalesce(c.total, 0), 'cash', coalesce(c.cash, 0),
                     'instapay', coalesce(c.instapay, 0), 'visa', coalesce(c.visa, 0))
                     order by k.ord), '[]'::jsonb)
                     from known_category k left join cat c on c.key = k.k),
    'byMethod',   (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', m.key, 'label', '', 'count', m.n, 'total', m.total)
                     order by k.ord), '[]'::jsonb)
                     from meth m join known_method k on k.k = m.key),
    'byEmployee', (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', e.key, 'label', e.label, 'count', e.n, 'total', e.total,
                     'cash', e.cash, 'instapay', e.instapay, 'visa', e.visa)
                     order by e.total desc, e.n desc, e.key), '[]'::jsonb) from emp e),
    'byBranch',   (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', b.key, 'label', b.label, 'count', b.n, 'total', b.total,
                     'cash', b.cash, 'instapay', b.instapay, 'visa', b.visa)
                     order by b.total desc, b.n desc, b.key), '[]'::jsonb) from br b),
    'byDay',      (select coalesce(jsonb_agg(jsonb_build_object(
                     'date', d.date, 'count', d.n, 'total', d.total,
                     'largest', d.largest, 'largestName', coalesce(d.largest_name, ''))
                     order by d.date), '[]'::jsonb) from day d),
    -- The headline "largest expense". Its identity, not the whole expense book:
    -- the rows behind the table stay with the list query the screen already has,
    -- which is the point of moving the arithmetic here.
    'largest',    (select jsonb_build_object(
                     'id', l.id, 'expenseNumber', l.expense_number, 'name', l.name,
                     'amount', l.amount, 'category', l.category, 'method', l.method,
                     'spentAt', l.spent_at)
                     from (select * from scoped order by amount desc, id limit 1) l)
  )
  into v;

  return v;
end
$$;

comment on function public.reports_expense_summary(timestamptz, timestamptz, text) is
  'Expense totals and breakdowns for a period, filtered on spent_at as the client '
  'does. Mirrors buildExpenseReport(): every known category appears even at zero, '
  'categories and methods read in the app''s own order, employees and branches '
  'read biggest first. RLS gates expenses by view_shifts, so a caller who cannot '
  'see the expense book aggregates an empty set rather than somebody else''s '
  'spending.';

-- ── grants ────────────────────────────────────────────────────────────────
-- Revoke from PUBLIC first: default privileges would otherwise hand EXECUTE
-- back to every role, which is how a gate quietly stops being one.
revoke execute on function public.reports_financial_summary(timestamptz, timestamptz)              from public;
revoke execute on function public.reports_sales_summary(timestamptz, timestamptz, text)         from public;
revoke execute on function public.reports_product_performance(timestamptz, timestamptz)            from public;
revoke execute on function public.reports_inventory_summary()                                      from public;
revoke execute on function public.reports_expense_summary(timestamptz, timestamptz, text)       from public;

grant execute on function public.reports_financial_summary(timestamptz, timestamptz)        to authenticated, service_role;
grant execute on function public.reports_sales_summary(timestamptz, timestamptz, text)   to authenticated, service_role;
grant execute on function public.reports_product_performance(timestamptz, timestamptz)      to authenticated, service_role;
grant execute on function public.reports_inventory_summary()                                to authenticated, service_role;
grant execute on function public.reports_expense_summary(timestamptz, timestamptz, text) to authenticated, service_role;

-- ── the indexes these aggregates depend on ────────────────────────────────
-- A total over three years is only fast if the period can be sought rather than
-- scanned. sales.created_at is already indexed; the joins and the expense window
-- are what would otherwise turn a bounded read into a sequence of table scans.
create index if not exists sale_items_sale_id_idx        on public.sale_items   (sale_id);
create index if not exists sale_items_product_id_idx     on public.sale_items   (product_id);
create index if not exists sale_payments_sale_id_idx     on public.sale_payments (sale_id);
create index if not exists expenses_spent_at_idx         on public.expenses     (spent_at desc);
create index if not exists sales_returns_created_at_idx  on public.sales_returns (created_at desc);
create index if not exists refund_records_created_at_idx on public.refund_records (created_at desc);

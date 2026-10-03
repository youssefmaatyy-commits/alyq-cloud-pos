-- 0076 — branch-safe server-side Invoice / Return Center search
--
-- One paginated read model over the existing authoritative sale, return and
-- refund records. It does not copy financial data or create another workflow.

begin;

create or replace function public.transaction_center_search(
  p_query text default null,
  p_sale_status text default null,
  p_refund_status text default null,
  p_payment_method text default null,
  p_payment_status text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_cashier text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_cashier text := nullif(btrim(coalesce(p_cashier, '')), '');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_offset integer;
  v_total bigint;
  v_rows jsonb;
begin
  if auth.uid() is null or v_branch is null then
    raise exception 'An active branch session is required' using errcode = '42501';
  end if;
  if not public.can('view_sales') then
    raise exception 'Invoice Center access denied' using errcode = '42501';
  end if;
  if coalesce(p_sale_status, '') not in ('','all','completed','pending','voided') then
    raise exception 'Unknown sale status filter' using errcode = '22023';
  end if;
  if coalesce(p_refund_status, '') not in ('','all','none','pending','completed','rejected') then
    raise exception 'Unknown refund status filter' using errcode = '22023';
  end if;
  if coalesce(p_payment_method, '') not in ('','all','cash','instapay','visa','cod') then
    raise exception 'Unknown payment method filter' using errcode = '22023';
  end if;
  if coalesce(p_payment_status, '') not in ('','all','paid','pending') then
    raise exception 'Unknown payment status filter' using errcode = '22023';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'Date range is reversed' using errcode = '22023';
  end if;

  v_offset := (v_page - 1) * v_size;

  with filtered as materialized (
    select s.id
      from public.sales s
     where s.branch_id = v_branch
       and (p_date_from is null or s.created_at >= p_date_from)
       and (p_date_to is null or s.created_at <= p_date_to)
       and (coalesce(p_sale_status, '') in ('','all') or s.status::text = p_sale_status)
       and (coalesce(p_payment_status, '') in ('','all') or s.payment_status::text = p_payment_status)
       and (
         coalesce(p_payment_method, '') in ('','all')
         or exists (
           select 1 from public.sale_payments sp
            where sp.sale_id = s.id and sp.branch_id = v_branch
              and sp.method::text = p_payment_method
         )
         or exists (
           select 1 from public.refund_records rf
            where rf.sale_id = s.id and rf.branch_id = v_branch
              and rf.payment_method::text = p_payment_method
         )
       )
       and (
         coalesce(p_refund_status, '') in ('','all')
         or (p_refund_status = 'none' and not exists (
           select 1 from public.refund_records rf
            where rf.sale_id = s.id and rf.branch_id = v_branch
         ))
         or exists (
           select 1 from public.refund_records rf
            where rf.sale_id = s.id and rf.branch_id = v_branch
              and rf.status::text = p_refund_status
         )
       )
       and (
         v_cashier is null
         or s.user_name ilike '%' || v_cashier || '%'
         or exists (
           select 1 from public.sales_returns sr
            where sr.sale_id = s.id and sr.branch_id = v_branch
              and sr.user_name ilike '%' || v_cashier || '%'
         )
       )
       and (
         v_query is null
         or s.sale_number ilike '%' || v_query || '%'
         or s.client_ref ilike '%' || v_query || '%'
         or coalesce(s.customer_name, '') ilike '%' || v_query || '%'
         or coalesce(s.customer_phone, '') ilike '%' || v_query || '%'
         or s.user_name ilike '%' || v_query || '%'
         or exists (
           select 1 from public.sale_items si
            where si.sale_id = s.id and si.branch_id = v_branch
              and (
                si.name_en ilike '%' || v_query || '%'
                or si.name_ar ilike '%' || v_query || '%'
                or si.sku ilike '%' || v_query || '%'
                or coalesce(si.barcode, '') ilike '%' || v_query || '%'
              )
         )
         or exists (
           select 1 from public.sales_returns sr
            where sr.sale_id = s.id and sr.branch_id = v_branch
              and (sr.return_number ilike '%' || v_query || '%'
                   or coalesce(sr.client_ref, '') ilike '%' || v_query || '%')
         )
         or exists (
           select 1 from public.refund_records rf
            where rf.sale_id = s.id and rf.branch_id = v_branch
              and rf.refund_number ilike '%' || v_query || '%'
         )
       )
  ), page as materialized (
    select s.*
      from public.sales s
      join filtered f on f.id = s.id
     order by s.created_at desc, s.id desc
     offset v_offset limit v_size
  )
  select
    (select count(*) from filtered),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'sale_number', p.sale_number,
        'client_ref', p.client_ref,
        'created_at', p.created_at,
        'status', p.status,
        'payment_status', p.payment_status,
        'subtotal', p.subtotal,
        'discount_amount', p.discount_amount,
        'total', p.total,
        'customer_id', p.customer_id,
        'customer_name', p.customer_name,
        'customer_phone', p.customer_phone,
        'cashier_id', p.user_id,
        'cashier_name', p.user_name,
        'source', p.source,
        'shift_id', p.shift_id,
        'branch_id', p.branch_id,
        'branch_code', b.code,
        'branch_name_en', b.name_en,
        'branch_name_ar', b.name_ar,
        'item_count', (select coalesce(sum(si.quantity),0) from public.sale_items si where si.sale_id=p.id and si.branch_id=v_branch),
        'payment_methods', coalesce((
          select jsonb_agg(distinct sp.method::text)
            from public.sale_payments sp
           where sp.sale_id=p.id and sp.branch_id=v_branch
        ), '[]'::jsonb),
        'returns', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',sr.id,'reference',sr.return_number,'status',sr.refund_status,
            'amount',sr.refund_amount,'created_at',sr.created_at
          ) order by sr.created_at)
            from public.sales_returns sr
           where sr.sale_id=p.id and sr.branch_id=v_branch
        ), '[]'::jsonb),
        'refunds', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',rf.id,'reference',rf.refund_number,'return_id',rf.return_id,
            'status',rf.status,'amount',rf.amount,'payment_method',rf.payment_method,
            'created_at',rf.created_at,'settled_at',rf.settled_at
          ) order by rf.created_at)
            from public.refund_records rf
           where rf.sale_id=p.id and rf.branch_id=v_branch
        ), '[]'::jsonb),
        'completed_refund_total', coalesce((
          select sum(rf.amount) from public.refund_records rf
           where rf.sale_id=p.id and rf.branch_id=v_branch and rf.status='completed'
        ),0),
        'pending_refund_total', coalesce((
          select sum(rf.amount) from public.refund_records rf
           where rf.sale_id=p.id and rf.branch_id=v_branch and rf.status='pending'
        ),0)
      ) order by p.created_at desc, p.id desc
    ), '[]'::jsonb)
  into v_total, v_rows
  from page p
  join public.branches b on b.id = p.branch_id;

  return jsonb_build_object(
    'rows', coalesce(v_rows, '[]'::jsonb),
    'total', coalesce(v_total, 0),
    'page', v_page,
    'page_size', v_size,
    'page_count', case when coalesce(v_total,0)=0 then 0 else ceil(v_total::numeric / v_size)::integer end,
    'branch_id', v_branch
  );
end;
$$;

comment on function public.transaction_center_search(text,text,text,text,text,timestamptz,timestamptz,text,integer,integer) is
  'Server-side branch-scoped Invoice/Return Center search and pagination across sale/invoice/client/customer/cashier/product/SKU/barcode/return/refund references. Completed and pending refund totals remain distinct.';

revoke all on function public.transaction_center_search(text,text,text,text,text,timestamptz,timestamptz,text,integer,integer)
  from public, anon;
grant execute on function public.transaction_center_search(text,text,text,text,text,timestamptz,timestamptz,text,integer,integer)
  to authenticated, service_role;

commit;

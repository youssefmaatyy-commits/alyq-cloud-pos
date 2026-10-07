-- 0093 — Factory Reset notification cleanup / pg-safeupdate repair
--
-- Supabase API sessions preload pg-safeupdate. Its post-parse hook rejects every
-- DELETE/UPDATE whose parse tree has no WHERE qualification, including DML in a
-- SECURITY DEFINER function. Migration 0092's reset-start audit trigger called
-- notification_factory_reset_cleanup(), whose unqualified outbox DELETE was the
-- first rejected statement (SQLSTATE 21000); the surrounding reset transaction
-- correctly rolled back.
--
-- This forward-only repair keeps 0091's deletion/preservation/atomicity contract
-- unchanged. Notification facts are removed child-first. Each intentional full-
-- relation DELETE is qualified by that table's non-null primary-key domain, not
-- WHERE TRUE and not a disabled safety guard. The same qualification is applied
-- to the otherwise-identical 0091 reset body so the next full-table operation
-- cannot become the next pg-safeupdate failure after notification cleanup.

begin;

create or replace function public.notification_factory_reset_cleanup()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  if new.action='system.reset.started' and new.entity_id='factory' then
    delete from public.notification_delivery_attempts where id is not null;
    delete from public.notification_push_deliveries where id is not null;
    delete from public.user_notification_inbox where id is not null;
    delete from public.notification_outbox where id is not null;
  end if;
  return new;
end
$function$;
revoke all on function public.notification_factory_reset_cleanup()
  from public,anon,authenticated;

-- Re-state the current Factory Reset body without changing its 0091 contract.
-- Only formerly unqualified full-relation DELETE statements gain primary-key
-- qualifications so API execution satisfies pg-safeupdate.
create or replace function public.system_factory_reset(
  p_options jsonb,
  p_confirmation text,
  p_fresh_until timestamptz,
  p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid;
  v_opts      jsonb;
  v_settings  jsonb;
  v_deleted   jsonb := '{}'::jsonb;
  v_preserved jsonb := '{}'::jsonb;
  v_actor        text;
  v_counts       integer := 0;
  v_sale_count     integer := 0;
  v_return_count   integer := 0;
  v_brand_count    integer := 0;
  v_delivery_count integer := 0;
  v_audit_count    integer := 0;
  v_depth          integer := 0;
  v_products     boolean;
begin
  v_uid := public.system_assert_authorized(
    p_fresh_until, p_confirmation, 'DELETE ALL DATA', p_password);

  perform public.system_assert_options(p_options,
    array['products','categories','customers','website','branding','delivery_payment']);
  v_products := coalesce((p_options->>'products')::boolean, false)
    or coalesce((p_options->>'categories')::boolean, false);
  v_opts := p_options || jsonb_build_object(
    'products', v_products,
    'delivery_payment', coalesce((p_options->>'delivery_payment')::boolean, false)
      or coalesce((p_options->>'website')::boolean, false)
  );

  perform public.system_assert_super_admin(v_uid);
  select name into v_actor from public.profiles where id = v_uid;
  select count(*)::integer into v_audit_count from public.audit_log;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.started', 'system', 'factory', 'Factory reset',
          jsonb_build_object(
            'mode', 'factory',
            'options', v_opts,
            'contract', '0091-current-schema-preserve-audit-security-stocktakes-imports'),
          v_uid::text, v_actor);

  -- Capture settings-group counts before any overlapping website operation so
  -- preview and result report the same pre-reset rows.
  select case when exists (
    select 1 from public.website_settings
     where coalesce(settings->'brand', '{}'::jsonb) <> '{}'::jsonb
        or coalesce(settings->'images'->>'logo_url', '') <> ''
  ) then 1 else 0 end into v_brand_count;
  select case when exists (
    select 1 from public.website_settings
     where coalesce(settings->'delivery', '{}'::jsonb) <> '{}'::jsonb
  ) then 1 else 0 end into v_delivery_count;

  -- ── operational floor, always ────────────────────────────────────────────
  select (
    (select count(*) from public.online_orders)
    + (select count(*) from public.online_order_items)
    + (select count(*) from public.order_events)
    + (select count(*) from public.stock_reservations)
    + (select count(*) from public.promo_code_usages)
  )::integer into v_counts;
  delete from public.stock_reservations where id is not null;
  delete from public.order_events where id is not null;
  delete from public.promo_code_usages where id is not null;
  delete from public.online_order_items where id is not null;
  delete from public.online_orders where id is not null;
  v_deleted := jsonb_set(v_deleted, '{orders}', to_jsonb(v_counts), true);

  -- Refund rows reference both sale and return. Returns RESTRICT sales, so the
  -- only valid order is refund -> return items -> returns -> sale leaves -> sale.
  select (
    (select count(*) from public.sales_returns)
    + (select count(*) from public.return_items)
  )::integer into v_return_count;
  select (
    (select count(*) from public.sales)
    + (select count(*) from public.sale_items)
    + (select count(*) from public.sale_payments)
    + (select count(*) from public.refund_records)
  )::integer into v_sale_count;
  delete from public.refund_records where id is not null;
  delete from public.return_items where id is not null;
  delete from public.sales_returns where id is not null;
  v_deleted := jsonb_set(v_deleted, '{returns}', to_jsonb(v_return_count), true);

  delete from public.sale_payments where id is not null;
  delete from public.sale_items where id is not null;
  delete from public.sales where id is not null;
  v_deleted := jsonb_set(v_deleted, '{sales}', to_jsonb(v_sale_count), true);

  -- Drawer rows RESTRICT their shift. Refund settlement rows are already gone.
  select count(*)::integer into v_counts from public.cash_movements;
  delete from public.cash_movements where id is not null;
  v_deleted := jsonb_set(v_deleted, '{cash_movements}', to_jsonb(v_counts), true);

  select count(*)::integer into v_counts from public.expenses;
  delete from public.expenses where id is not null;
  v_deleted := jsonb_set(v_deleted, '{expenses}', to_jsonb(v_counts), true);

  select count(*)::integer into v_counts from public.shifts;
  delete from public.shifts where id is not null;
  v_deleted := jsonb_set(v_deleted, '{shifts}', to_jsonb(v_counts), true);

  if coalesce((v_opts->>'customers')::boolean, false) then
    select ((select count(*) from public.customers)
          + (select count(*) from public.store_customers))::integer into v_counts;
    delete from public.store_customers where id is not null;
    delete from public.customers where id is not null;
    v_deleted := jsonb_set(v_deleted, '{customers}', to_jsonb(v_counts), true);
  end if;

  -- ── catalogue, only when selected (categories imply products) ────────────
  if v_products then
    -- Transfers and movements are operational inventory rows with live
    -- RESTRICT links. Their append-only audit evidence remains in audit_log.
    select count(*)::integer into v_counts from public.stock_transfers;
    delete from public.stock_transfers where id is not null;
    v_deleted := jsonb_set(v_deleted, '{stock_transfers}', to_jsonb(v_counts), true);

    select count(*)::integer into v_counts from public.stock_movements;
    delete from public.stock_movements where id is not null;
    v_deleted := jsonb_set(v_deleted, '{movements}', to_jsonb(v_counts), true);

    select (
      (select count(*) from public.products)
      + (select count(*) from public.product_variants)
      + (select count(*) from public.branch_stock_balances)
      + (select count(*) from public.catalogue_codes)
      + (select count(*) from public.product_content)
      + (select count(*) from public.product_color_images)
      + (select count(*) from public.store_reviews where product_id is not null)
      + (select count(*) from public.promotion_targets where target_kind in ('product','variant'))
    )::integer into v_counts;

    delete from public.promotion_targets where target_kind in ('product','variant');
    delete from public.store_reviews where product_id is not null;
    delete from public.product_content where product_id is not null;
    delete from public.product_color_images where id is not null;
    delete from public.catalogue_codes where kind is not null;
    -- Detach every historical line explicitly before set-based catalogue
    -- deletes. A multi-row FK cascade runs after all BEFORE DELETE triggers, so
    -- a single per-row release id cannot safely authorize every line.
    perform set_config('alyq.factory_reset_detach_stocktakes','on',true);
    update public.stocktake_lines
       set variant_id = null
     where variant_id is not null;
    update public.stocktake_lines
       set product_id = null
     where product_id is not null;
    perform set_config('alyq.factory_reset_detach_stocktakes','off',true);
    -- Branch balances cascade with variants/products; frozen stocktake fields remain.
    delete from public.product_variants where id is not null;
    delete from public.products where id is not null;
    v_deleted := jsonb_set(v_deleted, '{products}', to_jsonb(v_counts), true);
  end if;

  if coalesce((v_opts->>'categories')::boolean, false) then
    select (
      (select count(*) from public.categories)
      + (select count(*) from public.storefront_category_content)
      + (select count(*) from public.promotion_targets where target_kind = 'category')
    )::integer into v_counts;
    delete from public.promotion_targets where target_kind = 'category';
    delete from public.storefront_category_content where id is not null;
    loop
      delete from public.categories parent
       where parent.parent_id is not null
         and not exists (
           select 1 from public.categories child where child.parent_id = parent.id
         );
      get diagnostics v_depth = row_count;
      exit when v_depth = 0;
    end loop;
    delete from public.categories where parent_id is null;
    v_deleted := jsonb_set(v_deleted, '{categories}', to_jsonb(v_counts), true);
  end if;

  -- ── website content/settings ─────────────────────────────────────────────
  if coalesce((v_opts->>'website')::boolean, false) then
    select (
      (select count(*) from public.campaigns)
      + (select count(*) from public.store_faqs)
      + (select count(*) from public.website_settings)
    )::integer into v_counts;
    delete from public.campaigns where id is not null;
    delete from public.store_faqs where id is not null;
    select settings into v_settings from public.website_settings where id = 1;
    if coalesce((v_opts->>'branding')::boolean, false) then
      update public.website_settings set settings = '{}'::jsonb, updated_at = now() where id = 1;
    else
      v_settings := jsonb_strip_nulls(jsonb_build_object(
        'brand', v_settings->'brand',
        'images', v_settings->'images'
      ));
      update public.website_settings set settings = v_settings, updated_at = now() where id = 1;
    end if;
    v_deleted := jsonb_set(v_deleted, '{website}', to_jsonb(v_counts), true);
  elsif coalesce((v_opts->>'branding')::boolean, false) then
    update public.website_settings
       set settings = (settings - 'brand')
                     || jsonb_build_object('images',
                          coalesce(settings->'images', '{}'::jsonb)
                          - 'logo_url' - 'mark_url' - 'logo_dark_url'),
           updated_at = now()
     where id = 1;
  end if;
  if coalesce((v_opts->>'branding')::boolean, false) then
    v_deleted := jsonb_set(v_deleted, '{branding}', to_jsonb(v_brand_count), true);
  end if;

  if coalesce((v_opts->>'delivery_payment')::boolean, false) then
    update public.website_settings
       set settings = settings - 'delivery', updated_at = now()
     where id = 1;
    v_deleted := jsonb_set(v_deleted, '{delivery_payment}', to_jsonb(v_delivery_count), true);
  end if;

  -- Factory numbering starts fresh for the operational rows just removed.
  update public.sale_counters   set next_value = 1 where id = 1;
  update public.return_counters set next_value = 1 where id = 1;
  update public.refund_counters set next_value = 1 where id = 1;
  -- Approval requests are preserved, so approval_counters is deliberately not reset.
  perform setval('public.online_order_number_seq', 1, false);
  perform setval('public.shift_number_seq', 1, false);
  perform setval('public.expense_number_seq', 1, false);
  perform setval('public.cash_movement_number_seq', 1, false);

  -- Existing database scenarios arm this transaction-local interruption point.
  -- PostgREST requests cannot set custom transaction GUCs, so it is not a
  -- remotely reachable reset option. It remains solely as rollback evidence.
  if current_setting('dz.force_failure', true) = 'factory' then
    raise exception 'DZ_TEST_INTERRUPT: forced Factory Reset rollback proof'
      using errcode = 'raise_exception';
  end if;

  -- Exact preservation summary. Counts are read after destructive work and are
  -- part of the same transaction and the same contract as the preview.
  v_preserved := jsonb_build_object(
    'stocktake_headers', (select count(*) from public.stocktakes),
    'stocktake_lines', (select count(*) from public.stocktake_lines),
    'import_batches', (select count(*) from public.import_batches),
    -- Count the evidence that existed before this reset. The reset adds its own
    -- started/succeeded evidence, which is not a row the preview promised to keep.
    'audit_log', v_audit_count,
    'approval_requests', (select count(*) from public.approval_requests),
    'profiles', (select count(*) from public.profiles),
    'branches', (select count(*) from public.branches),
    'registers', (select count(*) from public.registers),
    'mobile_installations', (select count(*) from public.mobile_installations),
    'backups', (select count(*) from public.backups),
    'super_admin', (
      select username from public.profiles
       where role = 'admin' and active
       order by created_at
       limit 1
    ),
    'schema', true,
    'migrations_untouched', true
  );
  if not v_products then
    v_preserved := v_preserved || jsonb_build_object(
      'stock_transfers', (select count(*) from public.stock_transfers),
      'movements', (select count(*) from public.stock_movements),
      'products',
        (select count(*) from public.products)
        + (select count(*) from public.product_variants)
        + (select count(*) from public.branch_stock_balances)
        + (select count(*) from public.catalogue_codes)
        + (select count(*) from public.product_content)
        + (select count(*) from public.product_color_images)
        + (select count(*) from public.store_reviews where product_id is not null)
        + (select count(*) from public.promotion_targets where target_kind in ('product','variant'))
    );
  end if;
  if not coalesce((v_opts->>'categories')::boolean, false) then
    v_preserved := v_preserved || jsonb_build_object(
      'categories',
        (select count(*) from public.categories)
        + (select count(*) from public.storefront_category_content)
        + (select count(*) from public.promotion_targets where target_kind = 'category')
    );
  end if;
  if not coalesce((v_opts->>'customers')::boolean, false) then
    v_preserved := v_preserved || jsonb_build_object(
      'customers', (select count(*) from public.customers) + (select count(*) from public.store_customers)
    );
  end if;
  if not coalesce((v_opts->>'website')::boolean, false) then
    v_preserved := v_preserved || jsonb_build_object(
      'website',
        (select count(*) from public.campaigns)
        + (select count(*) from public.store_faqs)
        + (select count(*) from public.website_settings)
    );
  end if;
  if not coalesce((v_opts->>'branding')::boolean, false) then
    v_preserved := v_preserved || jsonb_build_object('branding', v_brand_count);
  end if;
  if not coalesce((v_opts->>'delivery_payment')::boolean, false) then
    v_preserved := v_preserved || jsonb_build_object('delivery_payment', v_delivery_count);
  end if;

  perform public.system_assert_super_admin(v_uid);

  -- Final operation. A failure here still rolls back every deletion, settings
  -- update, counter/sequence reset and the started-audit row.
  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.succeeded', 'system', 'factory', 'Factory reset',
          jsonb_build_object(
            'mode', 'factory',
            'options', v_opts,
            'deleted', v_deleted,
            'preserved', v_preserved,
            'contract', '0091-current-schema-preserve-audit-security-stocktakes-imports'),
          v_uid::text, v_actor);

  return jsonb_build_object(
    'mode', 'factory',
    'deleted', v_deleted,
    'preserved', v_preserved
  );
end;
$$;

revoke all on function public.system_factory_reset(jsonb,text,timestamptz,text)
  from public,anon;
grant execute on function public.system_factory_reset(jsonb,text,timestamptz,text)
  to authenticated;
comment on function public.system_factory_reset(jsonb,text,timestamptz,text) is
  '0093: atomic 0091 Factory Reset contract with pg-safeupdate-qualified deletes and child-first notification cleanup.';

create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare v_branch uuid:=public.current_branch_id();
begin
  if auth.uid() is null then
    raise exception 'Authenticated health check required' using errcode='42501';
  end if;
  return jsonb_build_object(
    'authenticated',true,
    'server_time',now(),
    'migration','0093_factory_reset_notification_cleanup_repair.sql',
    'migration_count',93,
    'active_branch_id',v_branch,
    'branch_context_valid',v_branch is not null and public.can_access_branch(v_branch)
  );
end
$function$;
revoke all on function public.system_health_probe() from public,anon;
grant execute on function public.system_health_probe() to authenticated,service_role;
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0093_factory_reset_notification_cleanup_repair.sql (count 93).';

commit;

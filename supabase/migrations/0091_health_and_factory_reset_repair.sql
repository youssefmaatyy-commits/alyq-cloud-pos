-- 0091 — Health contract and current-schema Factory Reset repair
--
-- This migration is forward-only. It does not rewrite 0047 or any prior file.
-- It advances the authenticated health contract, repairs Factory Reset against
-- every current RESTRICT dependency, preserves immutable/security history, and
-- makes the server preview/result describe the same deletion contract.
--
-- Factory Reset retention contract (current schema):
--   DELETE always (operational floor): online orders and their children;
--     refunds; return items and returns; sale payments/items and sales; drawer
--     cash movements; expenses; shifts. Successful offline replays are normal
--     sales and therefore leave with this operational floor.
--   DELETE only when catalogue products are selected (categories imply this):
--     stock transfers, stock movements, branch shelf balances (by cascade),
--     catalogue codes/content/reviews/colour images, product/variant promotion
--     targets, variants and products. The append-only audit evidence survives.
--   PRESERVE as immutable/history: stocktake headers and every snapshot line;
--     import_batches; audit_log; approval requests and their counter; backups.
--     Stocktake product/variant foreign keys become nullable SET NULL links so
--     a catalogue wipe cannot erase the frozen SKU/name/quantity snapshot.
--   PRESERVE as identity/security/installation state: auth accounts, profiles,
--     roles/capabilities, branches/memberships, operation policies, manager
--     credentials/attempts, registers and mobile installations. Register health
--     counters and client-local offline queues are outside Factory Reset.
--   NEVER touch schema, migration history, RLS, grants or provider secrets.
--
-- No TRUNCATE is used. Child rows are handled before parents inside the one RPC
-- transaction. Any exception, including the final audit insert, rolls back the
-- complete operation and its started-audit row.

begin;

-- ── 1. Preserve full stocktake history through a catalogue reset ───────────
-- 0060 intended stocktake lines to remain snapshot history, but product_id was
-- ON DELETE CASCADE. Keep the snapshot columns and only detach live catalogue
-- identities. variant_id was already SET NULL; product_id now behaves the same.
alter table public.stocktake_lines
  drop constraint if exists stocktake_lines_product_id_fkey;
alter table public.stocktake_lines
  alter column product_id drop not null;
alter table public.stocktake_lines
  add constraint stocktake_lines_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;

comment on column public.stocktake_lines.product_id is
  'Nullable live-catalogue link. Factory/product deletion clears it while immutable SKU/name/quantity snapshot columns preserve stocktake history.';

-- Permit only the FK-driven live-link detach armed by the existing product and
-- variant BEFORE DELETE triggers. Every snapshot field remains immutable.
create or replace function public.stocktake_lines_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.product_id is not null
       and current_setting('alyq.stocktake_releasing_product', true) = old.product_id::text then
      return old;
    end if;
    select status into v_status from public.stocktakes where id = old.stocktake_id;
    if v_status = 'finalized' then
      raise exception 'A finalized stocktake line is historical and cannot be deleted'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if new.expected_quantity is distinct from old.expected_quantity
     or new.shelf_key is distinct from old.shelf_key
     or new.sku is distinct from old.sku
     or new.stocktake_id is distinct from old.stocktake_id
     or (
       new.product_id is distinct from old.product_id
       and not (
         new.product_id is null
         and old.product_id is not null
         and (
           current_setting('alyq.stocktake_releasing_product', true) = old.product_id::text
           or current_setting('alyq.factory_reset_detach_stocktakes', true) = 'on'
         )
       )
     )
     or (
       new.variant_id is distinct from old.variant_id
       and not (
         new.variant_id is null
         and (
           current_setting('alyq.stocktake_releasing_variant', true) = coalesce(old.variant_id::text, '')
           or current_setting('alyq.factory_reset_detach_stocktakes', true) = 'on'
         )
       )
     ) then
    raise exception 'A stocktake line snapshot cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  select status into v_status from public.stocktakes where id = old.stocktake_id;
  if v_status = 'finalized' then
    if new.physical_quantity is distinct from old.physical_quantity
       or new.variance is distinct from old.variance
       or new.movement_reference is distinct from old.movement_reference
       or new.barcode is distinct from old.barcode
       or new.product_name_ar is distinct from old.product_name_ar
       or new.product_name_en is distinct from old.product_name_en
       or new.variant_label is distinct from old.variant_label then
      raise exception 'A finalized stocktake line is historical and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
    if new.movement_id is distinct from old.movement_id
       and not (new.movement_id is null and old.movement_id is not null) then
      raise exception 'A finalized stocktake line is historical and cannot be rewritten'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ── 2. Server preview uses the exact current reset contract ─────────────────
create or replace function public.system_reset_preview(
  p_mode text,
  p_options jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_opt   text;
  v_ops   jsonb := '{}'::jsonb;
  v_del   jsonb := '[]'::jsonb;
  v_keep  jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_products boolean;
begin
  if not public.can('manage_system_reset') then
    raise exception 'RESET_UNAUTHORIZED: manage_system_reset is required'
      using errcode = 'insufficient_privilege';
  end if;
  if p_mode not in ('operational', 'factory') then
    raise exception 'RESET_BAD_MODE: %', p_mode;
  end if;

  if p_mode = 'operational' then
    perform public.system_assert_options(p_options,
      array['sales','returns','orders','shifts','expenses','customers','movements','quantities']);
    v_ops := p_options
      || jsonb_build_object('returns',
           coalesce((p_options->>'returns')::boolean, false)
           or coalesce((p_options->>'sales')::boolean, false));
  else
    perform public.system_assert_options(p_options,
      array['products','categories','customers','website','branding','delivery_payment']);
    -- Categories cannot be removed while their products remain. State the
    -- implication in the preview and execute exactly the same effective option.
    v_products := coalesce((p_options->>'products')::boolean, false)
      or coalesce((p_options->>'categories')::boolean, false);
    v_ops := jsonb_build_object(
      'sales', true,
      'returns', true,
      'orders', true,
      'cash_movements', true,
      'shifts', true,
      'expenses', true,
      'customers', coalesce((p_options->>'customers')::boolean, false),
      'stock_transfers', v_products,
      'movements', v_products,
      'products', v_products,
      'categories', coalesce((p_options->>'categories')::boolean, false),
      'website', coalesce((p_options->>'website')::boolean, false),
      'branding', coalesce((p_options->>'branding')::boolean, false),
      -- A website reset drops every non-brand settings group, including
      -- delivery/payment. Surface that implication instead of claiming keep.
      'delivery_payment', coalesce((p_options->>'delivery_payment')::boolean, false)
        or coalesce((p_options->>'website')::boolean, false)
    );
  end if;

  for v_opt in select jsonb_object_keys(v_ops)
  loop
    v_entry := jsonb_build_object(
      'group', v_opt,
      'action', case when (v_ops->>v_opt)::boolean then 'delete' else 'preserve' end
    );
    case v_opt
      when 'sales' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.sales)
          + (select count(*) from public.sale_items)
          + (select count(*) from public.sale_payments)
          + (select count(*) from public.refund_records));
      when 'returns' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.sales_returns)
          + (select count(*) from public.return_items));
      when 'orders' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.online_orders)
          + (select count(*) from public.online_order_items)
          + (select count(*) from public.order_events)
          + (select count(*) from public.stock_reservations)
          + (select count(*) from public.promo_code_usages));
      when 'cash_movements' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.cash_movements));
      when 'shifts' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.shifts));
      when 'expenses' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.expenses));
      when 'customers' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.customers) + (select count(*) from public.store_customers));
      when 'stock_transfers' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.stock_transfers));
      when 'movements' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.stock_movements));
      when 'quantities' then
        v_entry := jsonb_build_object('group', 'quantities',
          'action', case when (v_ops->>'quantities')::boolean then 'reset' else 'preserve' end,
          'count',
          (select count(*) from public.products where stock_quantity > 0)
          + (select count(*) from public.product_variants where stock_quantity > 0));
      when 'products' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.products)
          + (select count(*) from public.product_variants)
          + (select count(*) from public.branch_stock_balances)
          + (select count(*) from public.catalogue_codes)
          + (select count(*) from public.product_content)
          + (select count(*) from public.product_color_images)
          + (select count(*) from public.store_reviews where product_id is not null)
          + (select count(*) from public.promotion_targets where target_kind in ('product','variant')));
      when 'categories' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.categories)
          + (select count(*) from public.storefront_category_content)
          + (select count(*) from public.promotion_targets where target_kind = 'category'));
      when 'website' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.campaigns)
          + (select count(*) from public.store_faqs)
          + (select count(*) from public.website_settings));
      when 'branding' then
        v_entry := v_entry || jsonb_build_object('count',
          case when exists (
            select 1 from public.website_settings
             where coalesce(settings->'brand', '{}'::jsonb) <> '{}'::jsonb
                or coalesce(settings->'images'->>'logo_url', '') <> ''
          ) then 1 else 0 end);
      when 'delivery_payment' then
        v_entry := v_entry || jsonb_build_object('count',
          case when exists (
            select 1 from public.website_settings
             where coalesce(settings->'delivery', '{}'::jsonb) <> '{}'::jsonb
          ) then 1 else 0 end);
      else
        v_entry := null;
    end case;
    if v_entry is not null then
      if (v_entry->>'action') = 'preserve' then
        v_keep := v_keep || jsonb_build_array(v_entry);
      else
        v_del := v_del || jsonb_build_array(v_entry);
      end if;
    end if;
  end loop;

  if p_mode = 'factory' then
    -- These rows are never reset options. They are named explicitly so the
    -- server preview and final result state the preservation contract.
    v_keep := v_keep || jsonb_build_array(
      jsonb_build_object('group','stocktake_headers','action','preserve','count',(select count(*) from public.stocktakes)),
      jsonb_build_object('group','stocktake_lines','action','preserve','count',(select count(*) from public.stocktake_lines)),
      jsonb_build_object('group','import_batches','action','preserve','count',(select count(*) from public.import_batches)),
      jsonb_build_object('group','audit_log','action','preserve','count',(select count(*) from public.audit_log)),
      jsonb_build_object('group','approval_requests','action','preserve','count',(select count(*) from public.approval_requests)),
      jsonb_build_object('group','profiles','action','preserve','count',(select count(*) from public.profiles)),
      jsonb_build_object('group','branches','action','preserve','count',(select count(*) from public.branches)),
      jsonb_build_object('group','registers','action','preserve','count',(select count(*) from public.registers)),
      jsonb_build_object('group','mobile_installations','action','preserve','count',(select count(*) from public.mobile_installations)),
      jsonb_build_object('group','backups','action','preserve','count',(select count(*) from public.backups))
    );
  end if;

  return jsonb_build_object(
    'mode', p_mode,
    'effective_options', v_ops,
    'delete', v_del,
    'preserve', v_keep,
    'protected_admin', (
      select jsonb_build_object('username', p.username, 'name', p.name)
        from public.profiles p
       where p.role = 'admin' and p.active
       order by p.created_at
       limit 1
    ),
    'schema_note', case when p_mode = 'factory'
      then 'Preserves audit/security history, stocktake snapshots, import history, identities, branches, registers, mobile installations, backups, schema, migrations and RLS.'
      else 'Schema, migrations, RLS and auth accounts are never touched.' end
  );
end;
$$;

-- ── 3. Current-schema Factory Reset ────────────────────────────────────────
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
  delete from public.stock_reservations;
  delete from public.order_events;
  delete from public.promo_code_usages;
  delete from public.online_order_items;
  delete from public.online_orders;
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
  delete from public.refund_records;
  delete from public.return_items;
  delete from public.sales_returns;
  v_deleted := jsonb_set(v_deleted, '{returns}', to_jsonb(v_return_count), true);

  delete from public.sale_payments;
  delete from public.sale_items;
  delete from public.sales;
  v_deleted := jsonb_set(v_deleted, '{sales}', to_jsonb(v_sale_count), true);

  -- Drawer rows RESTRICT their shift. Refund settlement rows are already gone.
  select count(*)::integer into v_counts from public.cash_movements;
  delete from public.cash_movements;
  v_deleted := jsonb_set(v_deleted, '{cash_movements}', to_jsonb(v_counts), true);

  select count(*)::integer into v_counts from public.expenses;
  delete from public.expenses;
  v_deleted := jsonb_set(v_deleted, '{expenses}', to_jsonb(v_counts), true);

  select count(*)::integer into v_counts from public.shifts;
  delete from public.shifts;
  v_deleted := jsonb_set(v_deleted, '{shifts}', to_jsonb(v_counts), true);

  if coalesce((v_opts->>'customers')::boolean, false) then
    select ((select count(*) from public.customers)
          + (select count(*) from public.store_customers))::integer into v_counts;
    delete from public.store_customers;
    delete from public.customers;
    v_deleted := jsonb_set(v_deleted, '{customers}', to_jsonb(v_counts), true);
  end if;

  -- ── catalogue, only when selected (categories imply products) ────────────
  if v_products then
    -- Transfers and movements are operational inventory rows with live
    -- RESTRICT links. Their append-only audit evidence remains in audit_log.
    select count(*)::integer into v_counts from public.stock_transfers;
    delete from public.stock_transfers;
    v_deleted := jsonb_set(v_deleted, '{stock_transfers}', to_jsonb(v_counts), true);

    select count(*)::integer into v_counts from public.stock_movements;
    delete from public.stock_movements;
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
    delete from public.product_content;
    delete from public.product_color_images;
    delete from public.catalogue_codes;
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
    delete from public.product_variants;
    delete from public.products;
    v_deleted := jsonb_set(v_deleted, '{products}', to_jsonb(v_counts), true);
  end if;

  if coalesce((v_opts->>'categories')::boolean, false) then
    select (
      (select count(*) from public.categories)
      + (select count(*) from public.storefront_category_content)
      + (select count(*) from public.promotion_targets where target_kind = 'category')
    )::integer into v_counts;
    delete from public.promotion_targets where target_kind = 'category';
    delete from public.storefront_category_content;
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
    delete from public.campaigns;
    delete from public.store_faqs;
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

-- ── 4. Health contract now matches the final migration ─────────────────────
create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare v_branch uuid := public.current_branch_id();
begin
  if auth.uid() is null then
    raise exception 'Authenticated health check required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'authenticated', true,
    'server_time', now(),
    'migration', '0091_health_and_factory_reset_repair.sql',
    'migration_count', 91,
    'active_branch_id', v_branch,
    'branch_context_valid', v_branch is not null and public.can_access_branch(v_branch)
  );
end
$function$;

revoke all on function public.system_reset_preview(text, jsonb) from public, anon;
grant execute on function public.system_reset_preview(text, jsonb) to authenticated;
revoke all on function public.system_factory_reset(jsonb, text, timestamptz, text) from public, anon;
grant execute on function public.system_factory_reset(jsonb, text, timestamptz, text) to authenticated;
revoke all on function public.system_health_probe() from public, anon;
grant execute on function public.system_health_probe() to authenticated, service_role;

comment on function public.system_reset_preview(text, jsonb) is
  '0091: read-only current-schema reset preview. Uses the same effective options and delete/preserve groups as Factory Reset.';
comment on function public.system_factory_reset(jsonb, text, timestamptz, text) is
  '0091: one-transaction current-schema Factory Reset. Correct child-first order; preserves audit/security/stocktake/import history and identities.';
comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0091_health_and_factory_reset_repair.sql (count 91).';

commit;

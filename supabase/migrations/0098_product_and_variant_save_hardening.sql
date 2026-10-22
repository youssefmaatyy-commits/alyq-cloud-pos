-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0098 — Product & Variant Save Hardening
--
-- Fixes root causes discovered during the BR104 Product & Variant Save audit:
--
--   1. `public.products_enforce_category_active()` (from 0044) previously fired
--      on every `UPDATE public.products` statement that included `category_id`
--      in its SET list, even when `NEW.category_id IS NOT DISTINCT FROM
--      OLD.category_id`. When a category was later archived (`active = false`),
--      editing the name, price, or images of any product already in that
--      category raised SQLSTATE 23514 (`Category ... is archived`), causing
--      the UI to fail with "The server rejected this change".
--      Now: `INSERT` into an archived category and `UPDATE` that moves a
--      product into a *different* archived category remain strictly refused,
--      while in-place edits of a product whose `category_id` is unchanged
--      succeed as intended by 0044 and ProductForm.
--
--   2. `public.variants_fill_color_key()` (from 0043) heals legacy 1-character
--      `color_key` values (such as `'r'` on `ROSE` / `BR104-R-2` or `'ا'` on
--      `احمر`) created by the first-keystroke draft bug when a variant is
--      saved, provided no sibling variant on the same product collides with
--      the full normalized `color_key`.
--
--   3. `public.enable_product_variants()` ensures every variant has an explicit
--      `branch_stock_balances` row at the active/default branch matching its
--      opening allocation even when `stock_quantity` was already 0.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Allow in-place product field edits when category_id is unchanged ────
-- Preserves intentional category archiving (`active = false` on bracelets,
-- necklaces, earrings) without ever reactivating the category, while allowing
-- authorized staff to edit a product's name, price, cost, images, SKU/barcode,
-- or thresholds in place. Moving a product to an archived category or issuing
-- a pure `SET category_id = <archived>` assignment remains strictly refused.
create or replace function public.products_enforce_category_active()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_active boolean;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;

  if new.category_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.category_id is not distinct from old.category_id
     and (
       new.name_ar is distinct from old.name_ar or
       new.name_en is distinct from old.name_en or
       new.description_ar is distinct from old.description_ar or
       new.description_en is distinct from old.description_en or
       new.sku is distinct from old.sku or
       new.barcode is distinct from old.barcode or
       new.selling_price is distinct from old.selling_price or
       new.cost_price is distinct from old.cost_price or
       new.tax_rate is distinct from old.tax_rate or
       new.image_url is distinct from old.image_url or
       new.images is distinct from old.images or
       new.low_stock_level is distinct from old.low_stock_level or
       new.stock_quantity is distinct from old.stock_quantity or
       new.stock_tracking_enabled is distinct from old.stock_tracking_enabled or
       new.variants_enabled is distinct from old.variants_enabled or
       new.show_on_website is distinct from old.show_on_website or
       new.is_featured is distinct from old.is_featured or
       new.active is distinct from old.active
     ) then
    return new;
  end if;

  select c.active into v_active from public.categories c where c.id = new.category_id;
  if v_active is false then
    raise exception 'Category % is archived — a product cannot be assigned to it',
      new.category_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.products_enforce_category_active() is
  'Fires on INSERT and on any UPDATE that changes category_id, refusing assignments to archived categories while permitting in-place edits of products already in an archived category.';

drop trigger if exists products_enforce_category_active on public.products;
create trigger products_enforce_category_active
  before insert or update of category_id on public.products
  for each row execute function public.products_enforce_category_active();

revoke execute on function public.products_enforce_category_active() from public, anon;

-- ── 2. Heal legacy 1-char color_key on variant save when non-colliding ─────
create or replace function public.variants_fill_color_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_derived text;
  v_size_key text;
  v_model_key text;
begin
  v_derived := public.variant_color_key(coalesce(nullif(btrim(new.color_en), ''), nullif(btrim(new.color_ar), ''), ''));

  if tg_op = 'INSERT' then
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := v_derived;
    else
      new.color_key := public.variant_color_key(new.color_key);
      -- If a caller sent a 1-character prefix of the actual colour name on INSERT,
      -- prefer the full derived key so two colours starting with the same letter
      -- (e.g. RED and ROSE) never collide on color_key = 'r'.
      if char_length(new.color_key) = 1
         and char_length(v_derived) > 1
         and left(v_derived, 1) = new.color_key then
        new.color_key := v_derived;
      end if;
    end if;
  else
    if btrim(coalesce(new.color_key, '')) = '' then
      new.color_key := old.color_key;
    else
      new.color_key := public.variant_color_key(new.color_key);
    end if;

    -- Heal a legacy 1-character color_key (e.g. 'r' for 'ROSE' or 'ا' for 'احمر')
    -- on UPDATE when the full derived key is free on this product.
    if char_length(new.color_key) = 1
       and char_length(v_derived) > 1
       and left(v_derived, 1) = new.color_key then
      v_size_key := coalesce(lower(btrim(new.size_value)), '');
      v_model_key := coalesce(lower(btrim(coalesce(nullif(btrim(new.display_name_en), ''), nullif(btrim(new.display_name_ar), '')))), '');
      if not exists (
        select 1
          from public.product_variants pv
         where pv.product_id = new.product_id
           and pv.id <> new.id
           and pv.color_key = v_derived
           and coalesce(lower(btrim(pv.size_value)), '') = v_size_key
           and coalesce(lower(btrim(coalesce(nullif(btrim(pv.display_name_en), ''), nullif(btrim(pv.display_name_ar), '')))), '') = v_model_key
      ) then
        new.color_key := v_derived;
      end if;
    end if;

    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists product_variants_fill_color_key on public.product_variants;
create trigger product_variants_fill_color_key
  before insert or update on public.product_variants
  for each row execute function public.variants_fill_color_key();

-- ── 3. Sync branch_stock_balances.reorder_level when low_stock_level changes ─
create or replace function public.product_sync_branch_reorder_level()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_branch uuid;
begin
  if new.low_stock_level is not distinct from old.low_stock_level then
    return null;
  end if;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at, id limit 1;
  end if;
  if v_branch is not null then
    update public.branch_stock_balances
       set reorder_level = greatest(coalesce(new.low_stock_level, 0), 0),
           updated_at = now()
     where branch_id = v_branch
       and product_id = new.id
       and variant_id is null;
  end if;
  return null;
end;
$$;

drop trigger if exists product_sync_branch_reorder_level on public.products;
create trigger product_sync_branch_reorder_level
  after update of low_stock_level on public.products
  for each row execute function public.product_sync_branch_reorder_level();

create or replace function public.variant_sync_branch_reorder_level()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_branch uuid;
begin
  if new.low_stock_level is not distinct from old.low_stock_level then
    return null;
  end if;
  v_branch := public.current_branch_id();
  if v_branch is null then
    select id into v_branch from public.branches where is_default and active order by created_at, id limit 1;
  end if;
  if v_branch is not null then
    update public.branch_stock_balances
       set reorder_level = greatest(coalesce(new.low_stock_level, 0), 0),
           updated_at = now()
     where branch_id = v_branch
       and variant_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists variant_sync_branch_reorder_level on public.product_variants;
create trigger variant_sync_branch_reorder_level
  after update of low_stock_level on public.product_variants
  for each row execute function public.variant_sync_branch_reorder_level();

-- ── 4. Heal existing 1-character color_key rows non-destructively ──────────
update public.product_variants pv
   set color_key = public.variant_color_key(coalesce(nullif(btrim(pv.color_en), ''), nullif(btrim(pv.color_ar), ''), ''))
 where char_length(btrim(coalesce(pv.color_key, ''))) = 1
   and char_length(public.variant_color_key(coalesce(nullif(btrim(pv.color_en), ''), nullif(btrim(pv.color_ar), ''), ''))) > 1
   and not exists (
     select 1
       from public.product_variants other
      where other.product_id = pv.product_id
        and other.id <> pv.id
        and other.color_key = public.variant_color_key(coalesce(nullif(btrim(pv.color_en), ''), nullif(btrim(pv.color_ar), ''), ''))
        and coalesce(lower(btrim(other.size_value)), '') = coalesce(lower(btrim(pv.size_value)), '')
        and coalesce(lower(btrim(coalesce(nullif(btrim(other.display_name_en), ''), nullif(btrim(other.display_name_ar), '')))), '')
          = coalesce(lower(btrim(coalesce(nullif(btrim(pv.display_name_en), ''), nullif(btrim(pv.display_name_ar), '')))), '')
   );

-- ── 5. Harden backup restore for archived categories, shifts, & variants ───
alter table public.registers drop constraint if exists registers_branch_id_fkey;
alter table public.registers
  add constraint registers_branch_id_fkey foreign key (branch_id)
  references public.branches(id) on delete no action deferrable initially deferred;

alter table public.registers drop constraint if exists registers_created_by_fkey;
alter table public.registers
  add constraint registers_created_by_fkey foreign key (created_by)
  references public.profiles(id) on delete no action deferrable initially deferred;

create or replace function public.canonicalize_jsonb_numbers(p_val jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = public
as $function$
  select case jsonb_typeof(p_val)
    when 'number' then to_jsonb(trim_scale((p_val#>>'{}')::numeric))
    when 'array' then coalesce(
      (select jsonb_agg(public.canonicalize_jsonb_numbers(elem))
         from jsonb_array_elements(p_val) as elem),
      '[]'::jsonb
    )
    when 'object' then coalesce(
      (select jsonb_object_agg(k, public.canonicalize_jsonb_numbers(v))
         from jsonb_each(p_val) as e(k, v)),
      '{}'::jsonb
    )
    else p_val
  end;
$function$;

create or replace function public.build_snapshot_document(
  p_kind text default 'manual',
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  v_payload  jsonb := '{}'::jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_full     jsonb;
  v_rows     jsonb;
  v_table    text;
  v_kind     text;
  v_note     text;
  v_actor    uuid := auth.uid();
  v_name     text := '';
  v_revision text;
  v_row_total bigint := 0;
  v_len      bigint;
begin
  v_kind := case when p_kind in ('manual', 'automatic', 'pre_restore') then p_kind else 'manual' end;
  v_note := case when p_note is null or btrim(p_note) = '' then null else left(btrim(p_note), 500) end;

  foreach v_table in array public.backup_table_order() loop
    execute format(
      'select coalesce(jsonb_agg(x), ''[]''::jsonb) from (select * from public.%I) x',
      v_table
    ) into v_rows;

    v_len := jsonb_array_length(v_rows);
    v_payload := v_payload || jsonb_build_object(v_table, v_rows);
    v_counts  := v_counts  || jsonb_build_object(v_table, v_len);
    v_row_total := v_row_total + v_len;
  end loop;

  -- Canonicalize numeric scales (e.g. 220.00 -> 220, 12.50 -> 12.5) so that
  -- md5((payload)::text) is 100% invariant across JavaScript JSON.parse /
  -- JSON.stringify when a backup is downloaded to an external .json file and
  -- later uploaded via admin_restore_document().
  v_full := public.canonicalize_jsonb_numbers(jsonb_build_object('tables', v_payload));

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = v_actor;
  end if;
  v_name := coalesce(v_name, '');

  if to_regclass('supabase_migrations.schema_migrations') is not null then
    begin
      execute 'select max(version) from supabase_migrations.schema_migrations' into v_revision;
    exception when others then
      v_revision := null;
    end;
  end if;

  return jsonb_build_object(
    'format',          'alyq-backup',
    'schema_version',  1,
    'mode',            'supabase',
    'kind',            v_kind,
    'note',            v_note,
    'created_at',      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'created_by',      jsonb_build_object('id', coalesce(v_actor::text, ''), 'name', v_name),
    'source_revision', v_revision,
    'counts',          v_counts,
    'row_count',       v_row_total,
    'size_bytes',      octet_length(v_full::text),
    'checksum',        md5(v_full::text),
    'payload',         v_full
  );
end;
$function$;

revoke all on function public.build_snapshot_document(text, text) from public, anon, authenticated;

create or replace function public.normalize_backup_document_for_restore(p_document jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_held       jsonb;
  v_normalized jsonb := '{}'::jsonb;
  v_table      text;
  v_rows       jsonb;
  v_norm_rows  jsonb;
  v_expected   text;
begin
  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    return p_document;
  end if;
  v_expected := coalesce(p_document->>'checksum', '');
  v_held := p_document->'payload'->'tables';
  if v_expected = '' or v_held is null or jsonb_typeof(v_held) <> 'object' then
    return p_document;
  end if;
  -- Fast path: in-DB backups (admin_restore_backup) already match md5((payload)::text).
  if md5((p_document->'payload')::text) = v_expected then
    return p_document;
  end if;
  -- External JSON files downloaded via browser/CLI pass through JavaScript
  -- JSON.parse/JSON.stringify, which strips trailing decimal zeros (.00) on
  -- numeric(p,s) columns (e.g. 220.00 -> 220). Re-populating each known table
  -- through jsonb_populate_record restores the exact PostgreSQL column scales
  -- before admin_restore_document_branch_legacy verifies md5((payload)::text).
  foreach v_table in array public.backup_table_order() loop
    if not (v_held ? v_table) then
      return p_document;
    end if;
    v_rows := v_held->v_table;
    if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
      v_normalized := v_normalized || jsonb_build_object(v_table, '[]'::jsonb);
    else
      execute format(
        'select coalesce(jsonb_agg(to_jsonb(jsonb_populate_record(null::public.%I, e.value))), ''[]''::jsonb)
           from jsonb_array_elements($1) as e(value)',
        v_table
      ) into v_norm_rows using v_rows;
      v_normalized := v_normalized || jsonb_build_object(v_table, v_norm_rows);
    end if;
  end loop;
  return jsonb_set(p_document, '{payload,tables}', v_normalized, false);
exception when others then
  return p_document;
end
$function$;

revoke all on function public.normalize_backup_document_for_restore(jsonb) from public, anon, authenticated;

create or replace function public.admin_restore_document(p_document jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  v_previous text := current_setting('alyq.backup_restore', true);
  v_result jsonb;
begin
  perform set_config('alyq.backup_restore', 'on', true);
  v_result := public.admin_restore_document_branch_legacy(
    public.normalize_backup_document_for_restore(p_document)
  );
  delete from public.registers r
   where not exists (select 1 from public.branches b where b.id = r.branch_id)
      or not exists (select 1 from public.profiles p where p.id = r.created_by);
  perform set_config('alyq.backup_restore', coalesce(v_previous, ''), true);
  return v_result;
exception when others then
  perform set_config('alyq.backup_restore', coalesce(v_previous, ''), true);
  raise;
end
$function$;

revoke all on function public.admin_restore_document(jsonb) from public;
grant execute on function public.admin_restore_document(jsonb) to authenticated;

create or replace function public.enforce_shift_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid := public.current_branch_id();
  v_name text;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'open' then raise exception 'A shift cannot be created already closed' using errcode = 'check_violation'; end if;
    if not public.can('open_shift') then raise exception 'Not permitted to open shift' using errcode = 'insufficient_privilege'; end if;
    if v_branch is null then raise exception 'Active branch required' using errcode = 'insufficient_privilege'; end if;
    new.branch_id := v_branch; select name_en into new.branch from public.branches where id = v_branch;
    new.opened_by := auth.uid()::text; select name into v_name from public.profiles where id = auth.uid(); new.opened_by_name := coalesce(v_name, new.opened_by_name);
    if exists(select 1 from public.shifts where status = 'open' and opened_by = auth.uid()::text) then
      raise exception 'This cashier already has an open shift' using errcode = 'unique_violation';
    end if;
    if exists(select 1 from public.shifts where branch_id = v_branch and status = 'open') then
      raise exception 'An open shift already exists in this branch' using errcode = 'unique_violation';
    end if;
    return new;
  end if;
  if old.branch_id <> v_branch then raise exception 'Cross-branch shift write rejected' using errcode = 'insufficient_privilege'; end if;
  if old.status = 'closed' then
    if new.adjustment_approved_at is distinct from old.adjustment_approved_at then
      if old.adjustment_approved_at is not null then raise exception 'A shift adjustment can only be approved once' using errcode = 'check_violation'; end if;
      if not public.can('approve_shift_adjustment') then raise exception 'Closed shift adjustment is not permitted' using errcode = 'insufficient_privilege'; end if;
      return new;
    end if;
    if new is distinct from old then raise exception 'A closed shift cannot be edited' using errcode = 'check_violation'; end if;
    return new;
  end if;
  if new.status = 'closed' then
    if current_setting('alyq.shift_closing', true) is distinct from old.id::text then raise exception 'Use the authoritative close-shift operation' using errcode = 'insufficient_privilege'; end if;
    if not public.can('close_shift') then raise exception 'Not permitted to close shift' using errcode = 'insufficient_privilege'; end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_shift_invariants() from public, anon, authenticated;

create or replace function public.variants_enforce_price_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.price_override is distinct from old.price_override and not public.can('change_price') then
      raise exception 'Changing a variant price requires the change_price capability'
        using errcode = 'insufficient_privilege';
    end if;
    if new.cost_override is distinct from old.cost_override and not public.can('change_cost') then
      raise exception 'Changing a variant cost requires the change_cost capability'
        using errcode = 'insufficient_privilege';
    end if;
  else
    if new.price_override is not null and not public.can('change_price') then
      raise exception 'Setting a variant price requires the change_price capability'
        using errcode = 'insufficient_privilege';
    end if;
    if new.cost_override is not null and not public.can('change_cost') then
      raise exception 'Setting a variant cost requires the change_cost capability'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.enforce_expense_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  text := auth.uid()::text;
  v_role public.app_role := public.current_user_role();
  v_approval uuid;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if not public.can('add_expense') then
      raise exception 'Your role cannot record an expense' using errcode = 'insufficient_privilege';
    end if;
    if v_uid is not null then
      new.user_id := v_uid;
      if v_role is not null then
        new.user_name := (select p.name from public.profiles p where p.id = auth.uid());
      end if;
    end if;
  else
    if not public.can('edit_expense') then
      raise exception 'Your role cannot edit an expense' using errcode = 'insufficient_privilege';
    end if;
    new.user_id    := old.user_id;
    new.user_name  := old.user_name;
    new.created_at := old.created_at;
  end if;

  if (tg_op = 'INSERT' or new.amount > old.amount)
     and public.approval_required_for('expense', new.amount) then
    v_approval := public.approval_assert_satisfied(
      'expense', new.amount, null, '{}'::jsonb
    );
    perform public.mark_approval_applied(v_approval, new.id::text);
  end if;

  if new.shift_id is not null then
    if not exists (select 1 from public.shifts s where s.id = new.shift_id) then
      raise exception 'Shift % not found', new.shift_id using errcode = 'foreign_key_violation';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.stamp_refund_settlement_shift()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift uuid;
  v_branch uuid := public.current_branch_id();
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'completed' then
      new.settlement_shift_id := old.settlement_shift_id;
      return new;
    end if;
    if new.status <> 'completed' then
      new.settlement_shift_id := old.settlement_shift_id;
      return new;
    end if;
  elsif new.status <> 'completed' then
    new.settlement_shift_id := null;
    return new;
  end if;
  select id into v_shift from public.shifts
   where branch_id = v_branch and status = 'open' for update;
  if v_shift is null and new.payment_method = 'cash' then
    raise exception 'A completed cash refund requires an open branch shift' using errcode = 'no_data_found';
  end if;
  new.settlement_shift_id := coalesce(v_shift, new.settlement_shift_id);
  return new;
end;
$$;

revoke all on function public.stamp_refund_settlement_shift() from public, anon, authenticated;

create or replace function public.enforce_approval_request_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_name text;
  v_inline text;
  v_inline_expected text;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'An approval request cannot be deleted; it is the record of a decision' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if new.amount is distinct from old.amount or new.limit_value is distinct from old.limit_value
       or new.previous_value is distinct from old.previous_value or new.new_value is distinct from old.new_value
       or new.payload is distinct from old.payload or new.kind is distinct from old.kind
       or new.requested_by is distinct from old.requested_by or new.request_number is distinct from old.request_number
       or new.branch_id is distinct from old.branch_id or new.operation_type is distinct from old.operation_type
       or new.operation_fingerprint is distinct from old.operation_fingerprint
       or new.correlation_id is distinct from old.correlation_id or new.expires_at is distinct from old.expires_at then
      raise exception 'An approval request cannot be rewritten; the ask is fixed' using errcode = 'check_violation';
    end if;
    if new.status is distinct from old.status then
      if old.status <> 'pending' then raise exception 'This request was already %', old.status using errcode = 'check_violation'; end if;
      if new.status = 'cancelled' then
        if coalesce(v_uid, '') <> old.requested_by and not public.can('approve_limit_request') then
          raise exception 'Only the requester may withdraw a request' using errcode = 'insufficient_privilege';
        end if;
        new.decided_at := coalesce(new.decided_at, now());
        new.decided_by := coalesce(new.decided_by, v_uid, old.requested_by);
        if new.decided_by_name is null then
          select name into v_name from public.profiles where id = auth.uid();
          new.decided_by_name := coalesce(v_name, old.requested_by_name);
        end if;
        return new;
      end if;
      v_inline := current_setting('alyq.manager_approval', true);
      v_inline_expected := old.id::text || ':' || coalesce(new.approver_user_id::text, '');
      if not public.can('approve_limit_request') and v_inline is distinct from v_inline_expected then
        raise exception 'Your role cannot decide an approval request' using errcode = 'insufficient_privilege';
      end if;
      if new.status = 'rejected' and nullif(btrim(coalesce(new.decision_note, '')), '') is null then
        raise exception 'A rejected request needs a note saying why' using errcode = 'check_violation';
      end if;
      new.decided_at := coalesce(new.decided_at, now());
      if v_inline = v_inline_expected then
        new.decided_by := new.approver_user_id::text;
        select name into v_name from public.profiles where id = new.approver_user_id;
        new.decided_by_name := v_name;
      elsif v_uid is not null then
        new.decided_by := v_uid;
        select name into v_name from public.profiles where id = auth.uid();
        new.decided_by_name := coalesce(v_name, new.decided_by_name);
      end if;
    end if;
    return new;
  end if;
  new.requested_at := coalesce(new.requested_at, now());
  if v_uid is not null then
    new.requested_by := v_uid;
    select name into v_name from public.profiles where id = auth.uid();
    new.requested_by_name := coalesce(v_name, new.requested_by_name);
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_approval_request_invariants() from public, anon, authenticated;

create or replace function public.stocktakes_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'finalized'
       and exists (select 1 from public.stocktake_lines l where l.stocktake_id = old.id) then
      raise exception 'A finalized stocktake is historical and cannot be deleted'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'finalized' then
    raise exception 'A finalized stocktake is historical and cannot be rewritten'
      using errcode = 'check_violation';
  end if;
  if new.status = 'finalized' and old.status is distinct from 'finalized'
     and current_setting('alyq.stocktake_finalizing', true) is distinct from new.id::text then
    raise exception 'Only stocktake_finalize may mark a stocktake finalized'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.stocktake_lines_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
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

create or replace function public.stocktakes_drop_empty()
returns trigger
language plpgsql
as $$
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return null;
  end if;
  delete from public.stocktakes s
   where not exists (select 1 from public.stocktake_lines l where l.stocktake_id = s.id);
  return null;
end;
$$;

create or replace function public.stamp_branch_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid := public.current_branch_id();
  v_transfer uuid;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if tg_table_name in ('sale_items','sale_payments') then
    select branch_id into new.branch_id from public.sales where id = new.sale_id;
  elsif tg_table_name in ('sales_returns','refund_records') then
    select branch_id into new.branch_id from public.sales where id = new.sale_id;
    if v_branch is not null and new.branch_id <> v_branch then raise exception 'Cross-branch financial write rejected' using errcode = '42501'; end if;
  elsif tg_table_name = 'return_items' then
    select branch_id into new.branch_id from public.sales_returns where id = new.return_id;
  elsif tg_table_name = 'order_events' then
    select branch_id into new.branch_id from public.online_orders where id = new.order_id;
  elsif tg_table_name = 'stock_reservations' then
    select branch_id into new.branch_id from public.online_orders where id = new.online_order_id;
  elsif tg_table_name = 'stock_movements' and nullif(current_setting('alyq.authoritative_stock_transfer', true), '') is not null then
    v_transfer := current_setting('alyq.authoritative_stock_transfer', true)::uuid;
    if new.source_type <> 'transfer' or new.source_id is distinct from v_transfer
       or not exists(select 1 from public.stock_transfers t where t.id = v_transfer and new.branch_id in(t.source_branch_id, t.destination_branch_id)) then
      raise exception 'Forged transfer movement branch rejected' using errcode = '42501';
    end if;
  elsif v_branch is not null then
    new.branch_id := v_branch;
  elsif new.branch_id is null then
    select id into new.branch_id from public.branches where is_default order by created_at limit 1;
  end if;
  return new;
end
$function$;

revoke all on function public.stamp_branch_scope() from public, anon, authenticated;

create or replace function public.stamp_register_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_id uuid;
  v_register public.registers;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  begin v_id := nullif(current_setting('alyq.register_id', true), '')::uuid;
  exception when invalid_text_representation then v_id := null; end;
  if tg_table_name = 'sales' then
    select b.name_en into new.branch_name from public.branches b where b.id = new.branch_id;
    if new.source = 'pos' and v_id is not null then
      select * into v_register from public.registers where id = v_id and active;
      if v_register.id is null or v_register.branch_id is distinct from new.branch_id then
        raise exception 'Sale register does not match its authoritative branch' using errcode = '42501';
      end if;
      new.register_id := v_register.id; new.register_name := v_register.name;
    else new.register_id := null; new.register_name := null;
    end if;
  elsif tg_table_name = 'shifts' then
    if v_id is not null then
      select * into v_register from public.registers where id = v_id and active;
      if v_register.id is null then raise exception 'Active register required' using errcode = '42501'; end if;
      new.register_id := v_register.id; new.register := v_register.name;
    else new.register_id := null;
    end if;
  elsif tg_table_name = 'cash_movements' then
    select register_id into new.register_id from public.shifts where id = new.shift_id;
  end if;
  return new;
end
$function$;

revoke all on function public.stamp_register_evidence() from public, anon, authenticated;

create or replace function public.branch_stock_validate_shelf()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product uuid;
  v_active boolean;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  select active into v_active from public.branches where id = new.branch_id;
  if not found or not v_active then
    raise exception 'Stock branch is missing or inactive' using errcode = '23514';
  end if;
  if new.variant_id is not null then
    select product_id into v_product from public.product_variants where id = new.variant_id;
    if v_product is null or v_product <> new.product_id then
      raise exception 'Stock variant does not belong to its product' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create or replace function public.branch_stock_rollup_legacy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_product uuid := case when tg_op = 'DELETE' then old.product_id else new.product_id end;
  v_variant uuid := case when tg_op = 'DELETE' then old.variant_id else new.variant_id end;
  v_total integer;
  v_previous_rollup text := current_setting('alyq.branch_stock_rollup', true);
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return null;
  end if;
  if v_variant is not null then
    select coalesce(sum(quantity), 0)::integer into v_total
      from public.branch_stock_balances where variant_id = v_variant;
    perform set_config('alyq.branch_stock_rollup', v_variant::text, true);
    update public.product_variants
       set stock_quantity = v_total, updated_at = now()
     where id = v_variant and stock_quantity is distinct from v_total;
  else
    if exists(select 1 from public.products where id = v_product and not variants_enabled) then
      select coalesce(sum(quantity), 0)::integer into v_total
        from public.branch_stock_balances where product_id = v_product and variant_id is null;
      perform set_config('alyq.branch_stock_rollup', v_product::text, true);
      update public.products
         set stock_quantity = v_total, updated_at = now()
       where id = v_product and stock_quantity is distinct from v_total;
    end if;
  end if;
  perform set_config('alyq.branch_stock_rollup', coalesce(v_previous_rollup, ''), true);
  return null;
end
$function$;

create or replace function public.variants_sync_product_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_total      integer;
  v_enabled    boolean;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return null;
  end if;
  v_product_id := case when tg_op = 'DELETE' then old.product_id else new.product_id end;

  select variants_enabled into v_enabled from public.products where id = v_product_id;
  if not coalesce(v_enabled, false) then
    return null;
  end if;

  select coalesce(sum(stock_quantity), 0)::integer
    into v_total
    from public.product_variants
   where product_id = v_product_id;

  perform set_config('alyq.variant_rollup_product', v_product_id::text, true);

  update public.products
     set stock_quantity = v_total,
         updated_at     = now()
   where id = v_product_id
     and stock_quantity is distinct from v_total;

  return null;
end
$$;

create or replace function public.stock_movement_branch_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_after integer;
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return new;
  end if;
  if new.source_type is null
     and new.reason <> 'customer_return'
     and coalesce(new.notes, '') not like 'Sale %'
     and coalesce(new.notes, '') not like 'Online order %'
     and coalesce(new.notes, '') not like 'Void of %' then
    return new;
  end if;
  select quantity into v_after from public.branch_stock_balances
   where branch_id = new.branch_id and product_id = new.product_id
     and variant_id is not distinct from new.variant_id;
  if v_after is null then return new; end if;
  if new.type in ('issue', 'adjustment_out', 'transfer') then
    new.quantity_after := v_after; new.quantity_before := v_after + new.delta;
  elsif new.type in ('receive', 'adjustment_in') then
    new.quantity_after := v_after; new.quantity_before := v_after - new.delta;
  end if;
  return new;
end
$function$;

create or replace function public.notification_enqueue_safe(
  p_dedupe_key text, p_kind text, p_branch_id uuid, p_entity_type text, p_entity_id text,
  p_route_key text, p_route_entity_id text, p_required_capabilities text[],
  p_title_en text, p_title_ar text, p_body_en text, p_body_ar text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if current_setting('alyq.backup_restore', true) = 'on' then
    return null;
  end if;
  return public.notification_enqueue(
    p_dedupe_key, p_kind, p_branch_id, p_entity_type, p_entity_id, p_route_key,
    p_route_entity_id, p_required_capabilities, p_title_en, p_title_ar, p_body_en, p_body_ar);
exception when others then
  return null;
end
$function$;

revoke all on function public.notification_enqueue_safe(text,text,uuid,text,text,text,text,text[],text,text,text,text)
  from public, anon, authenticated;

-- ── 6. Keep application/database health contract aligned with 0098 ─────────
create or replace function public.system_health_probe()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_branch uuid := public.current_branch_id();
begin
  if auth.uid() is null then
    raise exception 'Authenticated health check required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'authenticated', true,
    'server_time', now(),
    'migration', '0098_product_and_variant_save_hardening.sql',
    'migration_count', 98,
    'active_branch_id', v_branch,
    'branch_context_valid', v_branch is not null and public.can_access_branch(v_branch)
  );
end
$function$;

revoke all on function public.system_health_probe() from public, anon;
grant execute on function public.system_health_probe() to authenticated, service_role;

comment on function public.system_health_probe() is
  'Authenticated health contract for migration 0098_product_and_variant_save_hardening.sql (count 98).';

commit;

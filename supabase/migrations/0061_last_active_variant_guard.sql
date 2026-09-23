-- A variant-enabled product must keep a sellable combination. Migration 0043
-- checked the NUMBER of rows before delete, but an archived sibling does not
-- make the last active shelf sellable. Lock the parent before checking active
-- siblings: concurrent archive/delete operations on different shelves then
-- serialize instead of each seeing the other shelf as still active.
-- Existing RLS granted direct DELETE and direct UPDATE(active) to authenticated;
-- both skip these lifecycle RPCs. Keep metadata editing and the Phase 43
-- adjust_stock-only shelf update, but reserve deletion and active changes for
-- the guarded SECURITY DEFINER functions. Owner-run conversion, stocktake and
-- factory-reset functions retain their own explicit semantics.
revoke update, delete on table public.product_variants from public, anon, authenticated;
grant update (sku, barcode, color_key, color_ar, color_en, color_hex, size, size_label,
              image_url, price_override, cost_override, stock_quantity,
              low_stock_level, sort_order)
  on table public.product_variants to authenticated;

create or replace function public.set_variant_active(p_variant_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id uuid;
  v_variant   public.product_variants%rowtype;
  v_product   public.products%rowtype;
  v_others    integer;
begin
  if not public.can('edit_product') then
    raise exception 'Archiving a variant requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select product_id into v_parent_id from public.product_variants where id = p_variant_id;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_parent_id for update;
  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  if v_product.id is null or v_variant.product_id <> v_product.id then
    raise exception 'Variant % changed product during archive', p_variant_id using errcode = 'check_violation';
  end if;

  if v_variant.active = p_active then
    return jsonb_build_object('variant_id', v_variant.id, 'active', v_variant.active, 'changed', false);
  end if;

  if not p_active and v_product.variants_enabled then
    select count(*) into v_others
      from public.product_variants
     where product_id = v_variant.product_id and id <> v_variant.id and active;
    if v_others = 0 then
      raise exception 'Product % would have nothing left to sell — add or reactivate another combination first',
        v_product.sku using errcode = 'check_violation';
    end if;
  end if;

  update public.product_variants set active = p_active, updated_at = now() where id = v_variant.id;
  return jsonb_build_object('variant_id', v_variant.id, 'active', p_active, 'changed', true,
                            'sku', v_variant.sku);
end
$$;

create or replace function public.delete_variant(p_variant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_id uuid;
  v_variant   public.product_variants%rowtype;
  v_product   public.products%rowtype;
  v_refs      record;
  v_siblings  integer;
  v_active    integer;
  v_counts    integer;
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a variant requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select product_id into v_parent_id from public.product_variants where id = p_variant_id;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  select * into v_product from public.products where id = v_parent_id for update;
  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Variant % not found', p_variant_id using errcode = 'foreign_key_violation';
  end if;
  if v_product.id is null or v_variant.product_id <> v_product.id then
    raise exception 'Variant % changed product during deletion', p_variant_id using errcode = 'check_violation';
  end if;

  if v_product.variants_enabled then
    select count(*), count(*) filter (where active)
      into v_siblings, v_active
      from public.product_variants
     where product_id = v_variant.product_id and id <> v_variant.id;
    if v_siblings = 0 or (v_variant.active and v_active = 0) then
      raise exception 'Product % would have nothing left to sell — add or reactivate another combination first',
        v_product.sku using errcode = 'check_violation';
    end if;
  end if;

  select * into v_refs from public.variant_reference_counts(p_variant_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception 'Variant % is named by % historical record(s) — archive it instead of deleting',
      v_variant.sku, v_refs.total using errcode = 'restrict_violation';
  end if;
  -- 0060 added stocktake snapshots with an ON DELETE SET NULL FK for the
  -- admin danger-zone wipe. The normal delete RPC must KEEP its explicit
  -- stocktake-history refusal, even though that FK would allow the removal.
  select count(*) into v_counts from public.stocktake_lines where variant_id = p_variant_id;
  if v_counts > 0 then
    raise exception 'Variant % is named by a stocktake and cannot be deleted; archive it instead',
      v_variant.sku using errcode = 'restrict_violation';
  end if;

  delete from public.product_variants where id = v_variant.id;
  return jsonb_build_object('variant_id', v_variant.id, 'sku', v_variant.sku, 'deleted', true);
end
$$;

comment on function public.delete_variant(uuid) is
  'Deletes an unreferenced combination (sales, returns, stocktake history). A variant product must retain an active shelf even if archived siblings exist; archive/delete checks serialize on the product row.';
comment on function public.set_variant_active(uuid, boolean) is
  'Archives/reactivates one shelf. Refuses the last active shelf and serializes with delete_variant on the product row.';

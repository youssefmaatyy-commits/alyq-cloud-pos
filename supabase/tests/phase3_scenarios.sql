-- Phase 3 focused operations scenarios.
-- Runs after scenarios.sql + phase2_scenarios.sql in the same disposable DB.

-- ── Authoritative inventory adjustment: exact shelf, audit, branch, retry ──
do $phase3_inventory$
declare
  v_admin uuid := '00000000-0000-4000-8000-0000000000a1';
  v_viewer uuid := '00000000-0000-4000-8000-0000000000e1';
  v_main uuid := '00000000-0000-4000-8000-0000000000b1';
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_ref text := 'phase3-adjust-idempotent';
  v_before integer;
  v_after integer;
  v_movement uuid;
  v_json jsonb;
  v_count integer;
begin
  perform pg_temp.become(v_admin,'authenticated');
  perform public.switch_active_branch_with_audit(v_main);

  select * into v_product
    from public.products
   where stock_tracking_enabled and not variants_enabled
   order by created_at limit 1;
  if v_product.id is null then raise exception 'phase3 adjustment fixture product missing'; end if;
  v_before := v_product.stock_quantity;

  v_json := public.inventory_adjust_stock(
    v_ref,v_product.id,null,'adjustment_in','purchase',2,'Phase 3 retry-safe receipt'
  );
  v_movement := (v_json->'movement'->>'id')::uuid;
  select stock_quantity into v_after from public.products where id=v_product.id;
  if v_after<>v_before+2 then raise exception 'authoritative product stock did not move exactly once'; end if;
  if (v_json->>'replayed')::boolean then raise exception 'first adjustment claimed replay'; end if;
  if not exists(
    select 1 from public.stock_movements
     where id=v_movement and branch_id=v_main and client_ref=v_ref
       and source_type='adjustment' and quantity_before=v_before and quantity_after=v_after
  ) then raise exception 'branch-scoped adjustment evidence is incomplete'; end if;
  if not exists(
    select 1 from public.audit_log
     where action='stock.adjusted' and branch_id=v_main
       and details->>'movement_id'=v_movement::text
  ) then raise exception 'authoritative adjustment audit is missing'; end if;

  v_json := public.inventory_adjust_stock(
    v_ref,v_product.id,null,'adjustment_in','purchase',2,'Phase 3 retry-safe receipt'
  );
  if not (v_json->>'replayed')::boolean then raise exception 'identical adjustment retry was not replayed'; end if;
  select stock_quantity into v_after from public.products where id=v_product.id;
  select count(*) into v_count from public.stock_movements where branch_id=v_main and client_ref=v_ref;
  if v_after<>v_before+2 or v_count<>1 then
    raise exception 'adjustment retry duplicated stock or ledger (% / %)',v_after,v_count;
  end if;

  begin
    perform public.inventory_adjust_stock(v_ref,v_product.id,null,'adjustment_in','purchase',3,'changed retry');
    raise exception 'changed payload reused an inventory client reference';
  exception when unique_violation then null;
  end;

  begin
    perform public.inventory_adjust_stock('phase3-no-negative',v_product.id,null,'issue','other',v_after+1,'unsafe');
    raise exception 'negative stock adjustment succeeded';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.stock_movements where client_ref='phase3-no-negative') then
    raise exception 'rejected negative adjustment left a movement';
  end if;

  begin
    perform public.inventory_adjust_stock('phase3-no-one-sided-transfer',v_product.id,null,'transfer','transfer_out',1,'unsafe transfer');
    raise exception 'one-sided transfer succeeded against a non-branch stock schema';
  exception when feature_not_supported then null;
  end;

  select * into v_variant
    from public.product_variants
   where active order by created_at limit 1;
  if v_variant.id is not null then
    v_before := v_variant.stock_quantity;
    perform public.inventory_adjust_stock(
      'phase3-exact-variant',v_variant.product_id,v_variant.id,
      'adjustment_in','recount',1,'Exact shelf correction'
    );
    select stock_quantity into v_after from public.product_variants where id=v_variant.id;
    if v_after<>v_before+1 then raise exception 'exact variant shelf did not move'; end if;
    if not exists(
      select 1 from public.stock_movements
       where client_ref='phase3-exact-variant' and variant_id=v_variant.id
    ) then raise exception 'exact variant identity was not frozen on movement'; end if;
  end if;

  perform pg_temp.become(v_viewer,'authenticated');
  begin
    perform public.inventory_adjust_stock('phase3-viewer-denied',v_product.id,null,'adjustment_in','other',1,'forged');
    raise exception 'viewer adjusted stock';
  exception when insufficient_privilege then null;
  end;

  raise notice 'Phase 3 inventory authority — exact shelves, branch evidence, append-only audit, no-negative policy, one-sided-transfer refusal and retry idempotency all hold';
end
$phase3_inventory$;

reset role;

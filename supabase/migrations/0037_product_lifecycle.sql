-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0037
-- Phase 25 — safe product delete & archive lifecycle
--
-- THE GAP
--   The products screen has always offered Archive, but permanent deletion was
--   a stub: `catalogService.deleteProduct()` asserted the capability and then
--   threw for everybody, and no screen called it. The register recorded the
--   database side honestly as "no write path". That left the owner of an
--   installation with no sanctioned way to remove a product that was created
--   by mistake and never sold, and no structured answer — only a toast — for
--   one that has a history.
--
-- WHAT CHANGES
--   The lifecycle now has exactly two server-side verbs, both re-checking the
--   same capabilities the app checks, so a hand-built RPC call gets the same
--   answer a screen gets:
--
--     · public.delete_product(p_product_id)
--         Requires delete_product (0030 already gave the raw table a DELETE
--         policy on that capability; this function is now the path the app
--         uses). The product is locked, its historical references are COUNTED,
--         and the delete raises RESTRICT_VIOLATION when any exist — defence in
--         depth on top of the FK's own ON DELETE RESTRICT, with a message that
--         says why instead of a bare constraint name. Only a product with NO
--         references in the tables a deleted row would orphan is removed:
--
--           sale_items            the invoice history every report reads
--           return_items          the goods side of refunds
--           stock_movements       the immutable stock ledger (auditable)
--           online_order_items    the website's snapshot of what was ordered
--           stock_reservations    the hold record behind pending website orders
--
--         product_content and store_reviews are NOT counted: their FK is
--         `on delete cascade` by design — they are storefront dressing, not
--         business history, and removing them with the product is exactly what
--         that cascade was written for. The audit row is written BEFORE the
--         delete: one written after would reference a row that no longer
--         exists, and one not written at all leaves the removal invisible.
--
--     · public.set_product_active(p_product_id, p_active)
--         Archive / reactivate, requiring edit_product — the same capability
--         the RLS update policy and the app's archive toggle already use. A
--         product with a history is never refused its archive, and either
--         transition is idempotent: asking for the state the row is already in
--         answers `changed: false` instead of failing, so a double-submitted
--         click does not turn into an error toast. The transition is written
--         to the trail as product.archived / product.reactivated.
--
--     · public.product_reference_counts(p_product_id)
--         The read side of the same decision, so the screen can disable the
--         permanent-delete action and name the reason BEFORE the click, rather
--         than failing afterwards. A single product's counts, or every
--         referenced product at once (null argument) for the list page. Stored
--         as STABLE, definer, on the same capability as deletion: only a seat
--         that could act on the answer may read it.
--
-- WHAT DOES NOT CHANGE
--   · The lifecycle state itself. `products.active` already exists and every
--     selling surface already honours it: the POS grid filters on it
--     (ProductGrid), the storefront catalogue (0030) and best-sellers (0019)
--     `where p.active`, place_online_order refuses an inactive line (0034),
--     and pos_complete_sale refuses one at the till (0035). Archived needed no
--     new column and no new vocabulary — this migration adds no status field.
--   · No ON DELETE behaviour anywhere: the five history tables keep their
--     RESTRICT, the two storefront tables keep their CASCADE.
--   · RLS: the 0030 policies are exactly as they were. These functions run as
--     the owner and decide by `public.can()` — the same word the policies use
--     — so direct RPC calls cannot bypass anything a screen is held to.
--   · Historical resolution: nothing here touches a sale, a return, a
--     movement, an order or a report. An archived product still renders on the
--     invoice that references it; reports join products alive.
--
-- The vocabulary for the three new audit events is added before the functions
-- because audit_log.action references public.audit_actions(action); the parity
-- check diffs that table against AUDIT_ACTIONS in src/modules/audit/types.ts,
-- so the TypeScript side moves in the same commit.
--
-- Idempotent throughout: create-or-replace, on-conflict-do-nothing, revokes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── audit vocabulary · the product lifecycle ────────────────────────────────
insert into public.audit_actions (action, entity) values
  ('product.deleted',     'product'),
  ('product.archived',    'product'),
  ('product.reactivated', 'product')
on conflict (action) do nothing;

-- ── 1. how much history does a product have? ────────────────────────────────
-- The five tables a permanently deleted product would orphan. Counts, not
-- rows: the screen needs "0 vs some" and a reason, never the records
-- themselves, so that is all this function returns.
create or replace function public.product_reference_counts(p_product_id uuid default null)
returns table (
  product_id           uuid,
  sale_items           bigint,
  return_items         bigint,
  stock_movements      bigint,
  online_order_items   bigint,
  stock_reservations   bigint,
  total                bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- The answer decides whether delete is possible at all, so it is read by the
  -- seats that hold that action. `can()` resolves custom roles and per-user
  -- exceptions, exactly as everywhere else.
  if not public.can('delete_product') then
    raise exception 'Reading product reference counts requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select p.id,
           (select count(*) from public.sale_items si          where si.product_id = p.id),
           (select count(*) from public.return_items ri        where ri.product_id = p.id),
           (select count(*) from public.stock_movements sm     where sm.product_id = p.id),
           (select count(*) from public.online_order_items oi  where oi.product_id = p.id),
           (select count(*) from public.stock_reservations sr  where sr.product_id = p.id),
           (select count(*) from public.sale_items si          where si.product_id = p.id)
         + (select count(*) from public.return_items ri        where ri.product_id = p.id)
         + (select count(*) from public.stock_movements sm     where sm.product_id = p.id)
         + (select count(*) from public.online_order_items oi  where oi.product_id = p.id)
         + (select count(*) from public.stock_reservations sr  where sr.product_id = p.id)
      from public.products p
     where p_product_id is null or p.id = p_product_id
     order by p.id;
end;
$$;

comment on function public.product_reference_counts(uuid) is
  'How many rows in the history tables (sale_items, return_items, stock_movements, online_order_items, stock_reservations) reference each product. total > 0 means permanent deletion must be refused and archive is the answer. delete_product holders only.';

-- ── 2. archive / reactivate ─────────────────────────────────────────────────
create or replace function public.set_product_active(p_product_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_actor   text := auth.uid()::text;
  v_name    text;
begin
  -- The archive toggle in the app asks edit_product (product.activate in the
  -- register); the RLS update policy asks the same. The function does not
  -- introduce a second authority.
  if not public.can('edit_product') then
    raise exception 'Changing a product''s active state requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  -- Idempotent: a retried click finds the product already in the wanted state
  -- and is answered, not refused. Only a real transition is written to the
  -- trail — a replay must not manufacture a second audit event.
  if v_product.active is not distinct from p_active then
    return jsonb_build_object(
      'product_id', v_product.id,
      'active',     v_product.active,
      'changed',    false
    );
  end if;

  update public.products set active = p_active where id = p_product_id
  returning * into v_product;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    case when p_active then 'product.reactivated' else 'product.archived' end,
    'product',
    v_product.id::text,
    v_product.sku,
    jsonb_build_object(
      'product',  v_product.name_en,
      'sku',      v_product.sku,
      'previous', not p_active,
      'next',     p_active
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, v_actor, 'Unknown')
  );

  return jsonb_build_object(
    'product_id', v_product.id,
    'active',     v_product.active,
    'changed',    true
  );
end;
$$;

comment on function public.set_product_active(uuid, boolean) is
  'Archive (false) or reactivate (true) a product. Requires edit_product; idempotent; writes product.archived / product.reactivated to the audit trail.';

-- ── 3. permanent delete — only for a product with no history ────────────────
create or replace function public.delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.products%rowtype;
  v_refs    record;
  v_actor   text := auth.uid()::text;
  v_name    text;
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a product requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product % not found', p_product_id using errcode = 'foreign_key_violation';
  end if;

  select * into v_refs from public.product_reference_counts(p_product_id);
  if coalesce(v_refs.total, 0) > 0 then
    raise exception
      'Product % has historical transactions (sale_items %, return_items %, stock_movements %, online_order_items %, stock_reservations %) and cannot be permanently deleted; archive it instead',
      v_product.sku, v_refs.sale_items, v_refs.return_items, v_refs.stock_movements,
      v_refs.online_order_items, v_refs.stock_reservations
      using errcode = 'restrict_violation';
  end if;

  select p.name into v_name from public.profiles p where p.id = auth.uid();

  -- Before the delete: an audit row written afterwards would describe a row
  -- that no longer exists (and could never be written at all if the delete
  -- failed underneath it). The label and details carry only catalogue facts,
  -- never anything about staff or customers.
  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    'product.deleted',
    'product',
    v_product.id::text,
    v_product.sku,
    jsonb_build_object(
      'product', v_product.name_en,
      'sku',     v_product.sku,
      'barcode', v_product.barcode
    ),
    coalesce(v_actor, 'system'),
    coalesce(v_name, v_actor, 'Unknown')
  );

  delete from public.products where id = p_product_id;

  return jsonb_build_object(
    'deleted',    true,
    'product_id', v_product.id,
    'sku',        v_product.sku
  );
end;
$$;

comment on function public.delete_product(uuid) is
  'Permanently delete a product ONLY when no business/history table references it (refused with restrict_violation otherwise — archive those). Requires delete_product; writes product.deleted to the audit trail before the delete. No cascade reaches a history table: product_content and store_reviews go with the row by their own on delete cascade.';

-- ── 4. grants ────────────────────────────────────────────────────────────────
-- Staff functions: a signed-in member of staff may attempt them (the function
-- itself decides by capability). Anonymous visitors have no business here at
-- all.
revoke execute on function public.product_reference_counts(uuid)        from public, anon;
revoke execute on function public.set_product_active(uuid, boolean)     from public, anon;
revoke execute on function public.delete_product(uuid)                  from public, anon;

grant execute on function public.product_reference_counts(uuid)    to authenticated;
grant execute on function public.set_product_active(uuid, boolean) to authenticated;
grant execute on function public.delete_product(uuid)              to authenticated;

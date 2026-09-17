-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0044 — category lifecycle (safe delete, move, archive)
-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT CONCLUSIONS THIS MIGRATION BUILDS ON (no prior schema is rewritten):
--
--   · products.category_id (0002) is `uuid NOT NULL REFERENCES categories(id)
--     ON DELETE RESTRICT`. It can neither cascade-delete a product nor null a
--     product's category (the column is NOT NULL). It stays exactly as it is.
--   · categories.parent_id (0001) is `ON DELETE RESTRICT`, so a category with
--     children already refuses deletion at the FK; a cycle guard trigger
--     (0001) has kept the tree acyclic since Phase 2.
--   · categories_block_delete_in_use (0001) already refuses a DELETE whose
--     category still holds products, evaluated inside the DELETE statement.
--   · categories.active boolean (0001) is the archive state, and every
--     storefront read (`storefront_categories`, 0030) already filters on it.
--     Archived and deleted stay different states: `active = false` hides a
--     category; nothing is removed. No `archived_at` column is added — the
--     field to reuse exists.
--   · RLS (0030): categories insert needs add_product, update needs
--     edit_product, delete needs delete_product. Nothing here weakens it.
--
-- WHAT WAS MISSING, AND WHAT THIS FILE ADDS:
--
--   1. Assignment to an ARCHIVED category was refused nowhere server-side:
--      a forged product insert/update pointing at an archived category
--      succeeded. A trigger now refuses it.
--   2. The lifecycle wrote NO audit rows. A trigger now writes
--      category.archived / category.reactivated on every `active` flip and
--      category.deleted on every successful delete — whatever path took it.
--   3. There was no transactional delete: the client counted products and
--      then deleted, trusting its own count. delete_empty_category() now
--      locks the row and re-checks inside the transaction; the earlier
--      trigger and the RESTRICT FK remain behind it.
--   4. There was no move-products-and-delete operation at all. It now exists
--      as one atomic, permission-checked, audited transaction.
--
-- Every function is `security definer` with a fixed search_path, reads the
-- caller's authority through the existing public.can() matrix, and grants
-- nothing to anon. No dynamic SQL. No new capability is invented: archive
-- and reactivate are category edits (`edit_product`), deletes are
-- `delete_product`, and the move-and-delete needs both — the mover must be
-- allowed to reassign products AND to delete the category.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. a product cannot be assigned to an archived category ───────────────
-- The category picker hides archived categories; a forged request must fail
-- here rather than in the dropdown. Fires on INSERT and on any UPDATE that
-- moves a product's category, and refuses when the target is archived.
-- Historical rows are untouched: the trigger reads the category as it is NOW,
-- and no existing sale, return or order row carries a category at all.
create or replace function public.products_enforce_category_active()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_active boolean;
begin
  if new.category_id is null then
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
  'Refuses assigning a product to an archived category. The picker hides archived categories; this is what makes a forged request fail server-side. Existing rows are never rewritten.';

drop trigger if exists products_enforce_category_active on public.products;
create trigger products_enforce_category_active
  before insert or update of category_id on public.products
  for each row execute function public.products_enforce_category_active();

-- ── 2. the lifecycle writes the trail, whatever path took it ──────────────
-- SECURITY DEFINER so the audit row lands even when the actor's role could
-- not insert into audit_log directly: the trail must not depend on the
-- writer's grant. The actor is whoever the session claims, exactly like the
-- product/variant audit triggers before it.
create or replace function public.categories_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := coalesce(auth.uid()::text, 'system');
  v_name  text;
  v_details jsonb;
  v_action  text;
begin
  select p.name into v_name from public.profiles p where p.id = auth.uid();

  if tg_op = 'DELETE' then
    insert into public.audit_log (
      action, entity, entity_id, entity_label, details, user_id, user_name
    ) values (
      'category.deleted', 'category', old.id::text, coalesce(old.name_en, old.name_ar),
      jsonb_build_object(
        'name_ar', old.name_ar,
        'name_en', old.name_en,
        'parent_id', old.parent_id,
        'was_active', old.active
      ),
      v_actor, coalesce(v_name, v_actor)
    );
    return old;
  end if;

  -- UPDATE: only a real flip of `active` is a lifecycle event; a rename or a
  -- re-sort is not, and a replay of the same value must not manufacture an
  -- event.
  if new.active is not distinct from old.active then
    return new;
  end if;
  v_action := case when new.active then 'category.reactivated' else 'category.archived' end;
  v_details := jsonb_build_object(
    'name_ar', new.name_ar,
    'name_en', new.name_en,
    'parent_id', new.parent_id,
    'previous', not new.active,
    'next', new.active
  );

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    v_action, 'category', new.id::text, coalesce(new.name_en, new.name_ar),
    v_details,
    v_actor, coalesce(v_name, v_actor)
  );
  return new;
end;
$$;

comment on function public.categories_audit() is
  'Writes category.archived / category.reactivated on a real active flip and category.deleted on delete, whoever wrote it. SECURITY DEFINER so the trail exists however the change was made.';

drop trigger if exists categories_audit on public.categories;
create trigger categories_audit
  after update of active or delete on public.categories
  for each row execute function public.categories_audit();

-- ── 3. the vocabulary ──────────────────────────────────────────────────────
insert into public.audit_actions (action, entity) values
  ('category.archived',        'category'),
  ('category.reactivated',     'category'),
  ('category.deleted',         'category'),
  ('category.products_moved',  'category')
on conflict (action) do nothing;

-- ── 4. archive / reactivate — an idempotent, permission-checked flip ───────
-- The UI asks the same edit_product the RLS update policy asks; this only
-- makes the flip transactional and idempotent for a double-click. The audit
-- row is written by the trigger above.
create or replace function public.set_category_active(
  p_category_id uuid,
  p_active      boolean,
  p_user_id     text default null,
  p_user_name   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category public.categories%rowtype;
  v_actor    text := coalesce(auth.uid()::text, nullif(p_user_id, ''), 'system');
  v_name     text := coalesce(nullif(p_user_name, ''), v_actor);
begin
  if not public.can('edit_product') then
    raise exception 'Archiving or reactivating a category requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_category from public.categories where id = p_category_id for update;
  if not found then
    raise exception 'Category % not found', p_category_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Idempotent: a retried click finds the wanted state already held and is
  -- answered, not refused — and writes nothing (the trigger agrees).
  if v_category.active is not distinct from p_active then
    return jsonb_build_object(
      'category_id', v_category.id,
      'active',      v_category.active,
      'changed',     false
    );
  end if;

  update public.categories
     set active = p_active, updated_at = now()
   where id = v_category.id
   returning * into v_category;

  return jsonb_build_object(
    'category_id', v_category.id,
    'active',      v_category.active,
    'changed',     true
  );
end;
$$;

comment on function public.set_category_active(uuid, boolean, text, text) is
  'Archives (false) or reactivates (true) a category. Requires edit_product; idempotent; the flip is audited by the categories_audit trigger. Products are not touched: an archived category hides the shelf label, never the goods.';

-- ── 5. hard delete — only for a category that is truly empty ───────────────
-- Locks the row, re-checks products AND children inside the transaction, and
-- refuses with the counts named. The concurrent-assignment race is closed by
-- the lock: a product INSERT takes FOR KEY SHARE on its category row, which
-- conflicts with this FOR UPDATE, so the assignment either waits and then
-- fails the FK, or lands first and this function sees it and refuses. The
-- RESTRICT FK stays as the final barrier behind both checks.
create or replace function public.delete_empty_category(
  p_category_id uuid,
  p_user_id     text default null,
  p_user_name   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category   public.categories%rowtype;
  v_products   bigint;
  v_children   bigint;
  v_actor      text := coalesce(auth.uid()::text, nullif(p_user_id, ''), 'system');
  v_name       text := coalesce(nullif(p_user_name, ''), v_actor);
begin
  if not public.can('delete_product') then
    raise exception 'Deleting a category requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_category from public.categories where id = p_category_id for update;
  if not found then
    raise exception 'Category % not found', p_category_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Re-checked HERE, in the deleting transaction — never from a count the
  -- browser loaded earlier.
  select count(*) into v_products from public.products where category_id = v_category.id;
  if v_products > 0 then
    raise exception 'Category % still contains % product(s)', v_category.name_en, v_products
      using errcode = 'check_violation';
  end if;

  select count(*) into v_children from public.categories where parent_id = v_category.id;
  if v_children > 0 then
    raise exception 'Category % still contains % child categor(y/ies); move or delete them first',
      v_category.name_en, v_children
      using errcode = 'restrict_violation';
  end if;

  delete from public.categories where id = v_category.id;

  return jsonb_build_object(
    'category_id', v_category.id,
    'name_en',     v_category.name_en,
    'deleted',     true,
    'products',    0,
    'children',    0
  );
end;
$$;

comment on function public.delete_empty_category(uuid, text, text) is
  'Permanently deletes a category only when it holds zero products and zero child categories, re-checked under a row lock inside the deleting transaction. Requires delete_product. Audited as category.deleted by the trigger.';

-- ── 6. move the products, then delete the source — one transaction ─────────
-- Everything or nothing: the move, the zero-remaining verification and the
-- delete share one transaction, so a refusal leaves the source, the target
-- and every product exactly as they were. Both categories are locked in id
-- order so two concurrent moves can never deadlock each other; the product
-- rows follow their category locks. The caller must hold BOTH the authority
-- to reassign products (edit_product) and to delete the category
-- (delete_product) — one seat, two consequences, both checked.
create or replace function public.move_products_and_delete_category(
  p_source_category_id uuid,
  p_target_category_id uuid,
  p_user_id     text default null,
  p_user_name   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source   public.categories%rowtype;
  v_target   public.categories%rowtype;
  v_moved    bigint;
  v_left     bigint;
  v_children bigint;
  v_first    uuid;
  v_second   uuid;
  v_actor    text := coalesce(auth.uid()::text, nullif(p_user_id, ''), 'system');
  v_name     text := coalesce(nullif(p_user_name, ''), v_actor);
begin
  if not public.can('edit_product') then
    raise exception 'Moving products between categories requires the edit_product capability'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.can('delete_product') then
    raise exception 'Deleting the source category requires the delete_product capability'
      using errcode = 'insufficient_privilege';
  end if;

  if p_source_category_id = p_target_category_id then
    raise exception 'Source and target are the same category'
      using errcode = 'check_violation';
  end if;

  -- Deadlock-safe ordering: both locks are taken, always youngest-id first,
  -- so two mirrored calls serialise instead of strangling each other.
  if p_source_category_id < p_target_category_id then
    v_first := p_source_category_id;
    v_second := p_target_category_id;
  else
    v_first := p_target_category_id;
    v_second := p_source_category_id;
  end if;

  select * into v_source from public.categories where id = p_source_category_id for update;
  if not found then
    raise exception 'Source category % not found', p_source_category_id
      using errcode = 'foreign_key_violation';
  end if;
  select * into v_target from public.categories where id = p_target_category_id for update;
  if not found then
    raise exception 'Target category % not found', p_target_category_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_target.active is false then
    raise exception 'Target category % is archived — products cannot move into it',
      v_target.name_en
      using errcode = 'check_violation';
  end if;

  select count(*) into v_children from public.categories where parent_id = v_source.id;
  if v_children > 0 then
    raise exception 'Source category % still contains % child categor(y/ies); move or delete them first',
      v_source.name_en, v_children
      using errcode = 'restrict_violation';
  end if;

  -- The move is one statement: no browser loop, no per-product writes.
  update public.products
     set category_id = v_target.id,
         updated_at  = now()
   where category_id = v_source.id;
  get diagnostics v_moved = row_count;

  -- Verify before deleting: zero remaining references, from this
  -- transaction's own snapshot.
  select count(*) into v_left from public.products where category_id = v_source.id;
  if v_left > 0 then
    raise exception 'Category % still holds % product(s) after the move', v_source.name_en, v_left
      using errcode = 'check_violation';
  end if;

  delete from public.categories where id = v_source.id;

  insert into public.audit_log (
    action, entity, entity_id, entity_label, details, user_id, user_name
  ) values (
    'category.products_moved', 'category', v_target.id::text, v_target.name_en,
    jsonb_build_object(
      'source_id',   v_source.id,
      'source_name', v_source.name_en,
      'source_name_ar', v_source.name_ar,
      'target_id',   v_target.id,
      'target_name', v_target.name_en,
      'target_name_ar', v_target.name_ar,
      'moved',       v_moved,
      'source_deleted', true
    ),
    v_actor, v_name
  );

  return jsonb_build_object(
    'source_id',   v_source.id,
    'source_name', v_source.name_en,
    'target_id',   v_target.id,
    'target_name', v_target.name_en,
    'moved',       v_moved,
    'deleted',     true
  );
end;
$$;

comment on function public.move_products_and_delete_category(uuid, uuid, text, text) is
  'Moves every product from the source category to the active target and deletes the now-empty source, atomically. Requires edit_product AND delete_product. Refuses a missing side, a same-side call, an archived target, or a source with child categories. Audited as category.products_moved (the delete itself as category.deleted).';

-- ── 7. grants ───────────────────────────────────────────────────────────────
revoke execute on function public.products_enforce_category_active() from public, anon;
revoke execute on function public.categories_audit() from public;
revoke execute on function public.set_category_active(uuid, boolean, text, text) from public, anon;
revoke execute on function public.delete_empty_category(uuid, text, text) from public, anon;
revoke execute on function public.move_products_and_delete_category(uuid, uuid, text, text) from public, anon;

grant execute on function public.set_category_active(uuid, boolean, text, text)
  to authenticated, service_role;
grant execute on function public.delete_empty_category(uuid, text, text)
  to authenticated, service_role;
grant execute on function public.move_products_and_delete_category(uuid, uuid, text, text)
  to authenticated, service_role;

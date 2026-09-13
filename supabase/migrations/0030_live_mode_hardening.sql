-- ════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0030 — live-mode hardening
--
-- Everything in this file is invisible in demo mode and load-bearing in live
-- mode, where PostgREST reaches the database as `anon` or `authenticated`
-- instead of as the table owner. The owner bypasses RLS, so a test that runs
-- as the owner proves the triggers and nothing about the policies — which is
-- how these three survived:
--
--   C1  The storefront could not read the catalogue. Every `products` and
--       `categories` policy is `to authenticated`, so an anonymous visitor's
--       select returns zero rows and the shop window is empty. Fixed with two
--       `security definer` reads that publish exactly the public columns —
--       never `cost_price`, never `low_stock_level`, never who created the row.
--       The tables themselves stay closed to `anon`: one published read is
--       easier to reason about than a second class of row-level access.
--
--   C2  Signing up with `{"role":"admin"}` in the user metadata produced an
--       ACTIVE ADMIN. The browser supplies its own metadata, so a statement
--       about oneself is a request, not a fact. Only the service role — the
--       `alyq-admin` edge function, the project's only holder of the service
--       key — may declare a role or an active account. Everything else starts
--       as an inactive viewer and waits for an admin to promote it through
--       `upsert_staff_profile` / `set_staff_active`, which are already gated on
--       `manage_users`. The attempt itself is written to the audit trail, so a
--       forgery is visible even though it no longer works.
--
--   H1  The write policies said `with check = true`: any signed-in identity,
--       a viewer included, could rewrite prices and delete catalogue rows, and
--       only the UI hid the buttons. Writes now require the same capabilities
--       the UI hides behind, so the database means what the permission matrix
--       says. Cost price additionally requires `change_cost`, which is an
--       admin/manager capability — margin is not a cashier's to move. The three
--       counters keep RLS off but lose every write privilege, because they are
--       internal state for `security definer` functions and nothing else.
--
-- Plus two quality fixes: `set_updated_at()` — which has existed since
-- migration 0001 — is attached to the eight tables that were missing it, and
-- `profiles.custom_role_id` gets the index its lookups need.
--
-- Nothing here changes what a legitimate member of staff can do. `add_product`,
-- `edit_product`, `delete_product`, `change_price` and `adjust_stock` are held
-- by admin, manager, cashier and inventory_clerk (`change_cost` by admin and
-- manager), so the new gates stop viewers and anonymous callers, not the till.
--
-- Idempotent throughout: create-or-replace, drop-if-exists, if-not-exists,
-- on-conflict-do-nothing, and revokes (which are no-ops when already applied).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. C1 · the published storefront catalogue ────────────────────────────
-- SECURITY DEFINER, STABLE, search_path pinned: it runs as the owner so it can
-- see rows RLS hides from `anon`, and it can only ever return the columns
-- listed here. A visitor cannot widen the select, add a filter, or reach
-- `cost_price` — the shape of the answer is fixed in the database.
create or replace function public.storefront_catalogue()
returns table (
  id                     uuid,
  sku                    text,
  barcode                text,
  name_ar                text,
  name_en                text,
  description_ar         text,
  description_en         text,
  category_id            uuid,
  product_type           public.product_type,
  selling_price          numeric,
  tax_rate               numeric,
  stock_tracking_enabled boolean,
  stock_quantity         integer,
  show_on_website        boolean,
  is_featured            boolean,
  active                 boolean,
  image_url              text,
  images                 text[],
  created_at             timestamptz,
  updated_at             timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.sku,
         p.barcode,
         p.name_ar,
         p.name_en,
         p.description_ar,
         p.description_en,
         p.category_id,
         p.product_type,
         p.selling_price,
         p.tax_rate,
         p.stock_tracking_enabled,
         p.stock_quantity,
         p.show_on_website,
         p.is_featured,
         p.active,
         p.image_url,
         p.images,
         p.created_at,
         p.updated_at
    from public.products p
   where p.active
     and p.show_on_website
   order by p.is_featured desc,
            p.name_en     asc
$$;

comment on function public.storefront_catalogue() is
  'Public storefront read. Deliberately omits cost_price (margin), '
  'low_stock_level (reorder policy) and created_by/updated_by (staff identity): '
  'none of those are a customer''s business. SECURITY DEFINER so it works for '
  'anon, whose select on products is refused by RLS by design.';

create or replace function public.storefront_categories()
returns table (
  id         uuid,
  name_ar    text,
  name_en    text,
  parent_id  uuid,
  sort_order integer,
  active     boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         c.name_ar,
         c.name_en,
         c.parent_id,
         c.sort_order,
         c.active,
         c.created_at,
         c.updated_at
    from public.categories c
   where c.active
   order by c.sort_order asc,
            c.name_en    asc
$$;

comment on function public.storefront_categories() is
  'Public storefront read: the active category tree, for navigation only. The
  timestamps are here because the Category shape the storefront types against
  carries them, and a row''s age is not a secret the way its margin is.';

-- Tight, explicit grants. `public` is revoked first so the default
-- execute-to-everyone that a new function inherits cannot outlive this file.
revoke execute on function public.storefront_catalogue()  from public;
revoke execute on function public.storefront_categories() from public;

grant execute on function public.storefront_catalogue()  to anon, authenticated, service_role;
grant execute on function public.storefront_categories() to anon, authenticated, service_role;

-- ── 2. C2 · a signup cannot promote itself ────────────────────────────────
-- Replaces the 0014 definition. The old one read `raw_user_meta_data->>'role'`
-- from whoever signed up and set `active` to true when a role was present, so
-- the register form was an admin-creation form.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb)
                   || coalesce(new.raw_app_meta_data, '{}'::jsonb);
  v_declared text  := nullif(btrim(coalesce(v_meta->>'role', '')), '');
  v_username text;
  v_name     text;
begin
  -- A new account is an INACTIVE VIEWER. Always, whoever asked.
  --
  -- The 0014 version read `role` out of the metadata and set `active` to true
  -- when a role was there, so the public register endpoint doubled as an
  -- admin-creation endpoint: POST /signup with {"role":"admin"} and the trigger
  -- did the rest.
  --
  -- There is no honest way to tell the two callers apart from inside here.
  -- GoTrue fires this trigger in its OWN database session (supabase_auth_admin,
  -- with no `request.jwt.*` claims at all) both for a browser sign-up and for
  -- `auth.admin.createUser()`, so neither the session role nor a JWT claim says
  -- which one is asking. The only thing that differs is the metadata, and the
  -- metadata belongs to the caller. So it is not believed.
  --
  -- Nothing is lost by that. An admin creating staff goes through the
  -- `alyq-admin` edge function, which checks `can('manage_users')` as the
  -- caller, mints the credentials with the service key, and then calls
  -- `admin_upsert_staff_profile` AS THAT CALLER to set username, name, role and
  -- active — deleting the auth user again if that write fails. That RPC, not
  -- this trigger, is the authority on who somebody is, and it is already gated
  -- on `manage_users`. `seed_demo_staff()` likewise upserts its five demo
  -- profiles explicitly. Both keep working unchanged.
  v_username := nullif(btrim(coalesce(v_meta->>'username', '')), '');
  if v_username is null then
    v_username := nullif(split_part(coalesce(new.email, ''), '@', 1), '');
  end if;
  if v_username is null then
    v_username := 'user-' || substr(new.id::text, 1, 8);
  end if;

  v_name := coalesce(nullif(btrim(coalesce(v_meta->>'name', '')), ''), v_username);

  begin
    insert into public.profiles (id, username, name, role, active)
    values (new.id, v_username, v_name, 'viewer', false)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- Someone already uses that username; keep the account usable and let the
    -- name be fixed from the staff screen.
    insert into public.profiles (id, username, name, role, active)
    values (new.id, v_username || '-' || substr(new.id::text, 1, 4), v_name, 'viewer', false)
    on conflict (id) do nothing;
  end;

  -- An account that ARRIVED ASKING TO BE SOMETHING deserves a line in the
  -- trail, and this is the only place it can be written: by the time an admin
  -- looks, the request itself is gone. Ordinary sign-ups are not recorded here,
  -- and neither are staff accounts — the app already writes `user.created` and
  -- `user.role_changed` through the audit service for those, so a second writer
  -- would only produce double entries.
  if v_declared is not null then
    begin
      insert into public.audit_log (action, entity_id, entity_label, details, user_id, user_name)
      values ('user.created',
              new.id::text,
              v_name,
              jsonb_build_object(
                'granted_role',     'viewer',
                'granted_active',   false,
                'declared_role',    v_declared,
                'declared_refused', true,
                'email_confirmed',  coalesce(new.email_confirmed_at is not null, false)),
              new.id::text,
              v_name);
    exception when others then
      -- Never fail a sign-up because the trail could not be written. The
      -- profile row above is the thing that must exist; this records it.
      null;
    end;
  end if;

  return new;
end
$$;

comment on function public.handle_new_user() is
  'Create a profile for a new auth user: always an inactive viewer. A role in the '
  'metadata is NOT honoured — GoTrue fires this trigger in its own session for a '
  'browser sign-up and for auth.admin.createUser() alike, so the metadata cannot '
  'say which it is. Staff accounts take their role from '
  'admin_upsert_staff_profile(), called as the admin who asked. A declared role '
  'is recorded in audit_log as a refused escalation instead of being granted.';
-- ── 3. H1 · writes require the capability the UI already checks ───────────
-- Products. Select stays `to authenticated` (the storefront reads through the
-- definer function above), and the three write policies stop being `true`.
drop policy if exists "products_insert_authenticated" on public.products;
create policy "products_insert_authenticated"
  on public.products for insert to authenticated
  with check (public.can('add_product'));

drop policy if exists "products_update_authenticated" on public.products;
create policy "products_update_authenticated"
  on public.products for update to authenticated
  using (public.can('edit_product'))
  with check (public.can('edit_product'));

drop policy if exists "products_delete_authenticated" on public.products;
create policy "products_delete_authenticated"
  on public.products for delete to authenticated
  using (public.can('delete_product'));

-- Categories: catalogue management. There is no `add_category` capability and
-- adding one would fork the matrix, so categories ride on the product verbs —
-- the same people who own the catalogue own its shelves.
drop policy if exists "categories_insert_authenticated" on public.categories;
create policy "categories_insert_authenticated"
  on public.categories for insert to authenticated
  with check (public.can('add_product'));

drop policy if exists "categories_update_authenticated" on public.categories;
create policy "categories_update_authenticated"
  on public.categories for update to authenticated
  using (public.can('edit_product'))
  with check (public.can('edit_product'));

drop policy if exists "categories_delete_authenticated" on public.categories;
create policy "categories_delete_authenticated"
  on public.categories for delete to authenticated
  using (public.can('delete_product'));

-- The stock ledger. Reading it stays as it was; writing it is `adjust_stock`,
-- which is what the inventory UI already checks and what
-- `repair_stock_reservation` requires.
drop policy if exists "stock_movements_insert_authenticated" on public.stock_movements;
create policy "stock_movements_insert_authenticated"
  on public.stock_movements for insert to authenticated
  with check (public.can('adjust_stock'));

drop policy if exists "stock_movements_update_authenticated" on public.stock_movements;
create policy "stock_movements_update_authenticated"
  on public.stock_movements for update to authenticated
  using (public.can('adjust_stock'))
  with check (public.can('adjust_stock'));

-- A policy cannot compare OLD to NEW, so "you may edit a product, but moving a
-- price needs the price capability" belongs in a trigger. It fires only when
-- the column actually changes, so an unrelated edit by a price-capable role —
-- or a stock decrement by a `security definer` sale function, which never
-- touches these columns — passes through untouched.
create or replace function public.enforce_price_authority()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a browser session is subject to this. `public.can()` denies a missing
  -- profile, which is the right answer for an authenticated caller and the
  -- wrong one for a migration, the development seed, psql or the service-role
  -- edge function — none of which carry a staff identity, and all of which must
  -- still be able to write a price. PostgREST pins `role` per request, so
  -- "authenticated" is exactly "a signed-in user of the app".
  if coalesce(nullif(current_setting('role', true), ''), 'postgres') <> 'authenticated' then
    return new;
  end if;

  if new.selling_price is distinct from old.selling_price
     and not public.can('change_price') then
    raise exception 'Changing a selling price requires the change_price capability'
      using errcode = 'insufficient_privilege';
  end if;

  if new.cost_price is distinct from old.cost_price
     and not public.can('change_cost') then
    raise exception 'Changing a cost price requires the change_cost capability'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end
$$;

comment on function public.enforce_price_authority() is
  'Invariant: prices move only for a caller holding change_price / change_cost. '
  'Holds for every writer that is subject to RLS; SECURITY DEFINER functions run '
  'as the owner and are checked against the acting identity by public.can().';

drop trigger if exists products_enforce_price_authority on public.products;
create trigger products_enforce_price_authority
  before update on public.products
  for each row execute function public.enforce_price_authority();

-- The counters. They are sequence state for `security definer` sale/refund/
-- return numbering — internal, not user data. RLS was off and no privilege was
-- revoked, so any signed-in identity could rewrite the next order number.
-- Taking the privileges away is the barrier; RLS goes on as a second door that
-- nothing needs to walk through, since every legitimate writer is the owner.
revoke insert, update, delete, truncate, references, trigger
  on public.sale_counters, public.refund_counters, public.return_counters
  from anon, authenticated;

alter table public.sale_counters    enable row level security;
alter table public.refund_counters  enable row level security;
alter table public.return_counters  enable row level security;

-- Force RLS for the owner too would break the definer functions that maintain
-- these counters, so it is deliberately not set: the owner is the only writer,
-- and it now has no other option.

-- ── 4. updated_at, maintained by the database ─────────────────────────────
-- `public.set_updated_at()` has existed since migration 0001 and already runs
-- on categories, products, customers, profiles, shifts, expenses and
-- custom_roles. These eight tables have the column but no trigger, so their
-- timestamp was whatever the last caller remembered to send.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'approval_rules',
    'backup_settings',
    'campaigns',
    'coupons',
    'online_orders',
    'product_content',
    'store_faqs',
    'website_settings'
  ]
  loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', v_table, v_table);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()',
      v_table, v_table);
  end loop;
end
$$;

-- ── 5. the index the role overlay lookups need ────────────────────────────
-- `current_user_capabilities()` resolves the overlay by joining profiles on
-- custom_role_id for every capability check; without an index that is a scan
-- per check, and capability checks run inside policies.
create index if not exists profiles_custom_role_id_idx
  on public.profiles (custom_role_id)
  where custom_role_id is not null;

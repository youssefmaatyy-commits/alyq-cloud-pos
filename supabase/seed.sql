-- ALYQ Cloud POS · development seed
--
-- `supabase db reset` runs this after every migration; it can also be applied by
-- hand:  psql "$SUPABASE_DB_URL" -f supabase/seed.sql
--
-- What it leaves behind:
--   · five staff accounts — admin, manager, cashier, inventory_clerk, viewer —
--     all with the password `alyq1234`, matching the offline demo directory in
--     src/lib/auth/demoUsers.ts;
--   · the four custom-role presets from src/lib/permissions/customRoles.ts, each
--     with its capability overlay;
--   · a contract check at the end that fails the seed if either side drifted.
--
-- Idempotent: re-running creates nothing twice, never resets a password, and
-- leaves an operator's own accounts, custom roles and `active` flags alone.
--
-- NOT for production. It creates identities with a published password, and the
-- accounts it makes are real sign-ins. On a live project create the first admin
-- in the dashboard (see docs/DEPLOYMENT.md §5) and skip this file.

set search_path = public, extensions;

-- crypt()/gen_salt() hash the demo password exactly the way GoTrue expects.
-- Supabase already ships pgcrypto in the `extensions` schema, so this is a no-op
-- there; it makes the seed runnable on a plain PostgreSQL server too.
create extension if not exists pgcrypto;

-- ── 1. the bootstrap admin ────────────────────────────────────────────────
-- public.seed_demo_staff() is admin-only, and an empty database has no admin, so
-- the first identity is created here: the one thing the function cannot do for
-- itself. The id is fixed so the account is recognisable and re-seeding is a
-- no-op rather than a second admin.
do $$
declare
  v_id    uuid := '11111111-1111-4111-8111-111111111111';
  v_email text := 'admin@alyq.local';
begin
  select u.id into strict v_id from auth.users u where u.email = v_email;
exception
  when no_data_found then
    v_id := '11111111-1111-4111-8111-111111111111';
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      v_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      v_email,
      crypt('alyq1234', gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('username', 'admin', 'name', 'ALYQ Admin', 'role', 'admin'),
      now(),
      now()
    );
    begin
      insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (
        gen_random_uuid(), v_id, v_id,
        jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
        'email', now(), now(), now()
      );
    exception when others then
      -- The identity shape differs between GoTrue versions; the account and its
      -- profile are still correct, so this is not fatal.
      null;
    end;
end $$;

insert into public.profiles (id, username, name, email, role, active)
select u.id, 'admin', 'ALYQ Admin', u.email, 'admin', true
  from auth.users u
 where u.email = 'admin@alyq.local'
on conflict (id) do update
  set username = excluded.username,
      name     = excluded.name,
      email    = excluded.email,
      role     = excluded.role,
      active   = true;

-- ── 2. the other four demo accounts ───────────────────────────────────────
-- seed_demo_staff() insists on being called by an admin, so the seed speaks as
-- the account it just created, then puts the claim back down. Both spellings are
-- set because auth.uid() has read the flattened `request.jwt.claim.sub` on older
-- Supabase versions and the JSON `request.jwt.claims` blob on current ones.
do $$
declare
  v_sub text;
begin
  select id::text into strict v_sub from auth.users where email = 'admin@alyq.local';
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', v_sub, 'role', 'authenticated')::text, false);
  perform set_config('request.jwt.claim.sub', v_sub, false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
end $$;

select public.seed_demo_staff('alyq1234');

select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);

-- ── 3. profile emails ─────────────────────────────────────────────────────
-- profiles.email arrived in migration 0021 and seed_demo_staff() predates it, so
-- any account whose profile has no email gets the one it signs in with. Only
-- nulls are touched: nobody's edited contact detail is overwritten.
update public.profiles p
   set email = u.email
  from auth.users u
 where p.id = u.id
   and p.email is null
   and u.email is not null;

-- ── 4. custom-role presets ────────────────────────────────────────────────
-- The same four presets the app offers in Settings → Roles
-- (CUSTOM_ROLE_PRESETS in src/lib/permissions/customRoles.ts), so a fresh
-- database and an offline demo session start from one model. `npm run db:check`
-- compares the two lists and fails if they drift.
--
-- Each carries its base_role: the system role an account falls back to when the
-- preset is switched off, and the value written to profiles.role on assignment.
-- Capabilities are listed in catalogue order — the order the app writes them in,
-- so a seeded row and one created through the UI are byte-identical.
--
-- `active` is deliberately NOT in the conflict update: an operator who switched
-- a preset off keeps it off when the seed runs again. `is_system` stays false so
-- the presets remain editable and deletable from Settings → Roles.
insert into public.custom_roles (
  id, key, base_role, name_en, name_ar, description_en, description_ar, capabilities
) values
  (
    '22222222-2222-4222-8222-222222220001', 'sales_manager', 'manager',
    'Sales Manager', 'مدير مبيعات',
    'Full control of the till, returns and the online queue — without user or system settings.',
    'سيطرة كاملة على نقطة البيع والمرتجعات وطلبات الأونلاين — دون إعدادات المستخدمين أو النظام.',
    '{view_inventory,sell,apply_discount,void_sale,confirm_payment,process_return,process_refund,approve_refund,open_shift,close_shift,view_shifts,approve_shift_adjustment,manage_online_orders,edit_sale,export_data,approve_return,view_reports,export_reports}'
  ),
  (
    '22222222-2222-4222-8222-222222220002', 'inventory_manager', 'manager',
    'Inventory Manager', 'مدير مخازن',
    'Stock and products, including imports, adjustments and the reports that follow them.',
    'المخزون والمنتجات، بما في ذلك الاستيراد والتسويات والتقارير المرتبطة بها.',
    '{view_inventory,adjust_stock,add_product,edit_product,change_price,delete_product,import_data,export_data,view_reports,export_reports}'
  ),
  (
    '22222222-2222-4222-8222-222222220003', 'accountant', 'viewer',
    'Accountant', 'محاسب',
    'Sales, shift and expense reports, exports and the audit trail — nothing else.',
    'تقارير المبيعات والورديات والمصروفات والتصدير وسجل التدقيق — لا شيء آخر.',
    '{view_inventory,process_refund,approve_refund,add_expense,edit_expense,view_shifts,view_audit_log,export_data,view_reports,export_reports,approve_expense}'
  ),
  (
    '22222222-2222-4222-8222-222222220004', 'warehouse_employee', 'inventory_clerk',
    'Warehouse Employee', 'موظف مخزن',
    'Receive and adjust stock, no pricing, no selling and no reports.',
    'استلام وتسوية المخزون، دون تسعير أو بيع أو تقارير.',
    '{view_inventory,adjust_stock,import_data,export_data}'
  )
on conflict (key) do update
  set base_role      = excluded.base_role,
      name_en        = excluded.name_en,
      name_ar        = excluded.name_ar,
      description_en = excluded.description_en,
      description_ar = excluded.description_ar,
      capabilities   = excluded.capabilities,
      updated_at     = now();

-- ── 5. contract verification ──────────────────────────────────────────────
-- The seed is the last thing that runs before somebody signs in, so it is the
-- cheapest place to prove the model is intact. Any of these raising means the
-- database and the app disagree, and it is better to know now than to discover
-- it later as a button that does nothing — or one that works when it should not.
do $$
declare
  v_bad   text;
  v_admin uuid;
begin
  -- 5.1 every capability a role grants is one the app knows
  select string_agg(distinct cap, ', ' order by cap) into v_bad
    from public.custom_roles cr
    cross join lateral unnest(cr.capabilities) as cap
   where not exists (select 1 from public.known_capabilities() kc where kc.capability = cap);
  if v_bad is not null then
    raise exception 'seed contract: custom roles grant capabilities the catalogue does not know: %', v_bad;
  end if;

  -- 5.2 no role is empty — an account wearing it could not do anything at all,
  --     and would still show up in the users list as active
  select string_agg(cr.key, ', ' order by cr.key) into v_bad
    from public.custom_roles cr
   where cardinality(cr.capabilities) = 0;
  if v_bad is not null then
    raise exception 'seed contract: custom roles without capabilities: %', v_bad;
  end if;

  -- 5.3 every system role still has its matrix
  select string_agg(r.role::text, ', ' order by r.role::text) into v_bad
    from unnest(enum_range(null::public.app_role)) as r(role)
   where not exists (select 1 from public.role_capabilities rc where rc.role = r.role);
  if v_bad is not null then
    raise exception 'seed contract: system roles without capability grants: %', v_bad;
  end if;

  -- 5.4 no profile without an identity — such an account could never sign in
  select string_agg(p.username, ', ' order by p.username) into v_bad
    from public.profiles p
   where not exists (select 1 from auth.users u where u.id = p.id);
  if v_bad is not null then
    raise exception 'seed contract: profiles with no auth.users row: %', v_bad;
  end if;

  -- 5.5 the demo admin everything above depends on
  select u.id into v_admin
    from auth.users u
    join public.profiles p on p.id = u.id
   where u.email = 'admin@alyq.local'
     and p.role = 'admin'
     and p.active;
  if v_admin is null then
    raise exception 'seed contract: no active admin at admin@alyq.local';
  end if;

  raise notice
    'alyq seed ok · % staff profiles · % custom roles · % system-role grants',
    (select count(*) from public.profiles),
    (select count(*) from public.custom_roles),
    (select count(*) from public.role_capabilities);
end $$;

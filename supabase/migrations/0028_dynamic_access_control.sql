-- ══════════════════════════════════════════════════════════════════════════
-- 0028 · Phase 17 — dynamic access control: six capabilities named, and
--        per-user permission exceptions that every policy now honours.
-- ══════════════════════════════════════════════════════════════════════════
-- Two things were missing from the permission model, and both showed up in the
-- same place: acts a working seat performs every day that no capability named,
-- and the odd person who needs one act more (or one less) than their job.
--
--   1. The customer book and cost price were ungated. Any signed-in seat could
--      add, edit or delete a customer, and anybody who could edit a product
--      could write its cost price. Naming those acts is what makes them
--      assignable — see `view_customers`, `add_customer`, `edit_customer`,
--      `delete_customer`, `view_cost` and `change_cost` below.
--
--   2. Adjusting one person meant either editing the role everyone shares or
--      cloning a role for a single seat. Profiles now carry two overrides —
--      `extra_capabilities` and `denied_capabilities` — evaluated as
--
--          final = (custom role list, else the shipped matrix for the role)
--                  + extra − denied,   deny winning
--
--      They sit on top of the role, never instead of it, so a role stays the
--      description of a job and the exception stays what its name says.
--
-- Both are implemented where the model already lives. Nothing here forks the
-- role system, and no policy in 0011..0027 needs rewriting: `public.can()` is
-- the one function every policy and every RPC calls, so teaching it about
-- exceptions teaches the whole database at once.
--
-- Idempotent throughout — safe to re-run, like every migration in this folder.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. six capabilities, granted exactly as ROLE_CAPABILITIES states ──────
-- Mirrors src/lib/permissions/roles.ts, row for row; `npm run db:check` asserts
-- the two agree. The grants keep every working seat as capable as it already
-- was: the till keeps its customers (a sale needs one) and its cost price (the
-- product form it could already edit is where cost is written). Two deliberate
-- differences:
--
--   delete_customer — erasing a customer erases their purchase history, so it
--                     is an oversight act: admin and manager only.
--   viewer            — it keeps both new reads, and loses the customer writes
--                     it only ever had by accident: nothing checked.
--
-- `known_capabilities()` reads this table, so the role form's picker, the
-- database validation and every custom role see all six with no further change.
insert into public.role_capabilities (role, capability) values
  ('admin',           'view_customers'),
  ('manager',         'view_customers'),
  ('cashier',         'view_customers'),
  ('inventory_clerk', 'view_customers'),
  ('viewer',          'view_customers'),

  ('admin',           'add_customer'),
  ('manager',         'add_customer'),
  ('cashier',         'add_customer'),
  ('inventory_clerk', 'add_customer'),

  ('admin',           'edit_customer'),
  ('manager',         'edit_customer'),
  ('cashier',         'edit_customer'),
  ('inventory_clerk', 'edit_customer'),

  ('admin',           'delete_customer'),
  ('manager',         'delete_customer'),

  ('admin',           'view_cost'),
  ('manager',         'view_cost'),
  ('cashier',         'view_cost'),
  ('inventory_clerk', 'view_cost'),
  ('viewer',          'view_cost'),

  ('admin',           'change_cost'),
  ('manager',         'change_cost'),
  ('cashier',         'change_cost'),
  ('inventory_clerk', 'change_cost')
on conflict (role, capability) do nothing;

-- ── 2. vocabulary: one new audit action ───────────────────────────────────
-- Role lifecycle was already recorded (`role.created`, `role.updated`,
-- `role.activated`, `role.deactivated`, `user.role_changed`). A per-user
-- exception is neither a role change nor a role assignment, so it needs its own
-- verb: who was given or denied what, on one named person. No new audit table —
-- the existing `audit_log` carries it like every other act.
-- Mirrors AUDIT_ACTIONS / AUDIT_ENTITIES in src/modules/audit/types.ts.
insert into public.audit_actions (action, entity) values
  ('user.permissions_changed', 'user')
on conflict (action) do nothing;

-- ── 3. the exceptions themselves ──────────────────────────────────────────
-- Two text arrays on profiles, not a join table: an exception is a handful of
-- capability ids for one person, always read together with the profile that
-- owns it, and `admin_set_user_exceptions` below replaces them in one write.
-- Idempotent because migrations in this folder are re-runnable.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'extra_capabilities'
  ) then
    alter table public.profiles add column extra_capabilities text[] not null default '{}';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles' and column_name = 'denied_capabilities'
  ) then
    alter table public.profiles add column denied_capabilities text[] not null default '{}';
  end if;
end $$;

comment on column public.profiles.extra_capabilities is
  'Phase 17: capabilities granted to this person on top of their role. Evaluated by public.can().';
comment on column public.profiles.denied_capabilities is
  'Phase 17: capabilities withheld from this person regardless of their role. Deny wins.';

-- A capability cannot be both granted and withheld. The reader honours deny
-- anyway, but a contradictory row would be a mistake worth refusing: it says
-- the writer did not decide.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_capability_exceptions_disjoint'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_capability_exceptions_disjoint
      check (not (extra_capabilities && denied_capabilities));
  end if;
end $$;

-- ── 4. effective capabilities, and a `can()` that respects them ───────────
-- Set-returning so it can answer "what may this person do?" in one query — the
-- access preview and the exception editor both need the whole list, while a
-- policy needs only one of its rows.
create or replace function public.current_user_capabilities()
returns table (capability text)
language sql
stable
security definer
set search_path = public
as $$
  with profile as (
    select p.role,
           p.extra_capabilities,
           p.denied_capabilities,
           cr.capabilities as custom_capabilities
      from public.profiles p
      left join public.custom_roles cr
        on cr.id = p.custom_role_id
       and cr.active
     where p.id = auth.uid()
       and p.active
  ),
  -- The base, unchanged from 0021: an active custom role is an ABSOLUTE
  -- overlay — it replaces the shipped matrix rather than adding to it. A
  -- deactivated role falls back, never fails closed.
  base as (
    select case
             when p.custom_capabilities is not null then p.custom_capabilities
             else coalesce(
               (select array_agg(rc.capability)
                  from public.role_capabilities rc
                 where rc.role = p.role),
               '{}'::text[])
           end as caps
      from profile p
  )
  select c.capability
    from base
   cross join lateral (
     select unnest(base.caps) as capability
     union
     select unnest((select extra_capabilities from profile))
     except
     select unnest((select denied_capabilities from profile))
   ) c
$$;

comment on function public.current_user_capabilities() is
  'Effective capabilities of the authenticated caller: custom role (absolute) or the shipped matrix, then + extra − denied. Empty when there is no active profile — fail closed.';

-- Replaces the 0021 definition. Same question, same fail-closed answer, one
-- more input — and it deliberately does NOT call the set function above:
-- policies evaluate `can()` per row, so it stays a single primary-key lookup on
-- profiles plus the original rule. The precedence is written as short circuits,
-- deny first:
--
--   1. denied by the person's own exception → false, matrix never read
--   2. granted by the person's own exception → true,  matrix never read
--   3. otherwise the 0021 rule verbatim: an active custom role is absolute,
--      else the shipped matrix for the caller's role
--
-- So every RLS policy and every `public.can(...)` guard in 0011..0027 keeps
-- working untouched and now also honours an exception: `pos_complete_sale` will
-- not settle for somebody denied `sell`, and `pos_settle_refund` will settle for
-- somebody granted `approve_refund` on top of a role that lacks it. The
-- exception columns must agree with `current_user_capabilities()` above; the
-- app mirrors the same precedence in `resolveCapabilities()` and the identity
-- selftest pins it.
create or replace function public.can(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with profile as (
    select p.denied_capabilities, p.extra_capabilities
      from public.profiles p
     where p.id = auth.uid()
       and p.active
  )
  select case
    when exists (
      select 1 from profile
       where p_capability = any (coalesce(profile.denied_capabilities, '{}'))
    ) then false
    when exists (
      select 1 from profile
       where p_capability = any (coalesce(profile.extra_capabilities, '{}'))
    ) then true
    else coalesce(
      (select p_capability = any (cr.capabilities)
         from public.custom_roles cr
         join public.profiles p
           on p.custom_role_id = cr.id
          and p.id = auth.uid()
          and p.active
        where cr.active),
      public.role_can(public.current_user_role(), p_capability))
  end
$$;

comment on function public.can(text) is
  'Phase 17: does the CURRENT USER hold this capability — role list, then personal exceptions (deny first)? Fails closed.';

-- ── 5. the only door to the exception columns ─────────────────────────────
-- profiles has no direct write policy (`using (false)`), so this RPC is the
-- whole surface — the same shape as the other admin_* doors in 0021:
-- capability-checked, validated, refusing to lock the caller out of their own
-- oversight, and returning the row it wrote.
create or replace function public.admin_set_user_exceptions(
  p_user_id uuid,
  p_extra   text[] default '{}',
  p_denied  text[] default '{}'
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_extra   text[];
  v_denied  text[];
  v_row     public.profiles;
begin
  if not public.can('manage_users') then
    raise exception 'Only an admin may change a person''s permissions'
      using errcode = 'insufficient_privilege';
  end if;

  -- Normalise first so two equivalent writes store identical rows: distinct,
  -- sorted, blanks dropped. Then validate against the known set — the same
  -- guard the role RPCs use, so a typo cannot silently grant nothing.
  select coalesce(array_agg(c order by c), '{}') into v_denied
    from (select distinct btrim(x) as c from unnest(coalesce(p_denied, '{}')) as x) d
   where d.c <> '';
  select coalesce(array_agg(c order by c), '{}') into v_extra
    from (select distinct btrim(x) as c from unnest(coalesce(p_extra, '{}')) as x) e
   where e.c <> '';

  perform public.assert_known_capabilities(v_denied);
  perform public.assert_known_capabilities(v_extra);

  -- Deny wins, and it wins in storage too: dropping the overlap keeps the
  -- disjointness constraint from ever being tested by a careless caller.
  select coalesce(array_agg(c order by c), '{}') into v_extra
    from unnest(v_extra) as c
   where not (c = any (v_denied));

  -- Nobody removes their own oversight. An admin who denies themselves
  -- `manage_users` could no longer undo it — the same trap
  -- `admin_upsert_staff_profile` already refuses.
  if p_user_id = auth.uid() and 'manage_users' = any (v_denied) then
    raise exception 'You cannot remove your own ability to manage users'
      using errcode = 'check_violation';
  end if;

  update public.profiles
     set extra_capabilities = v_extra,
         denied_capabilities = v_denied
   where id = p_user_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no such user: %', p_user_id using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;

comment on function public.admin_set_user_exceptions(uuid, text[], text[]) is
  'Phase 17: replace one user''s permission exceptions. Requires manage_users, validates against known_capabilities(), lets deny win, and refuses to strip the caller''s own manage_users.';

-- ── 6. the customer book, gated where it is stored ────────────────────────
-- `customers` has carried the baseline tenant policy since 0010 — `using (true)`
-- for every authenticated member — because nothing named the acts. Now that they
-- are named, the table can say them too, and the module joins the ones checked
-- in all three places: the screen hides the button, the service asserts the
-- capability, and the database refuses the row.
--
-- This is safe to do here and would not be for the rest of the tenant tables:
-- no client outside `modules/customers/data` reads or writes `customers`, and
-- the flows that touch it server-side (`place_online_order`, `pos_complete_sale`)
-- are `security definer` and do not consult these policies at all. Every shipped
-- role holds `view_customers`, so no seat loses the book; a custom role that
-- declines it now declines it everywhere at once.
--
-- Products, sales and inventory deliberately keep their baseline policies: they
-- are written from inside RPCs and from screens whose capability checks live in
-- the service layer, and tightening them is a change of its own rather than a
-- rider on this one.
drop policy if exists "customers_select_authenticated" on public.customers;
create policy "customers_select_authenticated"
  on public.customers for select to authenticated
  using (public.can('view_customers'));

drop policy if exists "customers_write_authenticated" on public.customers;
create policy "customers_write_authenticated"
  on public.customers for insert to authenticated
  with check (public.can('add_customer'));

drop policy if exists "customers_update_authenticated" on public.customers;
create policy "customers_update_authenticated"
  on public.customers for update to authenticated
  using (public.can('edit_customer'))
  with check (public.can('edit_customer'));

drop policy if exists "customers_delete_authenticated" on public.customers;
create policy "customers_delete_authenticated"
  on public.customers for delete to authenticated
  using (public.can('delete_customer'));

-- ── 7. exposure ───────────────────────────────────────────────────────────
-- Same posture as the rest of the identity surface: callable by an
-- authenticated seat, invisible to an anonymous one, and never writable
-- directly — the capability check inside the function is the door.
grant execute on function public.current_user_capabilities() to authenticated;
grant execute on function public.admin_set_user_exceptions(uuid, text[], text[]) to authenticated;
revoke all on function public.current_user_capabilities() from anon;
revoke all on function public.admin_set_user_exceptions(uuid, text[], text[]) from anon;

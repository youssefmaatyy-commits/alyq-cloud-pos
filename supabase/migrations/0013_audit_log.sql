-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0013
-- Production readiness — the audit trail.
--
-- Design:
--   * `audit_actions` — the vocabulary: which actions exist and which entity
--                       each one happens to. Seeded from `AUDIT_ACTIONS` /
--                       `AUDIT_ENTITIES` in src/modules/audit/types.ts, and
--                       `scripts/migrations.check.mjs` diffs the two, so an
--                       action added in TypeScript without a migration (or a
--                       migration without TypeScript) fails CI.
--   * `audit_log`     — append-only rows. `action` is a foreign key into the
--                       vocabulary, so an unknown action cannot be written at
--                       all; `entity` is DERIVED from the action by trigger and
--                       must not be trusted from the client.
--
-- Append-only is enforced, not just documented:
--   · RLS grants no update or delete policy, and the privileges are revoked;
--   · a trigger refuses UPDATE and DELETE outright — including for the table
--     owner, service_role and psql, so nothing rewrites history;
--   · inserts are stamped with the authenticated caller, so `user_id` cannot be
--     forged by a client that lies about who it is.
--
-- A maintenance escape hatch still exists on purpose: an owner can
-- `alter table public.audit_log disable trigger audit_log_block_mutation`
-- before a deliberate purge. Refusing by default and requiring a conscious act
-- to change that is the point.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the action vocabulary ─────────────────────────────────────────────────
create table if not exists public.audit_actions (
  action text primary key,
  entity text not null,
  -- Short label key used by the UI (`audit.action.<action>` in the dictionary).
  constraint audit_actions_action_not_blank check (btrim(action) <> '')
);

comment on table public.audit_actions is
  'Audit vocabulary: which actions exist and which entity each concerns. Mirrors AUDIT_ACTIONS/AUDIT_ENTITIES in src/modules/audit/types.ts; verified by scripts/migrations.check.mjs.';

insert into public.audit_actions (action, entity) values
  ('shift.opened',              'shift'),
  ('shift.closed',              'shift'),
  ('shift.adjustment.approved', 'shift'),
  ('expense.created',           'expense'),
  ('expense.updated',           'expense'),
  ('expense.deleted',           'expense')
on conflict (action) do nothing;

-- ── the trail ─────────────────────────────────────────────────────────────
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  action       text not null references public.audit_actions (action),
  entity       text not null,
  entity_id    text not null,
  entity_label text not null,
  details      jsonb not null default '{}'::jsonb,
  user_id      text not null,
  user_name    text not null,
  created_at   timestamptz not null default now(),

  constraint audit_log_entity_id_not_blank    check (btrim(entity_id) <> ''),
  constraint audit_log_entity_label_not_blank check (btrim(entity_label) <> ''),
  constraint audit_log_details_is_object      check (jsonb_typeof(details) = 'object')
);

create index if not exists audit_log_created_at_idx on public.audit_log (created_at desc);
create index if not exists audit_log_entity_idx     on public.audit_log (entity, entity_id);
create index if not exists audit_log_user_idx       on public.audit_log (user_id, created_at desc);
create index if not exists audit_log_action_idx     on public.audit_log (action, created_at desc);

comment on table public.audit_log is
  'Append-only audit trail. No update or delete is permitted, by policy, by privilege and by trigger.';

-- ── invariants ────────────────────────────────────────────────────────────
/**
 * Stamps who really did it, and refuses to rewrite history.
 *
 * `entity` is derived from the action rather than taken from the payload: the
 * vocabulary already says which entity an action concerns, so a client that
 * sends `action = 'shift.opened', entity = 'expense'` is corrected, not
 * believed. `user_id`/`user_name` come from the session when there is one.
 */
create or replace function public.enforce_audit_log_invariants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text;
  v_uid    text := auth.uid()::text;
  v_name   text;
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    raise exception 'The audit log is append-only; % is not permitted', lower(tg_op)
      using errcode = 'insufficient_privilege';
  end if;

  select a.entity into v_entity from public.audit_actions a where a.action = new.action;
  if v_entity is null then
    raise exception 'Unknown audit action %', new.action using errcode = 'foreign_key_violation';
  end if;
  new.entity := v_entity;

  if v_uid is not null then
    new.user_id := v_uid;
    select p.name into v_name from public.profiles p where p.id = auth.uid();
    if v_name is not null then
      new.user_name := v_name;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists audit_log_enforce_invariants on public.audit_log;
create trigger audit_log_enforce_invariants
  before insert or update or delete on public.audit_log
  for each row execute function public.enforce_audit_log_invariants();

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table public.audit_actions enable row level security;
alter table public.audit_log    enable row level security;

-- Reading the trail is an oversight action: managers and admins only. Everyone
-- else cannot even see that a row exists.
drop policy if exists "audit_log_select_oversight" on public.audit_log;
create policy "audit_log_select_oversight"
  on public.audit_log for select to authenticated
  using (public.can('view_audit_log'));

-- Any signed-in user may append (the application records what the user just
-- did). The trigger above overwrites the attribution, so this cannot be used to
-- impersonate someone else.
drop policy if exists "audit_log_insert_authenticated" on public.audit_log;
create policy "audit_log_insert_authenticated"
  on public.audit_log for insert to authenticated
  with check (auth.uid() is not null);

-- No update or delete policy: both are refused for every role.
drop policy if exists "audit_log_no_update" on public.audit_log;
create policy "audit_log_no_update"
  on public.audit_log for update to authenticated using (false);

drop policy if exists "audit_log_no_delete" on public.audit_log;
create policy "audit_log_no_delete"
  on public.audit_log for delete to authenticated using (false);

-- The vocabulary is reference data: readable, not writable through the API.
drop policy if exists "audit_actions_select_authenticated" on public.audit_actions;
create policy "audit_actions_select_authenticated"
  on public.audit_actions for select to authenticated using (true);

drop policy if exists "audit_actions_no_write" on public.audit_actions;
create policy "audit_actions_no_write"
  on public.audit_actions for insert to authenticated with check (false);

-- ── grants ────────────────────────────────────────────────────────────────
revoke all on public.audit_log from anon;
revoke all on public.audit_actions from anon;
revoke update, delete on public.audit_log from authenticated;
revoke insert, update, delete on public.audit_actions from authenticated;

grant select, insert on public.audit_log to authenticated;
grant select on public.audit_actions to authenticated;
grant execute on function public.enforce_audit_log_invariants() to authenticated;

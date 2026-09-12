-- ══════════════════════════════════════════════════════════════════════════
-- 0029 · Phase 18 — backup, recovery and data safety: the database takes a
--        snapshot of itself, keeps the ones it is told to keep, and can be
--        put back the way it was — in one piece, or not at all.
-- ══════════════════════════════════════════════════════════════════════════
-- Until now the only way back from a mistake was the mistake. A product deleted
-- in bulk, a price list overwritten by an import, a custom role edited by the
-- wrong person: each was recoverable only by hand, from memory, or from an
-- export that never carried relationships. This migration adds the missing
-- direction — a whole-installation snapshot, and a restore that refuses to be
-- partial.
--
-- What is here, and the reasoning that shaped it:
--
--   1. `backups` holds the snapshot as jsonb, next to the data it describes.
--      Not a bucket, not a file on somebody's laptop: the restore has to run in
--      the same transaction as the deletion it undoes, and a document the
--      database can read is the only one it can restore from atomically.
--
--   2. The document column is closed. `backups` has no readable policy at all;
--      the app lists `backup_manifests`, a view of everything except the
--      document. Seeing that a backup exists and holding a copy of the database
--      are two different permissions (`view_backups` and `export_backup`), and
--      the schema is what keeps them two — a seat with the first can reassure an
--      owner, and cannot walk out with every customer's phone number.
--
--   3. A restore is one function, so it is one transaction. Validation happens
--      before anything is deleted, and the deletes and inserts happen in
--      foreign-key order — reverse to insert, forward to delete. If any statement
--      fails, nothing happened. There is no code path that leaves an installation
--      half-restored, because there is no code path that commits halfway.
--
--   4. Every restore first snapshots what it is about to replace, as a
--      `pre_restore` backup. That is the rollback: restoring the snapshot that
--      the restore made is how an admin undoes a restore, with no second
--      mechanism to build, test or explain.
--
--   5. Four tables are snapshotted but never rewritten by a restore:
--      `role_capabilities`, `audit_actions` and `role_aliases` are vocabulary the
--      migrations own — installing an older copy would quietly remove
--      capabilities from the picker and from every role holding them — and
--      `audit_log` is append-only by trigger, and must stay that way even here.
--      The trail is the one record a restore may not erase: it is what tells the
--      next reader that a restore happened, who asked, and which snapshot they
--      used. Mirrors LIVE_RESTORE_EXCLUDED in src/modules/backup/schema.ts.
--
--   6. Scheduling is a daily tick that decides for itself. `pg_cron` may not
--      exist on every project, so it is optional and guarded; the function it
--      calls reads `backup_settings` and does nothing when it is not due. One
--      tick therefore serves both a daily and a weekly policy, and a project
--      without pg_cron still gets automatic snapshots whenever an admin session
--      opens the panel (`automaticBackupIfDue` in the app).
--
-- Idempotent throughout — safe to re-run, like every migration in this folder.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. five capabilities, granted exactly as ROLE_CAPABILITIES states ──────
-- Mirrors src/lib/permissions/roles.ts row for row; `npm run db:check` asserts
-- the two agree in both directions, so a grant here without a line there (or the
-- reverse) fails the build.
--
-- The shape of the split is the point:
--
--   admin   — all five. The installation's owner can protect it, examine it,
--             carry a copy of it, and replace it.
--   manager — sees the panel, takes a snapshot and runs the health check. Not
--             `restore_backup`: a restore deletes every row written since the
--             snapshot, including sales that already happened, which is a
--             decision about the business rather than about the shift. Not
--             `export_backup`: the file is the whole database, staff directory
--             included.
--   cashier, inventory_clerk, viewer — nothing. Recovery is not a floor act.
--
-- These are capabilities, not role checks: an installation that wants a second
-- person able to restore grants `restore_backup` to their custom role in the
-- Permission Builder, instead of making them an admin.
insert into public.role_capabilities (role, capability) values
  ('admin',   'view_backups'),
  ('manager', 'view_backups'),

  ('admin',   'create_backup'),
  ('manager', 'create_backup'),

  ('admin',   'restore_backup'),

  ('admin',   'export_backup'),

  ('admin',   'run_health_check'),
  ('manager', 'run_health_check')
on conflict (role, capability) do nothing;

-- ── 2. vocabulary: seven audit actions ─────────────────────────────────────
-- Mirrors AUDIT_ACTIONS / AUDIT_ENTITIES in src/modules/audit/types.ts. No new
-- audit table and no second trail — `audit_log` carries these like every other
-- act, which is also why the restore leaves it standing.
--
-- A restore is recorded twice, and the split is deliberate. `restore.started` is
-- written by the seat *before* the call, because an entry written afterwards does
-- not exist if the restore fails or ends the session that asked for it;
-- `restore.completed` / `restore.failed` are written after, when the outcome is
-- known. `backup.created` and `backup.downloaded` are separate verbs for the same
-- reason the capabilities are separate: taking a snapshot exposes nothing, and
-- downloading one exposes everything.
insert into public.audit_actions (action, entity) values
  ('backup.created',          'backup'),
  ('backup.downloaded',       'backup'),
  ('backup.settings_changed', 'backup'),
  ('restore.started',         'backup'),
  ('restore.completed',       'backup'),
  ('restore.failed',          'backup'),
  ('health.check_run',        'backup')
on conflict (action) do nothing;

-- ── 3. the table list, in one place ────────────────────────────────────────
/**
 * Every table a snapshot carries, in foreign-key dependency order: a parent
 * always appears before the children that point at it. A restore inserts in this
 * order and deletes in the reverse, so no child is ever written before its
 * parent exists and no parent is ever removed while a child still points at it.
 *
 * One function rather than a list repeated in four, because the day somebody adds
 * a table they should have to add it once. Mirrors LIVE_TABLES in
 * src/modules/backup/schema.ts, which the selftest compares against this array.
 */
create or replace function public.backup_table_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select array[
    -- counters and vocabulary first: nothing points at them, everything may be
    -- pointed at by them
    'approval_counters',
    'refund_counters',
    'return_counters',
    'sale_counters',
    'role_aliases',
    'role_capabilities',
    'audit_actions',
    'approval_rules',
    -- the storefront's own documents
    'campaigns',
    'coupons',
    'store_faqs',
    'website_settings',
    -- the catalogue and the people
    'categories',
    'custom_roles',
    'customers',
    'store_customers',
    'shifts',
    'products',
    'profiles',
    -- the trading record
    'expenses',
    'sales',
    'audit_log',
    'online_orders',
    'sales_returns',
    -- children of the above, last
    'sale_items',
    'sale_payments',
    'stock_movements',
    'product_content',
    'store_reviews',
    'online_order_items',
    'order_events',
    'stock_reservations',
    'return_items',
    'refund_records',
    'approval_requests'
  ];
$$;

/**
 * What a restore actually rewrites: the order above, minus the four tables it
 * must leave alone (see the header, point 5).
 *
 * Derived rather than written out again, so the two lists cannot drift — adding a
 * table to `backup_table_order()` puts it in the restore path automatically, and
 * excluding one is a single name in a single array.
 */
create or replace function public.backup_restore_order()
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array(
    select t
      from unnest(public.backup_table_order()) with ordinality as x(t, n)
     where t <> all (array['role_aliases', 'role_capabilities', 'audit_actions', 'audit_log'])
     order by n
  ), '{}');
$$;

-- ── 4. the snapshot store ──────────────────────────────────────────────────
/**
 * One row per snapshot.
 *
 * `document` is the whole envelope — format, mode, actor, per-table counts, the
 * checksum and the payload — stored exactly as it would be written to a file, so
 * a download is a serialization and not a translation. `checksum`, `row_count`,
 * `size_bytes` and `table_count` are also columns: the list has to show them
 * without reading a megabyte of jsonb per row, and the restore verifies the
 * checksum in the same statement that reads it.
 *
 * `backups` itself is not in `backup_table_order()`. A restore replaces the
 * installation's data; it does not replace the record of how that data was
 * protected, and the `pre_restore` row written seconds earlier has to survive the
 * restore that needed it — that row is the rollback.
 */
create table if not exists public.backups (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'manual'
                    check (kind in ('manual', 'automatic', 'pre_restore')),
  note            text,
  mode            text not null default 'supabase'
                    check (mode in ('supabase', 'demo')),
  schema_version  smallint not null default 1,
  document        jsonb not null
                    check (jsonb_typeof(document) = 'object'),
  checksum        text not null default '',
  row_count       bigint not null default 0,
  size_bytes      bigint not null default 0,
  table_count     smallint not null default 0,
  source_revision text,
  created_at      timestamptz not null default now(),
  created_by      text not null default '',
  created_by_name text not null default '',

  constraint backups_note_len check (note is null or char_length(note) <= 500)
);

-- The list is read newest-first, and retention is decided per kind.
create index if not exists backups_created_at_idx on public.backups (created_at desc);
create index if not exists backups_kind_created_at_idx on public.backups (kind, created_at desc);

alter table public.backups enable row level security;

-- Closed. Every read and every write goes through a function below, each of
-- which checks a capability before it does anything; there is no policy because
-- there is no direct access to allow. `authenticated` is not granted select on
-- this table at all, so the document cannot be read by naming the table.
drop policy if exists "backups_no_select" on public.backups;
create policy "backups_no_select"
  on public.backups for select to anon, authenticated using (false);

drop policy if exists "backups_no_insert" on public.backups;
create policy "backups_no_insert"
  on public.backups for insert to anon, authenticated with check (false);

drop policy if exists "backups_no_update" on public.backups;
create policy "backups_no_update"
  on public.backups for update to anon, authenticated using (false);

drop policy if exists "backups_no_delete" on public.backups;
create policy "backups_no_delete"
  on public.backups for delete to anon, authenticated using (false);

comment on table public.backups is
  'Whole-installation snapshots. The document column is reachable only through '
  'get_backup_document(), admin_restore_backup() and admin_restore_document(), '
  'each of which checks a capability first.';

/**
 * The list the app reads: everything about a snapshot except the snapshot.
 *
 * The filter is in the view rather than in a policy on it, so it holds on every
 * Postgres version and for every caller — a view policy would be a second thing
 * to get right, and getting it wrong means handing out the database. The view is
 * not `security_invoker`, so it reads `backups` as its owner; the capability check
 * is what decides whether the caller sees any rows at all.
 */
create or replace view public.backup_manifests as
select b.id,
       b.kind,
       b.note,
       b.mode,
       b.schema_version,
       b.checksum,
       b.row_count,
       b.size_bytes,
       b.table_count,
       b.source_revision,
       b.created_at,
       b.created_by,
       b.created_by_name
  from public.backups b
 where public.can('view_backups');

comment on view public.backup_manifests is
  'Snapshot metadata for seats holding view_backups — never the document itself.';

-- ── 5. the schedule ────────────────────────────────────────────────────────
/**
 * One row (id = 1), like `website_settings`: the schedule is a property of the
 * installation, not of a seat, so there is nothing to join and nothing to pick.
 *
 * `frequency = 'off'` is the disabled state rather than a separate boolean, so
 * the three states an operator actually chooses between — off, daily, weekly —
 * are one column and cannot contradict each other.
 */
create table if not exists public.backup_settings (
  id                smallint primary key default 1 check (id = 1),
  frequency         text not null default 'daily'
                      check (frequency in ('off', 'daily', 'weekly')),
  retention_days    integer not null default 30
                      check (retention_days between 1 and 3650),
  retention_count   integer not null default 14
                      check (retention_count between 1 and 500),
  last_automatic_at timestamptz,
  updated_at        timestamptz not null default now(),
  updated_by        text not null default '',
  updated_by_name   text not null default ''
);

insert into public.backup_settings (id) values (1) on conflict (id) do nothing;

alter table public.backup_settings enable row level security;

-- Readable by a seat that may see the panel; writable only through
-- save_backup_settings(), which checks manage_settings and stamps who changed
-- it. A direct update would be an unaudited change to the recovery policy.
drop policy if exists "backup_settings_select" on public.backup_settings;
create policy "backup_settings_select"
  on public.backup_settings for select to authenticated
  using (public.can('view_backups'));

drop policy if exists "backup_settings_no_insert" on public.backup_settings;
create policy "backup_settings_no_insert"
  on public.backup_settings for insert to anon, authenticated with check (false);

drop policy if exists "backup_settings_no_update" on public.backup_settings;
create policy "backup_settings_no_update"
  on public.backup_settings for update to anon, authenticated using (false);

drop policy if exists "backup_settings_no_delete" on public.backup_settings;
create policy "backup_settings_no_delete"
  on public.backup_settings for delete to anon, authenticated using (false);

comment on table public.backup_settings is
  'Singleton (id = 1): automatic snapshot frequency and retention. Written only '
  'by save_backup_settings().';

-- ── 6. building a snapshot ─────────────────────────────────────────────────
/**
 * Read every table into one jsonb document. This is the builder; the gate lives
 * in `snapshot_document()` below, because the callers that need a document
 * (`create_backup`, the schedule, the pre-restore snapshot) have already checked
 * a different capability and must not be refused for lacking `export_backup`.
 *
 * Dynamic SQL over `backup_table_order()` rather than 35 hand-written
 * `jsonb_agg` lines, so a new table is carried by the next snapshot without this
 * function being edited — and so the list that decides what is backed up is the
 * same list that decides what a restore must find.
 *
 * Not granted to any role: it is called by the functions below, which run as
 * their owner.
 */
create or replace function public.build_snapshot_document(
  p_kind text default 'manual',
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
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

  -- The payload, wrapped, is what the checksum and the byte count are taken
  -- over — the same string the offline builder hashes (`checksumInput` in
  -- src/modules/backup/schema.ts), so a document means the same thing in both
  -- modes and a restore verifies what a snapshot actually asserted.
  v_full := jsonb_build_object('tables', v_payload);

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = v_actor;
  end if;
  v_name := coalesce(v_name, '');

  -- Where the snapshot came from, when the database can say. Read through
  -- dynamic SQL because the catalog is Supabase's, not this project's, and a
  -- project without it must still be able to take a backup.
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
$$;

/**
 * Hand a seat the document — the act of leaving the building with the database.
 *
 * Gated on `export_backup`, not on `view_backups`: the list says a snapshot
 * exists, this returns every customer, every sale and every staff account in it.
 * The two are separate capabilities precisely so that this one can be withheld.
 */
create or replace function public.snapshot_document(
  p_kind text default 'manual',
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if not public.can('export_backup') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;
  return public.build_snapshot_document(p_kind, p_note);
end;
$$;

/**
 * Read a stored snapshot's document, by id.
 *
 * Same gate as `snapshot_document()`: a stored snapshot and a fresh one contain
 * the same thing, so wanting either is wanting the database. The download path in
 * the app goes through here and nowhere else.
 */
create or replace function public.get_backup_document(p_backup_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_document jsonb;
begin
  if not public.can('export_backup') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;

  select b.document into v_document from public.backups b where b.id = p_backup_id;
  if v_document is null then
    -- P0002 is `no_data_found`, which the app's repository translates to a
    -- NOT_FOUND error rather than a generic failure: "that snapshot is gone" is
    -- a different sentence from "the database refused you".
    raise exception 'backup.error.not_found' using errcode = 'P0002';
  end if;

  return v_document;
end;
$$;

-- ── 7. retention ───────────────────────────────────────────────────────────
/**
 * Apply the retention policy, and nothing else.
 *
 * Called after every write, so the policy is enforced by the act that would
 * otherwise breach it rather than by a job somebody has to remember. Two rules,
 * both from `backup_settings`:
 *
 *   automatic  — keep the newest `retention_count`, and drop any older than
 *                `retention_days`. Both, because a busy week can fill a disk
 *                long before the window expires, and a quiet month can leave a
 *                snapshot nobody will ever need.
 *   pre_restore — the window only. A rollback point is worth keeping while the
 *                restore it protects is recent, and worthless a year later; the
 *                count does not apply, because pruning it by position could
 *                remove the way back from the most recent restore.
 *
 * Manual snapshots are never pruned. Somebody asked for that one by hand, often
 * for a reason written in its note ("before the July price change"), and a
 * policy deleting it silently is exactly the surprise this feature exists to
 * prevent.
 */
create or replace function public.prune_backups()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_days    integer;
  v_count   integer;
  v_cutoff  timestamptz;
  v_removed integer := 0;
begin
  select s.retention_days, s.retention_count
    into v_days, v_count
    from public.backup_settings s
   where s.id = 1;

  v_days  := coalesce(v_days, 30);
  v_count := coalesce(v_count, 14);
  v_cutoff := now() - make_interval(days => greatest(v_days, 1));

  with ranked as (
    select b.id,
           b.kind,
           b.created_at,
           row_number() over (partition by b.kind order by b.created_at desc) as rn
      from public.backups b
     where b.kind in ('automatic', 'pre_restore')
  ),
  doomed as (
    select r.id
      from ranked r
     where (r.kind = 'automatic' and (r.rn > greatest(v_count, 1) or r.created_at < v_cutoff))
        or (r.kind = 'pre_restore' and r.created_at < v_cutoff)
  )
  delete from public.backups b using doomed d where b.id = d.id;

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

-- ── 8. taking a snapshot ───────────────────────────────────────────────────
/**
 * Store a snapshot and return its manifest.
 *
 * `kind` is limited to what a seat may ask for. `pre_restore` is refused here on
 * purpose: that row is evidence that a restore happened and the way back from it,
 * and a seat able to write one by hand could manufacture a rollback point that
 * never protected anything — or bury the real one under lookalikes.
 *
 * Retention runs inside the same call, so the policy is applied by the act that
 * could breach it.
 */
create or replace function public.create_backup(
  p_kind text default 'manual',
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_document jsonb;
  v_kind     text;
  v_row      public.backups%rowtype;
  v_pruned   integer;
begin
  if not public.can('create_backup') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;

  v_kind := case when p_kind in ('manual', 'automatic') then p_kind else 'manual' end;
  if p_kind = 'pre_restore' then
    raise exception 'backup.error.forbidden_kind' using errcode = 'insufficient_privilege';
  end if;

  v_document := public.build_snapshot_document(v_kind, p_note);

  insert into public.backups (
    kind, note, mode, schema_version, document, checksum,
    row_count, size_bytes, table_count, source_revision,
    created_at, created_by, created_by_name
  )
  values (
    v_kind,
    v_document->>'note',
    coalesce(v_document->>'mode', 'supabase'),
    coalesce((v_document->>'schema_version')::smallint, 1),
    v_document,
    coalesce(v_document->>'checksum', ''),
    coalesce((v_document->>'row_count')::bigint, 0),
    coalesce((v_document->>'size_bytes')::bigint, 0),
    coalesce((select count(*) from jsonb_object_keys(v_document->'counts')), 0)::smallint,
    v_document->>'source_revision',
    coalesce(nullif(v_document->>'created_at', '')::timestamptz, now()),
    coalesce(v_document->'created_by'->>'id', ''),
    coalesce(v_document->'created_by'->>'name', '')
  )
  returning * into v_row;

  v_pruned := public.prune_backups();

  return jsonb_build_object(
    'id',              v_row.id,
    'kind',            v_row.kind,
    'note',            v_row.note,
    'mode',            v_row.mode,
    'schema_version',  v_row.schema_version,
    'checksum',        v_row.checksum,
    'row_count',       v_row.row_count,
    'size_bytes',      v_row.size_bytes,
    'table_count',     v_row.table_count,
    'source_revision', v_row.source_revision,
    'created_at',      to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'created_by',      nullif(v_row.created_by, ''),
    'created_by_name', nullif(v_row.created_by_name, ''),
    'pruned',          v_pruned
  );
end;
$$;

/**
 * The scheduled path: take a snapshot only if the policy says one is due.
 *
 * No capability check, and that is the whole reason this function exists —
 * `pg_cron` runs it as `postgres` with no signed-in seat behind it, so
 * `public.can()` has nobody to ask. The authority therefore lives in the grants:
 * execute is revoked from `anon` and `authenticated` and never given back, so no
 * session can reach it. It is a clock's entry point, not a seat's.
 *
 * Also the reason the app has its own `automaticBackupIfDue`: a project without
 * `pg_cron` still gets automatic snapshots, taken by the first admin to open the
 * panel after one falls due. Both paths call the same function, so a snapshot is
 * never taken twice for one window — `last_automatic_at` is the single answer to
 * "have we done this yet?".
 */
create or replace function public.automatic_backup_if_due()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_frequency text;
  v_last      timestamptz;
  v_interval  interval;
  v_next      timestamptz;
  v_document  jsonb;
  v_row       public.backups%rowtype;
  v_pruned    integer;
begin
  select s.frequency, s.last_automatic_at
    into v_frequency, v_last
    from public.backup_settings s
   where s.id = 1;

  v_frequency := coalesce(v_frequency, 'off');
  if v_frequency = 'off' then
    return jsonb_build_object('ran', false, 'reason', 'disabled', 'frequency', 'off');
  end if;

  v_interval := case when v_frequency = 'weekly' then interval '7 days' else interval '1 day' end;
  v_next := coalesce(v_last, '-infinity'::timestamptz) + v_interval;

  if v_last is not null and now() < v_next then
    return jsonb_build_object(
      'ran', false,
      'reason', 'not_due',
      'frequency', v_frequency,
      'next_due_at', to_char(v_next at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  v_document := public.build_snapshot_document('automatic', 'Scheduled snapshot');

  insert into public.backups (
    kind, note, mode, schema_version, document, checksum,
    row_count, size_bytes, table_count, source_revision,
    created_at, created_by, created_by_name
  )
  values (
    'automatic',
    v_document->>'note',
    coalesce(v_document->>'mode', 'supabase'),
    coalesce((v_document->>'schema_version')::smallint, 1),
    v_document,
    coalesce(v_document->>'checksum', ''),
    coalesce((v_document->>'row_count')::bigint, 0),
    coalesce((v_document->>'size_bytes')::bigint, 0),
    coalesce((select count(*) from jsonb_object_keys(v_document->'counts')), 0)::smallint,
    v_document->>'source_revision',
    coalesce(nullif(v_document->>'created_at', '')::timestamptz, now()),
    '',
    'schedule'
  )
  returning * into v_row;

  update public.backup_settings
     set last_automatic_at = v_row.created_at
   where id = 1;

  v_pruned := public.prune_backups();

  return jsonb_build_object(
    'ran', true,
    'frequency', v_frequency,
    'pruned', v_pruned,
    'backup', jsonb_build_object(
      'id',          v_row.id,
      'kind',        v_row.kind,
      'row_count',   v_row.row_count,
      'size_bytes',  v_row.size_bytes,
      'table_count', v_row.table_count,
      'checksum',    v_row.checksum,
      'created_at',  to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  );
end;
$$;

-- ── 9. the schedule's own settings ─────────────────────────────────────────
/**
 * Change the recovery policy, and say who changed it.
 *
 * Gated on `manage_settings` — the same capability the app asserts before calling
 * it, so the check is in both places and neither is load-bearing alone. Values are
 * clamped rather than refused: a policy is not a form field worth an error dialog,
 * and a number outside the range the table allows is a number nobody meant.
 */
create or replace function public.save_backup_settings(
  p_frequency text default 'daily',
  p_retention_days integer default 30,
  p_retention_count integer default 14
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_frequency text;
  v_days      integer;
  v_count     integer;
  v_actor     uuid := auth.uid();
  v_name      text := '';
begin
  if not public.can('manage_settings') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;

  v_frequency := case when p_frequency in ('off', 'daily', 'weekly') then p_frequency else 'daily' end;
  v_days  := least(3650, greatest(1, coalesce(p_retention_days, 30)));
  v_count := least(500,  greatest(1, coalesce(p_retention_count, 14)));

  if v_actor is not null then
    select p.name into v_name from public.profiles p where p.id = v_actor;
  end if;

  insert into public.backup_settings (id) values (1) on conflict (id) do nothing;

  update public.backup_settings
     set frequency       = v_frequency,
         retention_days  = v_days,
         retention_count = v_count,
         updated_at      = now(),
         updated_by      = coalesce(v_actor::text, ''),
         updated_by_name = coalesce(v_name, '')
   where id = 1;

  -- Applying the new policy immediately: shortening a window is a decision about
  -- what is kept, and waiting for the next snapshot to enforce it would keep
  -- exactly the rows the admin asked to stop keeping.
  perform public.prune_backups();

  return (select to_jsonb(s) from public.backup_settings s where s.id = 1);
end;
$$;

-- ── 10. putting the installation back ──────────────────────────────────────
/**
 * Replace the installation's data with a document. One function, so one
 * transaction: validation first, then the way back, then the deletes and inserts.
 * Any failure — a missing table, a checksum that does not match, a foreign key
 * that will not accept a row — rolls the whole of it back, and the installation
 * is exactly as it was. There is no partial restore, because there is no commit
 * until all of it worked.
 *
 * The order of operations is the safety argument:
 *
 *   1. authority   — `restore_backup`, checked here and not only in the browser,
 *                    because the deletion happens here.
 *   2. integrity   — is it one of our documents, is it a version this build
 *                    understands, was it made by a live installation, does it hold
 *                    every table, does its checksum match its payload. Each
 *                    refusal names a code the UI translates.
 *   3. the way back — a `pre_restore` snapshot of the current state, written
 *                    before anything is deleted. This is the rollback: restoring
 *                    that snapshot undoes this one.
 *   4. delete      — `backup_restore_order()` reversed, so no parent is removed
 *                    while a child still points at it.
 *   5. insert      — forward order, so every child finds its parent. Rows are
 *                    read through `jsonb_populate_record`, which fills the
 *                    columns this release has and ignores the ones it no longer
 *                    does; a snapshot from an older release that is missing a
 *                    column this one requires fails loudly here rather than
 *                    quietly writing nulls.
 *
 * Deliberately not restored: `role_capabilities`, `audit_actions`, `role_aliases`
 * and `audit_log` (see `backup_restore_order()` and the header). The audit trail
 * therefore still holds the `restore.started` entry the seat wrote before calling
 * this — the log the restore began in is the log the restore ends in.
 */
create or replace function public.admin_restore_document(p_document jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_tables   text[] := public.backup_restore_order();
  v_table    text;
  v_rows     jsonb;
  v_held     jsonb;
  v_missing  text[] := '{}';
  v_inserted bigint := 0;
  v_skipped  bigint := 0;
  v_pre_id   uuid;
  v_pre_doc  jsonb;
  v_expected text;
  v_actual   text;
  v_started  timestamptz := clock_timestamp();
begin
  -- 1. authority
  if not public.can('restore_backup') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;

  -- 2. integrity
  if p_document is null or jsonb_typeof(p_document) <> 'object' then
    raise exception 'backup.error.unparseable' using errcode = '22023';
  end if;
  if coalesce(p_document->>'format', '') <> 'alyq-backup' then
    raise exception 'backup.error.bad_format' using errcode = '22023';
  end if;
  if coalesce((p_document->>'schema_version')::integer, -1) <> 1 then
    raise exception 'backup.error.bad_version' using errcode = '22023';
  end if;
  if coalesce(p_document->>'mode', '') <> 'supabase' then
    -- A demo document holds localStorage stores, not tables: restoring one here
    -- would delete every table and fill none of them. Refused by mode, by name.
    raise exception 'backup.error.mode_mismatch' using errcode = '22023';
  end if;

  v_held := p_document->'payload'->'tables';
  if v_held is null or jsonb_typeof(v_held) <> 'object' then
    raise exception 'backup.error.empty' using errcode = '22023';
  end if;

  -- Completeness before anything else is touched. A document missing tables is
  -- the dangerous case: restoring it would leave the installation with some of
  -- its data replaced and some untouched, which is worse than either.
  foreach v_table in array public.backup_table_order() loop
    if not (v_held ? v_table) then
      v_missing := v_missing || v_table;
    end if;
  end loop;
  if array_length(v_missing, 1) is not null then
    raise exception 'backup.error.incomplete: %', array_to_string(v_missing, ', ')
      using errcode = '22023';
  end if;

  -- The checksum is the database's own md5 over the payload, recomputed here
  -- where it can be: the app cannot produce it, so this is the only place a
  -- truncated or hand-edited document is caught.
  v_expected := coalesce(p_document->>'checksum', '');
  v_actual := md5((p_document->'payload')::text);
  if v_expected <> '' and v_expected <> v_actual then
    raise exception 'backup.error.checksum_mismatch' using errcode = '22023';
  end if;

  -- 3. the way back, taken before the first delete
  v_pre_doc := public.build_snapshot_document(
    'pre_restore',
    'Automatic snapshot taken before a restore'
  );
  insert into public.backups (
    kind, note, mode, schema_version, document, checksum,
    row_count, size_bytes, table_count, source_revision,
    created_at, created_by, created_by_name
  )
  values (
    'pre_restore',
    v_pre_doc->>'note',
    'supabase',
    1,
    v_pre_doc,
    coalesce(v_pre_doc->>'checksum', ''),
    coalesce((v_pre_doc->>'row_count')::bigint, 0),
    coalesce((v_pre_doc->>'size_bytes')::bigint, 0),
    coalesce((select count(*) from jsonb_object_keys(v_pre_doc->'counts')), 0)::smallint,
    v_pre_doc->>'source_revision',
    coalesce(nullif(v_pre_doc->>'created_at', '')::timestamptz, now()),
    coalesce(v_pre_doc->'created_by'->>'id', ''),
    coalesce(v_pre_doc->'created_by'->>'name', '')
  )
  returning id into v_pre_id;

  -- 4. delete, children first
  for i in reverse array_length(v_tables, 1)..1 loop
    execute format('delete from public.%I', v_tables[i]);
  end loop;

  -- 5. insert, parents first
  foreach v_table in array v_tables loop
    v_rows := v_held->v_table;
    if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
      continue;
    end if;

    if v_table = 'profiles' then
      -- `profiles.id` is a foreign key into `auth.users`, and a restore cannot
      -- put an authentication account back: those live outside this schema and
      -- are not in any snapshot. A profile whose account no longer exists cannot
      -- sign in and cannot be inserted, so it is skipped rather than allowed to
      -- fail the whole restore — and counted, so the outcome says how many.
      execute format(
        'insert into public.%I
           select (jsonb_populate_record(null::public.%I, e.value)).*
             from jsonb_array_elements($1) as e(value)
            where coalesce(e.value->>''id'', '''') ~ ''^[0-9a-fA-F-]{36}$''
              and exists (select 1 from auth.users u where u.id = (e.value->>''id'')::uuid)',
        v_table, v_table
      ) using v_rows;
      get diagnostics v_inserted = row_count;

      execute format(
        'select count(*) from jsonb_array_elements($1) as e(value)
          where not (coalesce(e.value->>''id'', '''') ~ ''^[0-9a-fA-F-]{36}$''
                     and exists (select 1 from auth.users u where u.id = (e.value->>''id'')::uuid))',
        v_table
      ) using v_rows into v_skipped;
    else
      execute format(
        'insert into public.%I
           select (jsonb_populate_record(null::public.%I, e.value)).*
             from jsonb_array_elements($1) as e(value)',
        v_table, v_table
      ) using v_rows;
      get diagnostics v_inserted = row_count;
      v_skipped := 0;
    end if;
  end loop;

  return jsonb_build_object(
    'ok',                    true,
    'mode',                  'supabase',
    'restored_at',           to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'row_count',             (select coalesce(sum(jsonb_array_length(v_held->t)), 0)
                                from unnest(v_tables) as t),
    'tables_restored',       array_length(v_tables, 1),
    'pre_restore_backup_id', v_pre_id,
    'profiles_skipped',      v_skipped,
    'started_at',            to_char(v_started at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'source_created_at',     p_document->>'created_at',
    'checksum',              v_actual
  );
end;
$$;

/**
 * Restore a snapshot the database is already holding.
 *
 * Reads the document without `export_backup` and that is not an oversight: the
 * authority to install a snapshot has to include the authority to read the one it
 * is installing, or the two capabilities would have to be granted together and
 * the split would mean nothing. What a restore does not grant is a copy leaving
 * the building — the document is read inside this function, handed to
 * `admin_restore_document()`, and never returned to the caller.
 */
create or replace function public.admin_restore_backup(p_backup_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_document jsonb;
begin
  if not public.can('restore_backup') then
    raise exception 'backup.error.forbidden' using errcode = 'insufficient_privilege';
  end if;

  select b.document into v_document from public.backups b where b.id = p_backup_id;
  if v_document is null then
    raise exception 'backup.error.not_found' using errcode = 'P0002';
  end if;

  return public.admin_restore_document(v_document);
end;
$$;

-- ── 11. the clock (optional) ───────────────────────────────────────────────
/**
 * A daily tick, when the project has `pg_cron`.
 *
 * Optional on purpose. `pg_cron` is not enabled on every Supabase project and
 * creating it needs privileges this migration may not have, so the whole block is
 * guarded by a catalog check and wrapped in a handler: a project without it still
 * installs, still passes `db:check`, and still gets automatic snapshots through
 * the app's own `automaticBackupIfDue`. Nothing here may fail the migration.
 *
 * One tick a day serves both policies — the function it calls reads
 * `backup_settings` and returns without writing when a weekly snapshot is not yet
 * due. 03:17 rather than 03:00 because every cron job in every project wants the
 * top of the hour, and a backup competing with them for the same minute is a
 * backup that runs slowly.
 */
do $do$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available; automatic snapshots will be taken by the application when an admin session opens the panel.';
    return;
  end if;

  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron could not be enabled (%); automatic snapshots will be taken by the application instead.', sqlerrm;
    return;
  end;

  begin
    perform cron.schedule(
      'alyq-automatic-backup',
      '17 3 * * *',
      $cron$select public.automatic_backup_if_due()$cron$
    );
  exception when others then
    raise notice 'the automatic backup job could not be scheduled (%); the application will take snapshots when one is due.', sqlerrm;
  end;
end
$do$;

-- ── 12. who may call what ──────────────────────────────────────────────────
-- Supabase stopped granting privileges on new `public` objects to `authenticated`
-- by default, so existence is not reachability: without these, the app would
-- answer `permission denied` on a schema that is otherwise correct.
grant select on public.backup_manifests  to authenticated;
grant select on public.backup_settings   to authenticated;

grant execute on function public.backup_table_order()                       to authenticated;
grant execute on function public.backup_restore_order()                     to authenticated;
grant execute on function public.snapshot_document(text, text)              to authenticated;
grant execute on function public.get_backup_document(uuid)                  to authenticated;
grant execute on function public.create_backup(text, text)                  to authenticated;
grant execute on function public.save_backup_settings(text, integer, integer) to authenticated;
grant execute on function public.admin_restore_document(jsonb)              to authenticated;
grant execute on function public.admin_restore_backup(uuid)                 to authenticated;

-- The two functions no session may reach. `build_snapshot_document` is the
-- ungated builder the gated ones call, and `automatic_backup_if_due` is the
-- clock's entry point: it checks no capability because there is no seat behind
-- it, so its authority is that nobody but the scheduler can invoke it.
revoke all on function public.build_snapshot_document(text, text) from public, anon, authenticated;
revoke all on function public.automatic_backup_if_due()           from public, anon, authenticated;
-- Retention is applied by the writes that would otherwise breach it, never by a
-- seat on its own initiative.
revoke all on function public.prune_backups()                     from public, anon, authenticated;

revoke all on public.backup_manifests from anon;
revoke all on public.backup_settings  from anon;
-- `backups` is never granted: the document is reached only through a function
-- that has already decided the caller may have it.
revoke all on public.backups from anon, authenticated;

comment on function public.automatic_backup_if_due() is
  'Clock-only. Takes a snapshot when backup_settings says one is due. Revoked '
  'from every session role: it checks no capability because pg_cron has no seat, '
  'so its authority is that nothing but the scheduler can call it.';

comment on function public.admin_restore_document(jsonb) is
  'Replaces the installation with a document, in one transaction: validate, '
  'snapshot the current state as pre_restore, delete in reverse dependency '
  'order, insert in dependency order. Requires restore_backup. Leaves the audit '
  'log and the permission vocabulary standing.';

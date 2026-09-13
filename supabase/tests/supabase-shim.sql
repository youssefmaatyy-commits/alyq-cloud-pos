-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Supabase shim (test fixture — NOT a migration)
--
-- The migrations in `supabase/migrations/` are written for Supabase, so they
-- assume objects that Supabase itself provides and that the repository never
-- creates: the `auth` and `storage` schemas, `auth.uid()`, and the `anon` /
-- `authenticated` / `service_role` roles.
--
-- This file supplies minimal stand-ins for those objects so the migration chain
-- can be applied to a plain PostgreSQL server — which is what
-- `scripts/migrations.check.mjs --driver=pglite` does on every CI run. It is
-- never applied to a real Supabase project, where these objects already exist.
--
-- The stand-ins are deliberately small: enough for the migrations' DDL, RLS
-- policies and RPC definitions to be validated, not a reimplementation of
-- Supabase. Behaviour that depends on real Supabase internals (JWT parsing,
-- Storage internals) is out of scope here and is covered by the live suites.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── roles ─────────────────────────────────────────────────────────────────
-- Supabase ships these; `create policy … to authenticated` and
-- `grant … to authenticated` both fail without them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ── auth schema ───────────────────────────────────────────────────────────
create schema if not exists auth;

-- Mirrors the columns the migrations reference: `auth.users(id)` as a foreign
-- key target, plus the metadata columns `handle_new_user()` reads and the
-- credential columns `seed_demo_staff()` writes. Supabase's real table has many
-- more; these are the ones the repository depends on.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  instance_id        uuid,
  aud                text,
  role               text,
  email              text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- GoTrue needs an identity row for the email provider to accept a password
-- sign-in. Column set as of current Supabase; see the note in migration 0014.
create table if not exists auth.identities (
  id            uuid primary key default gen_random_uuid(),
  provider_id   text,
  user_id       uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null default '{}'::jsonb,
  provider      text not null,
  last_sign_in_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Supabase reads the caller from the request JWT, and that has had two
-- spellings: PostgREST used to publish every claim as its own GUC
-- (`request.jwt.claim.sub`), and now publishes the whole verified token as one
-- JSON GUC (`request.jwt.claims`). A hosted project reads the JSON form.
--
-- This stand-in reads BOTH and prefers the JSON one, which is a fidelity fix and
-- not a tidiness one. The harness impersonates a user with
-- `set_config('request.jwt.claim.sub', '<uuid>', true)`, so the legacy key has to
-- keep working — but while it was the ONLY key, a function written the way
-- production writes it (`auth.jwt() ->> 'sub'`, or reading `request.jwt.claims`
-- directly) saw an empty token here and a full one live: it would pass in CI and
-- then deny every real caller, or the reverse. Reading both means the two
-- spellings cannot disagree about who is asking.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''),
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    'anon'
  )
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''),
    nullif(current_setting('request.jwt.claim.email', true), '')
  )
$$;

-- Present in real Supabase and absent here until now, which meant a policy or
-- function using it could not be tested at all. Built from whichever spelling
-- the caller set, so it agrees with the three functions above.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    jsonb_build_object(
      'sub',   nullif(current_setting('request.jwt.claim.sub', true), ''),
      'role',  nullif(current_setting('request.jwt.claim.role', true), ''),
      'email', nullif(current_setting('request.jwt.claim.email', true), '')
    )
  )
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
grant select on auth.identities to service_role;

-- ── storage schema ────────────────────────────────────────────────────────
create schema if not exists storage;

-- Migration 0005 inserts into `storage.buckets` and guards its optional
-- columns with `information_schema` checks, so the minimal column set here is
-- what that migration is written to tolerate.
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

-- Storage owns its own RLS in production; the policies in 0005 are attached to
-- this table either way, so it must exist and be RLS-enabled.
alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0001
-- Phase 2 — Categories table
-- Safe to re-run in pieces; each statement is idempotent where possible.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── categories ────────────────────────────────────────────────────────────
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  name_ar    text        not null check (char_length(btrim(name_ar)) between 1 and 120),
  name_en    text        not null check (char_length(btrim(name_en)) between 1 and 120),
  parent_id  uuid        references public.categories (id) on delete restrict,
  active     boolean     not null default true,
  sort_order integer     not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table  public.categories is 'Bilingual product categories supporting a nested tree (Phase 2).';
comment on column public.categories.parent_id  is 'Parent category; NULL for top-level categories.';
comment on column public.categories.sort_order is 'Ascending display order inside the same parent.';

create index if not exists categories_parent_idx   on public.categories (parent_id);
create index if not exists categories_active_idx   on public.categories (active);
create index if not exists categories_sort_idx     on public.categories (sort_order, name_en);

-- Trigger: keep updated_at fresh.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists categories_set_updated_at on public.categories;
create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- Trigger: block parent cycles (a category may never be its own ancestor).
create or replace function public.categories_block_cycle()
returns trigger
language plpgsql
as $$
declare
  cursor_id uuid;
  hops      integer := 0;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'Category % cannot be its own parent', new.id
      using errcode = 'check_violation';
  end if;

  cursor_id := new.parent_id;
  while cursor_id is not null and hops < 64 loop
    if cursor_id = new.id then
      raise exception 'Category % would create a parent cycle', new.id
        using errcode = 'check_violation';
    end if;
    select c.parent_id into cursor_id from public.categories c where c.id = cursor_id;
    hops := hops + 1;
  end loop;

  return new;
end;
$$;

drop trigger if exists categories_block_cycle_trigger on public.categories;
create trigger categories_block_cycle_trigger
  before insert or update of parent_id on public.categories
  for each row execute function public.categories_block_cycle();

-- Trigger: block deleting a category that still contains products.
create or replace function public.categories_block_delete_in_use()
returns trigger
language plpgsql
as $$
declare
  used_by bigint;
begin
  select count(*) into used_by
    from public.products p
   where p.category_id = old.id;

  if used_by > 0 then
    raise exception 'Category % still contains % product(s); deactivate it instead', old.id, used_by
      using errcode = '23503';
  end if;

  return old;
end;
$$;

drop trigger if exists categories_block_delete_in_use_trigger on public.categories;
create trigger categories_block_delete_in_use_trigger
  before delete on public.categories
  for each row execute function public.categories_block_delete_in_use();

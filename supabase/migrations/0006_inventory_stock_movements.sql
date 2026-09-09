-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0006
-- Phase 3 — Inventory stock movement ledger.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── stock_movements (append-only audit log) ──────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_movement_type') then
    create type public.stock_movement_type as enum (
      'adjustment_in',
      'adjustment_out',
      'receive',
      'issue',
      'transfer',
      'correction'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_reason') then
    create type public.stock_reason as enum (
      'purchase',
      'supplier_return',
      'customer_return',
      'damaged',
      'expired',
      'lost',
      'theft',
      'recount',
      'transfer_in',
      'transfer_out',
      'other'
    );
  end if;
end
$$;

create table if not exists public.stock_movements (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id) on delete restrict,
  delta           integer not null check (delta > 0),
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after  integer not null check (quantity_after >= 0),
  type            public.stock_movement_type not null,
  reason          public.stock_reason         not null,
  notes           text,
  user_id         text   not null,
  user_name       text   not null,
  created_at      timestamptz not null default now(),

  -- After-write sanity: before + signed delta == after, never negative.
  constraint stock_movements_consistent
    check (quantity_after = greatest(0, quantity_before + (case
      when type in ('adjustment_out','issue','transfer') then -delta
      else delta
    end)))
);

comment on table  public.stock_movements is 'Append-only stock movement log; each row is the durable record of a quantity change.';
comment on column public.stock_movements.delta is 'Magnitude of the change; sign is implied by `type`.';
comment on column public.stock_movements.user_id is 'Internal user id (Phase 3 uses local ids; Phase 4+ should wire to auth.users).';
comment on column public.stock_movements.user_name is 'Snapshot of the user name at movement time so the audit trail is stable.';

create index if not exists stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index if not exists stock_movements_type_idx   on public.stock_movements (type, created_at desc);
create index if not exists stock_movements_user_idx   on public.stock_movements (user_id, created_at desc);

-- ── product.stock_quantity invariant ─────────────────────────────────────
-- Belt-and-braces: the product row is always >= 0 (already enforced by the
-- migration in 0004). This trigger is the data-safety net for concurrent
-- stock writes: any update that would push stock below 0 is rejected.
create or replace function public.products_block_negative_stock()
returns trigger
language plpgsql
as $$
begin
  if new.stock_quantity < 0 then
    raise exception 'Product % stock_quantity would be negative', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists products_block_negative_stock_trigger on public.products;
create trigger products_block_negative_stock_trigger
  before update of stock_quantity on public.products
  for each row execute function public.products_block_negative_stock();

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.stock_movements enable row level security;

drop policy if exists "stock_movements_select_authenticated" on public.stock_movements;
create policy "stock_movements_select_authenticated"
  on public.stock_movements for select
  to authenticated
  using (true);

drop policy if exists "stock_movements_insert_authenticated" on public.stock_movements;
create policy "stock_movements_insert_authenticated"
  on public.stock_movements for insert
  to authenticated
  with check (true);

-- Movements are immutable once written — no update / delete for stock.
drop policy if exists "stock_movements_no_update" on public.stock_movements;
create policy "stock_movements_no_update"
  on public.stock_movements for update
  to authenticated
  using (false);

drop policy if exists "stock_movements_no_delete" on public.stock_movements;
create policy "stock_movements_no_delete"
  on public.stock_movements for delete
  to authenticated
  using (false);

-- (Phase 4+ will wrap the insert + product update in a single RPC so the
-- "movement-then-update" sequencing becomes truly atomic at the database
-- level. Until then the sequence is enforced by the application layer in
-- `applySupabaseAdjustment` and the trigger above catches any drift.)

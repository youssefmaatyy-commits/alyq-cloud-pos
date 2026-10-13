-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0095 — completed-sale cancellation is retired
--
-- A completed invoice is a fact. Once it is paid and stock has left the shelf,
-- the only correct way to undo it is a sales return (`pos_process_return`),
-- which records the refund, the returned units and the reason against the
-- original sale. Cancelling (\"voiding\") a completed sale erased that trail and
-- silently reversed stock, so it is refused here, in the database, for every
-- caller — the till, the invoice page, the online-order workflow and any direct
-- RPC call alike.
--
-- What this migration does and does NOT do:
--
--   · `pos_void_sale` keeps its signature (so old clients get a clear, typed
--     refusal instead of \"function does not exist\") but raises
--     `feature_not_supported` before reading or writing anything. The sale, its
--     lines, its payments and its stock are untouched.
--   · The previous body survives as `pos_void_sale_core_0072` for history only.
--     It is revoked from every API role and no longer reachable from any caller.
--   · Only the refusal is reachable. Anonymous callers get no EXECUTE at all.
--   · Historical voided sales keep `status = 'voided'`, `voided_at`,
--     `void_reason`, the `sale.voided` audit rows and the stock movements that
--     were written when they were voided. Nothing is deleted or rewritten.
--   · Returns (`pos_process_return`), refunds and pre-payment cart clearing are
--     not touched.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.pos_void_sale(
  p_sale_id uuid,
  p_user_id text,
  p_user_name text,
  p_reason text default null,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Refuse first and touch nothing: no lookup that could lock the sale, no
  -- status change, no stock movement, no approval consumed.
  raise exception 'Completed sales cannot be cancelled. Process a sales return instead.'
    using errcode = 'feature_not_supported',
          hint = 'Open the invoice and use Process sales return, so the refund and returned stock are recorded against the sale.';
end;
$$;

-- Signed-in clients keep EXECUTE so that an old till, a stale tab or a direct
-- RPC call receives the typed, explanatory refusal above instead of an opaque
-- "permission denied". Anonymous callers are cut off entirely. The refusal
-- itself writes nothing, so granting execute cannot reopen the cancellation.
revoke all on function public.pos_void_sale(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.pos_void_sale(uuid, text, text, text, uuid) to authenticated, service_role;

-- The previous implementation is kept as history only. It must not be callable
-- by anything that is not the migration owner.
do $$
begin
  if to_regprocedure('public.pos_void_sale_core_0072(uuid,text,text,text)') is not null then
    revoke all on function public.pos_void_sale_core_0072(uuid, text, text, text)
      from public, anon, authenticated, service_role;
    comment on function public.pos_void_sale_core_0072(uuid, text, text, text) is
      'HISTORICAL ONLY (retired by migration 0095). Not reachable from any API role.';
  end if;
end
$$;

comment on function public.pos_void_sale(uuid, text, text, text, uuid) is
  'RETIRED (migration 0095). Completed-sale cancellation is refused for every caller. Use pos_process_return for a sales return. Historical voided rows remain readable.';

commit;

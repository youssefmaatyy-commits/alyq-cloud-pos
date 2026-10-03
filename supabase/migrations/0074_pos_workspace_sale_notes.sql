-- 0074 — POS workspace: authoritative cashier notes
--
-- Notes are optional invoice evidence. They travel through the existing
-- idempotent pos_complete_sale transaction and are frozen on the sale; receipt
-- reprints read the stored value and never reprice or reconstruct it.

begin;

alter table public.sales
  add column if not exists notes text;

alter table public.sales
  drop constraint if exists sales_notes_length;
alter table public.sales
  add constraint sales_notes_length
  check (notes is null or char_length(notes) <= 500);

comment on column public.sales.notes is
  'Optional cashier note frozen with the authoritative sale. At most 500 characters; receipt/detail reads this stored value.';

-- Preserve every pricing, stock, shift, permission, approval and idempotency
-- rule in the current authoritative function. This thin wrapper only freezes
-- the validated note after the core transaction returns its sale id.
do $$
begin
  if to_regprocedure('public.pos_complete_sale_core_0074(jsonb,uuid)') is null then
    alter function public.pos_complete_sale(jsonb,uuid)
      rename to pos_complete_sale_core_0074;
  end if;
end $$;

revoke all on function public.pos_complete_sale_core_0074(jsonb,uuid)
  from public, anon, authenticated;

create or replace function public.pos_complete_sale(
  p_payload jsonb,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_sale_id uuid;
  v_note text := nullif(btrim(coalesce(p_payload->>'notes', '')), '');
  v_existed boolean := false;
begin
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Sale note must be at most 500 characters'
      using errcode = '22001';
  end if;

  -- A retry must return the original immutable invoice without changing its
  -- note. The core remains the authority for identifying and returning it.
  select exists (
    select 1
      from public.sales s
     where s.client_ref = nullif(p_payload->>'client_ref', '')
       and s.branch_id = public.current_branch_id()
  ) into v_existed;

  v_result := public.pos_complete_sale_core_0074(p_payload, p_approval_request_id);
  v_sale_id := nullif(v_result->>'sale_id', '')::uuid;

  if not v_existed and v_sale_id is not null and v_note is not null then
    update public.sales
       set notes = v_note
     where id = v_sale_id
       and branch_id = public.current_branch_id()
       and notes is null;
  end if;

  return v_result;
end;
$$;

comment on function public.pos_complete_sale(jsonb,uuid) is
  'Authoritative idempotent POS completion. Delegates all existing business rules to the 0074 core and freezes an optional <=500 character cashier note only on first creation.';

revoke all on function public.pos_complete_sale(jsonb,uuid)
  from public, anon;
grant execute on function public.pos_complete_sale(jsonb,uuid)
  to authenticated, service_role;

commit;

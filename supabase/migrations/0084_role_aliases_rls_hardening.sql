-- 0084 — Harden role alias reference data with authenticated read-only RLS.

begin;

alter table public.role_aliases enable row level security;

revoke all on public.role_aliases from anon;
revoke insert, update, delete on public.role_aliases from authenticated;
grant select on public.role_aliases to authenticated;

drop policy if exists role_aliases_select_authenticated
  on public.role_aliases;

create policy role_aliases_select_authenticated
  on public.role_aliases
  for select
  to authenticated
  using (true);

commit;

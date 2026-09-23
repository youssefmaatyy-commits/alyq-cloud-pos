-- 0058 — Advanced Import Center is an audit event.
--
-- Phase 57 records that a reviewed file was applied or rolled back. The
-- trail stores the kind, the commit mode and the counts. It does not store
-- the file, customer phones, or catalogue codes. Preview writes nothing.

insert into public.audit_actions (action, entity) values
  ('import.applied', 'system')
on conflict (action) do nothing;

-- 0057 — Operations Center cleanup is an audit event.
--
-- Phase 56 records a confirmed cleanup or retention pass. Preview writes
-- nothing. The vocabulary row is what lets the trail accept the action in
-- live mode. No business table is added: the media registry is not a second
-- database, and backup snapshots stay inside the backup service.

insert into public.audit_actions (action, entity) values
  ('operations.cleanup_executed', 'system'),
  ('operations.retention_applied', 'system')
on conflict (action) do nothing;

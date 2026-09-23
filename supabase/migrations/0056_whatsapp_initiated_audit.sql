-- 0056 — WhatsApp order-update initiation is an audit event, not a delivery log.
--
-- Phase 55 sends customer updates as a wa.me deep link. Opening the link is
-- not delivery and does not change the order. The trail records that a staff
-- member initiated the message (template key, language, order number) so the
-- act is visible. There is no "delivered" action — that would be a claim this
-- installation cannot make.
--
-- Templates themselves live in the existing website_settings document. The
-- settings guard already allows an additional JSON group, so no settings
-- column is added here.

insert into public.audit_actions (action, entity) values
  ('whatsapp.initiated', 'online_order')
on conflict (action) do nothing;

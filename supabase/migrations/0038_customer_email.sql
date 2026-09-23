-- ═══════════════════════════════════════════════════════════════════════════
-- 0038 · customers.email — the optional contact the till already wanted
--
-- WHY
--   The customer record is name + phone (+ address, notes). The storefront
--   captures an email per order (`online_orders.customer_email`) and the till
--   asks for one too — but the customer book itself had no column for it, so a
--   customer's email could never be kept with the customer, only with a single
--   order. The till's quick-add form therefore had nothing to put it in.
--
-- THE CHANGE
--   One nullable column. Nothing else:
--     · optional — no NOT NULL, no default, existing rows untouched;
--     · not unique — a person may share an address book entry, and phone is
--       already the unique business key (`customers_phone_unique`);
--     · length-capped like its siblings (btrim, <= 255, RFC 5321's practical
--       address length) so a paste of a whole paragraph cannot ride in;
--     · empty string is stored as NULL by the client; the check treats it the
--       same as NULL so a blank email is simply "no email".
--
--   No new RLS is needed: the customers table's write policies are
--   `with check (public.can('add_customer'/'edit_customer'))` on the whole
--   row, so the column inherits the same gate automatically. No RPC changes —
--   customer writes are direct (service-asserted + RLS), unlike sales.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.customers
  add column if not exists email text
    check (email is null or char_length(btrim(email)) <= 255);

comment on column public.customers.email is
  'Optional contact email (Phase 27). Nullable and non-unique: phone is the business key. '
  'Blank is stored as NULL; sales keep their own name/phone snapshot and link by id.';

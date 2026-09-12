-- Phase 9 — Advanced customer-facing website (the online storefront).
--
-- What this migration adds, and why each piece is a table rather than a column
-- somewhere else:
--
--   * `website_settings`    one row (id = 1) holding the whole storefront
--                           appearance document: branding, colours, fonts,
--                           button style, hero/section images, homepage section
--                           order + visibility, social links, contact details,
--                           SEO defaults, InstaPay details and delivery options.
--                           It is a *document*, not a relation: every field is
--                           read and written as a unit by one admin screen and
--                           one storefront provider, and adding a knob must not
--                           require a migration. The TypeScript type
--                           (`WebsiteSettings`) is the contract; the column is
--                           jsonb so the two cannot drift on schema.
--   * `store_faqs`          admin-curated FAQ entries for the homepage section.
--   * `store_reviews`       customer testimonials (product_id null) and product
--                           reviews (product_id set), one table because both are
--                           "a rating + a sentence from a customer".
--   * `coupons`             discount codes: percent/fixed, minimum subtotal,
--                           optional cap, usage limit, validity window, and an
--                           optional product/category restriction.
--   * `campaigns`           flash sales and promotions — a discount applied to a
--                           set of products for a window, which is what drives
--                           the "Sale" badge and the campaign price.
--   * `product_content`     1:1 with `products`: brand, slug, per-product SEO
--                           and the specification list. Kept OUT of `products`
--                           so the catalogue table, its import/export and its
--                           RLS stay exactly as they are.
--   * `store_customers`     website accounts (separate from staff `profiles`).
--                           In live mode `id` is the Supabase Auth uid, so there
--                           is no password column here at all — credentials stay
--                           in `auth.users`, and RLS scopes rows to their owner.
--   * `online_orders`       the order aggregate: who, what channel, how much,
--                           and the two independent lifecycles the brief asks
--                           for — order status and payment status.
--   * `online_order_items`  line items, snapshotted (name/sku/price at order
--                           time) exactly like `sale_items`.
--   * `stock_reservations`  inventory protection. A pending order holds stock
--                           without deducting it: `reserved` → `converted`
--                           (approved, becomes a real deduction) or `released`
--                           (cancelled). Available-to-promise is
--                           `stock_quantity − Σ reserved`.
--   * `order_events`        append-only timeline: placed, approved, cancelled,
--                           payment verified… with the acting user and time.
--                           This is what the customer's tracking page renders and
--                           what answers "who approved this and when".
--
-- Two lifecycles, deliberately separate columns:
--   order status    pending → approved → processing → ready → completed
--                   (or cancelled from any unfinished state)
--   payment status  pending → paid | failed | verification_required
-- An order can be approved while its payment is still being verified (cash on
-- delivery), and a payment can be verified while the order is still pending.
-- Conflating them is what makes "paid but not shipped" unrepresentable.
--
-- Money note: `payment_method` reuses the POS enum so an approved order becomes
-- a sale without translation. 'cod' (cash on delivery) is added to that enum
-- HERE but not referenced until 0018 — PostgreSQL allows adding an enum value
-- inside a transaction, but not *using* it in the same one, and the migration
-- check applies each file in its own transaction.

-- ── enums ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'online_order_status') then
    create type public.online_order_status as enum
      ('pending', 'approved', 'processing', 'ready', 'completed', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'online_payment_status') then
    create type public.online_payment_status as enum
      ('pending', 'paid', 'failed', 'verification_required');
  end if;

  if not exists (select 1 from pg_type where typname = 'delivery_type') then
    create type public.delivery_type as enum ('delivery', 'pickup');
  end if;

  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type public.reservation_status as enum ('reserved', 'released', 'converted');
  end if;

  if not exists (select 1 from pg_type where typname = 'coupon_target') then
    create type public.coupon_target as enum ('all', 'products', 'categories');
  end if;

  if not exists (select 1 from pg_type where typname = 'campaign_kind') then
    create type public.campaign_kind as enum ('flash_sale', 'promotion');
  end if;

  if not exists (select 1 from pg_type where typname = 'order_event_kind') then
    create type public.order_event_kind as enum
      ('placed', 'approved', 'processing', 'ready', 'completed', 'cancelled',
       'payment_submitted', 'payment_approved', 'payment_rejected', 'note');
  end if;
end
$$;

-- Cash on delivery: online-only, and never "paid" at creation. Not referenced
-- anywhere in this file — see the header note.
alter type public.payment_method add value if not exists 'cod';

-- ── numbering ─────────────────────────────────────────────────────────────
-- Sequences, matching shifts/expenses: two customers checking out at the same
-- moment cannot collide, and the format matches the demo repository exactly.
create sequence if not exists public.online_order_number_seq as bigint start 1;

create or replace function public.next_online_order_number()
returns text
language sql
volatile
as $$
  select 'WEB-' || lpad(nextval('public.online_order_number_seq')::text, 6, '0')
$$;

comment on function public.next_online_order_number() is
  'Allocates the next online order number (WEB-000001). Same format as the demo repository.';

-- ── website settings (singleton document) ─────────────────────────────────
create table if not exists public.website_settings (
  id              smallint primary key default 1 check (id = 1),
  settings        jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  updated_by_name text,

  constraint website_settings_json_is_object check (jsonb_typeof(settings) = 'object')
);

comment on table public.website_settings is
  'Singleton storefront appearance/behaviour document. Read publicly (the storefront renders from it), written only by manage_website. An empty object means "use the application defaults".';

-- The row must exist so the storefront always has something to read; the app
-- merges it over its own defaults, so `{}` is a valid, meaningful seed.
insert into public.website_settings (id, settings)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- ── faqs ──────────────────────────────────────────────────────────────────
create table if not exists public.store_faqs (
  id           uuid primary key default gen_random_uuid(),
  question_ar  text not null,
  question_en  text not null,
  answer_ar    text not null,
  answer_en    text not null,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint store_faqs_question_not_blank check (btrim(question_en) <> '' or btrim(question_ar) <> ''),
  constraint store_faqs_answer_not_blank   check (btrim(answer_en) <> '' or btrim(answer_ar) <> '')
);

create index if not exists store_faqs_active_order_idx
  on public.store_faqs (active, sort_order);

-- ── reviews + testimonials ────────────────────────────────────────────────
create table if not exists public.store_reviews (
  id          uuid primary key default gen_random_uuid(),
  -- null → a homepage testimonial; set → a review of that product.
  product_id  uuid references public.products (id) on delete cascade,
  author_name text not null,
  rating      integer not null check (rating between 1 and 5),
  body        text not null default '',
  visible     boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),

  constraint store_reviews_author_not_blank check (btrim(author_name) <> '')
);

create index if not exists store_reviews_product_idx
  on public.store_reviews (product_id, visible, sort_order);

-- ── coupons ───────────────────────────────────────────────────────────────
create table if not exists public.coupons (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  discount_type public.discount_type not null default 'percent'
                  check (discount_type in ('percent', 'fixed')),
  value         numeric(14, 2) not null check (value > 0),
  min_subtotal  numeric(14, 2) not null default 0 check (min_subtotal >= 0),
  -- Optional cap, percent coupons only: `null` means uncapped.
  max_discount  numeric(14, 2) check (max_discount is null or max_discount > 0),
  usage_limit   integer check (usage_limit is null or usage_limit > 0),
  used_count    integer not null default 0 check (used_count >= 0),
  applies_to    public.coupon_target not null default 'all',
  target_ids    jsonb not null default '[]'::jsonb,
  active        boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint coupons_code_uppercase check (code = upper(btrim(code)) and btrim(code) <> ''),
  constraint coupons_window_ordered check (starts_at is null or ends_at is null or starts_at <= ends_at),
  constraint coupons_percent_at_most_100
    check (discount_type <> 'percent' or value <= 100),
  constraint coupons_used_within_limit
    check (usage_limit is null or used_count <= usage_limit),
  constraint coupons_targets_is_array check (jsonb_typeof(target_ids) = 'array')
);

comment on table public.coupons is
  'Discount codes for the storefront. `used_count` is incremented when an order is PLACED and decremented again if that order is cancelled, so one customer cannot hold the last use of a code across several pending orders.';

-- ── campaigns (flash sales / promotions) ──────────────────────────────────
create table if not exists public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  name_ar        text not null default '',
  name_en        text not null default '',
  kind           public.campaign_kind not null default 'flash_sale',
  discount_type  public.discount_type not null default 'percent'
                   check (discount_type in ('percent', 'fixed')),
  discount_value numeric(14, 2) not null check (discount_value > 0),
  product_ids    jsonb not null default '[]'::jsonb,
  badge_ar       text,
  badge_en       text,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint campaigns_window_ordered check (starts_at <= ends_at),
  constraint campaigns_percent_at_most_100
    check (discount_type <> 'percent' or discount_value <= 100),
  constraint campaigns_products_is_array check (jsonb_typeof(product_ids) = 'array')
);

create index if not exists campaigns_active_window_idx
  on public.campaigns (active, starts_at, ends_at);

-- ── per-product content: brand, slug, SEO, specifications ─────────────────
create table if not exists public.product_content (
  product_id      uuid primary key references public.products (id) on delete cascade,
  brand_ar        text,
  brand_en        text,
  slug            text unique,
  seo_title       text,
  seo_description text,
  -- [{ "label_ar", "label_en", "value_ar", "value_en" }] in display order.
  specs           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint product_content_slug_shape
    check (slug is null or slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint product_content_seo_description_length
    check (seo_description is null or char_length(seo_description) <= 320),
  constraint product_content_specs_is_array check (jsonb_typeof(specs) = 'array')
);

comment on table public.product_content is
  'Storefront-only product extras (brand, slug, SEO, specifications). Deliberately separate from `products` so the catalogue, its Excel import/export and its policies are untouched.';

-- ── website customer accounts ─────────────────────────────────────────────
create table if not exists public.store_customers (
  id            uuid primary key,
  name          text not null,
  email         text unique,
  phone         text not null,
  -- [{ id, label, full_name, phone, city, area, street, building, floor,
  --    apartment, is_default, notes }]
  addresses     jsonb not null default '[]'::jsonb,
  -- product ids the customer favourited.
  wishlist      jsonb not null default '[]'::jsonb,
  notes         text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,

  constraint store_customers_name_not_blank check (btrim(name) <> ''),
  constraint store_customers_phone_not_blank check (btrim(phone) <> ''),
  constraint store_customers_addresses_is_array check (jsonb_typeof(addresses) = 'array'),
  constraint store_customers_wishlist_is_array check (jsonb_typeof(wishlist) = 'array')
);

comment on table public.store_customers is
  'Website accounts. In live mode `id` is the Supabase Auth uid: no password is stored here, credentials live in auth.users and RLS scopes each row to its owner. Demo mode keeps its own digest in localStorage only.';

-- ── online orders ─────────────────────────────────────────────────────────
create table if not exists public.online_orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique default public.next_online_order_number(),
  -- Client-generated idempotency key, exactly like `sales.client_ref`: a double
  -- tap on "Place order" or a retried request must not create a second order
  -- (and therefore must not reserve the stock twice).
  client_ref           text not null unique,

  -- Customer: an account id when signed in, otherwise guest details.
  store_customer_id    uuid references public.store_customers (id) on delete set null,
  customer_name        text not null,
  customer_phone       text not null,
  customer_email       text,

  delivery_type        public.delivery_type not null default 'delivery',
  -- The chosen delivery address (or the pickup point), as the customer wrote it.
  address              jsonb not null default '{}'::jsonb,

  subtotal             numeric(14, 2) not null check (subtotal >= 0),
  discount_code        text,
  discount_amount      numeric(14, 2) not null default 0 check (discount_amount >= 0),
  delivery_fee         numeric(14, 2) not null default 0 check (delivery_fee >= 0),
  total                numeric(14, 2) not null check (total >= 0),

  payment_method       public.payment_method not null,
  payment_status       public.online_payment_status not null default 'pending',
  status               public.online_order_status not null default 'pending',

  -- InstaPay proof, submitted by the customer and verified by staff.
  payment_reference    text,
  payment_proof_url    text,
  payment_submitted_at timestamptz,
  payment_verified_by     uuid,
  payment_verified_by_name text,
  payment_verified_at     timestamptz,
  payment_rejected_reason text,

  -- Set once the order is approved and a POS sale exists. This is the link that
  -- makes an online order visible inside the POS as a real sale.
  sale_id              uuid references public.sales (id) on delete set null,
  sale_number          text,

  notes                text,
  cancellation_reason  text,
  approved_by          uuid,
  approved_by_name     text,
  approved_at          timestamptz,
  cancelled_by         uuid,
  cancelled_by_name    text,
  cancelled_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint online_orders_customer_not_blank check (btrim(customer_name) <> ''),
  constraint online_orders_phone_not_blank    check (btrim(customer_phone) <> ''),
  constraint online_orders_total_is_net_of_discount
    check (total = subtotal - discount_amount + delivery_fee),
  constraint online_orders_discount_at_most_subtotal
    check (discount_amount <= subtotal),
  constraint online_orders_address_is_object check (jsonb_typeof(address) = 'object'),
  -- A cancelled order keeps its record (the brief requires it) but must carry a
  -- reason, and must never be linked to a sale: cancelling releases the stock.
  constraint online_orders_cancelled_has_reason
    check (status <> 'cancelled' or btrim(coalesce(cancellation_reason, '')) <> ''),
  constraint online_orders_cancelled_has_no_sale
    check (status <> 'cancelled' or sale_id is null),
  -- An approved-or-later order is the one that created a sale.
  constraint online_orders_sale_requires_approval
    check (sale_id is null or status in ('approved', 'processing', 'ready', 'completed')),
  -- NOTE: the "paid requires a human verification" rule lives in 0018, not
  -- here. It has to mention 'cod', and PostgreSQL refuses to *use* an enum
  -- value in the same transaction that adds it — so the value is added here and
  -- the constraint that refers to it is added by the next migration.
  constraint online_orders_paid_requires_verifier
    check (payment_status <> 'paid' or payment_verified_at is not null)
);

create index if not exists online_orders_status_created_idx
  on public.online_orders (status, created_at desc);
create index if not exists online_orders_payment_status_idx
  on public.online_orders (payment_status);
create index if not exists online_orders_customer_idx
  on public.online_orders (store_customer_id, created_at desc);
create index if not exists online_orders_sale_idx
  on public.online_orders (sale_id);

comment on table public.online_orders is
  'Orders placed on the website. Two independent lifecycles (order status, payment status). Approval converts stock reservations into a POS sale and stamps sale_id/sale_number; cancellation releases them and keeps the record with a reason.';

-- ── order line items ──────────────────────────────────────────────────────
create table if not exists public.online_order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.online_orders (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete restrict,
  name_ar     text not null,
  name_en     text not null,
  sku         text not null,
  barcode     text,
  unit_price  numeric(14, 2) not null check (unit_price >= 0),
  quantity    integer not null check (quantity > 0),
  line_total  numeric(14, 2) not null check (line_total >= 0),

  constraint online_order_items_line_total_matches
    check (line_total = round(unit_price * quantity, 2))
);

create index if not exists online_order_items_order_idx
  on public.online_order_items (order_id);
create index if not exists online_order_items_product_idx
  on public.online_order_items (product_id);

comment on table public.online_order_items is
  'Snapshot of what was ordered (name/sku/price at order time), like sale_items. `on delete restrict` on product_id: an order must not lose its line items.';

-- ── stock reservations (inventory protection) ─────────────────────────────
create table if not exists public.stock_reservations (
  id              uuid primary key default gen_random_uuid(),
  online_order_id uuid not null references public.online_orders (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete restrict,
  quantity        integer not null check (quantity > 0),
  status          public.reservation_status not null default 'reserved',
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,

  constraint stock_reservations_resolved_has_timestamp
    check (status = 'reserved' or resolved_at is not null)
);

-- The one index that matters: available-to-promise is
-- `stock_quantity − Σ quantity WHERE status = 'reserved'`.
create index if not exists stock_reservations_open_idx
  on public.stock_reservations (product_id)
  where status = 'reserved';
create index if not exists stock_reservations_order_idx
  on public.stock_reservations (online_order_id);

comment on table public.stock_reservations is
  'Holds stock for a pending online order without deducting it. approved → converted (the deduction happens through the POS sale); cancelled → released. Prevents overselling between checkout and approval.';

/** Live reservations per product — the number to subtract from stock. */
create or replace function public.reserved_quantity(p_product_id uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(quantity), 0)::integer
  from public.stock_reservations
  where product_id = p_product_id
    and status = 'reserved'
$$;

comment on function public.reserved_quantity(uuid) is
  'Units of a product currently reserved by pending online orders. Available to promise = stock_quantity − reserved_quantity().';

-- ── order timeline ────────────────────────────────────────────────────────
create table if not exists public.order_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.online_orders (id) on delete cascade,
  kind       public.order_event_kind not null,
  note       text,
  user_id    uuid,
  user_name  text,
  created_at timestamptz not null default now()
);

create index if not exists order_events_order_idx
  on public.order_events (order_id, created_at);

comment on table public.order_events is
  'Append-only order timeline: what happened, who did it, when. Rendered to the customer as tracking history and to staff as the audit of the workflow.';

-- ── sales: where did this sale come from? ─────────────────────────────────
-- Additive and defaulted, so every existing POS sale keeps working unchanged.
alter table public.sales
  add column if not exists source text not null default 'pos'
    check (source in ('pos', 'online'));

comment on column public.sales.source is
  'pos = rung up at the till (every sale before Phase 9), online = created by approving a website order.';

create index if not exists sales_source_idx on public.sales (source);

-- ── vocabulary: capabilities ──────────────────────────────────────────────
-- Mirrors ROLE_CAPABILITIES in src/lib/permissions/roles.ts; the migration
-- check diffs the two row for row.
--   manage_online_orders  the Online Orders screen: approve, cancel, move
--                         through processing/ready/completed. Granted to every
--                         role that may already sell, because approving an order
--                         creates a sale and deducts stock.
--   manage_website        the storefront itself: appearance, sections, social
--                         links, SEO, InstaPay details, coupons, campaigns,
--                         FAQs and reviews. Admin + manager only — it is the
--                         shop''s public face, not a till operation.
-- Payment verification deliberately REUSES the existing `confirm_payment`
-- capability: confirming an InstaPay transfer against a website order is the
-- same judgement as confirming one at the till, and a second capability would
-- let the two drift.
insert into public.role_capabilities (role, capability) values
  ('admin',           'manage_online_orders'),
  ('manager',         'manage_online_orders'),
  ('cashier',         'manage_online_orders'),
  ('inventory_clerk', 'manage_online_orders'),
  ('admin',           'manage_website'),
  ('manager',         'manage_website')
on conflict (role, capability) do nothing;

-- ── vocabulary: audit actions ─────────────────────────────────────────────
-- Mirrors AUDIT_ACTIONS / AUDIT_ENTITIES in src/modules/audit/types.ts.
insert into public.audit_actions (action, entity) values
  ('online_order.approved',        'online_order'),
  ('online_order.cancelled',       'online_order'),
  ('online_order.payment_approved', 'online_order'),
  ('online_order.payment_rejected', 'online_order'),
  ('website_settings.updated',     'website_settings')
on conflict (action) do nothing;

-- ── row level security ────────────────────────────────────────────────────
-- Staff side: gated on the two new capabilities through public.can().
-- Customer side: guests are `anon`, and an anon role cannot be given row-level
-- identity, so the public paths go through security-definer functions instead
-- of table policies (see 0018). No direct anon access to orders is granted
-- here on purpose — otherwise anyone could read anyone''s order by guessing an
-- order number.

alter table public.website_settings    enable row level security;
alter table public.store_faqs          enable row level security;
alter table public.store_reviews       enable row level security;
alter table public.coupons             enable row level security;
alter table public.campaigns           enable row level security;
alter table public.product_content     enable row level security;
alter table public.store_customers     enable row level security;
alter table public.online_orders       enable row level security;
alter table public.online_order_items  enable row level security;
alter table public.stock_reservations  enable row level security;
alter table public.order_events        enable row level security;

-- The storefront must be able to read the shop''s appearance and public content
-- before anyone signs in.
drop policy if exists "website_settings_select_public" on public.website_settings;
create policy "website_settings_select_public"
  on public.website_settings for select to anon, authenticated
  using (true);

drop policy if exists "website_settings_write_managers" on public.website_settings;
create policy "website_settings_write_managers"
  on public.website_settings for update to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "website_settings_insert_managers" on public.website_settings;
create policy "website_settings_insert_managers"
  on public.website_settings for insert to authenticated
  with check (public.can('manage_website'));

drop policy if exists "website_settings_no_delete" on public.website_settings;
create policy "website_settings_no_delete"
  on public.website_settings for delete to authenticated using (false);

drop policy if exists "store_faqs_select_public" on public.store_faqs;
create policy "store_faqs_select_public"
  on public.store_faqs for select to anon, authenticated
  using (true);

drop policy if exists "store_faqs_write_managers" on public.store_faqs;
create policy "store_faqs_write_managers"
  on public.store_faqs for all to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "store_reviews_select_public" on public.store_reviews;
create policy "store_reviews_select_public"
  on public.store_reviews for select to anon, authenticated
  using (true);

drop policy if exists "store_reviews_write_managers" on public.store_reviews;
create policy "store_reviews_write_managers"
  on public.store_reviews for all to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

-- Coupons and campaigns are readable by signed-in staff (the Online Orders
-- screen shows which code an order used) and by the storefront, which needs to
-- validate a code at checkout. Only manage_website may change them.
drop policy if exists "coupons_select_public" on public.coupons;
create policy "coupons_select_public"
  on public.coupons for select to anon, authenticated
  using (true);

drop policy if exists "coupons_write_managers" on public.coupons;
create policy "coupons_write_managers"
  on public.coupons for all to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "campaigns_select_public" on public.campaigns;
create policy "campaigns_select_public"
  on public.campaigns for select to anon, authenticated
  using (true);

drop policy if exists "campaigns_write_managers" on public.campaigns;
create policy "campaigns_write_managers"
  on public.campaigns for all to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "product_content_select_public" on public.product_content;
create policy "product_content_select_public"
  on public.product_content for select to anon, authenticated
  using (true);

drop policy if exists "product_content_write_managers" on public.product_content;
create policy "product_content_write_managers"
  on public.product_content for all to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

-- Accounts: you read and write your own row. Staff with the audit capability may
-- read them (support: "which account placed this order?"). No password column
-- exists, so there is nothing sensitive to leak beyond contact details.
drop policy if exists "store_customers_select_self_or_staff" on public.store_customers;
create policy "store_customers_select_self_or_staff"
  on public.store_customers for select to authenticated
  using (id = auth.uid() or public.can('view_audit_log'));

drop policy if exists "store_customers_insert_self" on public.store_customers;
create policy "store_customers_insert_self"
  on public.store_customers for insert to authenticated
  with check (id = auth.uid());

drop policy if exists "store_customers_update_self" on public.store_customers;
create policy "store_customers_update_self"
  on public.store_customers for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "store_customers_no_delete" on public.store_customers;
create policy "store_customers_no_delete"
  on public.store_customers for delete to authenticated using (false);

-- Orders: staff who manage online orders read and update them; nothing is ever
-- deleted (a cancelled order keeps its record). Customers reach their own
-- orders through the lookup function in 0018, not through this policy.
drop policy if exists "online_orders_select_staff" on public.online_orders;
create policy "online_orders_select_staff"
  on public.online_orders for select to authenticated
  using (public.can('manage_online_orders') or public.can('view_audit_log'));

drop policy if exists "online_orders_update_staff" on public.online_orders;
create policy "online_orders_update_staff"
  on public.online_orders for update to authenticated
  using (public.can('manage_online_orders'))
  with check (public.can('manage_online_orders'));

drop policy if exists "online_orders_no_direct_insert" on public.online_orders;
create policy "online_orders_no_direct_insert"
  on public.online_orders for insert to authenticated with check (false);

drop policy if exists "online_orders_no_delete" on public.online_orders;
create policy "online_orders_no_delete"
  on public.online_orders for delete to authenticated using (false);

drop policy if exists "online_order_items_select_staff" on public.online_order_items;
create policy "online_order_items_select_staff"
  on public.online_order_items for select to authenticated
  using (public.can('manage_online_orders') or public.can('view_audit_log'));

-- Items, reservations and events are written by the order functions only.
drop policy if exists "online_order_items_no_direct_write" on public.online_order_items;
create policy "online_order_items_no_direct_write"
  on public.online_order_items for insert to authenticated with check (false);

drop policy if exists "online_order_items_no_delete" on public.online_order_items;
create policy "online_order_items_no_delete"
  on public.online_order_items for delete to authenticated using (false);

drop policy if exists "stock_reservations_select_staff" on public.stock_reservations;
create policy "stock_reservations_select_staff"
  on public.stock_reservations for select to authenticated
  using (public.can('manage_online_orders') or public.can('view_inventory'));

drop policy if exists "stock_reservations_no_direct_write" on public.stock_reservations;
create policy "stock_reservations_no_direct_write"
  on public.stock_reservations for insert to authenticated with check (false);

drop policy if exists "stock_reservations_no_delete" on public.stock_reservations;
create policy "stock_reservations_no_delete"
  on public.stock_reservations for delete to authenticated using (false);

drop policy if exists "order_events_select_staff" on public.order_events;
create policy "order_events_select_staff"
  on public.order_events for select to authenticated
  using (public.can('manage_online_orders') or public.can('view_audit_log'));

drop policy if exists "order_events_no_direct_write" on public.order_events;
create policy "order_events_no_direct_write"
  on public.order_events for insert to authenticated with check (false);

drop policy if exists "order_events_no_update" on public.order_events;
create policy "order_events_no_update"
  on public.order_events for update to authenticated using (false);

drop policy if exists "order_events_no_delete" on public.order_events;
create policy "order_events_no_delete"
  on public.order_events for delete to authenticated using (false);

-- ── updated_at triggers ───────────────────────────────────────────────────
-- The catalogue already has one; these tables are edited from the admin panel
-- and "last updated" is shown next to the save button.
do $$
declare
  t text;
begin
  foreach t in array array[
    'website_settings', 'store_faqs', 'store_reviews', 'coupons',
    'campaigns', 'product_content', 'online_orders'
  ]
  loop
    execute format(
      'create or replace function public.touch_%s_updated_at()
         returns trigger language plpgsql as $fn$
         begin
           new.updated_at := now();
           return new;
         end
         $fn$;',
      t
    );
    execute format(
      'drop trigger if exists %s_touch_updated_at on public.%I;',
      t, t
    );
    execute format(
      'create trigger %s_touch_updated_at
         before update on public.%I
         for each row execute function public.touch_%s_updated_at();',
      t, t, t
    );
  end loop;
end
$$;

# ALYQ Cloud POS — Database

Schema as built by `supabase/migrations/`. Check it with `npm run db:check`,
which applies every file in order, twice, and then asserts the result
satisfies what the application code queries.

> **Corrected 2026-09.** Migrations 0007, 0009 and 0010 contained six
> `for insert … using (false)` policies, which PostgreSQL rejects outright
> (INSERT policies take `WITH CHECK`), and 0007 had an unescaped `%` inside a
> `raise exception` format string. 0010 also typed its refund-status columns
> as `payment_status` while defaulting them to `'completed'`, a value that
> enum does not have. The chain could not be applied anywhere, which is why
> nobody had noticed. All four are fixed, and `npm run db:check` now fails on
> anything of the kind.

## Files

| Migration | Purpose |
| --- | --- |
| `0001_create_categories.sql` | `categories` table, `set_updated_at()`, cycle guard, delete-in-use guard, indexes |
| `0002_create_products.sql` | `product_type` enum, `products` table, unique SKU/barcode indexes, trigram search index, audit columns |
| `0003_rls_policies_and_seed.sql` | RLS policies, `set_audit_columns()`, `category_tree_view`, optional demo seed |
| `0004_product_stock_and_storefront.sql` | `stock_quantity`, `low_stock_level`, `show_on_website`, `is_featured`, `images` gallery |
| `0005_product_images_storage.sql` | `product-images` public storage bucket + RLS policies for uploads |
| `0006_inventory_stock_movements.sql` | `stock_movements` ledger (immutable, append-only), `stock_movement_type` / `stock_reason` enums, negative-stock guard trigger, RLS |
| `0007_pos_sales.sql` | `sales` + `sale_items` snapshots, atomic `pos_complete_sale` / `pos_void_sale` RPCs, sale numbering, payment + discount constraints |
| `0008_instapay_confirmation.sql` | InstaPay confirmation audit columns + transactional `pos_confirm_payment` RPC |
| `0009_split_payments.sql` | `sale_payments` table, payment-aware completion/confirmation RPCs |
| `0010_customers_returns_refunds.sql` | `customers`, `sales_returns` + `return_items`, `refund_records`, counters, sales customer linkage, transactional `pos_process_return` RPC |

## Column reference — `products`

`id, sku, barcode, name_ar, name_en, description_ar, description_en, category_id,
product_type, selling_price, cost_price, tax_rate, stock_tracking_enabled,
stock_quantity, low_stock_level, show_on_website, is_featured, active,
image_url, images, created_at, updated_at` (+ `created_by`, `updated_by`).

## Column reference — `categories`

`id, name_ar, name_en, parent_id, active, sort_order, created_at, updated_at`.

## Rules enforced by the database

1. **Bilingual names required** — `name_ar` / `name_en` are `NOT NULL` and 1–120 chars.
2. **SKU unique** — unique index on `lower(btrim(sku))` (case/whitespace safe).
3. **Barcode unique when provided** — *partial* unique index `WHERE barcode IS NOT NULL AND btrim(barcode) <> ''`.
4. **Prices** — `selling_price >= 0`, `cost_price >= 0`, `tax_rate BETWEEN 0 AND 100`.
5. **Category integrity** — `category_id` is required and `ON DELETE RESTRICT`.
6. **No category cycles** — `categories_block_cycle()` trigger.
7. **No deleting categories that contain products** — `categories_block_delete_in_use()` raises `SQLSTATE 23503`, so the client can map it to “deactivate instead”.
8. **Stock + thresholds** — `stock_quantity >= 0`, `low_stock_level >= 0`, gallery `images` bounded to 5 entries (cover lives in `image_url`).
9. **Product images (Storage)** — files are uploaded by the admin to the public `product-images` bucket; the database stores the resulting public URL as `image_url` (cover) and `images` (gallery). Uploads are capped at 5 MB and restricted to image MIME types.

## Apply

```bash
npm run db:check    # sanity-check locally first — no server or Docker needed

supabase link --project-ref <ref>
supabase db push
```

See [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) for the `psql` and SQL
editor routes, and for what to verify before releasing.

## Conventions

Every migration must be safe to run twice — the repository is applied on every
CI run, and re-applying to an existing project must be a no-op:

| Rule | How |
| --- | --- |
| Objects are created defensively | `create table if not exists`, `do $$ … if not exists (select 1 from pg_type …) $$`, `create index if not exists` |
| Functions are replaced | `create or replace function` |
| Triggers and policies are dropped first | `drop trigger if exists` / `drop policy if exists` before `create` |
| Seeds do not duplicate | `where not exists (…)` guards, `on conflict do nothing` |
| INSERT policies use `WITH CHECK` | `for insert … with check (false)`; `USING` is a syntax error for INSERT |
| `%` in `raise` messages is escaped | `raise exception 'Discount above 100%%'` — a lone `%` is a format placeholder and stops the file compiling |
| Enum-valued defaults are real labels | a column typed as `public.payment_status` may only default to `'paid'` or `'pending'` |
| New enum values are used in a later file | PostgreSQL will not use a label added in the same transaction |
| RLS is enabled on every application table | plus `select` policies for `authenticated` and a deny-all write policy where the only writer is an RPC |

Table names and RPC names used by the application are read straight out of
`src/**` by the check script, so a repository that queries a table no migration
creates fails CI by name.

## Planned migrations

The production-readiness workstream adds, in order (see
[`docs/PRODUCTION_READINESS_PLAN.md`](../../docs/PRODUCTION_READINESS_PLAN.md)):

| Migration | Purpose |
| --- | --- |
| `0011_profiles_and_auth` | `app_role` enum, `profiles`, role helpers, admin role management RPC |
| `0012_shifts` | cashier shift sessions and their RPCs |
| `0013_expenses` | expense ledger and its RPCs |
| `0014_audit_log` | append-only audit trail plus the triggers that write it |
| `0015_payment_methods_visa` | card payment method for the register |
| `0016_refund_settlement` | `refund_records` settlement columns and RPC |

`scripts/migrations.check.mjs` lists these as *pending* — it reports them
without failing, and fails if an entry becomes stale, so the list cannot be
forgotten once the migrations land.

## Environment variables

Copy `.env.example` to `.env`; see [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)
§2. When the Supabase values are absent the app runs in **demo mode** (data in
`localStorage`) — no code changes needed, and never for real money.

## Who may write what

Every application table has RLS enabled. Reads are granted to `authenticated`
and writes are denied outright (`with check (false)`), so a browser cannot
insert a sale, move stock or record a refund by talking to PostgREST directly.
The only writers are the `security definer` RPCs, which run as the table owner:

| RPC | Writes |
| --- | --- |
| `pos_complete_sale(jsonb)` | `sales`, `sale_items`, `sale_payments`, `stock_movements`, product stock |
| `pos_confirm_payment(jsonb)` | `sale_payments`, `sales.payment_status` |
| `pos_void_sale(...)` | `sales.status`, restores stock via `stock_movements` |
| `pos_process_return(jsonb)` | `sales_returns`, `return_items`, `refund_records`, restores stock via `stock_movements` |

Each RPC is granted to `authenticated` and validates its own input — totals are
recalculated from catalog prices, stock is re-checked, and a return cannot
exceed what is left returnable on the sale. The client never supplies a total
that the server trusts.

`stock_movements` is append-only by construction: no update or delete policy
exists, so the ledger cannot be rewritten.

## Still missing (scheduled)

Recorded here so the gap is explicit rather than implied: `profiles`, `shifts`,
`expenses` and `audit_log` are queried by the application today and have no
migration yet — the six files in *Planned migrations* above create them. Until
then, live mode cannot authenticate a user or record a shift.

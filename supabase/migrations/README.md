# ALYQ Cloud POS — Database (Phase 2: Products & Categories)

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
# Option A — CLI
supabase link --project-ref <ref>
supabase db push

# Option B — SQL editor
# Paste the five files in numeric order into the Supabase SQL editor and run.
```

## Environment variables

Create `.env.local` in the project root:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_CURRENCY=SAR        # optional, default SAR
```

When these are absent the app automatically runs in **demo mode**
(in-memory data persisted to `localStorage`) — no code changes needed.

## Deliberately out of scope (Phase 4+)

Batches, serials, expiry tracking, supplier cost layers, valuations, POS
checkouts, sales write-backs, website orders, deliveries, discounts, promo
codes, WhatsApp, reports, etc. remain future work.

Phase 3 introduces the immutable `stock_movements` ledger (insert only — no
update / delete via RLS), the `stock_movement_type` and `stock_reason` enums,
and a trigger that rejects any `products.stock_quantity` going below zero.
Every quantity change must come through `applySupabaseAdjustment`, which
records a movement first and then updates the product row. The eventual
Phase 4 RPC will wrap the two writes in a single transaction; until then
the sequence is enforced by the application layer.

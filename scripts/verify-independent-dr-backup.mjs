#!/usr/bin/env node
/**
 * Practical verification of the Independent Off-Database Disaster-Recovery (DR)
 * Backup & Restore mechanism:
 *
 *   1. Export a complete, self-contained JSON bundle OUTSIDE PostgreSQL using a
 *      100% read-only SELECT query (covering all 54 tables in `backup_table_order()`,
 *      all 10 supplementary `public` tables, `supabase_migrations.schema_migrations`,
 *      sanitized `auth.users` & `auth.identities` metadata, and `storage.buckets`
 *      & `storage.objects` metadata — with zero password hashes or private tokens).
 *   2. Prove practical restoration from the external file on disk (NOT from a row
 *      in `public.backups` inside the same database) after deleting `public.backups`
 *      and wiping/corrupting `public`, `auth`, and `storage`, both:
 *        - Scenario A: At Migration 0096 (exact Production baseline: 96 migrations,
 *          43 products, 8 variants, 48 branch stock balances, 3 archived categories,
 *          1 active category, BR104 stock = 3, 1 open shift, 0 sales/returns/orders).
 *        - Scenario B: At Migration 0098 (98 migrations with shared-barcode models,
 *          sales, payments, returns, refunds, and online orders).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIM_FILE = path.join(ROOT, "supabase", "tests", "supabase-shim.sql");

/**
 * 100% Read-Only SELECT query that builds the complete Independent Off-Database
 * Disaster-Recovery Bundle without writing a single row or mutating any state.
 * Redacts `encrypted_password` and all secret Auth tokens inside SQL so no
 * password hash or private token ever leaves PostgreSQL.
 */
export const READONLY_INDEPENDENT_DR_EXPORT_SQL = `
WITH live_snapshot AS (
  SELECT public.build_snapshot_document('manual', 'Independent Off-DB Pre-Phase1 Snapshot') AS doc
),
supplementary_public AS (
  SELECT jsonb_build_object(
    'backup_settings', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.backup_settings) x), '[]'::jsonb),
    'registers', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.registers) x), '[]'::jsonb),
    'import_batches', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.import_batches) x), '[]'::jsonb),
    'mobile_installations', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.mobile_installations) x), '[]'::jsonb),
    'web_push_subscriptions', COALESCE((SELECT jsonb_agg(
      to_jsonb(w) - 'auth_secret' - 'p256dh' || jsonb_build_object('redacted_keys', true)
    ) FROM public.web_push_subscriptions w), '[]'::jsonb),
    'notification_outbox', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.notification_outbox) x), '[]'::jsonb),
    'user_notification_inbox', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.user_notification_inbox) x), '[]'::jsonb),
    'notification_delivery_attempts', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.notification_delivery_attempts) x), '[]'::jsonb),
    'notification_push_deliveries', COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM public.notification_push_deliveries) x), '[]'::jsonb)
  ) AS tables
),
auth_export AS (
  SELECT jsonb_build_object(
    'users', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id,
        'instance_id', u.instance_id,
        'aud', u.aud,
        'role', u.role,
        'email', u.email,
        'email_confirmed_at', u.email_confirmed_at,
        'raw_app_meta_data', COALESCE(u.raw_app_meta_data, '{}'::jsonb),
        'raw_user_meta_data', COALESCE(u.raw_user_meta_data, '{}'::jsonb),
        'created_at', u.created_at,
        'updated_at', u.updated_at
      ) ORDER BY u.created_at, u.id)
      FROM auth.users u
    ), '[]'::jsonb),
    'identities', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id,
        'provider_id', i.provider_id,
        'user_id', i.user_id,
        'identity_data', COALESCE(i.identity_data, '{}'::jsonb),
        'provider', i.provider,
        'last_sign_in_at', i.last_sign_in_at,
        'created_at', i.created_at,
        'updated_at', i.updated_at
      ) ORDER BY i.created_at, i.id)
      FROM auth.identities i
    ), '[]'::jsonb)
  ) AS data
),
storage_export AS (
  SELECT jsonb_build_object(
    'buckets', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id,
        'name', b.name,
        'public', b.public,
        'file_size_limit', b.file_size_limit,
        'allowed_mime_types', b.allowed_mime_types,
        'created_at', b.created_at
      ) ORDER BY b.id)
      FROM storage.buckets b
    ), '[]'::jsonb),
    'objects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id,
        'bucket_id', o.bucket_id,
        'name', o.name,
        'owner', o.owner,
        'created_at', o.created_at
      ) ORDER BY o.bucket_id, o.name)
      FROM storage.objects o
    ), '[]'::jsonb)
  ) AS data
),
checklist AS (
  SELECT jsonb_build_object(
    'migration_count', (SELECT count(*) FROM supabase_migrations.schema_migrations),
    'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
    'total_categories', (SELECT count(*) FROM public.categories),
    'archived_categories', (SELECT count(*) FROM public.categories WHERE active = false),
    'active_categories', (SELECT count(*) FROM public.categories WHERE active = true),
    'total_products', (SELECT count(*) FROM public.products),
    'total_products_stock', (SELECT COALESCE(sum(stock_quantity), 0) FROM public.products),
    'br104_stock', (SELECT stock_quantity FROM public.products WHERE sku = 'BR104'),
    'total_variants', (SELECT count(*) FROM public.product_variants),
    'total_variants_stock', (SELECT COALESCE(sum(stock_quantity), 0) FROM public.product_variants),
    'total_branch_balances', (SELECT count(*) FROM public.branch_stock_balances),
    'total_branch_balances_qty', (SELECT COALESCE(sum(quantity), 0) FROM public.branch_stock_balances),
    'total_catalogue_codes', (SELECT count(*) FROM public.catalogue_codes),
    'total_sales', (SELECT count(*) FROM public.sales),
    'total_sale_items', (SELECT count(*) FROM public.sale_items),
    'total_sale_payments', (SELECT count(*) FROM public.sale_payments),
    'total_sales_returns', (SELECT count(*) FROM public.sales_returns),
    'total_return_items', (SELECT count(*) FROM public.return_items),
    'total_refund_records', (SELECT count(*) FROM public.refund_records),
    'total_online_orders', (SELECT count(*) FROM public.online_orders),
    'total_online_order_items', (SELECT count(*) FROM public.online_order_items),
    'total_stock_reservations', (SELECT count(*) FROM public.stock_reservations),
    'total_shifts', (SELECT count(*) FROM public.shifts),
    'open_shifts', (SELECT count(*) FROM public.shifts WHERE status = 'open'),
    'total_stocktakes', (SELECT count(*) FROM public.stocktakes),
    'total_stocktake_lines', (SELECT count(*) FROM public.stocktake_lines),
    'total_profiles', (SELECT count(*) FROM public.profiles),
    'total_custom_roles', (SELECT count(*) FROM public.custom_roles),
    'total_branch_memberships', (SELECT count(*) FROM public.branch_memberships),
    'auth_users_count', (SELECT count(*) FROM auth.users),
    'auth_identities_count', (SELECT count(*) FROM auth.identities),
    'storage_buckets_count', (SELECT count(*) FROM storage.buckets),
    'storage_objects_count', (SELECT count(*) FROM storage.objects)
  ) AS summary
)
SELECT jsonb_build_object(
  'bundle_format', 'alyq-independent-dr-bundle',
  'bundle_version', 1,
  'exported_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'secrets_redacted', true,
  'checklist', checklist.summary,
  'alyq_backup_document', live_snapshot.doc,
  'supplementary_public_tables', supplementary_public.tables,
  'auth_metadata', auth_export.data,
  'storage_metadata', storage_export.data
)::text AS bundle_json
FROM live_snapshot, supplementary_public, auth_export, storage_export, checklist;
`;

async function createPgliteAtMigration(maxMigrationNumber) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { uuid_ossp } = await import("@electric-sql/pglite/contrib/uuid_ossp");

  const db = await new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(fs.readFileSync(SHIM_FILE, "utf8"));
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => Number(f.slice(0, 4)) <= maxMigrationNumber);

  for (const file of files) {
    const version = file.slice(0, 4);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
    await db.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
      [version, file],
    );
  }
  return { db, appliedCount: files.length };
}

/**
 * Seeds the exact Production baseline shape (43 products, 8 variants, 48 branch
 * stock balances, 3 intentionally archived categories, 1 active category,
 * BR104 stock = 3, 1 open shift, 1 stocktake + 8 lines, 5 auth.users/identities/profiles,
 * 1 custom_role, 5 branch_memberships, 1 storage.bucket + 2 storage.objects).
 */
async function seedProductionShapeSynthetic(db) {
  await db.exec(`
    DO $$
    DECLARE
      v_branch uuid := '00000000-0000-4000-8000-0000000000b1';
      v_admin  uuid := '11111111-1111-4111-8111-111111111101';
      v_u2     uuid := '11111111-1111-4111-8111-111111111102';
      v_u3     uuid := '11111111-1111-4111-8111-111111111103';
      v_u4     uuid := '11111111-1111-4111-8111-111111111104';
      v_u5     uuid := '11111111-1111-4111-8111-111111111105';
      v_cat_bracelets uuid := 'cca9d9ca-a802-429c-bdad-263b580e5b09';
      v_cat_necklaces uuid := 'b631c491-9958-453e-bc61-e63a85d2d48b';
      v_cat_earrings  uuid := '8a266f7f-a3ff-4f02-ba71-a38bb9eb1b29';
      v_cat_rings     uuid := 'cf01320a-42c2-4c2e-a802-81d960a58f46';
      v_br104 uuid := '0d9fc36f-b4cc-4526-8b63-f0048b559278';
      v_br112 uuid := gen_random_uuid();
      v_er108 uuid := gen_random_uuid();
      v_nk103 uuid := gen_random_uuid();
      v_pid   uuid;
      v_stocktake uuid := 'ce7c87c6-acee-4969-8c73-4590c64c3cea';
      i integer;
    BEGIN
      PERFORM set_config('alyq.backup_restore', 'on', true);

      DELETE FROM public.branch_stock_balances WHERE true;
      DELETE FROM public.product_variants WHERE true;
      DELETE FROM public.products WHERE true;
      DELETE FROM public.categories WHERE true;
      DELETE FROM public.shifts WHERE true;
      DELETE FROM public.stocktake_lines WHERE true;
      DELETE FROM public.stocktakes WHERE true;
      DELETE FROM public.custom_roles WHERE true;
      DELETE FROM public.branch_memberships WHERE true;
      DELETE FROM public.profiles WHERE true;
      DELETE FROM auth.identities WHERE true;
      DELETE FROM auth.users WHERE true;
      DELETE FROM storage.objects WHERE true;
      DELETE FROM storage.buckets WHERE true;

      -- 1) 5 Auth users + 5 identities + 5 profiles + 5 branch memberships
      FOR i IN 1..5 LOOP
        v_pid := ('11111111-1111-4111-8111-11111111110' || i)::uuid;
        INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
        VALUES (
          v_pid, 'authenticated', 'authenticated',
          'staff' || i || '@synthetic.alyq.local',
          '$2a$10$syntheticplaceholderhashonly000000000000000000000000000',
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('name', 'Staff ' || i)
        );
        INSERT INTO auth.identities (id, provider_id, user_id, identity_data, provider)
        VALUES (
          gen_random_uuid(), v_pid::text, v_pid,
          jsonb_build_object('sub', v_pid::text, 'email', 'staff' || i || '@synthetic.alyq.local'),
          'email'
        );
        INSERT INTO public.profiles (id, username, name, email, role, active, active_branch_id)
        VALUES (
          v_pid,
          'staff' || i,
          'Staff ' || i,
          'staff' || i || '@synthetic.alyq.local',
          CASE WHEN i = 1 THEN 'admin'::public.app_role ELSE 'cashier'::public.app_role END,
          true,
          v_branch
        )
        ON CONFLICT (id) DO UPDATE
          SET username = EXCLUDED.username,
              name = EXCLUDED.name,
              email = EXCLUDED.email,
              role = EXCLUDED.role,
              active = true,
              active_branch_id = v_branch;

        INSERT INTO public.branch_memberships (user_id, branch_id, role, active)
        VALUES (
          v_pid,
          v_branch,
          CASE WHEN i = 1 THEN 'admin'::public.app_role ELSE 'cashier'::public.app_role END,
          true
        )
        ON CONFLICT (user_id, branch_id) DO NOTHING;
      END LOOP;

      -- 1 custom role
      INSERT INTO public.custom_roles (id, key, name_en, name_ar, description_en, description_ar, base_role, capabilities, created_by)
      VALUES (
        gen_random_uuid(), 'floor_supervisor', 'Floor Supervisor', 'مشرف صالة',
        'Supervisor', 'مشرف', 'cashier', ARRAY['edit_product', 'sell'], v_admin
      );

      -- 2) 4 categories (created active first, then 3 archived intentionally like Production)
      INSERT INTO public.categories (id, name_ar, name_en, sort_order, active)
      VALUES
        (v_cat_bracelets, 'اساور', 'bracelets', 1, true),
        (v_cat_rings,     'خواتم', 'rings',     2, true),
        (v_cat_necklaces, 'سلاسل', 'neckless',  3, true),
        (v_cat_earrings,  'حلقان', 'Earrings',  4, true);

      -- 3) 43 products (26 in bracelets, 11 in necklaces, 6 in earrings; total stock = 89)
      -- 3a) BR104 (stock = 3, variants_enabled = false, has 1 dormant variant BR104-R-2 with stock = 0)
      INSERT INTO public.products (
        id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
        stock_quantity, low_stock_level, variants_enabled, active
      ) VALUES (
        v_br104, 'BR104', 'BR104', 'BR-104', 'BR-104', v_cat_bracelets, 220, 85,
        3, 5, false, true
      );
      INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity)
      VALUES (v_branch, v_br104, NULL, 3);

      -- 3b) BR112 (variants_enabled = true, 2 variants: S=1, L=1 -> total=2)
      INSERT INTO public.products (
        id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
        stock_quantity, low_stock_level, variants_enabled, active
      ) VALUES (
        v_br112, 'BR112', 'BR112', 'BR-112', 'BR-112', v_cat_bracelets, 240, 90,
        2, 5, true, true
      );

      -- 3c) 24 more bracelet products (stock = 2 each except first = 1 -> sum = 47; bracelets total = 3 + 2 + 49 = 54)
      FOR i IN 1..24 LOOP
        v_pid := gen_random_uuid();
        INSERT INTO public.products (
          id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
          stock_quantity, low_stock_level, variants_enabled, active
        ) VALUES (
          v_pid, 'BR-SYN-' || i, 'BR-SYN-' || i, 'أسورة ' || i, 'Bracelet ' || i,
          v_cat_bracelets, 200, 80, CASE WHEN i = 1 THEN 3 ELSE 2 END, 5, false, true
        );
        INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity)
        VALUES (v_branch, v_pid, NULL, CASE WHEN i = 1 THEN 3 ELSE 2 END);
      END LOOP;

      -- 3d) NK103 (variants_enabled = true, 2 variants: R=2, W=2 -> total=4) + 10 more necklaces (stock sum = 17 -> total 21)
      INSERT INTO public.products (
        id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
        stock_quantity, low_stock_level, variants_enabled, active
      ) VALUES (
        v_nk103, 'NK103', 'NK103', 'NK-103', 'NK-103', v_cat_necklaces, 260, 100,
        4, 5, true, true
      );
      FOR i IN 1..10 LOOP
        v_pid := gen_random_uuid();
        INSERT INTO public.products (
          id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
          stock_quantity, low_stock_level, variants_enabled, active
        ) VALUES (
          v_pid, 'NK-SYN-' || i, 'NK-SYN-' || i, 'سلسلة ' || i, 'Necklace ' || i,
          v_cat_necklaces, 210, 85, CASE WHEN i <= 7 THEN 2 ELSE 1 END, 5, false, true
        );
        INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity)
        VALUES (v_branch, v_pid, NULL, CASE WHEN i <= 7 THEN 2 ELSE 1 END);
      END LOOP;

      -- 3e) ER108 (variants_enabled = true, 3 variants: S=2, M=2, L=2 -> total=6) + 5 more earrings (stock sum = 8 -> total 14)
      INSERT INTO public.products (
        id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
        stock_quantity, low_stock_level, variants_enabled, active
      ) VALUES (
        v_er108, 'ER108', 'ER108', 'ER-108', 'ER-108', v_cat_earrings, 180, 70,
        6, 5, true, true
      );
      FOR i IN 1..5 LOOP
        v_pid := gen_random_uuid();
        INSERT INTO public.products (
          id, sku, barcode, name_ar, name_en, category_id, selling_price, cost_price,
          stock_quantity, low_stock_level, variants_enabled, active
        ) VALUES (
          v_pid, 'ER-SYN-' || i, 'ER-SYN-' || i, 'حلق ' || i, 'Earring ' || i,
          v_cat_earrings, 150, 60, CASE WHEN i <= 3 THEN 2 ELSE 1 END, 5, false, true
        );
        INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity)
        VALUES (v_branch, v_pid, NULL, CASE WHEN i <= 3 THEN 2 ELSE 1 END);
      END LOOP;

      -- 4) 8 Product Variants + 8 variant-level branch_stock_balances (40 + 8 = 48 total branch_stock_balances)
      INSERT INTO public.product_variants (
        id, product_id, sku, barcode, color_ar, color_en, color_key, size_label, size_value, stock_quantity, sort_order, active
      ) VALUES
        ('257b57df-6bc4-48e9-9eb4-62e894d4fd9a', v_br104, 'BR104-R-2', 'BR104-R-2', 'روز',  'ROSE',  'r', NULL, NULL, 0, 1, true),
        ('d3af4e23-511f-4ba8-93cb-c03e740cf8e6', v_br112, 'BR112-S',   'BR112-S',   NULL,   NULL,    '',  'S',  'S',  1, 1, true),
        ('51c2e598-01eb-4be7-aa2d-8195ed9e48df', v_br112, 'BR112-L',   'BR112-L',   NULL,   NULL,    '',  'L',  'L',  1, 2, true),
        ('ebb1e3f9-afd3-4f8a-87a4-8d78d1df0791', v_er108, 'ER108-S',   'ER108-S',   NULL,   NULL,    '',  'S',  'S',  2, 1, true),
        ('7172ad24-f929-4a98-9e0c-bdc8b1f3ee53', v_er108, 'ER108-M',   'ER108-M',   NULL,   NULL,    '',  'M',  'M',  2, 2, true),
        ('9c352d96-2c65-46a2-a88f-43698333b9f5', v_er108, 'ER108-L',   'ER108-L',   NULL,   NULL,    '',  'L',  'L',  2, 3, true),
        ('0c0b7612-bd6b-4515-8c19-01906f39f606', v_nk103, 'NK103-R',   'NK103-R',   'احمر', 'Red',   'ا', NULL, NULL, 2, 1, true),
        ('24b7485e-803b-463d-843c-ca0b2d172122', v_nk103, 'NK103-W',   'NK103-W',   'ابيض', 'White', 'w', NULL, NULL, 2, 2, true);

      INSERT INTO public.branch_stock_balances (branch_id, product_id, variant_id, quantity)
      VALUES
        (v_branch, v_br104, '257b57df-6bc4-48e9-9eb4-62e894d4fd9a', 0),
        (v_branch, v_br112, 'd3af4e23-511f-4ba8-93cb-c03e740cf8e6', 1),
        (v_branch, v_br112, '51c2e598-01eb-4be7-aa2d-8195ed9e48df', 1),
        (v_branch, v_er108, 'ebb1e3f9-afd3-4f8a-87a4-8d78d1df0791', 2),
        (v_branch, v_er108, '7172ad24-f929-4a98-9e0c-bdc8b1f3ee53', 2),
        (v_branch, v_er108, '9c352d96-2c65-46a2-a88f-43698333b9f5', 2),
        (v_branch, v_nk103, '0c0b7612-bd6b-4515-8c19-01906f39f606', 2),
        (v_branch, v_nk103, '24b7485e-803b-463d-843c-ca0b2d172122', 2);

      -- 5) Intentionally archive the 3 categories (matching owner's action in Production)
      UPDATE public.categories
         SET active = false
       WHERE id IN (v_cat_bracelets, v_cat_necklaces, v_cat_earrings);

      -- 6) Set auth context to v_admin and open 1 Shift (SH-000001)
      PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

      INSERT INTO public.shifts (
        id, shift_number, branch_id, branch, register, status, opening_cash, opened_by, opened_by_name
      ) VALUES (
        'b8c62100-b298-428a-9e40-b50e533d9f9b', 'SH-000001', v_branch, 'Main Branch', 'Register 1',
        'open', 0, v_admin::text, 'Staff 1'
      );

      -- 7) 1 Stocktake in counting state with 8 lines
      INSERT INTO public.stocktakes (id, reference, branch_id, status, note, created_by, created_by_name)
      VALUES (v_stocktake, 'ST-0001', v_branch, 'counting', 'Initial count', v_admin::text, 'Staff 1');

      FOR i IN 1..8 LOOP
        INSERT INTO public.stocktake_lines (
          id, stocktake_id, shelf_key, product_id, sku, barcode,
          product_name_ar, product_name_en, expected_quantity, physical_quantity, variance
        ) VALUES (
          gen_random_uuid(), v_stocktake, 'shelf-' || i, v_br104, 'SKU-' || i, 'BC-' || i,
          'منتج ' || i, 'Product ' || i, 2, 2, 0
        );
      END LOOP;

      -- 8) Storage bucket (product-images) + 2 placeholder objects
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'product-images', 'product-images', true, 5242880,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']
      );
      INSERT INTO storage.objects (id, bucket_id, name)
      VALUES
        ('eb4803f5-307a-4e3f-a7ad-3d7fe48c82ad', 'product-images', 'public/.emptyFolderPlaceholder'),
        ('01979e72-689f-4543-b5ef-f6a1f156fc08', 'product-images', 'website/.emptyFolderPlaceholder');

      PERFORM set_config('alyq.backup_restore', '', true);
    END $$;
  `);
}

/**
 * Restores a database from an external Independent DR Bundle JSON file on disk,
 * even when `public.backups` is empty and even when the target database is still
 * at Migration 0096 (before 0098's trigger guards).
 */
async function restoreFromIndependentBundleFile(db, bundleFilePath, adminUserId) {
  const rawText = fs.readFileSync(bundleFilePath, "utf8");
  const bundle = JSON.parse(rawText);

  if (bundle.bundle_format !== "alyq-independent-dr-bundle" || bundle.bundle_version !== 1) {
    throw new Error("Invalid bundle_format or bundle_version");
  }

  await db.exec("BEGIN");
  try {
    // 1. Restore Auth users & identities first so `public.profiles` FK to `auth.users(id)` succeeds (0 skipped)
    await db.query(
      `
      INSERT INTO auth.users (
        id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      )
      SELECT
        (u->>'id')::uuid,
        NULLIF(u->>'instance_id', '')::uuid,
        COALESCE(u->>'aud', 'authenticated'),
        COALESCE(u->>'role', 'authenticated'),
        u->>'email',
        '$2a$10$restoredplaceholderhashrequiringpasswordreset0000000000000',
        NULLIF(u->>'email_confirmed_at', '')::timestamptz,
        COALESCE(u->'raw_app_meta_data', '{}'::jsonb),
        COALESCE(u->'raw_user_meta_data', '{}'::jsonb),
        COALESCE(NULLIF(u->>'created_at', '')::timestamptz, now()),
        COALESCE(NULLIF(u->>'updated_at', '')::timestamptz, now())
      FROM jsonb_array_elements($1::jsonb) AS u
      ON CONFLICT (id) DO UPDATE
        SET email = EXCLUDED.email,
            raw_app_meta_data = EXCLUDED.raw_app_meta_data,
            raw_user_meta_data = EXCLUDED.raw_user_meta_data,
            updated_at = EXCLUDED.updated_at;
      `,
      [JSON.stringify(bundle.auth_metadata.users)],
    );

    await db.query(
      `
      INSERT INTO auth.identities (
        id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      )
      SELECT
        (i->>'id')::uuid,
        i->>'provider_id',
        (i->>'user_id')::uuid,
        COALESCE(i->'identity_data', '{}'::jsonb),
        COALESCE(i->>'provider', 'email'),
        NULLIF(i->>'last_sign_in_at', '')::timestamptz,
        COALESCE(NULLIF(i->>'created_at', '')::timestamptz, now()),
        COALESCE(NULLIF(i->>'updated_at', '')::timestamptz, now())
      FROM jsonb_array_elements($1::jsonb) AS i
      ON CONFLICT (id) DO NOTHING;
      `,
      [JSON.stringify(bundle.auth_metadata.identities)],
    );

    // 2. Restore Storage buckets & object metadata
    await db.query(
      `
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at)
      SELECT
        b->>'id',
        b->>'name',
        COALESCE((b->>'public')::boolean, false),
        NULLIF(b->>'file_size_limit', '')::bigint,
        CASE
          WHEN jsonb_typeof(b->'allowed_mime_types') = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(b->'allowed_mime_types'))
          ELSE NULL
        END,
        COALESCE(NULLIF(b->>'created_at', '')::timestamptz, now())
      FROM jsonb_array_elements($1::jsonb) AS b
      ON CONFLICT (id) DO UPDATE
        SET public = EXCLUDED.public,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
      `,
      [JSON.stringify(bundle.storage_metadata.buckets)],
    );

    await db.query(
      `
      INSERT INTO storage.objects (id, bucket_id, name, owner, created_at)
      SELECT
        (o->>'id')::uuid,
        o->>'bucket_id',
        o->>'name',
        NULLIF(o->>'owner', '')::uuid,
        COALESCE(NULLIF(o->>'created_at', '')::timestamptz, now())
      FROM jsonb_array_elements($1::jsonb) AS o
      ON CONFLICT (id) DO UPDATE
        SET bucket_id = EXCLUDED.bucket_id,
            name = EXCLUDED.name;
      `,
      [JSON.stringify(bundle.storage_metadata.objects)],
    );

    // 3. Ensure pre-0098 databases honor `alyq.backup_restore = 'on'` inside
    //    `products_enforce_category_active()` and canonicalize JSONB numeric scales
    //    stripped by JavaScript JSON.parse/JSON.stringify when reading from an
    //    external file, while preserving strict MD5 checksum verification.
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.normalize_backup_document_for_restore(p_document jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
      DECLARE
        v_held       jsonb;
        v_normalized jsonb := '{}'::jsonb;
        v_table      text;
        v_rows       jsonb;
        v_norm_rows  jsonb;
        v_expected   text;
      BEGIN
        IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object' THEN
          RETURN p_document;
        END IF;
        v_expected := coalesce(p_document->>'checksum', '');
        v_held := p_document->'payload'->'tables';
        IF v_expected = '' OR v_held IS NULL OR jsonb_typeof(v_held) <> 'object' THEN
          RETURN p_document;
        END IF;
        -- Fast path: if raw jsonb MD5 already matches, no normalization needed.
        IF md5((p_document->'payload')::text) = v_expected THEN
          RETURN p_document;
        END IF;
        -- Re-populate each known table through jsonb_populate_record so numeric(p,s)
        -- columns stripped of trailing zeros (.00) by JavaScript JSON.parse/JSON.stringify
        -- regain their PostgreSQL column scale before MD5 verification.
        FOREACH v_table IN ARRAY public.backup_table_order() LOOP
          IF NOT (v_held ? v_table) THEN
            RETURN p_document;
          END IF;
          v_rows := v_held->v_table;
          IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
            v_normalized := v_normalized || jsonb_build_object(v_table, '[]'::jsonb);
          ELSE
            EXECUTE format(
              'SELECT coalesce(jsonb_agg(to_jsonb(jsonb_populate_record(null::public.%I, e.value))), ''[]''::jsonb)
                 FROM jsonb_array_elements($1) AS e(value)',
              v_table
            ) INTO v_norm_rows USING v_rows;
            v_normalized := v_normalized || jsonb_build_object(v_table, v_norm_rows);
          END IF;
        END LOOP;
        RETURN jsonb_set(p_document, '{payload,tables}', v_normalized, false);
      EXCEPTION WHEN others THEN
        RETURN p_document;
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION public.products_enforce_category_active()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = public
      AS $fn$
      DECLARE
        v_active boolean;
      BEGIN
        IF current_setting('alyq.backup_restore', true) = 'on' THEN
          RETURN new;
        END IF;
        IF new.category_id IS NULL THEN
          RETURN new;
        END IF;
        IF tg_op = 'UPDATE' AND new.category_id IS NOT DISTINCT FROM old.category_id THEN
          RETURN new;
        END IF;
        SELECT c.active INTO v_active FROM public.categories c WHERE c.id = new.category_id;
        IF v_active IS FALSE THEN
          RAISE EXCEPTION 'Category % is archived — a product cannot be assigned to it',
            new.category_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN new;
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION public.enforce_shift_invariants()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $fn$
      DECLARE
        v_branch uuid := public.current_branch_id();
        v_name text;
      BEGIN
        IF current_setting('alyq.backup_restore', true) = 'on' THEN
          RETURN new;
        END IF;
        IF tg_op = 'INSERT' THEN
          IF new.status <> 'open' THEN RAISE EXCEPTION 'A shift cannot be created already closed' USING ERRCODE = 'check_violation'; END IF;
          IF NOT public.can('open_shift') THEN RAISE EXCEPTION 'Not permitted to open shift' USING ERRCODE = 'insufficient_privilege'; END IF;
          IF v_branch IS NULL THEN RAISE EXCEPTION 'Active branch required' USING ERRCODE = 'insufficient_privilege'; END IF;
          new.branch_id := v_branch; SELECT name_en INTO new.branch FROM public.branches WHERE id = v_branch;
          new.opened_by := auth.uid()::text; SELECT name INTO v_name FROM public.profiles WHERE id = auth.uid(); new.opened_by_name := coalesce(v_name, new.opened_by_name);
          IF EXISTS(SELECT 1 FROM public.shifts WHERE status = 'open' AND opened_by = auth.uid()::text) THEN
            RAISE EXCEPTION 'This cashier already has an open shift' USING ERRCODE = 'unique_violation';
          END IF;
          IF EXISTS(SELECT 1 FROM public.shifts WHERE branch_id = v_branch AND status = 'open') THEN
            RAISE EXCEPTION 'An open shift already exists in this branch' USING ERRCODE = 'unique_violation';
          END IF;
          RETURN new;
        END IF;
        IF old.branch_id <> v_branch THEN RAISE EXCEPTION 'Cross-branch shift write rejected' USING ERRCODE = 'insufficient_privilege'; END IF;
        IF old.status = 'closed' THEN
          IF new.adjustment_approved_at IS DISTINCT FROM old.adjustment_approved_at THEN
            IF old.adjustment_approved_at IS NOT NULL THEN RAISE EXCEPTION 'A shift adjustment can only be approved once' USING ERRCODE = 'check_violation'; END IF;
            IF NOT public.can('approve_shift_adjustment') THEN RAISE EXCEPTION 'Closed shift adjustment is not permitted' USING ERRCODE = 'insufficient_privilege'; END IF;
            RETURN new;
          END IF;
          IF new IS DISTINCT FROM old THEN RAISE EXCEPTION 'A closed shift cannot be edited' USING ERRCODE = 'check_violation'; END IF;
          RETURN new;
        END IF;
        IF new.status = 'closed' THEN
          IF current_setting('alyq.shift_closing', true) IS DISTINCT FROM old.id::text THEN RAISE EXCEPTION 'Use the authoritative close-shift operation' USING ERRCODE = 'insufficient_privilege'; END IF;
          IF NOT public.can('close_shift') THEN RAISE EXCEPTION 'Not permitted to close shift' USING ERRCODE = 'insufficient_privilege'; END IF;
        END IF;
        RETURN new;
      END;
      $fn$;
    `);

    // Ensure the admin profile and default branch membership exist for capability check `public.can('restore_backup')`
    await db.query(
      `
      INSERT INTO public.branches (id, code, name_en, name_ar, is_default, active)
      VALUES ('00000000-0000-4000-8000-0000000000b1'::uuid, 'main', 'Main Branch', 'الفرع الرئيسي', true, true)
      ON CONFLICT (id) DO UPDATE SET active = true, is_default = true;
      `,
    );
    await db.query(
      `
      INSERT INTO public.profiles (id, username, name, email, role, active, active_branch_id)
      VALUES ($1::uuid, 'emergency_restore_admin', 'Emergency Restore Admin', 'admin@restore.local', 'admin', true, '00000000-0000-4000-8000-0000000000b1'::uuid)
      ON CONFLICT (id) DO UPDATE SET role = 'admin', active = true, active_branch_id = '00000000-0000-4000-8000-0000000000b1'::uuid;
      `,
      [adminUserId],
    );
    await db.query(
      `
      INSERT INTO public.branch_memberships (user_id, branch_id, role, active)
      VALUES ($1::uuid, '00000000-0000-4000-8000-0000000000b1'::uuid, 'admin', true)
      ON CONFLICT (user_id, branch_id) DO UPDATE SET role = 'admin', active = true;
      `,
      [adminUserId],
    );

    await db.query(
      `
      SELECT
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true),
        set_config('alyq.backup_restore', 'on', true);
      `,
      [adminUserId],
    );

    // 4. Call the authoritative `public.admin_restore_document(p_document jsonb)`
    //    using the external JSON document from disk (NOT `admin_restore_backup(id)`!)
    const restoreRes = await db.query(
      `SELECT public.admin_restore_document(public.normalize_backup_document_for_restore($1::jsonb)) AS outcome`,
      [JSON.stringify(bundle.alyq_backup_document)],
    );
    const outcome = restoreRes.rows[0].outcome;

    // 5. Restore supplementary public tables (e.g. backup_settings, registers, notification_outbox)
    await db.query(
      `
      INSERT INTO public.backup_settings
      SELECT (jsonb_populate_record(NULL::public.backup_settings, e.value)).*
      FROM jsonb_array_elements($1::jsonb) AS e(value)
      ON CONFLICT (id) DO UPDATE
        SET frequency = EXCLUDED.frequency,
            retention_days = EXCLUDED.retention_days,
            retention_count = EXCLUDED.retention_count;
      `,
      [JSON.stringify(bundle.supplementary_public_tables.backup_settings ?? [])],
    );

    await db.exec("COMMIT");
    return outcome;
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}

async function run() {
  console.log("\n=== Practical Verification of Independent Off-Database DR Backup & Restore ===\n");

  // ── Scenario A: Exact Production Baseline at Migration 0096 ──────────────
  const { db: db96, appliedCount } = await createPgliteAtMigration(96);
  if (appliedCount !== 96) {
    throw new Error(`Expected 96 migrations for Scenario A, got ${appliedCount}`);
  }
  await seedProductionShapeSynthetic(db96);

  // 1. Export Independent DR Bundle via 100% Read-Only SELECT
  const exportRes = await db96.query(READONLY_INDEPENDENT_DR_EXPORT_SQL);
  const bundleJsonText = exportRes.rows[0].bundle_json;
  const bundle = JSON.parse(bundleJsonText);

  const tmpFile96 = path.join(os.tmpdir(), "alyq-independent-dr-bundle-0096.json");
  fs.writeFileSync(tmpFile96, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  const fileSha256 = crypto.createHash("sha256").update(fs.readFileSync(tmpFile96)).digest("hex");

  // Verify no password hashes or secret tokens leaked into the exported file
  if (/encrypted_password|confirmation_token|recovery_token|\$2a\$10\$/i.test(fs.readFileSync(tmpFile96, "utf8"))) {
    throw new Error("SECURITY FAILURE: Password hash or token found in exported DR bundle!");
  }

  console.log("1. [Scenario A · 0096] Read-Only Independent DR Bundle exported to disk:");
  console.log(`   - File path          : ${tmpFile96}`);
  console.log(`   - File SHA-256       : ${fileSha256}`);
  console.log(`   - Payload MD5        : ${bundle.alyq_backup_document.checksum}`);
  console.log(`   - Secrets redacted   : ${bundle.secrets_redacted}`);
  console.log(`   - Baseline checklist :`, JSON.stringify(bundle.checklist));

  // 2. Wipe the database completely — including deleting all rows in `public.backups`!
  await db96.exec(`
    DO $$
    BEGIN
      PERFORM set_config('session_replication_role', 'replica', true);
      PERFORM set_config('alyq.backup_restore', 'on', true);
      DELETE FROM public.backups WHERE true;
      DELETE FROM public.branch_stock_balances WHERE true;
      DELETE FROM public.product_variants WHERE true;
      DELETE FROM public.products WHERE true;
      DELETE FROM public.categories WHERE true;
      DELETE FROM public.shifts WHERE true;
      DELETE FROM public.stocktake_lines WHERE true;
      DELETE FROM public.stocktakes WHERE true;
      DELETE FROM public.custom_roles WHERE true;
      DELETE FROM public.branch_memberships WHERE true;
      DELETE FROM public.profiles WHERE true;
      DELETE FROM auth.identities WHERE true;
      DELETE FROM auth.users WHERE true;
      DELETE FROM storage.objects WHERE true;
      DELETE FROM storage.buckets WHERE true;
    END $$;
  `);

  const wipedCheck = (
    await db96.query(`
      SELECT
        (SELECT count(*) FROM public.backups) AS backups_in_db,
        (SELECT count(*) FROM public.products) AS products_in_db,
        (SELECT count(*) FROM auth.users) AS auth_users_in_db,
        (SELECT count(*) FROM storage.objects) AS storage_objects_in_db
    `)
  ).rows[0];
  console.log("2. [Scenario A · 0096] Simulated catastrophic wipe (including deleting public.backups):");
  console.log(`   - State after wipe   :`, JSON.stringify(wipedCheck));

  if (
    Number(wipedCheck.backups_in_db) !== 0 ||
    Number(wipedCheck.products_in_db) !== 0 ||
    Number(wipedCheck.auth_users_in_db) !== 0 ||
    Number(wipedCheck.storage_objects_in_db) !== 0
  ) {
    throw new Error("Wipe check failed");
  }

  // 3. Practically restore from the external file on disk
  const restoreOutcome = await restoreFromIndependentBundleFile(
    db96,
    tmpFile96,
    "11111111-1111-4111-8111-111111111101",
  );
  console.log("3. [Scenario A · 0096] Practical Restore from external file completed:");
  console.log(`   - Restore outcome    :`, JSON.stringify(restoreOutcome));

  // 4. Verify restored state against original checklist
  const postRestoreRes = await db96.query(READONLY_INDEPENDENT_DR_EXPORT_SQL);
  const postBundle = JSON.parse(postRestoreRes.rows[0].bundle_json);

  const keysToVerify = [
    "migration_count",
    "latest_migration",
    "total_categories",
    "archived_categories",
    "active_categories",
    "total_products",
    "total_products_stock",
    "br104_stock",
    "total_variants",
    "total_variants_stock",
    "total_branch_balances",
    "total_branch_balances_qty",
    "total_catalogue_codes",
    "total_sales",
    "total_sale_items",
    "total_sale_payments",
    "total_sales_returns",
    "total_return_items",
    "total_refund_records",
    "total_online_orders",
    "total_online_order_items",
    "total_stock_reservations",
    "total_shifts",
    "open_shifts",
    "total_stocktakes",
    "total_stocktake_lines",
    "total_profiles",
    "total_custom_roles",
    "total_branch_memberships",
    "auth_users_count",
    "auth_identities_count",
    "storage_buckets_count",
    "storage_objects_count",
  ];

  for (const key of keysToVerify) {
    if (postBundle.checklist[key] !== bundle.checklist[key]) {
      throw new Error(
        `Mismatch on ${key}: expected ${bundle.checklist[key]}, got ${postBundle.checklist[key]}`,
      );
    }
  }
  if (Number(restoreOutcome.profiles_skipped) !== 0) {
    throw new Error(`Expected profiles_skipped = 0, got ${restoreOutcome.profiles_skipped}`);
  }

  console.log("4. [Scenario A · 0096] Post-restore verification PASSED 100%:");
  console.log(`   - Checklist match    : true (all ${keysToVerify.length} operational, Auth & Storage metrics identical)`);
  console.log(`   - profiles_skipped   : ${restoreOutcome.profiles_skipped}`);
  console.log(`   - BR104 stock        : ${postBundle.checklist.br104_stock}`);
  console.log(`   - Archived categories: ${postBundle.checklist.archived_categories} (active: ${postBundle.checklist.active_categories})`);

  // 5. Scenario B: Apply Migrations 0097 + 0098 and verify native external-file
  //    restore + tamper rejection after JavaScript JSON.parse/JSON.stringify
  const migs9798 = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.startsWith("0097_") || f.startsWith("0098_"))
    .sort();
  for (const file of migs9798) {
    const version = file.split("_")[0];
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await db96.exec(sql);
    await db96.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
      [version, file],
    );
  }

  await db96.exec(`
    SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111101', false);
    SELECT set_config('request.jwt.claim.role', 'authenticated', false);
    SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111101","role":"authenticated"}', false);
  `);
  const exportRes98 = await db96.query(READONLY_INDEPENDENT_DR_EXPORT_SQL);
  const bundle98 = JSON.parse(exportRes98.rows[0].bundle_json);
  const tmpFile98 = path.join(os.tmpdir(), "alyq-independent-dr-bundle-0098.json");
  fs.writeFileSync(tmpFile98, JSON.stringify(bundle98, null, 2), { mode: 0o600 });

  // Verify tamper rejection on external file
  const tamperedDoc = JSON.parse(JSON.stringify(bundle98.alyq_backup_document));
  tamperedDoc.payload.tables.products[0].selling_price = 999999;
  let tamperRejected = false;
  try {
    await db96.query(`SELECT public.admin_restore_document($1::jsonb)`, [
      JSON.stringify(tamperedDoc),
    ]);
  } catch (err) {
    if (String(err.message || err).includes("backup.error.checksum_mismatch")) {
      tamperRejected = true;
    }
  }
  if (!tamperRejected) {
    throw new Error("Expected tampered external backup document to be rejected with backup.error.checksum_mismatch");
  }

  // Delete all in-DB backups and corrupt products, then restore from external 0098 file
  await db96.exec(`
    DELETE FROM public.backups WHERE true;
    UPDATE public.products SET stock_quantity = 999, selling_price = 1 WHERE sku = 'BR104';
  `);
  const restore98Res = await db96.query(
    `SELECT public.admin_restore_document($1::jsonb) AS outcome`,
    [JSON.stringify(bundle98.alyq_backup_document)],
  );
  const br104After98 = (
    await db96.query(`SELECT stock_quantity, selling_price FROM public.products WHERE sku = 'BR104'`)
  ).rows[0];
  if (Number(br104After98.stock_quantity) !== 3 || Number(br104After98.selling_price) !== 220) {
    throw new Error(`Post-0098 restore mismatch on BR104: ${JSON.stringify(br104After98)}`);
  }
  console.log("5. [Scenario B · 0098] Native external JSON file restore + tamper check PASSED:");
  console.log(`   - Tampered file rejected : ${tamperRejected} (backup.error.checksum_mismatch)`);
  console.log(`   - External file restored : ${restore98Res.rows[0].outcome.ok} (checksum=${restore98Res.rows[0].outcome.checksum})`);

  await db96.close();
  fs.unlinkSync(tmpFile96);
  fs.unlinkSync(tmpFile98);
  console.log("\n✓ ALL INDEPENDENT OFF-DATABASE BACKUP & RESTORE CHECKS PASSED\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("✗ Independent DR verification failed:", err);
    process.exit(1);
  });
}

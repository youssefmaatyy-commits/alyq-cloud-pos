-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0005
-- Phase 2 (continued) — Supabase Storage bucket for product images.
-- ═══════════════════════════════════════════════════════════════════════════

-- Public bucket so product images can be served straight from the CDN without
-- an authenticated request. RLS policies below still gate writes.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Optional: cap uploads at 5 MB and restrict to image MIME types.
-- These columns exist in current Supabase; guard them so older schemas stay safe.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    update storage.buckets
       set file_size_limit = 5242880
     where id = 'product-images';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    update storage.buckets
       set allowed_mime_types = array[
         'image/jpeg','image/png','image/webp','image/gif','image/avif','image/svg+xml','image/bmp'
       ]
     where id = 'product-images';
  end if;
end
$$;

-- ── Storage RLS policies ─────────────────────────────────────────────────
-- Authenticated workspace members can read, upload and replace product images.
-- (Public reads are already served by the CDN for a `public` bucket.)
drop policy if exists "product_images_select" on storage.objects;
create policy "product_images_select"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "product_images_insert" on storage.objects;
create policy "product_images_insert"
  on storage.objects for insert
  with check (bucket_id = 'product-images');

drop policy if exists "product_images_update" on storage.objects;
create policy "product_images_update"
  on storage.objects for update
  using (bucket_id = 'product-images');

drop policy if exists "product_images_delete" on storage.objects;
create policy "product_images_delete"
  on storage.objects for delete
  using (bucket_id = 'product-images');

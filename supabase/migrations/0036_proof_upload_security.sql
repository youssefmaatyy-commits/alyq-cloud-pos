-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · Migration 0036
-- Proof-upload security — closing what 0005 left open to the whole internet.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0005 created the `product-images` bucket with policies whose comment said
-- "authenticated workspace members can read, upload and replace" — but the
-- policies themselves were created with no `to` clause, which makes them
-- `to public`: they applied to EVERY role, `anon` included. And every
-- storefront bundle ships the project's anon key. So any visitor could, with
-- a plain Supabase Storage API call and no frontend involved:
--
--   · LIST the whole bucket through the open SELECT policy — enumerating
--     every `proofs/` object and defeating the unguessable-UUID paths, and,
--     the bucket being public, fetch every customer's payment proof;
--   · INSERT at any prefix (`website/`, `public/`, `proofs/`), not just the
--     payment-proof namespace reserved for guests;
--   · UPDATE (overwrite the bytes, rename, move) and DELETE any object —
--     product artwork and other customers' proofs alike. An `upsert: true`
--     upload is an UPDATE under storage's model, so the client's
--     `upsert: false` was never the thing standing between two customers'
--     proofs.
--
-- This migration closes the write/list side without touching either
-- legitimate flow: signed-in staff (`authenticated`) keep full management of
-- the bucket, and an anonymous customer can still CREATE a payment proof —
-- but only under `proofs/`, and never modify, move, delete or enumerate
-- anything. There is deliberately no anon UPDATE/DELETE/SELECT policy: RLS
-- denies by default, an insert onto an existing path is a duplicate key, and
-- an upsert needs the UPDATE policy anon does not have. One customer's proof
-- is therefore unreachable from another customer's session.
--
-- Second gap, closed here too: the bucket's server-side MIME whitelist
-- included `image/svg+xml`. SVG is a script-carrying document format, not
-- merely a picture — an SVG in a PUBLIC bucket is served from the project's
-- own storage domain and runs its embedded scripts in the browser of anyone
-- who opens it directly (staff click "Open proof" on an uploaded SVG). That
-- was not a frontend validation to bypass: the frontend whitelist contained
-- SVG as well, so the allowance WAS the policy. `image/svg+xml` is dropped
-- from the bucket (and from the shared frontend whitelist in
-- `src/modules/products/services/imageStorage.ts`, so the two agree). The
-- remaining types — jpeg, png, webp, gif, avif, bmp — are raster formats
-- that cannot carry executable content.
--
-- Unchanged, deliberately:
--   · `file_size_limit` stays at 5 MB (5242880 bytes), enforced by the
--     Storage server itself, so a client that skips the frontend check still
--     cannot exceed it;
--   · the bucket stays PUBLIC. Product and website imagery must be served by
--     the CDN to anonymous shoppers, and proof object names are random UUIDs
--     that, with the listing hole closed, are neither guessable nor
--     enumerable. A proof URL now travels only to the customer who uploaded
--     it (through `lookup_online_order`'s order-number + phone gate) and to
--     staff (through the order admin). Moving proofs to a private bucket
--     with signed URLs is a redesign, not a policy fix, and is left to a
--     future phase.
--
-- Idempotent: policies are dropped and recreated, the MIME update is a no-op
-- once applied, and re-running the chain (0005 then 0036) lands on the same
-- hardened end state — which `npm run db:check` asserts, and the anonymous
-- storage phase in `supabase/tests/scenarios.sql` proves.

-- ── 1. bucket-level MIME whitelist: SVG is out ────────────────────────────
-- Guarded the way 0005 guarded it, so an older storage schema cannot fail
-- the chain; on any current Supabase project the column exists and the
-- Storage API enforces this list on every upload, whatever the client claims
-- to have validated.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types'
  ) then
    update storage.buckets
       set allowed_mime_types = array[
         'image/jpeg','image/png','image/webp','image/gif','image/avif','image/bmp'
       ]
     where id = 'product-images';
  end if;
end
$$;

-- ── 2. storage RLS: reads and management belong to signed-in staff ───────
-- Public image *serving* does not pass through these policies — a public
-- bucket is rendered by the CDN without touching storage.objects — so
-- narrowing SELECT to `authenticated` removes nothing from the shop window.
-- What it removes is the anonymous LIST call that handed out every proof
-- path in the bucket.
drop policy if exists "product_images_select" on storage.objects;
create policy "product_images_select"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images');

drop policy if exists "product_images_insert" on storage.objects;
create policy "product_images_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images');

drop policy if exists "product_images_update" on storage.objects;
create policy "product_images_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images');

drop policy if exists "product_images_delete" on storage.objects;
create policy "product_images_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images');

-- ── 3. and the one thing a guest may do: create their own proof ──────────
-- `storage.foldername()` returns the path's folder components, so the check
-- is exactly "the first folder is proofs": a root-level object merely NAMED
-- `proofs` does not qualify (its folder list is empty), and no other prefix
-- does either. INSERT-only — there is no anon policy for any other command.
drop policy if exists "payment_proof_anon_insert" on storage.objects;
create policy "payment_proof_anon_insert"
  on storage.objects for insert to anon
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = 'proofs'
  );

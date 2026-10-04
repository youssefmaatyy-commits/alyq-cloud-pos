-- Defensive DB-side backstop: a newly inserted sellable variant with a valid
-- SKU should never unintentionally end up barcode-less. The application
-- (reconcileVariantDraft / generateVariants / saveVariant in
-- src/modules/products/services/*) already derives the barcode from the SKU
-- via deriveBarcodeFromSku() before it ever reaches the database — this
-- trigger only catches a row inserted some other way (a script, a future
-- admin tool, a bug) that forgot to.
--
-- Scope is intentionally the smallest safe thing:
--   * BEFORE INSERT only — never UPDATE. The app already owns barcode
--     lifecycle (auto vs. manually-overridden, regenerate-on-SKU-change) for
--     edits; a trigger firing on every UPDATE could clobber an in-progress
--     edit or an intentionally-blank barcode mid-save. INSERT is the one
--     place "this row has never had a chance to get a barcode yet" is
--     unambiguous.
--   * Only touches NEW.barcode when it is still blank. A manually supplied
--     barcode (including one equal to '', meaning "leave it blank for now")
--     is never overwritten... except blank IS what triggers generation here,
--     which matches the TS rule: blank barcode == auto mode == derive from
--     SKU. A manual value, once present, is always left untouched.
--   * Only derives for SKUs that are pure printable ASCII (the Code 128
--     subset B range, 0x20-0x7E). This is a DELIBERATE, DOCUMENTED boundary,
--     not a shortcut: deriveBarcodeFromSku() in TypeScript uses
--     `.toUpperCase()`, which is locale-independent. Postgres' built-in
--     upper() is locale-aware (eg. under a tr_TR server locale, upper('i')
--     becomes 'İ', not 'I') and could silently diverge from the TS result
--     for mixed-case non-ASCII input. Rather than guess at an uppercasing
--     scheme that might not match the frontend byte-for-byte, this trigger
--     only acts where parity can be PROVEN: SKUs already restricted to
--     printable ASCII, uppercased with translate() over the fixed 26-letter
--     alphabet (locale-independent, unlike upper()). For any SKU containing
--     a character outside that range, this trigger deliberately does
--     nothing and leaves the barcode blank — the frontend (which runs the
--     real algorithm) is the authority for that narrow domain, and is
--     already relied on for every insert path the UI exposes.
--
-- Does not touch catalogue_codes, product_variants_sku_unique or
-- product_variants_barcode_unique — those already protect global uniqueness
-- and a collision here surfaces as the same unique-violation error an
-- application-derived duplicate would. No new algorithm, no EAN/UPC, no
-- randomness: this is deriveBarcodeFromSku(), mirrored for the ASCII domain.

create or replace function public.product_variants_autogenerate_barcode()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_sku text;
  v_normalized text;
begin
  -- Already has a barcode (manual override or otherwise) — never touch it.
  if btrim(coalesce(new.barcode, '')) <> '' then
    return new;
  end if;

  v_sku := btrim(coalesce(new.sku, ''));
  if v_sku = '' then
    return new;
  end if;

  -- Parity boundary: only act on SKUs entirely within printable ASCII
  -- (space … '~'), the exact range deriveBarcodeFromSku() keeps in TS. Any
  -- other SKU is left for the application layer, which already derives and
  -- persists the barcode before this row is ever inserted.
  if v_sku !~ '^[ -~]+$' then
    return new;
  end if;

  -- Mirrors deriveBarcodeFromSku(): trim (already done above) -> uppercase
  -- -> collapse inner whitespace runs to '-' -> collapse repeated '-' ->
  -- trim leading/trailing '-' -> truncate to 48 characters. translate() is
  -- used instead of upper() so the mapping is locale-independent (see
  -- header comment above) and limited to the plain ASCII alphabet, matching
  -- JS's String.prototype.toUpperCase() byte-for-byte for this domain.
  v_normalized := translate(v_sku, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  v_normalized := regexp_replace(v_normalized, '\s+', '-', 'g');
  v_normalized := regexp_replace(v_normalized, '-{2,}', '-', 'g');
  v_normalized := regexp_replace(v_normalized, '^-+|-+$', '', 'g');
  v_normalized := left(v_normalized, 48);

  if btrim(v_normalized) <> '' then
    new.barcode := v_normalized;
  end if;

  return new;
end;
$$;

comment on function public.product_variants_autogenerate_barcode() is
  'Defensive backstop only: fills a blank NEW.barcode from NEW.sku on INSERT when the SKU is pure printable ASCII, mirroring modules/products/services/barcode.ts:deriveBarcodeFromSku(). Non-ASCII SKUs are left to the application layer, which already derives+persists before insert. Never fires on UPDATE and never touches a barcode that is already set.';

drop trigger if exists product_variants_autogenerate_barcode on public.product_variants;
create trigger product_variants_autogenerate_barcode
  before insert on public.product_variants
  for each row execute function public.product_variants_autogenerate_barcode();

-- No backfill of existing rows: no migration up to and including 0085 ever
-- seeds public.product_variants, so there is no dev/demo data to collide
-- with or repair. A collision check is unnecessary for the same reason —
-- there is nothing yet in the table for a newly-derived barcode to collide
-- with other than what the application itself already guards against via
-- product_variants_barcode_unique.

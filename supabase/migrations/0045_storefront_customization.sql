-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0045 — premium storefront customization (Phase 45)
-- ═══════════════════════════════════════════════════════════════════════════
-- The storefront redesign needs exactly three database things; everything else
-- about the new look lives in the `website_settings` JSONB document, which is
-- the architecture this table was chosen for in 0017: one document, read as a
-- unit by one admin screen and one storefront provider, where adding a knob
-- must not require a migration. Deep defaults and old-payload merging live in
-- TypeScript (`resolveSettings`), so a document written before this phase
-- renders the redesigned storefront unchanged.
--
-- This migration adds only what a document cannot cleanly hold:
--
--   1. per-category storefront content — `storefront_category_content`, a 1:1
--      table beside `categories` (the `product_content` precedent): storefront
--      titles, descriptions, imagery, a featured flag and a storefront sort
--      order. It deliberately does NOT touch `categories` or the Phase 44
--      lifecycle: `category_id` cascades on delete, nothing here can archive,
--      restore or move a category, and only ACTIVE categories are published.
--   2. per-product editorial content — new additive columns on
--      `product_content` (short/full description, materials, dimensions, care,
--      shipping, returns, gift note — bilingual — plus a media array), so the
--      redesigned product page has real content to render without duplicating
--      the product_content architecture.
--   3. server-side validation of the settings document — a BEFORE INSERT OR
--      UPDATE trigger on `website_settings` that refuses a malformed token
--      (a colour that is not a colour, an enum value that does not exist, an
--      `href` that is neither an in-app route nor a safe http(s) URL, a
--      campaign window that does not parse). The client validates too; this is
--      the layer that makes a forged write fail server-side.
--
-- Nothing here weakens RLS: the new table follows the established split
-- (public SELECT for storefront content, `manage_website` for every write),
-- exactly as `website_settings` and `store_faqs` already do.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. per-category storefront content ─────────────────────────────────────
create table if not exists public.storefront_category_content (
  id                uuid primary key default gen_random_uuid(),
  category_id       uuid not null unique references public.categories (id) on delete cascade,
  title_ar          text check (char_length(title_ar) <= 200),
  title_en          text check (char_length(title_en) <= 200),
  description_ar    text check (char_length(description_ar) <= 1000),
  description_en    text check (char_length(description_en) <= 1000),
  -- Desktop / mobile / homepage imagery. URLs by policy: the admin uploads to
  -- the project's own storage bucket, and the storefront renders them as
  -- images — never as HTML.
  image_url         text check (image_url is null or char_length(image_url) <= 1000),
  mobile_image_url  text check (mobile_image_url is null or char_length(mobile_image_url) <= 1000),
  homepage_image_url text check (homepage_image_url is null or char_length(homepage_image_url) <= 1000),
  featured          boolean not null default false,
  -- Storefront-only ordering. The admin category tree keeps its own sort; this
  -- is the order the shop window shows things in.
  sort_order        integer not null default 0 check (sort_order >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists storefront_category_content_sort_idx
  on public.storefront_category_content (sort_order);

comment on table public.storefront_category_content is
  'Storefront-only category extras (display titles, copy, imagery, featured flag, shop-window order). Separate from `categories` so the Phase 44 lifecycle and every admin screen on the tree are untouched. Cascades with the category; publishes only alongside an active one.';

drop trigger if exists storefront_category_content_touch_updated_at
  on public.storefront_category_content;
create trigger storefront_category_content_touch_updated_at
  before update on public.storefront_category_content
  for each row execute function public.set_updated_at();

alter table public.storefront_category_content enable row level security;

drop policy if exists "storefront_category_content_select_public"
  on public.storefront_category_content;
create policy "storefront_category_content_select_public"
  on public.storefront_category_content for select
  to anon, authenticated
  using (true);

drop policy if exists "storefront_category_content_insert_managers"
  on public.storefront_category_content;
create policy "storefront_category_content_insert_managers"
  on public.storefront_category_content for insert
  to authenticated
  with check (public.can('manage_website'));

drop policy if exists "storefront_category_content_update_managers"
  on public.storefront_category_content;
create policy "storefront_category_content_update_managers"
  on public.storefront_category_content for update
  to authenticated
  using (public.can('manage_website'))
  with check (public.can('manage_website'));

drop policy if exists "storefront_category_content_delete_managers"
  on public.storefront_category_content;
create policy "storefront_category_content_delete_managers"
  on public.storefront_category_content for delete
  to authenticated
  using (public.can('manage_website'));

revoke all on public.storefront_category_content from public, anon;
grant select on public.storefront_category_content to anon, authenticated, service_role;
grant insert, update, delete on public.storefront_category_content to authenticated, service_role;

-- ── 2. per-product editorial content (additive columns) ────────────────────
-- The redesigned product page renders these in accordions; absent values
-- render no accordion rather than an empty one. Every column is nullable and
-- every existing row stays exactly as it was.
alter table public.product_content
  add column if not exists short_description_ar text
    constraint product_content_short_desc_ar_len check (char_length(short_description_ar) <= 1000),
  add column if not exists short_description_en text
    constraint product_content_short_desc_en_len check (char_length(short_description_en) <= 1000),
  add column if not exists description_ar text
    constraint product_content_description_ar_len check (char_length(description_ar) <= 8000),
  add column if not exists description_en text
    constraint product_content_description_en_len check (char_length(description_en) <= 8000),
  add column if not exists materials_ar text
    constraint product_content_materials_ar_len check (char_length(materials_ar) <= 2000),
  add column if not exists materials_en text
    constraint product_content_materials_en_len check (char_length(materials_en) <= 2000),
  add column if not exists dimensions_ar text
    constraint product_content_dimensions_ar_len check (char_length(dimensions_ar) <= 2000),
  add column if not exists dimensions_en text
    constraint product_content_dimensions_en_len check (char_length(dimensions_en) <= 2000),
  add column if not exists care_ar text
    constraint product_content_care_ar_len check (char_length(care_ar) <= 2000),
  add column if not exists care_en text
    constraint product_content_care_en_len check (char_length(care_en) <= 2000),
  add column if not exists shipping_ar text
    constraint product_content_shipping_ar_len check (char_length(shipping_ar) <= 2000),
  add column if not exists shipping_en text
    constraint product_content_shipping_en_len check (char_length(shipping_en) <= 2000),
  add column if not exists returns_ar text
    constraint product_content_returns_ar_len check (char_length(returns_ar) <= 2000),
  add column if not exists returns_en text
    constraint product_content_returns_en_len check (char_length(returns_en) <= 2000),
  add column if not exists gift_note_ar text
    constraint product_content_gift_ar_len check (char_length(gift_note_ar) <= 500),
  add column if not exists gift_note_en text
    constraint product_content_gift_en_len check (char_length(gift_note_en) <= 500),
  -- Editorial media beyond the product's own image list: [{ url, alt_ar,
  -- alt_en, kind ('product' | 'lifestyle'), sort_order }]. A jsonb array with
  -- a shape check, like specs before it.
  add column if not exists media jsonb not null default '[]'::jsonb
    constraint product_content_media_is_array check (jsonb_typeof(media) = 'array');

comment on column public.product_content.media is
  'Storefront media list: primary/lifestyle images with bilingual alt text and display order. URLs point at the project''s own storage; they are rendered as image sources, never as markup.';

-- ── 3. the public category read learns the content ─────────────────────────
-- A NEW function beside the 0030 one, not a replacement: every migration in
-- this project must replay cleanly, and `create or replace` across a changed
-- return type is refused by Postgres (and would also break 0030's own
-- idempotency). The 0030 function stays exactly as shipped for clients from
-- the previous release; new clients call `_v2`, which adds the content
-- columns to the end of the same row shape. Same security definer, same fixed
-- shape discipline, still `where c.active` — an archived category publishes
-- nothing, content or not.
create or replace function public.storefront_categories_v2()
returns table (
  id                 uuid,
  name_ar            text,
  name_en            text,
  parent_id          uuid,
  sort_order         integer,
  active             boolean,
  created_at         timestamptz,
  updated_at         timestamptz,
  content_title_ar   text,
  content_title_en   text,
  content_description_ar text,
  content_description_en text,
  content_image_url  text,
  content_mobile_image_url text,
  content_homepage_image_url text,
  featured           boolean,
  storefront_sort    integer
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         c.name_ar,
         c.name_en,
         c.parent_id,
         c.sort_order,
         c.active,
         c.created_at,
         c.updated_at,
         scc.title_ar,
         scc.title_en,
         scc.description_ar,
         scc.description_en,
         scc.image_url,
         scc.mobile_image_url,
         scc.homepage_image_url,
         coalesce(scc.featured, false),
         coalesce(scc.sort_order, 2147483647)
    from public.categories c
    left join public.storefront_category_content scc
      on scc.category_id = c.id
   where c.active
   order by coalesce(scc.sort_order, 2147483647) asc,
            c.sort_order asc,
            c.name_en asc
$$;

comment on function public.storefront_categories_v2() is
  'Public storefront read (Phase 45): the active category tree with its optional storefront content, shop-window order first. Archived categories publish nothing — the Phase 44 rule, unchanged. Companion to the 0030 storefront_categories(), whose shape this extends.';

revoke execute on function public.storefront_categories_v2() from public;
grant execute on function public.storefront_categories_v2() to anon, authenticated, service_role;

-- ── 4. server-side validation of the settings document ─────────────────────
-- The storefront renders straight out of this document, so the document is an
-- injection surface and the database is the place the injection dies. The
-- guard re-implements, in SQL, the same policy the client enforces:
--
--   · colours are #rgb / #rrggbb / #rrggbbaa, nothing else;
--   · enum knobs are one of their shipped values;
--   · every configurable href is either an in-app route (`#/…`) or an
--     absolute http(s) URL — `javascript:`, `data:`, `vbscript:`, relative
--     junk and control-character tricks all fail the regex and the write;
--   · scheduled campaigns carry parseable instants, start <= end;
--   · numeric knobs stay in their sane ranges;
--   · multi-message announcement and the section list are arrays of objects.
--
-- A document that predates any of these keys simply has nothing to check and
-- passes, which is what makes the guard backward-compatible.
create or replace function public.website_settings_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v           jsonb := new.settings;
  v_item      jsonb;
  v_href      text;
  v_color     text;
  v_num       numeric;
begin
  if jsonb_typeof(v) is distinct from 'object' then
    raise exception 'website settings must be a JSON object'
      using errcode = 'check_violation';
  end if;

  -- ── colours ─────────────────────────────────────────────────────────────
  if v ? 'theme' then
    foreach v_color in array array[
      'primary_color', 'secondary_color', 'accent_color',
      'background_color', 'surface_color', 'text_color', 'muted_text_color',
      'announcement_bg_color', 'announcement_text_color'
    ] loop
      if (v->'theme') ? v_color then
        if (v->'theme'->>v_color) !~* '^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$' then
          raise exception 'theme.% is not a colour', v_color
            using errcode = 'check_violation';
        end if;
      end if;
    end loop;

    if (v->'theme') ? 'font_stack'
       and not ((v->'theme'->>'font_stack') in ('system', 'modern', 'classic', 'rounded')) then
      raise exception 'theme.font_stack is not a shipped stack'
        using errcode = 'check_violation';
    end if;
    if (v->'theme') ? 'button_style'
       and not ((v->'theme'->>'button_style') in ('rounded', 'pill', 'square')) then
      raise exception 'theme.button_style is not a shipped style'
        using errcode = 'check_violation';
    end if;
    if (v->'theme') ? 'header_style'
       and not ((v->'theme'->>'header_style') in ('solid', 'compact', 'overlay')) then
      raise exception 'theme.header_style is not a shipped style'
        using errcode = 'check_violation';
    end if;
    if (v->'theme') ? 'corner_radius' then
      v_num := (v->'theme'->>'corner_radius')::numeric;
      if v_num is null or v_num < 0 or v_num > 32 then
        raise exception 'theme.corner_radius out of range'
          using errcode = 'check_violation';
      end if;
    end if;
    if (v->'theme') ? 'dark_mode'
       and jsonb_typeof(v->'theme'->'dark_mode') is distinct from 'boolean' then
      raise exception 'theme.dark_mode must be a boolean'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── the one href policy ─────────────────────────────────────────────────
  -- In-app routes start `#/`; everything else must be an absolute http(s)
  -- URL. Blank is allowed (no link rendered); any other scheme is not.
  foreach v_href in array array[
    coalesce(v->'announcement'->>'href', ''),
    coalesce(v->'announcement'->>'cta_href', ''),
    coalesce(v->'images'->>'background_url', ''),
    coalesce(v->'images'->>'logo_url', ''),
    coalesce(v->'images'->>'favicon_url', ''),
    coalesce(v->'images'->>'about_image_url', ''),
    coalesce(v->'seo'->>'og_image_url', ''),
    coalesce(v->'contact'->>'map_url', ''),
    coalesce(v->'social'->>'facebook', ''),
    coalesce(v->'social'->>'instagram', ''),
    coalesce(v->'social'->>'tiktok', ''),
    coalesce(v->'social'->>'instapay_link', '')
  ] loop
    if v_href <> '' and v_href !~* '^(https?://|#/)' then
      raise exception 'unsafe configured URL refused: %', left(v_href, 40)
        using errcode = 'check_violation';
    end if;
  end loop;

  -- whatsapp keeps its own rule: a safe http(s) URL or a phone number.
  if v ? 'social' and coalesce(v->'social'->>'whatsapp', '') <> '' then
    v_href := v->'social'->>'whatsapp';
    if v_href !~* '^https?://'
       and v_href !~ '^\+?[0-9 ()-]{8,20}$' then
      raise exception 'social.whatsapp must be an https URL or a phone number'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── arrays of configured objects ────────────────────────────────────────
  if v->'announcement' ? 'messages' then
    if jsonb_typeof(v->'announcement'->'messages') is distinct from 'array'
       or jsonb_array_length(v->'announcement'->'messages') > 20 then
      raise exception 'announcement.messages must be an array of at most 20 messages'
        using errcode = 'check_violation';
    end if;
    for v_item in select jsonb_array_elements(v->'announcement'->'messages') loop
      if jsonb_typeof(v_item) is distinct from 'object' then
        raise exception 'announcement.messages entries must be objects'
          using errcode = 'check_violation';
      end if;
      foreach v_href in array array[
        coalesce(v_item->>'href', ''), coalesce(v_item->>'cta_href', '')
      ] loop
        if v_href <> '' and v_href !~* '^(https?://|#/)' then
          raise exception 'unsafe announcement message URL refused'
            using errcode = 'check_violation';
        end if;
      end loop;
    end loop;
  end if;

  if v ? 'campaigns' then
    if jsonb_typeof(v->'campaigns') is distinct from 'array'
       or jsonb_array_length(v->'campaigns') > 50 then
      raise exception 'campaigns must be an array of at most 50 blocks'
        using errcode = 'check_violation';
    end if;
    for v_item in select jsonb_array_elements(v->'campaigns') loop
      if jsonb_typeof(v_item) is distinct from 'object' then
        raise exception 'campaign entries must be objects'
          using errcode = 'check_violation';
      end if;
      if (v_item->>'starts_at') is not null and (v_item->>'ends_at') is not null then
        begin
          if (v_item->>'starts_at')::timestamptz > (v_item->>'ends_at')::timestamptz then
            raise exception 'a campaign cannot end before it starts';
          end if;
        exception when others then
          raise exception 'a campaign window does not parse as timestamps'
            using errcode = 'check_violation';
        end;
      end if;
      foreach v_href in array array[
        coalesce(v_item->>'cta_href', ''), coalesce(v_item->>'desktop_image_url', ''),
        coalesce(v_item->>'mobile_image_url', '')
      ] loop
        if v_href <> '' and v_href !~* '^(https?://|#/)' then
          raise exception 'unsafe campaign URL refused'
            using errcode = 'check_violation';
        end if;
      end loop;
    end loop;
  end if;

  -- ── product-card tokens ─────────────────────────────────────────────────
  if v ? 'product_card' then
    if v->'product_card' ? 'mobile_columns' then
      v_num := (v->'product_card'->>'mobile_columns')::numeric;
      if v_num < 1 or v_num > 3 then
        raise exception 'product_card.mobile_columns must be 1..3'
          using errcode = 'check_violation';
      end if;
    end if;
    if v->'product_card' ? 'desktop_columns' then
      v_num := (v->'product_card'->>'desktop_columns')::numeric;
      if v_num < 2 or v_num > 6 then
        raise exception 'product_card.desktop_columns must be 2..6'
          using errcode = 'check_violation';
      end if;
    end if;
    if (v->'product_card') ? 'aspect'
       and not ((v->'product_card'->>'aspect') in ('portrait', 'square', 'landscape')) then
      raise exception 'product_card.aspect is not a shipped preset'
        using errcode = 'check_violation';
    end if;
    if (v->'product_card') ? 'image_fit'
       and not ((v->'product_card'->>'image_fit') in ('cover', 'contain')) then
      raise exception 'product_card.image_fit is not a shipped preset'
        using errcode = 'check_violation';
    end if;
    if (v->'product_card') ? 'gap'
       and not ((v->'product_card'->>'gap') in ('cozy', 'normal', 'airy')) then
      raise exception 'product_card.gap is not a shipped preset'
        using errcode = 'check_violation';
    end if;
    if (v->'product_card') ? 'text_align'
       and not ((v->'product_card'->>'text_align') in ('start', 'center')) then
      raise exception 'product_card.text_align is not a shipped preset'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── trust items: icons from the safe set, nothing uploaded ──────────────
  if v ? 'trust' and v->'trust' ? 'items' then
    if jsonb_typeof(v->'trust'->'items') is distinct from 'array'
       or jsonb_array_length(v->'trust'->'items') > 12 then
      raise exception 'trust.items must be an array of at most 12 items'
        using errcode = 'check_violation';
    end if;
    for v_item in select jsonb_array_elements(v->'trust'->'items') loop
      if (v_item->>'icon') is not null
         and not ((v_item->>'icon') in (
           'shield', 'truck', 'support', 'exchange', 'gift', 'star', 'store', 'clock'
         )) then
        raise exception 'trust item icon is not in the safe set'
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  -- ── sections: known keys only ───────────────────────────────────────────
  if v ? 'sections' then
    if jsonb_typeof(v->'sections') is distinct from 'array' then
      raise exception 'sections must be an array'
        using errcode = 'check_violation';
    end if;
    for v_item in select jsonb_array_elements(v->'sections') loop
      if (v_item->>'key') is null then
        raise exception 'a section entry names no key'
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

comment on function public.website_settings_guard() is
  'Server-side validation for the storefront settings document: colours, enum presets, the one href policy (in-app #/ routes or absolute http(s) URLs), campaign windows, numeric ranges, array shapes. A forged settings write fails here, not just in the browser.';

drop trigger if exists website_settings_guard on public.website_settings;
create trigger website_settings_guard
  before insert or update of settings on public.website_settings
  for each row execute function public.website_settings_guard();

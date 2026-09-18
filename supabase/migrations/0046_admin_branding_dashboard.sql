-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0046 — shared admin branding (Phase 46)
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 46 needs exactly one database thing: server-side validation of the new
-- `brand` group in the `website_settings` document. There is no new table and
-- no new column — the brand is stored ONCE, inside the same settings document
-- the storefront already reads (the primary logo remains the storefront's
-- existing `images.logo_url`; `brand` adds the compact mark, an optional
-- dark-surface logo, bilingual display-name overrides and the receipt toggle).
-- Deep defaults and old-payload merging live in TypeScript
-- (`resolveSettings`), so documents written before this phase resolve with a
-- complete `brand` object and render unchanged.
--
-- This migration replaces the `website_settings_guard()` trigger function
-- with the same signature it has had since 0045 (so the existing trigger
-- definition keeps working) and extends its checks with the brand group:
--
--   · the three brand URLs obey the one href policy — an in-app `#/…` route
--     or an absolute http(s) URL, blank allowed, any other scheme refused —
--     exactly the rule every other configurable URL already follows;
--   · `receipt_logo_enabled` must be a boolean;
--   · display names are bounded text.
--
-- Everything else in this function is byte-for-byte the 0045 guard, carried
-- forward unchanged: a later migration re-stating a trigger function must
-- never silently drop the checks that came before it.
--
-- Like the client's `sanitizeSettings`, this is the layer that makes a forged
-- branding write fail server-side, not just in the browser. RLS on
-- `website_settings` is unchanged: only managers write, everyone reads.
-- ═══════════════════════════════════════════════════════════════════════════

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
    coalesce(v->'social'->>'instapay_link', ''),
    coalesce(v->'brand'->>'mark_url', ''),
    coalesce(v->'brand'->>'logo_dark_url', '')
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

  -- ── brand (Phase 46) ────────────────────────────────────────────────────
  if v ? 'brand' then
    if jsonb_typeof(v->'brand') is distinct from 'object' then
      raise exception 'brand must be an object'
        using errcode = 'check_violation';
    end if;
    if (v->'brand') ? 'receipt_logo_enabled'
       and jsonb_typeof(v->'brand'->'receipt_logo_enabled') is distinct from 'boolean' then
      raise exception 'brand.receipt_logo_enabled must be a boolean'
        using errcode = 'check_violation';
    end if;
    foreach v_item in array array['display_name_ar', 'display_name_en'] loop
      if (v->'brand') ? v_item
         and length(coalesce(v->'brand'->>v_item, '')) > 60 then
        raise exception 'brand.% is longer than 60 characters', v_item
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
  'Server-side validation for the storefront settings document: colours, enum presets, the one href policy (in-app #/ routes or absolute http(s) URLs), campaign windows, numeric ranges, array shapes, and (0046) the shared brand group. A forged settings write fails here, not just in the browser.';

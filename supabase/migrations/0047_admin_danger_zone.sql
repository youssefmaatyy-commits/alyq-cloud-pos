-- ═══════════════════════════════════════════════════════════════════════════
-- ALYQ Cloud POS · 0047 — the Danger Zone (Phase 47)
-- ═══════════════════════════════════════════════════════════════════════════
-- Three server-authorized, atomic, auditable reset operations:
--
--   system_reset_preview(mode, options)        read-only counts (no mutation)
--   system_clear_operational_data(...)         Mode 1 — day-to-day activity
--   system_factory_reset(...)                  Mode 2 — catalogue + config too
--   system_reset_report_failure(...)           Mode 1/2 failure bookkeeping
--
-- Everything destructive lives here, in ONE SQL statement per call. A browser
-- can never perform a reset by iterating tables over REST: there is no such
-- endpoint. Each RPC independently verifies, in order:
--
--   1. the caller is an active profile with `manage_system_reset`
--      (public.can() — role matrix + custom roles + per-profile overrides);
--   2. the re-auth freshness window is open (the CLIENT proved the current
--      password through the existing auth service moments before; the raw
--      password never reaches the database — see the service in
--      src/modules/settings/services/systemReset.ts);
--   3. the confirmation phrase matches exactly ('DELETE OPERATIONAL DATA' /
--      'DELETE ALL DATA', whitespace-trimmed, case-normalized) — the phrase is
--      a deliberateness gate, NOT the authorization: the capability check
--      above is what refuses a forged call;
--   4. option keys are known (an unknown key aborts the whole thing);
--   5. at least one active admin profile survives (before AND after the
--      deletes — profiles are never deleted, but the check proves the
--      invariant inside the same transaction, so it can never be false).
--
-- Atomicity: a function called through PostgREST runs in ONE transaction. Any
-- failure between the first delete and the final audit row aborts everything —
-- there are no half-deleted sales, orphans or broken rollups, ever.
--
-- Delete order follows the REAL foreign keys (audited, not guessed):
--   stock_reservations, order_events, online_order_items → online_orders
--   refund_records, return_items → sales_returns; sale_payments, sale_items → sales
--   sales (restricted by returns/refunds/items → deleted last of the sale tree)
--   stock_movements → products RESTRICT (cleared before products, never after)
--   expenses → shifts SET NULL (expenses deleted before shifts for counting)
--   store_reviews/product_content/catalogue_codes/product_variants → products CASCADE
--   storefront_category_content → categories CASCADE; products → categories RESTRICT
--   categories.parent → categories RESTRICT (deleted deepest-first, looped)
--
-- Variant semantics (Phase 43): a variant product's rollup is written ONLY by
-- the variants_sync_product_stock trigger. The inventory reset updates
-- product_variants.stock_quantity and lets the trigger produce the rollup —
-- the direct rollup write is refused by the 0043 guard and never attempted.
--
-- Audit survival: public.audit_log is append-only by trigger (0013) — no mode
-- here offers clearing it in live mode, so the reset's own record always
-- survives. In demo mode the local trail may be cleared, and the demo service
-- writes its final event AFTER the cleanup for the same guarantee.
--
-- The auth schema is never touched: no mode deletes auth.users or profiles, so
-- "reset demo data" exists only where data is genuinely marked demo (the local
-- demo repositories), never as a live row filter — there is no is_demo column
-- in this schema, and inventing one is refused.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. vocabulary + capability ─────────────────────────────────────────────

insert into public.audit_actions (action, entity) values
  ('system.reset.started',   'system'),
  ('system.reset.succeeded', 'system'),
  ('system.reset.failed',    'system')
on conflict (action) do nothing;

-- The narrowest capability in the model: admin only. Mirrored in
-- src/lib/permissions/roles.ts (the parity check fails if either side moves
-- alone). Custom roles cannot be granted it: it is deliberately absent from
-- the granular builder set.
insert into public.role_capabilities (role, capability)
values ('admin', 'manage_system_reset')
on conflict (role, capability) do nothing;

-- ── 2. shared guards ───────────────────────────────────────────────────────

-- ── the 0046 guard, carried forward with one type fix ───────────────────────
-- The Danger Zone's settings surgery (factory reset) writes through this
-- trigger, and the Phase 47 scenario drove a brand write through it for the
-- first time — exposing a latent defect: the brand-length loop assigned its
-- TEXT array items into `v_item jsonb`, so any live-mode Branding save would
-- die with "invalid input syntax for type json". 0046 cannot be edited; this
-- re-statement carries the function forward byte-for-byte except for a new
-- `v_name text` loop variable. Every check from 0045 and 0046 is preserved.
create or replace function public.website_settings_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v           jsonb := new.settings;
  v_item      jsonb;
  v_name      text;
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
    -- v_name, not v_item: the array is TEXT and v_item is jsonb — assigning
    -- the loop variable directly fails with "invalid input syntax for type
    -- json" on the first brand write. Fixed here (0047) because this guard is
    -- the one function every later migration re-states; the check it runs is
    -- unchanged.
    foreach v_name in array array['display_name_ar', 'display_name_en'] loop
      if (v->'brand') ? v_name
         and length(coalesce(v->'brand'->>v_name, '')) > 60 then
        raise exception 'brand.% is longer than 60 characters', v_name
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

drop trigger if exists website_settings_guard on public.website_settings;
create trigger website_settings_guard
  before insert or update of settings on public.website_settings
  for each row execute function public.website_settings_guard();


-- The invariant the whole phase exists to protect: at least one ACTIVE admin
-- profile exists, and (when p_actor is given) that actor is still one of them.
-- Called before the deletes and again after them, inside the same transaction.
create or replace function public.system_assert_super_admin(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admins integer;
begin
  select count(*) into v_admins
    from public.profiles
   where role = 'admin' and active;

  if v_admins < 1 then
    raise exception 'SUPER_ADMIN_LOST: no active admin profile would survive this operation'
      using errcode = 'insufficient_privilege';
  end if;

  if p_actor is not null then
    if not exists (
      select 1 from public.profiles
       where id = p_actor and role = 'admin' and active
    ) then
      raise exception 'SUPER_ADMIN_LOST: the acting admin would not survive this operation'
      using errcode = 'insufficient_privilege';
    end if;
  end if;
end;
$$;

-- Capability + freshness gate shared by every destructive entry point.
-- Returns the caller's profile id. The freshness stamp comes from the client's
-- successful re-authentication through the existing auth service; the window
-- is deliberately short (10 minutes) so a stale prompt cannot authorize a
-- reset an hour later. The password itself is verified by the auth provider —
-- it is never sent here, never stored, never logged.
-- The re-auth PROOF, not the re-auth theatre: the browser asking for the
-- current password proves nothing server-side, and p_fresh_until is a stamp
-- the client made up. What proves identity is the password itself, checked
-- HERE against the auth credential through pgcrypto, on EVERY destructive
-- call. (Phase 48 amendment: the original release trusted the client's
-- freshness stamp alone, which let a hijacked admin session call the
-- destructive RPCs directly.)
--
-- Why there is no failed-attempt counter here, deliberately: a failed RPC is
-- one rolled-back statement, so any failure tally written inside it dies with
-- the raise — Postgres has no autonomous transactions. A counter that never
-- fires would be security theatre. The brute-force posture is therefore the
-- honest one: every single guess is a full authenticated API request against
-- a bcrypt check, rate-limitable at the gateway (see the deployment plan's
-- "enable restrictive API rate limits" step).
--
-- Where pgcrypto landed differs by environment (the `extensions` schema on
-- hosted Supabase, elsewhere the default schema). Resolve it once, here, and
-- bake the qualified call into this wrapper. SECURITY DEFINER because
-- auth.users is not readable by the wire role; the wrapper is revoked below,
-- so it is reachable only from inside the definer RPCs.
do $reauth_proof$
declare
  v_ns text;
begin
  create extension if not exists pgcrypto;
  select n.nspname into v_ns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.proname = 'crypt' and p.pronargs = 2
  order by case when n.nspname = 'extensions' then 0 else 1 end
  limit 1;
  if v_ns is null then
    raise exception '0047: pgcrypto.crypt(text,text) is not available';
  end if;
  execute format($fn$
    create or replace function public.system_password_matches(p_password text, p_uid uuid)
    returns boolean
    language sql
    stable
    security definer
    set search_path = public, %I
    as $body$
      select exists (
        select 1
        from auth.users u
        where u.id = p_uid
          and u.encrypted_password is not null
          and crypt(p_password, u.encrypted_password) = u.encrypted_password
      )
    $body$;
  $fn$, v_ns);
end;
$reauth_proof$;

revoke all on function public.system_password_matches(text, uuid) from public;
revoke all on function public.system_password_matches(text, uuid) from anon;
revoke all on function public.system_password_matches(text, uuid) from authenticated;

create or replace function public.system_assert_authorized(
  p_fresh_until timestamptz,
  p_confirmation text,
  p_expected_phrase text,
  p_password text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_role   public.app_role;
  v_active boolean;
begin
  if v_uid is null then
    raise exception 'RESET_UNAUTHORIZED: sign in first'
      using errcode = 'insufficient_privilege';
  end if;

  select role, active into v_role, v_active from public.profiles where id = v_uid;
  if not coalesce(v_active, false) then
    raise exception 'RESET_UNAUTHORIZED: the profile is inactive'
      using errcode = 'insufficient_privilege';
  end if;

  -- Capability, the way every other server decision reads it: the role matrix,
  -- custom roles and per-profile overrides through public.can().
  if not public.can('manage_system_reset') then
    raise exception 'RESET_UNAUTHORIZED: manage_system_reset is required'
      using errcode = 'insufficient_privilege';
  end if;

  if v_role is distinct from 'admin' then
    -- Belt and braces: the capability is admin-only by construction of the
    -- matrix, so this row should be unreachable. If a future migration ever
    -- widened the grant, the reset switch stays with the admin role alone.
    raise exception 'RESET_UNAUTHORIZED: the Danger Zone is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  -- Freshness narrows the window; it is the weaker half of the proof and
  -- never sufficient alone.
  if p_fresh_until is null or p_fresh_until < now() - interval '10 minutes' or p_fresh_until > now() + interval '10 minutes' then
    raise exception 'RESET_REAUTH_REQUIRED: re-enter the current password first'
      using errcode = 'insufficient_privilege';
  end if;

  -- The password itself, verified against the auth credential. A stamped
  -- window from the browser is not evidence; this is.
  if p_password is null or btrim(p_password) = '' then
    raise exception 'RESET_REAUTH_REQUIRED: re-enter the current password first'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.system_password_matches(btrim(p_password), v_uid) then
    raise exception 'RESET_REAUTH_REQUIRED: that current password was not accepted'
      using errcode = 'insufficient_privilege';
  end if;

  if btrim(coalesce(p_confirmation, '')) <> p_expected_phrase then
    raise exception 'RESET_PHRASE_MISMATCH: type % to confirm', p_expected_phrase;
  end if;

  return v_uid;
end;
$$;
-- Reject unknown option keys outright: a typo must abort, never silently do
-- less (or more) than the screen promised.
create or replace function public.system_assert_options(
  p_options jsonb,
  p_allowed text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  if p_options is null or jsonb_typeof(p_options) is distinct from 'object' then
    raise exception 'RESET_BAD_OPTIONS: options must be an object';
  end if;
  for v_key in select jsonb_object_keys(p_options)
  loop
    if not (v_key = any (p_allowed)) then
      raise exception 'RESET_BAD_OPTIONS: unknown option "%"', v_key;
    end if;
  end loop;
end;
$$;

-- ── 3. preview (read-only; proves the counts come from the server) ─────────

create or replace function public.system_reset_preview(
  p_mode text,
  p_options jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_opt   text;
  v_ops   jsonb := '{}'::jsonb;
  v_del   jsonb := '[]'::jsonb;
  v_keep  jsonb := '[]'::jsonb;
  v_entry jsonb;
begin
  if not public.can('manage_system_reset') then
    raise exception 'RESET_UNAUTHORIZED: manage_system_reset is required'
      using errcode = 'insufficient_privilege';
  end if;
  if p_mode not in ('operational', 'factory') then
    raise exception 'RESET_BAD_MODE: %', p_mode;
  end if;

  if p_mode = 'operational' then
    perform public.system_assert_options(p_options,
      array['sales','returns','orders','shifts','expenses','customers','movements','quantities']);
    -- "POS sales" carries the returns tree with it: a sale with a return on it
    -- cannot be deleted (sales_returns → sales RESTRICT). The server states
    -- the implication instead of failing late.
    v_ops := p_options
      || jsonb_build_object('returns',
           coalesce((p_options->>'returns')::boolean, false)
           or coalesce((p_options->>'sales')::boolean, false));
  else
    perform public.system_assert_options(p_options,
      array['products','categories','customers','website','branding','delivery_payment']);
    -- Factory always clears the operational floor beneath the catalogue.
    v_ops := jsonb_build_object(
      'sales', true, 'returns', true, 'orders', true, 'shifts', true,
      'expenses', true, 'movements', true,
      'customers', coalesce((p_options->>'customers')::boolean, false),
      'quantities', false);
  end if;

  for v_opt in select jsonb_object_keys(v_ops)
  loop
    v_entry := jsonb_build_object(
      'group', v_opt,
      'action', case when (v_ops->>v_opt)::boolean then 'delete' else 'preserve' end
    );
    case v_opt
      when 'sales' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.sales));
      when 'returns' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.sales_returns));
      when 'orders' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.online_orders));
      when 'shifts' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.shifts));
      when 'expenses' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.expenses));
      when 'customers' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.customers) + (select count(*) from public.store_customers));
      when 'movements' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.stock_movements));
      when 'quantities' then
        v_entry := jsonb_build_object('group', 'quantities',
          'action', case when (v_ops->>'quantities')::boolean then 'reset' else 'preserve' end,
          'count',
          (select count(*) from public.products where stock_quantity > 0)
          + (select count(*) from public.product_variants where stock_quantity > 0));
      when 'products' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.products));
      when 'categories' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.categories));
      when 'website' then
        v_entry := v_entry || jsonb_build_object('count',
          (select count(*) from public.campaigns)
          + (select count(*) from public.store_faqs)
          + (select count(*) from public.storefront_category_content));
      when 'branding' then
        v_entry := v_entry || jsonb_build_object('count',
          case when coalesce(public.website_settings.settings->'brand', '{}'::jsonb) <> '{}'::jsonb
                or coalesce(public.website_settings.settings->'images'->>'logo_url', '') <> ''
               and (select count(*) from public.website_settings) > 0
               then 1 else 0 end);
      when 'delivery_payment' then
        v_entry := v_entry || jsonb_build_object('count',
          case when coalesce(public.website_settings.settings->'delivery', '{}'::jsonb) <> '{}'::jsonb
                and (select count(*) from public.website_settings) > 0
               then 1 else 0 end);
      else
        v_entry := null;
    end case;
    if v_entry is not null then
      if (v_entry->>'action') = 'preserve' then
        v_keep := v_keep || jsonb_build_array(v_entry);
      else
        v_del := v_del || jsonb_build_array(v_entry);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'mode', p_mode,
    'effective_options', v_ops,
    'delete', v_del,
    'preserve', v_keep,
    'protected_admin', (
      select jsonb_build_object('username', p.username, 'name', p.name)
        from public.profiles p
       where p.role = 'admin' and p.active
       order by p.created_at
       limit 1
    ),
    'schema_note', 'Schema, migrations, RLS and auth accounts are never touched.'
  );
end;
$$;

-- ── 4. Mode 1 — clear operational data ─────────────────────────────────────

create or replace function public.system_clear_operational_data(
  p_options jsonb,
  p_confirmation text,
  p_fresh_until timestamptz,
  p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid;
  v_ops      jsonb;
  v_deleted  jsonb := '{}'::jsonb;
  v_actor    text;
  v_counts   integer := 0;
begin
  v_uid := public.system_assert_authorized(p_fresh_until, p_confirmation, 'DELETE OPERATIONAL DATA', p_password);

  perform public.system_assert_options(p_options,
    array['sales','returns','orders','shifts','expenses','customers','movements','quantities','audit']);
  -- `audit` is accepted-and-refused live: the trail is append-only by trigger
  -- (0013). A client that somehow sent it gets a clear "preserve" in the
  -- summary rather than a surprise.
  v_ops := p_options
    || jsonb_build_object('returns',
         coalesce((p_options->>'returns')::boolean, false)
         or coalesce((p_options->>'sales')::boolean, false))
    || jsonb_build_object('audit', false);

  perform public.system_assert_super_admin(v_uid);

  select name into v_actor from public.profiles where id = v_uid;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.started', 'system', 'operational', 'Clear operational data',
          jsonb_build_object('mode', 'operational', 'options', v_ops),
          v_uid::text, v_actor);

  -- Website orders tree (items/events/reservations cascade with the order).
  if coalesce((v_ops->>'orders')::boolean, false) then
    delete from public.stock_reservations;
    delete from public.order_events;
    delete from public.online_order_items;
    delete from public.online_orders;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{online_orders}', to_jsonb(v_counts));
  end if;

  -- The return tree first: sales_returns → sales RESTRICT means a sale can
  -- never leave while its return stands, and refund_records.return_id is
  -- ON DELETE SET NULL — an UPDATE the 0016 "the money is fixed" trigger
  -- refuses — so the refunds leave with the returns, before them. "POS sales"
  -- carries returns with it (the effective options above), so this branch
  -- always runs in a sales clear.
  if coalesce((v_ops->>'returns')::boolean, false) then
    delete from public.refund_records;
    delete from public.return_items;
    delete from public.sales_returns;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{returns}', to_jsonb(v_counts));
  end if;

  -- Then the sale tree, restricted leaves first.
  if coalesce((v_ops->>'sales')::boolean, false) then
    delete from public.sale_payments;
    delete from public.sale_items;
    delete from public.sales;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{sales}', to_jsonb(v_counts));
  end if;

  if coalesce((v_ops->>'movements')::boolean, false) then
    delete from public.stock_movements;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{stock_movements}', to_jsonb(v_counts));
  end if;

  if coalesce((v_ops->>'expenses')::boolean, false) then
    delete from public.expenses;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{expenses}', to_jsonb(v_counts));
  end if;

  if coalesce((v_ops->>'shifts')::boolean, false) then
    delete from public.shifts;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{shifts}', to_jsonb(v_counts));
  end if;

  if coalesce((v_ops->>'customers')::boolean, false) then
    -- Returns/orders already gone or pointing away (SET NULL), so no restrict
    -- can fire; store_customers are the website's book of the same people.
    delete from public.store_customers;
    delete from public.customers;
    get diagnostics v_counts = row_count;
    v_deleted := jsonb_set(v_deleted, '{customers}', to_jsonb(v_counts));
  end if;

  -- Inventory reset: zero the SHELF OF RECORD and let the 0043 trigger write
  -- the rollup (a direct products write is refused for variant products).
  -- With movement history preserved, each emptied shelf gets one `recount`
  -- movement so the ledger still sums to the shelf; with movements cleared,
  -- the ledger starts empty and consistent.
  if coalesce((v_ops->>'quantities')::boolean, false) then
    update public.products set stock_quantity = 0 where not variants_enabled and stock_quantity <> 0;

    insert into public.stock_movements (
      product_id, variant_id, delta, quantity_before, quantity_after,
      type, reason, notes, user_id, user_name
    )
    select v.product_id, v.id, v.stock_quantity, v.stock_quantity, 0,
           'adjustment_out', 'recount', 'Danger Zone inventory reset', v_uid::text, v_actor
      from public.product_variants v
     where v.stock_quantity > 0;

    update public.product_variants set stock_quantity = 0 where stock_quantity <> 0;

    -- Plain products' recount rows (variants' are written above; the product
    -- rollup follows its trigger and must not be double-counted).
    insert into public.stock_movements (
      product_id, delta, quantity_before, quantity_after,
      type, reason, notes, user_id, user_name
    )
    select p.id, greatest(p.stock_quantity, 0), p.stock_quantity, 0,
           'adjustment_out', 'recount', 'Danger Zone inventory reset', v_uid::text, v_actor
      from public.products p
     where p.stock_quantity > 0;

    v_deleted := jsonb_set(v_deleted, '{inventory_reset}', to_jsonb(true));
  end if;

  -- Post-verify inside the transaction: if this ever failed, the whole
  -- operation rolls back — data and audit row together.
  perform public.system_assert_super_admin(v_uid);

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.succeeded', 'system', 'operational', 'Clear operational data',
          jsonb_build_object('mode', 'operational', 'options', v_ops, 'deleted', v_deleted),
          v_uid::text, v_actor);

  return jsonb_build_object(
    'mode', 'operational',
    'deleted', v_deleted,
    'preserved', jsonb_build_object(
      'products', (select count(*) from public.products),
      'variants', (select count(*) from public.product_variants),
      'categories', (select count(*) from public.categories),
      'profiles', (select count(*) from public.profiles where active),
      'website_settings', true,
      'branding', true
    )
  );
end;
$$;

-- ── 5. Mode 2 — factory reset ──────────────────────────────────────────────

create or replace function public.system_factory_reset(
  p_options jsonb,
  p_confirmation text,
  p_fresh_until timestamptz,
  p_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid;
  v_opts     jsonb;
  v_settings jsonb;
  v_section  jsonb;
  v_deleted  jsonb := '{}'::jsonb;
  v_actor    text;
  v_counts   integer := 0;
  v_depth    integer := 0;
begin
  v_uid := public.system_assert_authorized(p_fresh_until, p_confirmation, 'DELETE ALL DATA', p_password);

  perform public.system_assert_options(p_options,
    array['products','categories','customers','website','branding','delivery_payment']);
  v_opts := p_options;

  perform public.system_assert_super_admin(v_uid);
  select name into v_actor from public.profiles where id = v_uid;

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.started', 'system', 'factory', 'Factory reset',
          jsonb_build_object('mode', 'factory', 'options', v_opts),
          v_uid::text, v_actor);

  -- ── the operational floor, always ────────────────────────────────────────
  delete from public.stock_reservations;
  delete from public.order_events;
  delete from public.online_order_items;
  delete from public.online_orders;

  delete from public.refund_records;
  delete from public.sale_payments;
  delete from public.sale_items;
  delete from public.sales;

  delete from public.return_items;
  delete from public.sales_returns;

  -- approval_requests are NOT cleared: their invariant trigger (0023) refuses
  -- every delete — they are the record of a decision, audit-class data, and
  -- the Danger Zone does not overrule that. Their numbering counter stays too,
  -- so no future request reuses a number a preserved record already carries.

  delete from public.expenses;
  delete from public.shifts;

  v_deleted := jsonb_set(v_deleted, '{operational}', to_jsonb(true));

  -- Test-only interruption point (the rollback proof in supabase/tests/
  -- scenarios.sql). Armed ONLY through a transaction-local custom GUC, which
  -- PostgREST cannot set from a request: no browser, no forged REST call, no
  -- UI state can reach this. It requires direct SQL access to the database —
  -- at which point the database is already in the caller's hands. Never set
  -- in production; checked and forgotten in microseconds.
  if current_setting('dz.force_failure', true) = 'factory' then
    raise exception 'DZ_TEST_INTERRUPT'
      using errcode = 'check_violation';
  end if;

  if coalesce((v_opts->>'customers')::boolean, false) then
    delete from public.store_customers;
    delete from public.customers;
    v_deleted := jsonb_set(v_deleted, '{customers}', to_jsonb(true));
  end if;

  -- ── catalogue ────────────────────────────────────────────────────────────
  if coalesce((v_opts->>'products')::boolean, false) then
    -- RESTRICT children first: movements point at products and must never
    -- outlive them; reviews/content/codes/variants cascade but are deleted
    -- explicitly so the counts in the audit are the truth.
    delete from public.stock_movements;
    delete from public.store_reviews;
    delete from public.product_content;
    delete from public.catalogue_codes;
    delete from public.product_variants;
    delete from public.products;
    v_deleted := jsonb_set(v_deleted, '{products}', to_jsonb(true));
  end if;

  if coalesce((v_opts->>'categories')::boolean, false) then
    delete from public.storefront_category_content;
    -- parent → RESTRICT: peel the tree from the leaves until it is gone.
    loop
      delete from public.categories where parent_id is not null;
      get diagnostics v_counts = row_count;
      exit when v_counts = 0;
      v_depth := v_depth + 1;
      exit when v_depth > 32; -- cannot happen; guards a corrupted cycle
    end loop;
    delete from public.categories where parent_id is null;
    v_deleted := jsonb_set(v_deleted, '{categories}', to_jsonb(true));
  end if;

  -- ── website content ──────────────────────────────────────────────────────
  if coalesce((v_opts->>'website')::boolean, false) then
    delete from public.campaigns;
    delete from public.store_faqs;
    -- The settings document: everything except what other selected groups say
    -- to keep (branding), reset to a valid `{}` (the app's deep-merge then
    -- serves the shipped ALYQ defaults — never a half-configured site).
    select public.website_settings.settings into v_settings from public.website_settings where id = 1;
    if coalesce((v_opts->>'branding')::boolean, false) then
      update public.website_settings set settings = '{}'::jsonb, updated_at = now() where id = 1;
    else
      -- Keep ONLY the brand identity block; drop every customization key.
      v_settings := jsonb_strip_nulls(jsonb_build_object(
        'brand', v_settings->'brand',
        'images', v_settings->'images'
      ));
      update public.website_settings set settings = v_settings, updated_at = now() where id = 1;
    end if;
    v_deleted := jsonb_set(v_deleted, '{website}', to_jsonb(true));
  elsif coalesce((v_opts->>'branding')::boolean, false) then
    -- Branding reset with the website kept: remove the brand block and the
    -- logo keys; the resolver falls back to the shipped ALYQ wordmark.
    update public.website_settings
       set settings = (public.website_settings.settings - 'brand')
                     || jsonb_build_object('images',
                          coalesce(public.website_settings.settings->'images', '{}'::jsonb)
                          - 'logo_url' - 'mark_url' - 'logo_dark_url'),
           updated_at = now()
     where id = 1;
    v_deleted := jsonb_set(v_deleted, '{branding}', to_jsonb(true));
  end if;

  if coalesce((v_opts->>'delivery_payment')::boolean, false) then
    update public.website_settings
       set settings = (public.website_settings.settings - 'delivery'),
           updated_at = now()
     where id = 1;
    v_deleted := jsonb_set(v_deleted, '{delivery_payment}', to_jsonb(true));
  end if;

  -- ── fresh numbering (factory means "as shipped") ─────────────────────────
  update public.sale_counters     set next_value = 1 where id = 1;
  update public.return_counters   set next_value = 1 where id = 1;
  update public.refund_counters   set next_value = 1 where id = 1;
  -- approval_counters deliberately untouched: the requests survive, so their
  -- numbering must too (no reused reference to a preserved decision).
  perform setval('public.shift_number_seq', 1, false);
  perform setval('public.expense_number_seq', 1, false);

  -- ── post-verify: the admin survived (structurally guaranteed; proven here) ─
  perform public.system_assert_super_admin(v_uid);

  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.succeeded', 'system', 'factory', 'Factory reset',
          jsonb_build_object('mode', 'factory', 'options', v_opts, 'deleted', v_deleted),
          v_uid::text, v_actor);

  return jsonb_build_object(
    'mode', 'factory',
    'deleted', v_deleted,
    'preserved', jsonb_build_object(
      'profiles', (select count(*) from public.profiles where active),
      'super_admin', (select username from public.profiles where id = v_uid),
      'schema', true,
      'migrations_untouched', true,
      'branding_kept', not coalesce((v_opts->>'branding')::boolean, false)
    )
  );
end;
$$;

-- ── 6. failure bookkeeping (the destructive call rolled back; record that) ─

create or replace function public.system_reset_report_failure(
  p_mode text,
  p_stage text,
  p_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_actor text;
begin
  if v_uid is null or not public.can('manage_system_reset') then
    raise exception 'RESET_UNAUTHORIZED: manage_system_reset is required'
      using errcode = 'insufficient_privilege';
  end if;
  if p_mode not in ('operational', 'factory', 'demo') then
    raise exception 'RESET_BAD_MODE: %', p_mode;
  end if;
  select name into v_actor from public.profiles where id = v_uid;

  -- The message comes from the database error, never from user input that
  -- could carry a password; truncate hard and never log credentials.
  insert into public.audit_log (action, entity, entity_id, entity_label, details, user_id, user_name)
  values ('system.reset.failed', 'system', p_mode,
          case p_mode when 'operational' then 'Clear operational data'
                      when 'factory' then 'Factory reset'
                      else 'Reset demo data' end,
          jsonb_build_object(
            'mode', p_mode,
            'stage', left(coalesce(p_stage, ''), 64),
            'error', left(coalesce(p_message, ''), 500)
          ),
          v_uid::text, v_actor);
end;
$$;

-- ── 7. privileges: the switch is reachable, the refusal is server-side ─────
-- EXECUTE for authenticated (the wire role), revoked from anonymous/public —
-- a forged call from an ordinary staff session then fails on the capability
-- check INSIDE the function, and a forged call without a session fails before
-- it. RLS is untouched everywhere; these functions read through their DEFINER
-- rights exactly like pos_settle_refund (0016) already does.

revoke execute on function public.system_assert_super_admin(uuid) from public, anon, authenticated;
revoke execute on function public.system_assert_options(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.system_reset_preview(text, jsonb) from public, anon;
revoke execute on function public.system_clear_operational_data(jsonb, text, timestamptz, text) from public, anon;
revoke execute on function public.system_factory_reset(jsonb, text, timestamptz, text) from public, anon;
revoke execute on function public.system_assert_authorized(timestamptz, text, text, text) from public, anon, authenticated;
revoke execute on function public.system_reset_report_failure(text, text, text) from public, anon;

grant execute on function public.system_reset_preview(text, jsonb) to authenticated;
grant execute on function public.system_clear_operational_data(jsonb, text, timestamptz, text) to authenticated;
grant execute on function public.system_factory_reset(jsonb, text, timestamptz, text) to authenticated;
grant execute on function public.system_reset_report_failure(text, text, text) to authenticated;

comment on function public.system_reset_preview(text, jsonb) is
  'Danger Zone (Phase 47): server-calculated delete/preserve counts for a reset mode. Read-only.';
comment on function public.system_clear_operational_data(jsonb, text, timestamptz, text) is
  'Danger Zone (Phase 47/48): atomic, audited clear of transactional data. Requires manage_system_reset, the exact phrase DELETE OPERATIONAL DATA, and the caller''s CURRENT PASSWORD, verified server-side against the auth credential (a client freshness stamp alone is not a proof).';
comment on function public.system_factory_reset(jsonb, text, timestamptz, text) is
  'Danger Zone (Phase 47/48): atomic, audited factory reset. Same gates with the phrase DELETE ALL DATA plus the server-verified current password; never touches auth, profiles, schema or migration history.';
comment on function public.system_reset_report_failure(text, text, text) is
  'Danger Zone (Phase 47): after a rolled-back reset, records the failure in the (append-only) audit trail. Same capability required; never receives credentials.';

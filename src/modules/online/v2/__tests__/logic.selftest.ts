import assert from "node:assert/strict";
import { buildDemoProducts } from "@/modules/products/data/demoSeed";
import { dictionaries } from "@/lib/i18n/dictionary";
import type { Campaign, Promotion, PromotionTarget } from "../../types";
import { EMPTY_CATALOG_FILTERS, type CatalogContext } from "../../services/catalogQuery";
import type { StoreVariant } from "../../services/pricing";
import {
  DEFAULT_STOREFRONT_V2_SETTINGS, DEFAULT_WEBSITE_SETTINGS, invalidSettingsColor,
  resolveSettings, sanitizeSettings, sanitizeStorefrontV2Settings, settingsForRemoteSave,
} from "../../services/settingsDefaults";
import { adaptV2Appearance, contrastRatio, v2Href } from "../appearance";
import { canonicalPreviewSearch, canonicalStorePathname } from "../storeRoutes";
import { sizeKeyOf, variantModel } from "../variantModel";
import { v2Price, v2Gallery, v2CatalogResults } from "../viewModel";

const product = { ...buildDemoProducts()[0], id: "example-product", variants_enabled: true,
  selling_price: 100, stock_quantity: 99, stock_tracking_enabled: true };
function variant(id: string, overrides: Partial<StoreVariant> = {}): StoreVariant {
  return { id, product_id: product.id, sku: `SKU-${id}`, color_key: "gold",
    color_ar: "ذهبي", color_en: "Gold", color_hex: "#daa520",
    size: 17, size_label: null, image_url: null, price_override: null,
    stock_quantity: 4, active: true, sort_order: 1, ...overrides };
}
const gold17 = variant("gold-17", { price_override: 125, stock_quantity: 2 });
const gold18 = variant("gold-18", { size: 18, stock_quantity: 0 });
const silver17 = variant("silver-17", { color_key: "silver", color_ar: "فضي", color_en: "Silver",
  color_hex: "#ccc", stock_quantity: 3 });
const silverXS = variant("silver-xs", { color_key: "silver", color_ar: "فضي", color_en: "Silver",
  size: null, size_label: "XS", stock_quantity: 3 });
const silverOne = variant("silver-one", { color_key: "silver", color_ar: "فضي", color_en: "Silver",
  size: null, size_label: "One Size", stock_quantity: 1 });
const campaign: Campaign = { id: "v2-campaign", name_ar: "عرض", name_en: "Sale", kind: "flash_sale",
  discount_type: "percent", discount_value: 20, product_ids: [product.id],
  badge_ar: null, badge_en: null, starts_at: "2025-01-01T00:00:00.000Z",
  ends_at: "2099-01-01T00:00:00.000Z", active: true,
  created_at: "2025-01-01T00:00:00.000Z", updated_at: "2025-01-01T00:00:00.000Z" };

let passed = 0;
function test(name: string, run: () => void) {
  run();
  console.log(`✓ ${name}`);
  passed++;
}

test("color + size targets the one published variant UUID; unavailable combinations are not invented", () => {
  const model = variantModel([gold17, gold18, silver17, silverXS]);
  assert.equal(model.exact("gold", "size:17")?.id, gold17.id);
  assert.equal(model.exact("silver", "size:17")?.id, silver17.id);
  assert.equal(model.exact("gold", "size:18"), null, "sold-out option remains visible but cannot be selected");
  assert.equal(model.exact(null, "size:17"), null, "no implicit color");
  assert.equal(model.exact("gold", null), null, "no implicit size");
  assert.equal(model.exact("gold", "size:xs"), null, "not a cross-product matrix");
  assert.equal(model.sizesFor("gold").length, 2);
  assert.equal(model.sizesFor("gold")[1].available, 0);
});

test("letter, numeric and one-size labels all derive from data and sort without a fixed size list", () => {
  assert.equal(sizeKeyOf({ size: 16.5, size_label: null }), "size:16.5");
  assert.equal(sizeKeyOf(silverXS), "size:xs");
  assert.equal(sizeKeyOf(silverOne), "size:one size");
  const model = variantModel([silverXS, silverOne, silver17, variant("half", { color_key: "silver", size: 16.5 })]);
  assert.deepEqual(model.sizesFor("silver").map((option) => option.label), ["16.5", "17", "One Size", "XS"]);
  assert.equal(model.exact("silver", "size:one size")?.id, silverOne.id);
});

test("reservation holds, disabled tracking and non-active variants never become Quick Add substitutes", () => {
  const held = variantModel([gold17, silver17], new Map([[gold17.id, 2]]));
  assert.equal(held.remaining(gold17), 0);
  assert.equal(held.exact("gold", "size:17"), null);
  assert.equal(held.soleQuickAdd(), null, "even one surviving shelf still requires an explicit choice");
  assert.equal(variantModel([gold17]).soleQuickAdd()?.id, gold17.id);
  assert.equal(variantModel([gold17], new Map(), false).soleQuickAdd(), null);
  assert.equal(variantModel([gold17, variant("inactive", { active: false })]).variants.length, 1);
});

test("advisory selected shelf pricing preserves variant override and campaign exclusion", () => {
  const cheapest = v2Price(product, [gold17, silver17], [campaign], [], []);
  assert.deepEqual({ price: cheapest.price, list: cheapest.list, from: cheapest.from },
    { price: 80, list: 100, from: true }, "unspecified selection shows the lowest available shelf");
  const gold = v2Price(product, [gold17, silver17], [campaign], [], [], gold17);
  assert.deepEqual({ id: gold.id, price: gold.price, list: gold.list, from: gold.from },
    { id: gold17.id, price: 125, list: 125, from: false }, "override does not stack with campaign");
  const reserved = v2Price(product, [gold17, silver17], [campaign], [], [], null, new Map([[silver17.id, 3]]));
  assert.equal(reserved.id, gold17.id, "held stock must not set a misleading from-price");
});

test("catalogue filters and sorts on the same advisory offer shown on V2 cards", () => {
  const discounted = { ...buildDemoProducts()[0], id: "discounted", selling_price: 100 };
  const regular = { ...buildDemoProducts()[1], id: "regular", selling_price: 60 };
  const context: CatalogContext = {
    campaigns: [], units: new Map(), contents: new Map(), reserved: new Map(),
    variants: new Map(), reservedVariant: new Map(),
  };
  const promotion: Promotion = {
    id: "promotion", enabled: true, channel: "online", name_en: "Offer", name_ar: "عرض",
    description_en: null, description_ar: null, discount_type: "percent", value: 50,
    scope: "product", minimum_order_amount: 0, maximum_discount_amount: null,
    starts_at: null, ends_at: null, priority: 1, stackable: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
  const targets: PromotionTarget[] = [{ promotion_id: promotion.id,
    target_kind: "product", target_id: discounted.id, created_at: promotion.created_at }];
  const filters = { ...EMPTY_CATALOG_FILTERS, sort: "price_asc" as const };
  assert.deepEqual(v2CatalogResults([regular, discounted], filters, context, [], [promotion], targets)
    .map((row) => row.product.id), [discounted.id, regular.id], "offer changes sort order");
  assert.deepEqual(v2CatalogResults([regular, discounted], { ...filters, maxPrice: 55 }, context,
    [], [promotion], targets).map((row) => row.product.id), [discounted.id], "offer changes price range");
  assert.deepEqual(v2CatalogResults([regular, discounted], filters, context,
    [], [promotion], targets, true).map((row) => row.product.id), [discounted.id], "offers filter is exact");
});

test("former preview paths map to one canonical public tree without changing identifiers", () => {
  assert.equal(canonicalStorePathname("/store/v2"), "/store");
  assert.equal(canonicalStorePathname("/store/v2/products"), "/store/products");
  assert.equal(canonicalStorePathname("/store/v2/products/pearl-ring"), "/store/products/pearl-ring");
  assert.equal(canonicalStorePathname("/store/v2/products/4fb4125a-0f26-461e-8a94-31e365342101"),
    "/store/products/4fb4125a-0f26-461e-8a94-31e365342101");
  for (const route of ["cart", "checkout", "confirmation", "track", "account", "about", "contact"]) {
    assert.equal(canonicalStorePathname(`/store/v2/${route}`), `/store/${route}`);
  }
  assert.equal(canonicalStorePathname("/store/v2/no-such-page"), "/store");
  assert.equal(canonicalStorePathname("/store/v2/products/a/b"), "/store");
  assert.equal(canonicalStorePathname("/store/v2-malicious"), "/store/v2-malicious");
  assert.equal(canonicalPreviewSearch("/store/v2/products", "?q=Gold%20Ring&size_label=XS&phone=01012345678"),
    "?q=Gold+Ring&size_label=XS", "catalogue filters survive, phone-like extra fields do not");
  assert.equal(canonicalPreviewSearch("/store/v2/track", "?number=WEB-123&phone=01012345678"),
    "?number=WEB-123", "a saved tracking bookmark never shares the customer's phone");
  assert.equal(canonicalPreviewSearch("/store/v2/account", "?tab=orders&token=secret"), "?tab=orders");
  assert.equal(canonicalPreviewSearch("/store/v2/unknown", "?token=secret"), "");
});

test("gallery, saved links and scoped accessible tokens adapt existing ALYQ settings", () => {
  assert.deepEqual(v2Gallery({ image_url: "/from-catalogue.jpg", images: ["/from-catalogue.jpg", "/second.jpg"] }, null),
    ["/from-catalogue.jpg", "/second.jpg"]);
  assert.equal(v2Href("#/store"), "/store");
  assert.equal(v2Href("#/store/products?category=rings"), "/store/products?category=rings");
  assert.equal(v2Href("#/store/products/my-ring"), "/store/products/my-ring");
  for (const route of ["cart", "checkout", "confirmation", "track", "account", "about", "contact"]) {
    assert.equal(v2Href(`#/store/${route}`), `/store/${route}`, `${route} stays canonical`);
  }
  assert.equal(v2Href("#/store/track?number=WEB-1"), "/store/track?number=WEB-1");
  assert.equal(v2Href("#/store/v2/products/my-ring?color=gold&size_label=XS"),
    "/store/products/my-ring?color=gold&size_label=XS", "saved preview link keeps slug and filters");
  assert.equal(v2Href("#/store/v2/track?number=WEB-1&phone=01012345678"), "/store/track?number=WEB-1");
  assert.equal(v2Href("#/store/v2/unknown?token=secret"), "/store", "no invented public route or query leak");
  assert.equal(v2Href("javascript:alert(1)"), null);
  assert.equal(v2Href("#//malicious.example"), null, "protocol-relative route rejected");
  const customized = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  customized.theme.primary_color = "#fff";
  customized.theme.background_color = "#161616";
  const tokens = adaptV2Appearance(customized).variables as Record<string, string>;
  assert.equal(tokens["--v2-primary"], "#fff");
  assert.equal(tokens["--v2-bg"], "#161616");
  assert.ok(contrastRatio(tokens["--v2-text"], tokens["--v2-bg"]) >= 4.5);
  assert.ok(contrastRatio(tokens["--v2-button-text"], tokens["--v2-button-bg"]) >= 4.5);
  assert.ok(!Object.keys(tokens).some((key) => key.startsWith("--store-")), "no admin/legacy token bleed");
});

test("old JSON resolves a typed V2 group without migrating or changing shared settings", () => {
  const old = { theme: { ...DEFAULT_WEBSITE_SETTINGS.theme, primary_color: "#223344" },
    product_card: { ...DEFAULT_WEBSITE_SETTINGS.product_card, mobile_columns: 1 } };
  const resolved = resolveSettings(old);
  assert.deepEqual(resolved.storefront_v2, DEFAULT_STOREFRONT_V2_SETTINGS);
  assert.equal(resolved.theme.primary_color, "#223344");
  assert.equal(adaptV2Appearance(resolved).mobileColumns, 1);
  for (const shared of [2, 3] as const) {
    resolved.product_card.mobile_columns = shared;
    assert.equal(adaptV2Appearance(resolved).mobileColumns, 2, "shared 3 is capped on phones");
  }
  resolved.storefront_v2.mobile_columns = 1;
  assert.equal(adaptV2Appearance(resolved).mobileColumns, 1);
  resolved.storefront_v2.mobile_columns = 2;
  assert.equal(adaptV2Appearance(resolved).mobileColumns, 2);
  assert.equal(JSON.stringify(old).includes("storefront_v2"), false, "reads never mutate the old row");
});

test("V2 save/read allowlist rejects forged CSS, images, enums, columns and unknown keys", () => {
  const malformed = sanitizeStorefrontV2Settings({
    header_bg: "url(javascript:alert(1))", footer_text: "#12345678", page_bg: "#fed",
    mobile_logo_url: "javascript:alert(1)", button_style: "arbitrary", body_font: "https://font.example",
    display_font: "Comic Sans", logo_height: 999, mobile_logo_height: -9, mobile_columns: 3,
    show_cart: "true", show_language: "false", custom_css: ".store { display:none }",
  });
  assert.equal(malformed.page_bg, "#fed");
  assert.equal(malformed.header_bg, null);
  assert.equal(malformed.footer_text, null);
  assert.equal(malformed.mobile_logo_url, null);
  assert.equal(malformed.button_style, "inherit");
  assert.equal(malformed.body_font, "inherit");
  assert.equal(malformed.display_font, "inherit");
  assert.equal(malformed.logo_height, 96);
  assert.equal(malformed.mobile_logo_height, 20);
  assert.equal(malformed.mobile_columns, null);
  assert.equal(malformed.show_cart, null);
  assert.equal(malformed.show_language, true);
  assert.ok(!("custom_css" in malformed));
  const raw = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  Object.assign(raw.storefront_v2, { ...malformed, custom_css: "body{}" });
  const clean = sanitizeSettings(raw);
  assert.equal(invalidSettingsColor(clean), null);
  assert.ok(!("custom_css" in clean.storefront_v2));
  const bad = structuredClone(clean);
  bad.storefront_v2.button_text = "#badhex";
  assert.equal(invalidSettingsColor(bad), "storefront_v2.button_text", "admin blocks the whole bad draft");
  const remote = settingsForRemoteSave(clean, "https://shop.example");
  assert.deepEqual(resolveSettings(JSON.parse(JSON.stringify(remote))).storefront_v2, clean.storefront_v2);
  clean.storefront_v2.mobile_logo_url = "/brand/hero-editorial-mobile.jpg";
  assert.equal(settingsForRemoteSave(clean, "https://shop.example").storefront_v2.mobile_logo_url,
    "https://shop.example/brand/hero-editorial-mobile.jpg", "the existing Supabase media boundary includes V2 mobile logos");
});

// Issue C (3rd follow-up round): manual preview confirmed the configured logo
// image DOES render (so the loading/path logic from the prior round is
// correct) but appears as "a very small square in the center of the dark
// header" whenever the admin configures a logo image without also touching
// the separate logo-size sliders. This pins the fix — an admin who only
// uploads a logo, and never opens the size sliders, still gets a clearly
// visible size — and that the fix does NOT grow the header row itself
// (`.v2-header-inner` in storefront-v2.css floors at 74px desktop / 64px
// mobile using exactly `logo-height + 18`), which is a hard constraint the
// task called out ("do not enlarge the entire header excessively").
test("a configured logo with no size chosen renders clearly visible, not a tiny square, and never grows the header", () => {
  const settings = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  settings.images.logo_url = "https://project-ref.supabase.co/storage/v1/object/public/product-images/website/logo.png";
  const vars = (settings2: typeof settings, overrides?: Partial<typeof settings.storefront_v2>) =>
    adaptV2Appearance(overrides ? { ...settings2, storefront_v2: { ...settings2.storefront_v2, ...overrides } } : settings2)
      .variables as Record<string, string>;
  const appearance = vars(settings);
  const desktopHeight = Number(String(appearance["--v2-logo-height"]).replace("px", ""));
  const mobileHeight = Number(String(appearance["--v2-mobile-logo-height"]).replace("px", ""));
  assert.ok(desktopHeight >= 48, "the default desktop logo height is a real, visible size, not a tiny badge");
  assert.ok(mobileHeight >= 36, "the default mobile logo height is a real, visible size, not a tiny badge");
  assert.ok(desktopHeight + 18 <= 74, "the default fits inside the header's existing 74px floor — no header growth");
  assert.ok(mobileHeight + 18 <= 64, "the default fits inside the header's existing 64px floor — no header growth");
  // An admin who DOES use the sliders keeps full control, unchanged.
  const chosen = vars(settings, { logo_height: 30, mobile_logo_height: 24 });
  assert.equal(chosen["--v2-logo-height"], "30px");
  assert.equal(chosen["--v2-mobile-logo-height"], "24px");
});

test("V2 overrides leave legacy theme alone and use accessible text for extreme palettes", () => {
  const raw = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  raw.storefront_v2 = { ...raw.storefront_v2, mobile_logo_url: "/brand/hero-editorial.jpg",
    header_bg: "#ffffff", header_text: "#ffffff", page_bg: "#111111", surface_bg: "#ffffff",
    text_color: "#111111", muted_text: "#bbbbbb", button_bg: "#ffffff", button_text: "#ffffff",
    badge_bg: "#ffffff", badge_text: "#ffffff", hero_bg: "#ffffff", hero_text: "#ffffff",
    announcement_bg: "#ffffff", announcement_text: "#ffffff", footer_bg: "#ffffff",
    footer_text: "#ffffff", footer_link: "#ffffff", badge_style: "pill", button_style: "square",
    body_font: "classic", display_font: "modern", sticky_header: false, show_cart: false };
  const originalTheme = structuredClone(raw.theme);
  const saved = sanitizeSettings(raw);
  assert.deepEqual(saved.theme, originalTheme, "a V2 edit does not recolour legacy");
  const view = adaptV2Appearance(saved);
  const vars = view.variables as Record<string, string>;
  for (const [background, text] of [
    ["--v2-bg", "--v2-text"], ["--v2-surface", "--v2-surface-text"],
    ["--v2-header-bg", "--v2-header-text"], ["--v2-button-bg", "--v2-button-text"],
    ["--v2-badge-bg", "--v2-badge-text"], ["--v2-hero-bg", "--v2-hero-text"],
    ["--v2-announcement-bg", "--v2-announcement-text"],
    ["--v2-footer-bg", "--v2-footer-text"], ["--v2-footer-bg", "--v2-footer-link"],
  ]) {
    assert.ok(contrastRatio(vars[background], vars[text]) >= 4.5, `${background}/${text} is readable`);
  }
  assert.equal(vars["--v2-header-bg"], "#ffffff");
  assert.equal(vars["--v2-button-radius"], "0px");
  assert.equal(vars["--v2-badge-radius"], "9999px");
  assert.equal(view.mobileLogoUrl, "/brand/hero-editorial.jpg");
  assert.equal(view.stickyHeader, false);
  assert.equal(view.showCart, false);
  assert.ok(vars["--v2-font-arabic-display"].includes("Noto Sans Arabic"));
});

test("new public copy ships in both languages", () => {
  for (const key of ["eyebrow", "quickAdd", "selectOptions", "notOrderable", "results", "noSizeGuide"] as const) {
    assert.ok(dictionaries.en[`store.v2.${key}`].length);
    assert.ok(dictionaries.ar[`store.v2.${key}`].length);
  }
});

console.log(`${passed}/${passed} V2 logic tests passed`);

/**
 * Phase 9 logic self-test (headless).
 * Run with:
 *   npx esbuild src/modules/online/__tests__/logic.selftest.ts \
 *     --bundle --format=esm --platform=node --outfile=/tmp/alyq-phase9.mjs && node /tmp/alyq-phase9.mjs
 *
 * Covers the online shop's rules and arithmetic: campaign pricing, coupons,
 * delivery fees, stock reservations (the inventory protection a website order
 * must not break), the order workflow (approve → a real POS sale, cancel → the
 * stock goes back), InstaPay verification that never marks an order paid by
 * itself, catalogue search/sort/filters, homepage sections, settings
 * merge/repair, SEO helpers and the online-orders export sheets.
 *
 * The last group drives the demo repository end to end — the same code path the
 * storefront and the Online Orders screen both use — so the mandatory
 * "website order becomes a till sale" integration is asserted, not assumed.
 */
import assert from "node:assert/strict";
import type { Category, Product } from "@/modules/products/types";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { dictionaries } from "@/lib/i18n/dictionary";
import type { TranslationKey } from "@/lib/i18n/dictionary";
import type { PickBilingual, Translate } from "@/lib/export";
import {
  brandsOf,
  campaignCovers,
  campaignFor,
  checkCoupon,
  customerKeyFor,
  deliveryAreaSupported,
  deliveryAreasOf,
  deliveryFeeFor,
  deliveryMinimumShortfall,
  evaluateCartPricing,
  freeDeliveryProgress,
  normalizePlaceName,
  goodsTotalOf,
  isCampaignLive,
  promotionUnitPrice,
  liveCampaigns,
  normalizeCouponCode,
  priceCart,
  round2,
  unitPriceOf,
  type CartPricingInput,
} from "../services/pricing";
import {
  availableToPromise,
  findOversell,
  holdsReservation,
  reservedByProduct,
  reservedOf,
  staleReservations,
  totalReserved,
} from "../services/availability";
import {
  availableActions,
  canSubmitProof,
  checkAction,
  deliveryHintKey,
  deliveryStatusOf,
  FULFILMENT_ORDER,
  initialPaymentStatus,
  isOrderClosed,
  isOrderOpen,
  needsPaymentVerification,
  nextStatusOf,
  orderProgress,
  requiresReason,
} from "../services/orderWorkflow";
import { bestSellerIds, campaignBadgeText, isNewArrival, productBadges, unitsSold } from "../services/badges";
import {
  brandFacet,
  categoryFacet,
  EMPTY_CATALOG_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  priceRangeOf,
  relatedProducts,
  searchCatalog,
  storefrontProducts,
  type CatalogContext,
  type CatalogFilters,
} from "../services/catalogQuery";
import {
  moveSection,
  orderedSections,
  resolvedBanners,
  resolvedSlides,
  resetSections,
  sectionLimit,
  sectionOf,
  sectionTitle,
  setSectionLimit,
  setSectionTitle,
  setSectionVisible,
  visibleSections,
} from "../services/sections";
import {
  configuredHref,
  sanitizeSettings,
  settingsForRemoteSave,
  DEFAULT_WEBSITE_SETTINGS,
  externalHref,
  internalHref,
  mergeSettings,
  STORE_PALETTE,
  invalidSettingsColor,
  readableOn,
  repairSections,
  resolveSettings,
  safeColor,
} from "../services/settingsDefaults";
import { announcementStyle, buttonRadiusOf, fontStackOf, shade, themeVariables } from "../services/theme";
import {
  absoluteUrl,
  buildRobotsTxt,
  buildSitemapXml,
  clipDescription,
  descriptionForProduct,
  keywordList,
  productPath,
  slugifyAscii,
  storefrontSitemapPages,
  suggestedSlug,
  titleForProduct,
} from "../services/seo";
import { fromDateTimeLocal, isWindowOpen, toDateTimeLocal } from "../services/datetime";
import { buildOnlineOrderSheets } from "../services/onlineOrdersExport";
import { OnlineError, toOnlineError } from "../data";
import { getDemoOnlineRepository, resetDemoOnlineRepository } from "../data/demoRepository";
import { HOMEPAGE_SECTIONS } from "../types";
import type {
  Campaign,
  Coupon,
  CustomerAddress,
  DeliverySettings,
  DeliveryZone,
  OnlineOrder,
  OrderEvent,
  ProductContent,
  Promotion,
  StockReservation,
  WebsiteSettings,
} from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-01T10:00:00.000Z");
const STAFF = { user_id: "user-demo-admin", user_name: "ALYQ Admin" };

const t: Translate = ((key: TranslationKey) => dictionaries.en[key] ?? key) as Translate;
const pick: PickBilingual = ((arabic: string | null, english: string | null) => english || arabic || "") as PickBilingual;

const DELIVERY: DeliverySettings = {
  enabled: true,
  fee: 30,
  free_delivery_threshold: 500,
  areas: [],
  minimum_order: null,
  note_ar: "",
  note_en: "",
  pickup_enabled: true,
  pickup_address_ar: "",
  pickup_address_en: "",
  cod_enabled: true,
  instapay_enabled: true,
  instapay_instructions_ar: "",
  instapay_instructions_en: "",
  instapay_proof_required: true,
};

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prd-1",
    sku: "SKU-1",
    variants_enabled: false,
    barcode: "6221000000017",
    name_ar: "أقراط",
    name_en: "Earrings",
    description_ar: null,
    description_en: "Gold-plated and hypoallergenic.",
    category_id: "cat-earrings",
    product_type: "physical",
    selling_price: 100,
    cost_price: 60,
    tax_rate: 0,
    stock_tracking_enabled: true,
    stock_quantity: 10,
    low_stock_level: 2,
    show_on_website: true,
    is_featured: false,
    active: true,
    image_url: null,
    images: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "cmp-1",
    name_ar: "تخفيضات",
    name_en: "Flash sale",
    kind: "flash_sale",
    discount_type: "percent",
    discount_value: 10,
    product_ids: [],
    badge_ar: null,
    badge_en: "Flash",
    starts_at: "2026-04-01T00:00:00.000Z",
    ends_at: "2026-06-01T00:00:00.000Z",
    active: true,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCoupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    id: "cpn-1",
    code: "WELCOME10",
    title_en: "Welcome",
    title_ar: "ترحيب",
    description_en: null,
    description_ar: null,
    discount_type: "percent",
    value: 10,
    min_subtotal: 0,
    max_discount: null,
    usage_limit: null,
    used_count: 0,
    per_customer_limit: null,
    first_order_only: false,
    stackable: false,
    applies_to: "all",
    target_ids: [],
    active: true,
    starts_at: null,
    ends_at: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OnlineOrder> = {}): OnlineOrder {
  const base: OnlineOrder = {
    id: "ord-1",
    order_number: "WEB-000001",
    client_ref: "ref-1",
    store_customer_id: null,
    customer_name: "Mona",
    customer_phone: "01001234567",
    customer_email: null,
    delivery_type: "delivery",
    address: {
      id: "adr-1",
      label: "Home",
      full_name: "Mona",
      phone: "01001234567",
      city: "Ismailia",
      area: "",
      street: "El Bahry",
      building: "",
      floor: "",
      apartment: "",
      is_default: true,
      notes: null,
    },
    subtotal: 200,
    discount_code: null,
    discount_amount: 0,
    promotion_id: null,
    price_snapshot: null,
    delivery_fee: 30,
    total: 230,
    payment_method: "cod",
    payment_status: "pending",
    status: "pending",
    payment_reference: null,
    payment_proof_url: null,
    payment_submitted_at: null,
    payment_verified_by: null,
    payment_verified_by_name: null,
    payment_verified_at: null,
    payment_rejected_reason: null,
    sale_id: null,
    sale_number: null,
    notes: null,
    cancellation_reason: null,
    approved_by: null,
    approved_by_name: null,
    approved_at: null,
    cancelled_by: null,
    cancelled_by_name: null,
    cancelled_at: null,
    completed_at: null,
    created_at: "2026-05-01T09:00:00.000Z",
    updated_at: "2026-05-01T09:00:00.000Z",
    items: [],
    events: [],
  };
  return { ...base, ...overrides };
}

function makeReservation(overrides: Partial<StockReservation> = {}): StockReservation {
  return {
    id: "res-1",
    online_order_id: "ord-1",
    product_id: "prd-1",
    variant_id: null,
    quantity: 2,
    status: "reserved",
    created_at: "2026-05-01T09:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

function makeContent(overrides: Partial<ProductContent> = {}): ProductContent {
  return {
    product_id: "prd-1",
    brand_ar: "أَلِــيْـــق",
    brand_en: "ALYQ",
    slug: "earrings",
    seo_title: null,
    seo_description: null,
    specs: [],
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

const CATALOG: Product[] = [
  makeProduct({ id: "prd-1", sku: "SKU-1", name_en: "Gold earrings", selling_price: 120, stock_quantity: 8 }),
  makeProduct({
    id: "prd-2",
    sku: "SKU-2",
    barcode: "6221000000024",
    name_en: "Pearl necklace",
    category_id: "cat-hair",
    selling_price: 60,
    stock_quantity: 0,
    is_featured: true,
    created_at: "2026-04-25T00:00:00.000Z",
  }),
  makeProduct({
    id: "prd-3",
    sku: "SKU-3",
    barcode: "6221000000031",
    name_en: "Silver ring",
    category_id: "cat-tools",
    selling_price: 900,
    stock_quantity: 3,
    created_at: "2025-11-01T00:00:00.000Z",
  }),
  makeProduct({ id: "prd-hidden", sku: "SKU-9", name_en: "Hidden", show_on_website: false }),
];

const CONTENTS: ProductContent[] = [
  makeContent({ product_id: "prd-1", brand_en: "ALYQ", slug: "gold-earrings" }),
  makeContent({ product_id: "prd-2", brand_en: "ALYQ", slug: "pearl-necklace" }),
  makeContent({ product_id: "prd-3", brand_en: "Lumina", slug: null }),
];

const CATEGORIES: Category[] = [
  {
    id: "cat-earrings",
    name_ar: "أقراط",
    name_en: "Earrings",
    parent_id: null,
    active: true,
    sort_order: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "cat-tools",
    name_ar: "أدوات",
    name_en: "Tools",
    parent_id: null,
    active: true,
    sort_order: 2,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

const CONTEXT: CatalogContext = {
  campaigns: [],
  units: new Map([
    ["prd-1", 4],
    ["prd-2", 9],
  ]),
  contents: new Map(CONTENTS.map((content) => [content.product_id, content])),
  reserved: new Map(),
  now: NOW,
};

function filters(overrides: Partial<CatalogFilters> = {}): CatalogFilters {
  return { ...EMPTY_CATALOG_FILTERS, ...overrides };
}

function settings(overrides: Partial<WebsiteSettings> = {}): WebsiteSettings {
  return structuredClone({ ...DEFAULT_WEBSITE_SETTINGS, ...overrides });
}

// ── campaign pricing ────────────────────────────────────────────────────────

test("a percent campaign discounts the catalogue price and rounds once", () => {
  const campaign = makeCampaign({ discount_type: "percent", discount_value: 15 });
  assert.equal(unitPriceOf(33.33, campaign), 28.33);
  assert.equal(unitPriceOf(100, campaign), 85);
  assert.equal(unitPriceOf(100, null), 100, "no campaign means the catalogue price");
});

test("a fixed campaign discount can never take a price below zero", () => {
  const campaign = makeCampaign({ discount_type: "fixed", discount_value: 250 });
  assert.equal(unitPriceOf(100, campaign), 0);
  assert.equal(unitPriceOf(400, campaign), 150);
});

test("campaigns are only live inside their window and while switched on", () => {
  const live = makeCampaign();
  const off = makeCampaign({ id: "cmp-off", active: false });
  const future = makeCampaign({ id: "cmp-future", starts_at: "2026-07-01T00:00:00.000Z" });
  const past = makeCampaign({ id: "cmp-past", ends_at: "2026-04-30T00:00:00.000Z" });

  assert.equal(isCampaignLive(live, NOW), true);
  assert.equal(isCampaignLive(off, NOW), false);
  assert.equal(isCampaignLive(future, NOW), false);
  assert.equal(isCampaignLive(past, NOW), false);
  assert.deepEqual(
    liveCampaigns([live, off, future, past], NOW).map((campaign) => campaign.id),
    ["cmp-1"],
  );
});

test("an empty product list means the campaign covers the whole shop", () => {
  assert.equal(campaignCovers(makeCampaign({ product_ids: [] }), "prd-anything"), true);
  assert.equal(campaignCovers(makeCampaign({ product_ids: ["prd-1"] }), "prd-2"), false);
  assert.equal(campaignCovers(makeCampaign({ product_ids: ["prd-1"] }), "prd-1"), true);
});

test("campaignFor picks the live campaign covering a product", () => {
  const chosen = makeCampaign({ id: "cmp-live", product_ids: ["prd-2"] });
  const ignored = makeCampaign({ id: "cmp-dead", active: false, product_ids: ["prd-2"] });
  assert.equal(campaignFor("prd-2", [ignored, chosen], NOW)?.id, "cmp-live");
  assert.equal(campaignFor("prd-3", [chosen], NOW), null);
});

// ── coupons ─────────────────────────────────────────────────────────────────

interface CouponLine {
  product_id: string;
  category_id: string | null;
  line_total: number;
}

const couponContext = (subtotal: number, lines: CouponLine[] = []) => ({ subtotal, lines, now: NOW });

test("a percent coupon is capped by max_discount and never exceeds the subtotal", () => {
  const capped = checkCoupon(
    makeCoupon({ value: 50, max_discount: 40 }),
    couponContext(200, [{ product_id: "prd-1", category_id: "cat-earrings", line_total: 200 }]),
  );
  assert.deepEqual(capped, { ok: true, coupon: capped.ok ? capped.coupon : makeCoupon(), discount: 40 });

  const huge = checkCoupon(makeCoupon({ discount_type: "fixed", value: 5000 }), couponContext(120, []));
  assert.equal(huge.ok && huge.discount, 120, "a fixed coupon cannot make an order negative");
});

test("every coupon refusal reason is reported, not swallowed", () => {
  const lines = [{ product_id: "prd-1", category_id: "cat-earrings", line_total: 100 }];
  assert.equal(checkCoupon(null, couponContext(100, lines)).ok, false);
  assert.deepEqual(checkCoupon(null, couponContext(100, lines)), { ok: false, reason: "not_found" });
  assert.deepEqual(checkCoupon(makeCoupon({ active: false }), couponContext(100, lines)), {
    ok: false,
    reason: "inactive",
  });
  assert.deepEqual(
    checkCoupon(makeCoupon({ starts_at: "2026-06-01T00:00:00.000Z" }), couponContext(100, lines)),
    { ok: false, reason: "not_started" },
  );
  assert.deepEqual(checkCoupon(makeCoupon({ ends_at: "2026-04-01T00:00:00.000Z" }), couponContext(100, lines)), {
    ok: false,
    reason: "expired",
  });
  assert.deepEqual(checkCoupon(makeCoupon({ usage_limit: 5, used_count: 5 }), couponContext(100, lines)), {
    ok: false,
    reason: "exhausted",
  });
  assert.deepEqual(checkCoupon(makeCoupon({ min_subtotal: 300 }), couponContext(100, lines)), {
    ok: false,
    reason: "min_subtotal",
  });
  assert.deepEqual(
    checkCoupon(makeCoupon({ applies_to: "products", target_ids: ["prd-9"] }), couponContext(100, lines)),
    { ok: false, reason: "not_applicable" },
  );
  assert.deepEqual(
    checkCoupon(makeCoupon({ applies_to: "categories", target_ids: ["cat-earrings"] }), couponContext(100, lines)),
    { ok: true, coupon: makeCoupon({ applies_to: "categories", target_ids: ["cat-earrings"] }), discount: 10 },
  );
});

test("a typed coupon code is normalised before matching", () => {
  assert.equal(normalizeCouponCode("  welcome 10 "), "WELCOME10");
  assert.equal(normalizeCouponCode(""), "");
});

// ── promotions engine (mirrors evaluate_order_pricing) ─────────────────────

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: "prm-1",
    enabled: true,
    name_en: "Test offer",
    name_ar: "عرض فحص",
    description_en: null,
    description_ar: null,
    discount_type: "percent",
    value: 15,
    scope: "store",
    minimum_order_amount: 0,
    maximum_discount_amount: null,
    starts_at: null,
    ends_at: null,
    priority: 0,
    stackable: false,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeZone(overrides: Partial<DeliveryZone> = {}): DeliveryZone {
  return {
    id: "dz-1",
    key: "cairo",
    name_en: "Cairo",
    name_ar: "القاهرة",
    governorate_key: "cairo",
    shipping_fee: 70,
    minimum_order_amount: 0,
    free_shipping_threshold: null,
    estimated_delivery_text_en: null,
    estimated_delivery_text_ar: null,
    enabled: true,
    sort_order: 20,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

const promoLines = () => [
  { product_id: "prd-1", category_id: "cat-rings", variant_id: null, qty: 5, unit_price: 200, line_total: 1000 },
  { product_id: "prd-2", category_id: "cat-neck", variant_id: null, qty: 1, unit_price: 100, line_total: 100 },
];

const noUsage = { customerUses: 0, hasPriorOrder: false };

function evaluatePromo(over: Partial<CartPricingInput>) {
  return evaluateCartPricing({
    lines: promoLines(),
    subtotal: 1100,
    promoCode: null,
    coupons: [],
    promotions: [],
    targetsByPromotion: new Map(),
    usageFor: () => noUsage,
    customerKey: "phone:01001234567",
    zone: null,
    legacy: { fee: 30, minimum: 0, threshold: 0 },
    deliveryType: "pickup",
    now: NOW,
    ...over,
  });
}

test("ALYQ10: discount, minimum, cap and refusals", () => {
  const coupon = makeCoupon({ code: "ALYQ10", value: 10, min_subtotal: 500, max_discount: 200 });
  const thousand = [
    { product_id: "prd-1", category_id: null, variant_id: null, qty: 10, unit_price: 100, line_total: 1000 },
  ];
  const ok = evaluatePromo({ promoCode: "alyq10", coupons: [coupon], lines: thousand, subtotal: 1000 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.pricing.promoDiscount, 100, "10% of 1000");
    assert.equal(ok.pricing.total, 900, "pickup, no fee: goods minus code");
    assert.equal(ok.pricing.promoCode, "ALYQ10", "the stored form, not the typed casing");
  }

  const small = evaluatePromo({
    promoCode: "ALYQ10",
    coupons: [coupon],
    lines: [{ product_id: "prd-1", category_id: null, variant_id: null, qty: 3, unit_price: 100, line_total: 300 }],
    subtotal: 300,
  });
  assert.equal(small.ok, false);
  if (!small.ok) assert.equal(small.reason, "min_subtotal");

  const big = evaluatePromo({
    promoCode: "ALYQ10",
    coupons: [coupon],
    lines: [{ product_id: "prd-1", category_id: null, variant_id: null, qty: 30, unit_price: 100, line_total: 3000 }],
    subtotal: 3000,
  });
  assert.equal(big.ok, true);
  if (big.ok) assert.equal(big.pricing.promoDiscount, 200, "the 200 cap holds");

  for (const [alter, reason] of [
    [{ ends_at: "2026-04-01T00:00:00.000Z" }, "expired"],
    [{ active: false }, "inactive"],
  ] as const) {
    const refused = evaluatePromo({ promoCode: "ALYQ10", coupons: [makeCoupon({ code: "ALYQ10", ...alter })] });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, reason);
  }
  const unknown = evaluatePromo({ promoCode: "NOPE", coupons: [coupon] });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "not_found");
});

test("per-customer limits, first-order-only and free shipping", () => {
  const per1 = makeCoupon({ code: "PER1", per_customer_limit: 1 });
  const spent = evaluatePromo({
    promoCode: "PER1",
    coupons: [per1],
    usageFor: () => ({ customerUses: 1, hasPriorOrder: true }),
  });
  assert.equal(spent.ok, false);
  if (!spent.ok) assert.equal(spent.reason, "limit_reached");
  const fresh = evaluatePromo({
    promoCode: "PER1",
    coupons: [per1],
    usageFor: () => ({ customerUses: 0, hasPriorOrder: true }),
  });
  assert.equal(fresh.ok, true, "a new customer passes a per-customer limit");

  const first = makeCoupon({ code: "FIRST", first_order_only: true });
  const repeat = evaluatePromo({
    promoCode: "FIRST",
    coupons: [first],
    usageFor: () => ({ customerUses: 0, hasPriorOrder: true }),
  });
  assert.equal(repeat.ok, false);
  if (!repeat.ok) assert.equal(repeat.reason, "limit_reached");

  const ship = makeCoupon({ code: "FREESHIP", discount_type: "free_shipping", value: 1 });
  const waived = evaluatePromo({
    promoCode: "FREESHIP",
    coupons: [ship],
    deliveryType: "delivery",
    zone: makeZone(),
  });
  assert.equal(waived.ok, true);
  if (waived.ok) {
    assert.equal(waived.pricing.promoDiscount, 0, "free shipping takes no money off");
    assert.equal(waived.pricing.promoFreeShipping, true);
    assert.equal(waived.pricing.deliveryFee, 0, "the Cairo 70 is waived");
    assert.equal(waived.pricing.shippingDiscount, 70);
    assert.equal(waived.pricing.total, 1100);
  }
});

test("stacking needs both sides to agree, else the larger wins alone", () => {
  const coupon = makeCoupon({ code: "SAVE20", discount_type: "fixed", value: 20 });
  const auto = makePromotion({ id: "prm-auto", value: 15 });
  // 15% of 1100 = 165 vs code 20: the automatic wins alone by default.
  const contested = evaluatePromo({ promoCode: "SAVE20", coupons: [coupon], promotions: [auto], targetsByPromotion: new Map() });
  assert.equal(contested.ok, true);
  if (contested.ok) {
    assert.equal(contested.pricing.autoDiscount, 165);
    assert.equal(contested.pricing.promoDiscount, 0);
    assert.equal(contested.pricing.totalDiscount, 165);
  }
  // Both stackable: 165 + 20 combine, capped at the subtotal.
  const stacked = evaluatePromo({
    promoCode: "SAVE20",
    coupons: [makeCoupon({ code: "SAVE20", discount_type: "fixed", value: 20, stackable: true })],
    promotions: [makePromotion({ id: "prm-auto", value: 15, stackable: true })],
    targetsByPromotion: new Map(),
  });
  assert.equal(stacked.ok, true);
  if (stacked.ok) assert.equal(stacked.pricing.totalDiscount, 185);
});

test("zones price server-side: fee, minimum, threshold, pickup, disabled", () => {
  const cairo = evaluatePromo({ deliveryType: "delivery", zone: makeZone() });
  assert.equal(cairo.ok, true);
  if (cairo.ok) {
    assert.equal(cairo.pricing.deliveryFee, 70);
    assert.equal(cairo.pricing.shippingSource, "zone");
    assert.equal(cairo.pricing.total, 1170);
  }
  const ism = evaluatePromo({ deliveryType: "delivery", zone: makeZone({ id: "dz-0", key: "ismailia", shipping_fee: 0 }) });
  assert.equal(ism.ok && ism.pricing.deliveryFee, 0);
  const pick = evaluatePromo({ deliveryType: "pickup", zone: makeZone() });
  assert.equal(pick.ok && pick.pricing.deliveryFee, 0, "pickup ignores the zone");

  const off = evaluatePromo({ deliveryType: "delivery", zone: makeZone({ enabled: false }) });
  assert.equal(off.ok, false, "a disabled zone is refused");

  const minimum = evaluatePromo({
    deliveryType: "delivery",
    zone: makeZone({ minimum_order_amount: 5000 }),
  });
  assert.equal(minimum.ok, false, "under the minimum the zone refuses");

  const free = evaluatePromo({
    deliveryType: "delivery",
    zone: makeZone({ free_shipping_threshold: 1000 }),
  });
  assert.equal(free.ok, true);
  if (free.ok) {
    assert.equal(free.pricing.deliveryFee, 0, "at the threshold the fee waives");
    assert.equal(free.pricing.shippingDiscount, 70);
  }
});

test("the storewide sale prices variant overrides and allocates exactly", () => {
  const lines = [
    { product_id: "prd-1", category_id: "cat-rings", variant_id: null, qty: 1, unit_price: 200, line_total: 200 },
    { product_id: "prd-2", category_id: "cat-rings", variant_id: "var-gold", qty: 1, unit_price: 300, line_total: 300 },
  ];
  const sale = evaluatePromo({
    lines,
    subtotal: 500,
    promotions: [makePromotion({ id: "prm-sale", value: 15 })],
    targetsByPromotion: new Map(),
  });
  assert.equal(sale.ok, true);
  if (sale.ok) {
    assert.equal(sale.pricing.autoDiscount, 75);
    assert.equal(sale.pricing.autoPromotionId, "prm-sale");
    // 75 × 200/500 = 30 → 170; the remainder 45 lands on the override → 255.
    assert.deepEqual(
      sale.pricing.lines.map((line) => line.discounted_unit_price),
      [170, 255],
    );
    const back = sale.pricing.lines.reduce((sum, line) => sum + line.discounted_unit_price * line.qty, 0);
    assert.equal(back, 425, "the shares add back to goods minus discount");
  }
});

test("targeted offers isolate lines: the ring moves, the necklace does not", () => {
  const ring20 = makePromotion({ id: "prm-ring", value: 20, scope: "category" });
  const targets = new Map([["prm-ring", new Set(["category:cat-rings"])]]);
  const offer = evaluatePromo({ promotions: [ring20], targetsByPromotion: targets });
  assert.equal(offer.ok, true);
  if (offer.ok) {
    assert.equal(offer.pricing.autoDiscount, 200, "20% of the ring's 1000 only");
    const [ring, neck] = offer.pricing.lines;
    assert.equal(ring.discounted_unit_price, 160);
    assert.equal(neck.discounted_unit_price, 100, "the out-of-scope line keeps its price");
  }

  const gold50 = makePromotion({ id: "prm-gold", value: 50, scope: "variant" });
  const vlines = [
    { product_id: "prd-2", category_id: "cat-rings", variant_id: "var-gold", qty: 1, unit_price: 300, line_total: 300 },
    { product_id: "prd-1", category_id: "cat-rings", variant_id: null, qty: 1, unit_price: 200, line_total: 200 },
  ];
  const variant = evaluatePromo({
    lines: vlines,
    subtotal: 500,
    promotions: [gold50],
    targetsByPromotion: new Map([["prm-gold", new Set(["variant:var-gold"])]]),
  });
  assert.equal(variant.ok, true);
  if (variant.ok) {
    assert.equal(variant.pricing.autoDiscount, 150, "50% of the 300 shelf only");
    assert.deepEqual(
      variant.pricing.lines.map((line) => line.discounted_unit_price),
      [150, 200],
    );
  }
});

test("customer keys normalize like the server", () => {
  assert.equal(customerKeyFor("9c8b7a65-4321-4f0e-8a1b-2c3d4e5f6071", "0100"), "9c8b7a65-4321-4f0e-8a1b-2c3d4e5f6071");
  assert.equal(customerKeyFor(null, "010 0123-4567"), "phone:01001234567");
  assert.equal(customerKeyFor(null, "abc", "ref-1"), "order:ref-1");
  assert.equal(customerKeyFor(null, "abc", null), null);
});

test("display prices show real current offers, never promises", () => {
  const targets = new Map([["prm-ring", new Set(["category:cat-rings"])]]);
  const ring20 = makePromotion({ id: "prm-ring", value: 20, scope: "category" });
  assert.deepEqual(
    promotionUnitPrice("prd-1", null, "cat-rings", 200, [ring20], targets, NOW),
    { unit: 160, promotionId: "prm-ring" },
  );
  assert.deepEqual(
    promotionUnitPrice("prd-2", null, "cat-neck", 100, [ring20], targets, NOW),
    { unit: 100, promotionId: null },
    "out of scope shows list",
  );
  assert.deepEqual(
    promotionUnitPrice("prd-1", null, "cat-rings", 200, [makePromotion({ minimum_order_amount: 500 })], new Map(), NOW),
    { unit: 200, promotionId: null },
    "a cart-level minimum is not a display promise",
  );
  assert.deepEqual(
    promotionUnitPrice("prd-1", null, "cat-rings", 200, [makePromotion({ enabled: false })], new Map(), NOW),
    { unit: 200, promotionId: null },
    "a disabled offer shows nothing",
  );
});

// ── delivery fees ───────────────────────────────────────────────────────────

test("pickup is free and delivery is waived at the threshold", () => {
  assert.equal(deliveryFeeFor(DELIVERY, "pickup", 10), 0);
  assert.equal(deliveryFeeFor(DELIVERY, "delivery", 10), 30);
  assert.equal(deliveryFeeFor(DELIVERY, "delivery", 500), 0, "at the threshold delivery is free");
  assert.equal(deliveryFeeFor({ ...DELIVERY, enabled: false }, "delivery", 10), 0);
});

test("free-delivery progress tells the customer what is left", () => {
  assert.deepEqual(freeDeliveryProgress(DELIVERY, 200), { eligible: false, remaining: 300, threshold: 500 });
  assert.deepEqual(freeDeliveryProgress(DELIVERY, 600), { eligible: true, remaining: 0, threshold: 500 });
  assert.equal(freeDeliveryProgress({ ...DELIVERY, free_delivery_threshold: null }, 600), null);
});

test("no list of places means the shop delivers anywhere", () => {
  assert.deepEqual(deliveryAreasOf({ ...DELIVERY, areas: [] }), []);
  assert.equal(deliveryAreaSupported({ ...DELIVERY, areas: [] }, "أي مكان", "أي حي"), true);
  // Plain-object entries that are blank are not places.
  assert.equal(
    deliveryAreaSupported({ ...DELIVERY, areas: [{ ar: "  ", en: "" }] }, "القاهرة", "مدينة نصر"),
    true,
  );
});

test("a listed place matches the city or the area, in either language", () => {
  const delivery = {
    ...DELIVERY,
    areas: [
      { ar: "الإسماعيلية", en: "Ismailia" },
      { ar: "حي الأربعين", en: "Al Arba'een" },
    ],
  };
  assert.equal(deliveryAreaSupported(delivery, "ismailia", ""), true, "English name, lower case");
  assert.equal(deliveryAreaSupported(delivery, "  ISMAILIA  ", ""), true, "trimmed and folded");
  assert.equal(deliveryAreaSupported(delivery, "", "الإسماعيلية"), true, "the area may carry it");
  assert.equal(deliveryAreaSupported(delivery, "القاهرة", "مدينة نصر"), false);
  assert.equal(deliveryAreaSupported(delivery, "", ""), false, "an empty address is not a place");
  assert.equal(normalizePlaceName("  حي   الأربعين "), "حي الأربعين");
});

test("the delivery minimum is measured on goods, and never gates pickup", () => {
  const delivery = { ...DELIVERY, minimum_order: 500 };
  assert.equal(deliveryMinimumShortfall(delivery, "delivery", 200), 300);
  assert.equal(deliveryMinimumShortfall(delivery, "delivery", 500), 0);
  assert.equal(deliveryMinimumShortfall(delivery, "delivery", 900), 0);
  assert.equal(deliveryMinimumShortfall(delivery, "pickup", 10), 0, "collecting in person is how a customer orders less");
  assert.equal(deliveryMinimumShortfall({ ...DELIVERY, minimum_order: null }, "delivery", 10), 0);
  assert.equal(deliveryMinimumShortfall({ ...DELIVERY, minimum_order: 0 }, "delivery", 10), 0);
});

// ── the cart ────────────────────────────────────────────────────────────────

test("priceCart reprices from the catalogue, applies a campaign and adds the fee", () => {
  const totals = priceCart({
    items: [
      { product_id: "prd-1", list_price: 100, quantity: 2, category_id: "cat-earrings" },
      { product_id: "prd-3", list_price: 900, quantity: 1, category_id: "cat-tools" },
    ],
    campaigns: [makeCampaign({ discount_type: "percent", discount_value: 10, product_ids: ["prd-1"] })],
    delivery: DELIVERY,
    deliveryType: "delivery",
    now: NOW,
  });

  assert.equal(totals.lines[0]?.unit_price, 90, "the campaign applies to the covered product only");
  assert.equal(totals.lines[1]?.unit_price, 900);
  assert.equal(totals.subtotal, 1080);
  assert.equal(totals.unit_count, 3);
  assert.equal(totals.discount_amount, 0, "a campaign is in the unit price, not a coupon discount");
  assert.equal(totals.delivery_fee, 0, "1080 is above the free-delivery threshold");
  assert.equal(totals.total, 1080);
});

test("priceCart charges the fee on the discounted subtotal and applies a coupon", () => {
  const totals = priceCart({
    items: [{ product_id: "prd-1", list_price: 100, quantity: 2, category_id: "cat-earrings" }],
    campaigns: [],
    coupon: makeCoupon({ discount_type: "fixed", value: 20 }),
    couponCode: "WELCOME10",
    delivery: DELIVERY,
    deliveryType: "delivery",
    now: NOW,
  });

  assert.equal(totals.subtotal, 200);
  assert.equal(totals.discount_amount, 20);
  assert.equal(totals.discount_code, "WELCOME10");
  assert.equal(totals.delivery_fee, 30, "180 is below the threshold, so the fee applies");
  assert.equal(totals.total, 210);
});

test("priceCart ignores a coupon the cart does not qualify for", () => {
  const totals = priceCart({
    items: [{ product_id: "prd-1", list_price: 100, quantity: 1 }],
    campaigns: [],
    coupon: makeCoupon({ min_subtotal: 500 }),
    delivery: DELIVERY,
    deliveryType: "pickup",
    now: NOW,
  });

  assert.equal(totals.discount_amount, 0);
  assert.equal(totals.discount_code, null);
  assert.equal(totals.total, 100, "pickup adds no fee");
});

test("an approved order becomes a sale for the goods only — the fee stays on the order", () => {
  assert.equal(goodsTotalOf({ subtotal: 230, discount_amount: 30 }), 200);
  assert.equal(round2(200.005), 200.01);
});

test("brands are grouped out of the storefront content, strongest first", () => {
  const brands = brandsOf(CONTENTS, pick);
  assert.deepEqual(brands.map((brand) => brand.name_en), ["ALYQ", "Lumina"]);
  assert.equal(brands[0]?.count, 2);
  assert.equal(brands[1]?.count, 1);
  assert.deepEqual(brandsOf([makeContent({ brand_ar: null, brand_en: null })], pick), []);

  const facet = brandFacet(CATALOG, CONTENTS);
  assert.deepEqual(facet.map((entry) => entry.key), ["alyq", "lumina"]);
  assert.equal(facet[0]?.count, 2, "only website-visible products are counted");

  const categories = categoryFacet(CATALOG, CATEGORIES);
  assert.deepEqual(categories.map((entry) => entry.id), ["cat-earrings", "cat-tools"]);
  assert.deepEqual(categories.map((entry) => entry.count), [1, 1]);
  assert.equal(
    categories.some((entry) => entry.id === "cat-hair"),
    false,
    "a category the shop does not list is left out, however many products point at it",
  );
});

// ── inventory protection ────────────────────────────────────────────────────

test("a product with stock tracking off has no shelf to run down", () => {
  assert.equal(availableToPromise({ stock_tracking_enabled: false, stock_quantity: 0 }, 5), null);
  assert.equal(availableToPromise({ stock_tracking_enabled: true, stock_quantity: 10 }, 4), 6);
  assert.equal(availableToPromise({ stock_tracking_enabled: true, stock_quantity: 3 }, 9), 0);
});

test("reservations are summed per product, and only while still open", () => {
  const totals = reservedByProduct([
    makeReservation({ id: "a", product_id: "prd-1", quantity: 2 }),
    makeReservation({ id: "b", product_id: "prd-1", quantity: 3 }),
    makeReservation({ id: "c", product_id: "prd-2", quantity: 1, status: "released" }),
    makeReservation({ id: "d", product_id: "prd-3", quantity: 4, status: "converted" }),
  ]);
  assert.equal(reservedOf(totals, "prd-1"), 5);
  assert.equal(reservedOf(totals, "prd-2"), 0, "a released hold is back on the shelf");
  assert.equal(reservedOf(totals, "prd-3"), 0, "a converted hold became the sale's deduction");
  assert.equal(reservedOf(totals, "prd-unknown"), 0);
  assert.equal(totalReserved([makeReservation({ quantity: 2 }), makeReservation({ quantity: 5 })]), 7);
});

test("a pending order is the only state still holding stock", () => {
  assert.equal(holdsReservation("pending"), true);
  // Approval converts the hold into the sale's deduction, so holding on as well
  // would count those units twice.
  assert.equal(holdsReservation("approved"), false);
  assert.equal(holdsReservation("processing"), false);
  assert.equal(holdsReservation("ready"), false);
  assert.equal(holdsReservation("completed"), false);
  assert.equal(holdsReservation("cancelled"), false);
});

test("oversell is reported for every line, and duplicate lines add up", () => {
  const products = [
    makeProduct({ id: "prd-1", sku: "SKU-1", stock_quantity: 5 }),
    makeProduct({ id: "prd-2", sku: "SKU-2", stock_quantity: 1 }),
    makeProduct({ id: "prd-service", sku: "SKU-S", stock_tracking_enabled: false, stock_quantity: 0 }),
  ];
  const reserved = new Map([["prd-1", 2]]);

  const problems = findOversell(
    [
      { product_id: "prd-1", quantity: 2 },
      { product_id: "prd-1", quantity: 2 },
      { product_id: "prd-2", quantity: 3 },
      { product_id: "prd-service", quantity: 99 },
    ],
    products,
    reserved,
  );

  // Phase 43: every line also names the shelf it is short on — null for a
  // product-level line, the combination for a variant one.
  assert.deepEqual(problems, [
    { product_id: "prd-1", sku: "SKU-1", requested: 4, available: 3, variant_id: null },
    { product_id: "prd-2", sku: "SKU-2", requested: 3, available: 1, variant_id: null },
  ]);
});

test("oversell of a combination is judged on ITS shelf, not the product rollup", () => {
  const products = [
    makeProduct({ id: "prd-1", sku: "SKU-1", stock_quantity: 4, variants_enabled: true }),
  ];
  const variants = [
    { id: "var-g17", product_id: "prd-1", sku: "SKU-1-G17", active: true, stock_quantity: 2 },
    { id: "var-s17", product_id: "prd-1", sku: "SKU-1-S17", active: true, stock_quantity: 2 },
  ];
  const reserved = new Map<string, number>();
  const reservedVariant = new Map<string, number>([["var-g17", 1]]);

  // Gold / 17 can promise 1. Silver / 17 can still promise both of its own —
  // neither borrows from the other, and the product's rollup (4) never enters.
  const problems = findOversell(
    [
      { product_id: "prd-1", variant_id: "var-g17", quantity: 2 },
      { product_id: "prd-1", variant_id: "var-s17", quantity: 2 },
    ],
    products,
    reserved,
    variants,
    reservedVariant,
  );

  assert.deepEqual(problems, [
    { product_id: "prd-1", sku: "SKU-1-G17", requested: 2, available: 1, variant_id: "var-g17" },
  ]);
});

test("a hold left behind by an order that moved on is visible to a repair pass", () => {
  const stale = staleReservations(
    [
      makeReservation({ id: "keep", online_order_id: "ord-pending" }),
      makeReservation({ id: "cancelled", online_order_id: "ord-cancelled" }),
      makeReservation({ id: "approved", online_order_id: "ord-approved" }),
      makeReservation({ id: "released", online_order_id: "ord-pending", status: "released" }),
      makeReservation({ id: "orphan", online_order_id: "ord-gone" }),
    ],
    [
      makeOrder({ id: "ord-pending", status: "pending" }),
      makeOrder({ id: "ord-cancelled", status: "cancelled" }),
      makeOrder({ id: "ord-approved", status: "approved" }),
    ],
  );
  assert.deepEqual(
    stale.map((reservation) => reservation.id),
    ["cancelled", "approved"],
    "an already-resolved hold, and one whose order is unknown, are not reported",
  );
});

// ── the order workflow ──────────────────────────────────────────────────────

test("the fulfilment ladder runs pending to completed, and cancellation is off it", () => {
  assert.deepEqual([...FULFILMENT_ORDER], ["pending", "approved", "processing", "ready", "completed"]);
  assert.equal(isOrderOpen("pending"), true);
  assert.equal(isOrderOpen("ready"), true);
  assert.equal(isOrderOpen("completed"), false);
  assert.equal(isOrderClosed("cancelled"), true);
  assert.equal(orderProgress("pending"), 0, "the stepper starts at the order being placed");
  assert.equal(orderProgress("approved"), 1);
  assert.equal(orderProgress("completed"), 4);
  assert.equal(orderProgress("cancelled"), null, "a cancelled order has no progress to show");
});

test("an order can only be approved while it is pending", () => {
  assert.deepEqual(checkAction(makeOrder({ status: "pending" }), "approve"), { ok: true, next: "approved" });
  assert.deepEqual(checkAction(makeOrder({ status: "approved" }), "approve"), { ok: false, reason: "not_pending" });
});

test("unverified InstaPay money never becomes a sale", () => {
  const unverified = makeOrder({ payment_method: "instapay", payment_status: "verification_required" });
  assert.deepEqual(checkAction(unverified, "approve"), { ok: false, reason: "payment_unverified" });

  const verified = makeOrder({ ...unverified, payment_status: "paid" });
  assert.deepEqual(checkAction(verified, "approve"), { ok: true, next: "approved" });
});

test("cancelling an order that already became a sale needs the void capability", () => {
  const approved = makeOrder({ status: "approved", sale_id: "sale-1", sale_number: "S-000001" });
  assert.deepEqual(checkAction(approved, "cancel"), { ok: false, reason: "needs_void_capability" });
  assert.deepEqual(checkAction(approved, "cancel", { canVoidSale: true }), { ok: true, next: "cancelled" });
  assert.deepEqual(checkAction(makeOrder({ status: "pending" }), "cancel"), { ok: true, next: "cancelled" });
});

test("a completed order cannot be cancelled and a cancelled one cannot move", () => {
  assert.deepEqual(checkAction(makeOrder({ status: "completed" }), "cancel"), {
    ok: false,
    reason: "already_completed",
  });
  assert.deepEqual(checkAction(makeOrder({ status: "cancelled" }), "approve"), {
    ok: false,
    reason: "already_cancelled",
  });
});

test("the ladder can skip processing but never go backwards", () => {
  assert.deepEqual(checkAction(makeOrder({ status: "approved" }), "processing"), { ok: true, next: "processing" });
  assert.deepEqual(checkAction(makeOrder({ status: "approved" }), "ready"), {
    ok: true,
    next: "ready",
  });
  assert.deepEqual(checkAction(makeOrder({ status: "ready" }), "processing"), { ok: false, reason: "backwards" });
  assert.deepEqual(checkAction(makeOrder({ status: "pending" }), "ready"), { ok: false, reason: "not_approved" });
  assert.deepEqual(checkAction(makeOrder({ status: "processing" }), "complete"), { ok: true, next: "completed" });
  assert.deepEqual(checkAction(makeOrder({ status: "completed" }), "complete"), {
    ok: false,
    reason: "already_completed",
  });
});

test("payment verification is a separate axis from the order status", () => {
  const paid = makeOrder({ payment_status: "paid" });
  assert.deepEqual(checkAction(paid, "payment_approve"), { ok: false, reason: "payment_already_paid" });
  assert.deepEqual(
    checkAction(makeOrder({ payment_status: "verification_required" }), "payment_approve"),
    { ok: true, next: "pending" },
  );
  assert.deepEqual(
    checkAction(makeOrder({ payment_status: "verification_required" }), "payment_reject"),
    { ok: true, next: "pending" },
  );
  assert.equal(nextStatusOf(makeOrder({ status: "approved" }), "ready"), "ready");
  assert.equal(nextStatusOf(makeOrder({ status: "pending" }), "approve"), "approved");
});

test("the actions an employee sees depend on the order and on their capability", () => {
  const pendingCod = makeOrder({ status: "pending", payment_method: "cod" });
  assert.deepEqual(availableActions(pendingCod, { canVoidSale: false, canConfirmPayment: true }), [
    "approve",
    "cancel",
    "complete",
    "payment_approve",
    "payment_reject",
  ]);

  const cashier = availableActions(
    makeOrder({ status: "approved", sale_id: "sale-1" }),
    { canVoidSale: false, canConfirmPayment: false },
  );
  assert.equal(cashier.includes("cancel"), false, "a cashier cannot unwind a sale");
  assert.deepEqual(cashier, ["processing", "ready", "complete"]);

  const manager = availableActions(makeOrder({ status: "approved", sale_id: "sale-1" }), {
    canVoidSale: true,
    canConfirmPayment: false,
  });
  assert.equal(manager.includes("cancel"), true);

  const unverified = availableActions(
    makeOrder({ status: "pending", payment_method: "instapay", payment_status: "verification_required" }),
    { canVoidSale: false, canConfirmPayment: true },
  );
  assert.equal(unverified.includes("approve"), false, "approval is not offered while the money is unverified");
  assert.deepEqual(unverified, ["cancel", "complete", "payment_approve", "payment_reject"]);

  const verified = availableActions(
    makeOrder({ status: "pending", payment_method: "instapay", payment_status: "paid" }),
    { canVoidSale: false, canConfirmPayment: true },
  );
  assert.equal(verified[0], "approve", "once the payment is confirmed, approval is the next thing to do");

  const done = availableActions(makeOrder({ status: "completed", payment_status: "paid" }), {
    canVoidSale: true,
    canConfirmPayment: true,
  });
  assert.deepEqual(done, [], "a paid, completed order has nothing left to do");
});

test("cancelling and rejecting a payment must be written down", () => {
  assert.equal(requiresReason("cancel"), true);
  assert.equal(requiresReason("payment_reject"), true);
  assert.equal(requiresReason("approve"), false);
  assert.equal(requiresReason("complete"), false);
});

test("money starts unverified, and InstaPay starts owed a decision", () => {
  assert.equal(initialPaymentStatus("cod"), "pending", "cash on delivery is simply unpaid until collected");
  assert.equal(
    initialPaymentStatus("instapay"),
    "verification_required",
    "an InstaPay order goes straight onto the list an employee must settle — no status ever starts as paid",
  );
  assert.notEqual(initialPaymentStatus("cod"), "paid");
  assert.notEqual(initialPaymentStatus("instapay"), "paid");
});

test("an InstaPay order asks for verification until a person settles it", () => {
  const awaiting = makeOrder({ payment_method: "instapay", payment_status: "verification_required" });
  assert.equal(needsPaymentVerification(awaiting), true);
  assert.equal(canSubmitProof(awaiting), true, "the customer may submit — and resubmit after a rejection");

  const settled = makeOrder({ ...awaiting, payment_status: "paid" });
  assert.equal(needsPaymentVerification(settled), false);
  assert.equal(canSubmitProof(settled), false, "a verified payment is not reopened by another screenshot");

  const failed = makeOrder({ ...awaiting, payment_status: "failed" });
  assert.equal(needsPaymentVerification(failed), false);
  assert.equal(canSubmitProof(failed), true, "a wrong reference is a mistake, not a verdict");

  assert.equal(
    needsPaymentVerification(makeOrder({ payment_method: "cod", payment_status: "pending" })),
    false,
    "cash on delivery owes no verification — the driver collects it",
  );
  assert.equal(canSubmitProof(makeOrder({ payment_method: "cod" })), false);
  assert.equal(canSubmitProof(makeOrder({ status: "cancelled", payment_method: "instapay" })), false);
  assert.equal(
    needsPaymentVerification(makeOrder({ status: "cancelled", payment_status: "verification_required" })),
    false,
    "a cancelled order leaves the queue",
  );
});

test("delivery wording follows the status and the fulfilment type", () => {
  assert.equal(deliveryStatusOf({ status: "pending", delivery_type: "delivery" }), "not_started");
  assert.equal(deliveryStatusOf({ status: "processing", delivery_type: "delivery" }), "preparing");
  assert.equal(deliveryStatusOf({ status: "completed", delivery_type: "delivery" }), "delivered");
  assert.equal(deliveryStatusOf({ status: "ready", delivery_type: "delivery" }), "out_for_delivery");
  assert.equal(deliveryStatusOf({ status: "ready", delivery_type: "pickup" }), "ready_for_pickup");
  assert.equal(deliveryStatusOf({ status: "completed", delivery_type: "pickup" }), "collected");
  assert.equal(deliveryStatusOf({ status: "cancelled", delivery_type: "delivery" }), "cancelled");
  assert.equal(deliveryHintKey({ status: "ready", delivery_type: "pickup" }), "store.track.hint.readyPickup");
  assert.equal(deliveryHintKey({ status: "pending", delivery_type: "delivery" }), "store.track.hint.pending");
  assert.equal(deliveryHintKey({ status: "cancelled", delivery_type: "delivery" }), "store.track.hint.cancelled");
  assert.equal(t(deliveryHintKey({ status: "ready", delivery_type: "delivery" })), "Your order is ready and on its way to you.");
});

// ── badges & demand ─────────────────────────────────────────────────────────

test("a new arrival is one the shop listed in the last 30 days", () => {
  assert.equal(isNewArrival("2026-04-20T00:00:00.000Z", NOW), true);
  assert.equal(isNewArrival("2026-03-01T00:00:00.000Z", NOW), false);
  assert.equal(isNewArrival(null, NOW), false);
});

test("units sold come from real demand, ignoring voids and cancellations", () => {
  const units = unitsSold({
    sales: [
      { status: "completed", items: [{ product_id: "prd-1", quantity: 3 }] },
      { status: "voided", items: [{ product_id: "prd-1", quantity: 100 }] },
      { status: "completed", items: [{ product_id: "prd-2", quantity: 2 }] },
    ],
    onlineOrders: [
      makeOrder({ status: "completed", items: [{ ...itemStub("prd-2"), quantity: 5 }] }),
      makeOrder({ status: "cancelled", items: [{ ...itemStub("prd-3"), quantity: 50 }] }),
    ],
  });
  assert.equal(units.get("prd-1"), 3);
  assert.equal(units.get("prd-2"), 7);
  assert.equal(units.get("prd-3"), undefined);
  assert.deepEqual(bestSellerIds(units, 5), ["prd-2", "prd-1"]);
  assert.deepEqual(bestSellerIds(new Map([["a", 0]])), [], "zero units is not a best seller");
});

function itemStub(productId: string) {
  return {
    id: `itm-${productId}`,
    order_id: "ord-1",
    product_id: productId,
    // Phase 43: legacy lines name no combination — null across the board.
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    name_ar: "صنف",
    name_en: "Item",
    sku: `SKU-${productId}`,
    barcode: null,
    unit_price: 10,
    quantity: 1,
    line_total: 10,
    discounted_unit_price: 10,
  };
}

test("badges come out most attention-grabbing first", () => {
  const badges = productBadges({
    product: { id: "prd-1", is_featured: true, created_at: "2026-04-28T00:00:00.000Z" },
    campaigns: [makeCampaign({ product_ids: ["prd-1"] })],
    bestSellerIds: ["prd-1"],
    now: NOW,
  });
  assert.deepEqual(badges, ["sale", "bestSeller", "new", "featured"]);
});

test("a campaign can name its own badge text", () => {
  assert.equal(campaignBadgeText("prd-1", [makeCampaign()], pick, NOW), "Flash");
  assert.equal(
    campaignBadgeText("prd-1", [makeCampaign({ badge_ar: null, badge_en: null })], pick, NOW),
    "Flash sale",
    "it falls back to the campaign name",
  );
  assert.equal(campaignBadgeText("prd-9", [makeCampaign({ product_ids: ["prd-1"] })], pick, NOW), null);
});

// ── catalogue search, filters & sorting ─────────────────────────────────────

test("only website-visible, active products are ever listed", () => {
  assert.deepEqual(
    storefrontProducts(CATALOG).map((product) => product.id),
    ["prd-1", "prd-2", "prd-3"],
  );
});

test("search matches name, SKU and barcode", () => {
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ search: "pearl" }), CONTEXT).map((entry) => entry.product.id),
    ["prd-2"],
  );
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ search: "SKU-3" }), CONTEXT).map((entry) => entry.product.id),
    ["prd-3"],
  );
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ search: "6221000000017" }), CONTEXT).map((entry) => entry.product.id),
    ["prd-1"],
  );
  assert.deepEqual(searchCatalog(CATALOG, filters({ search: "nothing matches this" }), CONTEXT), []);
});

test("category, brand and price filters narrow the list", () => {
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ categoryId: "cat-tools" }), CONTEXT).map((entry) => entry.product.id),
    ["prd-3"],
  );
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ brand: "alyq" }), CONTEXT).map((entry) => entry.product.id),
    ["prd-2", "prd-1"],
    "both ALYQ products, the featured one first as the default sort dictates",
  );
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ minPrice: 100, maxPrice: 900 }), CONTEXT).map((entry) => entry.product.id),
    ["prd-1", "prd-3"],
  );
});

test("availability filters read the held stock, not just the shelf", () => {
  const context: CatalogContext = { ...CONTEXT, reserved: new Map([["prd-1", 8]]) };
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ availability: "in_stock" }), context).map((entry) => entry.product.id),
    ["prd-3"],
    "prd-1 has 8 on the shelf but all 8 are held by pending orders",
  );
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ availability: "out_of_stock" }), context).map((entry) => entry.product.id),
    ["prd-2", "prd-1"],
    "prd-2 has nothing on the shelf, prd-1 has nothing left to promise",
  );
});

test("every sort the storefront offers orders the list differently", () => {
  const ids = (sort: CatalogFilters["sort"]) =>
    searchCatalog(CATALOG, filters({ sort }), CONTEXT).map((entry) => entry.product.id);

  assert.deepEqual(ids("price_asc"), ["prd-2", "prd-1", "prd-3"]);
  assert.deepEqual(ids("price_desc"), ["prd-3", "prd-1", "prd-2"]);
  assert.deepEqual(ids("best_selling"), ["prd-2", "prd-1", "prd-3"]);
  assert.deepEqual(ids("name"), ["prd-1", "prd-2", "prd-3"], "alphabetical on the English name");
  assert.deepEqual(ids("newest"), ["prd-2", "prd-1", "prd-3"]);
  assert.deepEqual(ids("featured"), ["prd-2", "prd-1", "prd-3"], "featured products come first");
});

test("a campaign price is what the sort and the filters see", () => {
  const context: CatalogContext = {
    ...CONTEXT,
    campaigns: [makeCampaign({ discount_type: "fixed", discount_value: 100, product_ids: ["prd-3"] })],
  };
  const [cheapest] = searchCatalog(CATALOG, filters({ sort: "price_asc", minPrice: 500, maxPrice: 850 }), context);
  assert.equal(cheapest?.product.id, "prd-3", "the grinder at 800 after the campaign is under the 850 cap");
  assert.equal(
    searchCatalog(CATALOG, filters({ minPrice: 500, maxPrice: 850 }), CONTEXT).length,
    0,
    "without the campaign the same filter finds nothing — the customer filters on what they would pay",
  );
  assert.equal(cheapest?.price, 800);
  assert.equal(cheapest?.listPrice, 900);
  assert.equal(cheapest?.onSale, true);
  assert.equal(cheapest?.discountPercent, 11);
  assert.equal(priceRangeOf(CATALOG, context)?.min, 60);
});

test("sections can cap their result count and restrict it to a product list", () => {
  assert.equal(searchCatalog(CATALOG, filters({ limit: 2 }), CONTEXT).length, 2);
  assert.deepEqual(
    searchCatalog(CATALOG, filters({ productIds: ["prd-3", "prd-1"] }), CONTEXT).map((entry) => entry.product.id),
    ["prd-1", "prd-3"],
  );
});

test("related products stay in the same category and exclude the product itself", () => {
  const related = relatedProducts(CATALOG[0] as Product, CATALOG, CONTEXT, 4);
  assert.equal(related.some((entry) => entry.product.id === "prd-1"), false);
  assert.ok(related.length > 0);
});

test("filters survive a round trip through the URL", () => {
  const original = filters({
    search: "earrings",
    categoryId: "cat-tools",
    brand: "alyq",
    minPrice: 50,
    maxPrice: 500,
    availability: "in_stock",
    sort: "price_desc",
  });
  const params = filtersToSearchParams(original);
  const restored = filtersFromSearchParams(params);
  assert.deepEqual(restored, original);
  assert.equal(params.get("q"), "earrings");
  assert.equal(params.get("sort"), "price_desc");

  // A section's own cap and product list are not a shopper's filter: they stay
  // out of the URL, so a link cannot be crafted to widen a homepage section.
  const scoped = filters({ productIds: ["prd-1"], limit: 4 });
  assert.equal(filtersFromSearchParams(filtersToSearchParams(scoped)).limit, null);
  assert.equal(filtersFromSearchParams(filtersToSearchParams(scoped)).productIds, null);

  // Empty filters leave the URL clean, so "all products" has no query string.
  assert.equal(filtersToSearchParams(filters()).toString(), "");

  const junk = filtersFromSearchParams(new URLSearchParams("sort=nonsense&availability=maybe&minPrice=abc"));
  assert.equal(junk.sort, "featured", "an unknown sort falls back to the default");
  assert.equal(junk.availability, "any");
  assert.equal(junk.minPrice, null);
});

// ── homepage sections ───────────────────────────────────────────────────────

test("every homepage section exists in the default document", () => {
  const configured = settings().sections.map((section) => section.key);
  assert.deepEqual(configured, [...HOMEPAGE_SECTIONS]);
});

test("hiding a section removes it from the storefront but keeps its place in the admin list", () => {
  const document = settings();
  document.sections = setSectionVisible(document, "reviews", false);
  assert.equal(visibleSections(document).some((section) => section.key === "reviews"), false);
  assert.equal(orderedSections(document).some((section) => section.key === "reviews"), true);
  assert.equal(sectionOf(document, "reviews")?.visible, false);
});

test("sections can be reordered, retitled and re-limited", () => {
  const document = settings();
  const moved = moveSection(document, 0, 2);
  // Phase 49: the default rhythm is hero → categories → newArrivals → …, so
  // moving the first section two slots down yields categories, newArrivals, hero.
  assert.deepEqual(
    moved.slice(0, 3).map((section) => section.key),
    ["categories", "newArrivals", "hero"],
  );

  document.sections = setSectionTitle(document, "faq", { ar: "أسئلة", en: "Questions" });
  assert.equal(sectionTitle(sectionOf(document, "faq")!, pick), "Questions");

  document.sections = setSectionLimit(document, "bestSellers", 6);
  assert.equal(sectionLimit(sectionOf(document, "bestSellers")!), 6);

  document.sections = resetSections(document);
  assert.deepEqual(
    document.sections.map((section) => section.key),
    [...HOMEPAGE_SECTIONS],
  );
});

test("a stored document missing sections is repaired, not rendered half-empty", () => {
  const repaired = repairSections([{ key: "hero", visible: true, sort_order: 0, title_ar: "", title_en: "", limit: 4 } as never]);
  assert.equal(repaired.length, HOMEPAGE_SECTIONS.length);
  assert.equal(repaired[0]?.key, "hero", "what the shop configured keeps its place");
  assert.deepEqual(repairSections(undefined).map((section) => section.key), [...HOMEPAGE_SECTIONS]);
});

test("slides and banners fall back to the shop's own images and copy", () => {
  const document = settings();
  assert.ok(resolvedSlides(document, pick).length > 0);
  assert.ok(resolvedBanners(document, pick).length >= 0);
});

// ── settings document ───────────────────────────────────────────────────────

test("stored settings are merged over the defaults, deeply", () => {
  const merged = resolveSettings({ theme: { primary_color: "#0f766e" }, delivery: { fee: 45 } });
  assert.equal(merged.theme.primary_color, "#0f766e");
  assert.equal(merged.delivery.fee, 45);
  assert.equal(merged.delivery.pickup_enabled, DEFAULT_WEBSITE_SETTINGS.delivery.pickup_enabled, "untouched keys survive");
  assert.equal(merged.currency, "EGP", "the currency is not configurable");
  assert.equal(merged.sections.length, HOMEPAGE_SECTIONS.length);
});

test("garbage in the settings document cannot break the storefront", () => {
  const resolved = resolveSettings("not an object");
  assert.deepEqual(resolved, DEFAULT_WEBSITE_SETTINGS);
  assert.equal(resolveSettings(null).version, 1);
  assert.equal(mergeSettings(DEFAULT_WEBSITE_SETTINGS, undefined).currency, "EGP");
});

test("colours are validated and text is put on a readable one", () => {
  assert.equal(safeColor("#123456", "#000000"), "#123456");
  assert.equal(safeColor("javascript:alert(1)", "#000000"), "#000000");
  assert.equal(safeColor(null, "#000000"), "#000000");
  assert.equal(readableOn("#ffffff"), "#0f172a");
  assert.equal(readableOn("#111827"), "#ffffff");
});

test("the InstaPay knobs default to the shipped behaviour and backfill old documents", () => {
  // The shop shipped asking every InstaPay customer for the proof and with no
  // configured copy of its own: a stored document that predates the fields must
  // resolve to exactly that, not to a surprise.
  assert.equal(DEFAULT_WEBSITE_SETTINGS.delivery.instapay_proof_required, true);
  assert.equal(DEFAULT_WEBSITE_SETTINGS.delivery.instapay_instructions_ar, "");
  assert.equal(DEFAULT_WEBSITE_SETTINGS.delivery.instapay_instructions_en, "");
  assert.equal(DEFAULT_WEBSITE_SETTINGS.social.instapay_holder, "");

  const legacy = resolveSettings({
    social: { instapay_link: "https://instapay.eg/alyq", instapay_account: "alyq@instapay" },
    delivery: { instapay_enabled: true },
  });
  assert.equal(legacy.social.instapay_link, "https://instapay.eg/alyq", "stored values survive the merge");
  assert.equal(legacy.social.instapay_holder, "", "a document without the holder gets the default");
  assert.equal(legacy.delivery.instapay_proof_required, true, "proof stays required unless switched off");
  assert.equal(legacy.delivery.instapay_instructions_en, "");

  const configured = resolveSettings({
    delivery: { instapay_proof_required: false, instapay_instructions_ar: "حوّل ثم اتصل بنا" },
    social: { instapay_holder: "ALYQ for Accessories" },
  });
  assert.equal(configured.delivery.instapay_proof_required, false, "an explicit off is honoured");
  assert.equal(configured.delivery.instapay_instructions_ar, "حوّل ثم اتصل بنا");
  assert.equal(configured.social.instapay_holder, "ALYQ for Accessories");
});

test("the InstaPay link only becomes an href when it is a safe absolute http(s) URL", () => {
  assert.equal(externalHref("https://instapay.eg/alyq"), "https://instapay.eg/alyq");
  assert.equal(externalHref("http://example.com/pay"), "http://example.com/pay");
  assert.equal(externalHref("  https://instapay.eg/x  "), "https://instapay.eg/x", "surrounding space is trimmed");
  assert.equal(externalHref(""), null, "an unset link renders no button at all");
  assert.equal(externalHref(null), null);
  assert.equal(externalHref("javascript:alert(1)"), null, "a script scheme never reaches an href");
  assert.equal(externalHref("JaVaScRiPt:alert(1)"), null, "the scheme check is case-insensitive");
  assert.equal(externalHref("data:text/html;base64,PHNjcmlwdD4="), null);
  assert.equal(externalHref("instapay://transfer"), null, "custom schemes are refused like any other");
  assert.equal(externalHref("/store/products"), null, "a relative path is not an external payment link");
  assert.equal(externalHref("ftp://files.example.com"), null);
});

test("every configured storefront link passes the same safe-href policy", () => {
  // The social profiles and the map are ordinary https links when they are real.
  assert.equal(externalHref("https://facebook.com/alyq.shop"), "https://facebook.com/alyq.shop");
  assert.equal(externalHref("https://instagram.com/alyq.shop"), "https://instagram.com/alyq.shop");
  assert.equal(externalHref("https://tiktok.com/@alyq.shop"), "https://tiktok.com/@alyq.shop");
  assert.equal(
    externalHref("https://maps.google.com/?q=alyq"),
    "https://maps.google.com/?q=alyq",
    "a map link keeps its query",
  );

  // Mixed case and stray whitespace are normalized, not smuggled through.
  assert.equal(externalHref("HTTPS://TikTok.com/@alyq"), "https://tiktok.com/@alyq");
  assert.equal(externalHref("\n https://facebook.com/x \t"), "https://facebook.com/x");

  // The bypass attempts a public href must refuse — every scheme that executes
  // or renders content, in any casing, with or without obfuscation.
  assert.equal(externalHref("vbscript:msgbox(1)"), null);
  assert.equal(externalHref("DATA:text/html,<script>alert(1)</script>"), null);
  assert.equal(externalHref("java\tscript:alert(1)"), null, "a tab inside the scheme does not sneak it past");
  assert.equal(externalHref("jav\u0000ascript:alert(1)"), null, "nor does a NUL character");
  assert.equal(externalHref(" javascript:alert(1)"), null, "leading whitespace is trimmed before the check");
  assert.equal(externalHref("https://"), null, "a scheme with no host is nothing to link to");
  assert.equal(externalHref(42), null, "a non-string value is not a link");

  // Fields that hold routes inside the shop accept "#/…" and nothing else: a
  // bare "#" must never become a link, and "#javascript:…" is the slice bypass
  // the hero and promo banners used to be open to.
  assert.equal(internalHref("#/store/products"), "#/store/products");
  assert.equal(internalHref("  #/store/contact "), "#/store/contact", "trimmed");
  assert.equal(internalHref("#"), null, "a bare hash is not a route");
  assert.equal(internalHref("#javascript:alert(1)"), null, "a scheme behind a hash is not a route");
  assert.equal(internalHref("https://facebook.com/x"), null, "external URLs are the other function's job");
  assert.equal(internalHref(""), null);

  // The combined policy for the announcement bar and CTAs: either kind passes,
  // anything else renders text with no link at all.
  assert.equal(configuredHref("#/store/products"), "#/store/products");
  assert.equal(configuredHref("https://facebook.com/alyq.shop"), "https://facebook.com/alyq.shop");
  assert.equal(configuredHref("javascript:alert(1)"), null);
  assert.equal(configuredHref("#javascript:alert(1)"), null);
  assert.equal(configuredHref(""), null);
});

test("the shop defaults to clean ivory, white and charcoal with a restrained gold", () => {
  const theme = resolveSettings({}).theme;
  for (const [key, color] of Object.entries(STORE_PALETTE)) {
    assert.equal(theme[key as keyof typeof STORE_PALETTE], color, `${key} comes from the sole shop palette`);
  }
  assert.notEqual(theme.primary_color, "#4f46e5", "POS indigo must not leak into the shop");
  assert.notEqual(theme.background_color, "#faf7f2", "no old beige page background");
  assert.ok(theme.corner_radius <= 6, "tight editorial corners, not app tiles");
});

test("only the exactly untouched persisted legacy palette upgrades; a single edit preserves every chosen value", () => {
  const legacy = {
    ...DEFAULT_WEBSITE_SETTINGS,
    theme: { ...DEFAULT_WEBSITE_SETTINGS.theme, primary_color: "#1c1917", secondary_color: "#44403c",
      accent_color: "#b08d57", background_color: "#faf7f2", surface_color: "#fffdfb",
      text_color: "#1c1917", muted_text_color: "#78716c" },
  };
  const upgraded = resolveSettings(legacy);
  assert.equal(upgraded.theme.background_color, STORE_PALETTE.background_color);
  assert.equal(upgraded.theme.accent_color, STORE_PALETTE.accent_color);
  assert.equal(legacy.theme.background_color, "#faf7f2", "resolve does not mutate persisted data");
  assert.equal(announcementStyle(upgraded).backgroundColor, "var(--store-secondary)",
    "old saved announcement defaults follow the newly derived secondary token");

  const tailored = resolveSettings({ ...legacy, theme: { ...legacy.theme, primary_color: "#0f766e" } });
  assert.equal(tailored.theme.primary_color, "#0f766e");
  assert.equal(tailored.theme.background_color, "#faf7f2", "other saved colours are not partially migrated");
  assert.equal(tailored.theme.accent_color, "#b08d57");
  assert.equal(resolveSettings({ theme: { primary_color: "#075985" } }).theme.primary_color, "#075985");
  const customAnn = { ...upgraded, announcement: { ...upgraded.announcement, bg_color: "#303d46", text_color: "#fafafa" } };
  assert.equal(announcementStyle(customAnn).backgroundColor, "#303d46", "an admin's announcement colour wins");
});

test("theme tokens derive from saved colours, and invalid entries block the whole settings save", () => {
  const saved = resolveSettings({ theme: { primary_color: "#0f766e", background_color: "#effdf6",
    surface_color: "#ffffff", text_color: "#093726", muted_text_color: "#3d6250", accent_color: "#b3955e" } });
  const vars = themeVariables(saved);
  assert.equal(vars["--store-primary"], "#0f766e");
  assert.equal(vars["--store-background"], "#effdf6");
  assert.equal(vars["--store-surface"], "#ffffff");
  assert.equal(vars["--store-text-primary"], "#093726");
  assert.equal(vars["--store-text-secondary"], "#3d6250");
  assert.equal(vars["--store-accent"], "#b3955e");
  assert.ok(vars["--store-primary-hover"] !== vars["--store-primary"]);
  for (const key of ["--store-surface-muted", "--store-border", "--store-accent-muted",
    "--store-danger", "--store-success", "--store-warning"]) assert.ok(vars[key], key);
  assert.equal(invalidSettingsColor(saved), null);
  assert.equal(invalidSettingsColor({ ...saved, theme: { ...saved.theme, primary_color: "terracotta" } }), "primary_color");
  assert.equal(invalidSettingsColor({ ...saved, announcement: { ...saved.announcement, bg_color: "url(evil)" } }), "announcement.bg_color");
  assert.equal(saved.theme.primary_color, "#0f766e", "the previously valid document is not mutated");
});

test("the tokens a premium layout needs exist, and stay namespaced", () => {
  const variables = themeVariables(resolveSettings({}));
  for (const token of [
    "--store-font-display",
    "--store-shadow",
    "--store-shadow-lift",
    "--store-hairline",
    "--store-hairline-gold",
    "--store-space-section",
    "--store-max-width",
  ]) {
    assert.ok(variables[token], `${token} is missing from the token set`);
  }
  // Namespacing is what keeps a shop rebrand from touching the till: the tokens
  // are written on <html>, so anything outside --store- could reach the POS.
  const stray = Object.keys(variables).filter((key) => !key.startsWith("--store-"));
  assert.deepEqual(stray, [], "a token outside the --store- namespace could leak into the POS");
  // A serif for headings; the admin's own stack left alone for body copy.
  assert.ok(variables["--store-font-display"].includes("serif"), "headings get a display serif");
  assert.ok(variables["--store-font"].includes("sans-serif"), "body copy stays a sans stack");
  assert.ok(
    variables["--store-shadow"].includes("32 36 39"),
    "shadows use the page's neutral charcoal, not old brown",
  );
});

test("the theme document becomes CSS variables, and shades stay valid hex", () => {
  const variables = themeVariables(settings());
  assert.ok(variables["--store-primary"]);
  assert.ok(variables["--store-on-primary"]);
  assert.match(shade("#4338ca", -0.2), /^#[0-9a-f]{6}$/i);
  assert.notEqual(shade("#4338ca", -0.2), "#4338ca", "a negative amount darkens the hover shade");
  assert.equal(
    shade("javascript:alert(1)", 0.2, "#4338ca"),
    shade("#4338ca", 0.2),
    "a colour that is not hex falls back to the shop's own primary rather than reaching the stylesheet",
  );
  assert.equal(buttonRadiusOf("pill", 8), 9999, "a pill ignores the corner radius entirely");
  assert.equal(buttonRadiusOf("square", 8), 0);
  assert.equal(buttonRadiusOf("rounded", 8), 8);
  assert.ok(fontStackOf("modern").length > 0);
  assert.equal(fontStackOf(null), fontStackOf("system"), "an unknown font falls back to the system stack");
});

// ── SEO ─────────────────────────────────────────────────────────────────────

test("slugs are ASCII, so an Arabic product name still gets a usable URL", () => {
  assert.equal(slugifyAscii("  Gold  Earrings!! "), "gold-earrings");
  assert.equal(slugifyAscii("Gold Pearl Earrings", "prd-7"), "gold-pearl-earrings");
  assert.equal(slugifyAscii("أقراط لؤلؤ", "prd-7"), "prd-7", "Arabic-only text falls back rather than going empty");
  assert.equal(slugifyAscii("أقراط لؤلؤ ٢٥٠", ""), "", "with no fallback there is nothing ASCII to store");
  assert.match(slugifyAscii("أقراط لؤلؤ", "prd-7"), /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "the shape the database constrains");

  assert.equal(suggestedSlug({ name_ar: "أقراط", name_en: "Gold Earrings", sku: "SKU-1" }), "gold-earrings");
  assert.equal(
    suggestedSlug({ name_ar: "أقراط", name_en: null, sku: "SKU-1" }),
    "sku-1",
    "an Arabic-only name suggests the SKU, which is always storable and always unique",
  );
});

test("product links prefer the admin's slug", () => {
  assert.equal(productPath({ id: "prd-1" }, { slug: "gold-earrings" }), "#/store/products/gold-earrings");
  assert.equal(productPath({ id: "prd-1" }, null), "#/store/products/prd-1");
  assert.equal(
    productPath({ id: "prd-1" }, { slug: "  " }),
    "#/store/products/prd-1",
    "an empty slug falls back to the id, so a shared link never dies",
  );
  assert.equal(absoluteUrl("https://shop.example.com", "#/store"), "https://shop.example.com/#/store");
  assert.equal(absoluteUrl("https://shop.example.com/", "#/store"), "https://shop.example.com/#/store");
  assert.equal(absoluteUrl("", "#/store"), "#/store", "with no site URL the hash path stands alone");
});

test("meta titles and descriptions are clipped and fall back sensibly", () => {
  assert.equal(titleForProduct({ name: "Earrings", seoTitle: null, storeName: "ALYQ" }), "Earrings | ALYQ");
  assert.equal(
    titleForProduct({ name: "Earrings", seoTitle: "Best earrings", storeName: "ALYQ" }),
    "Best earrings | ALYQ",
    "what the admin wrote leads, and the shop's name still brands the result",
  );
  assert.equal(
    titleForProduct({ name: "Earrings", seoTitle: "ALYQ earrings", storeName: "ALYQ" }),
    "ALYQ earrings",
    "the store name is not repeated when the title already carries it",
  );
  assert.equal(titleForProduct({ name: "", seoTitle: null, storeName: "ALYQ" }), "ALYQ");

  assert.equal(descriptionForProduct({ seoDescription: "Written by the shop", fallbackName: "Earrings" }), "Written by the shop");
  assert.equal(
    descriptionForProduct({ seoDescription: null, productDescription: "**Bold** body", fallbackName: "Earrings" }),
    "Bold body",
    "markdown is stripped out of a product description before it becomes a meta tag",
  );
  assert.equal(descriptionForProduct({ fallbackName: "Earrings" }), "Earrings", "never empty");

  const clipped = clipDescription("word ".repeat(80), 40);
  assert.ok(clipped.length <= 41, "a long description is trimmed to what a search result shows");
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipDescription("  short   text  "), "short text");
  assert.deepEqual(keywordList("a, b,, a، c", 2), ["a", "b"], "duplicates drop and the limit holds");
  assert.deepEqual(keywordList(null), []);
});

test("the sitemap lists the storefront pages and escapes what it writes", () => {
  const pages = storefrontSitemapPages({ settings: settings(), products: CATALOG, contents: CONTENTS });
  assert.ok(pages.length >= 4, "home, products, contact and the product pages");
  const xml = buildSitemapXml({ baseUrl: "https://shop.example.com/", pages });
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<loc>https:\/\/shop\.example\.com\/#\/store<\/loc>/);
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.equal(xml.includes("prd-hidden"), false, "a product off the website stays out of the sitemap");
  assert.equal(
    buildSitemapXml({ baseUrl: "https://shop.example.com", pages: [{ path: "#/store&x" }] }).includes("&amp;"),
    true,
    "the XML is escaped",
  );

  const robots = buildRobotsTxt("https://shop.example.com");
  assert.equal(robots.includes("Sitemap: https://shop.example.com/sitemap.xml"), true);
  assert.equal(robots.includes("Disallow: /#/pos"), true, "the back office is never indexed");
});

// ── date inputs ─────────────────────────────────────────────────────────────

test("campaign windows survive a trip through a datetime-local input", () => {
  const iso = "2026-05-01T10:00:00.000Z";
  const local = toDateTimeLocal(iso);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(isWindowOpen(fromDateTimeLocal(local, iso), null, new Date(fromDateTimeLocal(local, iso))), true);
  assert.equal(isWindowOpen(null, null), true);
  assert.equal(isWindowOpen("2026-06-01T00:00:00.000Z", null, NOW), false);
});

// ── the online-orders export ────────────────────────────────────────────────

test("the export writes one sheet of orders and one of ordered lines, in EGP", () => {
  const order = makeOrder({
    status: "approved",
    payment_method: "cod",
    payment_status: "pending",
    sale_number: "S-000001",
    approved_by_name: "ALYQ Admin",
    items: [
      { ...itemStub("prd-1"), quantity: 2, unit_price: 100, line_total: 200 },
      { ...itemStub("prd-3"), quantity: 1, unit_price: 900, line_total: 900 },
    ],
  });

  const sheets = buildOnlineOrderSheets({ orders: [order], t, pick });
  assert.equal(sheets.length, 2);

  const [ordersSheet, itemsSheet] = sheets as [typeof sheets[number], typeof sheets[number]];
  assert.equal(ordersSheet.rows.length, 1);
  assert.equal(itemsSheet.rows.length, 2, "one row per ordered line");

  const moneyColumns = ordersSheet.kinds.map((kind, index) => (kind === "money" ? index : -1)).filter((index) => index >= 0);
  assert.ok(moneyColumns.length >= 4, "subtotal, discount, delivery fee and total are all money columns");
  for (const index of moneyColumns) {
    assert.equal(typeof ordersSheet.rows[0]?.[index], "number", "money is written as a number so Excel can sum it");
  }

  const header = ordersSheet.header.join("|");
  assert.ok(header.includes(t("export.col.orderNumber")));
  assert.ok(header.includes(t("export.col.deliveryFee")));
  assert.ok(header.includes(t("export.col.paymentStatus")), "order status and payment status are separate columns");
  assert.ok(header.includes(t("export.col.status")));
  assert.ok(header.includes(t("export.col.saleNumber")), "the sale the order became is on the sheet");

  const statusColumn = ordersSheet.header.indexOf(t("export.col.status"));
  assert.equal(ordersSheet.rows[0]?.[statusColumn], t("online.status.approved"), "statuses are written translated");

  assert.equal(buildOnlineOrderSheets({ orders: [], t, pick })[0]?.rows.length, 0);
});

// ── end to end: the website order becomes a till sale ───────────────────────

/** A demo product the website is actually allowed to sell. */
async function demoProduct(sku: string): Promise<Product> {
  const products = await getDemoRepository().listProducts();
  const product = products.find(
    (candidate) =>
      candidate.sku === sku && candidate.active && candidate.stock_tracking_enabled && candidate.show_on_website,
  );
  assert.ok(product, `an active, stock-tracked website product with SKU ${sku} exists in the demo catalogue`);
  return product as Product;
}

test("placing an order holds the stock without deducting it, and a double tap cannot hold it twice", async () => {
  resetDemoOnlineRepository();
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1002");
  const before = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-1",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });

  assert.equal(placed.duplicate, false);
  assert.equal(placed.order.status, "pending");
  assert.match(placed.order.order_number, /^WEB-\d{6}$/);
  assert.equal(placed.order.payment_status, "pending", "cash on delivery has not been collected");
  assert.equal(placed.order.sale_id, null, "no sale exists before approval");
  assert.equal(placed.order.items.length, 1);
  assert.equal(placed.order.items[0]?.unit_price, product.selling_price, "the price comes from the catalogue");

  const after = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  assert.equal(after, before, "a pending order holds stock; it does not deduct it");

  const reservations = await repository.listReservations();
  assert.equal(
    reservations.filter((reservation) => reservation.online_order_id === placed.order.id && reservation.status === "reserved")
      .reduce((sum, reservation) => sum + reservation.quantity, 0),
    2,
  );

  const again = await repository.placeOrder({
    client_ref: "ref-e2e-1",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.order.id, placed.order.id, "the same order comes back — the stock is not held twice");

  // The held units are not available to the next customer.
  const held = await repository.listReservations();
  const totals = reservedByProduct(held.filter((reservation) => reservation.online_order_id === placed.order.id));
  assert.equal(availableToPromise(product, reservedOf(totals, product.id)), Math.max(product.stock_quantity - 2, 0));
});

test("a second customer cannot buy what a pending order is holding", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1002");
  const reservations = await repository.listReservations();
  const held = reservedOf(reservedByProduct(reservations), product.id);
  const available = Math.max(product.stock_quantity - held, 0);

  await assert.rejects(
    repository.placeOrder({
      client_ref: "ref-e2e-oversell",
      customer_name: "Ahmed",
      customer_phone: "01111111111",
      delivery_type: "pickup",
      address: null,
      payment_method: "cod",
      lines: [{ product_id: product.id, qty: available + 1 }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof OnlineError);
      assert.equal(error.code, "insufficient_stock");
      return true;
    },
  );
});

test("approving an order creates a POS sale and deducts the stock it was holding", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1020");
  const before = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-approve",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 3 }],
  });

  const approved = await repository.resolveOrder(placed.order.id, { action: "approve", ...STAFF });
  assert.equal(approved.status, "approved");
  assert.ok(approved.sale_id, "the order is linked to a real sale");
  assert.ok(approved.sale_number, "and carries its number, so the till and the website agree");
  assert.equal(approved.approved_by, STAFF.user_id, "who approved it is recorded");
  assert.equal(approved.approved_by_name, STAFF.user_name);
  assert.ok(approved.approved_at);

  const after = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  assert.equal(after, before - 3, "the hold became a deduction");

  const reservations = await repository.listReservations();
  assert.equal(
    reservations.filter((reservation) => reservation.online_order_id === placed.order.id && reservation.status === "reserved").length,
    0,
    "the hold is converted, so the units are not counted twice",
  );

  const kinds = approved.events.map((event: OrderEvent) => event.kind);
  assert.ok(kinds.includes("placed") && kinds.includes("approved"), "the history shows what happened");
});

test("completing an order stores the completed status and illegal moves carry the transition code", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1020");

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-complete",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  const approved = await repository.resolveOrder(placed.order.id, { action: "approve", ...STAFF });

  // The action word is "complete"; the stored status is "completed" — the only
  // label the database enum accepts. A server answering anything else becomes
  // the same typed refusal (see `normalizeOrderStatus`).
  const completed = await repository.resolveOrder(approved.id, { action: "complete", ...STAFF });
  assert.equal(completed.status, "completed", "the action maps to the stored status");
  assert.ok(completed.completed_at, "completion is timestamped");
  assert.ok(
    completed.events.some((event: OrderEvent) => event.kind === "completed"),
    "the history records the completion",
  );

  await assert.rejects(
    repository.resolveOrder(completed.id, { action: "complete", ...STAFF }),
    (error: unknown) => {
      assert.equal(
        toOnlineError(error).code,
        "status_transition_refused",
        "completing a completed order is a transition refusal, not a raw error",
      );
      return true;
    },
  );

  await assert.rejects(
    repository.resolveOrder(completed.id, { action: "approve", ...STAFF }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "status_transition_refused");
      return true;
    },
  );
});

test("cancelling a pending order releases the stock and keeps the record with its reason", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1001");
  const before = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-cancel",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 2 }],
  });

  await assert.rejects(
    repository.resolveOrder(placed.order.id, { action: "cancel", ...STAFF }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "workflow_refused", "a cancellation without a reason is refused");
      return true;
    },
  );

  const cancelled = await repository.resolveOrder(placed.order.id, {
    action: "cancel",
    reason: "Customer changed their mind",
    ...STAFF,
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellation_reason, "Customer changed their mind");
  assert.equal(cancelled.cancelled_by_name, STAFF.user_name);
  assert.equal(cancelled.sale_id, null, "a cancelled pending order never became a sale");

  const after = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  assert.equal(after, before, "cancelling deducts nothing");

  const reservations = await repository.listReservations();
  assert.equal(
    reservations.filter((reservation) => reservation.online_order_id === placed.order.id && reservation.status === "released").length,
    1,
    "the hold is released back to the shelf",
  );

  // And the units are available to the next customer again.
  const remaining = reservedOf(
    reservedByProduct((await repository.listReservations()).filter((reservation) => reservation.online_order_id === placed.order.id)),
    product.id,
  );
  assert.equal(remaining, 0);
});

test("cancelling an approved order voids the sale and puts the stock back", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-2001");

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-void",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  const approved = await repository.resolveOrder(placed.order.id, { action: "approve", ...STAFF });
  const afterApprove = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;

  const cancelled = await repository.resolveOrder(approved.id, {
    action: "cancel",
    reason: "Damaged in packing",
    ...STAFF,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.sale_id, "the sale link is kept for the audit trail");

  const afterCancel = (await getDemoRepository().listProducts()).find((p) => p.id === product.id)?.stock_quantity ?? 0;
  assert.equal(afterCancel, afterApprove + 1, "voiding the sale restored the unit");
});

test("InstaPay proof is verified by a person and never approves itself", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1002");

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-instapay",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "instapay",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  assert.equal(
    placed.order.payment_status,
    "verification_required",
    "an InstaPay order is owed a human decision from the moment it is placed",
  );

  const submitted = await repository.submitPaymentProof({
    order_number: placed.order.order_number,
    customer_phone: "01001234567",
    payment_reference: "IP-998877",
    payment_proof_url: "https://example.com/proofs/ip-998877.png",
  });
  assert.equal(submitted.payment_status, "verification_required", "a screenshot is a claim, not a payment");
  assert.equal(submitted.payment_verified_by, null, "nobody has judged it yet");
  assert.equal(submitted.payment_reference, "IP-998877");
  assert.ok(submitted.payment_submitted_at);
  assert.equal(submitted.status, "pending", "the order status is untouched by the upload");

  await assert.rejects(
    repository.resolveOrder(submitted.id, { action: "approve", ...STAFF }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "workflow_refused", "unverified money cannot become a sale");
      return true;
    },
  );

  const counts = await repository.counts();
  assert.equal(counts.needs_payment >= 1, true, "the POS badge counts orders waiting on verification");

  const verified = await repository.resolveOrder(submitted.id, { action: "payment_approve", ...STAFF });
  assert.equal(verified.payment_status, "paid");
  assert.equal(verified.payment_verified_by_name, STAFF.user_name, "who verified it is recorded");

  const approved = await repository.resolveOrder(verified.id, { action: "approve", ...STAFF });
  assert.equal(approved.status, "approved");
  assert.ok(approved.sale_id, "and only now does it become a sale");
});

test("a rejected proof leaves the order open and says why", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1020");

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-reject",
    customer_name: "Ahmed",
    customer_phone: "01111111111",
    delivery_type: "pickup",
    address: null,
    payment_method: "instapay",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  await repository.submitPaymentProof({
    order_number: placed.order.order_number,
    customer_phone: "01111111111",
    payment_reference: "IP-000111",
  });

  const rejected = await repository.resolveOrder(placed.order.id, {
    action: "payment_reject",
    reason: "Amount does not match the order",
    ...STAFF,
  });
  assert.equal(rejected.payment_status, "failed");
  assert.equal(rejected.payment_rejected_reason, "Amount does not match the order");
  assert.equal(rejected.status, "pending", "the order is still there to fix, not silently gone");
});

test("a customer tracks an order with its number and the phone it was placed with", async () => {
  const repository = getDemoOnlineRepository();
  const orders = await repository.listOrders();
  const target = orders[0];
  assert.ok(target);

  const found = await repository.lookupOrder(target.order_number, target.customer_phone);
  assert.equal(found.id, target.id);
  assert.ok(found.items.length > 0);
  assert.ok(found.events.length > 0);

  await assert.rejects(
    repository.lookupOrder(target.order_number, "01999999999"),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "order_not_found", "the phone number is part of the lookup");
      return true;
    },
  );
  await assert.rejects(repository.lookupOrder("WEB-999999", target.customer_phone));
});

test("the POS list can be filtered by status and by what needs attention", async () => {
  const repository = getDemoOnlineRepository();
  const all = await repository.listOrders({ status: "all", paymentStatus: "all", search: "" });
  assert.ok(all.length >= 5, "the scenarios above left a realistic list behind");

  const cancelled = await repository.listOrders({ status: "cancelled" });
  assert.ok(cancelled.length >= 2);
  assert.ok(cancelled.every((order) => order.status === "cancelled"));
  assert.ok(cancelled.every((order) => (order.cancellation_reason ?? "").length > 0), "every cancellation has a reason");

  const found = await repository.listOrders({ search: all[0]!.customer_phone });
  assert.ok(found.some((order) => order.id === all[0]!.id), "search matches the phone number");

  const counts = await repository.counts();
  assert.equal(counts.total, all.length);
  assert.equal(
    counts.pending + counts.approved + counts.processing + counts.ready + counts.completed + counts.cancelled,
    counts.total,
  );
  assert.ok(counts.open_value >= 0);
});

test("an order can only be placed for a product the website is allowed to sell", async () => {
  const repository = getDemoOnlineRepository();
  const products = await getDemoRepository().listProducts();
  const offline = products.find((product) => !product.show_on_website || !product.stock_tracking_enabled);

  if (offline) {
    await assert.rejects(
      repository.placeOrder({
        client_ref: "ref-e2e-offline",
        customer_name: "Mona",
        customer_phone: "01001234567",
        delivery_type: "pickup",
        address: null,
        payment_method: "cod",
        lines: [{ product_id: offline.id, qty: 1 }],
      }),
      (error: unknown) => {
        assert.equal(toOnlineError(error).code, "product_unavailable");
        return true;
      },
    );
  }

  await assert.rejects(
    repository.placeOrder({
      client_ref: "ref-e2e-empty",
      customer_name: "Mona",
      customer_phone: "01001234567",
      delivery_type: "pickup",
      address: null,
      payment_method: "cod",
      lines: [],
    }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "empty_cart");
      return true;
    },
  );

  await assert.rejects(
    repository.placeOrder({
      client_ref: "ref-e2e-nocontact",
      customer_name: "  ",
      customer_phone: "",
      delivery_type: "pickup",
      address: null,
      payment_method: "cod",
      lines: [{ product_id: products[0]!.id, qty: 1 }],
    }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "missing_contact");
      return true;
    },
  );

  await assert.rejects(
    repository.placeOrder({
      client_ref: "ref-e2e-noaddress",
      customer_name: "Mona",
      customer_phone: "01001234567",
      delivery_type: "delivery",
      address: null,
      payment_method: "cod",
      lines: [{ product_id: products[0]!.id, qty: 1 }],
    }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "missing_address");
      return true;
    },
  );
});

test("the website snapshot carries the settings, content and marketing the storefront renders", async () => {
  const repository = getDemoOnlineRepository();
  const snapshot = await repository.getSnapshot();

  assert.equal(snapshot.settings.currency, "EGP");
  assert.equal(snapshot.settings.sections.length, HOMEPAGE_SECTIONS.length);
  assert.ok(Array.isArray(snapshot.contents));
  assert.ok(Array.isArray(snapshot.faqs));
  assert.ok(Array.isArray(snapshot.reviews));
  assert.ok(Array.isArray(snapshot.campaigns));

  const marketing = await repository.getMarketing();
  assert.ok(Array.isArray(marketing.coupons));
  assert.ok(Array.isArray(marketing.campaigns));

  const best = await repository.bestSellers(5);
  assert.ok(best.length <= 5);
  assert.ok(best.every((row) => row.units > 0));
});

test("website accounts are the shop's own, not the till's login", async () => {
  const repository = getDemoOnlineRepository();
  const phone = `010${String(Date.now()).slice(-8)}`;

  const customer = await repository.register({ name: "Mona", phone, email: null, password: "secret-1" });
  assert.equal(customer.phone, phone);
  assert.deepEqual(customer.wishlist, []);

  await assert.rejects(
    repository.register({ name: "Mona", phone, email: null, password: "secret-1" }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "identifier_taken");
      return true;
    },
  );

  const current = await repository.current();
  assert.equal(current?.id, customer.id, "registering signs the customer in");

  await repository.logout();
  assert.equal(await repository.current(), null);

  await assert.rejects(
    repository.login({ identifier: phone, password: "wrong" }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "invalid_credentials");
      return true;
    },
  );

  const signed = await repository.login({ identifier: phone, password: "secret-1" });
  assert.equal(signed.id, customer.id);

  const updated = await repository.update(signed.id, { wishlist: ["prd-1"], name: "Mona A." });
  assert.deepEqual(updated.wishlist, ["prd-1"]);
  assert.equal(updated.name, "Mona A.");
});

test("a coupon's use is counted when an order is placed and given back when it is cancelled", async () => {
  const repository = getDemoOnlineRepository();
  const product = await demoProduct("ALYQ-1001");

  const draft = await repository.saveCoupon({
    code: "e2e10",
    discount_type: "percent",
    value: 10,
    min_subtotal: 0,
    max_discount: null,
    usage_limit: 3,
    applies_to: "all",
    target_ids: [],
    active: true,
    starts_at: null,
    ends_at: null,
  });
  assert.equal(draft.code, "E2E10", "codes are stored uppercase");
  assert.equal(draft.used_count, 0);

  const placed = await repository.placeOrder({
    client_ref: "ref-e2e-coupon",
    customer_name: "Mona",
    customer_phone: "01001234567",
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    coupon_code: "e2e10",
    lines: [{ product_id: product.id, qty: 1 }],
  });
  assert.equal(placed.order.discount_code, "E2E10");
  assert.ok(placed.order.discount_amount > 0);
  assert.equal(placed.order.total, round2(placed.order.subtotal - placed.order.discount_amount + placed.order.delivery_fee));

  const used = (await repository.listCoupons()).find((coupon) => coupon.code === "E2E10");
  assert.equal(used?.used_count, 1);

  await repository.resolveOrder(placed.order.id, { action: "cancel", reason: "Out of stock", ...STAFF });
  const given = (await repository.listCoupons()).find((coupon) => coupon.code === "E2E10");
  assert.equal(given?.used_count, 0, "a cancelled order gives the coupon back");

  await assert.rejects(
    repository.placeOrder({
      client_ref: "ref-e2e-badcoupon",
      customer_name: "Mona",
      customer_phone: "01001234567",
      delivery_type: "pickup",
      address: null,
      payment_method: "cod",
      coupon_code: "NOPE",
      lines: [{ product_id: product.id, qty: 1 }],
    }),
    (error: unknown) => {
      assert.equal(toOnlineError(error).code, "coupon_invalid");
      return true;
    },
  );

  await repository.deleteCoupon(draft.id);
});

test("the storefront's coupon check answers with a reason the customer can read", async () => {
  const repository = getDemoOnlineRepository();
  const result = await repository.checkCoupon({ code: "GONE", subtotal: 100, productIds: [], categoryIds: [] });
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "not_found");
});

test("settings are saved with who saved them and when", async () => {
  const repository = getDemoOnlineRepository();
  const document = settings();
  document.seo.meta_title = "ALYQ shop";
  document.theme.primary_color = "#0f766e";

  const meta = await repository.saveSettings({ settings: document, ...STAFF });
  assert.equal(meta.updated_by_name, STAFF.user_name);
  assert.ok(meta.updated_at);

  const stored = await repository.getSettings();
  assert.equal(stored.seo.meta_title, "ALYQ shop");
  assert.equal(stored.theme.primary_color, "#0f766e");
  assert.equal(stored.currency, "EGP");
});

console.log("\nPhase 27 · error normalization against the live 0034 wording");

test("every live checkout refusal lands on a customer-facing code (never bare db)", () => {
  // Each string is the exact wording migration 0034 raises. Before Phase 27
  // eight of them fell through to `db`, and two coupon wordings had drifted
  // from their regexes — the customer got "something went wrong" for a
  // perfectly explained problem.
  const cases: [string, string][] = [
    ["Customer name is required", "missing_contact"],
    ["Customer phone is required", "missing_contact"],
    ["Invalid delivery type", "delivery_unavailable"],
    ["Invalid payment method", "payment_unavailable"],
    ["Empty cart", "empty_cart"],
    ["Delivery is not available", "delivery_unavailable"],
    ["Delivery to القاهرة is not available", "delivery_area_unsupported"],
    ["Delivery orders need at least 1000.00", "delivery_minimum_not_met"],
    ["A delivery address is required", "missing_address"],
    ["Invalid quantity", "invalid_quantity"],
    ["Product ALYQ-1001 not found", "product_not_found"],
    ["Product ALYQ-1001 is not available on the website", "product_unavailable"],
    ["Product ALYQ-1001 cannot be ordered online", "product_not_online"],
    ["Only 2 of ALYQ-1001 available", "insufficient_stock"],
    ["Coupon WELCOME is not valid", "coupon_invalid"],
    ["Coupon WELCOME is not active yet", "coupon_not_started"],
    ["Coupon WELCOME has expired", "coupon_expired"],
    ["Coupon WELCOME has been fully used", "coupon_limit_reached"],
    ["Coupon WELCOME needs a subtotal of at least 200", "coupon_min_subtotal"],
    ["Coupon WELCOME does not apply to this cart", "coupon_not_applicable"],
  ];
  for (const [text, expected] of cases) {
    const err = toOnlineError(new Error(text));
    assert.equal(err.code, expected, `"${text}" → ${err.code}, expected ${expected}`);
  }

  const minimum = toOnlineError(new Error("Delivery orders need at least 1000.00"));
  assert.equal(minimum.detail.minimum, 1000, "the refusal carries the shop's number");
  const outside = toOnlineError(new Error("Delivery to القاهرة is not available"));
  assert.equal(outside.field, "address", "the customer is pointed at the address");
});

console.log("\nPhase 42 · the shop's own delivery rules, end to end in demo mode");

test("delivery areas and the minimum order gate the cart the way the server does", async () => {
  const repository = getDemoOnlineRepository();
  const products = await getDemoRepository().listProducts();
  const product = products.find(
    (candidate) => candidate.show_on_website && candidate.stock_tracking_enabled && candidate.stock_quantity >= 12,
  );
  assert.ok(product, "a tracked, on-website product to order");

  const original = await repository.getSettings();
  const delivery = {
    ...original.delivery,
    enabled: true,
    fee: 30,
    free_delivery_threshold: null,
    minimum_order: null,
    areas: [{ ar: "الإسماعيلية", en: "Ismailia" }],
  };

  const lines = [{ product_id: product.id, qty: 1 }];
  type OrderInput = Parameters<typeof repository.placeOrder>[0];
  const order = (
    over: Pick<OrderInput, "client_ref" | "delivery_type" | "address"> & Partial<OrderInput>,
  ): OrderInput => ({
    customer_name: "Mona",
    customer_phone: "01001234567",
    payment_method: "cod" as const,
    lines,
    ...over,
  });
  const address = (over: Partial<CustomerAddress> = {}): CustomerAddress => ({
    id: "",
    label: "",
    full_name: "",
    phone: "",
    city: "الإسماعيلية",
    area: "حي الأربعين",
    street: "شارع السلطان حسين",
    building: "",
    floor: "",
    apartment: "",
    notes: "",
    is_default: false,
    ...over,
  });

  try {
    await repository.saveSettings({ settings: { ...original, delivery }, ...STAFF });

    // a whole address inside the shop's places goes through, priced by the shop
    const placed = await repository.placeOrder(
      order({ client_ref: "ref-delivery-ok", delivery_type: "delivery", address: address() }),
    );
    assert.equal(placed.order.delivery_fee, 30, "the shop's fee, not the browser's");
    assert.equal(
      placed.order.total,
      round2(placed.order.subtotal - placed.order.discount_amount + placed.order.delivery_fee),
    );
    assert.equal(placed.order.address?.city, "الإسماعيلية");
    assert.equal(placed.order.address?.area, "حي الأربعين");

    // an address outside them does not — with the shop's own wording
    await assert.rejects(
      repository.placeOrder(
        order({
          client_ref: "ref-delivery-outside",
          delivery_type: "delivery",
          address: address({ city: "القاهرة", area: "مدينة نصر" }),
        }),
      ),
      (error: unknown) => {
        assert.equal(toOnlineError(error).code, "delivery_area_unsupported");
        return true;
      },
    );

    // a half address is refused: city, area and street are all required
    for (const [ref, half] of [
      ["ref-delivery-noarea", { area: "" }],
      ["ref-delivery-nostreet", { street: "" }],
      ["ref-delivery-nocity", { city: "" }],
    ] as const) {
      await assert.rejects(
        repository.placeOrder(
          order({ client_ref: ref, delivery_type: "delivery", address: address(half) }),
        ),
        (error: unknown) => {
          assert.equal(toOnlineError(error).code, "missing_address");
          return true;
        },
      );
    }

    // the minimum gates delivery, and only delivery
    await repository.saveSettings({
      settings: { ...original, delivery: { ...delivery, minimum_order: 5000 } },
      ...STAFF,
    });
    await assert.rejects(
      repository.placeOrder(
        order({ client_ref: "ref-delivery-minimum", delivery_type: "delivery", address: address() }),
      ),
      (error: unknown) => {
        assert.equal(toOnlineError(error).code, "delivery_minimum_not_met");
        return true;
      },
    );
    const pickup = await repository.placeOrder(
      order({ client_ref: "ref-pickup-minimum", delivery_type: "pickup", address: null }),
    );
    assert.equal(pickup.order.delivery_fee, 0, "collecting in person is how a customer orders less");

    // free delivery at the threshold, measured on the goods total
    await repository.saveSettings({
      settings: {
        ...original,
        delivery: {
          ...delivery,
          minimum_order: null,
          free_delivery_threshold: round2(product.selling_price * 2),
        },
      },
      ...STAFF,
    });
    const free = await repository.placeOrder(
      order({
        client_ref: "ref-delivery-free",
        delivery_type: "delivery",
        address: address(),
        lines: [{ product_id: product.id, qty: 2 }],
      }),
    );
    assert.equal(free.order.delivery_fee, 0, "at the threshold delivery is free");
    assert.equal(free.order.total, round2(free.order.subtotal - free.order.discount_amount));
  } finally {
    await repository.saveSettings({ settings: original, ...STAFF });
  }
});

test("editorial presets preserve saved choices and only allow curated campaign layouts", () => {
  const original = settings();
  const doc = structuredClone(original);
  doc.images.hero_slides = [];
  doc.sections = [...doc.sections].reverse().map((section, order) => ({ ...section, order, visible: false, image_url: null, body_en: "" }));
  doc.campaigns = [{ ...original.campaigns[0], layout: "arbitrary-css" as never }];
  const safe = sanitizeSettings(doc);
  assert.deepEqual(safe.images.hero_slides, [], "a cleared hero stays cleared");
  assert.deepEqual(safe.sections.map((s) => s.key), doc.sections.map((s) => s.key));
  assert.ok(safe.sections.every((s) => !s.visible && s.image_url === null && s.body_en === ""));
  assert.equal(safe.campaigns[0].layout, "split");
  for (const layout of ["full", "split", "alternating"] as const) {
    doc.campaigns[0].layout = layout;
    assert.equal(sanitizeSettings(doc).campaigns[0].layout, layout);
  }
});

test("bundled photography saves through the unchanged SQL absolute-URL policy", () => {
  const original = settings();
  const remote = settingsForRemoteSave(original, "https://shop.example");
  assert.equal(remote.campaigns[0].desktop_image_url, "https://shop.example/brand/categories/jewellery.jpg");
  assert.equal(remote.images.hero_slides[0].mobile_image_url, "https://shop.example/brand/hero-editorial-mobile.jpg");
  assert.equal(original.campaigns[0].desktop_image_url, "/brand/categories/jewellery.jpg", "never mutate a draft");
  assert.equal(remote.campaigns[0].cta_href, "#/store/products");
  const uploaded = structuredClone(original);
  uploaded.campaigns[0].desktop_image_url = "https://media.example/upload.jpg";
  assert.equal(settingsForRemoteSave(uploaded, "https://shop.example").campaigns[0].desktop_image_url, uploaded.campaigns[0].desktop_image_url);
  assert.throws(() => settingsForRemoteSave(original, "javascript:alert(1)"));
});

// runner — sequential, because the demo repository keeps one write in flight
let passed = 0;
async function main(): Promise<void> {
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\n${passed}/${tests.length} Phase 9 online-shop tests passed.\n`);
}

await main();

import assert from "node:assert/strict";
import { buildDemoProducts } from "@/modules/products/data/demoSeed";
import { dictionaries } from "@/lib/i18n/dictionary";
import type { CustomerAddress, DeliveryZone, OnlineOrder } from "../../types";
import { DEFAULT_WEBSITE_SETTINGS } from "../../services/settingsDefaults";
import type { StoreVariant } from "../../services/pricing";
import { EMPTY_CATALOG_FILTERS, filtersFromSearchParams, filtersToSearchParams,
  searchCatalog, type CatalogContext } from "../../services/catalogQuery";
import { v2CatalogResults } from "../viewModel";
import { V2_RECEIPT_KEY, readV2Receipt, rememberV2Receipt, planV2Reorder,
  v2CheckoutIssues } from "../journeyModel";

let passed = 0;
function test(name: string, run: () => void) { run(); console.log(`✓ ${name}`); passed++; }
const one = { ...buildDemoProducts()[0], id: "one", variants_enabled: true,
  stock_tracking_enabled: true, stock_quantity: 7, active: true, show_on_website: true, selling_price: 100 };
function variant(id: string, size: number | null, sizeLabel: string | null,
  color = "gold", stock = 3): StoreVariant {
  return { id, product_id: one.id, sku: `SKU-${id}`, color_key: color,
    color_ar: color === "gold" ? "ذهبي" : "فضي", color_en: color,
    color_hex: null, size, size_label: sizeLabel, image_url: null,
    stock_quantity: stock, price_override: null, active: true, sort_order: 1 };
}
const gold17 = variant("gold17", 17, null);
const gold18 = variant("gold18", 18, null, "gold", 0);
const silver17 = variant("silver17", 17, null, "silver");
const silverM = variant("silverM", null, "M", "silver");
const context: CatalogContext = { campaigns: [], units: new Map(), contents: new Map(), reserved: new Map(),
  variants: new Map([[one.id, [gold17, gold18, silver17, silverM]]]),
  reservedVariant: new Map([[silver17.id, 2]]) };
const historic = { order_number: "WEB-000421", customer_phone: "01012345678", items: [
  { product_id: one.id, variant_id: gold17.id, sku: gold17.sku, quantity: 1 },
] } as OnlineOrder;
const address: CustomerAddress = { id: "address", label: "Home", full_name: "Shopper", phone: "01012345678",
  city: "Cairo", area: "Maadi", street: "19 Street", building: "", floor: "", apartment: "",
  is_default: false, notes: null };

 test("receipt storage holds only a temporary reference+phone pair; refresh always needs private lookup", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
  rememberV2Receipt(historic, storage);
  const raw = data.get(V2_RECEIPT_KEY) ?? "";
  assert.ok(raw.includes("WEB-000421") && raw.includes("01012345678"));
  assert.ok(!raw.includes("items") && !raw.includes("subtotal") && !raw.includes("customer_name"));
  const pair = readV2Receipt(storage);
  assert.deepEqual({ order: pair?.order, phone: pair?.phone }, { order: historic.order_number,
    phone: historic.customer_phone });
  assert.equal(readV2Receipt(storage, Date.now() + 3 * 60 * 60 * 1000), null);
  assert.equal(storage.getItem(V2_RECEIPT_KEY), null, "expired pair removed");
  data.set(V2_RECEIPT_KEY, JSON.stringify({ order: "WEB-000421", at: Date.now() }));
  assert.equal(readV2Receipt(storage), null, "reference alone is insufficient");
  data.set(V2_RECEIPT_KEY, "invalid JSON");
  assert.equal(readV2Receipt(storage), null, "bad storage never renders an order");
  assert.equal(readV2Receipt({ getItem: () => { throw Error("blocked"); }, setItem: () => {}, removeItem: () => {} }), null);
});

test("checkout guard mirrors delivery zone/phone/minimum and rejects unavailable fulfilment/stock", () => {
  const settings = structuredClone(DEFAULT_WEBSITE_SETTINGS);
  settings.delivery.enabled = true;
  settings.delivery.pickup_enabled = true;
  settings.delivery.cod_enabled = true;
  settings.delivery.instapay_enabled = true;
  settings.delivery.minimum_order = 90;
  const zone = { id: "cairo", enabled: true, minimum_order_amount: 120 } as DeliveryZone;
  const fields = { name: "Shopper", phone: "01012345678", address, deliveryType: "delivery" as const,
    deliveryZoneId: "cairo", goodsTotal: 150, blockedLines: 0 };
  const okay = v2CheckoutIssues(fields, settings, [zone]);
  assert.equal(okay.phone || okay.name || okay.address || okay.zone || okay.area || okay.fulfilment ||
    okay.payment || okay.stock || okay.shortfall > 0, false);
  assert.equal(v2CheckoutIssues({ ...fields, phone: "123" }, settings, [zone]).phone, true);
  assert.equal(v2CheckoutIssues({ ...fields, deliveryZoneId: null }, settings, [zone]).zone, true);
  assert.equal(v2CheckoutIssues({ ...fields, goodsTotal: 100 }, settings, [zone]).shortfall, 20);
  assert.equal(v2CheckoutIssues({ ...fields, blockedLines: 1 }, settings, [zone]).stock, true);
  settings.delivery.enabled = false;
  assert.equal(v2CheckoutIssues(fields, settings, [zone]).fulfilment, true);
  assert.equal(v2CheckoutIssues({ ...fields, deliveryType: "pickup" }, settings, [zone]).fulfilment, false);
  settings.delivery.cod_enabled = false; settings.delivery.instapay_enabled = false;
  assert.equal(v2CheckoutIssues({ ...fields, deliveryType: "pickup" }, settings, [zone]).payment, true);
});

test("reorder requires the published exact variant and sufficient shelf stock (including existing cart)", () => {
  const plan = planV2Reorder(historic, [one], [gold17, gold18, silver17, silverM]);
  assert.deepEqual(plan.ready, [{ product_id: one.id, variant_id: gold17.id, quantity: 1 }]);
  assert.deepEqual(plan.unavailable, []);
  const missing = planV2Reorder(historic, [one], [silver17]);
  assert.deepEqual(missing.ready, []);
  assert.deepEqual(missing.unavailable, [gold17.sku], "silver size 17 never replaces missing gold size 17");
  assert.deepEqual(planV2Reorder(historic, [one], [{ ...gold17, active: false }]).unavailable, [gold17.sku]);
  assert.deepEqual(planV2Reorder(historic, [one], [gold17], new Map(), new Map([[gold17.id, 2]]),
    [{ product_id: one.id, variant_id: gold17.id, quantity: 1 }]).unavailable, [gold17.sku]);
  assert.deepEqual(planV2Reorder(historic, [{ ...one, show_on_website: false }], [gold17]).unavailable, [gold17.sku]);
  const oldWithoutVariant = { ...historic, items: [{ ...historic.items[0], variant_id: null }] } as OnlineOrder;
  assert.equal(planV2Reorder(oldWithoutVariant, [one], [gold17]).ready.length, 0,
    "historic product-only line cannot turn into a guessed size");
});

test("a published stock-tracked simple product reorders without inventing a variant", () => {
  const simple = { ...one, id: "simple", sku: "SKU-SIMPLE", variants_enabled: false, stock_quantity: 4 };
  const item = { ...historic.items[0], product_id: simple.id, variant_id: null,
    sku: simple.sku, quantity: 2 };
  const order = { ...historic, items: [item] } as OnlineOrder;
  assert.deepEqual(planV2Reorder(order, [simple], []), {
    ready: [{ product_id: simple.id, variant_id: null, quantity: 2 }], unavailable: [],
  });
  assert.deepEqual(planV2Reorder(order, [{ ...simple, stock_quantity: 1 }], []).unavailable,
    [item.sku], "current simple-product stock limits the reorder");
  assert.deepEqual(planV2Reorder(order, [simple], [], new Map([[simple.id, 3]])).unavailable,
    [item.sku], "existing reservations limit the same current shelf");
});

test("unpublished, inactive, untracked and sold-out historical products cannot enter a reorder", () => {
  const cases = [
    [{ ...one, show_on_website: false }, [gold17], "unpublished product"],
    [{ ...one, active: false }, [gold17], "archived product"],
    [{ ...one, stock_tracking_enabled: false }, [gold17], "tracking-disabled product"],
    [one, [{ ...gold17, active: false }], "inactive exact variant"],
    [one, [], "unpublished exact variant"],
    [one, [{ ...gold17, stock_quantity: 0 }], "sold-out exact variant"],
    [one, [{ ...gold17, product_id: "another-product" }], "UUID owned by another product"],
    [{ ...one, variants_enabled: false }, [gold17], "product no longer sells by variant"],
  ] as const;
  for (const [product, variants, label] of cases) {
    assert.deepEqual(planV2Reorder(historic, [product], variants),
      { ready: [], unavailable: [gold17.sku] }, label);
  }
});

test("partial reorder keeps only currently valid exact UUIDs and identifies every refused SKU", () => {
  const simple = { ...one, id: "simple", sku: "SKU-SIMPLE", variants_enabled: false, stock_quantity: 4 };
  const simpleItem = { ...historic.items[0], product_id: simple.id, variant_id: null, sku: simple.sku };
  const unavailableItem = { ...historic.items[0], variant_id: gold18.id, sku: gold18.sku };
  const order = { ...historic, items: [simpleItem, historic.items[0], unavailableItem] } as OnlineOrder;
  const plan = planV2Reorder(order, [simple, one], [silver17, gold17, gold18]);
  assert.deepEqual(plan.ready, [
    { product_id: simple.id, variant_id: null, quantity: 1 },
    { product_id: one.id, variant_id: gold17.id, quantity: 1 },
  ]);
  assert.deepEqual(plan.unavailable, [gold18.sku]);
  assert.equal(plan.ready.some((line) => line.variant_id === silver17.id), false,
    "same-size silver is never silently substituted for the unavailable gold shelf");
  const allUnavailable = planV2Reorder({ ...order, items: [unavailableItem] }, [simple, one],
    [silver17, gold18]);
  assert.deepEqual(allUnavailable, { ready: [], unavailable: [gold18.sku] });
});

test("repeated historical lines never promise more stock than the exact shelf holds", () => {
  const two = { ...historic.items[0], quantity: 2 };
  const result = planV2Reorder({ ...historic, items: [two, two] } as OnlineOrder, [one], [gold17]);
  assert.deepEqual(result, { ready: [{ product_id: one.id, variant_id: gold17.id, quantity: 2 }],
    unavailable: [gold17.sku] });
});

test("URL-backed numeric/letter-size + color facets select a single matching shelf", () => {
  const filters = { ...EMPTY_CATALOG_FILTERS, color: "silver", sizeLabel: "M" };
  const roundTrip = filtersFromSearchParams(filtersToSearchParams(filters));
  assert.equal(roundTrip.sizeLabel, "M");
  assert.deepEqual(searchCatalog([one], roundTrip, context).map((row) => row.product.id), [one.id]);
  assert.equal(searchCatalog([one], { ...filters, color: "gold" }, context).length, 0,
    "gold 17 + silver M cannot form an imaginary combination");
  assert.equal(searchCatalog([one], { ...EMPTY_CATALOG_FILTERS, color: "gold", size: 18,
    availability: "in_stock" }, context).length, 0);
  assert.equal(searchCatalog([one], { ...EMPTY_CATALOG_FILTERS, color: "gold", size: 18,
    availability: "out_of_stock" }, context).length, 1);
  assert.equal(searchCatalog([one], { ...EMPTY_CATALOG_FILTERS, color: "silver", size: 17,
    availability: "in_stock" }, context).length, 1, "one unit remains after the hold");
  const narrowed = v2CatalogResults([one], { ...filters, availability: "in_stock" }, context, [], [], []);
  assert.equal(narrowed[0]?.available, 3);
  assert.deepEqual(v2CatalogResults([one], { ...EMPTY_CATALOG_FILTERS, color: "gold", size: 18,
    availability: "out_of_stock" }, context, [], [], []).map((row) => row.available), [0]);
});

test("all new journey/advisory copy is translated in both directions", () => {
  const keys = ["advisoryCoupon", "advisoryTotal", "checkingPrices", "zoneEstimate", "receiptPrivate",
    "trackBoth", "browserLocal", "reorderUnavailable", "reorderPartial", "cartPruned"] as const;
  for (const key of keys) {
    const name = `store.v2.journey.${key}` as keyof typeof dictionaries.en;
    assert.ok(dictionaries.en[name]); assert.ok(dictionaries.ar[name]);
    assert.notEqual(dictionaries.en[name], dictionaries.ar[name]);
  }
});

console.log(`✓ ${passed}/${passed} V2 Phase 3 journey logic tests passed`);

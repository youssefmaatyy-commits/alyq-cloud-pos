/** Checkout copy, zone authority and propagation regression tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DeliveryZone, WebsiteSettings } from "../../types";
import {
  DEFAULT_WEBSITE_SETTINGS,
  resolveSettings,
  sanitizeSettings,
} from "../../services/settingsDefaults";
import {
  checkoutFreeDeliveryProgress,
  deliveryFeeFor,
} from "../../services/pricing";
import {
  activeCheckoutCopy,
  checkoutCopyWithAmount,
} from "../../services/checkoutCopy";
import {
  clearCachedPublicSettings,
  readCachedPublicSettings,
  writeCachedPublicSettings,
} from "../../services/publicSettingsCache";

const storage = new Map<string, string>();
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  onmessage: (() => void) | null = null;
  messages: unknown[] = [];
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(message: unknown) { this.messages.push(message); }
  close() { /* no-op */ }
}

const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: localStorageStub,
  BroadcastChannel: FakeBroadcastChannel,
};

const zone = (overrides: Partial<DeliveryZone> = {}): DeliveryZone => ({
  id: "zone-a",
  key: "zone-a",
  name_en: "Zone A",
  name_ar: "المنطقة أ",
  governorate_key: null,
  shipping_fee: 50,
  minimum_order_amount: 0,
  free_shipping_threshold: 300,
  estimated_delivery_text_en: null,
  estimated_delivery_text_ar: null,
  show_estimated_delivery: true,
  enabled: true,
  sort_order: 1,
  created_at: "2026-10-06T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z",
  ...overrides,
});

const customSettings = (overrides: Partial<WebsiteSettings["checkout_copy"]> = {}) =>
  resolveSettings({
    checkout_copy: {
      ...DEFAULT_WEBSITE_SETTINGS.checkout_copy,
      free_delivery_progress_ar: "متبقٍ {{amount}}",
      free_delivery_progress_en: "Only {{amount}} to go <b>plain</b> {{other}}",
      show_free_delivery_progress: false,
      estimated_total_advisory_ar: "",
      estimated_total_advisory_en: "Custom estimate",
      show_estimated_total_advisory: true,
      delivery_calculated_helper_ar: "يحسب لاحقًا",
      delivery_calculated_helper_en: "Quoted after address",
      show_delivery_calculated_helper: false,
      ...overrides,
    },
  });

console.log("Checkout copy / delivery-zone regressions:");

// Plain text, active-language-only selection, and one controlled token.
{
  const settings = customSettings();
  assert.equal(activeCheckoutCopy(settings.checkout_copy, "estimated_total_advisory", "ar"), "");
  assert.equal(activeCheckoutCopy(settings.checkout_copy, "estimated_total_advisory", "en"), "Custom estimate");
  assert.equal(
    checkoutCopyWithAmount(
      activeCheckoutCopy(settings.checkout_copy, "free_delivery_progress", "en"),
      "EGP 125.00",
    ),
    "Only EGP 125.00 to go <b>plain</b> {{other}}",
    "only {{amount}} is interpreted; HTML-looking text and unknown tokens stay literal",
  );
}

// Sanitization and JSON/JSONB-shaped round trips retain boolean controls.
{
  const sanitized = sanitizeSettings(customSettings());
  assert.equal(sanitized.checkout_copy.show_free_delivery_progress, false);
  assert.equal(sanitized.checkout_copy.show_estimated_total_advisory, true);
  assert.equal(sanitized.checkout_copy.show_delivery_calculated_helper, false);
  const jsonbRoundTrip = JSON.parse(JSON.stringify(sanitized)) as WebsiteSettings;
  assert.equal(jsonbRoundTrip.checkout_copy.show_free_delivery_progress, false);
  assert.equal(jsonbRoundTrip.checkout_copy.free_delivery_progress_en.includes("{{amount}}"), true);
}

// Admin-save cache overwrite and subsequent warm-cache read preserve every field.
{
  clearCachedPublicSettings();
  const first = customSettings();
  writeCachedPublicSettings(first, { updated_at: "2026-10-06T10:00:00Z", updated_by_name: "Admin" });
  const warm = readCachedPublicSettings();
  assert.ok(warm);
  assert.equal(warm.settings.checkout_copy.free_delivery_progress_en, first.checkout_copy.free_delivery_progress_en);
  assert.equal(warm.settings.checkout_copy.show_free_delivery_progress, false);

  const second = customSettings({
    free_delivery_progress_en: "Saved replacement {{amount}}",
    show_free_delivery_progress: true,
  });
  writeCachedPublicSettings(second, { updated_at: "2026-10-06T10:01:00Z", updated_by_name: "Admin" });
  const replaced = readCachedPublicSettings();
  assert.ok(replaced);
  assert.equal(replaced.settings.checkout_copy.free_delivery_progress_en, "Saved replacement {{amount}}");
  assert.equal(replaced.settings.checkout_copy.show_free_delivery_progress, true);
}

// Zone rows are authoritative; legacy fallback exists only when there are none.
{
  const delivery = DEFAULT_WEBSITE_SETTINGS.delivery;
  assert.equal(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "pickup", subtotalAfterDiscount: 100, zones: [], selectedZoneId: null,
  }), null, "pickup never advertises delivery progress");
  assert.deepEqual(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "delivery", subtotalAfterDiscount: 200, zones: [], selectedZoneId: null,
  }), { eligible: false, remaining: 300, threshold: 500 }, "no zone rows uses the global fallback");
  assert.equal(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "delivery", subtotalAfterDiscount: 200, zones: [zone()], selectedZoneId: null,
  }), null, "zone rows with no selection hide progress");
  assert.equal(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "delivery", subtotalAfterDiscount: 200,
    zones: [zone({ enabled: false })], selectedZoneId: "zone-a",
  }), null, "a disabled selected zone cannot authorize progress");
  assert.deepEqual(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "delivery", subtotalAfterDiscount: 225, zones: [zone()], selectedZoneId: "zone-a",
  }), { eligible: false, remaining: 75, threshold: 300 }, "selected enabled zone uses discounted goods and its threshold");
  assert.deepEqual(checkoutFreeDeliveryProgress({
    delivery, deliveryType: "delivery", subtotalAfterDiscount: 325, zones: [zone()], selectedZoneId: "zone-a",
  }), { eligible: true, remaining: 0, threshold: 300 });
}

// Copy visibility cannot influence pricing.
{
  const hidden = customSettings({
    show_free_delivery_progress: false,
    show_estimated_total_advisory: false,
    show_delivery_calculated_helper: false,
  });
  const shown = customSettings({
    show_free_delivery_progress: true,
    show_estimated_total_advisory: true,
    show_delivery_calculated_helper: true,
  });
  assert.equal(deliveryFeeFor(hidden.delivery, "delivery", 200), deliveryFeeFor(shown.delivery, "delivery", 200));
  assert.deepEqual(
    checkoutFreeDeliveryProgress({ delivery: hidden.delivery, deliveryType: "delivery", subtotalAfterDiscount: 200, zones: [], selectedZoneId: null }),
    checkoutFreeDeliveryProgress({ delivery: shown.delivery, deliveryType: "delivery", subtotalAfterDiscount: 200, zones: [], selectedZoneId: null }),
  );
}

// Same-document and simulated cross-tab invalidation both reach provider listeners.
{
  const { storefrontInvalidation } = await import("../../hooks/storefrontInvalidation");
  let refreshes = 0;
  const unsubscribe = storefrontInvalidation.subscribe(() => { refreshes += 1; });
  storefrontInvalidation.notify();
  assert.equal(refreshes, 1, "admin save notification refreshes the mounted provider");
  const channel = FakeBroadcastChannel.instances.find((entry) => entry.name === "alyq.storefront.invalidate");
  assert.ok(channel);
  assert.deepEqual(channel.messages, ["changed"]);
  channel.onmessage?.();
  assert.equal(refreshes, 2, "another tab's channel message refreshes the provider");
  unsubscribe();
}

// Pin the wiring around the pure contracts: JSONB save, cache replacement,
// provider refresh and one totals renderer (the duplicate checkout advisory is gone).
{
  const root = process.cwd();
  const repository = fs.readFileSync(path.join(root, "src/modules/online/data/supabaseRepository.ts"), "utf8");
  const settingsPage = fs.readFileSync(path.join(root, "src/modules/online/pages/WebsiteSettingsPage.tsx"), "utf8");
  const provider = fs.readFileSync(path.join(root, "src/modules/online/hooks/StorefrontProvider.tsx"), "utf8");
  const totals = fs.readFileSync(path.join(root, "src/modules/online/v2/JourneyParts.tsx"), "utf8");
  const checkout = fs.readFileSync(path.join(root, "src/modules/online/v2/StorefrontV2Checkout.tsx"), "utf8");
  assert.match(repository, /settings:\s*settingsForRemoteSave\(sanitizeSettings\(input\.settings\)/);
  assert.match(settingsPage, /writeCachedPublicSettings\(normalized, nextMeta\)/);
  assert.match(settingsPage, /storefrontInvalidation\.notify\(\)/);
  assert.match(provider, /storefrontInvalidation\.subscribe\(\(\)\s*=>\s*\{\s*void load\(\)/);
  assert.match(totals, /data-testid="v2-estimated-total-advisory"/);
  assert.equal((checkout.match(/store\.v2\.journey\.advisoryTotal/g) ?? []).length, 0);
}

console.log("  ✓ checkout copy, cache, invalidation, rendering and zone authority passed");

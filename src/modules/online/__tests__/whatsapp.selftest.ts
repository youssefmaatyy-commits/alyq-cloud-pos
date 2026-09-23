/**
 * Phase 55 — WhatsApp order updates are deep links, not deliveries.
 */
import assert from "node:assert/strict";
import process from "node:process";

import { identityPhone, whatsAppDestination } from "@/lib/phone";
import { resolveSettings } from "../services/settingsDefaults";
import {
  WHATSAPP_UPDATE_MUTES_ORDER,
  WHATSAPP_UPDATE_OUTCOME,
  customerTrackingLink,
  defaultWhatsAppTemplates,
  fillWhatsAppTemplate,
  orderGovernorateLabel,
  planWhatsAppUpdate,
  resolveWhatsAppUpdates,
  suggestedTemplateKey,
  whatsAppPlaceholderValues,
} from "../services/whatsapp";
import { WHATSAPP_PLACEHOLDERS } from "../types";

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("Egyptian mobiles collapse; another country is not rewritten to 20", () => {
  const stored = "+966 50 123 4567";
  assert.equal(whatsAppDestination("01001234567"), "201001234567");
  assert.equal(whatsAppDestination("+20 100 123 4567"), "201001234567");
  assert.equal(whatsAppDestination("00201001234567"), "201001234567");
  assert.equal(whatsAppDestination("201001234567"), "201001234567");
  assert.equal(whatsAppDestination(stored), "966501234567");
  assert.equal(stored, "+966 50 123 4567", "the stored number is not mutated");
  assert.equal(identityPhone("01001234567"), identityPhone("+20 100 123 4567"));
  assert.notEqual(identityPhone(stored).startsWith("20"), true);
});

test("a missing or local-unknown phone does not produce a URL", () => {
  assert.equal(whatsAppDestination(""), null);
  assert.equal(whatsAppDestination("abc"), null);
  assert.equal(whatsAppDestination("01"), null);
  assert.equal(whatsAppDestination("0123"), null);
  assert.equal(whatsAppDestination("0212345678"), null, "a non-mobile local number is not guessed as Egypt");
  const plan = planWhatsAppUpdate({
    phone: "",
    template: "hello",
    values: {},
    templateKey: "approved",
    language: "en",
  });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.reason, "invalid_phone");
  assert.equal(plan.mutatesOrderStatus, false);
});

test("Arabic and English previews resolve placeholders and encode the URL", () => {
  const values = whatsAppPlaceholderValues({
    customerName: "Ahmed",
    orderNumber: "WEB-000042",
    orderTotalLabel: "1,500.00 EGP",
    governorate: "الإسماعيلية",
    trackingLink: customerTrackingLink("https://shop.example", "WEB-000042", "01001234567"),
    paymentMethodLabel: "Cash on delivery",
    deliveryMethodLabel: "Delivery",
  });
  const arabic = fillWhatsAppTemplate(defaultWhatsAppTemplates().approved.ar, values);
  const english = fillWhatsAppTemplate(defaultWhatsAppTemplates().approved.en, values);
  assert.match(arabic, /تم تأكيد طلبك رقم WEB-000042/);
  assert.match(arabic, /Ahmed/);
  assert.match(english, /Your order WEB-000042 is confirmed/);
  assert.match(english, /1,500\.00 EGP/);
  assert.equal(values.tracking_link.includes("/online/"), false);
  assert.equal(values.tracking_link.includes("/#/store/track?"), true);
  assert.equal(values.tracking_link.includes("order=WEB-000042"), true);

  const plan = planWhatsAppUpdate({
    phone: "01001234567",
    template: `${arabic} & {{unit_cost}} {{promotion_id}}`,
    values,
    templateKey: "approved",
    language: "ar",
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.destination, "201001234567");
  assert.equal(plan.url.startsWith("https://wa.me/201001234567?text="), true);
  const decoded = decodeURIComponent(plan.url.split("?text=")[1]);
  assert.equal(decoded, plan.message);
  assert.equal(decoded.includes("unit_cost"), false);
  assert.equal(decoded.includes("promotion_id"), false);
  assert.equal(decoded.includes("&"), true);
  assert.equal(plan.outcome, "initiated");
  assert.equal(plan.outcome === WHATSAPP_UPDATE_OUTCOME, true);
  assert.equal(plan.mutatesOrderStatus, WHATSAPP_UPDATE_MUTES_ORDER);
  assert.equal(JSON.stringify(plan).includes("delivered"), false);
});

test("unknown placeholders are stripped and internal fields are not in the value set", () => {
  const values = whatsAppPlaceholderValues({
    customerName: "Sara",
    orderNumber: "WEB-1",
    orderTotalLabel: "10",
    governorate: "Cairo",
    trackingLink: "https://shop.example/#/store/track?order=WEB-1",
    paymentMethodLabel: "InstaPay",
    deliveryMethodLabel: "Delivery",
  });
  assert.deepEqual(Object.keys(values).sort(), [...WHATSAPP_PLACEHOLDERS].sort());
  assert.equal(fillWhatsAppTemplate("x {{unit_cost}} {{approval_id}} {{payment_reference}}", values), "x");
  assert.equal("delivery_estimate" in values, false);
});

test("templates follow the real status, including pickup versus delivery", () => {
  assert.equal(suggestedTemplateKey({ status: "approved", delivery_type: "delivery" }), "approved");
  assert.equal(suggestedTemplateKey({ status: "processing", delivery_type: "delivery" }), "processing");
  assert.equal(suggestedTemplateKey({ status: "ready", delivery_type: "delivery" }), "ready_delivery");
  assert.equal(suggestedTemplateKey({ status: "ready", delivery_type: "pickup" }), "ready_pickup");
  assert.equal(suggestedTemplateKey({ status: "completed", delivery_type: "delivery" }), "completed_delivery");
  assert.equal(suggestedTemplateKey({ status: "completed", delivery_type: "pickup" }), "completed_pickup");
  assert.equal(suggestedTemplateKey({ status: "pending", delivery_type: "delivery" }), null);
  assert.equal(suggestedTemplateKey({ status: "cancelled", delivery_type: "delivery" }), null);
});

test("governorate comes from the order snapshot, not a live zone list", () => {
  const label = orderGovernorateLabel(
    {
      delivery_zone_name_en: "Ismailia",
      delivery_zone_name_ar: "الإسماعيلية",
      address: { city: "Old city" } as never,
    },
    "en",
  );
  assert.equal(label, "Ismailia");
  assert.equal(
    orderGovernorateLabel({ delivery_zone_name_en: null, delivery_zone_name_ar: null, address: { city: "Suez" } as never }, "en"),
    "Suez",
  );
});

test("stored template edits survive, missing keys fall back, and empty text resets", () => {
  const resolved = resolveWhatsAppUpdates({
    templates: {
      processing: { ar: "نص مخصص", en: "" },
      not_a_status: { ar: "nope", en: "nope" },
    },
  });
  assert.equal(resolved.templates.processing.ar, "نص مخصص");
  assert.equal(resolved.templates.processing.en, defaultWhatsAppTemplates().processing.en);
  assert.equal(resolved.templates.approved.ar, defaultWhatsAppTemplates().approved.ar);
  assert.equal("not_a_status" in resolved.templates, false);
  const viaSettings = resolveSettings({ whatsapp_updates: { templates: { approved: { ar: "تم", en: "Done {{order_number}}" } } } });
  assert.equal(viaSettings.whatsapp_updates.templates.approved.en, "Done {{order_number}}");
  assert.match(viaSettings.whatsapp_updates.templates.ready_delivery.ar, /خرج للتوصيل/);
});

let passed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    passed += 1;
    console.log(`  ✓ ${entry.name}`);
  } catch (err) {
    console.error(`  ✗ ${entry.name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} Phase 55 WhatsApp tests passed`);

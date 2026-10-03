import assert from "node:assert/strict";
import { BarcodeBurstDecoder, isNormalTypingTarget } from "../hooks/useBarcodeScanner";
import { resolveExactScannedVariant } from "../services/scanner";
import type { ProductVariant } from "@/modules/products/variants";

class FakeElement {
  constructor(private readonly editable: boolean, private readonly optIn = false) {}
  closest(): FakeElement | null { return this.editable ? this : null; }
  hasAttribute(name: string): boolean { return name === "data-barcode-scanner-capture" && this.optIn; }
}
(globalThis as unknown as { Element: typeof FakeElement }).Element = FakeElement;

const tests: Array<[string, () => void]> = [
  ["rapid HID burst yields the exact Black/42 barcode", () => {
    const decoder = new BarcodeBurstDecoder();
    let result: string | null = null;
    [..."629ALYQ0142", "Enter"].forEach((key, index) => { result = decoder.feed(key, index * 12 + 1) ?? result; });
    assert.equal(result, "629ALYQ0142");
  }],
  ["ALYQ-01 Black/42 code resolves only its exact active branch shelf", () => {
    const base = {
      product_id: "alyq-01", color_key: "black", color_ar: "أسود", color_en: "Black", color_hex: null,
      image_url: null, price_override: null, cost_override: null, low_stock_level: 1, active: true,
      sort_order: 1, created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z",
    };
    const variants: ProductVariant[] = [
      { ...base, id: "black-41", sku: "ALYQ-01-BLK-41", barcode: "629ALYQ0141", size: 41, size_label: "41", size_value: "41", stock_quantity: 8 },
      { ...base, id: "black-42", sku: "ALYQ-01-BLK-42", barcode: "629ALYQ0142", size: 42, size_label: "42", size_value: "42", stock_quantity: 6 },
    ];
    const exact = resolveExactScannedVariant("629alyq0142", variants);
    assert.equal(exact?.id, "black-42"); assert.equal(exact?.sku, "ALYQ-01-BLK-42"); assert.equal(exact?.stock_quantity, 6);
  }],
  ["slow normal typing cannot become a scan", () => {
    const decoder = new BarcodeBurstDecoder();
    let result: string | null = null;
    [..."629ALYQ0142", "Enter"].forEach((key, index) => { result = decoder.feed(key, index * 120 + 1) ?? result; });
    assert.equal(result, null);
  }],
  ["short bursts are not barcodes", () => {
    const decoder = new BarcodeBurstDecoder();
    decoder.feed("4", 1); decoder.feed("2", 10);
    assert.equal(decoder.feed("Enter", 20), null);
  }],
  ["ordinary form fields are excluded", () => {
    assert.equal(isNormalTypingTarget(new FakeElement(true) as unknown as EventTarget), true);
    assert.equal(isNormalTypingTarget(new FakeElement(false) as unknown as EventTarget), false);
  }],
  ["capture is possible only for an explicit opt-in field", () => {
    assert.equal(isNormalTypingTarget(new FakeElement(true, true) as unknown as EventTarget), false);
  }],
];

for (const [name, run] of tests) { run(); console.log(`  ✓ ${name}`); }
console.log(`\n${tests.length}/${tests.length} scanner safety tests passed`);

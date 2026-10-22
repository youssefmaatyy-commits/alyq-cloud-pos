import assert from "node:assert/strict";
import { BarcodeBurstDecoder, isNormalTypingTarget } from "../hooks/useBarcodeScanner";
import { resolveExactScannedVariant } from "../services/scanner";
import { encodeCode128 } from "../services/barcodeHelpers";
import {
  classifyCameraError,
  decode1DBarcodeFromRgbaFrame,
} from "../services/cameraBarcodeScanner";
import { isAndroidPrintSpoolerAvailable, printHtmlDocument } from "../services/receipt";
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
  ["camera 1D scanline decoder round-trips Code 128 SKU and invoice barcodes from RGBA frames", () => {
    for (const sample of ["ALYQ-01-BLK-42", "SAL-20261020-001", "6291041500213"]) {
      const encoded = encodeCode128(sample, 10);
      assert.ok(encoded, `expected ${sample} to encode as Code 128`);
      const scale = 3;
      const width = encoded.width * scale;
      const height = 24;
      const rgba = new Uint8ClampedArray(width * height * 4);
      // Fill white background
      rgba.fill(255);
      // Paint black bars
      for (const bar of encoded.bars) {
        const startX = bar.x * scale;
        const endX = (bar.x + bar.width) * scale;
        for (let y = 0; y < height; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const idx = (y * width + x) * 4;
            rgba[idx] = 0;
            rgba[idx + 1] = 0;
            rgba[idx + 2] = 0;
            rgba[idx + 3] = 255;
          }
        }
      }
      const decoded = decode1DBarcodeFromRgbaFrame(rgba, width, height);
      assert.equal(decoded?.rawValue, sample);
      assert.equal(decoded?.format, "code_128");
    }
  }],
  ["camera permission classifier distinguishes denied, missing and busy camera hardware", () => {
    assert.equal(classifyCameraError({ name: "NotAllowedError", message: "Permission denied" }), "denied");
    assert.equal(classifyCameraError({ name: "NotFoundError", message: "Requested device not found" }), "not_found");
    assert.equal(classifyCameraError({ name: "NotReadableError", message: "Could not start video source" }), "in_use");
  }],
  ["Android PrintManager bridge handles receipt HTML when running inside Capacitor Android WebView", () => {
    const prevWindow = (globalThis as { window?: unknown }).window;
    let capturedHtml = "";
    let capturedRef = "";
    try {
      (globalThis as { window?: unknown }).window = {
        ALYQAndroidPrint: {
          isSupported: () => true,
          printHtml: (html: string, ref: string) => {
            capturedHtml = html;
            capturedRef = ref;
            return true;
          },
        },
      };
      assert.equal(isAndroidPrintSpoolerAvailable(), true);
      const outcome = printHtmlDocument("<!doctype html><html><body>ALYQ Receipt</body></html>", "SAL-1001");
      assert.equal(outcome, "android-spooler");
      assert.match(capturedHtml, /ALYQ Receipt/);
      assert.equal(capturedRef, "SAL-1001");
    } finally {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }],
];

for (const [name, run] of tests) { run(); console.log(`  ✓ ${name}`); }
console.log(`\n${tests.length}/${tests.length} scanner safety tests passed`);

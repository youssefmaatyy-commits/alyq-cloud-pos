import assert from "node:assert/strict";
import { BarcodeBurstDecoder, isNormalTypingTarget } from "../hooks/useBarcodeScanner";

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

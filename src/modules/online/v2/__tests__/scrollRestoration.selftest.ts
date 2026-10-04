import assert from "node:assert/strict";
import { decideV2Scroll } from "../scrollRestoration";

let passed = 0;
function test(name: string, run: () => void) { run(); console.log(`✓ ${name}`); passed++; }

test("a new destination (PUSH) always starts at the top, even if a position was recorded for this key", () => {
  assert.equal(decideV2Scroll("PUSH", undefined), 0);
  assert.equal(decideV2Scroll("PUSH", 480), 0, "a reused key on PUSH must not resurrect an old scroll offset");
});

test("a replaced entry (REPLACE, e.g. checkout -> confirmation) also starts at the top", () => {
  assert.equal(decideV2Scroll("REPLACE", undefined), 0);
  assert.equal(decideV2Scroll("REPLACE", 900), 0);
});

test("browser Back/Forward (POP) restores the exact saved offset for that history entry", () => {
  assert.equal(decideV2Scroll("POP", 640), 640);
  assert.equal(decideV2Scroll("POP", 0), 0);
});

test("POP with no recorded offset (first visit, or a fresh deep link) falls back to the top", () => {
  assert.equal(decideV2Scroll("POP", undefined), 0);
});

test("a saved offset is never negative regardless of how it was recorded", () => {
  assert.equal(decideV2Scroll("POP", -40), 0);
});

console.log(`${passed}/${passed} V2 scroll-restoration logic tests passed`);

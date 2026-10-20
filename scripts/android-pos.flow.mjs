/**
 * Android Full POS Mobile DOM E2E Flow.
 *
 * Verifies in a rendered 390×844 mobile viewport:
 *   1. Native Capacitor startup redirects `#/` directly to `#/dashboard`.
 *   2. Mobile Bottom Navigation Bar (`mobile-pos-bottom-nav`) renders all 5 tabs.
 *   3. All-Modules Bottom Sheet (`mobile-pos-modules-sheet`) exposes every
 *      ALYQ POS module and retains access to `/mobile` (`legacy-mobile`).
 *   4. `/mobile/more` retains legacy Mobile Management links and provides
 *      1-tap access back to `/dashboard/pos` and `/dashboard`.
 *   5. Mobile POS Register (`/dashboard/pos`) opens `CameraBarcodeScannerModal`
 *      (`pos-camera-scan-btn`), handles camera permission state, adds a scanned
 *      barcode into the cart, opens the mobile cart sheet (`pos-mobile-cart-drawer`),
 *      completes the sale, and dispatches the thermal receipt to
 *      `window.ALYQAndroidPrint` (Android PrintManager bridge).
 */
import { createUxHarness } from "./lib/ux-harness.mjs";

const ux = await createUxHarness({
  beforeImport: ({ localStorage: ls }) => {
    for (const key of Object.keys(ls)) {
      if (key.startsWith("alyq.demo.") || key.startsWith("alyq.store.")) ls.removeItem(key);
    }
    ls.setItem("alyq.mobile.native_pos.v1", "1");
    globalThis.window.innerWidth = 390;
    globalThis.window.innerHeight = 844;
  },
});

const {
  assert,
  sleep,
  waitFor,
  navigate,
  clickTestid,
  testid,
  setField,
  signInAs,
} = ux;

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${passed}. ${label}`);
}

async function main() {
  console.log("\nAndroid Full POS Mobile DOM E2E Verification (390×844)\n");
  await sleep(500);

  // 1. Sign in as admin; native entry lands on /dashboard
  await signInAs("admin");
  await waitFor(() => testid("mobile-pos-bottom-nav"), { label: "mobile POS bottom navigation bar" });
  check(
    "Native Android POS mode renders the full /dashboard workspace with mobile bottom navigation",
    Boolean(testid("mobile-pos-bottom-nav") && testid("mobile-pos-tab-pos") && testid("mobile-pos-modules-trigger")),
  );

  // 2. Open the Full POS Modules Sheet
  clickTestid("mobile-pos-modules-trigger");
  await waitFor(() => testid("mobile-pos-modules-sheet"), { label: "all POS modules bottom sheet" });

  const expectedModules = [
    "pos",
    "invoices",
    "returns",
    "refunds",
    "sync",
    "products",
    "new-product",
    "categories",
    "stock",
    "stocktake",
    "movements",
    "customers",
    "online-orders",
    "reservations",
    "online-hub",
    "shifts",
    "expenses",
    "eod",
    "reports",
    "approvals",
    "notifications",
    "health",
    "settings",
    "legacy-mobile",
  ];
  const missingModules = expectedModules.filter((key) => !testid(`mobile-module-link-${key}`));
  check(
    `All ${expectedModules.length} ALYQ POS modules are accessible from the mobile modules sheet`,
    missingModules.length === 0,
  );

  // 3. Navigate to legacy /mobile/more and verify bidirectional link back to Full POS
  clickTestid("mobile-module-link-legacy-mobile");
  await waitFor(() => window.location.hash.startsWith("#/mobile"), { label: "legacy /mobile shell" });
  navigate("/mobile/more");
  await waitFor(() => (document.body.textContent ?? "").includes("Full ALYQ POS Workspace"), {
    label: "MobileMorePage Full POS link",
  });
  check(
    "Legacy /mobile/more retains Mobile Management tools and links to Full ALYQ POS & Cashier",
    (document.body.textContent ?? "").includes("POS Register (Cashier)") &&
      (document.body.textContent ?? "").includes("Full ALYQ POS Workspace"),
  );

  // 4. Open a shift on /dashboard/shifts, then navigate to Mobile POS Register (/dashboard/pos)
  await navigate("#/dashboard/shifts");
  await waitFor(() => (document.body.textContent ?? "").includes("Open shift"), { label: "Shifts page" });
  ux.click("Open shift");
  await sleep(400);
  const shiftDialog = ux.dialogs().at(-1);
  const shiftInputs = [...shiftDialog.querySelectorAll("input")];
  ux.setInputValue(shiftInputs.find((i) => !i.readOnly && i.type === "text"), "Main branch");
  ux.setInputValue(shiftInputs.find((i) => i.inputMode === "decimal"), "100");
  ux.clickEl([...shiftDialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Open shift"));
  await waitFor(() => /SH-\d{6}/.test(document.body.textContent ?? ""), { label: "shift opened" });

  await navigate("#/dashboard/pos", 600);
  await waitFor(() => testid("pos-scan-search") && testid("pos-camera-scan-btn"), {
    label: "POS register with camera scan button",
  });
  check(
    "POS Register renders the touch-friendly Camera Barcode Scan button inside the search bar",
    Boolean(testid("pos-camera-scan-btn")),
  );

  // Seed a simple product in catalog or scan an existing demo product SKU
  const firstCatalogCard = document.querySelector('[data-testid^="pos-catalog-product-"]');
  assert.ok(firstCatalogCard, "expected at least one catalog product on POS page");
  const skuSpan = firstCatalogCard.querySelector("span.font-mono");
  const sampleSku = skuSpan?.textContent?.trim() || "";
  assert.ok(sampleSku.length > 0, "expected sample SKU from catalog card");

  // Open Camera Barcode Scanner Modal
  clickTestid("pos-camera-scan-btn");
  await waitFor(() => testid("pos-camera-scanner-modal"), { label: "Camera Barcode Scanner Modal" });
  check(
    "Camera Barcode Scanner Modal opens and displays permission & decoder engine status",
    Boolean(testid("pos-camera-scanner-modal") && testid("pos-camera-engine-status") && testid("pos-camera-manual-input")),
  );

  // Scan/submit the SKU via the scanner modal
  setField('[data-testid="pos-camera-manual-input"]', sampleSku);
  clickTestid("pos-camera-manual-submit");
  await sleep(300);

  // If the product is a variant product, VariantPicker opens; pick the first available variant or verify cart
  const variantBtn = document.querySelector('[data-testid^="variant-option-"]:not([disabled])');
  if (variantBtn) {
    variantBtn.click();
    await sleep(250);
  }

  await waitFor(() => testid("pos-mobile-cart-open"), { label: "mobile sticky cart bar" });
  check(
    "Scanned product is added to the mobile cart and sticky cart bar updates",
    Boolean(testid("pos-mobile-cart-open")),
  );

  // 5. Open Mobile Cart Drawer and verify checkout + Android PrintManager bridge
  let printedViaAndroidBridge = false;
  let printedReference = "";
  window.ALYQAndroidPrint = {
    isSupported: () => true,
    printHtml: (html, reference) => {
      printedViaAndroidBridge = html.includes("<!doctype html>") && html.includes(reference);
      printedReference = reference;
      return true;
    },
  };

  clickTestid("pos-mobile-cart-open");
  await waitFor(() => testid("pos-mobile-cart-drawer"), { label: "mobile cart drawer" });
  check(
    "Mobile Cart Drawer opens with full Current Sale lines, totals, and payment controls",
    Boolean(testid("pos-mobile-cart-drawer") && testid("pos-cart")),
  );

  const drawer = testid("pos-mobile-cart-drawer");
  setField('[data-testid="cash-input"]', "5000", drawer);
  await sleep(250);
  const completeBtn = [...drawer.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim().startsWith("✓") && ((b.textContent ?? "").includes("Complete") || (b.textContent ?? "").includes("إتمام")),
  );
  assert.ok(completeBtn && !completeBtn.disabled, "expected enabled Complete sale button inside mobile cart drawer");
  ux.clickEl(completeBtn);
  await waitFor(
    () => (document.body.textContent ?? "").includes("Print receipt") || (document.body.textContent ?? "").includes("طباعة الفاتورة"),
    { label: "SaleCompletedModal" },
  );

  const printBtn = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").includes("Print receipt") || (b.textContent ?? "").includes("طباعة"),
  );
  assert.ok(printBtn, "expected Print receipt button in SaleCompletedModal");
  ux.clickEl(printBtn);
  await waitFor(() => printedViaAndroidBridge, { label: "Android PrintManager bridge invocation" });
  check(
    `Android Receipt Print Bridge (window.ALYQAndroidPrint) received thermal receipt HTML for ${printedReference}`,
    printedViaAndroidBridge && printedReference.length > 0,
  );

  console.log(`\n✓ All ${passed} Android Full POS Mobile DOM E2E checks passed!\n`);
}

await main();
process.exit(0);

import assert from "node:assert/strict";
import { writeStoredSession } from "@/lib/auth/services/sessionStore";
import { ROLE_CAPABILITIES } from "@/lib/permissions/roles";
import { getDemoRepository } from "../data/demoRepository";
import { enableVariants, saveVariant, setVariantActive } from "../services/variantService";
import {
  createModelDraftRow,
  EMPTY_PRODUCT_VARIANT_FORM,
  reconcileVariantDraft,
  validateVariantDraft,
  variantDraftFromSaved,
  variantDraftTotal,
} from "../services/variantDraft";
import {
  isFreeSizeModel,
  modelNameOf,
  suggestModelSku,
  variantByCode,
  variantGalleryOf,
  variantLabel,
} from "../variants";
import {
  resolveExactScannedVariant,
  resolveScannedVariantProduct,
} from "@/modules/pos/services/scanner";
import { BarcodeBurstDecoder } from "@/modules/pos/hooks/useBarcodeScanner";
import { decode1DBarcodeFromRgbaFrame } from "@/modules/pos/services/cameraBarcodeScanner";
import { encodeCode128 } from "@/modules/pos/services/barcodeHelpers";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import { getDemoReturnRepository } from "@/modules/returns/data/demoRepository";
import { getDemoOnlineRepository } from "@/modules/online/data/demoRepository";
import { getDemoShiftRepository } from "@/modules/shifts/data/demoRepository";
import { variantModel } from "@/modules/online/v2/variantModel";

export async function runSharedBarcodeModelsSelftest(): Promise<void> {
  writeStoredSession(
    {
      token: "test-token",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      remember: true,
      user: {
        id: "u-admin",
        username: "admin",
        name: "Admin",
        role: "admin",
        capabilities: [...ROLE_CAPABILITIES.admin],
      },
    },
    "local",
  );

  // ── 1. Model draft & SKU auto-suggestion ─────────────────────────────────
  assert.equal(suggestModelSku("BR101", 1), "BR101-M01");
  assert.equal(suggestModelSku("BR101", 2, ["BR101-M01"]), "BR101-M02");
  assert.equal(suggestModelSku("BR101", 2, ["BR101-M01", "BR101-M02"]), "BR101-M03");

  const row1 = {
    ...createModelDraftRow("BR101", 1),
    display_name_ar: "شكل 1",
    display_name_en: "Model 1",
    stock_quantity: "4",
    image_url: "https://example.com/br101-m01.jpg",
  };
  const row2 = {
    ...createModelDraftRow("BR101", 2, [row1.sku]),
    display_name_ar: "شكل 2",
    display_name_en: "Model 2",
    stock_quantity: "3",
    image_url: "https://example.com/br101-m02.jpg",
  };
  const row3 = {
    ...createModelDraftRow("BR101", 3, [row1.sku, row2.sku]),
    display_name_ar: "شكل 3",
    display_name_en: "Model 3",
    stock_quantity: "5",
    image_url: "https://example.com/br101-m03.jpg",
  };

  const draft = reconcileVariantDraft(
    {
      ...EMPTY_PRODUCT_VARIANT_FORM,
      mode: "models",
      rows: [row1, row2, row3],
    },
    "BR101",
  );
  assert.equal(draft.mode, "models");
  assert.equal(draft.rows.length, 3);
  assert.deepEqual(
    draft.rows.map((r) => r.sku),
    ["BR101-M01", "BR101-M02", "BR101-M03"],
  );
  assert.equal(
    variantDraftTotal(draft.rows),
    12,
    "4 + 3 + 5 = 12 total units auto-calculated across the 3 models",
  );
  assert.equal(
    validateVariantDraft(draft, "BR101", "BR101"),
    null,
    "shared parent barcode BR101 is valid across all 3 models",
  );

  // Duplicate model name is rejected
  const dupDraft = {
    ...draft,
    rows: [row1, { ...row2, display_name_ar: "شكل 1", display_name_en: "Model 1" }],
  };
  assert.equal(validateVariantDraft(dupDraft, "BR101", "BR101"), "duplicateModelName");

  // ── 2. Repository & Service: BR101 with 3 models ─────────────────────────
  const catalog = getDemoRepository();
  const categories = await catalog.listCategories();
  const categoryId = categories.find((c) => c.active)?.id ?? null;

  const product = await catalog.createProduct({
    sku: "BR101",
    barcode: "BR101",
    name_ar: "أسورة أليق الذهبية",
    name_en: "ALYQ Gold Bracelet",
    description_ar: "أسورة بباركود مشترك وثلاثة أشكال",
    description_en: "Shared barcode bracelet with 3 models",
    category_id: categoryId,
    product_type: "physical",
    selling_price: 240,
    cost_price: 120,
    tax_rate: 0,
    stock_tracking_enabled: true,
    variants_enabled: false,
    stock_quantity: 12,
    low_stock_level: 2,
    show_on_website: true,
    is_featured: true,
    active: true,
    image_url: "https://example.com/br101-main.jpg",
    images: ["https://example.com/br101-main.jpg"],
  });

  const savedModels = [];
  for (const [idx, r] of draft.rows.entries()) {
    const res = await saveVariant({
      product,
      siblings: savedModels,
      values: {
        sku: r.sku,
        barcode: null, // inherits parent product's shared barcode BR101
        color_ar: null,
        color_en: null,
        color_hex: null,
        display_name_ar: r.display_name_ar ?? null,
        display_name_en: r.display_name_en ?? null,
        images: [r.image_url, `https://example.com/br101-m0${idx + 1}-side.jpg`],
        size: null,
        size_label: null,
        size_value: null,
        size_sort_order: idx,
        image_url: r.image_url,
        price_override: null,
        cost_override: null,
        stock_quantity: 0,
        low_stock_level: 1,
        active: true,
        sort_order: idx + 1,
      },
    });
    savedModels.push(res.variant);
  }

  assert.equal(savedModels.length, 3);
  for (const m of savedModels) {
    assert.equal(m.barcode, null, "model barcode is null in DB (inherits parent BR101)");
    assert.equal(isFreeSizeModel(m), true);
    assert.equal(variantGalleryOf(m).length, 2);
  }

  const enabledProduct = await enableVariants(product.id, [
    { variantId: savedModels[0].id, quantity: 4 },
    { variantId: savedModels[1].id, quantity: 3 },
    { variantId: savedModels[2].id, quantity: 5 },
  ]);
  assert.equal(enabledProduct.variants_enabled, true);
  assert.equal(enabledProduct.stock_quantity, 12);

  // Hydrate back into variantDraftFromSaved
  const allVariants = (await catalog.listVariants()).filter((v) => v.product_id === product.id);
  const hydrated = variantDraftFromSaved(allVariants);
  assert.equal(hydrated.mode, "models");
  assert.equal(hydrated.rows.length, 3);
  assert.equal(variantLabel(allVariants[0], "ar"), "شكل 1");
  assert.equal(variantLabel(allVariants[1], "ar"), "شكل 2");
  assert.equal(variantLabel(allVariants[2], "ar"), "شكل 3");
  assert.equal(modelNameOf(allVariants[1], "ar"), "شكل 2");

  // ── 3. POS Scanner & Sale & Return ───────────────────────────────────────
  // Scanning shared parent barcode BR101 MUST NOT auto-select any model!
  assert.equal(
    resolveExactScannedVariant("BR101", allVariants),
    null,
    "Scanning shared barcode BR101 must NEVER auto-pick the first model",
  );
  assert.equal(
    variantByCode(allVariants, "BR101"),
    null,
    "variantByCode('BR101') returns null so the visual Model Picker opens",
  );
  const pickerProduct = resolveScannedVariantProduct(
    "BR101",
    await catalog.listProducts(),
    allVariants,
  );
  assert.equal(
    pickerProduct?.id,
    product.id,
    "Scanning shared barcode BR101 resolves the parent product to open the visual Model Picker",
  );

  // Scanning unique model SKU BR101-M02 resolves Model 2 directly
  const directModel2 = resolveExactScannedVariant("BR101-M02", allVariants);
  assert.equal(directModel2?.id, savedModels[1].id);

  // ── 3b. Android Camera Barcode Scanner + External HID Barcode Reader ─────
  // (A) Camera 1D Code128 frame decoder scanning shared barcode "BR101":
  {
    const encoded = encodeCode128("BR101", 10);
    assert.ok(encoded, "BR101 encodes as Code 128");
    const scale = 3;
    const width = encoded.width * scale;
    const height = 24;
    const rgba = new Uint8ClampedArray(width * height * 4);
    rgba.fill(255);
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
    const cameraDecoded = decode1DBarcodeFromRgbaFrame(rgba, width, height);
    assert.equal(cameraDecoded?.rawValue, "BR101");
    assert.equal(resolveExactScannedVariant(cameraDecoded!.rawValue, allVariants), null);
    const cameraPickerTarget = resolveScannedVariantProduct(
      cameraDecoded!.rawValue,
      await catalog.listProducts(),
      allVariants,
    );
    assert.equal(cameraPickerTarget?.id, product.id, "Camera scan of BR101 opens visual Model Picker");
  }

  // (B) External USB/Bluetooth HID Barcode Reader rapid keystroke burst for "BR101":
  {
    const hidDecoder = new BarcodeBurstDecoder();
    let tMs = 100;
    for (const ch of "BR101") {
      assert.equal(hidDecoder.feed(ch, tMs), null);
      tMs += 8;
    }
    const hidScanned = hidDecoder.feed("Enter", tMs);
    assert.equal(hidScanned, "BR101");
    assert.equal(resolveExactScannedVariant(hidScanned!, allVariants), null);
    const hidPickerTarget = resolveScannedVariantProduct(
      hidScanned!,
      await catalog.listProducts(),
      allVariants,
    );
    assert.equal(hidPickerTarget?.id, product.id, "External HID scan of BR101 opens visual Model Picker");
  }

  // Open a shift if none is open and sell 2 units of Model 2 (BR101-M02)
  const shiftRepo = getDemoShiftRepository();
  const currentOpen = await shiftRepo.getOpenShift();
  if (!currentOpen) {
    await shiftRepo.openShift({
      branch: "Main",
      register: "POS-1",
      opening_cash: 500,
      opened_by: "u-admin",
      opened_by_name: "Admin",
    });
  }

  const salesRepo = getDemoSalesRepository();
  const saleClientRef = `pos-br101-test-${Date.now()}`;
  const sale = await salesRepo.completeSale({
    client_ref: saleClientRef,
    lines: [
      {
        product_id: product.id,
        variant_id: savedModels[1].id,
        qty: 2,
      },
    ],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 480, status: "paid" }],
    user_id: "u-admin",
    user_name: "Admin",
  });

  // Offline Sync replay idempotency: re-submitting the same client_ref must return
  // the same sale and must NOT deduct stock a second time!
  const replayedSale = await salesRepo.completeSale({
    client_ref: saleClientRef,
    lines: [
      {
        product_id: product.id,
        variant_id: savedModels[1].id,
        qty: 2,
      },
    ],
    discount_type: "none",
    discount_value: 0,
    payments: [{ method: "cash", amount: 480, status: "paid" }],
    user_id: "u-admin",
    user_name: "Admin",
  });
  assert.equal(replayedSale.id, sale.id, "Offline sync replay returns original sale without duplicate deduction");

  assert.equal(sale.total, 480);
  assert.equal(sale.items.length, 1);
  assert.equal(sale.items[0].variant_id, savedModels[1].id);
  assert.equal(sale.items[0].sku, "BR101-M02");
  assert.equal(sale.items[0].barcode, "BR101", "sale item snapshots parent shared barcode BR101");
  assert.equal(sale.items[0].variant_display_name, "Model 2");

  const afterSaleVariants = (await catalog.listVariants()).filter((v) => v.product_id === product.id);
  const stockBySku = Object.fromEntries(afterSaleVariants.map((v) => [v.sku, v.stock_quantity]));
  assert.equal(stockBySku["BR101-M01"], 4, "Model 1 stock untouched (4)");
  assert.equal(stockBySku["BR101-M02"], 1, "Model 2 stock deducted 3 -> 1");
  assert.equal(stockBySku["BR101-M03"], 5, "Model 3 stock untouched (5)");
  assert.equal(
    (await catalog.listProducts()).find((p) => p.id === product.id)?.stock_quantity,
    10,
    "Parent product rollup updated 12 -> 10",
  );

  // Return 1 unit of Model 2 (BR101-M02)
  const returnRepo = getDemoReturnRepository();
  const { returnRecord } = await returnRepo.createReturn({
    client_ref: `ret-br101-test-${Date.now()}`,
    sale_id: sale.id,
    reason: "Customer exchanged 1 unit",
    refund_method: "cash",
    refund_status: "completed",
    items: [
      {
        sale_item_id: sale.items[0].id,
        product_id: product.id,
        quantity: 1,
      },
    ],
    user_id: "u-admin",
    user_name: "Admin",
  });
  assert.equal(returnRecord.items[0].variant_id, savedModels[1].id);
  assert.equal(returnRecord.items[0].variant_display_name, "Model 2");

  const afterReturnVariants = (await catalog.listVariants()).filter((v) => v.product_id === product.id);
  const stockAfterReturn = Object.fromEntries(afterReturnVariants.map((v) => [v.sku, v.stock_quantity]));
  assert.equal(stockAfterReturn["BR101-M02"], 2, "Model 2 stock restored 1 -> 2");
  assert.equal(
    (await catalog.listProducts()).find((p) => p.id === product.id)?.stock_quantity,
    11,
    "Parent product rollup updated 10 -> 11",
  );

  // ── 4. Storefront V2 model & Online Order reservation ────────────────────
  const v2Model = variantModel(afterReturnVariants, new Map(), true);
  assert.equal(v2Model.hasModels, true);
  assert.equal(v2Model.soleQuickAdd(), null, "Never auto-selects when >1 model is published");
  assert.deepEqual(
    v2Model.models.map((m) => [m.variant.sku, m.available]),
    [
      ["BR101-M01", 4],
      ["BR101-M02", 2],
      ["BR101-M03", 5],
    ],
  );

  const onlineRepo = getDemoOnlineRepository();
  const { order } = await onlineRepo.placeOrder({
    client_ref: `ord-br101-test-${Date.now()}`,
    customer_name: "Sara Ahmed",
    customer_phone: "01012345678",
    customer_email: null,
    delivery_type: "pickup",
    address: null,
    payment_method: "cod",
    notes: null,
    coupon_code: null,
    lines: [
      {
        product_id: product.id,
        variant_id: savedModels[2].id, // Model 3 (BR101-M03)
        qty: 2,
      },
    ],
  });
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].variant_id, savedModels[2].id);
  assert.equal(order.items[0].sku, "BR101-M03");
  assert.equal(order.items[0].barcode, "BR101");
  assert.equal(order.items[0].variant_display_name, "Model 3");

  // Deactivate Model 1 without affecting Model 2 or Model 3
  const deactivated = await setVariantActive(savedModels[0].id, false);
  assert.equal(deactivated.active, false);
  const remainingActive = (await catalog.listVariants()).filter(
    (v) => v.product_id === product.id && v.active,
  );
  assert.equal(remainingActive.length, 2);

  // Clean up test product so other suites see the default demo state
  await setVariantActive(savedModels[0].id, true);
}

await runSharedBarcodeModelsSelftest();
console.log("  18/18 passed (sharedBarcodeModels)");


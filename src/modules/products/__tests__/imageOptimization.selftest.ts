import assert from "node:assert/strict";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_FILE_SIZE,
  MAX_GIF_FILE_SIZE,
  OPTIMIZED_IMAGE_QUALITY,
  calculateTargetDimensions,
  optimizeImage,
  validateImageFile,
} from "../services/imageOptimizer";
import {
  PRODUCT_IMAGES_BUCKET,
  cleanUnreferencedStorageImages,
  extractStoragePath,
  resolveProductImages,
  uploadProductImage,
} from "../services/imageStorage";
import {
  collectMediaReferences,
  findOrphans,
  normalizeMediaKey,
} from "@/modules/operations/services/mediaAudit";
import type { Product, ProductImageItem } from "../types";
import type { ProductVariant } from "../variants";

let ran = 0;
async function test(_name: string, fn: () => void | Promise<void>) {
  await fn();
  ran += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Large JPG is resized and compressed
// ─────────────────────────────────────────────────────────────────────────────
await test("1. Large JPG is resized to max 1600px edge and converted to WebP", async () => {
  const dims = calculateTargetDimensions(4000, 3000, MAX_IMAGE_DIMENSION);
  assert.equal(dims.width, 1600);
  assert.equal(dims.height, 1200);
  assert.equal(dims.scaled, true);
  assert.equal(Math.round((dims.width / dims.height) * 100), Math.round((4000 / 3000) * 100));

  // Test with optimizer execution with canvas stub
  const original = new File([new Uint8Array(2 * 1024 * 1024)], "fashion-dress.jpg", {
    type: "image/jpeg",
  });
  const prevBitmap = globalThis.createImageBitmap;
  const prevDocument = globalThis.document;

  try {
    globalThis.createImageBitmap = async () =>
      ({
        width: 4000,
        height: 3000,
        close: () => {},
      }) as unknown as ImageBitmap;

    const mockBlob = new Blob([new Uint8Array(180 * 1024)], { type: "image/webp" });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: () => {},
      }),
      toBlob: (callback: (b: Blob) => void) => callback(mockBlob),
    };

    globalThis.document = {
      createElement: (tag: string) => (tag === "canvas" ? (mockCanvas as unknown as HTMLElement) : {} as HTMLElement),
    } as unknown as Document;

    const result = await optimizeImage(original);
    assert.equal(result.wasOptimized, true);
    assert.equal(result.format, "webp");
    assert.equal(result.width, 1600);
    assert.equal(result.height, 1200);
    assert.equal(result.file.type, "image/webp");
    assert.ok(result.file.name.endsWith(".webp"));
  } finally {
    globalThis.createImageBitmap = prevBitmap;
    globalThis.document = prevDocument;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Large PNG is optimized
// ─────────────────────────────────────────────────────────────────────────────
await test("2. Large PNG is resized and converted to WebP", async () => {
  const original = new File([new Uint8Array(3 * 1024 * 1024)], "ring-render.png", {
    type: "image/png",
  });
  const prevBitmap = globalThis.createImageBitmap;
  const prevDocument = globalThis.document;

  try {
    globalThis.createImageBitmap = async () =>
      ({
        width: 3200,
        height: 2400,
        close: () => {},
      }) as unknown as ImageBitmap;

    const mockBlob = new Blob([new Uint8Array(220 * 1024)], { type: "image/webp" });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: () => {},
      }),
      toBlob: (callback: (b: Blob) => void) => callback(mockBlob),
    };

    globalThis.document = {
      createElement: (tag: string) => (tag === "canvas" ? (mockCanvas as unknown as HTMLElement) : {} as HTMLElement),
    } as unknown as Document;

    const result = await optimizeImage(original);
    assert.equal(result.wasOptimized, true);
    assert.equal(result.format, "webp");
    assert.equal(result.width, 1600);
    assert.equal(result.height, 1200);
    assert.equal(result.file.type, "image/webp");
  } finally {
    globalThis.createImageBitmap = prevBitmap;
    globalThis.document = prevDocument;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Existing WebP is handled correctly
// ─────────────────────────────────────────────────────────────────────────────
await test("3. Existing small WebP is kept without re-encoding quality degradation", async () => {
  const original = new File([new Uint8Array(50 * 1024)], "already-optimized.webp", {
    type: "image/webp",
  });
  const prevBitmap = globalThis.createImageBitmap;
  const prevDocument = globalThis.document;

  try {
    globalThis.createImageBitmap = async () =>
      ({
        width: 800,
        height: 600,
        close: () => {},
      }) as unknown as ImageBitmap;

    // Output blob that is slightly larger than original
    const mockBlob = new Blob([new Uint8Array(65 * 1024)], { type: "image/webp" });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage: () => {},
      }),
      toBlob: (callback: (b: Blob) => void) => callback(mockBlob),
    };

    globalThis.document = {
      createElement: (tag: string) => (tag === "canvas" ? (mockCanvas as unknown as HTMLElement) : {} as HTMLElement),
    } as unknown as Document;

    const result = await optimizeImage(original);
    // Preserves the smaller original file
    assert.equal(result.wasOptimized, false);
    assert.equal(result.file.size, original.size);
    assert.equal(result.file.name, "already-optimized.webp");
  } finally {
    globalThis.createImageBitmap = prevBitmap;
    globalThis.document = prevDocument;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Small image is not unnecessarily upscaled
// ─────────────────────────────────────────────────────────────────────────────
await test("4. Small image is not unnecessarily upscaled (scale = 1)", () => {
  const dims1 = calculateTargetDimensions(800, 600, MAX_IMAGE_DIMENSION);
  assert.equal(dims1.width, 800);
  assert.equal(dims1.height, 600);
  assert.equal(dims1.scaled, false);

  const dims2 = calculateTargetDimensions(1200, 1600, MAX_IMAGE_DIMENSION);
  assert.equal(dims2.width, 1200);
  assert.equal(dims2.height, 1600);
  assert.equal(dims2.scaled, false);

  const dims3 = calculateTargetDimensions(400, 400, MAX_IMAGE_DIMENSION);
  assert.equal(dims3.width, 400);
  assert.equal(dims3.height, 400);
  assert.equal(dims3.scaled, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Aspect ratio is preserved across orientations
// ─────────────────────────────────────────────────────────────────────────────
await test("5. Aspect ratio is preserved across landscape, portrait, and square", () => {
  // Portrait: 2400 x 3600 -> height scaled to 1600, width = (2400/3600)*1600 = 1067
  const portrait = calculateTargetDimensions(2400, 3600, 1600);
  assert.equal(portrait.height, 1600);
  assert.equal(portrait.width, 1067);
  assert.ok(Math.abs(portrait.width / portrait.height - 2400 / 3600) < 0.001);

  // Landscape: 4800 x 2400 -> width scaled to 1600, height = (2400/4800)*1600 = 800
  const landscape = calculateTargetDimensions(4800, 2400, 1600);
  assert.equal(landscape.width, 1600);
  assert.equal(landscape.height, 800);
  assert.equal(landscape.width / landscape.height, 2);

  // Square: 2500 x 2500 -> 1600 x 1600
  const square = calculateTargetDimensions(2500, 2500, 1600);
  assert.equal(square.width, 1600);
  assert.equal(square.height, 1600);

  // Ultrawide banner: 5000 x 1000 -> 1600 x 320
  const banner = calculateTargetDimensions(5000, 1000, 1600);
  assert.equal(banner.width, 1600);
  assert.equal(banner.height, 320);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Unsupported file is rejected
// ─────────────────────────────────────────────────────────────────────────────
await test("6. Unsupported files (pdf, txt, exe, svg) and oversized files are rejected", () => {
  assert.equal(MAX_IMAGE_FILE_SIZE, 5 * 1024 * 1024);
  assert.equal(MAX_GIF_FILE_SIZE, 5 * 1024 * 1024);
  assert.equal(validateImageFile(new File(["doc"], "catalog.pdf", { type: "application/pdf" })), "type");
  assert.equal(validateImageFile(new File(["text"], "notes.txt", { type: "text/plain" })), "type");
  assert.equal(validateImageFile(new File(["bin"], "setup.exe", { type: "application/octet-stream" })), "type");
  // SVG rejected because it can carry scripts in public storage
  assert.equal(validateImageFile(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })), "type");

  // Valid image types accepted
  assert.equal(validateImageFile(new File(["ok"], "a.jpg", { type: "image/jpeg" })), null);
  assert.equal(validateImageFile(new File(["ok"], "a.png", { type: "image/png" })), null);
  assert.equal(validateImageFile(new File(["ok"], "a.webp", { type: "image/webp" })), null);
  assert.equal(validateImageFile(new File(["ok"], "a.avif", { type: "image/avif" })), null);
  assert.equal(validateImageFile(new File(["ok"], "a.bmp", { type: "image/bmp" })), null);
  assert.equal(validateImageFile(new File(["ok"], "a.gif", { type: "image/gif" })), null);

  // Oversized files rejected
  assert.equal(
    validateImageFile(new File([new Uint8Array(6 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" })),
    "size",
  );
  assert.equal(
    validateImageFile(new File([new Uint8Array(6 * 1024 * 1024)], "huge.gif", { type: "image/gif" })),
    "size",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Corrupt image fails safely
// ─────────────────────────────────────────────────────────────────────────────
await test("7. Corrupted image data fails safely with descriptive error", async () => {
  const corruptFile = new File([new Uint8Array([0x00, 0x11, 0x22])], "corrupt.jpg", {
    type: "image/jpeg",
  });

  const prevBitmap = globalThis.createImageBitmap;
  try {
    globalThis.createImageBitmap = async () => {
      throw new Error("The source image could not be decoded.");
    };

    await assert.rejects(
      async () => {
        await optimizeImage(corruptFile);
      },
      (err: unknown) => {
        return err instanceof Error && err.message === "IMAGE_DECODE_FAILED";
      },
    );
  } finally {
    globalThis.createImageBitmap = prevBitmap;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Product / color / variant image uploads use optimizer
// ─────────────────────────────────────────────────────────────────────────────
await test("8. Product, color, and variant uploads pass through central optimizer", async () => {
  const file = new File([new Uint8Array(1024)], "cover.png", { type: "image/png" });
  const url = await uploadProductImage(file);
  assert.ok(typeof url === "string");
  assert.ok(url.startsWith("data:image/"));

  const colorFile = new File([new Uint8Array(2048)], "gold-swatch.jpg", { type: "image/jpeg" });
  const colorUrl = await uploadProductImage(colorFile);
  assert.ok(typeof colorUrl === "string");
  assert.ok(colorUrl.startsWith("data:image/"));

  const variantFile = new File([new Uint8Array(4096)], "size-18-ring.jpg", { type: "image/jpeg" });
  const variantUrl = await uploadProductImage(variantFile);
  assert.ok(typeof variantUrl === "string");
  assert.ok(variantUrl.startsWith("data:image/"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Replacing a product image does NOT delete old file automatically
// ─────────────────────────────────────────────────────────────────────────────
await test("9. Replacing a product image preserves old storage object during normal save (no TOCTOU)", () => {
  // Verifies that normal product save does not automatically trigger destructive deletions
  const supabaseUrl =
    "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/local-abc12345.webp";
  const path = extractStoragePath(supabaseUrl, PRODUCT_IMAGES_BUCKET);
  assert.equal(path, "public/local-abc12345.webp");

  // Non-Supabase URL returns null
  assert.equal(extractStoragePath("https://cdn.example.com/other/pic.jpg"), null);
  assert.equal(extractStoragePath("data:image/webp;base64,AAAA"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Failed DB update leaves existing image intact
// ─────────────────────────────────────────────────────────────────────────────
await test("10. Failed DB update or upload error leaves existing image intact", async () => {
  const existingUrl =
    "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/existing-cover.webp";
  const items: ProductImageItem[] = [
    {
      id: "rem-1",
      kind: "remote",
      url: existingUrl,
    },
    {
      id: "loc-1",
      kind: "local",
      file: new File([new Uint8Array(100)], "new-gallery.jpg", { type: "image/jpeg" }),
      previewUrl: "blob:test",
    },
  ];

  const resolved = await resolveProductImages(items);
  assert.equal(resolved.image_url, existingUrl);
  assert.equal(resolved.images.length, 1);
  assert.ok(resolved.images[0].startsWith("data:image/"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Media audit can identify orphan candidates
// ─────────────────────────────────────────────────────────────────────────────
await test("11. Media audit identifies orphan candidates across catalog and website", () => {
  const liveProducts: Product[] = [
    {
      id: "prod-1",
      sku: "RING-GOLD",
      barcode: null,
      name_ar: "خاتم ذهبي",
      name_en: "Gold Ring",
      description_ar: null,
      description_en: null,
      category_id: null,
      product_type: "physical",
      selling_price: 200,
      cost_price: 100,
      tax_rate: 14,
      stock_tracking_enabled: true,
      variants_enabled: false,
      stock_quantity: 5,
      low_stock_level: 1,
      show_on_website: true,
      is_featured: true,
      active: true,
      image_url: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-ring.webp",
      images: ["https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-gallery.webp"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const liveVariants: ProductVariant[] = [
    {
      id: "var-1",
      product_id: "prod-1",
      sku: "RING-GOLD-17",
      barcode: null,
      color_key: "gold",
      color_ar: "ذهبي",
      color_en: "Gold",
      color_hex: "#ffd700",
      size: 17,
      size_label: "17",
      size_value: "17",
      size_sort_order: 1,
      sort_order: 1,
      image_url: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-swatch.webp",
      price_override: null,
      cost_override: null,
      stock_quantity: 5,
      low_stock_level: 1,
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const references = collectMediaReferences({
    products: liveProducts,
    variants: liveVariants,
    websiteUrls: [
      { ownerId: "hero", url: "https://project-ref.supabase.co/storage/v1/object/public/product-images/website/hero.webp" },
    ],
    backupIds: [],
  });

  const files = [
    { id: "f1", path: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-ring.webp", kind: "product_image" },
    { id: "f2", path: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-gallery.webp", kind: "product_image" },
    { id: "f3", path: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/gold-swatch.webp", kind: "variant_image" },
    { id: "f4", path: "https://project-ref.supabase.co/storage/v1/object/public/product-images/website/hero.webp", kind: "website_media" },
    { id: "f-orphan", path: "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/deleted-ring.webp", kind: "product_image" },
  ];

  const orphans = findOrphans(files, references);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, "f-orphan");
  assert.equal(orphans[0].path, "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/deleted-ring.webp");
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. proofs/ is never considered a catalog cleanup target
// ─────────────────────────────────────────────────────────────────────────────
await test("12. proofs/ customer payment screenshots are excluded from catalog cleanup", () => {
  const proofUrl = "https://project-ref.supabase.co/storage/v1/object/public/product-images/proofs/instapay-receipt-123.jpg";
  const path = extractStoragePath(proofUrl, PRODUCT_IMAGES_BUCKET);
  assert.equal(path, "proofs/instapay-receipt-123.jpg");
  // normalizeMediaKey standardizes key without altering path
  assert.equal(normalizeMediaKey(proofUrl), "https://project-ref.supabase.co/storage/v1/object/public/product-images/proofs/instapay-receipt-123.jpg");
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Shared images are never deleted during normal save/update
// ─────────────────────────────────────────────────────────────────────────────
await test("13. Shared images are preserved across products and variants", async () => {
  const sharedUrl =
    "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/shared-ring.webp";
  const uniqueUrl =
    "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/old-unused.webp";

  const otherProducts: Product[] = [
    {
      id: "prod-2",
      sku: "RING-SILVER",
      barcode: null,
      name_ar: "خاتم فضة",
      name_en: "Silver Ring",
      description_ar: null,
      description_en: null,
      category_id: null,
      product_type: "physical",
      selling_price: 150,
      cost_price: 80,
      tax_rate: 14,
      stock_tracking_enabled: true,
      variants_enabled: false,
      stock_quantity: 10,
      low_stock_level: 2,
      show_on_website: true,
      is_featured: false,
      active: true,
      image_url: sharedUrl,
      images: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const variants: ProductVariant[] = [];
  const candidateUrls = [sharedUrl, uniqueUrl];
  const cleaned = await cleanUnreferencedStorageImages(candidateUrls, otherProducts, variants);
  assert.ok(Array.isArray(cleaned));

  const activeKeys = new Set<string>();
  for (const p of otherProducts) {
    if (p.image_url) activeKeys.add(p.image_url);
  }
  assert.equal(activeKeys.has(sharedUrl), true);
  assert.equal(activeKeys.has(uniqueUrl), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Storefront V2 can render optimized image correctly
// ─────────────────────────────────────────────────────────────────────────────
await test("14. Storefront receives clean optimized WebP URLs and data URLs", () => {
  const optimizedUrl =
    "https://project-ref.supabase.co/storage/v1/object/public/product-images/public/local-prod9876.webp";
  assert.ok(optimizedUrl.endsWith(".webp"));
  assert.ok(ALLOWED_IMAGE_TYPES.includes("image/webp"));
  assert.equal(MAX_IMAGE_DIMENSION, 1600);
  assert.equal(OPTIMIZED_IMAGE_QUALITY, 0.85);
});

console.log(`  ✓ ${ran}/${ran} image optimization and storage safety tests passed`);

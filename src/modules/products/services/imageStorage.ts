import { getSupabaseClient } from "@/lib/supabase/client";
import type { Product, ProductImageItem } from "../types";
import type { ProductVariant } from "../variants";
import { MAX_IMAGES } from "../constants";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_FILE_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_GIF_FILE_SIZE,
  OPTIMIZED_IMAGE_QUALITY,
  calculateTargetDimensions,
  optimizeImage,
  validateImageFile,
  type AllowedImageMimeType,
  type ImageFileError,
  type OptimizeImageOptions,
  type OptimizedImageResult,
} from "./imageOptimizer";

export {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_FILE_SIZE,
  MAX_IMAGE_DIMENSION,
  MAX_GIF_FILE_SIZE,
  OPTIMIZED_IMAGE_QUALITY,
  calculateTargetDimensions,
  optimizeImage,
  validateImageFile,
  type AllowedImageMimeType,
  type ImageFileError,
  type OptimizeImageOptions,
  type OptimizedImageResult,
};

/**
 * Product image upload / resolution layer.
 *
 * - Supabase mode  → optimizes files client-side (WebP / 1600px edge), uploads
 *   to `product-images` storage bucket, and returns public URLs.
 * - Demo mode      → optimizes files and encodes them as data URLs in-memory so
 *   the entire upload UX works end-to-end without any backend.
 *
 * The admin never pastes raw URLs — files are picked and optimized directly.
 */

export const PRODUCT_IMAGES_BUCKET = "product-images";

/** File extension derived from a MIME type — used for storage paths. */
function extensionForMime(type: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
  };
  return map[type] ?? "bin";
}

/** Read a File as a data URL (demo mode / preview). */
export async function fileToDataUrl(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
      reader.readAsDataURL(file);
    });
  }
  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:${file.type || "application/octet-stream"};base64,${base64}`;
}

/** Create a locally-previewable image item from a File (object URL preview). */
export function createLocalImageItem(file: File): ProductImageItem {
  return {
    id: newLocalId(),
    kind: "local",
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

function newLocalId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `local-${rand}`;
}

/**
 * Optimize and upload one image file, returning its public URL.
 * Automatically compresses large images to high-quality WebP <= 1600px edge.
 */
export async function uploadProductImage(file: File): Promise<string> {
  const invalid = validateImageFile(file);
  if (invalid === "type") throw new Error("IMAGE_TYPE_NOT_ALLOWED");
  if (invalid === "size") throw new Error("IMAGE_TOO_LARGE");

  // Optimize image client-side before transmission
  const { file: uploadFile } = await optimizeImage(file);

  const client = getSupabaseClient();

  // Demo mode — no backend: store the optimized image inline as a data URL.
  if (!client) {
    return fileToDataUrl(uploadFile);
  }

  const ext = extensionForMime(uploadFile.type);
  // Unique, predictable-but-unguessable path; the filename itself is never trusted.
  const path = `public/${newLocalId()}.${ext}`;

  const { error } = await client.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, uploadFile, {
      contentType: uploadFile.type,
      cacheControl: "3600",
      upsert: false,
    });

  if (error) {
    throw new Error(`UPLOAD_FAILED: ${error.message}`);
  }

  const { data } = client.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Turn the ordered image items into the final persisted shape:
 * `{ image_url, images }` where index 0 is the cover and the rest the gallery.
 * `remote` items pass straight through; `local` items are optimized and uploaded.
 */
export async function resolveProductImages(
  items: ProductImageItem[],
): Promise<{ image_url: string | null; images: string[] }> {
  const ordered = await Promise.all(
    items.slice(0, MAX_IMAGES).map(async (item) =>
      item.kind === "remote" ? item.url : await uploadProductImage(item.file),
    ),
  );
  return {
    image_url: ordered[0] ?? null,
    images: ordered.slice(1),
  };
}

/** Revoke the object-URL previews of every local item (memory hygiene). */
export function revokeLocalPreviews(items: ProductImageItem[]): void {
  for (const item of items) {
    if (item.kind === "local" && item.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

/** Extract storage relative path from a full public Supabase URL. */
export function extractStoragePath(url: string, bucket = PRODUCT_IMAGES_BUCKET): string | null {
  if (!url || typeof url !== "string") return null;
  const marker = `/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length).split("?")[0].split("#")[0];
  return path || null;
}

/**
 * Normalizes a media key for comparison against referenced URLs.
 */
function normalizeUrlKey(raw: string | null | undefined): string {
  const val = (raw ?? "").trim();
  if (!val) return "";
  try {
    if (val.startsWith("http://") || val.startsWith("https://")) {
      const parsed = new URL(val);
      return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
    }
  } catch {
    /* fallback to plain path */
  }
  return val.split("?")[0].split("#")[0].replace(/\/+$/, "");
}

/**
 * Safely cleans up storage objects that are no longer referenced by any active
 * product, variant, or store content.
 * Never deletes an image if it is still referenced anywhere in the catalog.
 */
export async function cleanUnreferencedStorageImages(
  candidateUrls: string[],
  activeProducts: Product[],
  activeVariants?: ProductVariant[],
): Promise<string[]> {
  const client = getSupabaseClient();
  if (!client || candidateUrls.length === 0) return [];

  // 1. Build an index of all actively referenced image URLs
  const activeKeys = new Set<string>();
  for (const product of activeProducts) {
    if (product.image_url) activeKeys.add(normalizeUrlKey(product.image_url));
    if (Array.isArray(product.images)) {
      for (const img of product.images) {
        if (img) activeKeys.add(normalizeUrlKey(img));
      }
    }
  }

  if (activeVariants) {
    for (const variant of activeVariants) {
      if (variant.image_url) activeKeys.add(normalizeUrlKey(variant.image_url));
    }
  }

  // 2. Identify storage paths that are truly unreferenced
  const pathsToDelete: string[] = [];
  for (const url of candidateUrls) {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) continue;
    const key = normalizeUrlKey(url);
    if (!activeKeys.has(key)) {
      const storagePath = extractStoragePath(url, PRODUCT_IMAGES_BUCKET);
      if (storagePath) pathsToDelete.push(storagePath);
    }
  }

  // 3. Delete unreferenced objects from Supabase Storage
  if (pathsToDelete.length > 0) {
    try {
      const { error } = await client.storage.from(PRODUCT_IMAGES_BUCKET).remove(pathsToDelete);
      if (error) {
        console.warn("[storage] Image cleanup warning:", error.message);
      }
    } catch (err) {
      console.warn("[storage] Error removing unreferenced images:", err);
    }
  }

  return pathsToDelete;
}

import { getSupabaseClient } from "@/lib/supabase/client";
import type { ProductImageItem } from "../types";
import { MAX_IMAGES } from "../constants";

/**
 * Product image upload / resolution layer.
 *
 * - Supabase mode  → uploads files to the `product-images` storage bucket and
 *   returns public URLs.
 * - Demo mode      → encodes files as data URLs (kept in the browser only) so
 *   the upload UX works end-to-end without any backend.
 *
 * The admin never pastes URLs — files come straight from the device.
 */

export const PRODUCT_IMAGES_BUCKET = "product-images";

/** 5 MB per image — generous for storefront photos, blocks accidental video/PDF. */
export const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Whitelist of accepted image MIME types (rejects arbitrary non-image files).
 * SVG is deliberately absent: it is a script-carrying format, and these files
 * land in a PUBLIC bucket — an uploaded SVG would run embedded scripts from
 * the project's storage domain when opened directly. The bucket's server-side
 * `allowed_mime_types` (migration 0036) carries the same list minus SVG, so a
 * caller that skips this validation is still refused by Storage itself.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
] as const;

export type ImageFileError = "type" | "size" | null;

/** Validate a single file's MIME type and size. Pure + testable. */
export function validateImageFile(file: File): ImageFileError {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    return "type";
  }
  if (file.size > MAX_IMAGE_FILE_SIZE) return "size";
  return null;
}

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

/** Read a File as a data URL (demo mode). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.readAsDataURL(file);
  });
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

/** Upload one file and return its public URL. */
export async function uploadProductImage(file: File): Promise<string> {
  const client = getSupabaseClient();

  // Demo mode — no backend: store the image inline as a data URL.
  if (!client) {
    return fileToDataUrl(file);
  }

  const ext = extensionForMime(file.type);
  // Unique, predictable-but-unguessable path; the filename itself is never trusted.
  const path = `public/${newLocalId()}.${ext}`;

  const { error } = await client.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: "3600", upsert: false });

  if (error) {
    throw new Error(`UPLOAD_FAILED: ${error.message}`);
  }

  const { data } = client.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Turn the ordered image items into the final persisted shape:
 * `{ image_url, images }` where index 0 is the cover and the rest the gallery.
 * `remote` items pass straight through; `local` items are uploaded first.
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

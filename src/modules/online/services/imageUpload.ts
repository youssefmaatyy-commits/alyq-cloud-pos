/**
 * Image uploads for the storefront.
 *
 * Reuses the product-image mechanism rather than inventing a second one: the
 * same validation (MIME whitelist, 5 MB cap), the same bucket, the same
 * demo-mode fallback to a data URL. Two things differ:
 *
 *   - the storage *prefix*. `website/` for branding and hero imagery, `proofs/`
 *     for the InstaPay screenshots customers upload. Keeping them apart means an
 *     admin can see what is what, and a cleanup script can treat customer
 *     uploads (which are financial evidence) differently from shop artwork.
 *   - proofs are uploaded by anonymous customers, which the existing bucket
 *     policy already permits; nothing about that is loosened here.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  PRODUCT_IMAGES_BUCKET,
  fileToDataUrl,
  validateImageFile,
  type ImageFileError,
} from "@/modules/products/services/imageStorage";

export const STORE_IMAGE_PREFIXES = ["website", "proofs"] as const;
export type StoreImagePrefix = (typeof STORE_IMAGE_PREFIXES)[number];

/** Re-exported so storefront forms validate with the catalogue's own rules. */
export { validateImageFile, type ImageFileError };

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extensionForMime(type: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[type] ?? "bin";
}

/**
 * Upload one storefront image and return a URL that can be stored.
 *
 * Throws with a message the caller can map to a field error; demo mode returns a
 * data URL, so the builder previews exactly what live mode will show.
 */
export async function uploadStoreImage(
  file: File,
  prefix: StoreImagePrefix = "website",
): Promise<string> {
  const invalid: ImageFileError = validateImageFile(file);
  if (invalid === "type") throw new Error("IMAGE_TYPE_NOT_ALLOWED");
  if (invalid === "size") throw new Error("IMAGE_TOO_LARGE");

  const client = getSupabaseClient();
  if (!client) return fileToDataUrl(file);

  const path = `${prefix}/${newId()}.${extensionForMime(file.type)}`;
  const { error } = await client.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, file, { contentType: file.type, cacheControl: "3600", upsert: false });
  if (error) throw new Error(`UPLOAD_FAILED: ${error.message}`);

  return client.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * A customer's payment proof, sized down before upload.
 *
 * Phone screenshots are routinely 4–8 MB, and a shop on a metered connection
 * should not pay that for a receipt nobody prints. Downscaling to a 1280px edge
 * keeps the reference number legible — which is the only thing an employee needs
 * to read — and cuts the payload by an order of magnitude.
 */
export async function prepareProofImage(file: File, maxEdge = 1280): Promise<File> {
  if (typeof document === "undefined" || !file.type.startsWith("image/")) return file;
  if (file.size <= 400_000) return file; // Already small: do not touch it.

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) {
      bitmap.close?.();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close?.();
      return file;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    // A browser that cannot decode the image still gets the original uploaded:
    // losing the proof would be worse than losing the compression.
    return file;
  }
}

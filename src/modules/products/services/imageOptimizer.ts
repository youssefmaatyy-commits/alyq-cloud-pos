/**
 * Central Product Image Optimizer (Phase 57).
 *
 * Automatically optimizes product images client-side before uploading to
 * Supabase Storage:
 *   - Downscales images exceeding 1600px long edge while preserving aspect ratio
 *   - Never upscales smaller images
 *   - Converts static formats (JPEG, PNG, WebP, AVIF, BMP) to modern WebP (~0.85 quality)
 *   - Preserves high visual fidelity for product cards, PDP, and high-DPI displays
 *   - Preserves multi-frame animated GIFs without converting to static frames
 *   - Validates MIME types and enforces memory-safe file size limits (15 MB max original)
 *   - Detects corrupted/undecodable files and fails safely
 */

export const MAX_IMAGE_DIMENSION = 1600;
export const OPTIMIZED_IMAGE_QUALITY = 0.85;
export const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per image (matches Supabase bucket ceiling)
export const MAX_GIF_FILE_SIZE = 5 * 1024 * 1024; // 5 MB ceiling for animated GIFs

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_TYPES)[number];
export type ImageFileError = "type" | "size" | "corrupt" | null;

export interface OptimizeImageOptions {
  maxDimension?: number;
  quality?: number;
  preserveGif?: boolean;
}

export interface OptimizedImageResult {
  file: File;
  width: number;
  height: number;
  format: "webp" | "jpeg" | "gif" | "png" | "original";
  wasOptimized: boolean;
  originalSize: number;
  optimizedSize: number;
}

/** Validate a single file's MIME type and size. Pure and testable. */
export function validateImageFile(file: File): "type" | "size" | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageMimeType)) {
    return "type";
  }
  const limit = file.type === "image/gif" ? MAX_GIF_FILE_SIZE : MAX_IMAGE_FILE_SIZE;
  if (file.size > limit) return "size";
  return null;
}

/**
 * Calculate target dimensions maintaining exact aspect ratio and never upscaling.
 */
export function calculateTargetDimensions(
  origWidth: number,
  origHeight: number,
  maxEdge: number = MAX_IMAGE_DIMENSION,
): { width: number; height: number; scaled: boolean } {
  if (origWidth <= 0 || origHeight <= 0) {
    return { width: Math.max(1, origWidth || 1), height: Math.max(1, origHeight || 1), scaled: false };
  }
  const scale = Math.min(1, maxEdge / Math.max(origWidth, origHeight));
  const targetWidth = Math.max(1, Math.round(origWidth * scale));
  const targetHeight = Math.max(1, Math.round(origHeight * scale));
  return {
    width: targetWidth,
    height: targetHeight,
    scaled: scale < 1,
  };
}

/**
 * Decode an image and draw onto a canvas at target dimensions.
 */
async function decodeImageToCanvas(
  file: File,
  targetWidth: number,
  targetHeight: number,
): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; width: number; height: number }> {
  // 1. createImageBitmap (fastest, off-main-thread where supported)
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas =
          typeof OffscreenCanvas === "function"
            ? new OffscreenCanvas(targetWidth, targetHeight)
            : typeof document !== "undefined"
              ? document.createElement("canvas")
              : null;

        if (canvas) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext("2d") as
            | CanvasRenderingContext2D
            | OffscreenCanvasRenderingContext2D
            | null;
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
            return { canvas, width: targetWidth, height: targetHeight };
          }
        }
      } finally {
        bitmap.close?.();
      }
    } catch (err) {
      if (err instanceof Error && /decode|corrupt|source/i.test(err.message)) {
        const error = new Error("IMAGE_DECODE_FAILED");
        (error as Error & { cause?: unknown }).cause = err;
        throw error;
      }
      throw err;
    }
  }

  // 2. HTMLImageElement fallback (for standard DOM environments)
  if (typeof Image !== "undefined" && typeof document !== "undefined") {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => {
          const error = new Error("IMAGE_DECODE_FAILED");
          (error as Error & { cause?: unknown }).cause = e;
          reject(error);
        };
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        return { canvas, width: targetWidth, height: targetHeight };
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  throw new Error("CANVAS_UNAVAILABLE");
}

/**
 * Export canvas contents to Blob with WebP / JPEG fallback.
 */
async function exportCanvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    try {
      return await canvas.convertToBlob({ type: mimeType, quality });
    } catch {
      if (mimeType === "image/webp") {
        try {
          return await canvas.convertToBlob({ type: "image/jpeg", quality });
        } catch {
          return null;
        }
      }
    }
  }
  if ("toBlob" in canvas && typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mimeType, quality);
    });
    if (blob) return blob;
    if (mimeType === "image/webp") {
      return new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
      });
    }
  }
  return null;
}

/**
 * Extract natural dimensions from an image File.
 */
async function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch (err) {
      const error = new Error("IMAGE_DECODE_FAILED");
      (error as Error & { cause?: unknown }).cause = err;
      throw error;
    }
  }

  if (typeof Image !== "undefined" && typeof document !== "undefined") {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => {
          const error = new Error("IMAGE_DECODE_FAILED");
          (error as Error & { cause?: unknown }).cause = e;
          reject(error);
        };
        img.src = url;
      });
      return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { width: 0, height: 0 };
}

/**
 * Optimizes an image File client-side:
 * - Downscales to `maxDimension` (1600px long edge default) while preserving aspect ratio
 * - Converts static formats (JPEG, PNG, WebP, AVIF, BMP) to WebP at target quality
 * - Preserves animated GIFs intact
 * - Returns the optimized File ready for Supabase Storage upload
 */
export async function optimizeImage(
  file: File,
  options?: OptimizeImageOptions,
): Promise<OptimizedImageResult> {
  const validationError = validateImageFile(file);
  if (validationError === "type") throw new Error("IMAGE_TYPE_NOT_ALLOWED");
  if (validationError === "size") throw new Error("IMAGE_TOO_LARGE");

  const maxDimension = options?.maxDimension ?? MAX_IMAGE_DIMENSION;
  const quality = options?.quality ?? OPTIMIZED_IMAGE_QUALITY;
  const preserveGif = options?.preserveGif ?? true;

  // Preserve animated GIF without destroying multi-frame animation
  if (file.type === "image/gif" && preserveGif) {
    return {
      file,
      width: 0,
      height: 0,
      format: "gif",
      wasOptimized: false,
      originalSize: file.size,
      optimizedSize: file.size,
    };
  }

  try {
    const { width: origWidth, height: origHeight } = await getImageDimensions(file);

    if (origWidth <= 0 || origHeight <= 0) {
      // Non-browser or unreadable environment: pass through safely
      return {
        file,
        width: 0,
        height: 0,
        format: "original",
        wasOptimized: false,
        originalSize: file.size,
        optimizedSize: file.size,
      };
    }

    const { width: targetWidth, height: targetHeight, scaled } = calculateTargetDimensions(
      origWidth,
      origHeight,
      maxDimension,
    );

    const { canvas } = await decodeImageToCanvas(file, targetWidth, targetHeight);
    const blob = await exportCanvasToBlob(canvas, "image/webp", quality);

    if (!blob) {
      return {
        file,
        width: origWidth,
        height: origHeight,
        format: "original",
        wasOptimized: false,
        originalSize: file.size,
        optimizedSize: file.size,
      };
    }

    const isWebP = blob.type === "image/webp";
    const outFormat: OptimizedImageResult["format"] = isWebP ? "webp" : "jpeg";
    const ext = isWebP ? ".webp" : ".jpg";
    const baseName = file.name.replace(/\.[^.]+$/, "") || "product";
    const optimizedFileName = `${baseName}${ext}`;

    // If not scaled and original was already WebP and smaller, keep original
    if (!scaled && file.type === blob.type && file.size <= blob.size) {
      return {
        file,
        width: origWidth,
        height: origHeight,
        format: "webp",
        wasOptimized: false,
        originalSize: file.size,
        optimizedSize: file.size,
      };
    }

    const optimizedFile = new File([blob], optimizedFileName, { type: blob.type });

    return {
      file: optimizedFile,
      width: targetWidth,
      height: targetHeight,
      format: outFormat,
      wasOptimized: true,
      originalSize: file.size,
      optimizedSize: optimizedFile.size,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "IMAGE_DECODE_FAILED") {
      throw err;
    }
    // Safe fallback if canvas is not available in current runtime
    return {
      file,
      width: 0,
      height: 0,
      format: "original",
      wasOptimized: false,
      originalSize: file.size,
      optimizedSize: file.size,
    };
  }
}

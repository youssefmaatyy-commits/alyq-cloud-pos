/**
 * Media audit (Phase 56).
 *
 * A file is an orphan only when it is registered here and absent from every
 * reference location this app knows: product images, variant images, website
 * media, and backup identifiers. Missing from one table is not enough.
 */
import type { MediaReference, RegisteredFile, RegisteredFileKind } from "../types";

export function normalizeMediaKey(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    }
  } catch {
    /* keep the raw path */
  }
  return raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
}

export function mediaKeysMatch(filePath: string, reference: string): boolean {
  const file = normalizeMediaKey(filePath);
  const ref = normalizeMediaKey(reference);
  if (!file || !ref) return false;
  if (file === ref) return true;
  return file.endsWith(`/${ref}`) || ref.endsWith(`/${file}`);
}

export function collectMediaReferences(input: {
  products: readonly { id: string; image_url: string | null; images: readonly string[] }[];
  variants: readonly { id: string; image_url: string | null }[];
  websiteUrls: readonly { ownerId: string; url: string | null | undefined }[];
  backupIds: readonly { id: string }[];
}): MediaReference[] {
  const refs: MediaReference[] = [];
  const remember = (location: MediaReference["location"], ownerId: string, url: string | null | undefined) => {
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;
    refs.push({ location, ownerId, url });
  };
  for (const product of input.products) {
    remember("product", product.id, product.image_url);
    for (const image of product.images) remember("product", product.id, image);
  }
  for (const variant of input.variants) remember("variant", variant.id, variant.image_url);
  for (const entry of input.websiteUrls) remember("website", entry.ownerId, entry.url);
  for (const backup of input.backupIds) {
    refs.push({ location: "backup", ownerId: backup.id, url: backup.id });
  }
  return refs;
}

/** Walk a settings document for media URLs. Skips secret-looking keys. */
export function collectUrlsFromDocument(value: unknown, ownerId: string, into: { ownerId: string; url: string }[] = [], depth = 0): { ownerId: string; url: string }[] {
  if (depth > 8 || value == null) return into;
  if (typeof value === "string") {
    if (looksLikeMedia(value)) into.push({ ownerId, url: value });
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlsFromDocument(item, ownerId, into, depth + 1);
    return into;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (lowered.includes("password") || lowered.includes("token") || lowered.includes("secret") || lowered.includes("service_role")) {
        continue;
      }
      collectUrlsFromDocument(child, ownerId, into, depth + 1);
    }
  }
  return into;
}

function looksLikeMedia(value: string): boolean {
  if (value.startsWith("data:") || value.startsWith("blob:")) return false;
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("/brand/") ||
    value.includes("product-images/") ||
    value.startsWith("website/")
  );
}

/**
 * Remember media this app has already seen, so a later removal can be offered
 * as an orphan. Data URLs are not files. Backup ids are not registered here.
 * Already-known paths are left alone, including their original timestamp.
 */
export function mergeSeenReferences(
  files: readonly RegisteredFile[],
  references: readonly MediaReference[],
  nowIso: string,
): RegisteredFile[] {
  const next = [...files];
  for (const reference of references) {
    if (reference.location === "backup") continue;
    const key = normalizeMediaKey(reference.url);
    if (!key || key.startsWith("data:") || key.startsWith("blob:")) continue;
    if (next.some((file) => mediaKeysMatch(file.path, reference.url))) continue;
    const kind: RegisteredFileKind =
      reference.location === "product"
        ? "product_image"
        : reference.location === "variant"
          ? "variant_image"
          : "website_media";
    next.push({
      id: `seen:${kind}:${stableMediaId(key)}`,
      path: reference.url,
      bytes: null,
      kind,
      createdAt: nowIso,
    });
  }
  return next;
}

function stableMediaId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function isReferenced(file: { path: string; id: string; kind: string }, references: readonly MediaReference[]): boolean {
  return references.some((reference) => {
    if (file.kind === "backup_artifact") return reference.location === "backup" && (reference.ownerId === file.id || mediaKeysMatch(file.path, reference.url));
    return mediaKeysMatch(file.path, reference.url);
  });
}

/** Orphan = registered and unreferenced in every known location. */
export function findOrphans<T extends { path: string; id: string; kind: string }>(files: readonly T[], references: readonly MediaReference[]): T[] {
  return files.filter((file) => !isReferenced(file, references));
}

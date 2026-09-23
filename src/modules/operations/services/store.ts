/**
 * Browser-side operations state. Not a second database.
 *
 * Read marks and the media registry live here because neither is a business
 * record. Cleanup writes only this registry, after the pure plan re-checks.
 */
import type { RegisteredFile } from "../types";

const MEDIA_KEY = "alyq.operations.media.v1";
const READ_KEY = "alyq.operations.notifications.read.v1";
const THRESHOLD_KEY = "alyq.operations.thresholds.v1";

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadMediaRegistry(): RegisteredFile[] {
  const parsed = readJson<unknown>(MEDIA_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is RegisteredFile => {
    if (!row || typeof row !== "object") return false;
    const file = row as Partial<RegisteredFile>;
    return typeof file.id === "string" && typeof file.path === "string" && typeof file.kind === "string";
  });
}

export function saveMediaRegistry(files: readonly RegisteredFile[]): void {
  writeJson(MEDIA_KEY, files);
}

export function loadReadIds(): string[] {
  const parsed = readJson<unknown>(READ_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

export function saveReadIds(ids: readonly string[]): void {
  writeJson(READ_KEY, ids);
}

export function loadStorageWarningBytes(): number | null {
  const parsed = readJson<{ storageWarningBytes?: unknown }>(THRESHOLD_KEY, {});
  const value = parsed.storageWarningBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function saveStorageWarningBytes(bytes: number | null): void {
  writeJson(THRESHOLD_KEY, { storageWarningBytes: bytes });
}

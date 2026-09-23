/**
 * Usage figures this screen is allowed to show.
 *
 * Record counts come from the repositories the page already loaded. Database
 * size and platform quota are not queried with the signed-in client — those
 * stay unavailable rather than estimated.
 */
export interface UsageCounts {
  products: number;
  variants: number;
  customers: number;
  sales: number;
  onlineOrders: number;
  returns: number;
  referencedImages: number;
  backupFiles: number | null;
  orphanFiles: number;
  registeredBytes: number | null;
}

export interface UsageReport {
  counts: UsageCounts;
  /** Always null with the current client. Do not fill this in. */
  databaseBytes: null;
  databaseNote: "Not available from current application credentials";
  storageNote: "Registered-file bytes only. Platform quota is not available from current application credentials.";
}

export function buildUsageReport(counts: UsageCounts): UsageReport {
  return {
    counts,
    databaseBytes: null,
    databaseNote: "Not available from current application credentials",
    storageNote: "Registered-file bytes only. Platform quota is not available from current application credentials.",
  };
}

export function sumRegisteredBytes(files: readonly { bytes: number | null }[]): number | null {
  let total = 0;
  let any = false;
  for (const file of files) {
    if (file.bytes === null || !Number.isFinite(file.bytes)) continue;
    any = true;
    total += file.bytes;
  }
  return any ? total : null;
}

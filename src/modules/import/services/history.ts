/**
 * Import Batch History Service.
 *
 * Provides batch audit tracking and idempotency retrieval.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import type { ImportBatchRecord } from "../types";

export async function fetchImportHistory(limit = 20): Promise<ImportBatchRecord[]> {
  try {
    const client = getSupabaseClient();
    if (!client) return [];

    const { data, error } = await client
      .from("import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data as ImportBatchRecord[];
  } catch {
    return [];
  }
}

export async function checkBatchIdempotency(batchId: string): Promise<ImportBatchRecord | null> {
  try {
    const client = getSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
      .from("import_batches")
      .select("*")
      .eq("batch_id", batchId)
      .maybeSingle();

    if (error || !data) return null;
    return data as ImportBatchRecord;
  } catch {
    return null;
  }
}

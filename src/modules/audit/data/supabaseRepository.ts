import { getSupabaseClient } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { AuditLogEntry, NewAuditLogEntry } from "../types";
import type { AuditRepository } from "./repository";

interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entity_id: string;
  entity_label: string;
  details: Record<string, string | number | boolean | null> | null;
  user_id: string;
  user_name: string;
  created_at: string;
}

function mapEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    action: row.action as AuditLogEntry["action"],
    entity: row.entity as AuditLogEntry["entity"],
    entity_id: row.entity_id,
    entity_label: row.entity_label,
    details: row.details ?? {},
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
  };
}

export class SupabaseAuditRepository implements AuditRepository {
  readonly kind = "supabase" as const;

  private require() {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  async listEntries(): Promise<AuditLogEntry[]> {
    try {
      const { data, error } = await this.require()
        .from("audit_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw toAppError(error);
      return ((data as AuditRow[]) ?? []).map(mapEntry);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }

  async append(input: NewAuditLogEntry): Promise<AuditLogEntry> {
    try {
      const { data, error } = await this.require()
        .from("audit_log")
        .insert({
          action: input.action,
          entity: input.entity,
          entity_id: input.entity_id,
          entity_label: input.entity_label,
          details: input.details ?? {},
          user_id: input.user_id,
          user_name: input.user_name,
        })
        .select("*")
        .single();
      if (error) throw toAppError(error);
      return mapEntry(data as AuditRow);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw toAppError(err);
    }
  }
}

let singleton: SupabaseAuditRepository | null = null;
export function getSupabaseAuditRepository(): SupabaseAuditRepository {
  if (!singleton) singleton = new SupabaseAuditRepository();
  return singleton;
}

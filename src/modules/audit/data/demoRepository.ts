import { safeStorage } from "@/modules/products/data/demoSeed";
import type { AuditLogEntry, NewAuditLogEntry } from "../types";
import type { AuditRepository } from "./repository";

const AUDIT_KEY = "alyq.demo.audit_log.v1";
const MAX_ENTRIES = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `aud-${rand}`;
}

function load(): AuditLogEntry[] {
  const raw = safeStorage.get(AUDIT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AuditLogEntry[]) : [];
  } catch {
    return [];
  }
}

function persist(entries: AuditLogEntry[]): void {
  safeStorage.set(AUDIT_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

/**
 * Demo (browser-persisted) audit log. Newest first; capped so it can never
 * fill the localStorage quota.
 */
export class DemoAuditRepository implements AuditRepository {
  readonly kind = "demo" as const;
  private entries: AuditLogEntry[];

  constructor() {
    this.entries = load();
  }

  async listEntries(): Promise<AuditLogEntry[]> {
    return [...this.entries].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async append(input: NewAuditLogEntry): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      id: newId(),
      action: input.action,
      entity: input.entity,
      entity_id: input.entity_id,
      entity_label: input.entity_label,
      details: input.details ?? {},
      user_id: input.user_id,
      user_name: input.user_name,
      created_at: nowIso(),
    };
    this.entries = [entry, ...this.entries];
    persist(this.entries);
    return entry;
  }
}

let singleton: DemoAuditRepository | null = null;
export function getDemoAuditRepository(): DemoAuditRepository {
  if (!singleton) singleton = new DemoAuditRepository();
  return singleton;
}

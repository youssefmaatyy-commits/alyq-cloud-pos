export interface RegisterRecord {
  id: string;
  code: string;
  name: string;
  branch_id: string;
  branch_name: string | null;
  active: boolean;
  installation_id: string;
  last_seen_at: string | null;
  app_version: string | null;
  platform: string | null;
  hardware_metadata: Record<string, unknown>;
  pending_offline_count: number;
  unresolved_conflict_count: number;
  created_at: string;
  updated_at: string;
}

export interface RegisterSaleEvidence {
  register_id: string;
  installation_id: string;
  /** Local display snapshot only; the server stamps its authoritative name. */
  register_name: string;
}

export interface RegisterCredential extends RegisterSaleEvidence {
  credential: string;
  register: RegisterRecord;
}

export type RegisterManageAction = "rename" | "activate" | "deactivate" | "reassign";

export type RegisterContextState =
  | { kind: "web"; register: null; reason: null }
  | { kind: "desktop-unregistered"; register: null; reason: string }
  | { kind: "desktop-ready"; register: RegisterRecord; reason: null }
  | { kind: "desktop-invalid"; register: RegisterRecord | null; reason: string };

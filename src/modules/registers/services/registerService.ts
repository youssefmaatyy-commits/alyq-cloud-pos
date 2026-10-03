import { getDesktopConfig, getDesktopContext, isDesktopRuntime, saveDesktopRegisterBinding } from "@/lib/desktop/bridge";
import type { DesktopRegisterBinding } from "@/lib/desktop/types";
import { assertCapability } from "@/lib/permissions/enforce";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type {
  RegisterContextState,
  RegisterCredential,
  RegisterManageAction,
  RegisterRecord,
  RegisterSaleEvidence,
} from "../types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapRegister(value: unknown): RegisterRecord {
  const row = record(value);
  return {
    id: String(row.id ?? ""),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    branch_id: String(row.branch_id ?? ""),
    branch_name: typeof row.branch_name === "string" ? row.branch_name : null,
    active: row.active === true,
    installation_id: String(row.installation_id ?? ""),
    last_seen_at: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    app_version: typeof row.app_version === "string" ? row.app_version : null,
    platform: typeof row.platform === "string" ? row.platform : null,
    hardware_metadata: record(row.hardware_metadata),
    pending_offline_count: Math.max(0, Number(row.pending_offline_count) || 0),
    unresolved_conflict_count: Math.max(0, Number(row.unresolved_conflict_count) || 0),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function snapshotBinding(binding: DesktopRegisterBinding): RegisterRecord {
  return {
    id: binding.snapshot.id,
    code: binding.snapshot.code,
    name: binding.snapshot.name,
    branch_id: binding.snapshot.branchId,
    branch_name: binding.snapshot.branchName,
    active: binding.snapshot.active,
    installation_id: binding.installationId,
    last_seen_at: binding.snapshot.validatedAt,
    app_version: null,
    platform: null,
    hardware_metadata: {},
    pending_offline_count: 0,
    unresolved_conflict_count: 0,
    created_at: binding.snapshot.validatedAt,
    updated_at: binding.snapshot.validatedAt,
  };
}

function bindingFor(register: RegisterRecord, credential: string): DesktopRegisterBinding {
  return {
    registerId: register.id,
    installationId: register.installation_id,
    credential,
    snapshot: {
      id: register.id,
      code: register.code,
      name: register.name,
      branchId: register.branch_id,
      branchName: register.branch_name,
      active: register.active,
      validatedAt: new Date().toISOString(),
    },
  };
}

async function requireDesktopCredential(): Promise<RegisterCredential> {
  const config = await getDesktopConfig();
  const binding = config?.registerBinding;
  if (!config || !binding) {
    throw new AppError("FORBIDDEN", "This desktop installation has not been registered");
  }
  return {
    register_id: binding.registerId,
    installation_id: binding.installationId,
    register_name: binding.snapshot.name,
    credential: binding.credential,
    register: snapshotBinding(binding),
  };
}

/** Current local binding proof. The credential never enters IndexedDB or diagnostics. */
export async function getRegisterCredential(): Promise<RegisterCredential | null> {
  if (!isDesktopRuntime()) return null;
  return requireDesktopCredential();
}

/**
 * Evidence frozen into a sale/outbox operation. Authority is resolved from the
 * credential by Postgres; these ids alone can never select a register.
 */
export async function getRegisterSaleEvidence(activeBranchId: string | null): Promise<RegisterSaleEvidence | null> {
  const credential = await getRegisterCredential();
  if (!credential) return null;
  if (!credential.register.active) throw new AppError("FORBIDDEN", "This register is deactivated");
  if (!activeBranchId || credential.register.branch_id !== activeBranchId) {
    throw new AppError("FORBIDDEN", "This register belongs to another branch");
  }
  return { register_id: credential.register_id, installation_id: credential.installation_id, register_name: credential.register.name };
}

/** Validate the cached local snapshot when online; retain it only for a genuine network outage. */
export async function resolveRegisterContext(activeBranchId: string | null): Promise<RegisterContextState> {
  if (!isDesktopRuntime()) return { kind: "web", register: null, reason: null };
  let credential: RegisterCredential;
  try {
    credential = await requireDesktopCredential();
  } catch (error) {
    return { kind: "desktop-unregistered", register: null, reason: error instanceof Error ? error.message : "Register setup required" };
  }
  const cached = credential.register;
  if (!isSupabaseConfigured) {
    const valid = cached.active && Boolean(activeBranchId) && cached.branch_id === activeBranchId;
    return valid
      ? { kind: "desktop-ready", register: cached, reason: null }
      : { kind: "desktop-invalid", register: cached, reason: "The local register does not match the active branch" };
  }
  try {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client.rpc("register_context", {
      p_installation_id: credential.installation_id,
      p_credential: credential.credential,
    });
    if (error) throw toAppError(error);
    const resolved = mapRegister(data);
    await saveDesktopRegisterBinding(bindingFor(resolved, credential.credential));
    if (!resolved.active) return { kind: "desktop-invalid", register: resolved, reason: "This register is deactivated" };
    if (!activeBranchId || resolved.branch_id !== activeBranchId) {
      return { kind: "desktop-invalid", register: resolved, reason: "This register belongs to another branch" };
    }
    return { kind: "desktop-ready", register: resolved, reason: null };
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);
    if (appError.code === "NETWORK" && cached.active && activeBranchId === cached.branch_id) {
      return { kind: "desktop-ready", register: cached, reason: null };
    }
    return { kind: "desktop-invalid", register: cached, reason: appError.message };
  }
}

export async function listRegisters(): Promise<RegisterRecord[]> {
  assertCapability("manage_registers");
  if (!isSupabaseConfigured) return [];
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client.rpc("register_list");
  if (error) throw toAppError(error);
  return Array.isArray(data) ? data.map(mapRegister) : [];
}

export async function createAndBindRegister(input: {
  code: string;
  name: string;
  branch_id: string;
}): Promise<RegisterRecord> {
  assertCapability("manage_registers");
  const context = await getDesktopContext();
  if (!context) throw new AppError("VALIDATION", "Register setup must run in the desktop application");
  if (!isSupabaseConfigured) throw new AppError("NOT_CONFIGURED", "Backend registration requires Supabase");
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client.rpc("register_create", {
    p_code: input.code,
    p_name: input.name,
    p_branch_id: input.branch_id,
    p_installation_id: context.installationId,
  });
  if (error) throw toAppError(error);
  const response = record(data);
  const register = mapRegister(response.register);
  const credential = typeof response.credential === "string" ? response.credential : "";
  if (!register.id || credential.length < 32) throw new AppError("DB", "Register credential missing from response");
  await saveDesktopRegisterBinding(bindingFor(register, credential));
  return register;
}

export async function manageRegister(input: {
  register_id: string;
  action: RegisterManageAction;
  name?: string | null;
  branch_id?: string | null;
}): Promise<RegisterRecord> {
  assertCapability("manage_registers");
  if (!isSupabaseConfigured) throw new AppError("NOT_CONFIGURED");
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client.rpc("register_manage", {
    p_register_id: input.register_id,
    p_action: input.action,
    p_name: input.name ?? null,
    p_branch_id: input.branch_id ?? null,
  });
  if (error) throw toAppError(error);
  return mapRegister(data);
}

export async function sendRegisterHeartbeat(input: {
  pending: number;
  conflicts: number;
  hardware: Record<string, unknown>;
}): Promise<RegisterRecord | null> {
  const credential = await getRegisterCredential();
  if (!credential || !isSupabaseConfigured) return null;
  const context = await getDesktopContext();
  const client = getSupabaseClient();
  if (!client || !context) return null;
  const { data, error } = await client.rpc("register_heartbeat", {
    p_installation_id: credential.installation_id,
    p_credential: credential.credential,
    p_app_version: context.version,
    p_platform: `${context.platform}/${context.arch}`,
    p_hardware_metadata: input.hardware,
    p_pending: Math.max(0, Math.trunc(input.pending)),
    p_conflicts: Math.max(0, Math.trunc(input.conflicts)),
  });
  if (error) throw toAppError(error);
  return mapRegister(data);
}

export async function recordHardwareEvent(event: "configured" | "printer_tested", details: Record<string, unknown>): Promise<void> {
  assertCapability("configure_hardware");
  const credential = await requireDesktopCredential();
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { error } = await client.rpc("register_hardware_event", {
    p_installation_id: credential.installation_id,
    p_credential: credential.credential,
    p_event: event,
    p_details: details,
  });
  if (error) throw toAppError(error);
}

export async function authorizeManualDrawer(reason: string): Promise<{ authorization_ref: string; drawer_state: "unknown" }> {
  assertCapability("open_cash_drawer");
  const credential = await requireDesktopCredential();
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const { data, error } = await client.rpc("register_authorize_drawer_open", {
    p_installation_id: credential.installation_id,
    p_credential: credential.credential,
    p_reason: reason,
  });
  if (error) throw toAppError(error);
  const result = record(data);
  if (typeof result.authorization_ref !== "string") throw new AppError("DB", "Drawer authorization missing");
  return { authorization_ref: result.authorization_ref, drawer_state: "unknown" };
}

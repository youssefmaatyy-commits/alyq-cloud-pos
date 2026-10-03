import type { Customer } from "@/modules/customers/types";
import type { CartDiscount, CartLine } from "../types";
import { getOfflineDb } from "./db";

/**
 * A suspended sale is a local draft, never a financial transaction or stock
 * reservation. It is deliberately stored beside the offline outbox so it
 * survives refreshes in a normal browser but remains invisible to inventory,
 * reports and the server until the cashier completes it.
 */
export interface HeldCartRecord {
  id: string;
  created_at: string;
  updated_at: string;
  held_by_id: string;
  held_by_name: string;
  /** Branch where the exact shelf snapshot was selected. */
  branch_id?: string | null;
  store: string | null;
  shift_id: string | null;
  customer: Customer | null;
  lines: CartLine[];
  invoice_discount: CartDiscount;
  coupon_code: string | null;
  notes: string | null;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `held-${crypto.randomUUID()}`
    : `held-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function clone<T>(value: T): T {
  // Store a detached snapshot. Cart lines/customer must not be mutated by the
  // new sale while a suspended sale is waiting for the cashier.
  return structuredClone(value);
}

export async function listHeldCarts(branchId: string | null = null): Promise<HeldCartRecord[]> {
  const db = getOfflineDb();
  return (await db.getAll<HeldCartRecord>("held_carts"))
    // Legacy drafts had no branch marker; keep them visible for upgrade
    // compatibility. Every new draft is branch-qualified below.
    .filter((record) => !branchId || !record.branch_id || record.branch_id === branchId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function holdCart(input: Omit<HeldCartRecord, "id" | "created_at" | "updated_at">): Promise<HeldCartRecord> {
  const now = new Date().toISOString();
  const record: HeldCartRecord = {
    ...clone(input),
    id: newId(),
    created_at: now,
    updated_at: now,
  };
  await getOfflineDb().put("held_carts", record);
  return record;
}

export async function removeHeldCart(id: string): Promise<void> {
  await getOfflineDb().delete("held_carts", id);
}

/** Test hook; production never clears drafts implicitly. */
export async function clearHeldCartsForTests(): Promise<void> {
  await getOfflineDb().clear("held_carts");
}

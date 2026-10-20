import type {
  CreateReturnInput,
  RefundRecord,
  ReturnItem,
  SalesReturn,
  SettleRefundInput,
  SettleRefundResult,
} from "../types";
import { AppError, type ReturnRepository } from "./repository";
import { safeStorage } from "@/modules/products/data/demoSeed";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
import { getDemoOnlineRepository } from "@/modules/online/data/demoRepository";
import { getDemoRepository as getCatalogDemo } from "@/modules/products/data/demoRepository";
import { applyDemoAdjustment } from "@/modules/inventory/data/demoRepository";
import { validateReturnDraft } from "../validation";
import { round2 } from "@/modules/pos/services/posMath";

const RETURNS_KEY = "alyq.demo.returns.v1";
const REFUNDS_KEY = "alyq.demo.refunds.v1";
const RETURN_COUNTER_KEY = "alyq.demo.return_counter.v1";
const REFUND_COUNTER_KEY = "alyq.demo.refund_counter.v1";
const LATENCY = 100;

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextReturnCounter(): number {
  const raw = safeStorage.get(RETURN_COUNTER_KEY);
  const current = Number(raw) || 0;
  const next = Math.max(1, current + 1);
  safeStorage.set(RETURN_COUNTER_KEY, String(next));
  return next;
}

function formatReturnNumber(n: number): string {
  return `RET-${String(n).padStart(6, "0")}`;
}

function nextRefundCounter(): number {
  const raw = safeStorage.get(REFUND_COUNTER_KEY);
  const current = Number(raw) || 0;
  const next = Math.max(1, current + 1);
  safeStorage.set(REFUND_COUNTER_KEY, String(next));
  return next;
}

function formatRefundNumber(n: number): string {
  return `REF-${String(n).padStart(6, "0")}`;
}

function loadReturns(): SalesReturn[] {
  const raw = safeStorage.get(RETURNS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistReturns(list: SalesReturn[]): void {
  safeStorage.set(RETURNS_KEY, JSON.stringify(list));
}

function loadRefunds(): RefundRecord[] {
  const raw = safeStorage.get(REFUNDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistRefunds(list: RefundRecord[]): void {
  safeStorage.set(REFUNDS_KEY, JSON.stringify(list));
}

export class DemoReturnRepository implements ReturnRepository {
  readonly kind = "demo" as const;
  private returns: SalesReturn[];
  private refunds: RefundRecord[];

  constructor() {
    this.returns = loadReturns();
    this.refunds = loadRefunds();
  }

  async listReturns(): Promise<SalesReturn[]> {
    return delay([...this.returns].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async getReturnsForSale(saleId: string): Promise<SalesReturn[]> {
    return delay(this.returns.filter((item) => item.sale_id === saleId), 20);
  }

  async getReturn(id: string): Promise<SalesReturn> {
    const found = this.returns.find((r) => r.id === id);
    if (!found) throw new AppError("NOT_FOUND", `Return ${id} not found`);
    return delay(found);
  }

  async listRefunds(): Promise<RefundRecord[]> {
    return delay([...this.refunds].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }

  async getRefundsForSale(saleId: string): Promise<RefundRecord[]> {
    return delay(
      this.refunds
        .filter((r) => r.sale_id === saleId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    );
  }

  async createReturn(
    input: CreateReturnInput,
  ): Promise<{ returnRecord: SalesReturn; refundRecord: RefundRecord }> {
    // A click retry carries the same key. Return the original records before
    // checking returnable quantities or touching stock a second time.
    if (input.client_ref) {
      const prior = this.returns.find((entry) => entry.client_ref === input.client_ref);
      if (prior) {
        const refund = this.refunds.find((entry) => entry.return_id === prior.id);
        if (refund) return delay({ returnRecord: prior, refundRecord: refund }, 20);
      }
    }

    const salesRepo = getDemoSalesRepository();
    const sale = await salesRepo.getSale(input.sale_id);
    if (!sale) throw new AppError("NOT_FOUND", `Sale ${input.sale_id} not found`);

    // An online-origin sale's lines read at list while its discount rides as
    // one fixed sale discount: the refund uses the order snapshot's paid
    // prices instead, so a discounted item refunds discounted, never list.
    let paidPrices: { product_id: string; variant_id: string | null; discounted_unit_price: number | null }[] | null =
      null;
    if (sale.source === "online") {
      try {
        const origin = await getDemoOnlineRepository().getOrderBySaleId(sale.id);
        paidPrices =
          origin?.items.map((item) => ({
            product_id: item.product_id,
            variant_id: item.variant_id ?? null,
            discounted_unit_price: item.discounted_unit_price ?? null,
          })) ?? null;
      } catch {
        paidPrices = null;
      }
    }

    const validation = validateReturnDraft(
      sale,
      input.items,
      input.reason,
      input.refund_method,
      this.returns,
      this.refunds,
      paidPrices,
    );

    if (!validation.valid) {
      const firstKey = Object.keys(validation.errors)[0] ?? "general";
      const err = new AppError("VALIDATION", validation.errors[firstKey] ?? "Invalid return draft");
      Object.assign(err, { fieldErrors: validation.errors });
      throw err;
    }

    const returnId = `ret-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const returnNumber = formatReturnNumber(nextReturnCounter());
    const refundNumber = formatRefundNumber(nextRefundCounter());
    const now = nowIso();

    const returnItems: ReturnItem[] = [];
    for (const validItem of validation.items) {
      if (validItem.requested_quantity <= 0) continue;
      const itemId = `reti-${returnItems.length}-${Date.now()}`;
      returnItems.push({
        id: itemId,
        return_id: returnId,
        sale_item_id: validItem.sale_item_id,
        product_id: validItem.product_id,
        variant_id: validItem.variant_id,
        variant_color_ar: validItem.variant_color_ar,
        variant_color_en: validItem.variant_color_en,
        variant_size: validItem.variant_size,
        variant_size_label: validItem.variant_size_label,
        variant_display_name: validItem.variant_display_name ?? null,
        name_ar: validItem.name_ar,
        name_en: validItem.name_en,
        sku: validItem.sku,
        barcode: validItem.barcode,
        unit_price: validItem.unit_price,
        quantity: validItem.requested_quantity,
        line_total: validItem.line_total,
      });
    }

    // Validate first, construct immutable records next, then move stock. If a
    // later shelf mutation fails, compensate each earlier one on its EXACT
    // variant shelf before exposing any return/refund record. This is the demo
    // equivalent of the live RPC transaction and prevents stock inflation.
    const applied: ReturnItem[] = [];
    try {
      const catalog = getCatalogDemo();
      for (const item of returnItems) {
        const products = await catalog.listProducts();
        await applyDemoAdjustment(
          {
            productId: item.product_id,
            variantId: item.variant_id,
            type: "adjustment_in",
            reason: "customer_return",
            quantity: item.quantity,
            notes: `Customer Return: ${returnNumber} (Sale ${sale.sale_number})`,
            userId: input.user_id,
            userName: input.user_name,
          },
          products,
        );
        applied.push(item);
      }
    } catch (error) {
      const catalog = getCatalogDemo();
      for (const item of [...applied].reverse()) {
        const products = await catalog.listProducts();
        await applyDemoAdjustment(
          {
            productId: item.product_id,
            variantId: item.variant_id,
            type: "adjustment_out",
            reason: "customer_return",
            quantity: item.quantity,
            notes: `Reversed: failed return ${returnNumber}`,
            userId: input.user_id,
            userName: input.user_name,
          },
          products,
        );
      }
      throw error;
    }

    const returnRecord: SalesReturn = {
      id: returnId,
      client_ref: input.client_ref ?? null,
      return_number: returnNumber,
      sale_id: sale.id,
      sale_number: sale.sale_number,
      customer_id: sale.customer_id ?? null,
      customer_name: sale.customer_name ?? null,
      reason: input.reason.trim(),
      refund_amount: validation.calculatedRefundAmount,
      refund_method: input.refund_method,
      refund_status: input.refund_status ?? "completed",
      user_id: input.user_id,
      user_name: input.user_name,
      items: returnItems,
      created_at: now,
    };

    const refundId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const refundRecord: RefundRecord = {
      id: refundId,
      refund_number: refundNumber,
      sale_id: sale.id,
      sale_number: sale.sale_number,
      return_id: returnId,
      amount: validation.calculatedRefundAmount,
      payment_method: input.refund_method,
      status: input.refund_status ?? "completed",
      reason: input.reason.trim(),
      user_id: input.user_id,
      user_name: input.user_name,
      created_at: now,
      // A refund created already-settled carries its own creator as the
      // settlement trail; a pending one waits for `settleRefund`.
      rejection_reason: null,
      settled_at: input.refund_status === "pending" ? null : now,
      settled_by: input.refund_status === "pending" ? null : input.user_id,
      settled_by_name: input.refund_status === "pending" ? null : input.user_name,
    };

    this.returns = [returnRecord, ...this.returns];
    persistReturns(this.returns);

    this.refunds = [refundRecord, ...this.refunds];
    persistRefunds(this.refunds);

    return delay({ returnRecord, refundRecord }, 60);
  }

  async settleRefund(refundId: string, input: SettleRefundInput): Promise<SettleRefundResult> {
    const refund = this.refunds.find((r) => r.id === refundId);
    if (!refund) throw new AppError("NOT_FOUND", `Refund ${refundId} not found`);

    // Idempotent in the same direction, refused in the other — the same shape
    // `pos_settle_refund` enforces in migration 0016.
    if (refund.status === input.decision) {
      return delay({ refund, alreadySettled: true }, 40);
    }
    if (refund.status !== "pending") {
      throw new AppError(
        "VALIDATION",
        `This refund was already settled as ${refund.status}`,
      );
    }
    const reason = input.reason?.trim() ?? "";
    if (input.decision === "rejected" && reason.length === 0) {
      throw new AppError("VALIDATION", "A rejected refund needs a reason");
    }

    const now = nowIso();
    const settled: RefundRecord = {
      ...refund,
      status: input.decision,
      rejection_reason: input.decision === "rejected" ? reason : null,
      settled_at: now,
      settled_by: input.user_id,
      settled_by_name: input.user_name,
    };
    // A rejection means the original stock-in must be reversed. Do that first
    // and compensate any partial reversal on failure; only then publish the
    // terminal refund/return state. A retry after an error therefore cannot
    // double-debit a variant shelf or leave stock and refund status diverged.
    const linked = settled.return_id ? this.returns.find((entry) => entry.id === settled.return_id) : null;
    if (settled.status === "rejected" && linked) {
      const reversed: ReturnItem[] = [];
      try {
        const catalog = getCatalogDemo();
        for (const item of linked.items) {
          const products = await catalog.listProducts();
          await applyDemoAdjustment(
            {
              productId: item.product_id,
              variantId: item.variant_id,
              type: "adjustment_out",
              reason: "customer_return",
              quantity: item.quantity,
              notes: `Reversed: refund ${settled.refund_number} rejected (Return ${linked.return_number})`,
              userId: input.user_id,
              userName: input.user_name,
            },
            products,
          );
          reversed.push(item);
        }
      } catch (error) {
        const catalog = getCatalogDemo();
        for (const item of [...reversed].reverse()) {
          const products = await catalog.listProducts();
          await applyDemoAdjustment(
            {
              productId: item.product_id,
              variantId: item.variant_id,
              type: "adjustment_in",
              reason: "customer_return",
              quantity: item.quantity,
              notes: `Reversed: failed refund rejection ${settled.refund_number}`,
              userId: input.user_id,
              userName: input.user_name,
            },
            products,
          );
        }
        throw error;
      }
    }

    this.refunds = this.refunds.map((r) => (r.id === refundId ? settled : r));
    persistRefunds(this.refunds);
    if (settled.return_id) {
      this.returns = this.returns.map((r) =>
        r.id === settled.return_id ? { ...r, refund_status: settled.status } : r,
      );
      persistReturns(this.returns);
    }

    return delay({ refund: settled, alreadySettled: false }, 60);
  }

  reset(): void {
    this.returns = [];
    persistReturns(this.returns);
    this.refunds = [];
    persistRefunds(this.refunds);
  }
}

let singleton: DemoReturnRepository | null = null;
export function getDemoReturnRepository(): DemoReturnRepository {
  if (!singleton) singleton = new DemoReturnRepository();
  return singleton;
}

void round2;

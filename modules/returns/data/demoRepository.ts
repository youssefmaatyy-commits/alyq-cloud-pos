import type { CreateReturnInput, RefundRecord, ReturnItem, SalesReturn } from "../types";
import { AppError, type ReturnRepository } from "./repository";
import { safeStorage } from "@/modules/products/data/demoSeed";
import { getDemoSalesRepository } from "@/modules/pos/data/demoRepository";
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
    const salesRepo = getDemoSalesRepository();
    const sale = await salesRepo.getSale(input.sale_id);
    if (!sale) throw new AppError("NOT_FOUND", `Sale ${input.sale_id} not found`);

    const validation = validateReturnDraft(
      sale,
      input.items,
      input.reason,
      input.refund_method,
      this.returns,
      this.refunds,
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
        name_ar: validItem.name_ar,
        name_en: validItem.name_en,
        sku: validItem.sku,
        barcode: validItem.barcode,
        unit_price: validItem.unit_price,
        quantity: validItem.requested_quantity,
        line_total: validItem.line_total,
      });

      // Increase stock safely and create stock movement record
      const catalog = getCatalogDemo();
      const products = await catalog.listProducts();
      await applyDemoAdjustment(
        {
          productId: validItem.product_id,
          type: "adjustment_in",
          reason: "customer_return",
          quantity: validItem.requested_quantity,
          notes: `Customer Return: ${returnNumber} (Sale ${sale.sale_number})`,
          userId: input.user_id,
          userName: input.user_name,
        },
        products,
      );
    }

    const returnRecord: SalesReturn = {
      id: returnId,
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
    };

    this.returns = [returnRecord, ...this.returns];
    persistReturns(this.returns);

    this.refunds = [refundRecord, ...this.refunds];
    persistRefunds(this.refunds);

    return delay({ returnRecord, refundRecord }, 60);
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

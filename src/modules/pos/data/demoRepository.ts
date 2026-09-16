import { applySaleListQuery } from "./saleListQuery";
import type {
  CompleteSaleInput,
  ConfirmPaymentInput,
  Sale,
  SaleItem,
  VoidSaleInput,
} from "../types";
import { AppError } from "@/modules/products/data/repository";
import { getDemoRepository } from "@/modules/products/data/demoRepository";
import { applyDemoAdjustment } from "@/modules/inventory/data/demoRepository";
import { getDemoShiftRepository } from "@/modules/shifts/data/demoRepository";
import { safeStorage } from "@/modules/products/data/demoSeed";
import { cartTotals, lineTotal, round2, validateDiscount } from "../services/posMath";
import type { SaleListQuery, SalesRepository } from "./repository";

const SALES_KEY = "alyq.demo.sales.v1";
const COUNTER_KEY = "alyq.demo.sale_counter.v1";
const LATENCY = 120;

function delay<T>(value: T, ms = LATENCY): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

export function formatSaleNumber(n: number): string {
  return `INV-${String(n).padStart(6, "0")}`;
}

function readSales(): Sale[] {
  const raw = safeStorage.get(SALES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Sale[]) : [];
  } catch {
    return [];
  }
}

function readCounter(): number {
  const raw = safeStorage.get(COUNTER_KEY);
  const current = Number(raw);
  return Number.isFinite(current) && current > 0 ? current : 0;
}

// One completion at a time per browser tab (double-submission guard).
let inFlight = false;

/**
 * Demo implementation. Uses the same public repositories as the UI:
 *   - catalog demo repo  → authoritative product prices + stock
 *   - inventory demo repo → stock deduction + `stock_movements` ledger
 * so the audit trail is identical to the rest of the app.
 */
export class DemoSalesRepository implements SalesRepository {
  readonly kind = "demo" as const;

  /**
   * Authoritative in-memory state, seeded from storage once and persisted on
   * every write — the same pattern the catalog and inventory demo repos use.
   *
   * Reading straight from storage on each call would make the whole module
   * depend on `localStorage` being present: outside a browser every read
   * returns empty, which silently breaks idempotency and restarts the invoice
   * counter at 1 for every sale.
   */
  private sales: Sale[] = readSales();
  private counter: number = Math.max(readCounter(), this.sales.length);

  private persist(): void {
    safeStorage.set(SALES_KEY, JSON.stringify(this.sales));
    safeStorage.set(COUNTER_KEY, String(this.counter));
  }

  /** Allocate the next invoice number (monotonic, never reused). */
  private nextSaleNumber(): string {
    this.counter += 1;
    return formatSaleNumber(this.counter);
  }

  async completeSale(input: CompleteSaleInput, _approvalRequestId?: string | null): Promise<Sale> {
    // Demo mode has no database, so there is no server-side gate to satisfy: the
    // limit is enforced by saleService before it gets here, exactly as it was.
    // The parameter exists so both repositories answer to one interface.
    // Idempotency first: a retried submit (double-click, network retry) must
    // return the original sale rather than raising the in-flight error.
    const existing = this.sales.find((s) => s.client_ref === input.client_ref);
    if (existing) return delay(existing, 20);

    if (inFlight) {
      throw new AppError("VALIDATION", "A sale is already being processed", "sale");
    }

    inFlight = true;
    try {
      if (input.lines.length === 0) {
        throw new AppError("VALIDATION", "Cart is empty", "cart");
      }

      // ── open-shift requirement (Phase 27) ─────────────────────────────────
      // Demo mode has no RPC, so the demo repository mirrors the rule the
      // database applies in pos_complete_sale (migration 0040): a till sale
      // needs the drawer to be open and is stamped with the shift; the
      // online channel stays independent of it.
      const shifts = await getDemoShiftRepository().listShifts();
      const openShift = shifts.find((sh) => sh.status === "open") ?? null;
      const openShiftId: string | null = input.source === "online" ? null : (openShift?.id ?? null);
      if (input.source !== "online" && !openShift) {
        throw new AppError("SHIFT_REQUIRED", "A shift must be open before a sale can be completed");
      }

      // ── authoritative re-read: fresh stock + catalog prices ──
      const fresh = await getDemoRepository().listProducts();

      const items: SaleItem[] = [];
      for (const line of input.lines) {
        const product = fresh.find((p) => p.id === line.product_id);
        if (!product) throw new AppError("NOT_FOUND", `Product ${line.product_id} not found`, "cart");
        if (!product.active) throw new AppError("VALIDATION", `${product.sku} is inactive`, "cart");
        if (!product.stock_tracking_enabled) {
          throw new AppError("VALIDATION", `${product.sku} is not stock-tracked`, "cart");
        }
        const qty = Math.trunc(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new AppError("VALIDATION", `Invalid quantity for ${product.sku}`, "cart");
        }
        if (qty > product.stock_quantity) {
          throw new AppError(
            "VALIDATION",
            `Only ${product.stock_quantity} of ${product.sku} in stock`,
            "cart",
          );
        }
        const unit = round2(product.selling_price);
        items.push({
          id: `sli-${items.length}-${Date.now()}`,
          sale_id: "pending",
          product_id: product.id,
          name_ar: product.name_ar,
          name_en: product.name_en,
          sku: product.sku,
          barcode: product.barcode,
          unit_price: unit,
          quantity: qty,
          line_total: lineTotal(unit, qty),
        });
      }

      // ── authoritative totals: recomputed from catalog prices ──
      if (validateDiscount(input.discount_type, input.discount_value)) {
        throw new AppError("VALIDATION", "Invalid discount", "discount");
      }
      const totals = cartTotals(
        items.map((i) => ({ unit_price: i.unit_price, qty: i.quantity })),
        { type: input.discount_type, value: input.discount_value },
      );

      // ── payment rules (split payment: one or more payments) ──
      const now = nowIso();
      const saleId = `sale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const saleNumber = this.nextSaleNumber();

      if (!Array.isArray(input.payments) || input.payments.length === 0) {
        throw new AppError("VALIDATION", "At least one payment is required", "payment");
      }

      // Validate + normalise each payment. `tendered` is kept only for the
      // cash-change summary; it is not persisted on the payment record.
      const cashTendered: number[] = [];
      const payments: Sale["payments"] = input.payments.map((p, i) => {
        // The till takes cash and InstaPay. Cash on delivery is only ever
        // attached to a sale an approved website order created, and only this
        // flow sets `source`, so the till's behaviour is unchanged.
        if (p.method === "cod" && input.source !== "online") {
          throw new AppError("VALIDATION", `Invalid payment method: ${p.method}`, "payment");
        }
        if (p.method !== "cash" && p.method !== "instapay" && p.method !== "cod") {
          throw new AppError("VALIDATION", `Invalid payment method: ${p.method}`, "payment");
        }
        const amount = round2(p.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new AppError("VALIDATION", "Payment amount must be greater than zero", "payment");
        }
        // Cash is always paid; cash on delivery never is (the money has not been
        // collected — it arrives with the courier); InstaPay may be either.
        const status =
          p.method === "cash" ? "paid" : p.method === "cod" ? "pending" : p.status === "paid" ? "paid" : "pending";
        if (p.method === "cash") {
          const t = round2(p.tendered ?? amount);
          if (!Number.isFinite(t) || t < amount) {
            throw new AppError("VALIDATION", "Insufficient cash received for the cash portion", "payment");
          }
          cashTendered.push(t);
        }
        return {
          id: `pay-${i}-${saleId}`,
          sale_id: saleId,
          method: p.method,
          amount,
          status,
          paid_at: status === "paid" ? now : null,
          paid_by: status === "paid" ? input.user_id : null,
          paid_by_name: status === "paid" ? input.user_name : null,
        };
      });

      // The sum of payments must equal the sale total exactly (no over/under).
      const appliedTotal = round2(payments.reduce((sum, p) => sum + p.amount, 0));
      if (appliedTotal !== totals.total) {
        throw new AppError(
          "VALIDATION",
          `Payments sum to ${appliedTotal}, but the sale total is ${totals.total}`,
          "payment",
        );
      }

      const allPaid = payments.every((p) => p.status === "paid");
      const cashPayments = payments.filter((p) => p.method === "cash");
      const amountReceived = cashPayments.length ? round2(cashTendered.reduce((s, t) => s + t, 0)) : null;
      const change = cashPayments.length
        ? round2(cashTendered.reduce((s, t) => s + t, 0) - cashPayments.reduce((s, p) => s + p.amount, 0))
        : null;
      const lastInstaPay = [...payments].reverse().find((p) => p.method === "instapay");

      const sale: Sale = {
        id: saleId,
        sale_number: saleNumber,
        client_ref: input.client_ref,
        status: allPaid ? "completed" : "pending",
        payment_method: payments[0].method,
        payment_status: allPaid ? "paid" : "pending",
        subtotal: totals.subtotal,
        discount_type: input.discount_type,
        discount_value: round2(input.discount_value || 0),
        discount_amount: totals.discountAmount,
        total: totals.total,
        amount_received: amountReceived,
        change,
        user_id: input.user_id,
        user_name: input.user_name,
        items: items.map((i) => ({ ...i, sale_id: saleId })),
        payments,
        customer_id: input.customer_id ?? null,
        customer_name: input.customer_name ?? null,
        customer_phone: input.customer_phone ?? null,
        created_at: now,
        shift_id: openShiftId,
        voided_at: null,
        void_reason: null,
        paid_at: allPaid ? now : lastInstaPay?.paid_at ?? null,
        paid_by: allPaid ? input.user_id : lastInstaPay?.paid_by ?? null,
        paid_by_name: allPaid ? input.user_name : lastInstaPay?.paid_by_name ?? null,
        source: input.source ?? "pos",
      };

      // ── deduct stock + record a movement per line (re-read each time
      //    so quantity_before / quantity_after stay accurate) ──
      for (const item of sale.items) {
        const current = await getDemoRepository().listProducts();
        await applyDemoAdjustment(
          {
            productId: item.product_id,
            type: "issue",
            reason: "other",
            quantity: item.quantity,
            notes: `Sale ${saleNumber}`,
            userId: input.user_id,
            userName: input.user_name,
          },
          current,
        );
      }

      this.sales = [sale, ...this.sales];
      this.persist();
      return delay(sale, 30);
    } finally {
      inFlight = false;
    }
  }

  /**
   * Mark a pending InstaPay sale as paid.
   *
   * Idempotent (a second confirmation returns the sale unchanged), only
   * applies to InstaPay sales that are still pending, and touches nothing but
   * the payment fields — totals, items, stock and movements stay exactly as
   * they were, and no duplicate sale is created.
   */
  async confirmPayment(
    id: string,
    input: ConfirmPaymentInput,
  ): Promise<Sale> {
    const index = this.sales.findIndex((s) => s.id === id);
    if (index === -1) throw new AppError("NOT_FOUND");
    const sale = this.sales[index];

    // Idempotent: if nothing is pending, return the sale unchanged.
    if (sale.status === "voided") {
      throw new AppError("VALIDATION", "Cannot confirm a voided sale", "payment");
    }

    const pending = sale.payments.filter(
      (p) => p.method === "instapay" && p.status === "pending",
    );
    if (pending.length === 0) {
      return delay(sale); // already fully paid — no-op
    }

    const now = nowIso();
    const payments: Sale["payments"] = sale.payments.map((p) =>
      p.method === "instapay" && p.status === "pending"
        ? { ...p, status: "paid" as const, paid_at: now, paid_by: input.user_id, paid_by_name: input.user_name }
        : p,
    );
    const allPaid = payments.every((p) => p.status === "paid");
    const lastConfirmed = [...payments].reverse().find((p) => p.method === "instapay");

    const confirmed: Sale = {
      ...sale,
      payments,
      status: allPaid ? "completed" : "pending",
      payment_status: allPaid ? "paid" : "pending",
      paid_at: lastConfirmed?.paid_at ?? sale.paid_at,
      paid_by: lastConfirmed?.paid_by ?? sale.paid_by,
      paid_by_name: lastConfirmed?.paid_by_name ?? sale.paid_by_name,
    };
    const updated = [...this.sales];
    updated[index] = confirmed;
    this.sales = updated;
    this.persist();
    return delay(confirmed);
  }

  async listSales(query: SaleListQuery = {}): Promise<Sale[]> {
    return delay(applySaleListQuery(this.sales, query));
  }

  async countSales(query: SaleListQuery = {}): Promise<number | null> {
    // The offline backend holds the whole set in memory, so its total is exact
    // and free. Paging is ignored, exactly as the live count ignores it.
    return delay(
      applySaleListQuery(this.sales, query, { ignorePaging: true }).length,
    );
  }

  async getSale(id: string): Promise<Sale> {
    const sale = this.sales.find((s) => s.id === id);
    if (!sale) throw new AppError("NOT_FOUND");
    return delay(sale);
  }

  async voidSale(id: string, input: VoidSaleInput): Promise<Sale> {
    const sales = [...this.sales];
    const index = sales.findIndex((s) => s.id === id);
    if (index === -1) throw new AppError("NOT_FOUND");
    const sale = sales[index];
    if (sale.status === "voided") return delay(sale);

    // Return stock for every line with a reversing movement.
    for (const item of sale.items) {
      const current = await getDemoRepository().listProducts();
      await applyDemoAdjustment(
        {
          productId: item.product_id,
          type: "adjustment_in",
          reason: "other",
          quantity: item.quantity,
          notes: `Void of ${sale.sale_number}${input.reason ? `: ${input.reason}` : ""}`,
          userId: input.user_id,
          userName: input.user_name,
        },
        current,
      );
    }

    const updated: Sale = {
      ...sale,
      status: "voided",
      voided_at: nowIso(),
      void_reason: input.reason,
    };
    sales[index] = updated;
    this.sales = sales;
    this.persist();
    return delay(updated);
  }
}

let singleton: DemoSalesRepository | null = null;
export function getDemoSalesRepository(): DemoSalesRepository {
  if (!singleton) singleton = new DemoSalesRepository();
  return singleton;
}

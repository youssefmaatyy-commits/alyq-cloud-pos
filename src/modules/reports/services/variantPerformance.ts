/**
 * Per-combination performance (Phase 43) — what each colour/size did.
 *
 * `reports_product_performance` answers "how did the PRODUCT sell" and reads
 * stock from the rollup; this module answers the question it cannot: which
 * combination moved, which came back, and which shelf is sitting on the money.
 * The database RPC (`reports_variant_performance`, migration 0043) is the
 * authority; `computeVariantPerformance` is the same arithmetic over rows the
 * browser already holds, so demo mode — and a project whose migrations predate
 * 0043 — still renders the table instead of an apology.
 *
 * One row per variant whether or not it sold: a combination with revenue and no
 * returns and an empty shelf is exactly the story this table exists to tell.
 * Nothing here is additive with the product report — adding the two together
 * would double count — so no consumer ever sums across both.
 */
import { getSupabaseClient } from "@/lib/supabase/client";
import { roundMoney } from "@/modules/expenses/validation";
import type { Sale } from "@/modules/pos/types";
import type { SalesReturn } from "@/modules/returns/types";
import type { Product } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { toTimestampBounds } from "./dateRanges";
import type { AggregateResult } from "./reportAggregates";
import type { DateRange } from "./financialExport";

/** One combination's period, in the RPC's own field names. */
export interface VariantPerformanceRow {
  variantId: string;
  productId: string;
  productSku: string;
  productNameEn: string;
  productNameAr: string;
  sku: string;
  colorEn: string | null;
  colorAr: string | null;
  size: number | null;
  sizeLabel: string | null;
  /** False once archived — an archived combination can still have sold. */
  active: boolean;
  /** Sale LINES naming the combination (an invoice can hold two). */
  invoices: number;
  units: number;
  revenue: number;
  /** Units × (variant cost_override ?? product cost_price) — the RPC's rule. */
  cost: number;
  returnedUnits: number;
  returnedAmount: number;
  /** The shelf now: 0 for an untracked product, the variant's own stock otherwise. */
  stock: number;
  stockValue: number;
}

// ── jsonb → numbers ─────────────────────────────────────────────────────────
// The same coercion `reportAggregates` applies: a numeric through
// `jsonb_build_object` may legally arrive as a string, and no tile renders NaN.
type Json = Record<string, unknown>;
const n = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function mapRow(raw: Json): VariantPerformanceRow {
  return {
    variantId: String(raw.variantId ?? ""),
    productId: String(raw.productId ?? ""),
    productSku: String(raw.productSku ?? ""),
    productNameEn: String(raw.productNameEn ?? ""),
    productNameAr: String(raw.productNameAr ?? ""),
    sku: String(raw.sku ?? ""),
    colorEn: s(raw.colorEn),
    colorAr: s(raw.colorAr),
    size: raw.size === null || raw.size === undefined ? null : n(raw.size),
    sizeLabel: s(raw.sizeLabel),
    active: raw.active === true,
    invoices: n(raw.invoices),
    units: n(raw.units),
    revenue: n(raw.revenue),
    cost: n(raw.cost),
    returnedUnits: n(raw.returnedUnits),
    returnedAmount: n(raw.returnedAmount),
    stock: n(raw.stock),
    stockValue: n(raw.stockValue),
  };
}

/**
 * The database's answer, over EVERY invoice in the window. Requires
 * `view_reports` (the RPC enforces it) and migration 0043; anything else comes
 * back as a RESULT the caller falls back from — never a thrown empty screen.
 */
export async function fetchVariantPerformance(
  range: DateRange,
): Promise<AggregateResult<VariantPerformanceRow[]>> {
  let client: ReturnType<typeof getSupabaseClient>;
  try {
    client = getSupabaseClient();
  } catch {
    return { ok: false, reason: "no database connection" };
  }
  if (!client || typeof client.rpc !== "function") {
    return { ok: false, reason: "no database connection" };
  }
  const bounds = toTimestampBounds(range);
  const { data, error } = await client.rpc("reports_variant_performance", {
    p_from: bounds.from ?? null,
    p_to: bounds.to ?? null,
  });
  if (error) return { ok: false, reason: error.message || "reports_variant_performance" };
  if (!Array.isArray(data)) return { ok: false, reason: "reports_variant_performance returned nothing" };
  try {
    return {
      ok: true,
      value: (data as Json[]).map(mapRow),
    };
  } catch (cause) {
    return { ok: false, reason: `reports_variant_performance: ${(cause as Error).message}` };
  }
}

export interface ComputeVariantPerformanceInput {
  /** Non-voided sales, already cut to the report's window by the caller. */
  sales: readonly Sale[];
  /** Returns already cut to the window; a rejected refund counts as nothing. */
  returns: readonly SalesReturn[];
  variants: readonly ProductVariant[];
  products: readonly Product[];
}

/**
 * The fallback arithmetic, over rows the browser already holds — the exact rule
 * the RPC encodes, restated for demo mode:
 *
 *   · sold lines group by `variant_id`; voided sales and product-level lines
 *     (`variant_id = null`) count nowhere;
 *   · returns whose refund was rejected count nowhere;
 *   · cost is units × (variant cost_override ?? product cost_price);
 *   · stock is the combination's own shelf, 0 when the product is untracked.
 *
 * Ordered like the RPC: revenue descending, then SKU.
 */
export function computeVariantPerformance({
  sales,
  returns,
  variants,
  products,
}: ComputeVariantPerformanceInput): VariantPerformanceRow[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  const costOf = (variant: ProductVariant): number => {
    const product = productById.get(variant.product_id);
    return Number(variant.cost_override ?? product?.cost_price ?? 0);
  };
  const tracked = (variant: ProductVariant): boolean =>
    productById.get(variant.product_id)?.stock_tracking_enabled !== false;

  const rows = new Map<string, VariantPerformanceRow>();
  for (const variant of variants) {
    const product = productById.get(variant.product_id);
    if (!product) continue; // a variant without its product cannot be reported
    const unitCost = costOf(variant);
    const stock = tracked(variant) ? variant.stock_quantity : 0;
    rows.set(variant.id, {
      variantId: variant.id,
      productId: variant.product_id,
      productSku: product.sku,
      productNameEn: product.name_en,
      productNameAr: product.name_ar,
      sku: variant.sku,
      colorEn: variant.color_en,
      colorAr: variant.color_ar,
      size: variant.size,
      sizeLabel: variant.size_label,
      active: variant.active,
      invoices: 0,
      units: 0,
      revenue: 0,
      cost: 0,
      returnedUnits: 0,
      returnedAmount: 0,
      stock,
      stockValue: roundMoney(stock * unitCost),
    });
  }

  for (const sale of sales) {
    if (sale.status === "voided") continue;
    for (const item of sale.items ?? []) {
      if (!item.variant_id) continue; // the product report's line, not this one's
      const row = rows.get(item.variant_id);
      if (!row) continue; // the combination was deleted since the sale
      row.invoices += 1;
      row.units += item.quantity;
      row.revenue = roundMoney(row.revenue + item.line_total);
    }
  }

  // Cost is units × the row's own unit cost — the RPC's coalesce applied once
  // per combination, the same convention `productPerformance` uses for products.
  for (const variant of variants) {
    const row = rows.get(variant.id);
    if (!row) continue;
    row.cost = roundMoney(row.units * costOf(variant));
  }

  for (const salesReturn of returns) {
    if (salesReturn.refund_status === "rejected") continue;
    for (const item of salesReturn.items ?? []) {
      if (!item.variant_id) continue;
      const row = rows.get(item.variant_id);
      if (!row) continue;
      row.returnedUnits += item.quantity;
      row.returnedAmount = roundMoney(row.returnedAmount + item.line_total);
    }
  }

  return [...rows.values()].sort((a, b) => b.revenue - a.revenue || a.sku.localeCompare(b.sku));
}

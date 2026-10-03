import type { Product, ProductPatch } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { StockMovement } from "../types";
import type { AdjustStockArgs, InventoryRepository } from "./repository";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  readActiveBranchStock,
  withActiveBranchProductStock,
  withActiveBranchVariantStock,
} from "./branchStock";

interface MovementRow {
  id: string;
  product_id: string;
  variant_id?: string | null;
  variant_color_ar?: string | null;
  variant_color_en?: string | null;
  variant_size?: number | string | null;
  variant_size_label?: string | null;
  delta: number;
  quantity_before: number;
  quantity_after: number;
  type: string;
  reason: string;
  notes: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
  branch_id?: string | null;
  client_ref?: string | null;
  source_type?: StockMovement["source_type"];
  source_id?: string | null;
  reference?: string | null;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  color_key: string | null;
  color_ar: string | null;
  color_en: string | null;
  color_hex: string | null;
  size: number | string | null;
  size_label: string | null;
  size_value: string | null;
  size_sort_order: number | string | null;
  image_url: string | null;
  price_override: number | string | null;
  cost_override: number | string | null;
  stock_quantity: number | string | null;
  low_stock_level: number | string | null;
  active: boolean;
  sort_order: number | string | null;
  created_at: string;
  updated_at: string;
}

function mapVariant(row: VariantRow): ProductVariant {
  const numberOrNull = (value: number | string | null | undefined): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku ?? "",
    barcode: row.barcode ?? null,
    color_key: row.color_key ?? "",
    color_ar: row.color_ar ?? null,
    color_en: row.color_en ?? null,
    color_hex: row.color_hex ?? null,
    size: numberOrNull(row.size),
    size_label: row.size_label ?? null,
    size_value: row.size_value ?? row.size_label ?? (row.size == null ? null : String(row.size)),
    size_sort_order: toNumber(row.size_sort_order),
    image_url: row.image_url ?? null,
    price_override: numberOrNull(row.price_override),
    cost_override: numberOrNull(row.cost_override),
    stock_quantity: toNumber(row.stock_quantity),
    low_stock_level: toNumber(row.low_stock_level),
    active: row.active ?? true,
    sort_order: toNumber(row.sort_order),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    product_id: row.product_id,
    variant_id: row.variant_id ?? null,
    variant_color_ar: row.variant_color_ar ?? null,
    variant_color_en: row.variant_color_en ?? null,
    variant_size: row.variant_size === null || row.variant_size === undefined ? null : toNumber(row.variant_size),
    variant_size_label: row.variant_size_label ?? null,
    delta: toNumber(row.delta),
    quantity_before: toNumber(row.quantity_before),
    quantity_after: toNumber(row.quantity_after),
    type: row.type as StockMovement["type"],
    reason: row.reason as StockMovement["reason"],
    notes: row.notes ?? null,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
    branch_id: row.branch_id ?? null,
    client_ref: row.client_ref ?? null,
    source_type: row.source_type ?? null,
    source_id: row.source_id ?? null,
    reference: row.reference ?? null,
  };
}

const PRODUCTS_SELECT =
  "id, sku, barcode, name_en, name_ar, category_id, active, stock_quantity, stock_tracking_enabled, low_stock_level, variants_enabled";
const MOVEMENTS_SELECT = "*";
const VARIANTS_SELECT = "*";

/**
 * Live Supabase repository. The intended production behaviour is:
 *   1. insert the movement row (audit trail durable)
 *   2. update `products.stock_quantity` (with `WHERE stock_quantity = $expected`
 *      for optimistic concurrency, coming in Phase 4+)
 * For now the two writes are sequenced client-side; a future migration can
 * wrap them in a Postgres RPC (`adjust_stock`).
 */
export class SupabaseInventoryRepository implements InventoryRepository {
  readonly kind = "supabase" as const;

  async listProducts(): Promise<Product[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const [catalogue, stock] = await Promise.all([
      client.from("products").select(PRODUCTS_SELECT),
      readActiveBranchStock(client),
    ]);
    if (catalogue.error) throw toAppError(catalogue.error);
    return ((catalogue.data as Product[] | null) ?? [])
      .map((product) => withActiveBranchProductStock(product, stock));
  }

  async updateProductStock(_productId: string, _patch: ProductPatch): Promise<Product> {
    throw new AppError(
      "VALIDATION",
      "Live stock is branch-authoritative; use the atomic inventory adjustment operation",
    );
  }

  async listVariants(): Promise<ProductVariant[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const [variants, stock] = await Promise.all([
      client.from("product_variants").select(VARIANTS_SELECT),
      readActiveBranchStock(client),
    ]);
    if (variants.error) throw toAppError(variants.error);
    return ((variants.data as VariantRow[] | null) ?? [])
      .map(mapVariant)
      .map((variant) => withActiveBranchVariantStock(variant, stock));
  }

  async updateVariantStock(_variantId: string, _quantity: number): Promise<ProductVariant> {
    throw new AppError(
      "VALIDATION",
      "Live variant stock is branch-authoritative; use the atomic inventory adjustment operation",
    );
  }

  async listMovements(): Promise<StockMovement[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .select(MOVEMENTS_SELECT)
      .order("created_at", { ascending: false });
    if (error) throw toAppError(error);
    return (data as MovementRow[] | null ?? []).map(mapMovement);
  }

  async listMovementsForProduct(productId: string): Promise<StockMovement[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .select(MOVEMENTS_SELECT)
      .eq("product_id", productId)
      .order("created_at", { ascending: false });
    if (error) throw toAppError(error);
    return (data as MovementRow[] | null ?? []).map(mapMovement);
  }

  async recordMovement(input: Omit<StockMovement, "id" | "created_at" | "quantity_before" | "quantity_after">): Promise<StockMovement> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("stock_movements")
      .insert({
        product_id: input.product_id,
        variant_id: input.variant_id ?? null,
        variant_color_ar: input.variant_color_ar ?? null,
        variant_color_en: input.variant_color_en ?? null,
        variant_size: input.variant_size ?? null,
        delta: input.delta,
        quantity_before: 0,
        quantity_after: 0,
        type: input.type,
        reason: input.reason,
        notes: input.notes,
        user_id: input.user_id,
        user_name: input.user_name,
      })
      .select(MOVEMENTS_SELECT)
      .single();
    if (error) throw toAppError(error);
    return mapMovement(data as MovementRow);
  }
}

let singleton: SupabaseInventoryRepository | null = null;
export function getSupabaseInventoryRepository(): SupabaseInventoryRepository {
  if (!singleton) singleton = new SupabaseInventoryRepository();
  return singleton;
}

/**
 * Live adjustment adapter. One RPC locks and moves the exact shelf, appends the
 * existing ledger and audit rows, and replays safely by client reference.
 */
export async function applySupabaseAdjustment(
  args: AdjustStockArgs,
  _products: Product[],
  repo = getSupabaseInventoryRepository(),
): Promise<{ product: Product; movement: StockMovement }> {
  const client = getSupabaseClient();
  if (!client) throw new AppError("NOT_CONFIGURED");
  const clientRef = args.clientRef ?? (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `adjust-${crypto.randomUUID()}`
      : `adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const { data, error } = await client.rpc("inventory_adjust_stock", {
    p_client_ref: clientRef,
    p_product_id: args.productId,
    p_variant_id: args.variantId ?? null,
    p_type: args.type,
    p_reason: args.reason,
    p_quantity: Math.trunc(args.quantity),
    p_notes: args.notes,
  });
  if (error) throw toAppError(error);
  const envelope = data as { ok?: boolean; movement?: MovementRow } | null;
  if (!envelope?.ok || !envelope.movement) {
    throw new AppError("DB", "Authoritative inventory adjustment returned no movement");
  }
  const product = (await repo.listProducts()).find((item) => item.id === args.productId);
  if (!product) throw new AppError("NOT_FOUND");
  return { product, movement: mapMovement(envelope.movement) };
}

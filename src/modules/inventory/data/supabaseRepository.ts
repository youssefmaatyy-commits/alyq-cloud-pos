import type { Product, ProductPatch } from "@/modules/products/types";
import type { ProductVariant } from "@/modules/products/variants";
import { AppError, toAppError } from "@/modules/products/data/repository";
import type { StockMovement } from "../types";
import type { AdjustStockArgs, InventoryRepository } from "./repository";
import { signedDelta } from "../types";
import { getSupabaseClient } from "@/lib/supabase/client";

interface MovementRow {
  id: string;
  product_id: string;
  variant_id?: string | null;
  variant_color_ar?: string | null;
  variant_color_en?: string | null;
  variant_size?: number | string | null;
  delta: number;
  quantity_before: number;
  quantity_after: number;
  type: string;
  reason: string;
  notes: string | null;
  user_id: string;
  user_name: string;
  created_at: string;
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
    variant_size_label: (row as MovementRow & { variant_size_label?: string | null }).variant_size_label ?? null,
    delta: toNumber(row.delta),
    quantity_before: toNumber(row.quantity_before),
    quantity_after: toNumber(row.quantity_after),
    type: row.type as StockMovement["type"],
    reason: row.reason as StockMovement["reason"],
    notes: row.notes ?? null,
    user_id: row.user_id,
    user_name: row.user_name,
    created_at: row.created_at,
  };
}

const PRODUCTS_SELECT =
  "id, sku, name_en, name_ar, stock_quantity, stock_tracking_enabled, low_stock_level, variants_enabled";
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
    const { data, error } = await client.from("products").select(PRODUCTS_SELECT);
    if (error) throw toAppError(error);
    return (data as Product[] | null) ?? [];
  }

  async updateProductStock(productId: string, patch: ProductPatch): Promise<Product> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("products")
      .update(patch)
      .eq("id", productId)
      .select(PRODUCTS_SELECT)
      .single();
    if (error) throw toAppError(error);
    return data as Product;
  }

  async listVariants(): Promise<ProductVariant[]> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client.from("product_variants").select(VARIANTS_SELECT);
    if (error) throw toAppError(error);
    return ((data as VariantRow[] | null) ?? []).map(mapVariant);
  }

  async updateVariantStock(variantId: string, quantity: number): Promise<ProductVariant> {
    const client = getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    const { data, error } = await client
      .from("product_variants")
      // The rollup trigger on `product_variants` moves the product total; this
      // statement must never touch `products.stock_quantity` itself, and the
      // database would refuse it if it did.
      .update({ stock_quantity: Math.max(0, Math.trunc(quantity)) })
      .eq("id", variantId)
      .select(VARIANTS_SELECT)
      .single();
    if (error) throw toAppError(error);
    return mapVariant(data as VariantRow);
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
 * Two-step live adjustment. The movement is inserted first; if the subsequent
 * stock update fails we re-raise so the caller can decide to roll back.
 */
export async function applySupabaseAdjustment(
  args: AdjustStockArgs,
  products: Product[],
  repo = getSupabaseInventoryRepository(),
): Promise<{ product: Product; movement: StockMovement }> {
  const current = products.find((p) => p.id === args.productId);
  if (!current) throw new AppError("NOT_FOUND");
  if (!current.stock_tracking_enabled) {
    throw new AppError("VALIDATION", "Stock tracking is disabled for this product", "quantity");
  }

  // ── Phase 43: a variant product's movement moves the EXACT variant ────────
  if (current.variants_enabled) {
    const variants = await repo.listVariants();
    const variant = variants.find((v) => v.id === args.variantId && v.product_id === current.id);
    if (!variant) {
      throw new AppError(
        args.variantId ? "VARIANT_NOT_FOUND" : "VARIANT_REQUIRED",
        args.variantId
          ? `Variant ${args.variantId} does not belong to ${current.sku}`
          : `${current.sku} sells by variant — say which colour and size moved`,
        "variant_id",
      );
    }
    const variantBefore = variant.stock_quantity;
    const variantAfter = Math.max(0, variantBefore + signedDelta(args.type, args.quantity));
    const movement = await repo.recordMovement({
      product_id: current.id,
      variant_id: variant.id,
      variant_color_ar: variant.color_ar,
      variant_color_en: variant.color_en,
      variant_size: variant.size,
      variant_size_label: variant.size_label,
      delta: args.quantity,
      type: args.type,
      reason: args.reason,
      notes: args.notes,
      user_id: args.userId,
      user_name: args.userName,
    });
    await repo.updateVariantStock(variant.id, variantAfter);
    const product = (await repo.listProducts()).find((p) => p.id === current.id) ?? current;
    return {
      product,
      movement: { ...movement, quantity_before: variantBefore, quantity_after: variantAfter },
    };
  }

  const quantityBefore = current.stock_quantity;
  const newQty = Math.max(0, quantityBefore + signedDelta(args.type, args.quantity));

  const movement = await repo.recordMovement({
    product_id: current.id,
    variant_id: null,
    variant_color_ar: null,
    variant_color_en: null,
    variant_size: null,
    variant_size_label: null,
    delta: args.quantity,
    type: args.type,
    reason: args.reason,
    notes: args.notes,
    user_id: args.userId,
    user_name: args.userName,
  });

  // Patch the just-inserted row with the snapshot (Supabase has no RETURNING
  // trick here, so we update by id). Single round-trip.
  const client = getSupabaseClient();
  if (client) {
    const { error: patchErr } = await client
      .from("stock_movements")
      .update({ quantity_before: quantityBefore, quantity_after: newQty })
      .eq("id", movement.id);
    if (patchErr) throw toAppError(patchErr);
  }

  const product = await repo.updateProductStock(current.id, { stock_quantity: newQty });
  return {
    product,
    movement: { ...movement, quantity_before: quantityBefore, quantity_after: newQty },
  };
}

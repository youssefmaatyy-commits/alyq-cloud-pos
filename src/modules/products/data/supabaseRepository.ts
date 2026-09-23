import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";
import { colorKeyOf, type NewProductVariant, type ProductVariant, type ProductVariantPatch } from "../variants";
import {
  AppError,
  toAppError,
  type CatalogRepository,
  type ProductReferenceCounts,
  type ProductReferenceMap,
  type VariantActor,
  type VariantOpening,
  type VariantReferenceMap,
} from "./repository";

/** Row shape as returned by Supabase (defensive: numeric columns may arrive as strings). */
interface ProductRow {
  id: string;
  sku: string;
  barcode: string | null;
  name_ar: string;
  name_en: string;
  description_ar: string | null;
  description_en: string | null;
  category_id: string | null;
  product_type: string;
  selling_price: number | string;
  cost_price: number | string;
  tax_rate: number | string;
  stock_tracking_enabled: boolean;
  variants_enabled?: boolean | null;
  stock_quantity: number | string | null;
  low_stock_level: number | string | null;
  show_on_website: boolean;
  is_featured: boolean;
  active: boolean;
  image_url: string | null;
  images: string[] | null;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  id: string;
  name_ar: string;
  name_en: string;
  parent_id: string | null;
  active: boolean;
  sort_order: number | string;
  created_at: string;
  updated_at: string;
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku ?? "",
    barcode: row.barcode ?? null,
    name_ar: row.name_ar ?? "",
    name_en: row.name_en ?? "",
    description_ar: row.description_ar ?? null,
    description_en: row.description_en ?? null,
    category_id: row.category_id ?? null,
    product_type: (row.product_type ?? "physical") as Product["product_type"],
    selling_price: toNumber(row.selling_price),
    cost_price: toNumber(row.cost_price),
    tax_rate: toNumber(row.tax_rate),
    stock_tracking_enabled: Boolean(row.stock_tracking_enabled),
    variants_enabled: Boolean(row.variants_enabled),
    stock_quantity: toNumber(row.stock_quantity),
    low_stock_level: toNumber(row.low_stock_level),
    show_on_website: row.show_on_website ?? true,
    is_featured: Boolean(row.is_featured),
    active: row.active ?? true,
    image_url: row.image_url ?? null,
    images: Array.isArray(row.images)
      ? row.images.filter((url): url is string => typeof url === "string" && url.length > 0)
      : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name_ar: row.name_ar ?? "",
    name_en: row.name_en ?? "",
    parent_id: row.parent_id ?? null,
    active: row.active ?? true,
    sort_order: toNumber(row.sort_order),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapVariant(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku ?? "",
    barcode: row.barcode ?? null,
    color_key: row.color_key ?? "",
    color_ar: row.color_ar ?? null,
    color_en: row.color_en ?? null,
    color_hex: row.color_hex ?? null,
    size: toNullableNumber(row.size),
    size_label: row.size_label ?? null,
    image_url: row.image_url ?? null,
    price_override: toNullableNumber(row.price_override),
    cost_override: toNullableNumber(row.cost_override),
    stock_quantity: toNumber(row.stock_quantity),
    low_stock_level: toNumber(row.low_stock_level),
    active: row.active ?? true,
    sort_order: toNumber(row.sort_order),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const PRODUCTS_SELECT = "*";
const CATEGORIES_SELECT = "*";
const VARIANTS_SELECT = "*";

/**
 * Live Supabase repository. Any unexpected error is normalised into an
 * `AppError` so the UI only ever has to handle one error shape.
 */
export class SupabaseRepository implements CatalogRepository {
  readonly kind = "supabase" as const;

  private client = getSupabaseClient();

  private require() {
    const client = this.client ?? getSupabaseClient();
    if (!client) throw new AppError("NOT_CONFIGURED");
    return client;
  }

  private rethrow(error: unknown, field?: string): never {
    const err = error as { code?: string; message?: string; details?: string } | null;
    const pgCode = err?.code;
    const message = err?.message ?? "Unknown database error";

    if (pgCode === "23505") {
      // Decide which constraint fired so the form can highlight the field.
      const details = `${err?.details ?? ""} ${message}`.toLowerCase();
      if (details.includes("barcode")) throw new AppError("DUPLICATE_BARCODE", message, "barcode", pgCode);
      throw new AppError("DUPLICATE_SKU", message, "sku", pgCode);
    }
    if (pgCode === "23503") throw new AppError("CATEGORY_IN_USE", message, field, pgCode);
    throw toAppError(error);
  }

  /**
   * Error mapping for the lifecycle RPCs (migration 0037). The functions raise
   * named SQLSTATEs so each refusal maps to exactly one AppError code:
   *   42501 insufficient_privilege  → FORBIDDEN (capability refused server-side)
   *   23001 restrict_violation      → PRODUCT_HAS_HISTORY (archive, don't delete)
   *   23503 foreign_key_violation   → NOT_FOUND when it is the RPC's own
   *     "Product … not found", otherwise the FK's RESTRICT fired on a history
   *     table no count saw — which still means the product has a history.
   */
  private rethrowLifecycle(error: unknown): never {
    const err = error as { code?: string; message?: string } | null;
    const pgCode = err?.code;
    const message = err?.message ?? "Unknown database error";

    if (pgCode === "42501") throw new AppError("FORBIDDEN", message, undefined, pgCode);
    if (pgCode === "23001") throw new AppError("PRODUCT_HAS_HISTORY", message, undefined, pgCode);
    if (pgCode === "23503") {
      if (/not found/i.test(message)) throw new AppError("NOT_FOUND", message, undefined, pgCode);
      throw new AppError("PRODUCT_HAS_HISTORY", message, undefined, pgCode);
    }
    throw toAppError(error);
  }

  // ── products ───────────────────────────────────────────────────────────

  async listProducts(): Promise<Product[]> {
    try {
      const { data, error } = await this.require()
        .from("products")
        .select(PRODUCTS_SELECT)
        .order("name_en", { ascending: true });
      if (error) this.rethrow(error);
      return (data as ProductRow[] | null ?? []).map(mapProduct);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async createProduct(input: NewProduct): Promise<Product> {
    try {
      const { data, error } = await this.require()
        .from("products")
        .insert(input)
        .select(PRODUCTS_SELECT)
        .single();
      if (error) this.rethrow(error);
      return mapProduct(data as ProductRow);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async updateProduct(id: string, patch: ProductPatch): Promise<Product> {
    try {
      const { data, error } = await this.require()
        .from("products")
        .update(patch)
        .eq("id", id)
        .select(PRODUCTS_SELECT)
        .single();
      if (error) this.rethrow(error);
      return mapProduct(data as ProductRow);
    } catch (error) {
      this.rethrow(error);
    }
  }

  /**
   * Archive / reactivate through `public.set_product_active` (0037), so the
   * capability check and the product.archived / product.reactivated audit row
   * happen inside the database whichever client calls. The function answers
   * the idempotent no-op case, so a double-submitted toggle is not an error.
   */
  async setProductActive(id: string, active: boolean): Promise<Product> {
    try {
      const { error } = await this.require().rpc("set_product_active", {
        p_product_id: id,
        p_active: active,
      });
      if (error) this.rethrowLifecycle(error);
      // Re-read the row so callers get the full Product the contract promises.
      const { data, error: readError } = await this.require()
        .from("products")
        .select(PRODUCTS_SELECT)
        .eq("id", id)
        .single();
      if (readError) this.rethrow(readError);
      return mapProduct(data as ProductRow);
    } catch (error) {
      this.rethrowLifecycle(error);
    }
  }

  async listProductReferences(): Promise<ProductReferenceMap> {
    try {
      const { data, error } = await this.require()
        .rpc("product_reference_counts", { p_product_id: null });
      if (error) this.rethrowLifecycle(error);
      const map: ProductReferenceMap = {};
      for (const row of (data ?? []) as Record<string, number | string>[]) {
        const id = String(row.product_id);
        const counts: ProductReferenceCounts = {
          sale_items: toNumber(row.sale_items),
          return_items: toNumber(row.return_items),
          stock_movements: toNumber(row.stock_movements),
          online_order_items: toNumber(row.online_order_items),
          stock_reservations: toNumber(row.stock_reservations),
          total: toNumber(row.total),
        };
        if (counts.total > 0) map[id] = counts;
      }
      return map;
    } catch (error) {
      this.rethrowLifecycle(error);
    }
  }

  /**
   * Permanent delete through `public.delete_product` (0037): the capability,
   * the history check and the audit row are all decided by the database, so a
   * forged request is held to exactly the same lifecycle rules as the screen.
   */
  async deleteProduct(id: string): Promise<void> {
    try {
      const { error } = await this.require().rpc("delete_product", {
        p_product_id: id,
      });
      if (error) this.rethrowLifecycle(error);
    } catch (error) {
      this.rethrowLifecycle(error);
    }
  }

  // ── variants (Phase 43) ────────────────────────────────────────────────
  //
  // The live half is thin on purpose: the rules live in the database (RLS, the
  // identity trigger, the rollup trigger, the four functions), so a caller that
  // skips this repository entirely still gets them. What this layer does is
  // translate the refusals into codes the screens can act on, and never invent a
  // variant of its own: an ambiguous lookup is an error, not a guess.

  /**
   * Variant refusals, mapped from the SQLSTATE the database raises:
   *   42501 insufficient_privilege → FORBIDDEN
   *   23001 restrict_violation     → VARIANT_IN_USE (history names it)
   *   23505 unique_violation       → DUPLICATE_SKU / DUPLICATE_BARCODE
   *   23514 check_violation        → depends on the sentence:
   *      · "conversion must neither create nor destroy" → VARIANTS_STOCK_MISMATCH
   *      · "sells by variant"                            → VARIANT_STOCK_READONLY
   *      · "no longer sold"                              → VARIANT_UNAVAILABLE
   *      · "must keep at least one" / "nothing left to sell" → VARIANT_REQUIRED
   *      · anything else about stock/units                → VARIANT_STOCK_INSUFFICIENT
   */
  private rethrowVariant(error: unknown): never {
    const err = error as { code?: string; message?: string } | null;
    const pgCode = err?.code;
    const message = err?.message ?? "Unknown database error";

    if (pgCode === "42501") throw new AppError("FORBIDDEN", message, undefined, pgCode);
    if (pgCode === "23001") throw new AppError("VARIANT_IN_USE", message, undefined, pgCode);
    if (pgCode === "23505") {
      if (/barcode/i.test(message)) throw new AppError("DUPLICATE_BARCODE", message, "barcode", pgCode);
      throw new AppError("DUPLICATE_SKU", message, "sku", pgCode);
    }
    if (pgCode === "23514" || pgCode === "P0001") {
      if (/must neither create nor destroy/i.test(message)) {
        throw new AppError("VARIANTS_STOCK_MISMATCH", message, undefined, pgCode);
      }
      if (/sells by variant/i.test(message)) {
        throw new AppError("VARIANT_STOCK_READONLY", message, "stock_quantity", pgCode);
      }
      if (/is no longer sold/i.test(message)) {
        throw new AppError("VARIANT_UNAVAILABLE", message, undefined, pgCode);
      }
      if (/must keep at least one|nothing left to sell/i.test(message)) {
        throw new AppError("VARIANT_REQUIRED", message, undefined, pgCode);
      }
      throw new AppError("VARIANT_STOCK_INSUFFICIENT", message, undefined, pgCode);
    }
    if (pgCode === "23503") {
      if (/not found/i.test(message)) throw new AppError("VARIANT_NOT_FOUND", message, undefined, pgCode);
      throw new AppError("VARIANT_IN_USE", message, undefined, pgCode);
    }
    throw toAppError(error);
  }

  async listVariants(): Promise<ProductVariant[]> {
    try {
      const { data, error } = await this.require()
        .from("product_variants")
        .select(VARIANTS_SELECT)
        .order("product_id", { ascending: true })
        .order("color_key", { ascending: true })
        .order("size", { ascending: true, nullsFirst: false });
      if (error) this.rethrowVariant(error);
      return (data as VariantRow[] | null ?? []).map(mapVariant);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async createVariant(input: NewProductVariant): Promise<ProductVariant> {
    try {
      // `color_key` is sent when the caller derived it; the database fills it
      // from the label when it is absent, and never rewrites it afterwards.
      const payload = {
        ...input,
        color_key: input.color_key?.trim() || colorKeyOf(input),
      };
      const { data, error } = await this.require()
        .from("product_variants")
        .insert(payload)
        .select(VARIANTS_SELECT)
        .single();
      if (error) this.rethrowVariant(error);
      return mapVariant(data as VariantRow);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async updateVariant(id: string, patch: ProductVariantPatch): Promise<ProductVariant> {
    try {
      if (patch.stock_quantity !== undefined) {
        // The database refuses this too (variant stock is a shelf, not a field);
        // refusing here keeps the message the same in both modes.
        throw new AppError(
          "VARIANT_STOCK_READONLY",
          "Variant stock changes through a stock adjustment, so the movement ledger records it",
          "stock_quantity",
          "23514",
        );
      }
      if (patch.active !== undefined) {
        // Even a caller that skips saveVariant must use the locking archive
        // RPC, not an unguarded PostgREST metadata UPDATE.
        throw new AppError("VALIDATION", "Use setVariantActive to archive or reactivate a combination", "active");
      }
      const { data, error } = await this.require()
        .from("product_variants")
        .update(patch)
        .eq("id", id)
        .select(VARIANTS_SELECT)
        .single();
      if (error) this.rethrowVariant(error);
      return mapVariant(data as VariantRow);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async setVariantActive(id: string, active: boolean): Promise<ProductVariant> {
    try {
      // Unlike a direct UPDATE, this RPC refuses to archive the product's last
      // active combination. History stays attached to its original ID.
      const { error } = await this.require().rpc("set_variant_active", {
        p_variant_id: id, p_active: active,
      });
      if (error) this.rethrowVariant(error);
      const { data, error: readError } = await this.require().from("product_variants")
        .select(VARIANTS_SELECT).eq("id", id).single();
      if (readError) this.rethrowVariant(readError);
      return mapVariant(data as VariantRow);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async deleteVariant(id: string): Promise<void> {
    try {
      const { error } = await this.require().rpc("delete_variant", { p_variant_id: id });
      if (error) this.rethrowVariant(error);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async listVariantReferences(): Promise<VariantReferenceMap> {
    try {
      const { data, error } = await this.require().rpc("variant_reference_counts", {
        p_variant_id: null,
      });
      if (error) this.rethrowVariant(error);
      const map: VariantReferenceMap = {};
      for (const row of (data as { variant_id: string; total: number | string }[] | null) ?? []) {
        map[row.variant_id] = toNumber(row.total);
      }
      return map;
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async enableProductVariants(
    productId: string,
    opening: readonly VariantOpening[],
    actor: VariantActor,
  ): Promise<Product> {
    try {
      const distribution: Record<string, number> = {};
      for (const entry of opening) distribution[entry.variantId] = Math.trunc(entry.quantity);
      const { error } = await this.require().rpc("enable_product_variants", {
        p_product_id: productId,
        p_opening: distribution,
        p_user_id: actor.userId,
        p_user_name: actor.userName,
      });
      if (error) this.rethrowVariant(error);
      return await this.productById(productId);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  async disableProductVariants(
    productId: string,
    consolidatedStock: number,
    actor: VariantActor,
  ): Promise<Product> {
    try {
      const { error } = await this.require().rpc("disable_product_variants", {
        p_product_id: productId,
        p_consolidated_stock: consolidatedStock,
        p_user_id: actor.userId,
        p_user_name: actor.userName,
      });
      if (error) this.rethrowVariant(error);
      return await this.productById(productId);
    } catch (error) {
      this.rethrowVariant(error);
    }
  }

  /** Re-read one product — the functions answer with a summary, not the row. */
  private async productById(id: string): Promise<Product> {
    const { data, error } = await this.require()
      .from("products")
      .select(PRODUCTS_SELECT)
      .eq("id", id)
      .single();
    if (error) this.rethrow(error);
    return mapProduct(data as ProductRow);
  }

  // ── categories ─────────────────────────────────────────────────────────

  async listCategories(): Promise<Category[]> {
    try {
      const { data, error } = await this.require()
        .from("categories")
        .select(CATEGORIES_SELECT)
        .order("sort_order", { ascending: true })
        .order("name_en", { ascending: true });
      if (error) this.rethrow(error);
      return (data as CategoryRow[] | null ?? []).map(mapCategory);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async createCategory(input: NewCategory): Promise<Category> {
    try {
      const { data, error } = await this.require()
        .from("categories")
        .insert(input)
        .select(CATEGORIES_SELECT)
        .single();
      if (error) this.rethrow(error);
      return mapCategory(data as CategoryRow);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<Category> {
    try {
      const { data, error } = await this.require()
        .from("categories")
        .update(patch)
        .eq("id", id)
        .select(CATEGORIES_SELECT)
        .single();
      if (error) this.rethrow(error);
      return mapCategory(data as CategoryRow);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async deleteCategory(id: string): Promise<void> {
    try {
      // Phase 44: the server decides. The RPC locks the category row and
      // re-counts products and children inside the deleting transaction —
      // this client no longer counts anything it cannot see.
      const { error } = await this.require().rpc("delete_empty_category", {
        p_category_id: id,
      });
      if (error) this.rethrowCategory(error);
    } catch (error) {
      this.rethrowCategory(error);
    }
  }

  async setCategoryActive(id: string, active: boolean): Promise<Category> {
    try {
      const { error } = await this.require().rpc("set_category_active", {
        p_category_id: id,
        p_active: active,
      });
      if (error) this.rethrowCategory(error);
      // Re-read the row so callers get the full Category the contract promises.
      const { data, error: readError } = await this.require()
        .from("categories")
        .select(CATEGORIES_SELECT)
        .eq("id", id)
        .single();
      if (readError) this.rethrow(readError);
      return mapCategory(data as CategoryRow);
    } catch (error) {
      this.rethrowCategory(error);
    }
  }

  async moveProductsAndDeleteCategory(
    sourceId: string,
    targetId: string,
  ): Promise<{ moved: number; source: Category; target: Category }> {
    try {
      const { data, error } = await this.require().rpc("move_products_and_delete_category", {
        p_source_category_id: sourceId,
        p_target_category_id: targetId,
      });
      if (error) this.rethrowCategory(error);
      const result = (data ?? {}) as { moved?: number | string; source_name?: string };
      // Re-read the survivor so the UI can refresh against real state.
      const { data: target, error: readError } = await this.require()
        .from("categories")
        .select(CATEGORIES_SELECT)
        .eq("id", targetId)
        .single();
      if (readError) this.rethrow(readError);
      return {
        moved: Number(result.moved ?? 0),
        target: mapCategory(target as CategoryRow),
        // The source is gone; echo what the transaction deleted.
        source: {
          id: sourceId,
          name_en: String(result.source_name ?? sourceId),
          name_ar: String(result.source_name ?? sourceId),
        } as Category,
      };
    } catch (error) {
      this.rethrowCategory(error);
    }
  }

  /**
   * Error mapping for the category lifecycle RPCs (migration 0044). The
   * functions raise with Postgres codes; the messages disambiguate the
   * business rule behind a shared code, exactly like rethrowLifecycle.
   */
  private rethrowCategory(error: unknown): never {
    const err = error as { code?: string; message?: string } | null;
    const pgCode = err?.code;
    const message = err?.message ?? "Unknown database error";

    if (pgCode === "42501") throw new AppError("FORBIDDEN", message, undefined, pgCode);
    if (pgCode === "23001") throw new AppError("CATEGORY_HAS_CHILDREN", message, undefined, pgCode);
    if (pgCode === "23503") {
      if (/not found/i.test(message)) throw new AppError("NOT_FOUND", message, undefined, pgCode);
      throw new AppError("CATEGORY_IN_USE", message, undefined, pgCode);
    }
    if (pgCode === "23514") {
      if (/archived/i.test(message)) throw new AppError("CATEGORY_ARCHIVED", message, undefined, pgCode);
      if (/same category/i.test(message)) throw new AppError("VALIDATION", message, undefined, pgCode);
      throw new AppError("CATEGORY_NOT_EMPTY", message, undefined, pgCode);
    }
    throw toAppError(error);
  }
}

let singleton: SupabaseRepository | null = null;

export function getSupabaseRepository(): SupabaseRepository {
  if (!singleton) singleton = new SupabaseRepository();
  return singleton;
}

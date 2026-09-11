import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  Category,
  CategoryPatch,
  NewCategory,
  NewProduct,
  Product,
  ProductPatch,
} from "../types";
import { AppError, toAppError, type CatalogRepository } from "./repository";

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

const PRODUCTS_SELECT = "*";
const CATEGORIES_SELECT = "*";

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

  async setProductActive(id: string, active: boolean): Promise<Product> {
    return this.updateProduct(id, { active });
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
      // Guard in the client too — the DB also has a trigger-based guard.
      const { count, error: countError } = await this.require()
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("category_id", id);
      if (countError) this.rethrow(countError);
      if ((count ?? 0) > 0) throw new AppError("CATEGORY_IN_USE", `Category ${id} in use`);

      const { error } = await this.require().from("categories").delete().eq("id", id);
      if (error) this.rethrow(error);
    } catch (error) {
      this.rethrow(error);
    }
  }
}

let singleton: SupabaseRepository | null = null;

export function getSupabaseRepository(): SupabaseRepository {
  if (!singleton) singleton = new SupabaseRepository();
  return singleton;
}

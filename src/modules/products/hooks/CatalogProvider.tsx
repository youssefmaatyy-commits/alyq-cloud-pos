import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getCatalogMode, getCatalogRepository } from "../data";
import type { AppError, CatalogRepository, ProductReferenceMap } from "../data/repository";
import type { Category, CategoryNode, Product } from "../types";
import type { ProductVariant } from "../variants";
import { summarizeVariants } from "../variants";
import {
  assertCategoryDeletable,
  deleteCategory as deleteCategoryService,
  deleteProduct as deleteProductService,
  listProductReferences,
  loadCatalog,
  saveCategory as saveCategoryService,
  saveProduct as saveProductService,
  setProductActive as setProductActiveService,
} from "../services/catalogService";
import { mayPerform } from "@/lib/permissions/actions";
import { buildCategoryTree } from "../services/categoryTree";
import type { CategoryFormValues, ProductFormValues } from "../validation";

export interface CatalogContextValue {
  mode: "supabase" | "demo";
  repository: CatalogRepository;
  products: Product[];
  categories: Category[];
  /**
   * Phase 43: every combination in the catalogue, display order, with the
   * per-product summary attached to each product row (so tables and detail
   * pages can say "3 variants · 1 low" without a second read each).
   */
  variants: ProductVariant[];
  variantsByProduct: Map<string, ProductVariant[]>;
  tree: CategoryNode[];
  /**
   * product id → how much preserved history it has (empty unless the acting
   * user may delete products). The screens use it to disable permanent delete
   * with a reason; enforcement itself lives in the data layer.
   */
  productReferences: ProductReferenceMap;
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  /** Silent re-read of the reference map only — for screens that remount. */
  refreshReferences: () => Promise<void>;
  saveProduct: (
    values: ProductFormValues,
    currentId?: string,
  ) => Promise<{ product: Product; isNew: boolean }>;
  saveCategory: (
    values: CategoryFormValues,
    currentId?: string,
  ) => Promise<{ category: Category; isNew: boolean }>;
  setProductActive: (id: string, active: boolean) => Promise<Product>;
  deleteProduct: (id: string) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  categoryById: (id: string | null | undefined) => Category | undefined;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

/** Loads the catalog once and exposes validated mutations to the pages. */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [productReferences, setProductReferences] = useState<ProductReferenceMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getCatalogRepository(), []);
  const mode = useMemo(() => getCatalogMode(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snapshot, combinations] = await Promise.all([
        loadCatalog(),
        repository.listVariants().catch(() => []),
      ]);
      setVariants(combinations);
      // A variant product's tiles and badges answer from its ACTIVE variants
      // (stockStatus), never from the rollup alone.
      const grouped = new Map<string, ProductVariant[]>();
      for (const variant of combinations) {
        const list = grouped.get(variant.product_id);
        if (list) list.push(variant);
        else grouped.set(variant.product_id, [variant]);
      }
      setProducts(
        snapshot.products.map((product) => {
          const own = grouped.get(product.id);
          return own && own.length > 0
            ? { ...product, variant_summary: summarizeVariants(own) }
            : product;
        }),
      );
      setCategories(snapshot.categories);
      // Reference counts only matter to a seat that could delete — asking for
      // them without the capability would turn a working catalogue load into a
      // refused RPC (live) for everybody else.
      if (mayPerform("product.delete")) {
        setProductReferences(await listProductReferences().catch(() => ({})));
      } else {
        setProductReferences({});
      }
    } catch (err) {
      setError(err as AppError);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Silent re-read of the reference map only — no loading flip, no catalogue
   * reload. History can mint while this screen is away (a sale completed at
   * the POS, an online order approved), and the map is what keeps the delete
   * affordance honest: a product that sold a minute ago must render "Archive
   * instead", not an armed delete. The repository still gets the final say.
   */
  const refreshReferences = useCallback(async () => {
    if (!mayPerform("product.delete")) {
      setProductReferences({});
      return;
    }
    setProductReferences(await listProductReferences().catch(() => ({})));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveProduct = useCallback(
    async (values: ProductFormValues, currentId?: string) => {
      const result = await saveProductService({
        values,
        products,
        categories,
        currentId,
      });
      await refresh();
      return result;
    },
    [categories, products, refresh],
  );

  const saveCategory = useCallback(
    async (values: CategoryFormValues, currentId?: string) => {
      const result = await saveCategoryService({ values, categories, currentId });
      await refresh();
      return result;
    },
    [categories, refresh],
  );

  const setProductActive = useCallback(
    async (id: string, active: boolean) => {
      // Optimistic update keeps the list responsive; refreshed after the call.
      setProducts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, active, updated_at: new Date().toISOString() } : p)),
      );
      try {
        const product = await setProductActiveService(id, active);
        await refresh();
        return product;
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh],
  );

  const deleteProduct = useCallback(
    async (id: string) => {
      // Optimistic removal keeps the list responsive; a refusal (history,
      // permission) throws, the refresh below puts the row back, and the page
      // raises the error as a toast.
      setProducts((prev) => prev.filter((p) => p.id !== id));
      try {
        await deleteProductService(id);
        await refresh();
      } catch (err) {
        await refresh();
        throw err;
      }
    },
    [refresh],
  );

  const deleteCategory = useCallback(
    async (id: string) => {
      assertCategoryDeletable(id, { products, categories });
      await deleteCategoryService(id, { products, categories });
      await refresh();
    },
    [categories, products, refresh],
  );

  const categoryById = useCallback(
    (id: string | null | undefined) => (id ? categories.find((c) => c.id === id) : undefined),
    [categories],
  );

  const tree = useMemo(() => buildCategoryTree(categories, products), [categories, products]);

  const variantsByProduct = useMemo(() => {
    const grouped = new Map<string, ProductVariant[]>();
    for (const variant of variants) {
      const list = grouped.get(variant.product_id);
      if (list) list.push(variant);
      else grouped.set(variant.product_id, [variant]);
    }
    return grouped;
  }, [variants]);

  const value = useMemo<CatalogContextValue>(
    () => ({
      mode,
      repository,
      products,
      categories,
      variants,
      variantsByProduct,
      tree,
      productReferences,
      loading,
      error,
      refresh,
      refreshReferences,
      saveProduct,
      saveCategory,
      setProductActive,
      deleteProduct,
      deleteCategory,
      categoryById,
    }),
    [
      mode,
      repository,
      products,
      categories,
      variants,
      variantsByProduct,
      tree,
      productReferences,
      loading,
      error,
      refresh,
      refreshReferences,
      saveProduct,
      saveCategory,
      setProductActive,
      deleteProduct,
      deleteCategory,
      categoryById,
    ],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error("useCatalog must be used inside <CatalogProvider>");
  return ctx;
}

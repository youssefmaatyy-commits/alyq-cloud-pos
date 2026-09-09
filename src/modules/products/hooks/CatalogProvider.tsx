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
import type { AppError, CatalogRepository } from "../data/repository";
import type { Category, CategoryNode, Product } from "../types";
import {
  assertCategoryDeletable,
  deleteCategory as deleteCategoryService,
  loadCatalog,
  saveCategory as saveCategoryService,
  saveProduct as saveProductService,
  setProductActive as setProductActiveService,
} from "../services/catalogService";
import { buildCategoryTree } from "../services/categoryTree";
import type { CategoryFormValues, ProductFormValues } from "../validation";

export interface CatalogContextValue {
  mode: "supabase" | "demo";
  repository: CatalogRepository;
  products: Product[];
  categories: Category[];
  tree: CategoryNode[];
  loading: boolean;
  error: AppError | null;
  refresh: () => Promise<void>;
  saveProduct: (
    values: ProductFormValues,
    currentId?: string,
  ) => Promise<{ product: Product; isNew: boolean }>;
  saveCategory: (
    values: CategoryFormValues,
    currentId?: string,
  ) => Promise<{ category: Category; isNew: boolean }>;
  setProductActive: (id: string, active: boolean) => Promise<Product>;
  deleteCategory: (id: string) => Promise<void>;
  categoryById: (id: string | null | undefined) => Category | undefined;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

/** Loads the catalog once and exposes validated mutations to the pages. */
export function CatalogProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const repository = useMemo(() => getCatalogRepository(), []);
  const mode = useMemo(() => getCatalogMode(), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await loadCatalog();
      setProducts(snapshot.products);
      setCategories(snapshot.categories);
    } catch (err) {
      setError(err as AppError);
    } finally {
      setLoading(false);
    }
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

  const value = useMemo<CatalogContextValue>(
    () => ({
      mode,
      repository,
      products,
      categories,
      tree,
      loading,
      error,
      refresh,
      saveProduct,
      saveCategory,
      setProductActive,
      deleteCategory,
      categoryById,
    }),
    [
      mode,
      repository,
      products,
      categories,
      tree,
      loading,
      error,
      refresh,
      saveProduct,
      saveCategory,
      setProductActive,
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
